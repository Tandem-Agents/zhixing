import { hasProtocolStateInMessages, normalizeUserTurnInput } from "@zhixing-ai/core";
import { parseConversationId } from "@zhixing-ai/core/conversation";
import {
  advancementExecutionContextBlock,
  type AdvancementExecutionMaterial,
} from "@zhixing-ai/core/advancement/execution-context";
import { AuthorityStorageError } from "@zhixing-ai/core/authority";
import {
  createLeaseBudgetTracker,
  type AssignmentResourceLease,
  type AuthorityCallContext,
  type FinalFrame,
  type IngressContext,
  type StreamFrame,
  type TranscriptRunRecord,
} from "@zhixing-ai/core/contracts";
import type { LogRecordPort } from "@zhixing-ai/core/logging";
import type { AgentYield, RunInputPort, RunResult } from "@zhixing-ai/core/loop";
import {
  canonicalize,
  protocolDigest,
  validateStreamFrame,
  type StreamDataFramePayload,
} from "@zhixing-ai/core/protocol";
import {
  currentMaintenanceAbortSignal,
  maintenanceRetryDelayMs,
  StorageMaintenanceCancelledError,
  type ForegroundActivityPort,
} from "@zhixing-ai/core/resources";
import {
  WorksceneContinuationApplication,
  worksceneTaskContext,
  type WorksceneContinuationQuery,
} from "@zhixing-ai/core/workscene/application";
import {
  AssignmentStartCancelledError,
  DataPlaneAssignmentInactiveError,
} from "@zhixing-ai/executor";
import {
  ConversationAssignmentCancelledError,
  ConversationPendingCancellationError,
  type ConversationRunJournal,
} from "@zhixing-ai/owner-kernel/conversation-assignment";
import type { ConversationAssignmentAuthority } from "@zhixing-ai/owner-kernel/conversation-assignment-authority";
import type { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import {
  assignmentReservationId,
  ResourceCandidateStaleError,
} from "@zhixing-ai/owner-kernel/resource-governor";
import type { DurableConversationTurnInput } from "@zhixing-ai/owner-kernel/run-turn";
import {
  assignmentGlobalCapability,
  createAssignmentGlobalQueryPort,
} from "../assignment-global-state-ports.js";
import {
  retryControlAdmission,
  retryResourceUsage,
} from "../conversation-admission-retry.js";
import type {
  ConversationAssignmentArtifactAuthorityIndex,
  ConversationExecutorDispatchApplication,
  ConversationExecutorDispatchPlan,
  ConversationExecutorExecutionEffect,
  ConversationExecutorInteractionScope,
} from "../conversation-executor-dispatch.js";
import type { ConversationOwnerRuntimeStack } from "../conversation-owner-runtime.js";
import type { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import { retryDurableObligation } from "../durable-obligation-retry.js";
import { executionTurnContext } from "../execution-turn-context.js";
import type { FirstPartyFinalitySession } from "../first-party-finality-session.js";
import type {
  FirstPartySurfaceSession,
  LosslessDataPlaneSession,
} from "../lossless-data-plane-runtime.js";
import { shouldRetryRemoteObligation } from "../remote-obligation-failure.js";
import type { AdmissionAndLifecycle } from "./admission-lifecycle.js";
import type {
  ConversationAdvancementExecutionPort,
  ConversationLosslessDataPlaneTopology,
} from "./contracts.js";
import type { ConversationAccess } from "./conversation-access.js";
import {
  admissionKey,
  assignmentResourceContext,
  assignmentSubmissionContext,
  cancelledRunResult,
  conversationAssignmentId,
  conversationExecutorRequirement,
  executionFailureReason,
  holdObservedForeground,
  inputControlRequestId,
  NO_FOREGROUND_OBLIGATION,
  observeRuntimePhase,
  replayCommittedRun,
  reservationOriginForSource,
  resourceHostContext,
  RetryableRunEndPreparation,
  runFailureReason,
  runTrustScope,
  usageReporterContext,
  type CapturedRunAttemptHandle,
  type RuntimeObligationScope,
} from "./runtime-obligation-scope.js";
import type { TerminalSettlement } from "./terminal-settlement.js";

export interface TurnExecutionHost {
  confirmScheduled(conversationId: string, runId: string): void;
  worksceneContinuationSources(
    conversationId: string,
    query?: WorksceneContinuationQuery,
  ): ReturnType<ConversationRunJournal["worksceneContinuationSources"]>;
}

export interface TurnExecutionOptions {
  readonly authority: ConversationOwnerRuntimeStack;
  readonly scope: RuntimeObligationScope;
  readonly access: ConversationAccess;
  readonly admission: AdmissionAndLifecycle;
  readonly settlement: TerminalSettlement;
  readonly host: TurnExecutionHost;
  readonly requiredManager: () => ConversationManager;
  readonly clock: () => string;
  readonly issuer: ConversationAssignmentAuthority;
  readonly executorDispatch: ConversationExecutorDispatchApplication;
  readonly assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly interactions: DurableConversationInteractionObserver;
  readonly losslessDataPlane: ConversationLosslessDataPlaneTopology;
  readonly advancementExecution?: ConversationAdvancementExecutionPort;
  readonly foreground?: ForegroundActivityPort;
  readonly phaseRecords?: LogRecordPort;
  readonly onFinal?: (frame: FinalFrame) => void | Promise<void>;
  readonly onFirstPartyFrame?: (
    frame: StreamFrame,
    readDisplay?: () => Promise<StreamDataFramePayload>,
  ) => void | Promise<void>;
  readonly onFirstPartyAssignment?: (source: {
    conversationId: string;
    runId: string;
    assignmentId: string;
  }) => void;
  readonly onFirstPartyStreamEnd?: (source: {
    readonly conversationId: string;
    readonly runId: string;
    readonly assignmentId: string;
    readonly finalSeq: number;
  }) => void;
  readonly observeFailure: (
    error: unknown,
    context: {
      readonly phase: "run" | "recovery";
      readonly conversationId: string;
      readonly runId?: string;
    },
  ) => void;
}

/**
 * Owns single-attempt `run(input)` execution (`prepare → execute → seal/commit → publish`)
 * and non-sleeping `#prepareRunEndUntilAvailable`, binding an immutable `CapturedRunAttemptHandle`
 * at entry and delegating `finally` to `TerminalSettlement.cleanupRunAttempt`.
 */
export class TurnExecution {
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #scope: RuntimeObligationScope;
  readonly #access: ConversationAccess;
  readonly #admission: AdmissionAndLifecycle;
  readonly #settlement: TerminalSettlement;
  readonly #host: TurnExecutionHost;
  readonly #requiredManager: () => ConversationManager;
  readonly #clock: () => string;
  readonly #issuer: ConversationAssignmentAuthority;
  readonly #executorDispatch: ConversationExecutorDispatchApplication;
  readonly #assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly #interactions: DurableConversationInteractionObserver;
  readonly #losslessDataPlane: ConversationLosslessDataPlaneTopology;
  readonly #advancementExecution: ConversationAdvancementExecutionPort | undefined;
  readonly #foreground: ForegroundActivityPort | undefined;
  readonly #phaseRecords: LogRecordPort | undefined;
  readonly #onFinal: TurnExecutionOptions["onFinal"];
  readonly #onFirstPartyFrame: TurnExecutionOptions["onFirstPartyFrame"];
  readonly #onFirstPartyAssignment: TurnExecutionOptions["onFirstPartyAssignment"];
  readonly #onFirstPartyStreamEnd: TurnExecutionOptions["onFirstPartyStreamEnd"];
  readonly #observeFailure: TurnExecutionOptions["observeFailure"];

  constructor(options: TurnExecutionOptions) {
    this.#authority = options.authority;
    this.#scope = options.scope;
    this.#access = options.access;
    this.#admission = options.admission;
    this.#settlement = options.settlement;
    this.#host = options.host;
    this.#requiredManager = options.requiredManager;
    this.#clock = options.clock;
    this.#issuer = options.issuer;
    this.#executorDispatch = options.executorDispatch;
    this.#assignmentArtifactAuthority = options.assignmentArtifactAuthority;
    this.#interactions = options.interactions;
    this.#losslessDataPlane = options.losslessDataPlane;
    this.#advancementExecution = options.advancementExecution;
    this.#foreground = options.foreground;
    this.#phaseRecords = options.phaseRecords;
    this.#onFinal = options.onFinal;
    this.#onFirstPartyFrame = options.onFirstPartyFrame;
    this.#onFirstPartyAssignment = options.onFirstPartyAssignment;
    this.#onFirstPartyStreamEnd = options.onFirstPartyStreamEnd;
    this.#observeFailure = options.observeFailure;
  }

  #phase<T>(name: string, work: () => Promise<T>): Promise<T> {
    return observeRuntimePhase(this.#phaseRecords, name, work);
  }

  #requireExecutionResources() {
    const resources = this.#authority.executionResources;
    if (!resources) {
      throw new Error("Local executor resource authority is unavailable");
    }
    return resources;
  }

  async *run(
    input: DurableConversationTurnInput,
  ): AsyncGenerator<AgentYield, RunResult> {
    const capturedScope = this.#scope.current;
    const preparedKey = admissionKey(input);
    const prepared = preparedKey
      ? capturedScope.preparedAdmissions.get(preparedKey)
      : undefined;
    if (
      prepared &&
      (canonicalize(prepared.input) !==
        canonicalize(normalizeUserTurnInput(input.input)) ||
        canonicalize(prepared.attachments) !==
          canonicalize(input.attachments ?? []) ||
        canonicalize(prepared.invocation) !== canonicalize(input.invocation) ||
        canonicalize(prepared.environment ?? null) !==
          canonicalize(input.environment ?? null))
    ) {
      throw new Error("Prepared conversation admission does not bind this invocation");
    }
    const appliedAdmission =
      prepared?.admission ??
      (await this.#admission.applyInputAdmission(input, true, capturedScope));
    const requestId = inputControlRequestId(appliedAdmission.ingress);
    const journal = this.#access.journal(input.conversationId, capturedScope);
    const runId = appliedAdmission.runId;
    const claimToken =
      prepared?.claimToken ??
      capturedScope.schedulingRuns.get(runId) ??
      capturedScope.scheduledRuns.get(runId) ??
      Symbol(runId);

    if (
      this.#scope.isCurrent(capturedScope) &&
      capturedScope.schedulingRuns.has(runId)
    ) {
      this.#host.confirmScheduled(input.conversationId, runId);
      capturedScope.scheduledRuns.set(runId, claimToken);
    } else {
      capturedScope.schedulingRuns.delete(runId);
      capturedScope.scheduledRuns.set(runId, claimToken);
    }
    if (preparedKey) {
      capturedScope.preparedAdmissions.delete(preparedKey);
    }
    const attemptForeground =
      prepared?.foreground ??
      (this.#foreground
        ? holdObservedForeground(this.#foreground, this.#phaseRecords)
        : NO_FOREGROUND_OBLIGATION);

    const attemptHandle: CapturedRunAttemptHandle = {
      scope: capturedScope.scope,
      scopeState: capturedScope,
      conversationId: input.conversationId,
      runId,
      claimToken,
      ...(prepared?.admissionId ? { admissionId: prepared.admissionId } : {}),
      capturedJournal: journal,
      attemptForeground,
    };

    let executionIngress = appliedAdmission.ingress;
    let attempt: number;
    try {
      if (appliedAdmission.replayed) {
        const committed = await journal.committedRun(runId);
        if (committed) {
          try {
            attemptForeground.close();
          } finally {
            this.#scope.clearRunClaimsInScope(capturedScope, runId, claimToken);
          }
          return replayCommittedRun(committed.runRecord, committed.windowCompact);
        }
        const replayedState = await journal.runState(runId);
        if (replayedState !== "queued") {
          throw new Error(
            `Conversation input ${requestId} already resolved to run ${runId} in state ${replayedState ?? "unknown"}`,
          );
        }
        const pending = (await journal.pendingInputs()).find(
          (candidate) => candidate.runId === runId,
        );
        if (!pending) {
          throw new Error(`Queued conversation run ${runId} has no durable input`);
        }
        executionIngress = pending.ingress;
      }
      attempt = await journal.nextAssignmentAttempt(runId);
    } catch (error) {
      try {
        attemptForeground.close();
      } finally {
        this.#scope.clearRunClaimsInScope(capturedScope, runId, claimToken);
        this.#scope.markRecoveryInScope(capturedScope, input.conversationId);
      }
      throw error;
    }

    const executionMessages = input.messages.map((message, index) =>
      index === input.messages.length - 1 &&
      message.role === "user" &&
      executionIngress.turnOrigin?.messageIdentity
        ? {
            ...message,
            inputIdentity: structuredClone(
              executionIngress.turnOrigin.messageIdentity,
            ),
          }
        : message,
    );
    const assignmentId = conversationAssignmentId(runId, attempt);
    this.#scope.claimAssignmentInScope(
      capturedScope,
      assignmentId,
      runId,
      claimToken,
    );

    let channelSession: LosslessDataPlaneSession | undefined;
    let firstPartySurfaceSession: FirstPartySurfaceSession | undefined;
    let firstPartyFinalitySession: FirstPartyFinalitySession | undefined;
    let firstPartyStreamFinalSeq: number | undefined;
    const drainFirstPartyProjection = (
      finalSeq: number,
      finalIdentity?: string,
    ) => {
      const surface = firstPartySurfaceSession;
      const finality = firstPartyFinalitySession;
      if (!surface) return;
      firstPartySurfaceSession = undefined;
      firstPartyFinalitySession = undefined;
      void this.#settlement.drainFirstPartyProjection({
        capturedScope,
        conversationId: input.conversationId,
        runId,
        finalSeq,
        ...(finalIdentity !== undefined ? { finalIdentity } : {}),
        finality,
        surface,
      });
    };

    let executorPlan: ConversationExecutorDispatchPlan | undefined;
    let executionScope: { close(): void } | undefined;
    let runFailed = false;
    let runError: unknown;

    try {
      if (
        !(await this.#settlement.settleTargetCancellations(
          input.conversationId,
          runId,
          capturedScope,
        ))
      ) {
        throw new ConversationPendingCancellationError(runId);
      }
      if (
        ["cancel-requested", "cancelled"].includes(
          (await journal.runState(runId)) ?? "",
        )
      ) {
        throw new ConversationAssignmentCancelledError(runId, assignmentId);
      }
      const authority = await journal.authorityState();
      if (authority.deleted) {
        throw new Error("Conversation has been durably deleted");
      }
      const executionProfile = input.runtime.executionProfile?.();
      const permissionRules = input.runtime.executionPermissionRules?.(
        runTrustScope(input.conversationId, appliedAdmission.environment),
      );
      if (executionProfile === undefined || permissionRules === undefined) {
        throw new Error(
          "Durable conversation runtime must expose execution and permission snapshots",
        );
      }
      const recentExecutorId = await journal.recentExecutorAffinity();
      const sessionMeta = await journal.sessionMeta();
      const parsedConvForRole = parseConversationId(input.conversationId);
      const primaryRoleForTurn: import("@zhixing-ai/core").ModelRoleId =
        parsedConvForRole.scope.kind === "workscene" ? "power" : "main";
      const manifestModelSelection: import("@zhixing-ai/core/contracts").CrossDeviceModelSelectionIntent =
        sessionMeta.modelSelection?.mode === "override"
          ? {
              mode: "connection",
              connectionId: sessionMeta.modelSelection.connectionId,
              model: sessionMeta.modelSelection.model,
              ...(sessionMeta.modelSelection.params
                ? { params: structuredClone(sessionMeta.modelSelection.params) }
                : {}),
              ...(sessionMeta.modelSelection.maxOutputPreference !== undefined
                ? { maxOutputPreference: sessionMeta.modelSelection.maxOutputPreference }
                : {}),
            }
          : {
              mode: "follow-role",
              role: primaryRoleForTurn,
            };
      const historyRequiresModelProtocolV2 =
        hasProtocolStateInMessages(executionMessages);
      executorPlan = await this.#phase("executor-plan", () =>
        this.#executorDispatch.plan({
          conversationId: input.conversationId,
          requirement: conversationExecutorRequirement(
            input.invocation,
            executionIngress,
          ),
          executionProfile,
          permissionRules,
          ...(recentExecutorId ? { recentExecutorId } : {}),
          ...(appliedAdmission.environment
            ? { environment: appliedAdmission.environment }
            : {}),
          modelSelection: manifestModelSelection,
          ...(manifestModelSelection.mode === "follow-role" &&
          !historyRequiresModelProtocolV2
            ? { allowLegacyV1FollowRole: true }
            : {}),
        }),
      );
      const preparedAuthority = executorPlan.assignment;
      const targetExecutorId = preparedAuthority.executorId;
      if (targetExecutorId !== this.#authority.executorId) {
        this.#scope.closeFirstSendWindowInScope(capturedScope, runId, claimToken);
      }
      const origin = reservationOriginForSource(input.options?.source);
      const resourceContext = resourceHostContext(
        "reservation.prepareAssignmentRoot",
        assignmentId,
        this.#clock(),
      );
      await this.#phase("reconcile-receipts", () =>
        this.#executorDispatch.reconcileLocalReceipts(),
      );
      await this.#phase("enqueue-root", () =>
        this.#authority.resources.enqueueRoot(
          assignmentReservationId(assignmentId),
          { kind: "run", id: runId, attempt },
          origin,
          resourceContext,
        ),
      );
      const controlContext = [
        ...worksceneTaskContext(
          await WorksceneContinuationApplication.tasks(
            (id, query) => this.#host.worksceneContinuationSources(id, query),
            input.conversationId,
          ),
        ),
        ...(await this.#advancementExecutionContext(
          input.conversationId,
          executionIngress,
        )),
      ];
      const ownerEpoch = this.#access.ownerEpochFor(
        input.conversationId,
        capturedScope,
      );
      const prepareResourceLease = () =>
        this.#authority.resources.prepareAssignmentRoot<"conversation">(
          {
            assignmentId,
            executorId: targetExecutorId,
            workload: { kind: "run", id: runId, attempt },
            scopeBinding: {
              kind: "conversation",
              conversationId: input.conversationId,
              ownerEpoch,
            },
            budget: preparedAuthority.policy.budget,
          },
          origin,
          resourceContext,
        );
      const issueEnvelope = (
        resourceLease: AssignmentResourceLease<"conversation">,
      ) =>
        this.#issuer.issue({
          runId,
          assignmentId,
          executorId: targetExecutorId,
          conversationId: input.conversationId,
          ownerEpoch,
          ...(this.#authority.domain.kind === "anchor"
            ? { anchorEpoch: this.#authority.domain.anchorEpoch }
            : {}),
          baseRevision: authority.commitRevision,
          attempt,
          resourceLease,
          ingress: executionIngress,
          controlContext,
          contentAssets: [...appliedAdmission.attachments],
          windowInput: {
            t: "full",
            windowEpoch: authority.commitRevision + 1,
            messages: [...executionMessages],
          },
          policy: preparedAuthority.policy,
          environment: preparedAuthority.environment,
        });
      let unsigned = issueEnvelope(
        await this.#phase("resource-lease", prepareResourceLease),
      );
      const plannedDispatch = executorPlan;
      await this.#phase("executor-prepare", () =>
        plannedDispatch.prepare({
          assignmentId,
          manifest: unsigned.manifest,
          ...(input.adaptLocalRuntime
            ? { adaptRuntime: input.adaptLocalRuntime }
            : {}),
        }),
      );
      let dispatch: Awaited<ReturnType<typeof journal.assign>>;
      for (;;) {
        try {
          dispatch = await this.#phase("assign", () => journal.assign(unsigned));
          break;
        } catch (error) {
          if (!(error instanceof ResourceCandidateStaleError)) throw error;
          if (
            ["cancel-requested", "cancelled"].includes(
              (await journal.runState(runId)) ?? "",
            )
          ) {
            throw new ConversationAssignmentCancelledError(runId, assignmentId);
          }
          const next = issueEnvelope(await prepareResourceLease());
          if (canonicalize(next.manifest) !== canonicalize(unsigned.manifest)) {
            throw new TypeError(
              "Renewed resource candidate changed the prepared execution manifest",
            );
          }
          unsigned = next;
        }
      }
      executorPlan.markPromoted();
      if (executionIngress.kind === "first-party") {
        this.#onFirstPartyAssignment?.({
          conversationId: input.conversationId,
          runId,
          assignmentId,
        });
      }
      this.#scope.rememberAssignmentInScope(
        capturedScope,
        dispatch.envelope,
        dispatch.activation,
        this.#assignmentArtifactAuthority,
      );
      executorPlan.bindRuntime(preparedAuthority.binding);
      const submissionContext = assignmentSubmissionContext(dispatch.envelope);
      const resourceSubmissionContext = assignmentResourceContext(dispatch.envelope);
      const flushResourceUsage = () =>
        this.#authority.finalizeUsage(assignmentId, (report) =>
          usageReporterContext(report.reporterId, report.digest, this.#clock()),
        );
      await this.#phase("dispatch", () =>
        plannedDispatch.dispatch({
          journal,
          envelope: dispatch.envelope,
          activation: dispatch.activation,
          contexts: this.#access.capturedAssignmentRouting(capturedScope).contexts,
          submissionContext,
        }),
      );
      const streamRef = {
        execution: "conversation",
        conversationId: input.conversationId,
        runId,
        ownerEpoch,
      } as const;
      if (
        executionIngress.kind === "channel" &&
        this.#losslessDataPlane.kind === "available"
      ) {
        const losslessDataPlane = this.#losslessDataPlane.port;
        const ticketId = `ticket:${protocolDigest(
          "ConversationChannelTicketIdentity",
          1,
          {
            assignmentId,
            surfacePrincipal: executionIngress.surfacePrincipal,
          },
        )}`;
        const ticket = await journal.issueDataPlaneTicket({
          ticketId,
          assignmentId,
          surfacePrincipal: executionIngress.surfacePrincipal,
          kind: "run-interact",
          ttlMs: 24 * 60 * 60 * 1_000,
        });
        channelSession = await losslessDataPlane.openConversationChannel({
          executorId: targetExecutorId,
          assignmentId,
          ref: streamRef,
          ticket,
          journal,
        });
      } else if (
        executionIngress.kind === "first-party" &&
        this.#losslessDataPlane.kind === "available"
      ) {
        const losslessDataPlane = this.#losslessDataPlane.port;
        const ticketId = `ticket:${protocolDigest(
          "ConversationFirstPartyTicketIdentity",
          1,
          {
            assignmentId,
            surfacePrincipal: executionIngress.surfacePrincipal,
          },
        )}`;
        const ticket = await this.#phase("ticket-issue", () =>
          journal.issueDataPlaneTicket({
            ticketId,
            assignmentId,
            surfacePrincipal: executionIngress.surfacePrincipal,
            kind: "run-interact",
            ttlMs: 24 * 60 * 60 * 1_000,
          }),
        );
        firstPartyFinalitySession = this.#settlement.createFirstPartyFinality?.({
          lastSeen: [
            {
              subject: streamRef,
              afterStatusRevision: 0,
            },
          ],
          onStatus: () => undefined,
          ...(this.#onFinal
            ? {
                onConversationFinal: async (frame) => {
                  const identity = canonicalize(frame);
                  if (capturedScope.ownerPublishedFirstPartyFinals.delete(identity)) {
                    capturedScope.pendingFirstPartyFinals.delete(identity);
                    return;
                  }
                  await this.#onFinal?.(frame);
                  capturedScope.pendingFirstPartyFinals.delete(identity);
                  capturedScope.firstPartyPublishedFinals.add(identity);
                },
              }
            : {}),
        });
        await this.#phase("first-party-finality", async () => {
          await firstPartyFinalitySession?.start();
        });
        const projectionFinality = firstPartyFinalitySession;
        firstPartySurfaceSession = await this.#phase("first-party-surface", () =>
          retryControlAdmission(
            () =>
              losslessDataPlane.openFirstPartySurfaceSession({
                executorId: targetExecutorId,
                assignmentId,
                ref: streamRef,
                ticket,
                surfacePrincipal: executionIngress.surfacePrincipal,
                adoptFrame: async (frame, _checkpoint, _signal, readDisplay) => {
                  if (frame.payload.kind === "provisional-final") {
                    await projectionFinality?.acceptProvisionalFinal(frame);
                  }
                  await this.#onFirstPartyFrame?.(frame, readDisplay);
                },
              }),
            async () => {},
            input.options?.abortSignal,
          ),
        );
      }
      firstPartySurfaceSession?.start();

      const executeLocal = (async function* (
        this: TurnExecution,
        effect: ConversationExecutorExecutionEffect,
      ): AsyncGenerator<AgentYield, RunResult> {
        const executionRuntime = effect.runtime;
        executionScope ??= effect.openExecutionScope();
        await this.#phase("start-and-report", () =>
          effect.startAndReport(submissionContext),
        );

        const stream = await this.#phase("create-stream", () =>
          effect.createStream({ assignmentId, ref: streamRef }),
        );
        let beforeFirstModelCall = true;
        const appendObservedFrame = async (
          ...args: Parameters<typeof stream.append>
        ) => {
          this.#foreground?.pulse();
          const frame = await stream.append(...args);
          if (
            executionIngress.kind === "first-party" &&
            this.#losslessDataPlane.kind === "absent" &&
            this.#onFirstPartyFrame
          ) {
            await this.#onFirstPartyFrame(validateStreamFrame(frame));
          }
        };
        const streamMeta = executionIngress.turnOrigin
          ? { turnOrigin: executionIngress.turnOrigin }
          : {};
        let observedFinal: Awaited<ReturnType<typeof stream.final>> | undefined;
        let streamEndPublished = false;
        const finishObservedStream = async () => {
          const final = (observedFinal ??= await stream.final(streamMeta));
          firstPartyStreamFinalSeq = final.finalSeq;
          if (
            !streamEndPublished &&
            executionIngress.kind === "first-party" &&
            this.#losslessDataPlane.kind === "absent"
          ) {
            this.#onFirstPartyStreamEnd?.({
              conversationId: input.conversationId,
              runId,
              assignmentId,
              finalSeq: final.finalSeq,
            });
            streamEndPublished = true;
          }
          return final;
        };
        const yieldToDurableCancellation = async (): Promise<boolean> => {
          const state = await journal.runState(runId);
          if (state !== "cancel-requested" && state !== "cancelled") return false;
          if (state === "cancel-requested") {
            await this.#settlement.drivePendingCancellations(journal, capturedScope);
          }
          if (!observedFinal) await interactionScope.drain();
          await finishObservedStream();
          await stream.markTerminal?.();
          this.#scope.markRecoveryInScope(capturedScope, input.conversationId);
          this.#settlement.kickDelivery(input.hooks?.onFinalPublishFailure);
          return true;
        };
        const settleTerminal = async <T>(
          operation: (cancelled: boolean) => Promise<T>,
        ): Promise<T> => {
          return retryDurableObligation(
            async () => {
              const outcome = await retryControlAdmission(
                () =>
                  this.#settlement.terminalOperations.run(async () => {
                    if (currentMaintenanceAbortSignal().aborted) {
                      throw new StorageMaintenanceCancelledError();
                    }
                    const cancelled = await yieldToDurableCancellation();
                    try {
                      return { ok: true as const, value: await operation(cancelled) };
                    } catch (error) {
                      if (maintenanceRetryDelayMs(error) !== undefined) throw error;
                      return { ok: false as const, error };
                    }
                  }),
                async () => {},
              );
              if (!outcome.ok) throw outcome.error;
              return outcome.value;
            },
            currentMaintenanceAbortSignal(),
            (error) => error instanceof RetryableRunEndPreparation,
          );
        };
        let toolCalls = 0;
        const interactionScope = effect.createInteractionScope({
          conversationId: input.conversationId,
          interactions: this.#interactions,
          context: submissionContext,
          surfacePrincipal: executionIngress.surfacePrincipal,
          broker: executionRuntime.confirmationBroker,
          stream,
          streamMeta,
        });
        const controlHeartbeat = effect.startHeartbeat();
        let runEndPrepared = false;
        const settleFailure = async (error: unknown): Promise<never> => {
          await controlHeartbeat.stop();
          try {
            await settleTerminal(async (cancelled) => {
              if (cancelled) return;
              const usageFinal = await flushResourceUsage();
              if (await effect.hasOpenSideEffects()) {
                await journal.markAssignmentUncertain(
                  assignmentId,
                  "ledger-unknown",
                );
              } else {
                if (!runEndPrepared) {
                  await this.#prepareRunEndUntilAvailable(
                    effect,
                    submissionContext,
                    interactionScope,
                  );
                  runEndPrepared = true;
                }
                const failure = await effect.failExecution({
                  reason: executionFailureReason(error),
                  usageFinal,
                });
                if (failure) {
                  const currentState = await journal.runState(runId);
                  if (currentState === "dispatched" || currentState === "running") {
                    await journal.failAssignedRun(
                      runId,
                      assignmentId,
                      failure.reason,
                      failure.usageFinal,
                    );
                  }
                  await finishObservedStream();
                  await stream.markTerminal?.();
                }
              }
              this.#settlement.kickDelivery();
            });
          } catch (settlementError) {
            throw new AggregateError(
              [error, settlementError],
              `Conversation execution failed (${executionFailureReason(error)}) and durable failure settlement failed (${executionFailureReason(settlementError)})`,
            );
          }
          throw error;
        };

        let runResult: RunResult;
        let inputPort: RunInputPort | undefined;
        let releaseConfirmation: (() => void) | undefined;
        try {
          releaseConfirmation = this.#requiredManager().bindExecutionConfirmation(
            input.conversationId,
            executionRuntime,
          );
          inputPort =
            input.invocation.kind === "agent"
              ? await this.#phase("open-run-input", () =>
                  journal.openRunInput(runId, assignmentId),
                )
              : undefined;
          const generator = effect.runKernel(executionMessages, {
            ...input.options,
            inputPort,
            turnContext: executionTurnContext(
              dispatch.envelope.work,
              input.options?.turnContext,
            ),
            modelProviderPhases: {
              entered: () => attemptForeground.pause(),
              settled: () => attemptForeground.resume(),
            },
            onProtocolEvent: async (event, meta) => {
              const append = () =>
                appendObservedFrame(
                  { kind: "agent-event", event },
                  {
                    ...streamMeta,
                    ...(meta.lineage ? { lineage: meta.lineage } : {}),
                  },
                );
              await (beforeFirstModelCall
                ? this.#phase(`event-append.${event.event}`, append)
                : append());
            },
            toolSideEffectObserver: this.#interactions,
            assignmentIssuedAt: dispatch.envelope.issuedAt,
            assignmentMutations: effect.assignmentMutations({
              execution: "conversation",
              anchorEpoch: this.#authority.ownerEpoch,
              allowGlobal: this.#authority.globalPublishing,
              ...(this.#authority.globalPublishing
                ? {
                    capability: assignmentGlobalCapability({
                      assignmentId,
                      execution: "conversation",
                      capabilities: dispatch.envelope.capabilities,
                    }),
                  }
                : {}),
            }),
            ...(this.#authority.globalState
              ? {
                  globalQuery: createAssignmentGlobalQueryPort({
                    state: this.#authority.globalState,
                    capability: assignmentGlobalCapability({
                      assignmentId,
                      execution: "conversation",
                      capabilities: dispatch.envelope.capabilities,
                    }),
                    anchorEpoch: this.#authority.ownerEpoch,
                  }),
                }
              : this.#authority.executionAssetCatalog
                ? { globalQuery: this.#authority.executionAssetCatalog }
                : {}),
            authorizeToolExecution: () =>
              effect.authorizeToolExecution(dispatch.envelope.permissionLease),
            modelCallResourceMeter: (() => {
              const tracker = createLeaseBudgetTracker(
                dispatch.envelope.resourceLease.budget,
              );
              return {
                budgetSnapshot: () => tracker.snapshot(),
                reserve: async ({ callIndex, tokenUpperBound }) => {
                  const usageId = `usage:${assignmentId}:model:${callIndex}`;
                  beforeFirstModelCall = false;
                  await this.#phase("model-usage-reserve", () =>
                    retryResourceUsage(
                      () =>
                        this.#requireExecutionResources().reserveUsage(
                          dispatch.envelope.resourceLease,
                          { usageId, tokens: tokenUpperBound, calls: 1 },
                          resourceSubmissionContext,
                        ),
                      input.options?.abortSignal,
                    ),
                  );
                  tracker.recordReserved(usageId, tokenUpperBound);
                  return { usageId };
                },
                consume: async ({ usageId, tokens }) => {
                  await this.#phase("model-usage-consume", () =>
                    retryResourceUsage(
                      () =>
                        this.#requireExecutionResources().consume(
                          dispatch.envelope.resourceLease,
                          { usageId, ...(tokens === 0 ? {} : { tokens }), calls: 1 },
                          resourceSubmissionContext,
                        ),
                      input.options?.abortSignal,
                    ),
                  );
                  tracker.recordConsumed(usageId, tokens);
                },
              };
            })(),
          });
          try {
            while (true) {
              const item = await interactionScope.run(() => generator.next());
              if (item.done) {
                runResult = item.value;
                break;
              }
              if (item.value.type === "tool_start") toolCalls += 1;
              await appendObservedFrame(
                { kind: "agent-yield", yield: item.value },
                streamMeta,
              );
              if (
                executionIngress.kind !== "first-party" ||
                !this.#onFirstPartyFrame
              ) {
                yield item.value;
              }
            }
          } finally {
            await interactionScope.run(() => generator.return(undefined as never));
          }
        } catch (error) {
          return await settleFailure(error);
        } finally {
          try {
            releaseConfirmation?.();
          } finally {
            try {
              await controlHeartbeat.stop();
            } finally {
              await inputPort?.close();
            }
          }
        }

        if (runResult.agentResult.reason !== "completed") {
          const cancelled = await settleTerminal(async (cancelled) => {
            if (cancelled) return true;
            const usageFinal = await flushResourceUsage();
            if (await effect.hasOpenSideEffects()) {
              await journal.markAssignmentUncertain(
                assignmentId,
                "ledger-unknown",
              );
            } else {
              if (!runEndPrepared) {
                await this.#prepareRunEndUntilAvailable(
                  effect,
                  submissionContext,
                  interactionScope,
                );
                runEndPrepared = true;
              }
              await finishObservedStream();
              const failure = await effect.failExecution({
                reason: runFailureReason(runResult.agentResult),
                usageFinal,
              });
              if (failure) {
                const currentState = await journal.runState(runId);
                if (currentState === "dispatched" || currentState === "running") {
                  await journal.failAssignedRun(
                    runId,
                    assignmentId,
                    failure.reason,
                    failure.usageFinal,
                  );
                }
              }
              await stream.markTerminal?.();
            }
            return false;
          });
          if (cancelled) return cancelledRunResult(runResult);
          this.#settlement.kickDelivery(
            input.hooks?.onFinalPublishFailure,
            runResult,
          );
          return runResult;
        }

        const terminal = await settleTerminal(async (cancelled) => {
          if (cancelled) {
            return { kind: "cancelled" as const };
          }
          if (!runEndPrepared) {
            await this.#prepareRunEndUntilAvailable(
              effect,
              submissionContext,
              interactionScope,
            );
            runEndPrepared = true;
          }
          const sourceValue = runResult.runRecord.source ?? input.options?.source;
          const advancement =
            runResult.runRecord.advancement ?? input.options?.advancement;
          const transcriptRun: TranscriptRunRecord = {
            ...runResult.runRecord,
            type: "run",
            runId,
            runIndex: dispatch.envelope.work.baseRevision,
            ...(sourceValue ? { source: sourceValue } : {}),
            ...(advancement ? { advancement } : {}),
          };
          const usageFinal = await flushResourceUsage();
          const bundle = await effect.sealConversationBundle({
            runRecord: transcriptRun,
            ...(runResult.windowCompact
              ? { windowCompact: runResult.windowCompact }
              : {}),
            contentAssets: [...appliedAdmission.attachments],
            streamFinal: await finishObservedStream(),
            usage: {
              inputTokens: runResult.agentResult.usage.inputTokens,
              outputTokens: runResult.agentResult.usage.outputTokens,
              toolCalls,
            },
            usageFinal,
          });
          const committed = await effect.submitSealedBundle(submissionContext);
          if (!committed.committed) {
            const error = new Error(
              `Conversation commit rejected: ${committed.error.message}`,
            );
            input.hooks?.onCommitFailure?.(error, runResult);
            throw error;
          }
          await stream.markTerminal?.();
          return { kind: "committed" as const, bundle, committed };
        }).catch(settleFailure);

        if (terminal.kind === "cancelled") return cancelledRunResult(runResult);
        const { bundle, committed } = terminal;
        if (firstPartySurfaceSession && firstPartyFinalitySession) {
          const final = (await journal.pendingFinalFrames()).find(
            (candidate) =>
              candidate.conversationId === input.conversationId &&
              candidate.runId === runId &&
              candidate.commitRevision === committed.commitRevision,
          );
          if (!final) {
            throw new Error(
              "Committed first-party run has no durable final projection",
            );
          }
          const finalIdentity = canonicalize(final);
          capturedScope.pendingFirstPartyFinals.add(finalIdentity);
          try {
            await firstPartyFinalitySession.confirmConversationFinal({
              frame: final,
              bundle,
            });
          } catch (error) {
            input.hooks?.onFinalPublishFailure?.(error, runResult);
          }
          drainFirstPartyProjection(bundle.streamFinal.finalSeq, finalIdentity);
        }
        this.#scope.markRecoveryInScope(capturedScope, input.conversationId);
        this.#settlement.kickDelivery(
          input.hooks?.onFinalPublishFailure,
          runResult,
        );
        return runResult;
      }).bind(this);

      return yield* executorPlan.run({
        execute: executeLocal,
        foreground: attemptForeground,
        onCommitted: (committed) =>
          replayCommittedRun(committed.runRecord, committed.windowCompact),
        onRemoteSettled: () => {
          this.#scope.markRecoveryInScope(capturedScope, input.conversationId);
          this.#settlement.kickDelivery();
        },
      });
    } catch (error) {
      runFailed = true;
      runError = error;
      if (error instanceof ConversationPendingCancellationError) {
        this.#scope.markRecoveryInScope(capturedScope, input.conversationId);
        throw error;
      }
      const cancelledPreparation =
        (error instanceof ConversationAssignmentCancelledError &&
          error.runId === runId &&
          error.assignmentId === assignmentId) ||
        ((error instanceof AssignmentStartCancelledError ||
          (error instanceof DataPlaneAssignmentInactiveError &&
            error.ref.execution === "conversation" &&
            error.ref.runId === runId &&
            error.ref.conversationId === input.conversationId)) &&
          error.assignmentId === assignmentId &&
          ["cancel-requested", "cancelled"].includes(
            (await journal.runState(runId)) ?? "",
          ));
      if (cancelledPreparation) {
        this.#scope.markRecoveryInScope(capturedScope, input.conversationId);
        await this.#settlement.drivePendingCancellations(journal, capturedScope);
        this.#settlement.kickDelivery();
        runFailed = false;
        const usage = { inputTokens: 0, outputTokens: 0 };
        return {
          agentResult: { reason: "aborted", usage },
          runRecord: { timestamp: this.#clock(), messages: [], usage },
          newMessages: [],
          durationMs: 0,
        };
      }
      const userCancelled =
        (error as { name?: unknown } | null)?.name === "AbortError" &&
        (await journal
          .runState(runId)
          .then(
            (state) => state === "cancel-requested" || state === "cancelled",
            () => false,
          ));
      if (!userCancelled) {
        this.#observeFailure(error, {
          phase: "run",
          conversationId: input.conversationId,
          runId,
        });
      }
      this.#scope.markRecoveryInScope(capturedScope, input.conversationId);
      throw error;
    } finally {
      await this.#settlement.cleanupRunAttempt({
        attempt: attemptHandle,
        assignmentId,
        getChannelSession: () => channelSession,
        getFirstPartyStreamFinalSeq: () => firstPartyStreamFinalSeq,
        drainFirstPartyProjection,
        getFirstPartyFinalitySession: () => firstPartyFinalitySession,
        getFirstPartySurfaceSession: () => firstPartySurfaceSession,
        getExecutorPlan: () => executorPlan,
        getExecutionScope: () => executionScope,
        runFailed,
        runError,
      });
    }
  }

  async #prepareRunEndUntilAvailable(
    effect: ConversationExecutorExecutionEffect,
    context: AuthorityCallContext,
    interactionScope: ConversationExecutorInteractionScope,
  ): Promise<void> {
    try {
      await effect.prepareForRunEnd(context);
      await interactionScope.drain();
    } catch (error) {
      if (
        maintenanceRetryDelayMs(error) !== undefined ||
        error instanceof AuthorityStorageError ||
        !shouldRetryRemoteObligation(error)
      ) {
        throw error;
      }
      throw new RetryableRunEndPreparation(error);
    }
  }

  async #advancementExecutionContext(
    conversationId: string,
    ingress: IngressContext,
  ): Promise<{ source: string; block: string }[]> {
    const binding = ingress.turnOrigin?.advancementExecution;
    if (!binding) return [];
    const material: AdvancementExecutionMaterial = this.#advancementExecution
      ? await this.#advancementExecution.prepare({
          conversationId,
          turnId: ingress.ingressId,
          binding,
        })
      : Object.freeze({
          status: "unavailable",
          turnId: ingress.ingressId,
          binding,
          reason: "宿主没有装配推进执行材料",
        });
    return [advancementExecutionContextBlock(material)];
  }
}
