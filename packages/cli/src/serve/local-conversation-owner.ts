import { randomBytes } from "node:crypto";
import {
  buildStartupBootstrapPair,
  localConversationId,
  type Conversation,
  type RunRecordRef,
} from "@zhixing/core";
import type {
  EvidenceHandlerPort,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  ConversationManager,
  type RuntimeFactory,
  type TurnCommittedInfo,
} from "@zhixing/owner-kernel";
import {
  createAdvancementRecoveryMaintenance,
  renderRecentContextFromMessages,
  type AdvancementController,
  type AdvancementRecoveryMaintenance,
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
import { createAdvancementReviewMaintenance } from "./advancement-review-maintenance.js";
import { createServeAdvancementController } from "./advancement-controller.js";
import { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";
import type { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import type { LocalConversationOwnerRuntimeStack } from "./conversation-owner-runtime.js";
import { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";

export interface LocalConversationOwnerPort {
  createConversation(): Promise<string>;
  listConversations(): Promise<readonly string[]>;
  readonly manager: ConversationManager;
  readonly protocol: ConversationProtocolRuntime;
  readonly advancement: AdvancementController;
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
  readonly dataPlane: Pick<ExecutorDataPlaneRuntime, "tickets" | "createStream">;
}

/**
 * Device-local conversation composition root. It intentionally exposes only an
 * internal port: product RPC, CLI and channel routing remain anchor-owned.
 */
export class LocalConversationOwnerAssembly {
  readonly #owner: LocalConversationOwnerRuntimeStack;
  readonly #protocol: ConversationProtocolRuntime;
  readonly #manager: ConversationManager;
  readonly #advancement: AdvancementController;
  readonly #recovery: AdvancementRecoveryMaintenance;
  #accepting = false;
  #closed = false;

  private constructor(input: {
    readonly options: LocalConversationOwnerAssemblyOptions;
    readonly protocol: ConversationProtocolRuntime;
    readonly manager: ConversationManager;
    readonly advancement: AdvancementController;
    readonly recovery: AdvancementRecoveryMaintenance;
  }) {
    this.#owner = input.options.owner;
    this.#protocol = input.protocol;
    this.#manager = input.manager;
    this.#advancement = input.advancement;
    this.#recovery = input.recovery;
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

    const protocol = new ConversationProtocolRuntime({
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

    advancement = await createServeAdvancementController({
      config: options.config,
      credentials: options.credentials,
      governor: () => owner.resources,
      sessionState: () => protocol.sessionState,
      rubricScope: "local",
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
      advancement,
      recovery,
    });
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Local conversation owner is closed");
    if (this.#accepting) return;
    await this.#protocol.recoverReadinessProjections();
    await this.#protocol.recover();
    await this.#recovery.recoverAllOpenSessions();
    this.#protocol.startRecoveryLoop();
    this.#accepting = true;
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#accepting = false;
    await this.#protocol.stopRecoveryLoop();
    await this.#manager.disposeAll();
  }

  port(): LocalConversationOwnerPort {
    return {
      createConversation: async () => {
        if (!this.#accepting) throw new Error("Local conversation owner is not accepting work");
        const conversationId = localConversationId(
          this.#owner.deviceId,
          createUlid(),
        );
        await this.#protocol.ensureSession(conversationId);
        return conversationId;
      },
      listConversations: () => this.#protocol.listSessions(),
      manager: this.#manager,
      protocol: this.#protocol,
      advancement: this.#advancement,
    };
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
