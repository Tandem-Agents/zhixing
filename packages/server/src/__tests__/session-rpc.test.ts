/**
 * S2.D 集成测试：session.* RPC 方法 + delta/complete 推送
 *
 * 用 mock RuntimeFactory（不依赖真实 LLM）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import {
  AdvancementStore,
  AgentError,
  assistantMessage,
  RubricContractBuilder,
  RubricStore,
  userMessage,
} from "@zhixing/core";
import type {
  AgentEventMap,
  AgentResult,
  AgentYield,
  AdvancementAdmissionStrategy,
  AdvancementProxyMessage,
  AdvancementRunReview,
  ConfirmedRubricSnapshot,
  ContextBudget,
  Message,
  OrchestrationRunResultV1,
  RubricContractDraftSnapshot,
  RunResult,
  TaskListState,
} from "@zhixing/core";
import { startServer, type ZhixingServerInstance } from "../server.js";
import { createServerContext } from "../context.js";
import {
  ConversationManager,
  DurableConversationAdmissionRejectedError,
} from "@zhixing/owner-kernel";
import { createConversationAgentTurnAdmissionPort } from "@zhixing/owner-kernel/conversation-agent-turn-admission";
import type {
  ConversationBootstrap,
  DurableConversationTurnExecutor,
  RunTurnOptions,
  RuntimeSubAgentUsageEntry,
  RuntimeSecuritySnapshot,
  SessionRuntime,
  RuntimeFactory,
} from "@zhixing/owner-kernel";
import { DEFAULT_SERVER_CONFIG } from "../types.js";
import {
  encodeRequest,
  parseMessage,
  RPC_ERROR_CODES,
  type JsonRpcResponse,
  isSuccessResponse,
  isErrorResponse,
} from "../rpc/protocol.js";
import {
  AdvancementController,
  createAdvancementRecoveryMaintenance,
} from "@zhixing/owner-services";
import {
  createAdvancementEventSink,
  createAdvancementProxyTurnPort,
} from "../advancement/adapters.js";
import {
  PERSPECTIVES_CONVERGENCE_NODE_ID,
  PERSPECTIVES_DELIBERATION_DEFINITION_ID,
  PerspectivesController,
  type PerspectiveAllocationStrategy,
  type PerspectivesOrchestrationExecutor,
} from "../perspectives/index.js";
import { createTempDir } from "@zhixing/test-utils";
import { protocolDigest } from "@zhixing/core/protocol";
import {
  CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
  ConversationDirectoryApplicationService,
  createConversationDirectoryProductApiContribution,
  projectConversationClear,
  projectConversationDelete,
  type ConversationClearProjectionPort,
  type ConversationDeleteProjectionPort,
  type ConversationDirectoryStorage,
  type ConversationAdoptionReviewProjection,
} from "@zhixing/core/conversation/application";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import { loadAdvancementState } from "../rpc/methods/session.js";
import type { ConversationDirectory } from "../runtime/conversation-directory.js";

const TEST_VERSION = "0.1.0-test";
const TEST_TOKEN = "test-token-session";
let nextTestClientInstance = 0;

// ─── Mock runtime ───

interface MockOptions {
  /** 推送的 delta 数量（默认 2） */
  deltaCount?: number;
  /** run 抛出异常 */
  throwError?: string;
  /** run 正常返回 reason:"error" 的 agentResult(error 为 AgentError 实例) */
  errorResult?: string;
  /**
   * 被 abort 后返回 reason:"aborted" 的 RunResult(模拟真实适配器:abort 经
   * .then(success) 包成 aborted 结果、不 throw)。默认 mock 即便 abort 也
   * 返回 completed——本选项让 mock 忠实建模"用户取消"的终止投影。
   */
  abortYieldsAborted?: boolean;
  /** 每个 yield 的延迟（ms） */
  yieldDelayMs?: number;
  /** RunResult 顶层携带的 turn 边界控制意图(定向通知的驱动源) */
  pendingPostTurnControl?: RunResult["pendingPostTurnControl"];
  /** 捕获 SessionRuntime.run 的 per-turn options，用于验证 RPC 层注入契约。 */
  observedRunOptions?: Array<RunTurnOptions | undefined>;
  /** /usage /context 的预算能力 */
  contextBudget?: ContextBudget;
  /** /usage 的子 agent 拆分能力 */
  subAgentUsages?: readonly RuntimeSubAgentUsageEntry[];
  /** /security 的运行体快照能力 */
  securitySnapshot?: RuntimeSecuritySnapshot;
  /** run 外 lifecycle 诊断缓冲 */
  lifecycleDiagnostics?: readonly AgentEventMap["lifecycle:warning"][];
  /** run 外窗口换代后追加到诊断缓冲的 warning */
  windowChangeDiagnostics?: readonly AgentEventMap["lifecycle:warning"][];
}

function createMockRuntime(
  sessionId: string,
  opts: MockOptions = {},
): SessionRuntime {
  let aborted = false;
  let lifecycleDiagnostics = [...(opts.lifecycleDiagnostics ?? [])];

  return {
    sessionId,
    // 纯执行体:输入消息由调用方构造(窗口归 ManagedSession),mock 取末条回声
    async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
      opts.observedRunOptions?.push(options);
      const userMsg: Message =
        messages[messages.length - 1] ?? { role: "user", content: [] };
      const block = userMsg.content[0];
      const text = block && block.type === "text" ? block.text : "";
      if (opts.throwError) {
        throw new Error(opts.throwError);
      }
      if (opts.errorResult) {
        return {
          agentResult: {
            reason: "error",
            error: new AgentError(opts.errorResult, "provider_error", false),
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          runRecord: {
            timestamp: new Date().toISOString(),
            messages: [userMsg],
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          newMessages: [],
          durationMs: 0,
        };
      }

      const count = opts.deltaCount ?? 2;
      for (let i = 0; i < count; i++) {
        if (aborted) break;
        if (opts.yieldDelayMs) await sleep(opts.yieldDelayMs);
        yield { type: "text_delta", text: `chunk-${i}` };
      }

      // 用户取消:真实运行体把 abort 包成 reason:"aborted" 经 .then(success)
      // 返回(不 throw)。此分支让 runTurnWithCommit 走 return 而非 throw,
      // runManagedTurn 据此必从 done 路径 push session.complete。
      if (aborted && opts.abortYieldsAborted) {
        return {
          agentResult: {
            reason: "aborted",
            usage: { inputTokens: 5, outputTokens: 0 },
          },
          runRecord: {
            timestamp: new Date().toISOString(),
            messages: [userMsg],
            usage: { inputTokens: 5, outputTokens: 0 },
          },
          newMessages: [],
          durationMs: 0,
        };
      }

      const reply: Message = {
        role: "assistant",
        content: [{ type: "text", text: `echo:${text}` }],
      };
      yield { type: "turn_complete", turnCount: 1, usage: { inputTokens: 5, outputTokens: 5 } };

      return {
        agentResult: {
          reason: "completed",
          message: reply,
          usage: { inputTokens: 5, outputTokens: 5 },
        },
        runRecord: {
          timestamp: new Date().toISOString(),
          messages: [userMsg, reply],
          usage: { inputTokens: 5, outputTokens: 5 },
        },
        newMessages: [reply],
        durationMs: 0,
        ...(opts.pendingPostTurnControl
          ? { pendingPostTurnControl: opts.pendingPostTurnControl }
          : {}),
      };
    },
    abort(): boolean {
      aborted = true;
      return true;
    },
    ...(opts.securitySnapshot
      ? { securitySnapshot: () => opts.securitySnapshot! }
      : {}),
    ...(opts.contextBudget
      ? {
          estimateConversationRequestBudget: () => opts.contextBudget!,
          calibrationFactor: 0.95,
          subAgentUsages: () => opts.subAgentUsages ?? [],
        }
      : {}),
    drainLifecycleDiagnostics: () => {
      const drained = lifecycleDiagnostics;
      lifecycleDiagnostics = [];
      return drained;
    },
    onAttentionWindowChange: async () => {
      lifecycleDiagnostics.push(...(opts.windowChangeDiagnostics ?? []));
    },
    async dispose() {},
  };
}

function createMockFactory(opts: MockOptions = {}): RuntimeFactory {
  return {
    async create(sessionId) {
      return createMockRuntime(sessionId, opts);
    },
  };
}

function createDurableReplayExecutor(
  runId: string,
): DurableConversationTurnExecutor {
  return {
    admit: async () => ({ runId, shouldSchedule: false }),
    confirmScheduled: () => {},
    deferScheduling: () => {},
    cancelAdmitted: async () => {},
    cancel: async () => ({ dispositions: [] }),
    findRunByIngress: async () => undefined,
    findInteractionOutcome: async () => undefined,
    resolveUncertain: async () => ({
      state: "queued",
      factDigest: `sha256:${"0".repeat(64)}`,
    }),
    writeSession: async () => ({ status: "accepted", domainRevision: 1 }),
    projectSession: async () => {},
    controlPrincipal: ({ surfacePrincipal, connectionId }) => ({
      surfacePrincipal,
      connectionId,
      deviceId: "device-test",
    }),
    run: async function* (): AsyncGenerator<AgentYield, RunResult> {
      throw new Error("durable replay executor must not start a second run");
    },
    publishPendingFinals: async () => 0,
    releaseConversation: () => {},
  };
}

function createDurableRejectedExecutor(): DurableConversationTurnExecutor {
  return {
    ...createDurableReplayExecutor("run-never-created"),
    admit: async () => {
      throw new DurableConversationAdmissionRejectedError(
        "idempotency-conflict",
        "conflicting durable payload",
      );
    },
  };
}

function createTestPerspectivesController(
  finalText = "多视角最终版",
  observed: {
    readonly allocationQuestions?: string[];
    readonly runInputs?: string[];
  } = {},
): PerspectivesController {
  const allocationStrategy: PerspectiveAllocationStrategy = {
    async allocate(input) {
      observed.allocationQuestions?.push(input.question);
      return {
        perspectives: [
          { name: "产品", charge: "判断用户价值" },
          { name: "架构", charge: "判断工程边界" },
        ],
        usage: { inputTokens: 2, outputTokens: 1 },
      };
    },
  };
  const orchestrationExecutor: PerspectivesOrchestrationExecutor = {
    async run(input) {
      if (typeof input.runInput === "string") {
        observed.runInputs?.push(input.runInput);
      }
      await input.eventBus.emit("orchestration:run_start", {
        runId: "orch-1",
        definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
        nodeCount: input.executable.definition.nodeIds.length,
        maxParallel: input.executable.definition.policy.maxParallel,
      });
      return {
        runId: "orch-1",
        definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
        status: "completed",
        outputs: {
          [PERSPECTIVES_CONVERGENCE_NODE_ID]: {
            nodeId: PERSPECTIVES_CONVERGENCE_NODE_ID,
            format: "text",
            content: finalText,
          },
        },
        nodeResults: {},
        errors: { nodes: {} },
        usage: { inputTokens: 10, outputTokens: 4 },
        durationMs: 1,
      } satisfies OrchestrationRunResultV1;
    },
  };
  return new PerspectivesController({
    allocationStrategy,
    orchestrationExecutor,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("waitUntil timed out");
}

/**
 * 内存版对话目录——以 appendRun 收集的记录为"盘上事实":有 run 即在清单,
 * 倒读按追加序逆序分页。rename/remove 维护内存 meta 覆盖层。
 */
function createMemoryDirectory(
  records: Map<string, unknown[]>,
): ConversationDirectory & ConversationDirectoryStorage &
  Pick<ConversationClearProjectionPort, "clearStoredView"> &
  Readonly<{
    touch(conversationId: string): Promise<Readonly<{
      id: string;
      name: string;
      createdAt: string;
      lastActiveAt: string;
      isDefault: boolean;
      archived: boolean;
    }> | null>;
  }> {
  const names = new Map<string, string>();
  const removed = new Set<string>();
  let createdSeq = 0;
  const exists = (id: string) =>
    !removed.has(id) && (records.has(id) || names.has(id));
  const meta = (id: string) => {
    const now = new Date().toISOString();
    return {
      id,
      name: names.get(id) ?? id,
      createdAt: now,
      lastActiveAt: now,
      isDefault: false,
      archived: false,
    } as never;
  };
  return {
    async list() {
      const now = new Date().toISOString();
      return [...new Set([...records.keys(), ...names.keys()])]
        .filter((id) => !removed.has(id))
        .map((id) => ({
          conversationId: id,
          name: names.get(id) ?? id,
          createdAt: now,
          lastActiveAt: now,
          isDefault: false,
          archived: false,
        })) as never;
    },
    async exists(id) {
      return exists(id);
    },
    async create() {
      const id = `conv_created_${createdSeq++}`;
      names.set(id, id);
      records.set(id, []);
      const created = meta(id);
      return {
        conversationId: created.id,
        name: created.name,
        createdAt: created.createdAt,
        lastActiveAt: created.lastActiveAt,
      };
    },
    async ensure(id) {
      if (!exists(id)) {
        names.set(id, id);
        records.set(id, []);
      }
      return meta(id);
    },
    async touch(id) {
      if (!exists(id)) return null;
      return meta(id);
    },
    async clearStoredView(id) {
      if (!exists(id)) return false;
      records.set(id, []);
      return true;
    },
    async rename(id, name) {
      if (!exists(id)) return null;
      names.set(id, name);
      const now = new Date().toISOString();
      return {
        conversationId: id,
        name,
        createdAt: now,
        lastActiveAt: now,
        isDefault: false,
        archived: false,
      } as never;
    },
    async deleteStoredConversation(id) {
      if (!exists(id)) return false;
      removed.add(id);
      return true;
    },
    async readHistory(id, opts) {
      const all = (records.get(id) ?? []) as Array<{ messages: unknown }>;
      const reversed = all
        .map((record, runIndex) => ({
          record: { ...record, runIndex } as never,
          shardId: "000001",
        }))
        .reverse();
      const start = opts.before
        ? reversed.findIndex(
            (r) => (r.record as { runIndex: number }).runIndex < opts.before!.runIndex,
          )
        : 0;
      const slice = start < 0 ? [] : reversed.slice(start);
      return {
        runs: slice.slice(0, opts.limit),
        hasMore: slice.length > opts.limit,
      };
    },
  };
}

function createConversationProductApi(input: {
  readonly directory: ConversationDirectoryStorage &
    Pick<ConversationClearProjectionPort, "clearStoredView"> &
    Pick<ConversationDirectory, "exists" | "ensure"> &
    Readonly<{
      touch(conversationId: string): Promise<Readonly<{
        id: string;
        name: string;
        createdAt: string;
        lastActiveAt: string;
      }> | null>;
      deleteStoredConversation(conversationId: string): Promise<boolean>;
    }>;
  readonly conversations: ConversationManager;
  readonly advancement?: AdvancementController;
  readonly advancementRecovery?: Readonly<{
    recoverConversation(conversationId: string): Promise<unknown>;
  }>;
  readonly adoptionReview?: (input: Readonly<{
    conversationId: string;
    surfacePrincipal: string;
    connectionId: string;
  }>) => Promise<ConversationAdoptionReviewProjection | undefined>;
  readonly publishCleared?: (conversationId: string) => void;
  readonly publishDeleted?: (conversationId: string) => void;
}): ProductApiDispatcher {
  const application = new ConversationDirectoryApplicationService({
    storage: input.directory,
    agentTurns: createConversationAgentTurnAdmissionPort({
      manager: input.conversations,
    }),
    agentTurnIdentity: {
      exists: (conversationId) => input.directory.exists(conversationId),
      create: async () => (await input.directory.create()).conversationId,
      ensure: async (conversationId) => {
        await input.directory.ensure(conversationId);
      },
    },
    resume: {
      restoreIdentity: async (conversationId) => {
        const restored = await input.directory.touch(conversationId);
        return restored
          ? {
              conversationId,
              name: restored.name,
              createdAt: restored.createdAt,
              lastActiveAt: restored.lastActiveAt,
            }
          : null;
      },
      recoverDependentLifecycle: async (conversationId) => {
        await input.advancementRecovery?.recoverConversation(conversationId);
      },
      ...(input.adoptionReview
        ? {
            reviewAdoption: async ({ conversationId, caller }) =>
              caller.kind === "surface"
                ? input.adoptionReview!({
                    conversationId,
                    surfacePrincipal: caller.surfacePrincipal,
                    connectionId: caller.connectionId,
                  })
                : undefined,
          }
        : {}),
    },
    clear: {
      requiresStableOperationIdentity:
        input.conversations.usesDurableTurnProtocol(),
      createOperationIdentity: () => "session.clear:test-legacy-operation",
      commit: async ({ conversationId, operationId, caller }) => {
        if (input.conversations.usesDurableTurnProtocol()) {
          if (caller.kind !== "surface") throw new Error("surface caller required");
          const write = await input.conversations.writeDurableSession({
            conversationId,
            requestId: operationId,
            mutation: { kind: "window-op", op: "clear" },
            principal: input.conversations.durableControlPrincipal(caller),
            conversationExists: () => input.directory.exists(conversationId),
          });
          if (write.status === "busy") {
            return { status: "busy", reason: "pending-lifecycle" } as const;
          }
          if (write.status === "not-found") return write;
          await input.conversations.projectDurableSession({
            conversationId,
            requestId: operationId,
            mutation: "clear",
            domainRevision: write.domainRevision,
          });
          return { status: "cleared" } as const;
        }
        await projectConversationClear({
          conversationId,
          operationId,
          projection: {
            clearStoredView: (id) => input.directory.clearStoredView(id),
            clearRuntimeView: (id, persist) =>
              input.conversations.clear(id, persist),
          },
          publishFact: (fact) => input.publishCleared?.(fact.conversationId),
        });
        return { status: "cleared" } as const;
      },
    },
    delete: {
      requiresStableOperationIdentity:
        input.conversations.usesDurableTurnProtocol(),
      createOperationIdentity: () => "session.delete:test-legacy-operation",
      commit: async ({ conversationId, operationId, caller }) => {
        if (input.conversations.usesDurableTurnProtocol()) {
          if (caller.kind !== "surface") throw new Error("surface caller required");
          const write = await input.conversations.writeDurableSession({
            conversationId,
            requestId: operationId,
            mutation: { kind: "conversation-delete" },
            principal: input.conversations.durableControlPrincipal(caller),
            conversationExists: () => input.directory.exists(conversationId),
          });
          if (write.status === "busy") {
            return { status: "busy", reason: "pending-lifecycle" } as const;
          }
          if (write.status === "not-found") return write;
          await input.conversations.projectDurableSession({
            conversationId,
            requestId: operationId,
            mutation: "delete",
            domainRevision: write.domainRevision,
          });
          return { status: "deleted" } as const;
        }
        const projection: ConversationDeleteProjectionPort = {
          deleteRuntimeAndStorage: async ({ onDeleted }) => {
            const outcome = await input.conversations.delete(conversationId, {
              removeDisk: () => input.directory.deleteStoredConversation(conversationId),
              onDeleted,
            });
            return outcome === "busy" ? "busy" : outcome ? "deleted" : "not-found";
          },
          ...(input.advancement
            ? {
                cancelDependentLifecycle: (id: string) =>
                  input.advancement!.cancelOpenConversationSession({
                    conversationId: id,
                    reason: "user-cancelled",
                    message: "原始对话已删除，推进会话已取消。",
                  }).then(() => undefined),
                removeDependentData: (id: string) =>
                  input.advancement!.removeConversationData(id),
              }
            : {}),
        };
        await projectConversationDelete({
          conversationId,
          operationId,
          deletionAlreadyCommitted: false,
          dependentFailure: "best-effort",
          projection,
          publishFact: () => input.publishDeleted?.(conversationId),
          onDependentFailure: (step, error) => {
            console.error(
              step === "cancel-lifecycle"
                ? "[session.delete] advancement cleanup failed:"
                : "[session.delete] advancement data removal failed:",
              error,
            );
          },
        });
        return { status: "deleted" } as const;
      },
    },
    runControl: {
      requiresStableCancellationIdentity:
        input.conversations.usesDurableTurnProtocol(),
      requiresAuthoritativeRunIdentity:
        input.conversations.usesDurableTurnProtocol(),
      emptyCancellationIsSuccess: false,
      createCancellationIdentity: () => "session.abort:test-legacy-operation",
      cancel: async ({
        conversationId,
        operationId,
        runId,
        caller,
        occurredAt,
      }) => {
        if (caller.kind !== "surface") throw new Error("surface caller required");
        if (!input.conversations.usesDurableTurnProtocol()) {
          const result = input.conversations.abort(conversationId, {
            kind: "user-cancel",
            source: "rpc",
            pressedAt: occurredAt,
          });
          return {
            matchedDurableRuns: 0,
            abortedInFlight: result.abortedInFlight,
            cancelledPending: result.cancelledPending,
          };
        }
        const result = await input.conversations.cancelDurableRuns({
          conversationId,
          requestId: operationId,
          ...(runId ? { runId } : {}),
          reason: {
            kind: "user-cancel",
            source: "rpc",
            pressedAt: occurredAt,
          },
          principal: input.conversations.durableControlPrincipal(caller),
        });
        return {
          matchedDurableRuns: result.dispositions.length,
          abortedInFlight: result.dispositions.some(
            (item) => item.abortedInFlight,
          ),
          cancelledPending: result.dispositions.reduce(
            (sum, item) => sum + item.cancelledPending,
            0,
          ),
          ...(result.dispositions.find((item) => item.source === "advancement")
            ?.ingressId
            ? {
                dependentLifecycleIngressId: result.dispositions.find(
                  (item) => item.source === "advancement",
                )!.ingressId,
              }
            : {}),
        };
      },
      ...(input.advancement
        ? {
            settleDependentCancellation: async ({
              conversationId,
              ingressId,
            }: {
              conversationId: string;
              ingressId: string;
            }) => {
              const active = await input.advancement!.loadActiveSession(
                conversationId,
              );
              if (
                active?.status === "active" &&
                active.outstandingProxyMessageId === ingressId
              ) {
                await input.advancement!.settleProxyMessage({
                  conversationId,
                  advancementSessionId: active.id,
                  proxyMessageId: ingressId,
                });
              }
            },
            recoverDependentCancellation: async (conversationId: string) => {
              await input.advancementRecovery?.recoverConversation(conversationId);
            },
          }
        : {}),
      resolveUncertain: async ({
        conversationId,
        runId,
        operationId,
        ownerEpoch,
        openFactDigest,
        decision,
        caller,
      }) => {
        if (caller.kind !== "surface") throw new Error("surface caller required");
        return input.conversations.resolveDurableUncertain({
          conversationId,
          runId,
          requestId: operationId,
          ownerEpoch,
          openFactDigest,
          decision,
          principal: input.conversations.durableControlPrincipal(caller),
        });
      },
    },
    runtime: {
      read: (conversationId) => {
        const active = input.conversations.getSession(conversationId);
        return {
          ...(active ? { lastActiveAt: active.lastActiveAt } : {}),
          active: active !== undefined,
          busy: active?.busy ?? false,
          observerCount:
            input.conversations.getObserverCount(conversationId),
          pendingCount: input.conversations.pendingCount(conversationId),
        };
      },
    },
    advancement: input.advancement
      ? {
          read: (conversationId) =>
            loadAdvancementState(
              { advancement: input.advancement } as never,
              conversationId,
            ),
        }
      : undefined,
  });
  return new ProductApiDispatcher(
    CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
    [createConversationDirectoryProductApiContribution(application)],
  );
}

// ─── 客户端辅助 ───

interface RpcClient {
  ws: WebSocket;
  request(method: string, params?: unknown): Promise<JsonRpcResponse>;
  /** 等待匹配条件的下一条通知（含已缓存的） */
  waitNotification(method: string, timeoutMs?: number): Promise<{ method: string; params: unknown }>;
  close(): void;
}

async function connect(port: number): Promise<RpcClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let nextId = 0;
  const clientInstanceId = `session-test-${++nextTestClientInstance}`;
  const pending = new Map<string | number, (msg: JsonRpcResponse) => void>();
  const notificationQueue: Array<{ method: string; params: unknown }> = [];
  const notificationWaiters: Array<{
    predicate: (n: { method: string; params: unknown }) => boolean;
    resolve: (n: { method: string; params: unknown }) => void;
  }> = [];

  ws.on("message", (data) => {
    const text = data.toString();
    const parsed = parseMessage(text);
    if (parsed.kind === "response") {
      const id = parsed.message.id;
      if (id !== null) {
        const cb = pending.get(id);
        if (cb) {
          pending.delete(id);
          cb(parsed.message);
        }
      }
    } else if (parsed.kind === "notification") {
      const notif = { method: parsed.message.method, params: parsed.message.params };
      const waiterIdx = notificationWaiters.findIndex((w) => w.predicate(notif));
      if (waiterIdx >= 0) {
        const w = notificationWaiters.splice(waiterIdx, 1)[0]!;
        w.resolve(notif);
      } else {
        notificationQueue.push(notif);
      }
    }
  });

  return {
    ws,
    request(method, params) {
      const id = ++nextId;
      return new Promise<JsonRpcResponse>((resolve) => {
        pending.set(id, resolve);
        const requestParams = method === "auth" && params && typeof params === "object"
          ? { ...params, client: { id: clientInstanceId } }
          : params;
        ws.send(encodeRequest(id, method, requestParams));
      });
    },
    waitNotification(method, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const predicate = (n: { method: string; params: unknown }) => n.method === method;
        const idx = notificationQueue.findIndex(predicate);
        if (idx >= 0) {
          resolve(notificationQueue.splice(idx, 1)[0]!);
          return;
        }
        const timer = setTimeout(() => {
          const wIdx = notificationWaiters.findIndex((w) => w.predicate === predicate);
          if (wIdx >= 0) notificationWaiters.splice(wIdx, 1);
          reject(new Error(`Timeout waiting for notification: ${method}`));
        }, timeoutMs);
        notificationWaiters.push({
          predicate,
          resolve: (n) => {
            clearTimeout(timer);
            resolve(n);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

async function waitCompleteForTurn(
  client: RpcClient,
  turnId: string,
  timeoutMs = 2000,
): Promise<{ method: string; params: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const notification = await client.waitNotification(
      "session.complete",
      remainingMs,
    );
    const params = notification.params as { turnId?: unknown };
    if (params.turnId === turnId) return notification;
  }
  throw new Error(`Timeout waiting for session.complete turnId: ${turnId}`);
}

// ─── 测试 ───

describe("session.* RPC (S2.D)", () => {
  let server: ZhixingServerInstance;

  // 默认 appendRun mock：按 conversation 自增 runIndex 并记录追加的原文
  // （窗口经 acceptRun 接受协议自行前进，session.history RPC 返回的是窗口投影）。
  //
  // 不关心持久化具体形态的测试（测 routing / abort / pending queue 等）通过此默认 cb 就够；
  // 需要断言持久化副作用的测试仍可覆盖式传自己的 appendRun。
  const recordsByConversation = new Map<string, unknown[]>();

  async function createTestAdvancementHarness(): Promise<{
    controller: AdvancementController;
    store: AdvancementStore;
  }>;
  async function createTestAdvancementHarness(opts: {
    admissionStrategy?: AdvancementAdmissionStrategy;
    rubricPublication?: ConstructorParameters<typeof AdvancementController>[0]["rubricPublication"];
  } = {}): Promise<{
    controller: AdvancementController;
    store: AdvancementStore;
  }> {
    const root = await createTempDir("server-advancement");
    const store = new AdvancementStore(`${root}/advancement`);
    return {
      store,
      controller: new AdvancementController({
        store,
        contractBuilder: createTestRubricContractBuilder(root),
        admissionStrategy:
          opts.admissionStrategy ?? createStartAdvancementAdmissionStrategy(),
        ...(opts.rubricPublication
          ? { rubricPublication: opts.rubricPublication }
          : {}),
        now: () => "2026-01-01T00:00:00.000Z",
      }),
    };
  }

  async function createTestAdvancementController(): Promise<AdvancementController> {
    return (await createTestAdvancementHarness()).controller;
  }

  function createTestRubricContractBuilder(root: string): RubricContractBuilder {
    return new RubricContractBuilder({
      rubricStore: new RubricStore(`${root}/rubrics`),
      generationStrategy: {
        async generate(input) {
          return {
            draftId: `draft-${input.originalTurnId}`,
            originalTurnId: input.originalTurnId,
            source: "generated",
            candidateRubricIds: input.candidateRubrics.map((rubric) => rubric.id),
            title: "测试推进准则",
            description: "用于测试推进控制面。",
            content: {
              passCriteria: ["测试任务达到可验收状态"],
              evidenceRequirements: [
                {
                  id: "conversation-result",
                  kind: "conversation-fact",
                  description: "执行侧说明完成结果。",
                  required: true,
                },
              ],
              failureHandling: [
                {
                  id: "continue",
                  scenario: "任务尚未完成",
                  reply: "请继续处理直到达到验收标准。",
                },
              ],
            },
            createdAt: input.now,
          };
        },
      },
      revisionStrategy: {
        async revise(input) {
          return {
            ...input.currentDraft,
            draftId: `revised-${input.currentDraft.draftId}`,
            source: "generated",
            title: "修订后的测试推进准则",
            content: {
              ...input.currentDraft.content,
              passCriteria: [
                ...input.currentDraft.content.passCriteria,
                input.userFeedback,
              ],
            },
            createdAt: input.now,
          };
        },
      },
    });
  }

  function createActiveActionAdmissionStrategy(
    action: "revise-rubric" | "take-over-active",
  ): AdvancementAdmissionStrategy {
    return {
      async decide(input) {
        if (input.hasActiveAdvancementSession) {
          return { kind: "direct-task", action, reason: "test-active-action" };
        }
        return { kind: "direct-task", action: "run-direct", reason: "test-direct" };
      },
    };
  }

  function createStartAdvancementAdmissionStrategy(
    awaitingAction: "keep-awaiting-confirmation" | "downgrade-to-direct" | "cancel-pending-task" = "keep-awaiting-confirmation",
  ): AdvancementAdmissionStrategy {
    return {
      async decide(input) {
        if (input.hasOpenAdvancementSession) {
          return {
            kind: awaitingAction === "downgrade-to-direct" ? "direct-task" : "question",
            action: awaitingAction,
            reason: "test-awaiting-action",
          };
        }
        if (input.hasActiveAdvancementSession) {
          return {
            kind: "direct-task",
            action: "continue-active",
            reason: "test-active-action",
          };
        }
        return {
          kind: "advancement-task",
          action: "start-advancement",
          reason: "test-start",
        };
      },
    };
  }

  function testUserInput(text: string) {
    return { parts: [{ type: "text" as const, text }] };
  }

  function testDraft(originalTurnId: string): RubricContractDraftSnapshot {
    return {
      draftId: `draft-${originalTurnId}`,
      originalTurnId,
      source: "generated",
      candidateRubricIds: [],
      title: "测试推进准则",
      description: "用于测试推进控制面。",
      content: {
        passCriteria: ["测试任务达到可验收状态"],
        evidenceRequirements: [],
        failureHandling: [
          {
            id: "continue",
            scenario: "任务尚未完成",
            reply: "请继续处理直到达到验收标准。",
          },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  function testConfirmedRubric(): ConfirmedRubricSnapshot {
    const content = testDraft("turn-recovery-original").content;
    return {
      source: {
        kind: "library",
        rubricId: "rubric-recovery",
        rubricVersion: "v1",
      },
      title: "确认版测试推进准则",
      description: "用户确认后的推进准则。",
      content: {
        passCriteria: content.passCriteria.map((text, index) => ({
          id: `pc-${index + 1}`,
          text,
        })),
        evidenceRequirements: content.evidenceRequirements,
        failureHandling: content.failureHandling,
      },
      confirmedAt: "2026-01-01T00:01:00.000Z",
      confirmedBy: "user",
    };
  }

  async function seedOutstandingProxySession(
    store: AdvancementStore,
    conversationId: string,
  ): Promise<void> {
    await store.createSession({
      id: "adv-recovery",
      conversationId,
      originalUserTask: testUserInput("把测试修到全绿"),
      pendingRubricDraft: testDraft("turn-recovery-original"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.confirmRubric(
      conversationId,
      "adv-recovery",
      testConfirmedRubric(),
      {
        turnId: "turn-recovery-original",
        surfacePrincipal: "surface:test",
        turnOrigin: { channel: "rpc", triggeredBy: "surface:test" },
        inputDigest: protocolDigest(
          "AdvancementOriginalTaskInput",
          1,
          testUserInput("把测试修到全绿"),
        ),
      },
    );
    const admissionInputDigest = protocolDigest(
      "AdvancementOriginalTaskInput",
      1,
      testUserInput("把测试修到全绿"),
    );
    await store.settleOriginalTaskAdmission(conversationId, "adv-recovery", {
      turnId: "turn-recovery-original",
      inputDigest: admissionInputDigest,
      runId: "run-recovery-original",
    });
    const review: AdvancementRunReview = {
      id: "review-recovery",
      runIndex: 0,
      runRecordRef: { shardId: "000001", runIndex: 0 },
      reviewedAt: "2026-01-01T00:02:00.000Z",
      decision: "failed",
      evidence: [],
      attribution: {
        criteria: [
          { criterionId: "pc-1", verdict: "unmet", reason: "测试尚未全绿。" },
        ],
      },
      unmetCriteria: ["测试尚未全绿"],
      selectedFailureHandlingId: "continue",
      proxyMessageId: "proxy-recovery",
    };
    const proxyMessage: AdvancementProxyMessage = {
      id: "proxy-recovery",
      sessionId: "adv-recovery",
      reviewId: "review-recovery",
      content: testUserInput("请继续处理直到达到验收标准。"),
      rubricFailureHandlingId: "continue",
      variables: {},
      attribution: review.attribution,
      createdAt: "2026-01-01T00:03:00.000Z",
    };
    await store.appendRunReviewWithProxyMessage(
      conversationId,
      "adv-recovery",
      review,
      proxyMessage,
    );
  }

  async function startWithFactory(
    factory: RuntimeFactory,
    opts: {
      advancement?: AdvancementController;
      perspectives?: PerspectivesController;
      withAdvancementRecovery?: boolean;
      seedConversations?: readonly string[];
      durableTurnExecutor?: DurableConversationTurnExecutor;
    } = {},
  ): Promise<void> {
    recordsByConversation.clear();
    for (const conversationId of opts.seedConversations ?? []) {
      recordsByConversation.set(conversationId, [
        {
          type: "run",
          runId: "run-recovery-original",
          runIndex: 0,
          timestamp: "2026-01-01T00:01:30.000Z",
          messages: [
            { role: "user", content: [{ type: "text", text: "把测试修到全绿" }] },
            { role: "assistant", content: [{ type: "text", text: "先修了一部分。" }] },
          ],
          source: "interactive",
        },
      ]);
    }
    const conversations = new ConversationManager(factory, {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
    }, {
      appendRun: async (conversationId, record) => {
        const prev = recordsByConversation.get(conversationId) ?? [];
        recordsByConversation.set(conversationId, [...prev, record]);
        return { runIndex: prev.length, shardId: "000001" };
      },
      ...(opts.durableTurnExecutor
        ? { durableTurnExecutor: opts.durableTurnExecutor }
        : {}),
    });
    const conversationDirectory = createMemoryDirectory(recordsByConversation);
    const advancementRecovery =
      opts.advancement && opts.withAdvancementRecovery
      ? createAdvancementRecoveryMaintenance({
          advancement: opts.advancement,
          directory: {
            list: async () =>
              (await conversationDirectory.list()).map((record) => ({
                id: record.conversationId,
                name: record.name,
                createdAt: record.createdAt,
                lastActiveAt: record.lastActiveAt,
                isDefault: false,
                archived: false,
                scope: { kind: "user" as const },
              })),
            exists: (conversationId) =>
              conversationDirectory.exists(conversationId),
            readRunsReverse: (conversationId, options) =>
              conversationDirectory.readHistory(conversationId, options),
          },
            proxyTurns: createAdvancementProxyTurnPort({
              manager: conversations,
              conversationExists: (conversationId) =>
                conversationDirectory.exists(conversationId),
            }),
            events: createAdvancementEventSink(() => null),
          })
        : undefined;
    let ctx!: ReturnType<typeof createServerContext>;
    const productApi = createConversationProductApi({
      directory: conversationDirectory,
      conversations,
      advancement: opts.advancement,
      advancementRecovery,
      publishCleared: (conversationId) => {
        ctx.sessionBroadcast?.(conversationId, "session.changed", {
          conversationId,
          change: "cleared",
        });
      },
      publishDeleted: (conversationId) => {
        ctx.sessionBroadcast?.(conversationId, "session.changed", {
          conversationId,
          change: "deleted",
        });
      },
    });
    ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
      advancement: opts.advancement,
      advancementRecovery,
      perspectives: opts.perspectives,
      conversationDirectory,
      productApi,
    });
    server = await startServer({ context: ctx });
  }

  afterEach(async () => {
    if (server) await server.close();
  });

  // ─── auth 报告 session capability ───

  it("auth reports 'session' capability when conversations manager is present", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    const r = await client.request("auth", { token: TEST_TOKEN });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      const result = r.result as { capabilities: string[] };
      expect(result.capabilities).toContain("session");
    }
    client.close();
  });

  // ─── session.send ───

  it("session.send returns sessionId and pushes delta + complete", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 3 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "hi",
      turnId: "turn-main",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    const sessionId = (sendResp as { result: { sessionId: string } }).result.sessionId;
    const returnedTurnId = (sendResp as { result: { turnId: string } }).result.turnId;
    expect(sessionId).toMatch(/^conv_/);
    expect(returnedTurnId).toBe("turn-main");

    // 收 deltas + turn_complete + complete
    const deltas: unknown[] = [];
    while (deltas.length < 4) {
      const n = await client.waitNotification("session.delta");
      deltas.push(n.params);
    }
    expect(deltas).toHaveLength(4); // 3 text_delta + 1 turn_complete
    expect((deltas[0] as { turnId: string }).turnId).toBe("turn-main");

    const complete = await client.waitNotification("session.complete");
    const completeParams = complete.params as {
      sessionId: string;
      turnId: string;
      result: AgentResult;
      pendingPostTurnControl?: unknown;
    };
    expect(completeParams.sessionId).toBe(sessionId);
    expect(completeParams.turnId).toBe("turn-main");
    expect(completeParams.result.reason).toBe("completed");
    // 控制意图走定向通知，不混入 complete 组播。
    expect(completeParams.pendingPostTurnControl).toBeUndefined();

    client.close();
  });

  it("session.send broadcasts run-out lifecycle diagnostics as control events", async () => {
    await startWithFactory(createMockFactory({
      deltaCount: 0,
      lifecycleDiagnostics: [
        {
          hookId: "zhixing-guidance",
          phase: "onWindowOpen",
          runtimeId: "runtime-conv",
          windowIndex: 0,
          message: "工作场景约定读取失败，已降级为仅全局约定",
        },
      ],
    }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "hi",
      turnId: "turn-warning",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;

    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      conversationId: sendResp.result.conversationId,
      scope: "control",
      runId: "turn-warning",
      event: "lifecycle:warning",
      payload: {
        hookId: "zhixing-guidance",
        message: "工作场景约定读取失败，已降级为仅全局约定",
      },
    });

    await client.waitNotification("session.delta");
    await client.waitNotification("session.complete");
    client.close();
  });

  it("session.clear broadcasts run-out lifecycle diagnostics after window reset", async () => {
    await startWithFactory(createMockFactory({
      deltaCount: 0,
      windowChangeDiagnostics: [
        {
          hookId: "zhixing-guidance",
          phase: "onWindowOpen",
          runtimeId: "runtime-conv",
          windowIndex: 1,
          message: "工作场景约定目录不是绝对路径，已跳过场景层",
        },
      ],
    }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "hi",
      turnId: "turn-clear-warning",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const conversationId = sendResp.result.conversationId;
    await client.waitNotification("session.delta");
    await client.waitNotification("session.complete");

    const clearResp = await client.request("session.clear", { conversationId });
    expect(isSuccessResponse(clearResp)).toBe(true);
    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      conversationId,
      scope: "control",
      runId: "",
      event: "lifecycle:warning",
      payload: {
        hookId: "zhixing-guidance",
        message: "工作场景约定目录不是绝对路径，已跳过场景层",
      },
    });

    client.close();
  });

  it("session.send engage=perspectives runs deliberation and commits only final answer", async () => {
    const allocationQuestions: string[] = [];
    const runInputs: string[] = [];
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      perspectives: createTestPerspectivesController("最终收敛答案", {
        allocationQuestions,
        runInputs,
      }),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const textWithMaterialTrigger = "引用材料里有 @ 错误正文\n@ 评估这个方案";
    const sendResp = await client.request("session.send", {
      text: textWithMaterialTrigger,
      engage: { kind: "perspectives", question: "评估这个方案" },
      turnId: "turn-perspective",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    const accepted = (sendResp as {
      result: { conversationId: string; turnId: string };
    }).result;
    expect(accepted.turnId).toBe("turn-perspective");

    const textDelta = await client.waitNotification("session.delta");
    expect(textDelta.params).toMatchObject({
      conversationId: accepted.conversationId,
      turnId: "turn-perspective",
      delta: { type: "text_delta", text: "最终收敛答案" },
    });
    const assistantDelta = await client.waitNotification("session.delta");
    expect(assistantDelta.params).toMatchObject({
      delta: { type: "assistant_message" },
    });
    const turnComplete = await client.waitNotification("session.delta");
    expect(turnComplete.params).toMatchObject({
      delta: {
        type: "turn_complete",
        usage: { inputTokens: 12, outputTokens: 5 },
      },
    });
    const complete = await client.waitNotification("session.complete");
    expect(complete.params).toMatchObject({
      conversationId: accepted.conversationId,
      turnId: "turn-perspective",
      result: {
        reason: "completed",
        usage: { inputTokens: 12, outputTokens: 5 },
      },
    });

    const records = recordsByConversation.get(accepted.conversationId);
    expect(records).toHaveLength(1);
    expect(allocationQuestions).toEqual(["评估这个方案"]);
    expect(runInputs).toEqual(["评估这个方案"]);
    expect(records?.[0]).toMatchObject({
      messages: [
        { role: "user", content: [{ type: "text", text: textWithMaterialTrigger }] },
        { role: "assistant", content: [{ type: "text", text: "最终收敛答案" }] },
      ],
      source: "channel",
      perspectives: {
        definitionId: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
        perspectiveCount: 2,
      },
    });
    client.close();
  });

  it("queued engage=perspectives cancel only completes the sender's pending turn", async () => {
    const runInputs: string[] = [];
    await startWithFactory(
      createMockFactory({
        deltaCount: 8,
        yieldDelayMs: 30,
        abortYieldsAborted: true,
      }),
      {
        perspectives: createTestPerspectivesController("不应执行", {
          runInputs,
        }),
      },
    );
    const alice = await connect(server.port);
    const bob = await connect(server.port);
    await alice.request("auth", { token: TEST_TOKEN });
    await bob.request("auth", { token: TEST_TOKEN });

    const first = await alice.request("session.send", {
      text: "长任务",
      turnId: "turn-active-before-perspective",
    });
    expect(isSuccessResponse(first)).toBe(true);
    if (!isSuccessResponse(first)) return;
    const conversationId = (
      first.result as { conversationId: string }
    ).conversationId;
    await alice.waitNotification("session.delta");

    const subscribe = await bob.request("session.subscribe", { conversationId });
    expect(isSuccessResponse(subscribe)).toBe(true);

    const queued = await alice.request("session.send", {
      conversationId,
      text: "@ 评估这个方案",
      engage: { kind: "perspectives", question: "评估这个方案" },
      turnId: "turn-pending-perspective",
    });
    expect(isSuccessResponse(queued)).toBe(true);
    if (!isSuccessResponse(queued)) return;
    expect(queued.result).toMatchObject({
      conversationId,
      turnId: "turn-pending-perspective",
    });

    const abortResp = await alice.request("session.abort", { conversationId });
    expect(isSuccessResponse(abortResp)).toBe(true);

    const pendingComplete = await waitCompleteForTurn(
      alice,
      "turn-pending-perspective",
    );
    expect(pendingComplete.params).toMatchObject({
      conversationId,
      turnId: "turn-pending-perspective",
      result: {
        reason: "error",
        error: {
          name: "Cancelled",
          message: "Pending perspective turn cancelled",
        },
      },
    });
    await expect(
      waitCompleteForTurn(bob, "turn-pending-perspective", 300),
    ).rejects.toThrow(/Timeout waiting/);
    expect(runInputs).toEqual([]);

    alice.close();
    bob.close();
  });

  it("session.send 进入推进任务时返回 Rubric 待确认且不执行 main run", async () => {
    await startWithFactory(createMockFactory(), {
      advancement: await createTestAdvancementController(),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-adv-1",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const result = sendResp.result as {
      conversationId: string;
      turnId: string;
      status: string;
      advancementSessionId: string;
      rubricDraftId: string;
      rubricDraft: { originalTurnId: string };
    };
    expect(result.status).toBe("awaiting-rubric-confirmation");
    expect(result.turnId).toBe("turn-adv-1");
    expect(result.rubricDraft.originalTurnId).toBe("turn-adv-1");
    expect(recordsByConversation.get(result.conversationId)).toEqual([]);

    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      scope: "control",
      runId: "turn-adv-1",
      seq: 0,
      event: "advancement:contract_draft",
    });
    client.close();
  });

  it("awaiting 期间二次 send 命中已有草案：turnId 恒为 originalTurnId，确认链不断裂", async () => {
    await startWithFactory(createMockFactory(), {
      advancement: await createTestAdvancementController(),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const first = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-original",
    });
    expect(isSuccessResponse(first)).toBe(true);
    if (!isSuccessResponse(first)) return;
    const awaiting = first.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };

    // 二次 send（新 turnId）命中 await-existing——返回的 turnId 必须仍是
    // 原始 turnId：它是确认后真正执行的 turn 身份，confirm 校验链锚定它。
    const second = await client.request("session.send", {
      conversationId: awaiting.conversationId,
      text: "这个标准可以吗？",
      turnId: "turn-second",
    });
    expect(isSuccessResponse(second)).toBe(true);
    if (!isSuccessResponse(second)) return;
    expect(second.result).toMatchObject({
      status: "awaiting-rubric-confirmation",
      turnId: "turn-original",
      rubricDraftId: awaiting.rubricDraftId,
    });

    // 确认链走通：confirm 返回的 turnId 与 awaiting 结果一致
    const confirmed = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
    });
    expect(isSuccessResponse(confirmed)).toBe(true);
    if (!isSuccessResponse(confirmed)) return;
    expect(confirmed.result).toMatchObject({ turnId: "turn-original" });
    client.close();
  });

  it("awaiting 期间 engage=perspectives 不绕过 Rubric 确认面", async () => {
    await startWithFactory(createMockFactory(), {
      advancement: await createTestAdvancementController(),
      perspectives: createTestPerspectivesController("不应执行的多视角答案"),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const first = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-awaiting-original",
    });
    expect(isSuccessResponse(first)).toBe(true);
    if (!isSuccessResponse(first)) return;
    const awaiting = first.result as {
      conversationId: string;
      rubricDraftId: string;
    };

    const second = await client.request("session.send", {
      conversationId: awaiting.conversationId,
      text: "@ 评估这个方案",
      engage: { kind: "perspectives", question: "评估这个方案" },
      turnId: "turn-awaiting-engage",
    });
    expect(isSuccessResponse(second)).toBe(true);
    if (!isSuccessResponse(second)) return;
    expect(second.result).toMatchObject({
      status: "awaiting-rubric-confirmation",
      turnId: "turn-awaiting-original",
      rubricDraftId: awaiting.rubricDraftId,
    });
    expect(recordsByConversation.get(awaiting.conversationId)).toEqual([]);
    client.close();
  });

  it("confirm 绑定草案版本：draftId 过期拒绝盲确认，会话保持 awaiting", async () => {
    await startWithFactory(createMockFactory(), {
      advancement: await createTestAdvancementController(),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-draft-bind",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };

    // 另一端修订草案后，本端拿旧 draftId 确认 → 拒绝
    const revised = await client.request("session.advancementRevise", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      userFeedback: "把文档更新也加入通过标准",
    });
    expect(isSuccessResponse(revised)).toBe(true);

    const stale = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
    });
    expect(isSuccessResponse(stale)).toBe(false);

    // 协议边界强制：不带 rubricDraftId 一律拒绝——「确认你所见」不依赖
    // 客户端自觉，非 CLI / 旧调用方也不能盲确认
    const missing = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
    });
    expect(isSuccessResponse(missing)).toBe(false);

    const state = await client.request("session.resume", {
      conversationId: awaiting.conversationId,
    });
    expect(isSuccessResponse(state)).toBe(true);
    if (!isSuccessResponse(state)) return;
    expect(state.result).toMatchObject({
      advancement: { status: "awaiting-rubric-confirmation" },
    });
    client.close();
  });

  it("session.list 与 session.resume 暴露当前推进状态快照", async () => {
    await startWithFactory(createMockFactory(), {
      advancement: await createTestAdvancementController(),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-adv-state",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const listResp = await client.request("session.list");
    expect(isSuccessResponse(listResp)).toBe(true);
    if (!isSuccessResponse(listResp)) return;
    const listed = (
      listResp.result as {
        conversations: Array<{
          conversationId: string;
          advancement?: {
            status: string;
            advancementSessionId: string;
            rubricDraftId?: string;
            rubricTitle?: string;
          };
        }>;
      }
    ).conversations.find((entry) => entry.conversationId === awaiting.conversationId);
    expect(listed?.advancement).toMatchObject({
      status: "awaiting-rubric-confirmation",
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
      rubricTitle: "测试推进准则",
    });

    const resumeResp = await client.request("session.resume", {
      conversationId: awaiting.conversationId,
    });
    expect(isSuccessResponse(resumeResp)).toBe(true);
    if (!isSuccessResponse(resumeResp)) return;
    expect(resumeResp.result).toMatchObject({
      conversationId: awaiting.conversationId,
      advancement: {
        status: "awaiting-rubric-confirmation",
        advancementSessionId: awaiting.advancementSessionId,
        // awaiting 携草案全文——接入面据此重建确认面（主动浮现）
        pendingRubricDraft: {
          draftId: awaiting.rubricDraftId,
          content: {
            passCriteria: ["测试任务达到可验收状态"],
          },
        },
      },
    });
    client.close();
  });

  it("session.send 草案生成失败时返回控制面失败且不落空会话", async () => {
    const root = await createTempDir("server-advancement-contract-failed");
    await startWithFactory(createMockFactory(), {
      advancement: new AdvancementController({
        store: new AdvancementStore(`${root}/advancement`),
        contractBuilder: new RubricContractBuilder({
          rubricStore: new RubricStore(`${root}/rubrics`),
        }),
        admissionStrategy: createStartAdvancementAdmissionStrategy(),
      }),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-contract-failed",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const result = sendResp.result as {
      conversationId: string;
      turnId: string;
      status: string;
      error: { message: string };
    };
    expect(result.status).toBe("contract-failed");
    expect(result.turnId).toBe("turn-contract-failed");
    expect(result.error.message).toContain("no draft generation strategy");
    expect(recordsByConversation.has(result.conversationId)).toBe(false);

    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      scope: "control",
      runId: "turn-contract-failed",
      seq: 0,
      event: "advancement:contract_failed",
      payload: {
        originalTurnId: "turn-contract-failed",
        error: { message: result.error.message },
      },
    });

    const list = await client.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      expect(
        (list.result as { conversations: Array<{ conversationId: string }> })
          .conversations,
      ).not.toContainEqual(
        expect.objectContaining({ conversationId: result.conversationId }),
      );
    }
    client.close();
  });

  it("session.advancementRevise 按用户反馈修订待确认 Rubric 且不执行 main run", async () => {
    const advancement = await createTestAdvancementHarness();
    await startWithFactory(createMockFactory(), {
      advancement: advancement.controller,
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-adv-revise",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const reviseResp = await client.request("session.advancementRevise", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      userFeedback: "补充文档验收",
    });
    expect(isSuccessResponse(reviseResp)).toBe(true);
    if (!isSuccessResponse(reviseResp)) return;
    expect(reviseResp.result).toMatchObject({
      status: "revised",
      rubricDraft: {
        originalTurnId: "turn-adv-revise",
        title: "修订后的测试推进准则",
      },
    });
    expect(recordsByConversation.get(awaiting.conversationId)).toEqual([]);

    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      scope: "control",
      runId: "turn-adv-revise",
      seq: 1,
      event: "advancement:contract_draft",
      payload: {
        advancementSessionId: awaiting.advancementSessionId,
        revised: true,
      },
    });

    const reviseResp2 = await client.request("session.advancementRevise", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      userFeedback: "再补充构建验收",
    });
    expect(isSuccessResponse(reviseResp2)).toBe(true);
    const event2 = await client.waitNotification("session.event");
    expect(event2.params).toMatchObject({
      scope: "control",
      runId: "turn-adv-revise",
      seq: 2,
      event: "advancement:contract_draft",
      payload: {
        advancementSessionId: awaiting.advancementSessionId,
        revised: true,
      },
    });

    const session = await advancement.store.loadSession(
      awaiting.conversationId,
      awaiting.advancementSessionId,
    );
    expect(session?.pendingRubricDraft?.title).toBe("修订后的测试推进准则");
    expect(session?.pendingRubricDraft?.content.passCriteria).toContain(
      "补充文档验收",
    );
    expect(session?.pendingRubricDraft?.content.passCriteria).toContain(
      "再补充构建验收",
    );
    expect(session?.rubricDraftVersion).toBe(2);
    client.close();
  });

  it("session.advancementConfirm 确认后用原始 turnId 执行原任务", async () => {
    const publicationCalls: string[] = [];
    const advancement = await createTestAdvancementHarness({
      rubricPublication: {
        acceptanceOutcome: () => ({
          kind: "deferred",
          message: "准则等待保存。",
        }),
        publish: async ({ draft }) => {
          publicationCalls.push(draft.draftId);
          return { kind: "saved", rubricId: "rubric-saved", revision: 1 };
        },
      },
    });
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-adv-2",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const confirmResp = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
      rubricPersistence: { kind: "save-new" },
    });
    expect(isSuccessResponse(confirmResp)).toBe(true);
    if (!isSuccessResponse(confirmResp)) return;
    expect(confirmResp.result).toMatchObject({
      status: "confirmed",
      turnId: "turn-adv-2",
      runStatus: "immediate",
      rubricPublicationMessage: "准则已保存到准则库。",
    });

    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      scope: "control",
      runId: "turn-adv-2",
      seq: 1,
      event: "advancement:contract_confirmed",
    });
    const complete = await client.waitNotification("session.complete");
    expect((complete.params as { turnId: string }).turnId).toBe("turn-adv-2");
    const records = recordsByConversation.get(awaiting.conversationId) as Array<{
      messages: Message[];
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]?.messages[0]?.content[0]).toMatchObject({
      type: "text",
      text: "请把测试修到全绿，盯到验收通过",
    });
    expect(publicationCalls).toEqual([awaiting.rubricDraftId]);
    client.close();
  });

  it.each([
    {
      label: "deferred",
      publish: async () => ({
        kind: "deferred" as const,
        message: "准则库暂忙，稍后会继续保存。",
      }),
      expectedMessage: "准则库暂忙，稍后会继续保存。",
    },
    {
      label: "failed",
      publish: async () => {
        throw new Error("rubric publication failed");
      },
      expectedMessage: "任务已继续执行，但准则暂未保存；稍后可重新保存。",
    },
  ])(
    "session.advancementConfirm 映射 $label 保存结果且不取消原任务",
    async ({ label, publish, expectedMessage }) => {
      const advancement = await createTestAdvancementHarness({
        rubricPublication: {
          acceptanceOutcome: () => ({
            kind: "deferred",
            message: "准则等待保存。",
          }),
          publish,
        },
      });
      await startWithFactory(createMockFactory({ deltaCount: 0 }), {
        advancement: advancement.controller,
      });
      const client = await connect(server.port);
      await client.request("auth", { token: TEST_TOKEN });

      const turnId = `turn-publication-${label}`;
      const sendResp = await client.request("session.send", {
        text: "请继续完成任务，并保存确认后的准则",
        turnId,
      });
      expect(isSuccessResponse(sendResp)).toBe(true);
      if (!isSuccessResponse(sendResp)) return;
      const awaiting = sendResp.result as {
        conversationId: string;
        advancementSessionId: string;
        rubricDraftId: string;
      };
      await client.waitNotification("session.event");

      const confirmResp = await client.request("session.advancementConfirm", {
        conversationId: awaiting.conversationId,
        advancementSessionId: awaiting.advancementSessionId,
        rubricDraftId: awaiting.rubricDraftId,
        rubricPersistence: { kind: "save-new" },
      });
      expect(isSuccessResponse(confirmResp)).toBe(true);
      if (!isSuccessResponse(confirmResp)) return;
      expect(confirmResp.result).toMatchObject({
        status: "confirmed",
        turnId,
        runStatus: "immediate",
        rubricPublicationMessage: expectedMessage,
      });
      await client.waitNotification("session.complete");

      const session = await advancement.store.loadSession(
        awaiting.conversationId,
        awaiting.advancementSessionId,
      );
      expect(session?.status).toBe("active");
      client.close();
    },
  );

  it("session.advancementConfirm 结清已存在的耐久原任务准入", async () => {
    const advancement = await createTestAdvancementHarness();
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      durableTurnExecutor: createDurableReplayExecutor("run-original-task"),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-durable-original",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const confirmResp = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
    });
    expect(isSuccessResponse(confirmResp)).toBe(true);
    if (!isSuccessResponse(confirmResp)) return;
    expect(confirmResp.result).toMatchObject({
      status: "confirmed",
      turnId: "turn-durable-original",
      runId: "run-original-task",
      runStatus: "queued",
    });

    const durable = await advancement.store.loadSession(
      awaiting.conversationId,
      awaiting.advancementSessionId,
    );
    expect(durable?.originalTaskAdmission).toMatchObject({
      status: "admitted",
      intent: {
        turnId: "turn-durable-original",
        surfacePrincipal: expect.any(String),
      },
      runId: "run-original-task",
    });
    client.close();
  });

  it("session.advancementConfirm 遇到确定性准入冲突时取消推进会话", async () => {
    const advancement = await createTestAdvancementHarness();
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      durableTurnExecutor: createDurableRejectedExecutor(),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请完成原任务",
      turnId: "turn-durable-conflict",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const confirmResp = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
    });
    expect(isErrorResponse(confirmResp)).toBe(true);

    const session = await advancement.store.loadSession(
      awaiting.conversationId,
      awaiting.advancementSessionId,
    );
    expect(session?.status).toBe("cancelled");
    client.close();
  });

  it("session.advancementCancel 不可取消已确认的 active 推进会话", async () => {
    const advancement = await createTestAdvancementHarness();
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-active-cancel",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const confirmResp = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
    });
    expect(isSuccessResponse(confirmResp)).toBe(true);

    const cancelResp = await client.request("session.advancementCancel", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
    });
    expect(isErrorResponse(cancelResp)).toBe(true);
    if (isErrorResponse(cancelResp)) {
      expect(cancelResp.error.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
    }
    const session = await advancement.store.loadSession(
      awaiting.conversationId,
      awaiting.advancementSessionId,
    );
    expect(session?.status).toBe("active");
    client.close();
  });

  it("session.advancementConfirm 原对话已删除时取消推进会话", async () => {
    const advancement = await createTestAdvancementHarness();
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-adv-deleted",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };

    const deleteResp = await client.request("session.delete", {
      conversationId: awaiting.conversationId,
    });
    expect(isSuccessResponse(deleteResp)).toBe(true);
    // 控制日志生命周期跟随对话本体——删除后连带清空，会话与数据都不可见
    await expect(
      advancement.store.loadSession(
        awaiting.conversationId,
        awaiting.advancementSessionId,
      ),
    ).resolves.toBeNull();
    await expect(
      advancement.store.loadActiveSession(awaiting.conversationId),
    ).resolves.toBeNull();

    const confirmResp = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
    });
    expect(isErrorResponse(confirmResp)).toBe(true);
    if (isErrorResponse(confirmResp)) {
      expect(confirmResp.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }
    client.close();
  });

  it("session.delete 终结已确认的 active 推进会话", async () => {
    const advancement = await createTestAdvancementHarness();
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-adv-delete-active",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const confirmResp = await client.request("session.advancementConfirm", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      rubricDraftId: awaiting.rubricDraftId,
    });
    expect(isSuccessResponse(confirmResp)).toBe(true);
    await client.waitNotification("session.event");
    await client.waitNotification("session.complete");

    const active = await advancement.store.loadSession(
      awaiting.conversationId,
      awaiting.advancementSessionId,
    );
    expect(active?.status).toBe("active");

    const deleteResp = await client.request("session.delete", {
      conversationId: awaiting.conversationId,
    });
    expect(isSuccessResponse(deleteResp)).toBe(true);

    // 先取消 open 会话（控制面事件语义），随后控制日志连带删除、数据不可见
    await expect(
      advancement.store.loadSession(
        awaiting.conversationId,
        awaiting.advancementSessionId,
      ),
    ).resolves.toBeNull();
    await expect(
      advancement.store.loadActiveSession(awaiting.conversationId),
    ).resolves.toBeNull();
    client.close();
  });

  it("session.delete 的推进清理失败不改变主对话删除结果", async () => {
    const advancement = await createTestAdvancementHarness();
    const cleanupSpy = vi
      .spyOn(advancement.controller, "cancelOpenConversationSession")
      .mockRejectedValueOnce(new Error("advancement cleanup failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    try {
      const sendResp = await client.request("session.send", {
        text: "请把测试修到全绿，盯到验收通过",
        turnId: "turn-delete-cleanup-fails",
      });
      expect(isSuccessResponse(sendResp)).toBe(true);
      if (!isSuccessResponse(sendResp)) return;
      const awaiting = sendResp.result as {
        conversationId: string;
      };
      await client.waitNotification("session.event");

      const deleteResp = await client.request("session.delete", {
        conversationId: awaiting.conversationId,
      });
      expect(isSuccessResponse(deleteResp)).toBe(true);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "[session.delete] advancement cleanup failed:",
        expect.any(Error),
      );

      const list = await client.request("session.list");
      expect(isSuccessResponse(list)).toBe(true);
      if (isSuccessResponse(list)) {
        expect(
          (list.result as { conversations: Array<{ conversationId: string }> })
            .conversations,
        ).not.toContainEqual(
          expect.objectContaining({ conversationId: awaiting.conversationId }),
        );
      }
    } finally {
      cleanupSpy.mockRestore();
      errorSpy.mockRestore();
      client.close();
    }
  });

  it("session.delete durable binding requires a stable identity and dispatches it once", async () => {
    const durable = createDurableReplayExecutor("run-delete-durable");
    const write = vi.spyOn(durable, "writeSession");
    const project = vi.spyOn(durable, "projectSession");
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      durableTurnExecutor: durable,
      seedConversations: ["conv-delete-durable"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const missing = await client.request("session.delete", {
      conversationId: "conv-delete-durable",
    });
    expect(isErrorResponse(missing)).toBe(true);
    if (isErrorResponse(missing)) {
      expect(missing.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
      expect(missing.error.message).toBe(
        "session.delete requires a stable 'requestId' while durable execution is enabled",
      );
    }
    expect(write).not.toHaveBeenCalled();

    const deleted = await client.request("session.delete", {
      conversationId: "conv-delete-durable",
      requestId: "delete-durable-1",
    });
    expect(isSuccessResponse(deleted)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conv-delete-durable",
      requestId: "delete-durable-1",
      mutation: { kind: "conversation-delete" },
    }));
    expect(project).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("session.advancementCancel 可降级为直接执行原始任务", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: await createTestAdvancementController(),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请持续推进到完成",
      turnId: "turn-adv-3",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const cancelResp = await client.request("session.advancementCancel", {
      conversationId: awaiting.conversationId,
      advancementSessionId: awaiting.advancementSessionId,
      executeOriginal: true,
    });
    expect(isSuccessResponse(cancelResp)).toBe(true);
    if (!isSuccessResponse(cancelResp)) return;
    expect(cancelResp.result).toMatchObject({
      status: "direct-execution",
      turnId: "turn-adv-3",
    });
    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      scope: "control",
      runId: "turn-adv-3",
      seq: 1,
      event: "advancement:contract_cancelled",
    });
    const complete = await client.waitNotification("session.complete");
    expect((complete.params as { turnId: string }).turnId).toBe("turn-adv-3");
    expect(recordsByConversation.get(awaiting.conversationId)).toHaveLength(1);
    client.close();
  });

  it("session.send 带推进控制面时,显式 stale conversationId 不会写入推进状态", async () => {
    const advancement = await createTestAdvancementHarness();
    await startWithFactory(createMockFactory(), {
      advancement: advancement.controller,
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const created = await client.request("session.new");
    expect(isSuccessResponse(created)).toBe(true);
    if (!isSuccessResponse(created)) return;
    const conversationId = (
      created.result as { conversationId: string }
    ).conversationId;

    const deleteResp = await client.request("session.delete", { conversationId });
    expect(isSuccessResponse(deleteResp)).toBe(true);

    const sendResp = await client.request("session.send", {
      conversationId,
      text: "请把测试修到全绿，盯到验收通过",
      turnId: "turn-stale-advancement",
    });
    expect(isErrorResponse(sendResp)).toBe(true);
    if (isErrorResponse(sendResp)) {
      expect(sendResp.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }
    await expect(
      advancement.store.loadActiveSession(conversationId),
    ).resolves.toBeNull();
    client.close();
  });

  it("session.send 带推进控制面时,忙碌会话仍保持原排队语义", async () => {
    const root = await createTempDir("server-advancement-busy-direct");
    const admissionStrategy: AdvancementAdmissionStrategy = {
      async decide(input) {
        const text = input.input.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(" ");
        if (text.includes("second")) {
          throw new Error("busy turn should not run advancement admission");
        }
        return {
          kind: "direct-task",
          action: "run-direct",
          reason: "test-direct",
        };
      },
    };
    await startWithFactory(
      createMockFactory({ deltaCount: 8, yieldDelayMs: 30 }),
      {
        advancement: new AdvancementController({
          store: new AdvancementStore(`${root}/advancement`),
          contractBuilder: createTestRubricContractBuilder(root),
          admissionStrategy,
        }),
      },
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const first = await client.request("session.send", {
      text: "first",
      turnId: "turn-busy-first",
    });
    expect(isSuccessResponse(first)).toBe(true);
    if (!isSuccessResponse(first)) return;
    const conversationId = (
      first.result as { conversationId: string }
    ).conversationId;
    await client.waitNotification("session.delta");

    const second = await client.request("session.send", {
      conversationId,
      text: "second",
      turnId: "turn-busy-second",
    });
    expect(isSuccessResponse(second)).toBe(true);
    if (!isSuccessResponse(second)) return;
    expect(second.result).toMatchObject({
      conversationId,
      turnId: "turn-busy-second",
    });

    const complete1 = await client.waitNotification("session.complete");
    expect((complete1.params as { turnId: string }).turnId).toBe(
      "turn-busy-first",
    );
    const complete2 = await client.waitNotification("session.complete");
    expect((complete2.params as { turnId: string }).turnId).toBe(
      "turn-busy-second",
    );
    expect(recordsByConversation.get(conversationId)).toHaveLength(2);
    client.close();
  });

  it("待确认阶段可通过自然语言取消待处理任务且不执行原任务", async () => {
    const advancement = await createTestAdvancementHarness({
      admissionStrategy: createStartAdvancementAdmissionStrategy(
        "cancel-pending-task",
      ),
    });
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请持续推进到完成",
      turnId: "turn-adv-cancel-original",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
      advancementSessionId: string;
      rubricDraftId: string;
    };
    await client.waitNotification("session.event");

    const cancelResp = await client.request("session.send", {
      conversationId: awaiting.conversationId,
      text: "取消这次任务，先不做了",
      turnId: "turn-adv-cancel-command",
    });
    expect(isSuccessResponse(cancelResp)).toBe(true);
    if (!isSuccessResponse(cancelResp)) return;
    expect(cancelResp.result).toMatchObject({
      status: "cancelled",
      turnId: "turn-adv-cancel-command",
      advancementSessionId: awaiting.advancementSessionId,
    });

    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      scope: "control",
      runId: "turn-adv-cancel-original",
      seq: 1,
      event: "advancement:contract_cancelled",
      payload: {
        advancementSessionId: awaiting.advancementSessionId,
        executeOriginal: false,
      },
    });
    await expect(client.waitNotification("session.complete", 100)).rejects.toThrow(
      "Timeout waiting for notification: session.complete",
    );
    expect(recordsByConversation.get(awaiting.conversationId)).toEqual([]);
    const session = await advancement.store.loadSession(
      awaiting.conversationId,
      awaiting.advancementSessionId,
    );
    expect(session?.status).toBe("cancelled");
    expect(session?.exit?.reason).toBe("user-cancelled");
    client.close();
  });

  it("待确认阶段按 admission action 降级,不依赖 reason 文案", async () => {
    const root = await createTempDir("server-advancement-action");
    const admissionStrategy: AdvancementAdmissionStrategy = {
      async decide(input) {
        return input.hasOpenAdvancementSession
          ? {
              kind: "direct-task",
              action: "downgrade-to-direct",
              reason: "llm says skip contract",
            }
          : {
              kind: "advancement-task",
              action: "start-advancement",
              reason: "test-start",
            };
      },
    };
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: new AdvancementController({
        store: new AdvancementStore(`${root}/advancement`),
        contractBuilder: createTestRubricContractBuilder(root),
        admissionStrategy,
      }),
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", {
      text: "请把测试修到全绿",
      turnId: "turn-action-original",
    });
    expect(isSuccessResponse(sendResp)).toBe(true);
    if (!isSuccessResponse(sendResp)) return;
    const awaiting = sendResp.result as {
      conversationId: string;
    };
    await client.waitNotification("session.event");

    const downgradeResp = await client.request("session.send", {
      conversationId: awaiting.conversationId,
      text: "不要确认了，先直接执行",
      turnId: "turn-action-command",
    });
    expect(isSuccessResponse(downgradeResp)).toBe(true);
    if (!isSuccessResponse(downgradeResp)) return;
    expect(downgradeResp.result).toMatchObject({
      turnId: "turn-action-original",
    });

    const event = await client.waitNotification("session.event");
    expect(event.params).toMatchObject({
      scope: "control",
      runId: "turn-action-original",
      event: "advancement:contract_cancelled",
    });
    const complete = await client.waitNotification("session.complete");
    expect((complete.params as { turnId: string }).turnId).toBe(
      "turn-action-original",
    );
    expect(recordsByConversation.get(awaiting.conversationId)).toHaveLength(1);
    client.close();
  });

  it("delete in-flight 会话被拒(busy),发起端仍收到 complete——complete 承载不变量回归锚", async () => {
    // 慢 turn 保持 in-flight
    await startWithFactory(
      createMockFactory({ deltaCount: 8, yieldDelayMs: 30 }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "长任务" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result
      .sessionId;
    await client.waitNotification("session.delta"); // turn 已在跑

    // 删除 in-flight 会话 → 必须被拒(否则 complete 组播到删后空名册、发起端挂死)
    const delResp = await client.request("session.delete", {
      conversationId: sessionId,
    });
    expect(isSuccessResponse(delResp)).toBe(false);

    // 会话未被拔——in-flight turn 正常跑完,发起端收到 complete(不变量保住)
    const complete = await client.waitNotification("session.complete");
    expect(
      (complete.params as { result: { reason: string } }).result.reason,
    ).toBe("completed");

    client.close();
  });

  it("用户取消(session.abort)in-flight turn → 仍推 session.complete(reason:aborted)——cli 不卡死的承载性回归锚", async () => {
    // 慢 turn 保持 in-flight,abort 落在 turn 中途;abortYieldsAborted 让 mock
    // 忠实建模真实运行体(abort 经 .then(success) 包成 aborted、不 throw)。
    await startWithFactory(
      createMockFactory({ deltaCount: 8, yieldDelayMs: 30, abortYieldsAborted: true }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "长任务" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result
      .sessionId;

    // 等首帧 delta(turn 已在跑)再取消
    await client.waitNotification("session.delta");
    const abortResp = await client.request("session.abort", {
      conversationId: sessionId,
    });
    expect(isSuccessResponse(abortResp)).toBe(true);

    // 取消后服务端仍发终止 complete,reason 为可区分的 aborted——
    // 等待该通知即等价于 cli 的 sendTurn waiter 落定(无永久挂起)。
    const complete = await client.waitNotification("session.complete");
    const result = (complete.params as { result: { reason: string } }).result;
    expect(result.reason).toBe("aborted");

    client.close();
  });

  it("session.new 建对话并进列表;session.resume 返回 meta 与活跃态、不存在 notFound", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const created = await client.request("session.new");
    expect(isSuccessResponse(created)).toBe(true);
    const newId = (created as { result: { conversationId: string } }).result
      .conversationId;

    const list = await client.request("session.list");
    const entries = (
      list as { result: { conversations: Array<{ conversationId: string }> } }
    ).result.conversations;
    expect(entries.some((c) => c.conversationId === newId)).toBe(true);

    const resumed = await client.request("session.resume", {
      conversationId: newId,
    });
    expect(isSuccessResponse(resumed)).toBe(true);
    const r = (
      resumed as {
        result: { conversationId: string; active: boolean; busy: boolean };
      }
    ).result;
    expect(r.conversationId).toBe(newId);
    expect(r.active).toBe(false);

    const missing = await client.request("session.resume", {
      conversationId: "conv-ghost",
    });
    expect(isSuccessResponse(missing)).toBe(false);

    client.close();
  });

  it("session.resume 会恢复 active 推进会话中的 outstanding proxy", async () => {
    const advancement = await createTestAdvancementHarness();
    await seedOutstandingProxySession(advancement.store, "conv-recovery");
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      withAdvancementRecovery: true,
      seedConversations: ["conv-recovery"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const resumed = await client.request("session.resume", {
      conversationId: "conv-recovery",
    });
    expect(isSuccessResponse(resumed)).toBe(true);
    if (!isSuccessResponse(resumed)) return;
    expect(resumed.result).toMatchObject({
      conversationId: "conv-recovery",
      active: true,
      advancement: {
        status: "active",
        advancementSessionId: "adv-recovery",
        outstandingProxyMessageId: "proxy-recovery",
        lastReview: {
          id: "review-recovery",
          decision: "failed",
        },
      },
    });

    await waitUntil(() => (recordsByConversation.get("conv-recovery") ?? []).length === 2);
    const record = recordsByConversation.get("conv-recovery")?.[1] as {
      source?: string;
      advancement?: { sessionId: string; proxyMessageId: string };
      messages: Message[];
    };
    expect(record.source).toBe("advancement");
    expect(record.advancement).toMatchObject({
      sessionId: "adv-recovery",
      proxyMessageId: "proxy-recovery",
    });
    expect(record.messages[0]?.content[0]).toMatchObject({
      type: "text",
      text: "请继续处理直到达到验收标准。",
    });
    client.close();
  });

  it("session.send 在 active 推进中修正标准会再生契约：旧会话收场退出 + 新草案确认面", async () => {
    const advancement = await createTestAdvancementHarness({
      admissionStrategy: createActiveActionAdmissionStrategy("revise-rubric"),
    });
    await seedOutstandingProxySession(advancement.store, "conv-revise");
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      seedConversations: ["conv-revise"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const resp = await client.request("session.send", {
      conversationId: "conv-revise",
      text: "验收标准加一条：文档同步更新",
      turnId: "turn-revise",
    });
    expect(isSuccessResponse(resp)).toBe(true);
    if (!isSuccessResponse(resp)) return;
    expect(resp.result).toMatchObject({
      status: "awaiting-rubric-confirmation",
    });

    const exitedEvent = await client.waitNotification("session.event");
    expect(exitedEvent.params).toMatchObject({
      scope: "control",
      event: "advancement:exited",
      payload: {
        advancementSessionId: "adv-recovery",
        exit: { reason: "superseded" },
        closure: { synthesized: false },
      },
    });
    const draftEvent = await client.waitNotification("session.event");
    expect(draftEvent.params).toMatchObject({
      scope: "control",
      event: "advancement:contract_draft",
    });

    const old = await advancement.store.loadSession("conv-revise", "adv-recovery");
    expect(old?.status).toBe("exited");
    expect(old?.exit?.reason).toBe("superseded");
    const next = await advancement.store.loadActiveSession("conv-revise");
    expect(next?.status).toBe("awaiting-rubric-confirmation");
    expect(next?.pendingRubricDraft?.content.passCriteria).toContain(
      "验收标准加一条：文档同步更新",
    );
    client.close();
  });

  it("session.send 修正标准失败时旧契约保持 active，被中断的推进立即重接", async () => {
    const root = await createTempDir("server-advancement-revise-fail");
    const store = new AdvancementStore(`${root}/advancement`);
    const controller = new AdvancementController({
      store,
      admissionStrategy: createActiveActionAdmissionStrategy("revise-rubric"),
      contractBuilder: {
        reviseDraft: async () => {
          throw new Error("revision provider down");
        },
      } as never,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    await seedOutstandingProxySession(store, "conv-revise-fail");
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: controller,
      withAdvancementRecovery: true,
      seedConversations: ["conv-revise-fail"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const resp = await client.request("session.send", {
      conversationId: "conv-revise-fail",
      text: "验收标准改一下",
      turnId: "turn-revise-fail",
    });
    expect(isSuccessResponse(resp)).toBe(true);
    if (!isSuccessResponse(resp)) return;
    expect(resp.result).toMatchObject({ status: "contract-failed" });

    const failedEvent = await client.waitNotification("session.event");
    expect(failedEvent.params).toMatchObject({
      scope: "control",
      event: "advancement:contract_failed",
    });

    // 旧契约保持 active 不受损
    const session = await store.loadActiveSession("conv-revise-fail");
    expect(session?.status).toBe("active");
    expect(session?.outstandingProxyMessageId).toBe("proxy-recovery");

    // 被中断的推进立即重接：outstanding proxy 被重新调度执行
    await waitUntil(
      () => (recordsByConversation.get("conv-revise-fail") ?? []).length === 2,
    );
    const record = recordsByConversation.get("conv-revise-fail")?.[1] as {
      source?: string;
      advancement?: { proxyMessageId: string };
    };
    expect(record.source).toBe("advancement");
    expect(record.advancement).toMatchObject({
      proxyMessageId: "proxy-recovery",
    });
    client.close();
  });

  it("session.send 接管 active 推进时发 exited 事件并携带收场报告", async () => {
    const advancement = await createTestAdvancementHarness({
      admissionStrategy: createActiveActionAdmissionStrategy("take-over-active"),
    });
    await seedOutstandingProxySession(advancement.store, "conv-takeover");
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      seedConversations: ["conv-takeover"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const resp = await client.request("session.send", {
      conversationId: "conv-takeover",
      text: "先停下，我们聊聊别的",
      turnId: "turn-takeover",
    });
    expect(isSuccessResponse(resp)).toBe(true);

    const exitedEvent = await client.waitNotification("session.event");
    expect(exitedEvent.params).toMatchObject({
      scope: "control",
      event: "advancement:exited",
      payload: {
        advancementSessionId: "adv-recovery",
        exit: { reason: "user-took-over" },
        closure: {
          synthesized: false,
          facts: { sessionId: "adv-recovery" },
        },
      },
    });
    const session = await advancement.store.loadSession(
      "conv-takeover",
      "adv-recovery",
    );
    expect(session?.status).toBe("exited");
    client.close();
  });

  it("session.advancementDetail 返回 open 会话的归因展开面；无记录时 detail 为 null", async () => {
    const advancement = await createTestAdvancementHarness();
    await seedOutstandingProxySession(advancement.store, "conv-detail");
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      seedConversations: ["conv-detail"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const resp = await client.request("session.advancementDetail", {
      conversationId: "conv-detail",
    });
    expect(isSuccessResponse(resp)).toBe(true);
    if (!isSuccessResponse(resp)) return;
    expect(resp.result).toMatchObject({
      conversationId: "conv-detail",
      detail: {
        advancementSessionId: "adv-recovery",
        status: "active",
        rubricTitle: "确认版测试推进准则",
        facts: {
          reviewedRunCount: 1,
          criteria: [
            {
              criterionId: "pc-1",
              verdict: "unmet",
              reason: "测试尚未全绿。",
            },
          ],
          attemptedStrategies: [
            { failureHandlingId: "continue", attempts: 1 },
          ],
        },
        lastReview: { id: "review-recovery", decision: "failed" },
      },
    });

    const empty = await client.request("session.advancementDetail", {
      conversationId: "conv-none",
    });
    expect(isSuccessResponse(empty)).toBe(true);
    if (!isSuccessResponse(empty)) return;
    expect(empty.result).toMatchObject({ detail: null });
    client.close();
  });

  it("session.advancementDetail 无 open 会话时返回最新终态会话——离线收场回看", async () => {
    const advancement = await createTestAdvancementHarness();
    await seedOutstandingProxySession(advancement.store, "conv-closed");
    await advancement.store.exitSession(
      "conv-closed",
      "adv-recovery",
      {
        reason: "user-took-over",
        message: "用户接管了任务。",
        occurredAt: "2026-01-01T00:05:00.000Z",
      },
      "2026-01-01T00:05:00.000Z",
    );
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      seedConversations: ["conv-closed"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const resp = await client.request("session.advancementDetail", {
      conversationId: "conv-closed",
    });
    expect(isSuccessResponse(resp)).toBe(true);
    if (!isSuccessResponse(resp)) return;
    expect(resp.result).toMatchObject({
      conversationId: "conv-closed",
      detail: {
        advancementSessionId: "adv-recovery",
        status: "exited",
        exit: { reason: "user-took-over" },
        facts: {
          status: "exited",
          reviewedRunCount: 1,
          criteria: [{ criterionId: "pc-1", verdict: "unmet" }],
        },
      },
    });
    client.close();
  });

  it("session.send 在 active 推进中补充输入时返回 continuation 告知", async () => {
    const advancement = await createTestAdvancementHarness();
    await seedOutstandingProxySession(advancement.store, "conv-continue");
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      seedConversations: ["conv-continue"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const resp = await client.request("session.send", {
      conversationId: "conv-continue",
      text: "补充一下：优先修 fooTest",
      turnId: "turn-continue",
    });
    expect(isSuccessResponse(resp)).toBe(true);
    if (!isSuccessResponse(resp)) return;
    expect(resp.result).toMatchObject({
      turnId: "turn-continue",
      advancementContinuation: { interruptedProxy: false },
    });
    client.close();
  });

  it("session.send 在无 outstanding 的 active 推进中补充输入同样返回 continuation 告知", async () => {
    const advancement = await createTestAdvancementHarness();
    await seedOutstandingProxySession(advancement.store, "conv-continue-b");
    // proxy 已结算：active 会话无 outstanding 且不 busy——continue-active
    // 走主流程 fall-through 路径，告知不得看运气走哪条路径。
    await advancement.store.settleProxyMessage(
      "conv-continue-b",
      "adv-recovery",
      "proxy-recovery",
      "2026-01-01T00:04:00.000Z",
    );
    await startWithFactory(createMockFactory({ deltaCount: 0 }), {
      advancement: advancement.controller,
      seedConversations: ["conv-continue-b"],
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const resp = await client.request("session.send", {
      conversationId: "conv-continue-b",
      text: "再补充一点背景",
      turnId: "turn-continue-b",
    });
    expect(isSuccessResponse(resp)).toBe(true);
    if (!isSuccessResponse(resp)) return;
    expect(resp.result).toMatchObject({
      turnId: "turn-continue-b",
      advancementContinuation: { interruptedProxy: false },
    });
    client.close();
  });

  it("session.resume 先入组播名册再恢复推进（handler 直测顺序锚）", async () => {
    const calls: string[] = [];
    const storage: ConversationDirectoryStorage = {
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      rename: async () => null,
      readHistory: async () => ({ runs: [], hasMore: false }),
    };
    const application = new ConversationDirectoryApplicationService({
      storage,
      resume: {
        restoreIdentity: async () => {
          calls.push("restoreIdentity");
          return {
            conversationId: "conv-order",
            name: "conv",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastActiveAt: "2026-01-01T00:00:00.000Z",
          };
        },
        recoverDependentLifecycle: async () => {
          calls.push("recoverConversation");
        },
        reviewAdoption: async ({ caller }) => {
          calls.push("reviewAdoption");
          expect(caller).toEqual({
            kind: "surface",
            surfacePrincipal: "rpc:test-cli",
            connectionId: "7",
          });
          return {
            status: "ready" as const,
            mergedConversationCount: 1,
            appliedRuleCount: 0,
            pendingScheduleCount: 1,
            pendingRuleCount: 0,
            message: "已合并 1 个本机对话；1 项排程等待确认。",
          };
        },
      },
      runtime: {
        read: () => {
          calls.push("readRuntime");
          return {
            active: false,
            busy: false,
            observerCount: 1,
            pendingCount: 0,
          };
        },
      },
    });
    const serverCtx = {
      conversations: {
        getObserverConnectionIds: () => new Set<string>(),
        addObserver: () => {
          calls.push("addObserver");
          return true;
        },
        removeObserver: () => calls.push("removeObserver"),
      },
      productApi: new ProductApiDispatcher(
        CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
        [createConversationDirectoryProductApiContribution(application)],
      ),
    } as never;

    const { buildSessionResumeMethod } = await import(
      "../rpc/methods/session.js"
    );
    await buildSessionResumeMethod().handler(
      { conversationId: "conv-order" },
      {
        server: serverCtx,
        connection: { id: 7, clientInfo: { id: "test-cli" } },
      } as never,
    );

    expect(calls).toEqual([
      "addObserver",
      "restoreIdentity",
      "recoverConversation",
      "readRuntime",
      "reviewAdoption",
    ]);
  });

  it("session.resume missing 只回滚本次新增的 observer", async () => {
    const storage: ConversationDirectoryStorage = {
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      rename: async () => null,
      readHistory: async () => ({ runs: [], hasMore: false }),
    };
    const application = new ConversationDirectoryApplicationService({
      storage,
      resume: {
        restoreIdentity: async () => null,
        recoverDependentLifecycle: async () => {
          throw new Error("missing resume must not enter recovery");
        },
      },
      runtime: {
        read: () => ({
          active: false,
          busy: false,
          observerCount: 0,
          pendingCount: 0,
        }),
      },
    });
    const observers = new Set<string>();
    const manager = {
      getObserverConnectionIds: () => observers,
      addObserver: (_conversationId: string, connectionId: string) => {
        observers.add(connectionId);
        return true;
      },
      removeObserver: (_conversationId: string, connectionId: string) => {
        observers.delete(connectionId);
      },
    };
    const serverCtx = {
      conversations: manager,
      productApi: new ProductApiDispatcher(
        CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
        [createConversationDirectoryProductApiContribution(application)],
      ),
    } as never;
    const { buildSessionResumeMethod } = await import(
      "../rpc/methods/session.js"
    );
    const invokeMissing = () =>
      buildSessionResumeMethod().handler(
        { conversationId: "conv-missing" },
        {
          server: serverCtx,
          connection: { id: 7, clientInfo: { id: "test-cli" } },
        } as never,
      );

    await expect(invokeMissing()).rejects.toThrow("Session not found");
    expect(observers.has("7")).toBe(false);

    observers.add("7");
    await expect(invokeMissing()).rejects.toThrow("Session not found");
    expect(observers.has("7")).toBe(true);
  });

  it("session.clear:清空活跃会话并组播 session.changed cleared;busy 时拒绝", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "你好" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result
      .sessionId;
    await client.waitNotification("session.complete");

    const cleared = await client.request("session.clear", {
      conversationId: sessionId,
    });
    expect(isSuccessResponse(cleared)).toBe(true);
    const changed = await client.waitNotification("session.changed");
    expect(changed.params).toEqual({
      conversationId: sessionId,
      change: "cleared",
    });

    client.close();
  });

  it("session.clear:legacy 未知身份保持 NOT_FOUND 且不建目录、不写正文、不广播", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const cleared = await client.request("session.clear", {
      conversationId: "missing-clear",
    });
    expect(isErrorResponse(cleared)).toBe(true);
    if (isErrorResponse(cleared)) {
      expect(cleared.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
      expect(cleared.error.message).toBe("Session not found: missing-clear");
    }
    expect(recordsByConversation.has("missing-clear")).toBe(false);
    const list = await client.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      expect(list.result).toEqual({ conversations: [] });
    }
    await expect(
      client.waitNotification("session.changed", 100),
    ).rejects.toThrow("Timeout waiting for notification: session.changed");

    client.close();
  });

  it("session.compact:运行体不支持时 INTERNAL_ERROR 报能力缺失", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "你好" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result
      .sessionId;
    await client.waitNotification("session.complete");

    const compactResp = await client.request("session.compact", {
      conversationId: sessionId,
    });
    expect(isSuccessResponse(compactResp)).toBe(false);

    client.close();
  });

  it("session.security 返回当前运行体安全快照", async () => {
    await startWithFactory(
      createMockFactory({
        deltaCount: 1,
        securitySnapshot: {
          contextId: { kind: "main" },
          workspacePath: null,
          permissionRules: [],
          builtinRules: [],
          rateLimits: [{ key: "bash", used: 1, limit: 5 }],
          confirmations: [
            { key: "bash::npm", count: 2, highestRisk: "medium" },
          ],
        },
      }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "你好" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result
      .sessionId;
    await client.waitNotification("session.complete");

    const resp = await client.request("session.security", {
      conversationId: sessionId,
    });
    expect(isSuccessResponse(resp)).toBe(true);
    if (isSuccessResponse(resp)) {
      expect(resp.result).toMatchObject({
        contextId: { kind: "main" },
        rateLimits: [{ key: "bash", used: 1, limit: 5 }],
      });
    }

    client.close();
  });

  it("session.usage 返回预算与子 agent 拆分", async () => {
    await startWithFactory(
      createMockFactory({
        deltaCount: 1,
        contextBudget: {
          contextWindow: 200_000,
          effectiveWindow: 180_000,
          currentTokens: 12_000,
          usageRatio: 0.067,
          status: "normal",
        },
        subAgentUsages: [
          {
            index: 1,
            description: "调研模块结构",
            tokens: 12_000,
            toolUses: 2,
            durationMs: 3000,
            subId: "abc123",
            status: "succeeded",
          },
        ],
      }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "你好" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result
      .sessionId;
    await client.waitNotification("session.complete");

    const resp = await client.request("session.usage", {
      conversationId: sessionId,
    });
    expect(isSuccessResponse(resp)).toBe(true);
    if (isSuccessResponse(resp)) {
      expect(resp.result).toMatchObject({
        turnCount: 1,
        calibrationFactor: 0.95,
        subUsages: [
          {
            index: 1,
            description: "调研模块结构",
            tokens: 12_000,
            status: "succeeded",
          },
        ],
      });
    }

    client.close();
  });

  it("session.security:运行体不支持时 INTERNAL_ERROR 报能力缺失", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "你好" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result
      .sessionId;
    await client.waitNotification("session.complete");

    const resp = await client.request("session.security", {
      conversationId: sessionId,
    });
    expect(isSuccessResponse(resp)).toBe(false);
    if (isErrorResponse(resp)) {
      expect(resp.error.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
    }

    client.close();
  });

  it("session.compact / contextBudget / usage / security 对不存在会话先 notFound,不激活 runtime", async () => {
    let createCalls = 0;
    await startWithFactory({
      async create(sessionId) {
        createCalls++;
        return createMockRuntime(sessionId);
      },
    });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const compact = await client.request("session.compact", {
      conversationId: "ghost",
    });
    expect(isErrorResponse(compact)).toBe(true);
    if (isErrorResponse(compact)) {
      expect(compact.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }

    const budget = await client.request("session.contextBudget", {
      conversationId: "ghost",
    });
    expect(isErrorResponse(budget)).toBe(true);
    if (isErrorResponse(budget)) {
      expect(budget.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }

    const usage = await client.request("session.usage", {
      conversationId: "ghost",
    });
    expect(isErrorResponse(usage)).toBe(true);
    if (isErrorResponse(usage)) {
      expect(usage.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }

    const security = await client.request("session.security", {
      conversationId: "ghost",
    });
    expect(isErrorResponse(security)).toBe(true);
    if (isErrorResponse(security)) {
      expect(security.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }

    expect(createCalls).toBe(0);
    const list = await client.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      expect(list.result).toEqual({ conversations: [] });
    }

    client.close();
  });

  it("session.taskListUpdate 返回写后权威快照;session.taskList 可读同源快照", async () => {
    const taskLists = new Map<string, TaskListState>();
    const conversations = new ConversationManager(createMockFactory(), {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
    });
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
      taskListSnapshot: async (conversationId) =>
        taskLists.get(conversationId) ?? null,
      taskListUpdate: async (conversationId, action) => {
        const curr = taskLists.get(conversationId) ?? { items: [] };
        const next: TaskListState =
          action.kind === "add"
            ? {
                items: [
                  ...curr.items,
                  { id: "task-1", content: action.content, status: "pending" },
                ],
              }
            : curr;
        taskLists.set(conversationId, next);
        return { ok: true, message: "ok", taskList: next };
      },
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const before = await client.request("session.taskList", {
      conversationId: "conv-task",
    });
    expect(isSuccessResponse(before)).toBe(true);
    expect((before as { result: { taskList: TaskListState | null } }).result.taskList).toBeNull();

    const updated = await client.request("session.taskListUpdate", {
      conversationId: "conv-task",
      action: { kind: "add", content: "写周报" },
    });
    expect(isSuccessResponse(updated)).toBe(true);
    const updateResult = (
      updated as { result: { taskList: TaskListState } }
    ).result;
    expect(updateResult.taskList.items[0]?.content).toBe("写周报");

    const after = await client.request("session.taskList", {
      conversationId: "conv-task",
    });
    expect(isSuccessResponse(after)).toBe(true);
    const readResult = (after as { result: { taskList: TaskListState } }).result;
    expect(readResult.taskList.items[0]?.content).toBe("写周报");

    client.close();
  });

  it("session.taskListUpdate 不绕过会话 owner:in-flight turn 期间返回 BUSY 且不写入", async () => {
    const updates: unknown[] = [];
    const directory = createMemoryDirectory(recordsByConversation);
    const conversations = new ConversationManager(
      createMockFactory({ deltaCount: 8, yieldDelayMs: 30 }),
      {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      },
      {
        appendRun: async (conversationId, record) => {
          const prev = recordsByConversation.get(conversationId) ?? [];
          recordsByConversation.set(conversationId, [...prev, record]);
          return { runIndex: prev.length, shardId: "000001" };
        },
      },
    );
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
      conversationDirectory: directory,
      productApi: createConversationProductApi({
        directory,
        conversations,
      }),
      taskListSnapshot: async () => null,
      taskListUpdate: async (_conversationId, action) => {
        updates.push(action);
        return { ok: true, message: "ok", taskList: { items: [] } };
      },
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "长任务" });
    const conversationId = (
      sendResp as { result: { conversationId: string } }
    ).result.conversationId;
    await client.waitNotification("session.delta");

    const updated = await client.request("session.taskListUpdate", {
      conversationId,
      action: { kind: "add", content: "不能插队" },
    });
    expect(isErrorResponse(updated)).toBe(true);
    if (isErrorResponse(updated)) {
      expect(updated.error.code).toBe(RPC_ERROR_CODES.BUSY);
    }
    expect(updates).toEqual([]);

    await client.waitNotification("session.complete", 5000);
    client.close();
  });

  it("error 终止的 turn:complete.result.error 的 name / message 经真实 wire 保真(AgentError 实例直发会丢的回归锚)", async () => {
    await startWithFactory(
      createMockFactory({ deltaCount: 1, errorResult: "provider 炸了" }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "hi" });
    const complete = await client.waitNotification("session.complete");
    const result = (
      complete.params as {
        result: { reason: string; error?: { name: string; message: string } };
      }
    ).result;
    // Error 的 name / message 是不可枚举原型属性,实例直上 wire 经 JSON 即丢——
    // 此处走真实 WebSocket 序列化,锁住发射端的 wire 投影
    expect(result.reason).toBe("error");
    expect(result.error?.name).toBe("AgentError");
    expect(result.error?.message).toBe("provider 炸了");

    client.close();
  });

  it("session.send 只有在接入面显式声明时才向 runContext 注入 post-turn 控制能力", async () => {
    const observedRunOptions: Array<RunTurnOptions | undefined> = [];
    await startWithFactory(
      createMockFactory({ deltaCount: 0, observedRunOptions }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "default surface" });
    await client.waitNotification("session.complete");
    expect(
      observedRunOptions.at(-1)?.turnContext?.turnOrigin?.surface,
    ).toBeUndefined();

    await client.request("session.send", {
      text: "cli surface",
      surfaceCapabilities: { postTurnControl: true },
    });
    await client.waitNotification("session.complete");
    expect(
      observedRunOptions.at(-1)?.turnContext?.turnOrigin?.surface?.capabilities
        ?.postTurnControl,
    ).toBe(true);

    client.close();
  });

  it("post-turn 控制意图经 session.postTurnControlIntent 定向发起连接,先于 complete;complete 纯结果不带意图", async () => {
    await startWithFactory(
      createMockFactory({
        deltaCount: 1,
        pendingPostTurnControl: {
          intent: { kind: "enter", sceneId: "scene-1" },
          conflict: { kindsSeen: ["exit", "enter"] },
        },
      }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", {
      text: "go",
      surfaceCapabilities: { postTurnControl: true },
    });
    const intent = await client.waitNotification("session.postTurnControlIntent");
    expect((intent.params as { intent: unknown }).intent).toEqual({
      kind: "enter",
      sceneId: "scene-1",
    });
    expect((intent.params as { conflict: unknown }).conflict).toEqual({
      kindsSeen: ["exit", "enter"],
    });
    const complete = await client.waitNotification("session.complete");
    expect(
      (complete.params as { pendingPostTurnControl?: unknown }).pendingPostTurnControl,
    ).toBeUndefined();

    client.close();
  });

  it("控制意图不组播:旁观 observer 收 complete 但物理收不到 postTurnControlIntent", async () => {
    await startWithFactory(
      createMockFactory({
        deltaCount: 1,
        pendingPostTurnControl: {
          intent: { kind: "enter", sceneId: "scene-1" },
        },
      }),
    );
    const alice = await connect(server.port);
    const bob = await connect(server.port);
    await alice.request("auth", { token: TEST_TOKEN });
    await bob.request("auth", { token: TEST_TOKEN });

    const first = await alice.request("session.send", {
      text: "round-1",
      surfaceCapabilities: { postTurnControl: true },
    });
    const conversationId = (first as { result: { conversationId: string } }).result.conversationId;
    await alice.waitNotification("session.postTurnControlIntent");
    await alice.waitNotification("session.complete");

    await bob.request("session.subscribe", { conversationId });
    await alice.request("session.send", {
      text: "round-2",
      conversationId,
      surfaceCapabilities: { postTurnControl: true },
    });

    // 旁观端:收到组播 complete(纯结果),但意图通知不可达
    const bobComplete = await bob.waitNotification("session.complete");
    expect(
      (bobComplete.params as { pendingPostTurnControl?: unknown }).pendingPostTurnControl,
    ).toBeUndefined();
    await expect(
      bob.waitNotification("session.postTurnControlIntent", 300),
    ).rejects.toThrow();
    // 发起端照常定向收到
    await alice.waitNotification("session.postTurnControlIntent");

    alice.close();
    bob.close();
  });

  it("组播:第二连接 subscribe 后同看流式 turn(delta + complete),unsubscribe 停收;delete 组播 session.changed", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const alice = await connect(server.port);
    const bob = await connect(server.port);
    await alice.request("auth", { token: TEST_TOKEN });
    await bob.request("auth", { token: TEST_TOKEN });

    // alice 开启对话
    const first = await alice.request("session.send", { text: "round-1" });
    const conversationId = (first as { result: { conversationId: string } }).result.conversationId;
    await alice.waitNotification("session.complete");

    // bob 订阅(observer 登记)→ 同看 alice 发起的下一个 turn
    const sub = await bob.request("session.subscribe", { conversationId });
    expect(isSuccessResponse(sub) && (sub.result as { subscribed: boolean }).subscribed).toBe(true);

    await alice.request("session.send", { text: "round-2", conversationId });
    const bobDelta = await bob.waitNotification("session.delta");
    expect((bobDelta.params as { conversationId: string }).conversationId).toBe(conversationId);
    const bobComplete = await bob.waitNotification("session.complete");
    expect((bobComplete.params as { result: AgentResult }).result.reason).toBe("completed");
    // 发起端照常收到(发起者在名册内)
    await alice.waitNotification("session.complete");

    // unsubscribe 后 bob 不再收;delete 前的 changed 只发给在册 observer(alice)
    await bob.request("session.unsubscribe", { conversationId });
    await alice.request("session.delete", { conversationId });
    const changed = await alice.waitNotification("session.changed");
    expect(changed.params).toEqual({ conversationId, change: "deleted" });

    alice.close();
    bob.close();
  });

  it("session.subscribe 可订阅已落盘但未激活会话;run 外变更照常组播", async () => {
    await startWithFactory(createMockFactory());
    const alice = await connect(server.port);
    const bob = await connect(server.port);
    await alice.request("auth", { token: TEST_TOKEN });
    await bob.request("auth", { token: TEST_TOKEN });

    const created = await alice.request("session.new");
    expect(isSuccessResponse(created)).toBe(true);
    const conversationId = (created as { result: { conversationId: string } })
      .result.conversationId;

    const sub = await alice.request("session.subscribe", { conversationId });
    expect(
      isSuccessResponse(sub) && (sub.result as { subscribed: boolean }).subscribed,
    ).toBe(true);

    const list = await bob.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      const entry = (
        list.result as {
          conversations: Array<{
            conversationId: string;
            active: boolean;
            observerCount: number;
          }>;
        }
      ).conversations.find((c) => c.conversationId === conversationId);
      expect(entry).toMatchObject({
        active: false,
        observerCount: 1,
      });
    }

    await bob.request("session.rename", { conversationId, name: "新名字" });
    const renamed = await alice.waitNotification("session.changed");
    expect(renamed.params).toEqual({
      conversationId,
      change: "renamed",
      name: "新名字",
    });

    await bob.request("session.delete", { conversationId });
    const deleted = await alice.waitNotification("session.changed");
    expect(deleted.params).toEqual({ conversationId, change: "deleted" });

    alice.close();
    bob.close();
  });

  it("session.subscribe 对不存在会话返回 subscribed:false", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const r = await client.request("session.subscribe", { conversationId: "ghost" });
    expect(isSuccessResponse(r) && (r.result as { subscribed: boolean }).subscribed).toBe(false);
    client.close();
  });

  it("session.send 显式 stale conversationId 不会重建已删事实流", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const created = await client.request("session.new");
    expect(isSuccessResponse(created)).toBe(true);
    const conversationId = (created as { result: { conversationId: string } })
      .result.conversationId;
    await client.request("session.delete", { conversationId });

    const stale = await client.request("session.send", {
      conversationId,
      text: "should not resurrect",
    });
    expect(isErrorResponse(stale)).toBe(true);
    if (isErrorResponse(stale)) {
      expect(stale.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }
    expect(recordsByConversation.get(conversationId)).toHaveLength(0);

    const list = await client.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      expect(list.result).toEqual({ conversations: [] });
    }

    client.close();
  });

  it("session.send 显式 id 与并发 delete 竞争时,存在性检查在 owner 门内,不会删除后复活", async () => {
    recordsByConversation.clear();
    const conversationId = "conv_delete_race";
    recordsByConversation.set(conversationId, []);
    const directory = createMemoryDirectory(recordsByConversation);
    let releaseRemove!: () => void;
    let removeEntered!: () => void;
    const removeStarted = new Promise<void>((r) => {
      removeEntered = r;
    });
    const removeGate = new Promise<void>((r) => {
      releaseRemove = r;
    });
    const rawRemove = directory.deleteStoredConversation.bind(directory);
    directory.deleteStoredConversation = async (id) => {
      removeEntered();
      await removeGate;
      return rawRemove(id);
    };
    let createCalls = 0;
    const conversations = new ConversationManager(
      {
        async create(sessionId) {
          createCalls++;
          return createMockRuntime(sessionId);
        },
      },
      {
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 30 * 60_000,
        idleCheckIntervalMs: 999_999,
      },
      {
        appendRun: async (id, record) => {
          const prev = recordsByConversation.get(id) ?? [];
          recordsByConversation.set(id, [...prev, record]);
          return { runIndex: prev.length, shardId: "000001" };
        },
      },
    );
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
      conversationDirectory: directory,
      productApi: createConversationProductApi({
        directory,
        conversations,
      }),
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const deleting = client.request("session.delete", { conversationId });
    await removeStarted;
    const sending = client.request("session.send", {
      conversationId,
      text: "should not resurrect",
    });

    releaseRemove();
    expect(isSuccessResponse(await deleting)).toBe(true);
    const sendResp = await sending;
    expect(isErrorResponse(sendResp)).toBe(true);
    if (isErrorResponse(sendResp)) {
      expect(sendResp.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }
    expect(createCalls).toBe(0);
    expect(recordsByConversation.get(conversationId)).toHaveLength(0);

    client.close();
  });

  it("session.send 显式空 conversationId 不会按首轮 send 新建会话", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const emptyId = await client.request("session.send", {
      conversationId: "",
      text: "should not create",
    });
    expect(isErrorResponse(emptyId)).toBe(true);
    if (isErrorResponse(emptyId)) {
      expect(emptyId.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }

    const nonStringId = await client.request("session.send", {
      conversationId: 42,
      text: "should not create",
    });
    expect(isErrorResponse(nonStringId)).toBe(true);
    if (isErrorResponse(nonStringId)) {
      expect(nonStringId.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }

    const nullConversationId = await client.request("session.send", {
      conversationId: null,
      sessionId: "conv_should_not_fallback",
      text: "should not fallback",
    });
    expect(isErrorResponse(nullConversationId)).toBe(true);
    if (isErrorResponse(nullConversationId)) {
      expect(nullConversationId.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }

    const list = await client.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      expect(list.result).toEqual({ conversations: [] });
    }

    client.close();
  });

  it("session.send rejects empty text", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.send", { text: "" });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }
    client.close();
  });

  it("session.send rejects empty structured input", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.send", {
      input: { parts: [{ type: "text", text: "" }] },
    });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }
    client.close();
  });

  it("session.send rejects text and structured input together", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.send", {
      text: "plain",
      input: { parts: [{ type: "text", text: "structured" }] },
    });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }
    client.close();
  });

  it("session.send with existing sessionId reuses runtime", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const r1 = await client.request("session.send", { text: "first" });
    const id1 = (r1 as { result: { sessionId: string } }).result.sessionId;
    await client.waitNotification("session.complete");

    const r2 = await client.request("session.send", { text: "second", sessionId: id1 });
    const id2 = (r2 as { result: { sessionId: string } }).result.sessionId;
    expect(id2).toBe(id1);
    await client.waitNotification("session.complete");

    const list = await client.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      const { conversations } = list.result as { conversations: Array<{ conversationId: string }> };
      expect(conversations).toHaveLength(1);
      expect(conversations[0]!.conversationId).toBe(id1);
    }
    // 两轮 turn 各落一条 run record(同一运行时复用)
    expect(recordsByConversation.get(id1)).toHaveLength(2);

    client.close();
  });

  it("error in runtime.run is reported via session.complete with error reason", async () => {
    await startWithFactory(createMockFactory({ throwError: "boom" }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "trigger error" });
    const complete = await client.waitNotification("session.complete");
    const result = (complete.params as { result: AgentResult }).result;
    expect(result.reason).toBe("error");
    if (result.reason === "error") {
      expect(result.error.message).toBe("boom");
    }

    client.close();
  });

  // ─── session.list ───

  it("session.list:盘上空 → 空清单(纯内存 ephemeral 不进列表)", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.list");
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect(r.result).toEqual({ conversations: [] });
    }
    client.close();
  });

  it("session.list:盘上全量叠加活跃态(busy 随 turn 起落)", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 2, yieldDelayMs: 50 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    // 先完成一轮(落盘进清单),再发慢速第二轮观测 busy
    const first = await client.request("session.send", { text: "warm" });
    const conversationId = (first as { result: { conversationId: string } }).result.conversationId;
    await client.waitNotification("session.complete");

    await client.request("session.send", { text: "slow", conversationId });
    const listBusy = await client.request("session.list");
    expect(isSuccessResponse(listBusy)).toBe(true);
    if (isSuccessResponse(listBusy)) {
      const { conversations } = listBusy.result as {
        conversations: Array<{ conversationId: string; active: boolean; busy: boolean }>;
      };
      const entry = conversations.find((c) => c.conversationId === conversationId)!;
      expect(entry.active).toBe(true);
      expect(entry.busy).toBe(true);
    }

    await client.waitNotification("session.complete");
    const listIdle = await client.request("session.list");
    if (isSuccessResponse(listIdle)) {
      const { conversations } = listIdle.result as {
        conversations: Array<{ conversationId: string; busy: boolean }>;
      };
      expect(conversations.find((c) => c.conversationId === conversationId)!.busy).toBe(false);
    }

    client.close();
  });

  // ─── session.history ───

  it("session.history:倒读落盘事实流(新→旧),不要求会话活跃", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "round-1" });
    const conversationId = (sendResp as { result: { conversationId: string } }).result.conversationId;
    await client.waitNotification("session.complete");
    await client.request("session.send", { text: "round-2", conversationId });
    await client.waitNotification("session.complete");

    const r = await client.request("session.history", { conversationId, limit: 1 });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      const page = r.result as {
        runs: Array<{ record: { messages: Message[] } }>;
        hasMore: boolean;
      };
      // 倒读:首页是最新一轮;更早内容 hasMore
      expect(page.runs).toHaveLength(1);
      const block = page.runs[0]!.record.messages[0]!.content[0]!;
      expect(block.type === "text" && block.text).toBe("round-2");
      expect(page.hasMore).toBe(true);
    }
    client.close();
  });

  it("session.history:未知对话产出空页(读容错),不抛 NOT_FOUND", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.history", { conversationId: "nope" });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect(r.result).toEqual({ runs: [], hasMore: false });
    }
    client.close();
  });

  // ─── session.rename ───

  it("session.rename:改名并组播 session.changed{renamed};未知对话 NOT_FOUND", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "hi" });
    const conversationId = (sendResp as { result: { conversationId: string } }).result.conversationId;
    await client.waitNotification("session.complete");

    const r = await client.request("session.rename", { conversationId, name: "新名字" });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect(r.result).toEqual({ conversationId, name: "新名字" });
    }
    const changed = await client.waitNotification("session.changed");
    expect(changed.params).toEqual({ conversationId, change: "renamed", name: "新名字" });

    const missing = await client.request("session.rename", { conversationId: "nope", name: "x" });
    expect(isErrorResponse(missing)).toBe(true);
    if (isErrorResponse(missing)) {
      expect(missing.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }
    client.close();
  });

  it("session.rename 对场景对话保持全域键(目录返回库内身份,RPC 层不丢 ws: 前缀)", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    // 显式 id 引用必须先在目录层有身份;这里用内存目录的盘上事实种子
    // 模拟场景入口已创建好 local meta,再验证 RPC 层不丢 ws: 全域键。
    const wsId = "ws:scene-1:conv_abc";
    recordsByConversation.set(wsId, []);
    await client.request("session.send", { text: "hi", conversationId: wsId });
    await client.waitNotification("session.complete");

    const r = await client.request("session.rename", { conversationId: wsId, name: "场景对话名" });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect((r.result as { conversationId: string }).conversationId).toBe(wsId);
    }
    client.close();
  });

  it("session.history 拒绝坏 limit / 坏 before(无界读取与分页失真在边界 fail-fast)", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    for (const limit of ["20", 0, -1, 1.5] as unknown[]) {
      const r = await client.request("session.history", { conversationId: "c", limit });
      expect(isErrorResponse(r)).toBe(true);
      if (isErrorResponse(r)) {
        expect(r.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
      }
    }
    const badBefore = await client.request("session.history", {
      conversationId: "c",
      before: { shardId: 1, runIndex: "x" },
    });
    expect(isErrorResponse(badBefore)).toBe(true);
    client.close();
  });

  // ─── session.delete ───

  it("session.delete removes runtime", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "x" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result.sessionId;
    await client.waitNotification("session.complete");

    await client.request("session.delete", { sessionId });
    const list = await client.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      expect(list.result).toEqual({ conversations: [] });
    }
    client.close();
  });

  // ─── 并发互斥 (PendingQueue) ───

  it("concurrent sends to same conversation are serialized", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1, yieldDelayMs: 50 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const r1 = await client.request("session.send", {
      text: "first",
      turnId: "turn-first",
    });
    const convId = (r1 as { result: { conversationId: string } }).result.conversationId;
    expect((r1 as { result: { turnId: string } }).result.turnId).toBe(
      "turn-first",
    );

    const r2 = await client.request("session.send", {
      text: "second",
      conversationId: convId,
      turnId: "turn-second",
    });
    expect(isSuccessResponse(r2)).toBe(true);
    expect((r2 as { result: { turnId: string } }).result.turnId).toBe(
      "turn-second",
    );

    const c1 = await client.waitNotification("session.complete");
    const c1Params = c1.params as {
      turnId: string;
      result: { reason: string };
    };
    const c1Result = c1Params.result;
    expect(c1Params.turnId).toBe("turn-first");
    expect(c1Result.reason).toBe("completed");

    const c2 = await client.waitNotification("session.complete");
    const c2Params = c2.params as {
      turnId: string;
      result: { reason: string };
    };
    const c2Result = c2Params.result;
    expect(c2Params.turnId).toBe("turn-second");
    expect(c2Result.reason).toBe("completed");

    const list = await client.request("session.list");
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      const { conversations } = list.result as {
        conversations: Array<{ pendingCount: number }>;
      };
      expect(conversations[0]!.pendingCount).toBe(0);
    }
    // 串行执行:两轮各落一条 run record
    expect(recordsByConversation.get(convId)).toHaveLength(2);

    client.close();
  });

  it("session.send returns BUSY when queue is full", async () => {
    const conversations = new ConversationManager(createMockFactory({ deltaCount: 1, yieldDelayMs: 200 }), {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
      maxPending: 2,
    });
    const directory = createMemoryDirectory(recordsByConversation);
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
      conversationDirectory: directory,
      productApi: createConversationProductApi({ directory, conversations }),
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const r1 = await client.request("session.send", { text: "running" });
    const convId = (r1 as { result: { conversationId: string } }).result.conversationId;

    await client.request("session.send", { text: "queued-1", conversationId: convId });
    await client.request("session.send", { text: "queued-2", conversationId: convId });

    const r4 = await client.request("session.send", { text: "overflow", conversationId: convId });
    expect(isErrorResponse(r4)).toBe(true);
    if (isErrorResponse(r4)) {
      expect(r4.error.code).toBe(RPC_ERROR_CODES.BUSY);
    }

    for (let i = 0; i < 3; i++) {
      await client.waitNotification("session.complete", 5000);
    }
    client.close();
  });

  // ─── 配置缺失场景 ───

  it("session.send returns INTERNAL_ERROR when conversations manager is missing", async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      // conversations intentionally omitted
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.send", { text: "hi" });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
    }
    client.close();
  });

  // ─── TranscriptStore 集成 (Step 7b) ───

  it("completed turn is persisted via ConversationManager.recordTurn", async () => {
    const appendedRecords: Array<{ conversationId: string; record: { messages: Message[] } }> = [];

    const conversations = new ConversationManager(createMockFactory({ deltaCount: 1 }), {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
    }, {
      appendRun: async (conversationId, record) => {
        appendedRecords.push({ conversationId, record: { messages: [...record.messages] } });
        return { runIndex: appendedRecords.length - 1, shardId: "000001" };
      },
    });
    const directory = createMemoryDirectory(recordsByConversation);
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
      conversationDirectory: directory,
      productApi: createConversationProductApi({ directory, conversations }),
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "persist me" });
    const convId = (sendResp as { result: { conversationId: string } }).result.conversationId;
    await client.waitNotification("session.complete");

    await sleep(50);

    expect(appendedRecords).toHaveLength(1);
    expect(appendedRecords[0]!.conversationId).toBe(convId);
    const { messages } = appendedRecords[0]!.record;
    expect(messages[0]!.role).toBe("user");
    expect(messages[messages.length - 1]!.role).toBe("assistant");

    client.close();
  });

  it("error turn is NOT persisted via ConversationManager.recordTurn", async () => {
    const appendedRecords: unknown[] = [];

    const conversations = new ConversationManager(createMockFactory({ throwError: "kaboom" }), {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
    }, {
      appendRun: async (_cid, record) => {
        appendedRecords.push(record);
        return { runIndex: appendedRecords.length - 1, shardId: "000001" };
      },
    });
    const directory = createMemoryDirectory(recordsByConversation);
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
      conversationDirectory: directory,
      productApi: createConversationProductApi({ directory, conversations }),
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "will error" });
    await client.waitNotification("session.complete");
    await sleep(50);

    expect(appendedRecords).toHaveLength(0);
    client.close();
  });

  it("loadHistory restores history on getOrCreate（启动装填对进窗口）", async () => {
    const restored: ConversationBootstrap = {
      bootstrap: [
        { role: "user", content: [{ type: "text", text: "previous question" }] },
        { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
      ],
      turnCount: 1,
    };

    const loadHistory = async (conversationId: string) => {
      if (conversationId === "conv_restored") return restored;
      return undefined;
    };

    const conversations = new ConversationManager(
      createMockFactory({ deltaCount: 1 }),
      { graceTimeoutMs: 60_000, idleTimeoutMs: 30 * 60_000, idleCheckIntervalMs: 999_999 },
      {
        loadHistory,
        appendRun: async () => ({ runIndex: 1, shardId: "000001" }),
      },
    );
    recordsByConversation.set("conv_restored", []);
    const directory = createMemoryDirectory(recordsByConversation);
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
      conversationDirectory: directory,
      productApi: createConversationProductApi({ directory, conversations }),
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "follow up", conversationId: "conv_restored" });
    expect(isSuccessResponse(sendResp)).toBe(true);
    await client.waitNotification("session.complete");

    // 装填对已进窗口:本轮 run 输入 = [装填对..., 新用户消息],mock 取末条回声;
    // turnCount 从装填值续延(turnIndex 链路)。窗口投影的细粒度断言由
    // conversation-manager / 同形性测试覆盖,此处锁端到端链路打通。
    const session = conversations.getSession("conv_restored")!;
    expect(session.turnCount).toBe(2); // 装填 1 + 本轮 1
    expect(conversations.getHistory("conv_restored")!.length).toBeGreaterThanOrEqual(4);
    client.close();
  });
});
