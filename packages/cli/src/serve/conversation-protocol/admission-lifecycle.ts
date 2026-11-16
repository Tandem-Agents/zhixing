import { randomUUID } from "node:crypto";
import { normalizeUserTurnInput } from "@zhixing-ai/core";
import type { SurfaceAssetCoordinator } from "@zhixing-ai/core/authority";
import type { LogRecordPort } from "@zhixing-ai/core/logging";
import { canonicalize } from "@zhixing-ai/core/protocol";
import {
  currentMaintenanceAbortSignal,
  maintenanceRetryDelayMs,
  StorageMaintenanceCancelledError,
  type ForegroundActivityPort,
} from "@zhixing-ai/core/resources";
import {
  createConversationControlEnvelope,
  createInitialControlEnvelope,
} from "@zhixing-ai/owner-kernel/control-admission";
import type {
  ConversationRunJournal,
  PendingConversationInput,
} from "@zhixing-ai/owner-kernel/conversation-assignment";
import type { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import {
  DurableConversationAdmissionRejectedError,
  type DurableConversationAdmissionInput,
  type DurableConversationAdmissionResult,
  type DurableConversationSessionProjectionInput,
  type DurableConversationSessionWriteInput,
  type DurableConversationSessionWriteResult,
} from "@zhixing-ai/owner-kernel/run-turn";
import { retryControlAdmission } from "../conversation-admission-retry.js";
import type { ConversationAssignmentArtifactAuthorityIndex } from "../conversation-executor-dispatch.js";
import type { ConversationOwnerRuntimeStack } from "../conversation-owner-runtime.js";
import type { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import type { AppliedConversationAdmission } from "./contracts.js";
import type { ConversationAccess } from "./conversation-access.js";
import {
  admissionKey,
  holdObservedForeground,
  ingressForTurn,
  inputControlRequestId,
  type AuthorityScopeState,
  type RuntimeObligationScope,
} from "./runtime-obligation-scope.js";

export interface AdmissionAndLifecycleHost {
  ensureSession(conversationId: string): Promise<void>;
  deferScheduling(conversationId: string, runId: string): void;
  settleTargetCancellations(
    conversationId: string,
    runId: string,
    scopeState?: AuthorityScopeState,
  ): Promise<boolean>;
  prepareControlBasis(): Promise<void>;
  prepareConversationBasis(
    conversationId: string,
    scopeState?: AuthorityScopeState,
  ): Promise<void>;
}

export interface AdmissionAndLifecycleOptions {
  readonly authority: ConversationOwnerRuntimeStack;
  readonly scope: RuntimeObligationScope;
  readonly access: ConversationAccess;
  readonly host: AdmissionAndLifecycleHost;
  readonly manager: () => ConversationManager;
  readonly clock: () => string;
  readonly foreground?: ForegroundActivityPort;
  readonly phaseRecords?: LogRecordPort;
  readonly projectLifecycle?: (
    input: DurableConversationSessionProjectionInput,
  ) => Promise<void>;
  readonly recoverAuxiliary: (conversationId: string) => Promise<void>;
  readonly assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly interactions: DurableConversationInteractionObserver;
}

/**
 * Owns `preparedAdmissions`, un-adopted `ForegroundObligation` handoff,
 * input admission/scheduling checks, and session write/lifecycle projections.
 */
export class AdmissionAndLifecycle {
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #scope: RuntimeObligationScope;
  readonly #access: ConversationAccess;
  readonly #host: AdmissionAndLifecycleHost;
  readonly #manager: () => ConversationManager;
  readonly #clock: () => string;
  readonly #foreground: ForegroundActivityPort | undefined;
  readonly #phaseRecords: LogRecordPort | undefined;
  readonly #projectLifecycle: AdmissionAndLifecycleOptions["projectLifecycle"];
  readonly #recoverAuxiliary: (conversationId: string) => Promise<void>;
  readonly #assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly #interactions: DurableConversationInteractionObserver;

  constructor(options: AdmissionAndLifecycleOptions) {
    this.#authority = options.authority;
    this.#scope = options.scope;
    this.#access = options.access;
    this.#host = options.host;
    this.#manager = options.manager;
    this.#clock = options.clock;
    this.#foreground = options.foreground;
    this.#phaseRecords = options.phaseRecords;
    this.#projectLifecycle = options.projectLifecycle;
    this.#recoverAuxiliary = options.recoverAuxiliary;
    this.#assignmentArtifactAuthority = options.assignmentArtifactAuthority;
    this.#interactions = options.interactions;
  }

  async admit(
    input: DurableConversationAdmissionInput,
  ): Promise<DurableConversationAdmissionResult> {
    const key = admissionKey(input);
    if (!key) {
      throw new Error("Durable conversation admission requires a stable turn id");
    }
    const scopeState = this.#scope.current;
    const admission = await this.applyInputAdmission(input, false, scopeState);
    this.#scope.markRecoveryInScope(scopeState, input.conversationId, admission.runId);
    let state: Awaited<ReturnType<ConversationRunJournal["runState"]>> = "queued";
    if (admission.replayed || input.options?.turnContext?.turnOrigin?.messageIdentity) {
      try {
        state = await this.#access
          .journal(input.conversationId, scopeState)
          .runState(admission.runId);
      } catch {
        this.#scope.markRecoveryInScope(scopeState, input.conversationId);
        return { runId: admission.runId, shouldSchedule: false };
      }
    }
    const scheduling =
      this.#scope.isCurrent(scopeState) &&
      state === "queued" &&
      !scopeState.schedulingRuns.has(admission.runId) &&
      !scopeState.scheduledRuns.has(admission.runId)
        ? await this.inputScheduling(input.conversationId, admission.runId, scopeState)
        : "blocked";
    const shouldSchedule = this.#scope.isCurrent(scopeState) && scheduling !== "blocked";
    if (!shouldSchedule) return { runId: admission.runId, shouldSchedule: false };
    const admissionId = this.#scope.nextAdmissionId();
    const claimToken = Symbol(admissionId);
    scopeState.schedulingRuns.set(admission.runId, claimToken);
    scopeState.preparedAdmissions.set(key, {
      admissionId,
      claimToken,
      conversationId: input.conversationId,
      surfacePrincipal: admission.ingress.surfacePrincipal,
      admission,
      input: normalizeUserTurnInput(input.input),
      attachments: [...(input.attachments ?? [])],
      invocation: input.invocation,
      ...(input.environment
        ? { environment: structuredClone(input.environment) }
        : {}),
      ...(scheduling === "ready" && this.#foreground
        ? {
            foreground: holdObservedForeground(
              this.#foreground,
              this.#phaseRecords,
            ),
          }
        : {}),
    });
    this.#scope.markRecoveryInScope(scopeState, input.conversationId, admission.runId);
    if (scheduling === "ready") {
      scopeState.firstSendWindows.set(input.conversationId, {
        runId: admission.runId,
        claimToken,
        deferred: false,
      });
    }
    return { runId: admission.runId, shouldSchedule, admissionId };
  }

  confirmScheduled(conversationId: string, runId: string): void {
    const scopeState = this.#scope.current;
    const prepared = [...scopeState.preparedAdmissions.values()].find(
      (candidate) =>
        candidate.conversationId === conversationId &&
        candidate.admission.runId === runId,
    );
    if (!prepared && !scopeState.scheduledRuns.has(runId)) return;
    const claimToken =
      prepared?.claimToken ??
      scopeState.schedulingRuns.get(runId) ??
      scopeState.scheduledRuns.get(runId) ??
      Symbol(runId);
    scopeState.schedulingRuns.delete(runId);
    scopeState.scheduledRuns.set(runId, claimToken);
  }

  deferScheduling(conversationId: string, runId: string): void {
    const scopeState = this.#scope.current;
    this.#scope.clearRunClaimsInScope(scopeState, runId);
    this.#scope.markRecoveryInScope(scopeState, conversationId);
  }

  scheduledTaskSettled(conversationId: string, admissionId: string): void {
    const scopeState = this.#scope.current;
    const prepared = [...scopeState.preparedAdmissions.values()].find(
      (candidate) =>
        candidate.conversationId === conversationId &&
        candidate.admissionId === admissionId,
    );
    if (!prepared) return;
    this.#host.deferScheduling(conversationId, prepared.admission.runId);
  }

  async mayScheduleInput(
    conversationId: string,
    runId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<boolean> {
    return (await this.inputScheduling(conversationId, runId, scopeState)) !== "blocked";
  }

  async inputScheduling(
    conversationId: string,
    runId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<"ready" | "behind-active" | "blocked"> {
    if (!(await this.#host.settleTargetCancellations(conversationId, runId, scopeState))) {
      return "blocked";
    }
    if (!this.#scope.isCurrent(scopeState)) return "blocked";
    const state = await this.#access
      .journal(conversationId, scopeState)
      .assignmentSchedulingState(runId);
    if (state.ready) return "ready";
    return state.blockingRunId !== undefined &&
      scopeState.scheduledRuns.has(state.blockingRunId) &&
      this.#manager()?.getSession(conversationId)?.busy === true
      ? "behind-active"
      : "blocked";
  }

  async applyInputAdmission(
    input: DurableConversationAdmissionInput,
    allowPendingReplay = false,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<AppliedConversationAdmission> {
    await this.#access.adopt(input.conversationId);
    const at = this.#clock();
    const ingress = ingressForTurn(input, this.#authority.deviceId, at);
    const requestId = inputControlRequestId(ingress);
    const source = {
      principal: {
        surfacePrincipal: ingress.surfacePrincipal,
        deviceId: this.#authority.deviceId,
        connectionId:
          input.options?.turnContext?.turnOrigin?.triggeredBy ?? "connection:local",
      },
      ingress,
    };
    const journal = this.#access.journal(input.conversationId, scopeState);
    const envelope = createInitialControlEnvelope({
      requestId,
      source,
      at,
      body: {
        t: "input",
        conversationId: input.conversationId,
        ingress: { ingressId: ingress.ingressId, source: ingress.kind },
        input: normalizeUserTurnInput(input.input),
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: [...input.attachments] }
          : {}),
        invocation: input.invocation,
        ...(input.environment
          ? { environment: structuredClone(input.environment) }
          : {}),
        ownerEpoch: this.#access.ownerEpochFor(input.conversationId, scopeState),
      },
    });
    const control = {
      admission: this.#authority.controlAdmission,
      envelope,
      source,
      runId: `run:${randomUUID()}`,
    } as const;
    const recover = async () => {
      await this.#host.prepareControlBasis();
      await this.#host.prepareConversationBasis(input.conversationId, scopeState);
    };
    return retryControlAdmission(
      async () => {
        if (
          !journal.hasRecoveredInputProjection ||
          !this.#authority.controlAdmission.hasRecoveredProjection
        ) {
          await recover();
        }
        if (currentMaintenanceAbortSignal().aborted) {
          throw new StorageMaintenanceCancelledError();
        }
        await this.#host.ensureSession(input.conversationId);
        if (currentMaintenanceAbortSignal().aborted) {
          throw new StorageMaintenanceCancelledError();
        }
        const durablePending = allowPendingReplay
          ? (
              await this.#access
                .journal(input.conversationId, scopeState)
                .pendingInputs()
            ).find(
              (candidate) =>
                candidate.ingress.ingressId === ingress.ingressId &&
                candidate.ingress.surfacePrincipal === ingress.surfacePrincipal,
            )
          : undefined;
        if (durablePending) {
          if (
            canonicalize(durablePending.input) !==
              canonicalize(normalizeUserTurnInput(input.input)) ||
            canonicalize(durablePending.attachments) !==
              canonicalize(input.attachments ?? []) ||
            canonicalize(durablePending.invocation) !==
              canonicalize(input.invocation) ||
            canonicalize(durablePending.environment ?? null) !==
              canonicalize(input.environment ?? null)
          ) {
            throw new DurableConversationAdmissionRejectedError(
              "idempotency-conflict",
              "Conversation ingress is already bound to another invocation",
            );
          }
          await this.#markAttachmentsAdopted(durablePending.attachments);
          return {
            runId: durablePending.runId,
            ingress: durablePending.ingress,
            attachments: durablePending.attachments,
            ...(durablePending.environment
              ? { environment: structuredClone(durablePending.environment) }
              : {}),
            replayed: true,
          };
        }
        const admissionState = await this.#authority.controlAdmission.lookup({
          envelope,
          source,
        });
        if (admissionState.kind === "settled") {
          const appliedReplay = admissionState.outcome;
          if (appliedReplay.kind === "rejected") {
            throw new DurableConversationAdmissionRejectedError(
              "idempotency-conflict",
              `Conversation input was rejected: ${appliedReplay.result.error.message}`,
            );
          }
          if (appliedReplay.result.status === "rejected") {
            throw new DurableConversationAdmissionRejectedError(
              appliedReplay.result.error.code === "idempotency-conflict"
                ? "idempotency-conflict"
                : "conversation-not-found",
              `Conversation input was rejected: ${appliedReplay.result.error.message}`,
            );
          }
          if (appliedReplay.result.body.t !== "input") {
            throw new Error(
              "Conversation input admission returned another control result",
            );
          }
          const replayedAttachments = [...(input.attachments ?? [])];
          await this.#markAttachmentsAdopted(replayedAttachments);
          return {
            runId: appliedReplay.result.body.runId,
            ingress,
            attachments: replayedAttachments,
            ...(input.environment
              ? { environment: structuredClone(input.environment) }
              : {}),
            replayed: true,
          };
        }
        if (
          admissionState.kind === "absent" &&
          input.attachments &&
          input.attachments.length > 0
        ) {
          await this.#assertUploadAdoption({
            scope: {
              domain: "conversation",
              conversationId: input.conversationId,
              ownerEpoch: this.#access.ownerEpochFor(
                input.conversationId,
                scopeState,
              ),
            },
            surfacePrincipal: ingress.surfacePrincipal,
            requestId,
            assets: input.attachments,
            payloadDigest: envelope.payloadDigest,
          });
        }
        let admission: Awaited<ReturnType<ConversationRunJournal["applyInputControl"]>>;
        try {
          admission = await journal.applyInputControl(control);
        } catch (firstError) {
          this.#scope.markRecoveryInScope(scopeState, input.conversationId);
          if (maintenanceRetryDelayMs(firstError) !== undefined) throw firstError;
          try {
            admission = await journal.applyInputControl(control);
          } catch (replayError) {
            if (maintenanceRetryDelayMs(replayError) !== undefined) throw replayError;
            if (
              firstError instanceof DurableConversationAdmissionRejectedError &&
              replayError instanceof DurableConversationAdmissionRejectedError
            ) {
              throw replayError;
            }
            throw new AggregateError(
              [firstError, replayError],
              "Conversation input admission could not determine its durable disposition",
            );
          }
        }
        if (admission.kind === "rejected") {
          throw new DurableConversationAdmissionRejectedError(
            "idempotency-conflict",
            `Conversation input was rejected: ${admission.result.error.message}`,
          );
        }
        if (admission.result.status === "rejected") {
          throw new DurableConversationAdmissionRejectedError(
            admission.result.error.code === "idempotency-conflict"
              ? "idempotency-conflict"
              : "conversation-not-found",
            `Conversation input was rejected: ${admission.result.error.message}`,
          );
        }
        if (admission.result.body.t !== "input") {
          throw new Error(
            "Conversation input admission returned another control result",
          );
        }
        let durableIngress = ingress;
        let durableAttachments = [...(input.attachments ?? [])];
        let durableEnvironment = input.environment
          ? structuredClone(input.environment)
          : undefined;
        const admittedRunId = admission.result.body.runId;
        if (admission.kind === "replayed") {
          const pending = (await journal.pendingInputs()).find(
            (candidate) => candidate.runId === admittedRunId,
          );
          if (pending) {
            durableIngress = pending.ingress;
            durableAttachments = [...pending.attachments];
            durableEnvironment = pending.environment
              ? structuredClone(pending.environment)
              : undefined;
          }
        }
        await this.#markAttachmentsAdopted(durableAttachments);
        return {
          runId: admittedRunId,
          ingress: durableIngress,
          attachments: durableAttachments,
          ...(durableEnvironment ? { environment: durableEnvironment } : {}),
          replayed: admission.kind === "replayed",
        };
      },
      recover,
      input.options?.abortSignal,
    );
  }

  async #markAttachmentsAdopted(
    attachments: PendingConversationInput["attachments"],
  ): Promise<void> {
    if (this.#authority.surfaceAssets) {
      await this.#authority.surfaceAssets.markAdopted(attachments);
      return;
    }
    for (const attachment of attachments) {
      if (!(await this.#authority.artifacts.has(attachment))) {
        throw new Error(`Conversation attachment is unavailable: ${attachment.digest}`);
      }
    }
  }

  async #assertUploadAdoption(
    input: Parameters<SurfaceAssetCoordinator["assertUploadAdoption"]>[0],
  ): Promise<void> {
    if (this.#authority.surfaceAssets) {
      await this.#authority.surfaceAssets.assertUploadAdoption(input);
      return;
    }
    for (const asset of input.assets) {
      if (!(await this.#authority.artifacts.has(asset))) {
        throw new Error(`Conversation attachment is unavailable: ${asset.digest}`);
      }
    }
  }

  async writeSession(
    input: DurableConversationSessionWriteInput,
  ): Promise<DurableConversationSessionWriteResult> {
    await this.#access.adopt(input.conversationId);
    const scopeState = this.#scope.current;
    const journal = this.#access.journal(input.conversationId, scopeState);
    const lifecycleMutation =
      input.mutation.kind === "conversation-delete" ||
      (input.mutation.kind === "window-op" && input.mutation.op === "clear");
    const existingLifecycle = lifecycleMutation
      ? await journal.lifecycleRequest(input.requestId)
      : undefined;
    const existingMutation = lifecycleMutation
      ? undefined
      : await journal.sessionMutationRequest(input.requestId);
    const existing = existingLifecycle ?? existingMutation;
    const authority = existing ? undefined : await journal.authorityState();
    if (
      !existing &&
      !authority!.hasDurableIdentity &&
      !(await input.conversationExists())
    ) {
      return { status: "not-found" };
    }
    const domainRevision = existing
      ? existing.domainRevision - 1
      : authority!.domainRevision;
    const source = { principal: { ...input.principal } };
    const outcome = await this.applyAuthorityControl(
      input.conversationId,
      journal,
      {
        admission: this.#authority.controlAdmission,
        envelope: createConversationControlEnvelope({
          requestId: input.requestId,
          source,
          at: this.#clock(),
          body: {
            t: "session-write",
            conversationId: input.conversationId,
            mutation: input.mutation,
            ownerEpoch: this.#access.ownerEpochFor(input.conversationId, scopeState),
            domainRevision,
          },
        }),
        source,
      },
      false,
      scopeState,
    );
    if (outcome.kind === "rejected") {
      throw new Error(`Session write was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.status === "rejected") {
      if (
        outcome.result.error.code === "busy" ||
        outcome.result.error.code === "revision-conflict"
      ) {
        return { status: "busy" };
      }
      if (outcome.result.error.code === "not-found") {
        return { status: "not-found" };
      }
      throw new Error(`Session write was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.body.t !== "session-write") {
      throw new Error("Session write returned another control result");
    }
    if (lifecycleMutation) {
      this.#scope.markRecoveryInScope(scopeState, input.conversationId);
    }
    return {
      status: "accepted",
      domainRevision: outcome.result.body.revision,
    };
  }

  async projectSession(
    input: DurableConversationSessionProjectionInput,
  ): Promise<void> {
    const scopeState = this.#scope.current;
    let verified = false;
    try {
      await retryControlAdmission(
        async () => {
          await this.#access.adopt(input.conversationId);
          const journal = this.#access.journal(input.conversationId, scopeState);
          if (!verified) {
            const fact = await journal.lifecycleRequest(input.requestId);
            if (
              !fact ||
              fact.conversationId !== input.conversationId ||
              fact.mutation !== input.mutation ||
              fact.domainRevision !== input.domainRevision
            ) {
              throw new Error(
                "Lifecycle projection does not bind its durable authority fact",
              );
            }
            verified = true;
          }
          await this.resumeLifecycleProjections(
            input.conversationId,
            journal,
            scopeState,
          );
        },
        () => this.#host.prepareConversationBasis(input.conversationId, scopeState),
      );
    } catch (error) {
      if (verified) {
        this.#scope.markRecoveryInScope(scopeState, input.conversationId);
      }
      throw error;
    }
  }

  async completeLifecycleProjections(conversationId: string): Promise<number> {
    await this.#access.adopt(conversationId);
    const scopeState = this.#scope.current;
    return this.resumeLifecycleProjections(
      conversationId,
      this.#access.journal(conversationId, scopeState),
      scopeState,
    );
  }

  async resumeLifecycleProjections(
    conversationId: string,
    journal: ConversationRunJournal,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<number> {
    const existing = this.#scope.lifecycleProjectionClaims.get(conversationId);
    if (existing) return existing;
    const projection = this.#runLifecycleProjections(
      conversationId,
      journal,
      scopeState,
    ).finally(() => {
      if (this.#scope.lifecycleProjectionClaims.get(conversationId) === projection) {
        this.#scope.lifecycleProjectionClaims.delete(conversationId);
      }
    });
    this.#scope.lifecycleProjectionClaims.set(conversationId, projection);
    return projection;
  }

  async #runLifecycleProjections(
    conversationId: string,
    journal: ConversationRunJournal,
    scopeState: AuthorityScopeState,
  ): Promise<number> {
    const state = await journal.authorityState();
    if (state.pendingLifecycleProjections === 0) {
      if (state.deleted) {
        await this.#recoverAuxiliary(conversationId);
        this.#scope.retireConversationInScope(
          scopeState,
          conversationId,
          this.#assignmentArtifactAuthority,
          this.#interactions,
        );
      }
      return 0;
    }
    if (!this.#projectLifecycle) {
      throw new Error("Durable conversation lifecycle projection is not configured");
    }
    const projected = await journal.resumeLifecycleProjections(async (input) => {
      if (input.mutation === "delete") {
        await this.#authority.surfaceAssets?.revokeConversation(input.conversationId);
      }
      await this.#projectLifecycle!(input);
    });
    const after = await journal.authorityState();
    await this.#recoverAuxiliary(conversationId);
    if (after.deleted && after.pendingLifecycleProjections === 0) {
      this.#scope.retireConversationInScope(
        scopeState,
        conversationId,
        this.#assignmentArtifactAuthority,
        this.#interactions,
      );
    }
    return projected;
  }

  async applyAuthorityControl(
    conversationId: string,
    journal: ConversationRunJournal,
    input: Parameters<ConversationRunJournal["applyControl"]>[0],
    deferCapacityRetry = false,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<Awaited<ReturnType<ConversationRunJournal["applyControl"]>>> {
    try {
      return await journal.applyControl(input);
    } catch (firstError) {
      this.#scope.markRecoveryInScope(scopeState, conversationId);
      if (deferCapacityRetry && maintenanceRetryDelayMs(firstError) !== undefined) {
        throw firstError;
      }
      try {
        return await journal.applyControl(input);
      } catch (replayError) {
        throw new AggregateError(
          [firstError, replayError],
          "Conversation control could not determine its durable disposition",
        );
      }
    }
  }
}
