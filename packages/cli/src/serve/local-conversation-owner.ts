import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  buildStartupBootstrapPair,
  localConversationId,
  parseRubricDocument,
  projectRubricContractDraft,
  rubricDocumentId,
  stringifyRubricDraft,
  userTurnInputFromText,
  type Conversation,
  type RubricContractDraftSnapshot,
  type RubricDraftPersistenceChoice,
  type RunRecordRef,
  type UserTurnInput,
} from "@zhixing/core";
import type {
  DeferredGlobalIntent,
  EvidenceHandlerPort,
  ExplicitEnvironmentSelection,
  FinalFrame,
  ScheduleWriteMutation,
  SessionStatePort,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type { ArtifactStore } from "@zhixing/core/authority";
import {
  projectConversationClear,
  type ConversationClearCommitPort,
  type ConversationClearedFact,
} from "@zhixing/core/conversation/application";
import {
  ConversationManager,
  ConversationTransferSource,
  DeferredGlobalIntentRepository,
  listConversationTransferStates,
  resolveCurrentConversationAuthority,
  type CurrentConversationAuthority,
  type RuntimeFactory,
  type TurnCommittedInfo,
} from "@zhixing/owner-kernel";
import {
  createAdvancementRecoveryMaintenance,
  DeferredRubricPublication,
  DeferredScheduleIntentProducer,
  renderRecentContextFromMessages,
  type AdvancementController,
  type AdvancementRecoveryMaintenance,
  type DeferredScheduleIntentResult,
} from "@zhixing/owner-services";
import {
  createAdvancementEventSink,
  createAdvancementOriginalTaskAdmissionPort,
  createAdvancementProxyTurnPort,
} from "@zhixing/server";
import type {
  ProviderCredentialProjection,
  ZhixingConfig,
} from "@zhixing/providers";
import type {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import {
  projectSessionTurn,
  type ProjectedSessionTurnResult,
  type SessionTurnNotify,
} from "@zhixing/rpc";
import { createAdvancementReviewMaintenance } from "./advancement-review-maintenance.js";
import { createServeAdvancementController } from "./advancement-controller.js";
import { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";
import type { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import type { LocalConversationOwnerRuntimeStack } from "./conversation-owner-runtime.js";
import { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import { GlobalRubricCatalog } from "./advancement-rubric-library.js";

/** 本地域 port 的会话只读面:冻结读取子集;写入只能经 port 的命令 wrapper。 */
export type LocalConversationSessionReadPort = Readonly<
  Pick<
    SessionStatePort,
    | "readSessionMeta"
    | "readTranscriptTail"
    | "readTaskList"
    | "readAdvancementState"
  >
>;

export async function verifyLocalConversationFinal(
  protocol: Pick<ConversationProtocolRuntime, "finalHistory">,
  frame: FinalFrame,
): Promise<void> {
  const committed = await protocol.finalHistory(
    frame.conversationId,
    Math.max(0, frame.commitRevision - 1),
  );
  if (!committed.some((item) => canonicalize(item.frame) === canonicalize(frame))) {
    throw new Error("Local final frame is not present in authoritative history");
  }
}

/**
 * 本地域 owner 的 internal-only 消费面。只读视图冻结;mutation / answer /
 * admission 逐项经命令 wrapper,副作用前共用同一生命周期栅栏;不暴露任何
 * raw 可写对象(manager / protocol / advancement / consumer)。
 */
export interface LocalConversationOwnerPort {
  createConversation(): Promise<string>;
  ensureSession(conversationId: string): Promise<void>;
  listConversations(): Promise<readonly string[]>;
  listConversationAuthorities(): Promise<readonly {
    readonly conversationId: string;
    readonly authority: CurrentConversationAuthority;
  }[]>;
  currentAuthority(conversationId: string): Promise<CurrentConversationAuthority>;
  commitConversationClear: ConversationClearCommitPort["commit"];
  subscribeConversationFacts(
    listener: (fact: ConversationClearedFact) => void,
  ): () => void;
  mutateSession: SessionStatePort["mutate"];
  cancelTurns(input: {
    readonly conversationId: string;
    readonly requestId: string;
  }): Promise<void>;
  resolveDurableUncertain(
    input: Omit<
      Parameters<ConversationManager["resolveDurableUncertain"]>[0],
      "principal"
    > & {
      readonly surfacePrincipal: string;
      readonly connectionId: string;
    },
  ): ReturnType<ConversationManager["resolveDurableUncertain"]>;
  runTurn(input: {
    readonly conversationId: string;
    readonly text: string;
    readonly turnId: string;
    readonly environment?: ExplicitEnvironmentSelection;
    readonly notify?: SessionTurnNotify;
  }): Promise<ProjectedSessionTurnResult>;
  admitTurn(input: {
    readonly conversationId: string;
    readonly input: UserTurnInput;
    readonly turnId: string;
    readonly environment?: ExplicitEnvironmentSelection;
    readonly notify: SessionTurnNotify;
  }): Promise<{
    readonly status: "immediate" | "queued" | "replayed";
    readonly runId?: string;
    readonly outcome: Promise<ProjectedSessionTurnResult>;
  }>;
  answerInteractionWithTicket(
    input: Parameters<DurableConversationInteractionObserver["answerInteractionWithTicket"]>[0],
  ): Promise<void>;
  resolveNoInteractiveSurface(
    input: Parameters<DurableConversationInteractionObserver["resolveNoInteractiveSurface"]>[0],
  ): Promise<void>;
  deferSchedule(input: {
    readonly conversationId: string;
    readonly requestId: string;
    readonly mutation: ScheduleWriteMutation;
  }): Promise<DeferredScheduleIntentResult>;
  listDeferredIntents(conversationId: string): Promise<readonly DeferredGlobalIntent[]>;
  discardDeferredIntent(intentId: string): Promise<void>;
  readonly sessionState: LocalConversationSessionReadPort;
  readonly statusHistory: ConversationProtocolRuntime["statusHistory"];
  readonly finalHistory: ConversationProtocolRuntime["finalHistory"];
  readonly pendingInteractions: DurableConversationInteractionObserver["pendingInteractions"];
  readonly rubricCatalog: Readonly<
    Pick<GlobalRubricCatalog, "listForMatching" | "load">
  >;
}

export interface LocalConversationRemovalSnapshot {
  readonly operationId: string;
  readonly conversations: readonly {
    readonly conversationId: string;
    readonly displayName: string;
    readonly state: "current" | "frozen" | "importing";
  }[];
  readonly acceptedWork: {
    readonly active: number;
    readonly pendingFinals: number;
    readonly pendingAssignments: number;
    readonly deferredIntents: number;
    readonly outbox: number;
    readonly leases: number;
    readonly permits: number;
  };
  readonly ownerItems: readonly {
    readonly owner:
      | "conversation"
      | "intent"
      | "final"
      | "assignment"
      | "remote"
      | "channel"
      | "scheduler"
      | "delivery"
      | "lease"
      | "permit";
    readonly id: string;
    readonly revision: string;
  }[];
}

export interface LocalConversationOwnerAssemblyOptions {
  readonly owner: LocalConversationOwnerRuntimeStack;
  /**
   * Executor-only composition may pass its existing device-log ledger. An
   * anchor+executor host omits it so the local owner creates a ledger on the
   * executor authority log instead of reusing the anchor-domain ledger.
   */
  readonly ledger?: ConversationAssignmentLedger;
  readonly ConversationAssignmentLedger: typeof ConversationAssignmentLedger;
  readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
  readonly runtimeFactory: RuntimeFactory;
  readonly interactions: DurableConversationInteractionObserver;
  readonly config: ZhixingConfig;
  readonly credentials: ProviderCredentialProjection;
  readonly evidence: EvidenceHandlerPort;
  readonly currentAnchorDeviceId: () => string | undefined;
  readonly dataPlane: Pick<ExecutorDataPlaneRuntime, "tickets" | "createStream">;
  /** 关闭时 drain 的判定预算;默认 30s,只在无法证明收束时决定失败收场时机。 */
  readonly closeDrainBudgetMs?: number;
}

/**
 * Device-local conversation composition root. It intentionally exposes only an
 * internal port: product RPC, CLI and channel routing remain anchor-owned.
 */
export class LocalConversationOwnerAssembly {
  readonly #owner: LocalConversationOwnerRuntimeStack;
  readonly #protocol: ConversationProtocolRuntime;
  readonly #manager: ConversationManager;
  readonly #recovery: AdvancementRecoveryMaintenance;
  readonly #intents: DeferredGlobalIntentRepository;
  readonly #transferSource: ConversationTransferSource;
  readonly #port: LocalConversationOwnerPort;
  readonly #closeDrainBudgetMs: number;
  #state: "created" | "starting" | "ready" | "closing" | "closed" = "created";
  #started = false;
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #activeCommands = 0;
  #commandDrain: Promise<void> | undefined;
  #resolveCommandDrain: (() => void) | undefined;
  readonly #transferringConversations = new Set<string>();
  readonly #conversationFactListeners: Set<
    (fact: ConversationClearedFact) => void
  >;
  readonly #transferAbort = new AbortController();
  #removalOperationId: string | undefined;
  #removalSnapshot: LocalConversationRemovalSnapshot | undefined;
  #hostStopOperationId: string | undefined;
  #hostStopSnapshot: LocalConversationRemovalSnapshot | undefined;
  #hostStopSettlement: Promise<void> | undefined;
  #hostStopSettledOperationId: string | undefined;

  private constructor(input: {
    readonly options: LocalConversationOwnerAssemblyOptions;
    readonly protocol: ConversationProtocolRuntime;
    readonly manager: ConversationManager;
    readonly recovery: AdvancementRecoveryMaintenance;
    readonly intents: DeferredGlobalIntentRepository;
    readonly scheduleIntents: DeferredScheduleIntentProducer;
    readonly rubricCatalog: GlobalRubricCatalog;
    readonly conversationFactListeners: Set<
      (fact: ConversationClearedFact) => void
    >;
  }) {
    this.#owner = input.options.owner;
    this.#protocol = input.protocol;
    this.#manager = input.manager;
    this.#recovery = input.recovery;
    this.#intents = input.intents;
    this.#conversationFactListeners = input.conversationFactListeners;
    this.#closeDrainBudgetMs = input.options.closeDrainBudgetMs ?? 30_000;
    this.#transferSource = new ConversationTransferSource({
      deviceId: this.#owner.deviceId,
      log: this.#owner.executorLog,
      artifacts: this.#owner.artifacts,
      signer: this.#owner.signer,
      storageMaintenance: this.#owner.storageMaintenance,
      abortSignal: () => this.#transferAbort.signal,
      verifier: this.#owner.verifier,
      acceptsConversationId: (conversationId) =>
        this.#owner.acceptsConversationId(conversationId),
      accepting: () =>
        this.#state === "ready" &&
        this.#removalOperationId === undefined &&
        this.#hostStopOperationId === undefined,
      isCurrentAnchor: (deviceId) =>
        input.options.currentAnchorDeviceId() === deviceId,
      conversationState: async (conversationId) => {
        if (!this.#protocol.sessionExists(conversationId)) {
          return { exists: false, deleted: false, ownerEpoch: this.#owner.ownerEpoch };
        }
        const authority = await this.#protocol.sessionAuthorityState(conversationId);
        return {
          exists: authority.hasDurableIdentity,
          deleted: authority.deleted,
          ownerEpoch: this.#owner.ownerEpoch,
        };
      },
      settleConversation: async (conversationId) => {
        this.#transferringConversations.add(conversationId);
        await this.#waitForCommandDrain();
        await this.#manager.abortConversationAndWait(
          conversationId,
          { kind: "external", origin: "conversation-transfer" },
          this.#closeDrainBudgetMs,
        );
        const deadline = Date.now() + this.#closeDrainBudgetMs;
        while (true) {
          await this.#protocol.recoverConversation(conversationId);
          await this.#recovery.recoverConversation(conversationId);
          const closure = await this.#protocol.pendingClosureWork(conversationId);
          if (
            !this.#manager.hasActiveWork(conversationId) &&
            closure.pendingFinals === 0 &&
            closure.pendingAssignments === 0 &&
            closure.recoveryBacklog === 0 &&
            closure.activeLocalLeases === 0
          ) break;
          if (Date.now() >= deadline) {
            throw new Error("Conversation transfer could not reach a stable freeze point");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
      resumeConversation: (conversationId) => {
        this.#transferringConversations.delete(conversationId);
      },
      snapshotSessionState: async (conversationId) => {
        const [meta, transcript, taskList, advancement] = await Promise.all([
          this.#protocol.sessionState.readSessionMeta(
            conversationId,
            hostContext("conversation-transfer-snapshot"),
          ),
          readAllTranscript(this.#protocol, conversationId),
          this.#protocol.sessionState.readTaskList(
            conversationId,
            hostContext("conversation-transfer-snapshot"),
          ),
          this.#protocol.sessionState.readAdvancementState(
            conversationId,
            hostContext("conversation-transfer-snapshot"),
          ),
        ]);
        return {
          reducerVersion: "conversation-session-state-v1",
          value: JSON.parse(canonicalize({ meta, transcript, taskList, advancement })),
        };
      },
    });
    const interactions = input.options.interactions;
    const sessionState = this.#protocol.sessionState;
    const rubricCatalog = input.rubricCatalog;
    const sessionReadPort: LocalConversationSessionReadPort = Object.freeze({
      readSessionMeta: async (conversationId, context) => {
        await this.#assertConversationCurrent(conversationId);
        return sessionState.readSessionMeta(conversationId, context);
      },
      readTranscriptTail: async (conversationId, context, before, limit) => {
        await this.#assertConversationCurrent(conversationId);
        return sessionState.readTranscriptTail(conversationId, context, before, limit);
      },
      readTaskList: async (conversationId, context) => {
        await this.#assertConversationCurrent(conversationId);
        return sessionState.readTaskList(conversationId, context);
      },
      readAdvancementState: async (conversationId, context) => {
        await this.#assertConversationCurrent(conversationId);
        return sessionState.readAdvancementState(conversationId, context);
      },
    });
    const rubricReadPort = Object.freeze({
      listForMatching: () => rubricCatalog.listForMatching(),
      load: (id: string) => rubricCatalog.load(id),
    });
    const admitLocalTurn: LocalConversationOwnerPort["admitTurn"] = async (
      turn,
    ) => {
      const releaseCommand = this.#beginCommand();
      let settle!: (result: ProjectedSessionTurnResult) => void;
      const outcome = new Promise<ProjectedSessionTurnResult>((resolve) => {
        settle = resolve;
      });
      try {
        await this.#assertConversationCurrent(turn.conversationId);
        const admission = await this.#manager.admitTurn({
          conversationId: turn.conversationId,
          exists: () => this.#protocol.sessionExists(turn.conversationId),
          source: "interactive",
          beforeEnqueue: (managed) =>
            this.#manager.admitDurableTurn({
              conversationId: managed.conversationId,
              input: turn.input,
              invocation: { kind: "agent", source: "interactive" },
              ...(turn.environment
                ? { environment: structuredClone(turn.environment) }
                : {}),
              options: {
                turnContext: { turnId: turn.turnId },
                source: "interactive",
                surfacePrincipal: "surface:local:first-party",
              },
              surfacePrincipal: "surface:local:first-party",
            }),
          makeTask: (managed) => ({
            source: "interactive" as const,
            execute: async () => {
              try {
                settle(
                  await projectSessionTurn({
                    manager: this.#manager,
                    managed,
                    input: turn.input,
                    turnId: turn.turnId,
                    runOptions: {
                      source: "interactive",
                      turnContext: { turnId: turn.turnId },
                      surfacePrincipal: "surface:local:first-party",
                    },
                    ...(turn.environment ? { environment: turn.environment } : {}),
                    notify: turn.notify,
                    onPostTurnControlIntent: (control) => {
                      turn.notify("session.postTurnControlIntent", {
                        conversationId: turn.conversationId,
                        turnId: turn.turnId,
                        intent: control.intent,
                        ...(control.conflict ? { conflict: control.conflict } : {}),
                      });
                    },
                  }),
                );
              } catch (error) {
                settle({ kind: "error", error });
              } finally {
                this.#manager.setBusy(turn.conversationId, false);
              }
            },
            cancel: () => {
              turn.notify("session.complete", {
                conversationId: turn.conversationId,
                sessionId: turn.conversationId,
                turnId: turn.turnId,
                result: {
                  reason: "error",
                  error: { name: "Cancelled", message: "Pending turn cancelled" },
                  usage: { inputTokens: 0, outputTokens: 0 },
                },
              });
              settle({ kind: "aborted" });
            },
          }),
        });
        if (admission.status === "not-found") {
          throw new Error("Conversation is not available on this device");
        }
        if (admission.status === "full") {
          throw new Error("Conversation has too many pending messages");
        }
        if (admission.status === "immediate") void admission.task.execute();
        return {
          status: admission.status,
          ...(admission.runId ? { runId: admission.runId } : {}),
          outcome,
        };
      } finally {
        releaseCommand();
      }
    };
    this.#port = Object.freeze<LocalConversationOwnerPort>({
      createConversation: async () => {
        return this.#runCommand(async () => {
          const conversationId = localConversationId(
            this.#owner.deviceId,
            createUlid(),
          );
          await this.#protocol.ensureSession(conversationId);
          return conversationId;
        });
      },
      ensureSession: async (conversationId) => {
        await this.#runCommand(async () => {
          await this.#assertConversationCurrent(conversationId);
          await this.#protocol.ensureSession(conversationId);
        });
      },
      listConversations: async () => {
        const current: string[] = [];
        for (const conversationId of await this.#protocol.listSessions()) {
          if (await this.#isConversationCurrent(conversationId)) current.push(conversationId);
        }
        return current;
      },
      listConversationAuthorities: async () => {
        const authorities: Array<{
          readonly conversationId: string;
          readonly authority: CurrentConversationAuthority;
        }> = [];
        for (const conversationId of await this.#protocol.listSessions()) {
          authorities.push({
            conversationId,
            authority: await this.#currentAuthority(conversationId),
          });
        }
        return authorities;
      },
      currentAuthority: (conversationId) => this.#currentAuthority(conversationId),
      commitConversationClear: async ({ conversationId, operationId }) => {
        return this.#runCommand(async () => {
          if (!(await this.#isConversationCurrent(conversationId))) {
            return { status: "not-found" } as const;
          }
          try {
            const write = await sessionState.mutate(
              conversationId,
              { kind: "window-op", op: "clear" },
              hostRequestContext("local-conversation-clear", operationId),
            );
            await this.#protocol.projectSession({
              conversationId,
              requestId: operationId,
              mutation: "clear",
              domainRevision: write.revision,
            });
            return { status: "cleared" } as const;
          } catch (error) {
            if (isAuthorityErrorCode(error, "not-found")) {
              return { status: "not-found" } as const;
            }
            if (isAuthorityErrorCode(error, "busy")) {
              return {
                status: "busy",
                reason: "pending-lifecycle",
              } as const;
            }
            throw error;
          }
        });
      },
      subscribeConversationFacts: (listener) => {
        this.#conversationFactListeners.add(listener);
        return () => this.#conversationFactListeners.delete(listener);
      },
      mutateSession: async (conversationId, mutation, context) => {
        return this.#runCommand(async () => {
          await this.#assertConversationCurrent(conversationId);
          return sessionState.mutate(conversationId, mutation, context);
        });
      },
      cancelTurns: async (input) => {
        await this.#runCommand(async () => {
          await this.#assertConversationCurrent(input.conversationId);
          await this.#manager.cancelDurableRuns({
            conversationId: input.conversationId,
            requestId: input.requestId,
            principal: {
              surfacePrincipal: "surface:local:internal",
              deviceId: this.#owner.deviceId,
              connectionId: "local-owner-internal",
            },
          });
        });
      },
      resolveDurableUncertain: async (input) => {
        return this.#runCommand(async () => {
          await this.#assertConversationCurrent(input.conversationId);
          return this.#manager.resolveDurableUncertain({
            conversationId: input.conversationId,
            runId: input.runId,
            requestId: input.requestId,
            ownerEpoch: input.ownerEpoch,
            openFactDigest: input.openFactDigest,
            decision: input.decision,
            principal: this.#manager.durableControlPrincipal({
              surfacePrincipal: input.surfacePrincipal,
              connectionId: input.connectionId,
            }),
          });
        });
      },
      runTurn: async (input) => {
        const admitted = await admitLocalTurn({
          conversationId: input.conversationId,
          input: userTurnInputFromText(input.text),
          turnId: input.turnId,
          ...(input.environment ? { environment: input.environment } : {}),
          notify: input.notify ?? (() => {}),
        });
        return admitted.outcome;
      },
      admitTurn: admitLocalTurn,
      answerInteractionWithTicket: async (input) => {
        await this.#runCommand(async () => {
          await this.#assertConversationCurrent(
            this.#protocol.conversationIdForAssignment(input.assignmentId),
          );
          await interactions.answerInteractionWithTicket(input);
        });
      },
      resolveNoInteractiveSurface: async (input) => {
        await this.#runCommand(async () => {
          await this.#assertConversationCurrent(
            this.#protocol.conversationIdForAssignment(input.assignmentId),
          );
          await interactions.resolveNoInteractiveSurface(input);
        });
      },
      deferSchedule: (schedule) =>
        this.#runCommand(async () => {
          await this.#assertConversationCurrent(schedule.conversationId);
          return input.scheduleIntents.record(schedule);
        }),
      listDeferredIntents: (conversationId) =>
        this.#runCommand(async () => {
          await this.#assertConversationCurrent(conversationId);
          return this.#intents.list(
            conversationId,
            hostContext("local-intent-list"),
          );
        }),
      discardDeferredIntent: (intentId) =>
        this.#runCommand(async () => {
          await this.#assertConversationCurrent(
            await this.#intents.locateConversation(intentId),
          );
          return this.#intents.decide(
            intentId,
            "discarded",
            hostContext("local-intent-discard"),
          );
        }),
      sessionState: sessionReadPort,
      statusHistory: async (requests) => {
        for (const request of requests) {
          await this.#assertConversationCurrent(request.conversationId);
        }
        return this.#protocol.statusHistory(requests);
      },
      finalHistory: async (conversationId, afterCommitRevision) => {
        await this.#assertConversationCurrent(conversationId);
        return this.#protocol.finalHistory(conversationId, afterCommitRevision);
      },
      pendingInteractions: async () => {
        const pending = await interactions.pendingInteractions();
        const visible: (typeof pending)[number][] = [];
        for (const item of pending) {
          const conversationId = this.#protocol.conversationIdForAssignment(item.assignmentId);
          if (await this.#isConversationCurrent(conversationId)) visible.push(item);
        }
        return visible;
      },
      rubricCatalog: rubricReadPort,
    });
  }

  static async create(
    options: LocalConversationOwnerAssemblyOptions,
  ): Promise<LocalConversationOwnerAssembly> {
    const owner = options.owner;
    let manager: ConversationManager;
    let advancement: AdvancementController;
    let recovery: AdvancementRecoveryMaintenance;
    let reviewCommitted: ((info: TurnCommittedInfo) => void) | undefined;
    const projectedRuns = new Set<string>();
    const conversationFactListeners = new Set<
      (fact: ConversationClearedFact) => void
    >();

    let protocol!: ConversationProtocolRuntime;
    protocol = new ConversationProtocolRuntime({
      owner,
      manager: () => manager,
      interactions: options.interactions,
      localExecutor: {
        ...(options.ledger ? { ledger: options.ledger } : {}),
        ConversationAssignmentLedger: options.ConversationAssignmentLedger,
        InProcessAssignmentSubmission: options.InProcessAssignmentSubmission,
        runtimeFactory: options.runtimeFactory,
        dataPlaneTickets: options.dataPlane.tickets,
        createStream: (input) => options.dataPlane.createStream(input),
      },
      onFinal: (frame) => verifyLocalConversationFinal(protocol, frame),
      projectLifecycle: async ({ conversationId, mutation, requestId }) => {
        if (mutation === "clear") {
          await projectConversationClear({
            conversationId,
            operationId: requestId,
            projection: {
              clearStoredView: async () => true,
              clearRuntimeView: async (id, persist) =>
                manager.has(id) ? manager.clear(id, persist) :
                  (await persist()) ? "cleared" : "not-found",
            },
            publishFact: (fact) => {
              for (const listener of conversationFactListeners) {
                listener(fact);
              }
            },
          });
          return;
        }
        if (!manager.has(conversationId)) return;
        const outcome = await manager.delete(conversationId, {
          removeDisk: async () => true,
        });
        if (outcome === "busy") throw new Error("Local conversation delete is busy");
      },
      recoverAuxiliary: async (conversationId) => {
        if (!recovery) return;
        const result = await recovery.recoverConversation(conversationId);
        if (
          result.status === "failed" ||
          result.status === "full" ||
          result.status === "busy" ||
          result.status === "not-found" ||
          result.status === "missing-proxy"
        ) {
          throw new Error(result.message ?? `Local advancement recovery failed: ${result.status}`);
        }
      },
    });

    manager = new ConversationManager(options.runtimeFactory, undefined, {
      onRelease: (conversationId) => protocol.releaseConversation(conversationId),
      loadHistory: async (conversationId) => {
        const meta = await protocol.sessionState.readSessionMeta(
          conversationId,
          hostContext("local-owner-history"),
        );
        if (meta.turnCount === 0) return undefined;
        const records = await readAllTranscript(protocol, conversationId);
        const messages = records.flatMap((record) => record.messages).slice(-100);
        const rendered = renderRecentContextFromMessages(messages);
        return {
          bootstrap: rendered ? buildStartupBootstrapPair(rendered) : null,
          turnCount: meta.turnCount,
        };
      },
      ensureConversation: (conversationId) => protocol.ensureSession(conversationId),
      initTranscript: (conversationId) => protocol.ensureSession(conversationId),
      appendRun: async () => {
        throw new Error("Local conversations persist turns only through the owner commit protocol");
      },
      appendCommittedRun: async (_conversationId, record) => {
        const appended = !projectedRuns.has(record.runId);
        projectedRuns.add(record.runId);
        return { runIndex: record.runIndex, shardId: "owner-log", appended };
      },
      applyCommittedSessionMutations: async () => {},
      onTurnCommitted: (info) => reviewCommitted?.(info),
      durableTurnExecutor: protocol,
    });

    const rubricCatalog = new GlobalRubricCatalog({
      globalState: () => undefined,
      artifacts: () => undefined,
      anchorEpoch: () => undefined,
      executionAssets: () => owner.executionAssetCatalog,
    });
    const intents = new DeferredGlobalIntentRepository({
      log: owner.executorLog,
      localDomainId: owner.domain.localDomainId,
      ownerEpoch: owner.ownerEpoch,
      mode: "local",
      acceptsConversationId: (conversationId) => owner.acceptsConversationId(conversationId),
      conversationExists: (conversationId) => protocol.sessionExists(conversationId),
      isCurrentOwner: (conversationId) => protocol.sessionExists(conversationId),
      conversationAuthority: protocol.deferredIntentAuthority,
    });
    const scheduleIntents = new DeferredScheduleIntentProducer({ intents });
    const rubricPublication = new DeferredRubricPublication({
      intents,
      prepareMutation: (input) =>
        prepareDeferredRubricMutation({
          ...input,
          catalog: rubricCatalog,
          artifacts: owner.artifacts,
        }),
    });
    advancement = await createServeAdvancementController({
      config: options.config,
      credentials: options.credentials,
      governor: () => owner.resources,
      sessionState: () => protocol.sessionState,
      rubricScope: "local",
      rubricCatalog,
      rubricPublication,
      recentContextProvider: async (conversationId) =>
        renderRecentContextFromMessages(manager.getHistory(conversationId, 6)),
      evidenceRuntime: () => ({
        signer: owner.signer,
        verifier: owner.verifier,
        resolveTarget: (conversationId, runId) =>
          protocol.advancementEvidenceTarget(conversationId, runId),
        clientFor: (executorId) =>
          executorId === owner.executorId ? options.evidence : undefined,
      }),
    });

    const conversationExists = (conversationId: string) =>
      protocol.sessionExists(conversationId);
    recovery = createAdvancementRecoveryMaintenance({
      advancement,
      directory: {
        list: async () => {
          const items: Conversation[] = [];
          for (const conversationId of await protocol.listSessions()) {
            const meta = await protocol.sessionState.readSessionMeta(
              conversationId,
              hostContext("local-owner-directory"),
            );
            items.push({
              id: conversationId,
              name: meta.name ?? conversationId,
              createdAt: meta.lastActiveAt,
              lastActiveAt: meta.lastActiveAt,
              isDefault: false,
              archived: false,
              scope: { kind: "user" },
            });
          }
          return items;
        },
        exists: conversationExists,
        readRunsReverse: async (conversationId, page) => {
          const result = await protocol.sessionState.readTranscriptTail(
            conversationId,
            hostContext("local-owner-recovery"),
            page.before,
            page.limit,
          );
          return {
            runs: [...result.records].reverse().map((record) => ({
              record,
              shardId: "owner-log",
            })),
            hasMore: result.next !== undefined,
          };
        },
      },
      proxyTurns: createAdvancementProxyTurnPort({
        manager,
        conversationExists,
      }),
      originalTasks: createAdvancementOriginalTaskAdmissionPort(manager, {
        conversationExists,
      }),
      events: createAdvancementEventSink(() => null),
    });
    reviewCommitted = createAdvancementReviewMaintenance({
      advancement,
      sessionBroadcast: () => null,
      conversations: () => manager,
      conversationExists,
      recoverConversation: (conversationId, options) =>
        recovery.recoverConversation(conversationId, options),
    });

    return new LocalConversationOwnerAssembly({
      options,
      protocol,
      manager,
      recovery,
      intents,
      scheduleIntents,
      rubricCatalog,
      conversationFactListeners,
    });
  }

  async start(options: {
    readonly lifecycle?: {
      readonly operationId: string;
      readonly kind: "stop" | "executor-removal" | "anchor-uninstall";
      readonly recoverAcceptedWork: boolean;
      readonly alreadySettled?: boolean;
    };
  } = {}): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#state === "closing" || this.#state === "closed") {
      throw new Error("Local conversation owner is closed");
    }
    if (this.#starting) return this.#starting;
    this.#state = "starting";
    this.#started = true;
    const starting = (async () => {
      try {
        if (options.lifecycle) {
          if (options.lifecycle.kind === "executor-removal") {
            this.#removalOperationId = options.lifecycle.operationId;
          } else {
            this.#hostStopOperationId = options.lifecycle.operationId;
            if (options.lifecycle.alreadySettled) {
              this.#hostStopSettledOperationId = options.lifecycle.operationId;
            }
          }
          this.#protocol.beginShutdownDrain();
        }
        for (const transfer of await listConversationTransferStates(
          this.#owner.executorLog,
          this.#owner.verifier,
        )) {
          if (
            transfer.phase !== "aborted" &&
            transfer.phase !== "tombstoned"
          ) {
            this.#transferringConversations.add(transfer.identity.conversationId);
          }
        }
        if (!options.lifecycle || options.lifecycle.recoverAcceptedWork) {
          await this.#intents.recover();
          await this.#protocol.recoverReadinessProjections();
          await this.#protocol.recover();
          await this.#recovery.recoverAllOpenSessions();
          if (!options.lifecycle) this.#protocol.startRecoveryLoop();
        }
        if (this.#state !== "starting") {
          // close 已介入:停掉刚起的恢复循环,由 close 统一收束。
          await this.#protocol.stopRecoveryLoop();
          throw new Error("Local conversation owner is closing");
        }
        this.#state = "ready";
      } catch (error) {
        if (this.#state === "starting") this.#state = "created";
        throw error;
      }
    })();
    this.#starting = starting;
    starting.catch(() => {
      // 失败允许重试:仅当状态已复位且句柄未被替换时清理。
      if (this.#state === "created" && this.#starting === starting) {
        this.#starting = undefined;
      }
    });
    return starting;
  }

  /** Read-only activity probe used by the Executor-only on-demand Host. */
  async hasIdleBlockingWork(): Promise<boolean> {
    this.#requireReady();
    if (
      this.#activeCommands > 0 ||
      this.#transferringConversations.size > 0 ||
      this.#manager.hasActiveWork()
    ) return true;
    const closure = await this.#protocol.pendingClosureWork();
    if (
      closure.pendingFinals > 0 ||
      closure.pendingAssignments > 0 ||
      closure.recoveryBacklog > 0 ||
      closure.activeLocalLeases > 0
    ) return true;
    const conversations = (await this.#port.listConversationAuthorities())
      .filter(({ authority }) =>
        authority.state === "current" ||
        authority.state === "frozen" ||
        authority.state === "importing");
    for (const { conversationId } of conversations) {
      const intents = await this.#intents.list(
        conversationId,
        hostContext("executor-idle-intent-probe"),
      );
      if (intents.some((intent) => intent.status === "pending")) return true;
    }
    return false;
  }

  /**
   * 关闭只有一个结果:原子进入 closing → 可判定 drain → 驱动 protocol /
   * advancement 到稳定检查点 → 停恢复循环 → 核对零 active/queued、零恢复
   * 积压、final 与本地租约终态 → dispose。期限内证明不了收束时仍以同一
   * promise 失败收场:停掉已拥有后台、保留耐久 pending 供下次 start 重驱,
   * 绝不伪造成功。重复与并发调用取得同一结果。
   */
  close(): Promise<void> {
    if (!this.#closing) this.#closing = this.#settle();
    return this.#closing;
  }

  async #settle(): Promise<void> {
    if (this.#state === "closed") return;
    const neverStarted = !this.#started;
    this.#state = "closing";
    this.#transferAbort.abort(new Error("Local conversation transfer source is stopping"));
    this.#protocol.beginShutdownDrain();
    const starting = this.#starting;
    if (starting) await starting.catch(() => {});
    await this.#waitForCommandDrain();
    if (neverStarted) {
      await this.#protocol.stopRecoveryLoop().catch(() => {});
      await this.#manager.disposeAll().catch(() => {});
      this.#state = "closed";
      return;
    }
    if (this.#hostStopSettledOperationId) {
      await this.#protocol.stopRecoveryLoop().catch(() => {});
      await this.#manager.disposeAll().catch(() => {});
      this.#state = "closed";
      return;
    }
    const deadline = Date.now() + this.#closeDrainBudgetMs;
    let failure: unknown;
    let lastReadings = "";
    const probe = async (): Promise<boolean> => {
      const closure = await this.#protocol.pendingClosureWork();
      const activeWork = this.#manager.hasActiveWork();
      lastReadings =
        `activeWork=${activeWork} pendingFinals=${closure.pendingFinals}` +
        ` pendingAssignments=${closure.pendingAssignments}` +
        ` recoveryBacklog=${closure.recoveryBacklog}` +
        ` activeLocalLeases=${closure.activeLocalLeases}`;
      return (
        !activeWork &&
        closure.pendingFinals === 0 &&
        closure.pendingAssignments === 0 &&
        closure.recoveryBacklog === 0 &&
        closure.activeLocalLeases === 0
      );
    };
    try {
      // 一次性 drain:active/queued 只取消一轮,避免与恢复重放互相重标。
      await this.#manager.abortAllAndWait(
        { kind: "external", origin: "local-owner-close" },
        Math.max(1, deadline - Date.now()),
      );
      // 恢复 owner 保持存活:把 drain 产生的取消/提交义务驱动到检查点再读取;
      // 恢复对同一 pending 输入至多重放一次,后续轮次自然静默。
      while (true) {
        await this.#protocol.recover();
        await this.#recovery.recoverAllOpenSessions();
        if (await probe()) break;
        if (Date.now() >= deadline) {
          failure = new Error(
            `Local conversation owner close is not provably settled: ${lastReadings}`,
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      failure = error;
    }
    await this.#protocol.stopRecoveryLoop().catch(() => {});
    if (failure === undefined) {
      // 循环停止后无任何新标记来源,复读一次确认静止。
      const quiet = await probe().catch(() => false);
      if (!quiet) {
        failure = new Error(
          `Local conversation owner close is not provably settled: ${lastReadings}`,
        );
      }
    }
    await this.#manager.disposeAll().catch(() => {});
    if (failure !== undefined) throw failure;
    this.#state = "closed";
  }

  port(): LocalConversationOwnerPort {
    return this.#port;
  }

  transferSource(): ConversationTransferSource {
    return this.#transferSource;
  }

  transferIdentity(): {
    readonly deviceId: string;
    readonly ownerEpoch: number;
  } {
    return { deviceId: this.#owner.deviceId, ownerEpoch: this.#owner.ownerEpoch };
  }

  async transferCandidates(): Promise<readonly string[]> {
    if (this.#removalOperationId || this.#hostStopOperationId) return [];
    const candidates: string[] = [];
    for (const { conversationId, authority } of await this.#port.listConversationAuthorities()) {
      if (authority.state === "current" || authority.state === "frozen" || authority.state === "importing") {
        candidates.push(conversationId);
      }
    }
    return candidates;
  }

  async recoverAcceptedWorkForLifecycle(): Promise<void> {
    await this.#intents.recover();
    await this.#protocol.recover();
    await this.#recovery.recoverAllOpenSessions();
  }

  deviceRemovalCandidates(operationId: string): readonly string[] {
    return this.#requireRemovalSnapshot(operationId).conversations.map(
      (item) => item.conversationId,
    );
  }

  async closeHostStopAdmission(operationId: string): Promise<void> {
    this.#requireReady();
    if (this.#removalOperationId) {
      throw new Error("Device removal already owns the local conversation gate");
    }
    if (this.#hostStopOperationId && this.#hostStopOperationId !== operationId) {
      throw new Error("Another host-stop operation owns the local conversation gate");
    }
    this.#hostStopOperationId = operationId;
    this.#protocol.beginShutdownDrain();
    await this.#waitForCommandDrain();
    this.#hostStopSnapshot ??= await this.preflightForDeviceRemoval(operationId);
  }

  restoreHostStopAcceptedWork(
    operationId: string,
    ownerItems: readonly LocalConversationRemovalSnapshot["ownerItems"][number][],
    alreadySettled = false,
  ): void {
    this.#requireReady();
    if (this.#hostStopOperationId !== operationId) {
      throw new Error("Host-stop artifact does not own the local conversation gate");
    }
    const localOwners = new Set([
      "conversation",
      "intent",
      "final",
      "assignment",
      "lease",
      "permit",
    ]);
    const frozen = Object.freeze(ownerItems
      .filter((item) => localOwners.has(item.owner))
      .map((item) => Object.freeze({ ...item }))
      .sort((left, right) =>
        `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US")));
    if (this.#hostStopSnapshot) {
      assertExactAcceptedWork(
        this.#hostStopSnapshot.ownerItems.map((item) => ({
          id: `${item.owner}:${item.id}`,
          revision: item.revision,
        })),
        frozen.map((item) => ({ id: `${item.owner}:${item.id}`, revision: item.revision })),
        "host-stop restored artifact",
      );
    } else {
      this.#hostStopSnapshot = Object.freeze({
        operationId,
        conversations: Object.freeze([]),
        acceptedWork: Object.freeze({
          active: 0,
          pendingFinals: 0,
          pendingAssignments: 0,
          deferredIntents: 0,
          outbox: 0,
          leases: 0,
          permits: 0,
        }),
        ownerItems: frozen,
      });
    }
    if (alreadySettled) this.#hostStopSettledOperationId = operationId;
  }

  async releaseHostStopAdmission(operationId: string): Promise<void> {
    if (this.#hostStopOperationId === undefined) return;
    if (this.#hostStopOperationId !== operationId) {
      throw new Error("Host-stop release does not own the local conversation gate");
    }
    this.#protocol.resumeAfterShutdownDrain();
    this.#hostStopOperationId = undefined;
    this.#hostStopSnapshot = undefined;
    this.#hostStopSettlement = undefined;
    this.#hostStopSettledOperationId = undefined;
  }

  resumeRecoveryAfterLifecycle(): void {
    this.#protocol.startRecoveryLoop();
  }

  hostStopAcceptedWorkItems(
    operationId: string,
    owner: LocalConversationRemovalSnapshot["ownerItems"][number]["owner"],
  ): readonly { readonly id: string; readonly revision: string }[] {
    const snapshot = this.#requireHostStopSnapshot(operationId);
    return Object.freeze(snapshot.ownerItems
      .filter((item) => item.owner === owner)
      .map(({ id, revision }) => Object.freeze({ id, revision })));
  }

  async settleHostStopAcceptedWork(
    operationId: string,
    strategy: "immediate" | "drain" | "cancel",
    timeoutMs: number,
  ): Promise<void> {
    this.#requireHostStopSnapshot(operationId);
    if (this.#hostStopSettledOperationId === operationId) return;
    if (this.#hostStopSettlement) return this.#hostStopSettlement;
    const settlement = (async () => {
      const deadline = Date.now() + timeoutMs;
      if (strategy === "immediate") {
        await this.#protocol.stopRecoveryLoop();
        while (true) {
          const closure = await this.#protocol.pendingClosureWork();
          if (!this.#manager.hasActiveWork() && closure.activeLocalLeases === 0) {
            this.#hostStopSettledOperationId = operationId;
            return;
          }
          if (Date.now() >= deadline) {
            throw new Error("Host stop could not reach the local durable safe point before its deadline");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (strategy === "cancel") {
        await this.#manager.abortAllAndWait(
          { kind: "external", origin: "server-shutdown" },
          Math.max(1, timeoutMs),
        );
      }
      while (true) {
        await this.#protocol.recover();
        await this.#recovery.recoverAllOpenSessions();
        const closure = await this.#protocol.pendingClosureWork();
        if (
          !this.#manager.hasActiveWork() &&
          closure.pendingFinals === 0 &&
          closure.pendingAssignments === 0 &&
          closure.recoveryBacklog === 0 &&
          closure.activeLocalLeases === 0
        ) {
          await this.#protocol.stopRecoveryLoop();
          this.#hostStopSettledOperationId = operationId;
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error("Host stop could not settle local accepted work before its deadline");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    this.#hostStopSettlement = settlement;
    try {
      await settlement;
    } catch (error) {
      if (this.#hostStopSettlement === settlement) this.#hostStopSettlement = undefined;
      throw error;
    }
  }

  async assertHostStopAcceptedWorkSettled(
    operationId: string,
    owner: LocalConversationRemovalSnapshot["ownerItems"][number]["owner"],
    strategy: "immediate" | "drain" | "cancel",
    frozen: readonly { readonly id: string; readonly revision: string }[],
  ): Promise<void> {
    const expected = this.hostStopAcceptedWorkItems(operationId, owner);
    assertExactAcceptedWork(expected, frozen, `host-stop ${owner} frozen input`);
    const current = (await this.preflightForDeviceRemoval(operationId)).ownerItems
      .filter((item) => item.owner === owner)
      .map(({ id, revision }) => ({ id, revision }));
    assertCurrentAcceptedWorkBelongsToFrozen(current, frozen, `host-stop ${owner}`);
    if (owner === "conversation") {
      assertExactAcceptedWork(current, frozen, "host-stop conversation read-back");
      if (this.#manager.hasActiveWork()) {
        throw new Error("Host stop still has active conversation work");
      }
      return;
    }
    if (
      strategy === "immediate" &&
      (owner === "intent" || owner === "final" || owner === "assignment")
    ) return;
    if (current.length !== 0) {
      throw new Error(`Host stop ${owner} accepted work is not settled`);
    }
  }

  async checkpointAcceptedWork(): Promise<string> {
    return (await this.#owner.executorLog.checkpoint()).prefixDigest;
  }

  /**
   * Freezes the complete local-owner set for one authenticated device-removal
   * operation. The caller persists the returned snapshot before choosing a
   * transfer or destruction path.
   */
  async preflightForDeviceRemoval(operationId: string): Promise<LocalConversationRemovalSnapshot> {
    this.#requireReady();
    await this.#waitForCommandDrain();
    const candidates = (await this.#port.listConversationAuthorities())
      .filter(({ authority }) =>
        authority.state === "current" ||
        authority.state === "frozen" ||
        authority.state === "importing")
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId, "en-US"));
    const conversations = await Promise.all(candidates.map(async ({ conversationId, authority }) => {
      const meta = await this.#protocol.sessionState.readSessionMeta(
        conversationId,
        hostContext("device-removal-preflight"),
      );
      return Object.freeze({
        conversationId,
        displayName: meta.name?.trim() || conversationId,
        state: authority.state as "current" | "frozen" | "importing",
      });
    }));
    const ownerItems: Array<LocalConversationRemovalSnapshot["ownerItems"][number]> = [];
    let pendingFinals = 0;
    let pendingAssignments = 0;
    let leases = 0;
    let deferredIntents = 0;
    for (const conversation of conversations) {
      ownerItems.push(Object.freeze({
        owner: "conversation",
        id: conversation.conversationId,
        revision: protocolDigest("ExecutorRemovalConversation", 1, conversation),
      }));
      const closure = await this.#protocol.pendingClosureWork(conversation.conversationId);
      const intents = await this.#intents.list(
        conversation.conversationId,
        hostContext("device-removal-preflight"),
      );
      pendingFinals += closure.pendingFinals;
      pendingAssignments += closure.pendingAssignments;
      leases += closure.activeLocalLeases;
      deferredIntents += intents.length;
      for (const item of closure.items.finals) {
        ownerItems.push(Object.freeze({ owner: "final", ...item }));
      }
      for (const item of closure.items.assignments) {
        ownerItems.push(Object.freeze({ owner: "assignment", ...item }));
      }
      for (const item of closure.items.recovery) {
        ownerItems.push(Object.freeze({ owner: "intent", ...item }));
      }
      for (const intent of intents) {
        ownerItems.push(Object.freeze({
          owner: "intent",
          id: intent.intentId,
          revision: protocolDigest("ExecutorRemovalIntent", 1, intent),
        }));
      }
      for (const item of closure.items.leases) {
        ownerItems.push(Object.freeze({ owner: "lease", ...item }));
        ownerItems.push(Object.freeze({ owner: "permit", ...item }));
      }
    }
    return Object.freeze({
      operationId,
      conversations: Object.freeze(conversations),
      acceptedWork: Object.freeze({
        active: Number(this.#manager.hasActiveWork()),
        pendingFinals,
        pendingAssignments,
        deferredIntents,
        outbox: pendingFinals,
        leases,
        permits: leases,
      }),
      ownerItems: Object.freeze(ownerItems.sort((left, right) =>
        `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US"))),
    });
  }

  async freezeForDeviceRemoval(
    operationId: string,
    expectedSnapshotDigest?: string,
  ): Promise<LocalConversationRemovalSnapshot> {
    if (this.#removalOperationId && this.#removalOperationId !== operationId) {
      throw new Error("Another device-removal operation owns the local conversation gate");
    }
    if (this.#removalSnapshot?.operationId === operationId) {
      if (
        expectedSnapshotDigest !== undefined &&
        protocolDigest("ExecutorRemovalPreflightSnapshot", 1, this.#removalSnapshot) !== expectedSnapshotDigest
      ) {
        throw new Error("Device removal preflight changed before the decision safe point");
      }
      return this.#removalSnapshot;
    }
    const snapshot = await this.preflightForDeviceRemoval(operationId);
    if (
      expectedSnapshotDigest !== undefined &&
      protocolDigest("ExecutorRemovalPreflightSnapshot", 1, snapshot) !== expectedSnapshotDigest
    ) {
      throw new Error("Device removal preflight changed before the decision safe point");
    }
    this.#removalOperationId = operationId;
    try {
      for (const conversation of snapshot.conversations) {
        this.#transferringConversations.add(conversation.conversationId);
      }
      for (const { conversationId } of snapshot.conversations) {
        await this.#manager.abortConversationAndWait(
          conversationId,
          { kind: "external", origin: "device-removal" },
          this.#closeDrainBudgetMs,
        );
        await this.#protocol.recoverConversation(conversationId);
        await this.#recovery.recoverConversation(conversationId);
      }
      this.#removalSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      this.#removalOperationId = undefined;
      this.#removalSnapshot = undefined;
      for (const { conversationId } of await this.#port.listConversationAuthorities()) {
        this.#transferringConversations.delete(conversationId);
      }
      throw error;
    }
  }

  releaseDeviceRemovalFreeze(operationId: string): void {
    if (this.#removalOperationId === undefined) return;
    if (this.#removalOperationId !== operationId) {
      throw new Error("Device-removal gate identity does not match");
    }
    for (const conversation of this.#removalSnapshot?.conversations ?? []) {
      this.#transferringConversations.delete(conversation.conversationId);
    }
    this.#removalOperationId = undefined;
    this.#removalSnapshot = undefined;
  }

  async destroyFrozenConversations(
    operationId: string,
    conversationIds: readonly string[],
  ): Promise<void> {
    const snapshot = this.#requireRemovalSnapshot(operationId);
    if (canonicalize([...conversationIds].sort()) !==
      canonicalize(snapshot.conversations.map((item) => item.conversationId).sort())) {
      throw new Error("Device-removal deletion does not match the frozen conversation set");
    }
    for (const conversationId of conversationIds) {
      const authority = await this.#protocol.sessionAuthorityState(conversationId);
      if (!authority.deleted) {
        await this.#protocol.sessionState.mutate(
          conversationId,
          { kind: "conversation-delete" },
          {
            ...hostContext("device-removal-delete"),
            requestId: `device-removal:${operationId}:${conversationId}`,
            expectedRevision: authority.domainRevision,
          },
        );
      }
      await this.#protocol.completeLifecycleProjections(conversationId);
      const after = await this.#protocol.sessionAuthorityState(conversationId);
      if (!after.deleted || after.pendingLifecycleProjections !== 0) {
        throw new Error("Device-removal conversation deletion is not durably projected");
      }
    }
  }

  async assertDeviceRemovalSettled(
    operationId: string,
    mode: "transfer" | "destroy",
    ownerItems: LocalConversationRemovalSnapshot["ownerItems"],
  ): Promise<void> {
    const snapshot = this.#requireRemovalSnapshot(operationId);
    const localOwners = new Set(["conversation", "intent", "final", "assignment", "lease", "permit"]);
    const frozen = ownerItems.filter((item) => localOwners.has(item.owner));
    assertExactAcceptedWork(
      snapshot.ownerItems.map((item) => ({ id: `${item.owner}:${item.id}`, revision: item.revision })),
      frozen.map((item) => ({ id: `${item.owner}:${item.id}`, revision: item.revision })),
      "device-removal durable ownerItems",
    );
    for (const conversationId of snapshot.conversations.map((item) => item.conversationId)) {
      const session = await this.#protocol.sessionAuthorityState(conversationId);
      if (mode === "destroy") {
        if (!session.deleted || session.pendingLifecycleProjections !== 0) {
          throw new Error("Device removal did not durably delete the frozen conversation");
        }
      } else if (!session.deleted) {
        const authority = await this.#currentAuthority(conversationId);
        if (authority.state === "current" || authority.state === "frozen" || authority.state === "importing") {
          throw new Error("Device removal still owns a local conversation authority");
        }
      }
      const closure = await this.#protocol.pendingClosureWork(conversationId);
      if (
        closure.pendingFinals !== 0 ||
        closure.pendingAssignments !== 0 ||
        closure.recoveryBacklog !== 0 ||
        closure.activeLocalLeases !== 0
      ) {
        throw new Error("Device removal still has accepted conversation work");
      }
    }
    const current = await this.preflightForDeviceRemoval(operationId);
    if (current.ownerItems.length !== 0) {
      assertCurrentAcceptedWorkBelongsToFrozen(
        current.ownerItems.map((item) => ({ id: `${item.owner}:${item.id}`, revision: item.revision })),
        frozen.map((item) => ({ id: `${item.owner}:${item.id}`, revision: item.revision })),
        "device-removal owner read-back",
      );
      throw new Error("Device removal still owns frozen accepted work");
    }
  }

  #requireRemovalSnapshot(operationId: string): LocalConversationRemovalSnapshot {
    if (this.#removalOperationId !== operationId || !this.#removalSnapshot) {
      throw new Error("Device-removal operation does not own the local conversation gate");
    }
    return this.#removalSnapshot;
  }

  #requireHostStopSnapshot(operationId: string): LocalConversationRemovalSnapshot {
    if (this.#hostStopOperationId !== operationId || !this.#hostStopSnapshot) {
      throw new Error("Host-stop operation does not own the local conversation gate");
    }
    return this.#hostStopSnapshot;
  }

  async #assertConversationCurrent(conversationId: string): Promise<void> {
    if (!(await this.#isConversationCurrent(conversationId))) {
      throw new Error("Conversation is available on the always-on device");
    }
  }

  async #isConversationCurrent(conversationId: string): Promise<boolean> {
    const authority = await this.#currentAuthority(conversationId);
    return (
      !this.#transferringConversations.has(conversationId) &&
      authority.state === "current" &&
      authority.deviceId === this.#owner.deviceId &&
      authority.ownerEpoch === this.#owner.ownerEpoch
    );
  }

  #currentAuthority(conversationId: string): Promise<CurrentConversationAuthority> {
    return resolveCurrentConversationAuthority(
      this.#owner.executorLog,
      this.#owner.verifier,
      conversationId,
      { deviceId: this.#owner.deviceId, ownerEpoch: this.#owner.ownerEpoch },
    );
  }

  #requireReady(): void {
    if (this.#state !== "ready") {
      throw new Error("Local conversation owner is not ready");
    }
  }

  #beginCommand(): () => void {
    this.#requireReady();
    if (this.#removalOperationId) {
      throw new Error("This device is being removed; local conversation admission is closed");
    }
    if (this.#hostStopOperationId) {
      throw new Error("This host is stopping; local conversation admission is closed");
    }
    if (this.#activeCommands === 0) {
      this.#commandDrain = new Promise<void>((resolve) => {
        this.#resolveCommandDrain = resolve;
      });
    }
    this.#activeCommands += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeCommands -= 1;
      if (this.#activeCommands === 0) {
        this.#resolveCommandDrain?.();
        this.#resolveCommandDrain = undefined;
        this.#commandDrain = undefined;
      }
    };
  }

  async #runCommand<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.#beginCommand();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #waitForCommandDrain(): Promise<void> {
    await this.#commandDrain;
  }
}

function assertExactAcceptedWork(
  actual: readonly { readonly id: string; readonly revision: string }[],
  expected: readonly { readonly id: string; readonly revision: string }[],
  label: string,
): void {
  const normalize = (items: readonly { readonly id: string; readonly revision: string }[]) =>
    [...items]
      .sort((left, right) => left.id.localeCompare(right.id, "en-US"))
      .map((item) => `${item.id}\u0000${item.revision}`);
  if (canonicalize(normalize(actual)) !== canonicalize(normalize(expected))) {
    throw new Error(`${label} does not match the frozen exact-set`);
  }
}

function assertCurrentAcceptedWorkBelongsToFrozen(
  current: readonly { readonly id: string; readonly revision: string }[],
  frozen: readonly { readonly id: string; readonly revision: string }[],
  label: string,
): void {
  const expected = new Map(frozen.map((item) => [item.id, item.revision]));
  for (const item of current) {
    if (expected.get(item.id) !== item.revision) {
      throw new Error(`${label} observed a successor or unowned accepted-work item`);
    }
  }
}

async function readAllTranscript(
  protocol: ConversationProtocolRuntime,
  conversationId: string,
): Promise<readonly TranscriptRunRecord[]> {
  const pages: TranscriptRunRecord[][] = [];
  let cursor: RunRecordRef | undefined;
  do {
    const page = await protocol.sessionState.readTranscriptTail(
      conversationId,
      hostContext("local-owner-history"),
      cursor,
      500,
    );
    pages.push(page.records);
    cursor = page.next;
  } while (cursor);
  return pages.reverse().flat();
}

function hostContext(component: string) {
  return hostRequestContext(component, `${component}:${Date.now()}`);
}

function hostRequestContext(component: string, requestId: string) {
  return {
    principal: { kind: "host" as const, component },
    requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

function isAuthorityErrorCode(
  error: unknown,
  code: "busy" | "not-found",
): boolean {
  return !!error && typeof error === "object" && "code" in error &&
    error.code === code;
}

function createUlid(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new TypeError("Local conversation timestamp is outside the ULID range");
  }
  const entropy = randomBytes(10);
  let entropyValue = 0n;
  for (const byte of entropy) entropyValue = (entropyValue << 8n) | BigInt(byte);
  let value = (BigInt(now) << 80n) | entropyValue;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

async function prepareDeferredRubricMutation(input: {
  readonly draft: RubricContractDraftSnapshot;
  readonly persistence: RubricDraftPersistenceChoice;
  readonly catalog: GlobalRubricCatalog;
  readonly artifacts: ArtifactStore;
}): Promise<DeferredGlobalIntent["mutation"]> {
  let expectedRevision: number | undefined;
  if (input.persistence.kind === "update-existing") {
    const existing = await input.catalog.load(input.persistence.rubricId);
    const match = /^revision:(\d+)$/.exec(existing.updatedAt);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) {
      throw new TypeError("Deferred rubric update target has no valid cached revision");
    }
    expectedRevision = Number(match[1]);
  }
  const targetId = input.persistence.kind === "update-existing"
    ? input.persistence.rubricId
    : undefined;
  const projected = projectRubricContractDraft(input.draft, targetId);
  const raw = stringifyRubricDraft(projected);
  const document = parseRubricDocument(raw);
  const rubricId = rubricDocumentId(document);
  if (targetId !== undefined && rubricId !== targetId) {
    throw new TypeError("Deferred rubric update changed the target identity");
  }
  const content = await input.artifacts.put(Buffer.from(raw, "utf8"));
  const rubric = {
    title: document.title,
    description: document.description,
    content,
  };
  return input.persistence.kind === "update-existing"
    ? {
        kind: "rubric-update-own",
        rubricId: input.persistence.rubricId,
        rubric,
        expectedRevision: expectedRevision!,
      }
    : { kind: "rubric-save-own", rubric };
}
