/**
 * runTurnWithCommit —— 原子化一次 session turn 的"运行 + 提交 + 异常回滚"。
 *
 * 设计背景：
 *   userMsg push（adapter 入口）和 canonical 覆盖（updateMessages）
 *   拆成两个时点。有 3 条异常路径会让 updateMessages 不被调用：
 *     P1: agent-loop 返回 non-completed（error / max_turns / aborted）
 *     P2: commitTurn 实现 throw（disk full / permission / 自定义持久化错误）
 *     P3: runtime.run 本身 throw（网络、权限、abortSignal 触发）
 *   任意一条触发 → adapter.messages 留下"孤儿 userMsg"（无对应 assistant）→
 *   下一轮 LLM 输入违反协议（两条连续 user 块）→ Anthropic / OpenAI API 直接 422。
 *
 *   此 helper 把三条路径都纳管：入口保存 preRun snapshot，按 reason 分叉：
 *     - completed + recordTurn 成功：正常路径，canonical 已由 recordTurn 覆盖
 *     - completed + recordTurn throw：内部 rollback + 通过 hooks.onCommitFailure 通知
 *     - non-completed：rollback 到 preRun
 *     - runtime throw：rollback 后 re-throw 让 caller 报错给用户
 *
 *   rollback 和 session-adapter 的 Bug A 自修（non-completed 自动 pop userMsg）
 *   幂等共存：adapter 先 pop，helper 再 updateMessages(preRun) 覆盖成相同的 preRun
 *   状态 —— 双保险，任一层缺失另一层也能保证内存合法。
 *
 * 责任边界：
 *   helper 只负责"状态正确性" —— rollback 保证 adapter 不留 orphan userMsg。
 *   用户可见的后果（发回复 / 发错误 / 发回执）由 caller 按 runResult.agentResult 决定。
 *   commitTurn 失败的日志 / metrics / 告警通过 onCommitFailure hook 由 caller 实施
 *   —— helper 不依赖具体 logger / eventBus。
 */

import type { AgentYield, Message, RunResult } from "@zhixing/core";
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
   * 调用此 hook 时 adapter.messages 已被 helper rollback 到 preRun 状态 ——
   * 本轮对话历史丢失，但用户仍会看到本轮 assistant 回复（assistant 消息在
   * `runResult.agentResult` 里，由 caller 发给用户）。
   */
  readonly onCommitFailure?: (err: unknown, runResult: RunResult) => void;
}

// ─── Helper ───

/**
 * 原子化 turn —— 运行 runtime.run + recordTurn + 异常 rollback。
 *
 * AsyncGenerator 透传 yield 事件给消费者（session.ts RPC 用于 session.delta 推送；
 * inbound-router 消费但忽略）。最终 return RunResult —— caller 据此判断如何给
 * 用户发回复。
 *
 * @param manager          ConversationManager 实例（提供 recordTurn）
 * @param conversationId   目标会话 ID —— session 必须已 getOrCreate（否则 throw）
 * @param text             用户消息文本
 * @param options          透传给 runtime.run（abortSignal / turnContext / turnIndex / source）
 * @param hooks            可选回调（onCommitFailure）
 * @returns                AsyncGenerator<AgentYield, RunResult>
 *
 * @throws  `session ${id} not found` 若 conversationId 对应的会话未创建
 * @throws  runtime.run 本身抛出的任何异常（adapter state 已 rollback，caller 负责报错）
 */
export async function* runTurnWithCommit(
  manager: ConversationManager,
  conversationId: string,
  text: string,
  options?: RunTurnOptions,
  hooks?: RunTurnHooks,
): AsyncGenerator<AgentYield, RunResult> {
  const session = manager.getSession(conversationId);
  if (!session) {
    throw new Error(
      `runTurnWithCommit: session ${conversationId} not found in manager`,
    );
  }
  const runtime = session.runtime;

  // 保存 pre-run snapshot —— 异常路径 rollback 的唯一合法状态来源。
  // 必须在 runtime.run 之前保存（run 入口会 push userMsg，后保存就含 orphan 了）。
  const preRun: Message[] = runtime.getHistory();

  let runResult: RunResult;
  try {
    const gen = runtime.run(text, options);
    while (true) {
      const iter = await gen.next();
      if (iter.done) {
        runResult = iter.value;
        break;
      }
      yield iter.value;
    }
  } catch (err) {
    // P3: runtime.run 内部 throw —— abort / provider 错误 / 意外异常。
    //   adapter 的 throw 路径本身已 pop userMsg（turnAborted=true 那条），
    //   但"未进 turnAborted 的 throw"（理论少见）也要覆盖 —— updateMessages 幂等兜底。
    runtime.updateMessages(preRun);
    throw err;
  }

  // P1 / P2 决策：按 reason 分叉
  if (runResult.agentResult.reason === "completed") {
    try {
      await manager.recordTurn(
        conversationId,
        runResult.turn,
        runResult.compactBefore,
      );
    } catch (err) {
      // P2: commitTurn 失败 —— rollback + 通知 caller
      //   内存 state 回到 run 前（本轮历史丢失，用户可见回复由 caller 照常发）。
      //   不 re-throw：caller 的主流程（发回复给用户）不应被持久化失败打断，
      //   但要观测，所以走 hook 通知。
      runtime.updateMessages(preRun);
      hooks?.onCommitFailure?.(err, runResult);
    }
  } else {
    // P1: non-completed —— adapter 自修已 pop userMsg，此处 updateMessages(preRun)
    //   是幂等覆盖 + 架构明确性（helper 不依赖 adapter 自修的实现细节，自己也能
    //   独立保证 state 正确）。两者互不冲突。
    runtime.updateMessages(preRun);
  }

  return runResult;
}
