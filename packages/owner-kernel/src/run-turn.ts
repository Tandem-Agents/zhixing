/**
 * runTurnWithCommit —— 一次 session turn 的"运行 + 提交"编排。
 *
 * 状态模型：run 输入在此瞬态构造（[...注意力窗口, 用户消息]——窗口归
 * ManagedSession，runtime 是纯执行体）。耐久协议下输入在进入内存调度前已写
 * queued 权威事实；旧路径则仍只在本 helper 内瞬态持有。两条路径都只在最终
 * 提交接受后推进窗口，因此失败不会留下孤儿 userMsg，也无需窗口回滚机器。
 *
 * 责任边界：helper 负责"运行 + 按结果决定是否提交"。旧路径的用户可见后果由
 * caller 投影；耐久路径的结果与状态由权威 outbox 投影。日志与告警通过 hooks
 * 注入，helper 不依赖具体 logger / eventBus。
 *
 * 接受策略：只接受 completed 的 run —— 中断 / 出错的 run 不落盘不入窗
 * （partial 内容已经由 yield 流推给用户，但不成为对话事实）。
 */

import {
  userMessageFromTurnInput,
  type AbortReason,
  type AgentYield,
  type Message,
  type RunResult,
  type TurnSource,
  type UserTurnInputLike,
} from "@zhixing/core";
import type { ConversationManager } from "./conversation-manager.js";
import type { RunTurnOptions, SessionRuntime } from "./types.js";
import type {
  ConversationInvocation,
  ConversationRunState,
  ContentAssetRef,
  ExplicitEnvironmentSelection,
  SessionControlMutation,
} from "@zhixing/core/contracts";

// ─── Hooks ───

/**
 * runTurnWithCommit 的可选回调 —— 让 caller 观测持久化失败场景做日志 / 告警。
 *
 * helper 不强加 logger / eventBus 依赖，caller 自行注入。
 */
export interface RunTurnHooks {
  /**
   * 持久化失败回调 —— run 本身成功（runResult.agentResult.reason === "completed"），
   * 但 `ConversationManager.recordTurn` 抛错时触发。
   *
   * 此时窗口未前进（接受协议在持久化成功之后才触窗口）——本轮不成为对话事实，
   * 但用户仍会看到本轮 assistant 回复（在 `runResult.agentResult` 里，由 caller
   * 发给用户）。
   */
  readonly onCommitFailure?: (err: unknown, runResult: RunResult) => void;
  /** Final-outbox publication failed after the authoritative commit already succeeded. */
  readonly onFinalPublishFailure?: (err: unknown, runResult: RunResult) => void;
}

/** Durable owner-protocol input for one conversation turn. */
export interface DurableConversationTurnInput {
  readonly conversationId: string;
  readonly input: UserTurnInputLike;
  readonly attachments?: readonly ContentAssetRef[];
  readonly messages: readonly Message[];
  readonly baseRevision: number;
  readonly runtime: SessionRuntime;
  /**
   * Composes invocation-specific behavior around the executor-local runtime that
   * was created for the frozen environment. The protocol retains lifecycle
   * ownership of the supplied runtime.
   */
  readonly adaptLocalRuntime?: (runtime: SessionRuntime) => SessionRuntime;
  readonly invocation: ConversationInvocation;
  readonly environment?: ExplicitEnvironmentSelection;
  readonly options?: RunTurnOptions;
  readonly hooks?: RunTurnHooks;
}

/** Durable admission performed before a turn enters the in-memory scheduler. */
export interface DurableConversationAdmissionInput {
  readonly conversationId: string;
  readonly input: UserTurnInputLike;
  readonly attachments?: readonly ContentAssetRef[];
  readonly invocation: ConversationInvocation;
  readonly environment?: ExplicitEnvironmentSelection;
  readonly options?: RunTurnOptions;
  /** Stable authenticated surface identity when transport routing identity is ephemeral. */
  readonly surfacePrincipal?: string;
}

export interface DurableConversationAdmissionResult {
  readonly runId: string;
  /** False when the same durable run already owns an in-memory execution slot. */
  readonly shouldSchedule: boolean;
}

export interface DurableConversationControlPrincipal {
  readonly surfacePrincipal: string;
  readonly deviceId: string;
  readonly connectionId: string;
}

export interface DurableConversationCancelInput {
  readonly conversationId: string;
  readonly requestId: string;
  /** Omit only for an authenticated batch-cancel surface or a legacy caller. */
  readonly runId?: string;
  readonly reason?: AbortReason;
  readonly principal: DurableConversationControlPrincipal;
  /**
   * 渠道批量取消的回执绑定;仅 runId 缺省的批量形态可携带。
   * 空批次回执由 cancel-batch 权威决定经 DeliveryAuthority 产出。
   */
  readonly response?: {
    readonly replyTarget: import("@zhixing/core/contracts").DeliveryTargetDto;
  };
}

export interface DurableConversationCancellationDisposition {
  readonly runId: string;
  readonly runState: ConversationRunState;
  readonly source: TurnSource;
  /** Stable ingress identity of the cancelled run, for exact auxiliary projection binding. */
  readonly ingressId: string;
  readonly abortedInFlight: boolean;
  readonly cancelledPending: number;
}

export interface DurableConversationCancellationResult {
  readonly dispositions: readonly DurableConversationCancellationDisposition[];
}

/** Read-only durable ownership of a stable ingress identity. */
export interface DurableConversationIngressRun {
  readonly runId: string;
  readonly state: ConversationRunState;
}

/**
 * 已终结交互的耐久 outcome 投影——单源自 owner 权威日志的 interaction
 * mirror(耐久 resolve 成功 ⇒ mirror 已落盘)。answered 保留绑定 requestId 的
 * 完整决定摘要，供 surface 精确区分同一决定重放与异决定冲突。
 * cancelled/expired/auto-resolved 归 closed——非本用户决策,不参与回放。
 */
export type DurableInteractionOutcome =
  | { readonly t: "answered"; readonly decisionDigest: string }
  | { readonly t: "closed" };

export interface DurableConversationResolveInput {
  readonly conversationId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly ownerEpoch: number;
  readonly openFactDigest: string;
  readonly decision:
    | "user-verified-side-effects"
    | "user-abandoned"
    | "user-retry-acknowledged";
  readonly principal: DurableConversationControlPrincipal;
}

export interface DurableConversationResolutionResult {
  readonly state: "queued" | "cancelled" | "failed";
  readonly factDigest: string;
}

export interface DurableConversationSessionWriteInput {
  readonly conversationId: string;
  readonly requestId: string;
  readonly mutation: Extract<
    SessionControlMutation,
    { kind: "window-op" | "conversation-delete" }
  >;
  readonly principal: DurableConversationControlPrincipal;
  /** Transition-time identity source used only before the first durable lifecycle fact. */
  readonly conversationExists: () => Promise<boolean>;
}

export interface DurableConversationSessionProjectionInput {
  readonly conversationId: string;
  readonly requestId: string;
  readonly mutation: "clear" | "delete";
  readonly domainRevision: number;
}

export type DurableConversationSessionWriteResult =
  | { readonly status: "accepted"; readonly domainRevision: number }
  | { readonly status: "busy" }
  | { readonly status: "not-found" };

/**
 * Production seam that switches a conversation turn onto the durable protocol.
 *
 * 全部能力必需:协议启用与能力完整不可分叉。legacy 模式只以 executor
 * 整体缺席(manager 未装配)表达;任何实现不得省略方法或以空实现冒充,
 * 测试夹具必须提供显式完整 adapter。
 */
export interface DurableConversationTurnExecutor {
  admit(
    input: DurableConversationAdmissionInput,
  ): Promise<DurableConversationAdmissionResult>;
  /** Transfers a durable admission claim after the in-memory scheduler accepted it. */
  confirmScheduled(conversationId: string, runId: string): void;
  /** Returns an accepted-but-unscheduled run to durable recovery ownership. */
  deferScheduling(conversationId: string, runId: string): void;
  cancelAdmitted(conversationId: string, runId: string): Promise<void>;
  cancel(
    input: DurableConversationCancelInput,
  ): Promise<DurableConversationCancellationResult>;
  findRunByIngress(
    conversationId: string,
    ingressId: string,
    source: ConversationInvocation["source"],
  ): Promise<DurableConversationIngressRun | undefined>;
  /** Replays a finished interaction from the durable mirror; undefined = never durably finished. */
  findInteractionOutcome(
    conversationId: string,
    requestId: string,
  ): Promise<DurableInteractionOutcome | undefined>;
  resolveUncertain(
    input: DurableConversationResolveInput,
  ): Promise<DurableConversationResolutionResult>;
  writeSession(
    input: DurableConversationSessionWriteInput,
  ): Promise<DurableConversationSessionWriteResult>;
  /** Materializes and acknowledges the exact durable lifecycle fact. */
  projectSession(
    input: DurableConversationSessionProjectionInput,
  ): Promise<void>;
  controlPrincipal(input: {
    readonly surfacePrincipal: string;
    readonly connectionId: string;
  }): DurableConversationControlPrincipal;
  run(input: DurableConversationTurnInput): AsyncGenerator<AgentYield, RunResult>;
  publishPendingFinals(conversationId: string): Promise<number>;
  /** Drops rebuildable in-process projections when the owning session is released. */
  releaseConversation(conversationId: string): void;
}

// ─── Helper ───

/**
 * 运行一轮 turn 并按结果提交。
 *
 * AsyncGenerator 透传 yield 事件给消费者（RPC 投影用于主流推送；
 * 渠道入口消费但忽略）。最终 return RunResult —— caller 据此判断如何给
 * 用户发回复。
 *
 * @param manager          ConversationManager 实例（提供 recordTurn）
 * @param conversationId   目标会话 ID —— session 必须已 getOrCreate（否则 throw）
 * @param input            用户 turn 输入
 * @param options          透传给 runtime.run（abortSignal / turnContext / turnIndex / source）
 * @param hooks            可选回调（onCommitFailure）
 * @returns                AsyncGenerator<AgentYield, RunResult>
 *
 * @throws  `session ${id} not found` 若 conversationId 对应的会话未创建
 * @throws  runtime.run 本身抛出的任何异常（内存停在 run 前基底，caller 负责报错）
 */
export async function* runTurnWithCommit(
  manager: ConversationManager,
  conversationId: string,
  input: UserTurnInputLike,
  options?: RunTurnOptions,
  hooks?: RunTurnHooks,
): AsyncGenerator<AgentYield, RunResult> {
  const session = manager.getSession(conversationId);
  if (!session) {
    throw new Error(
      `runTurnWithCommit: session ${conversationId} not found in manager`,
    );
  }

  const messages = [
    ...session.window.getMessages(),
    userMessageFromTurnInput(input),
  ];
  const durable = manager.durableTurnExecutor();
  if (durable) {
    return yield* durable.run({
      conversationId,
      input,
      ...(options?.attachments ? { attachments: options.attachments } : {}),
      messages,
      baseRevision: session.turnCount,
      runtime: session.runtime,
      invocation: agentInvocation(options),
      ...(options ? { options } : {}),
      ...(hooks ? { hooks } : {}),
    });
  }

  // run 输入 = 窗口事实 + 本轮用户消息,瞬态构造——用户消息不预写入任何状态,
  // accept 之前窗口不前进。
  const gen = session.runtime.run(messages, options);
  let runResult: RunResult;
  while (true) {
    const iter = await gen.next();
    if (iter.done) {
      runResult = iter.value;
      break;
    }
    yield iter.value;
  }

  if (runResult.agentResult.reason === "completed") {
    const source = runResult.runRecord.source ?? options?.source;
    const advancement =
      runResult.runRecord.advancement ?? options?.advancement;
    const runRecord = {
      ...runResult.runRecord,
      ...(source ? { source } : {}),
      ...(advancement ? { advancement } : {}),
    };
    try {
      await manager.recordTurn(
        conversationId,
        runRecord,
        runResult.windowCompact,
        { turnId: options?.turnContext?.turnId },
      );
    } catch (err) {
      // 持久化失败：窗口未前进、本轮不成为对话事实。不 re-throw —— caller 的
      // 主流程（发回复给用户）不应被持久化失败打断，但要观测，走 hook 通知。
      hooks?.onCommitFailure?.(err, runResult);
    }
  }

  return runResult;
}

function agentInvocation(options?: RunTurnOptions): ConversationInvocation {
  const source = options?.source ?? "interactive";
  return {
    kind: "agent",
    source,
    ...(source === "advancement" && options?.advancement
      ? { advancement: options.advancement }
      : {}),
  };
}
