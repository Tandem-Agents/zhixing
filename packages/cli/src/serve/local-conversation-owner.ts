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
import { canonicalize } from "@zhixing/core/protocol";
import type { ArtifactStore } from "@zhixing/core/authority";
import {
  ConversationManager,
  ConversationTransferSource,
  DeferredGlobalIntentRepository,
  listConversationTransferStates,
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
  mutateSession: SessionStatePort["mutate"];
  cancelTurns(input: {
    readonly conversationId: string;
    readonly requestId: string;
  }): Promise<void>;
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

  private constructor(input: {
    readonly options: LocalConversationOwnerAssemblyOptions;
    readonly protocol: ConversationProtocolRuntime;
    readonly manager: ConversationManager;
    readonly recovery: AdvancementRecoveryMaintenance;
    readonly intents: DeferredGlobalIntentRepository;
    readonly scheduleIntents: DeferredScheduleIntentProducer;
    readonly rubricCatalog: GlobalRubricCatalog;
  }) {
    this.#owner = input.options.owner;
    this.#protocol = input.protocol;
    this.#manager = input.manager;
    this.#recovery = input.recovery;
    this.#intents = input.intents;
    this.#closeDrainBudgetMs = input.options.closeDrainBudgetMs ?? 30_000;
    this.#transferSource = new ConversationTransferSource({
      deviceId: this.#owner.deviceId,
      log: this.#owner.executorLog,
      artifacts: this.#owner.artifacts,
      signer: this.#owner.signer,
      verifier: this.#owner.verifier,
      acceptsConversationId: (conversationId) =>
        this.#owner.acceptsConversationId(conversationId),
      accepting: () => this.#state === "ready",
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
      readSessionMeta: (conversationId, context) =>
        sessionState.readSessionMeta(conversationId, context),
      readTranscriptTail: (conversationId, context, before, limit) =>
        sessionState.readTranscriptTail(conversationId, context, before, limit),
      readTaskList: (conversationId, context) =>
        sessionState.readTaskList(conversationId, context),
      readAdvancementState: (conversationId, context) =>
        sessionState.readAdvancementState(conversationId, context),
    });
    const rubricReadPort = Object.freeze({
      listForMatching: () => rubricCatalog.listForMatching(),
      load: (id: string) => rubricCatalog.load(id),
    });
    const admitLocalTurn: LocalConversationOwnerPort["admitTurn"] = async (
      turn,
    ) => {
      this.#assertConversationWritable(turn.conversationId);
      const releaseCommand = this.#beginCommand();
      let settle!: (result: ProjectedSessionTurnResult) => void;
      const outcome = new Promise<ProjectedSessionTurnResult>((resolve) => {
        settle = resolve;
      });
      try {
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
        this.#assertConversationWritable(conversationId);
        await this.#runCommand(() => this.#protocol.ensureSession(conversationId));
      },
      listConversations: () => this.#protocol.listSessions(),
      mutateSession: async (conversationId, mutation, context) => {
        this.#assertConversationWritable(conversationId);
        return this.#runCommand(() =>
          sessionState.mutate(conversationId, mutation, context)
        );
      },
      cancelTurns: async (input) => {
        this.#assertConversationWritable(input.conversationId);
        await this.#runCommand(() =>
          this.#manager.cancelDurableRuns({
            conversationId: input.conversationId,
            requestId: input.requestId,
            principal: {
              surfacePrincipal: "surface:local:internal",
              deviceId: this.#owner.deviceId,
              connectionId: "local-owner-internal",
            },
          })
        );
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
        await this.#runCommand(() =>
          interactions.answerInteractionWithTicket(input)
        );
      },
      resolveNoInteractiveSurface: async (input) => {
        await this.#runCommand(() =>
          interactions.resolveNoInteractiveSurface(input)
        );
      },
      deferSchedule: (schedule) =>
        this.#runCommand(() => {
          this.#assertConversationWritable(schedule.conversationId);
          return input.scheduleIntents.record(schedule);
        }),
      listDeferredIntents: (conversationId) =>
        this.#runCommand(() =>
          this.#intents.list(
            conversationId,
            hostContext("local-intent-list"),
          )
        ),
      discardDeferredIntent: (intentId) =>
        this.#runCommand(() =>
          this.#intents.decide(
            intentId,
            "discarded",
            hostContext("local-intent-discard"),
          )
        ),
      sessionState: sessionReadPort,
      statusHistory: (requests) => this.#protocol.statusHistory(requests),
      finalHistory: (conversationId, afterCommitRevision) =>
        this.#protocol.finalHistory(conversationId, afterCommitRevision),
      pendingInteractions: () => interactions.pendingInteractions(),
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
      projectLifecycle: async ({ conversationId, mutation }) => {
        if (!manager.has(conversationId)) return;
        if (mutation === "clear") {
          const outcome = await manager.clear(conversationId, async () => true);
          if (outcome === "busy") throw new Error("Local conversation clear is busy");
          return;
        }
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
    });
  }

  async start(): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#state === "closing" || this.#state === "closed") {
      throw new Error("Local conversation owner is closed");
    }
    if (this.#starting) return this.#starting;
    this.#state = "starting";
    this.#started = true;
    const starting = (async () => {
      try {
        await this.#intents.recover();
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
        await this.#protocol.recoverReadinessProjections();
        await this.#protocol.recover();
        await this.#recovery.recoverAllOpenSessions();
        this.#protocol.startRecoveryLoop();
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

  #assertConversationWritable(conversationId: string): void {
    if (this.#transferringConversations.has(conversationId)) {
      throw new Error("Conversation is being moved to the always-on device");
    }
  }

  #requireReady(): void {
    if (this.#state !== "ready") {
      throw new Error("Local conversation owner is not ready");
    }
  }

  #beginCommand(): () => void {
    this.#requireReady();
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
  return {
    principal: { kind: "host" as const, component },
    requestId: `${component}:${Date.now()}`,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
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
