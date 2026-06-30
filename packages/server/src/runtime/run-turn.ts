/**
 * runTurnWithCommit —— 一次 session turn 的"运行 + 提交"编排。
 *
 * 状态模型：run 输入在此瞬态构造（[...注意力窗口, 用户消息]——窗口归
 * ManagedSession，runtime 是纯执行体），用户消息在被接受之前不进入任何状态；
 * 窗口只在 recordTurn 的接受协议（先持久化 / pending 入列成功、后 acceptRun）
 * 下前进。因此所有失败路径——non-completed、持久化抛错、runtime.run 自身
 * 抛错——内存都自然停在 run 前基底，孤儿 userMsg 这一类状态不可能产生，
 * 无需任何 snapshot / 回滚机器。
 *
 * 责任边界：
 *   helper 只负责"运行 + 按结果决定是否提交"。用户可见的后果（发回复 / 发错误 /
 *   发回执）由 caller 按 runResult.agentResult 决定。持久化失败的日志 /
 *   metrics / 告警通过 onCommitFailure hook 由 caller 实施 —— helper 不依赖
 *   具体 logger / eventBus。
 *
 * 接受策略：只接受 completed 的 run —— 中断 / 出错的 run 不落盘不入窗
 * （partial 内容已经由 yield 流推给用户，但不成为对话事实）。
 */

import {
  userMessageFromTurnInput,
  type AgentYield,
  type RunResult,
  type UserTurnInputLike,
} from "@zhixing/core";
import type { ConversationManager } from "./conversation-manager.js";
import type { RunTurnOptions } from "./types.js";

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
}

// ─── Helper ───

/**
 * 运行一轮 turn 并按结果提交。
 *
 * AsyncGenerator 透传 yield 事件给消费者（session.ts RPC 用于 session.delta 推送；
 * inbound-router 消费但忽略）。最终 return RunResult —— caller 据此判断如何给
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

  // run 输入 = 窗口事实 + 本轮用户消息,瞬态构造——用户消息不预写入任何状态,
  // accept 之前窗口不前进。
  const gen = session.runtime.run(
    [...session.window.getMessages(), userMessageFromTurnInput(input)],
    options,
  );
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
    try {
      await manager.recordTurn(
        conversationId,
        runResult.runRecord,
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
