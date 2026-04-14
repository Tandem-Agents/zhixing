/**
 * 非交互模式解析器 — 无渲染器订阅时的兜底策略
 *
 * Broker 在 requestConfirmation() 被调用时检查 listenerCount：
 *   - 有监听器 → 走正常的队列 + 渲染流程
 *   - 无监听器 → 立即调用 NonInteractiveResolver.resolve()
 *
 * 这是 fail-to-deny 的核心实现——知行的默认安全姿态。
 *
 * 对比 Hermes：Hermes 在非交互时 fail-open（放行一切），这是严重的安全姿态
 * 问题。知行走反方向：默认 fail-to-deny，除非用户显式配置预审批策略。
 */

import type {
  ConfirmationDecision,
  ConfirmationRequest,
  NonInteractiveResolver,
} from "./types.js";

/**
 * 默认解析器——把请求以 deny 拒绝，附带一个说明性 reason。
 * 这是知行生产模式下的安全默认。
 */
export const failToDenyResolver: NonInteractiveResolver = {
  name: "fail-to-deny",
  resolve(request: ConfirmationRequest): ConfirmationDecision {
    return {
      kind: "deny",
      reason: `操作需要用户确认，但当前环境无交互式渲染器（${request.sessionType} 会话）。默认拒绝。`,
    };
  },
};

/**
 * 备选解析器——返回 expired 让上层按"超时"语义处理。
 * 用于上层想区分"用户真的拒绝"和"系统无法询问"的场景。
 */
export const failToExpiredResolver: NonInteractiveResolver = {
  name: "fail-to-expired",
  resolve(): ConfirmationDecision {
    return { kind: "expired" };
  },
};

/**
 * 工具函数：按名字获取内置解析器。
 * Phase 2 接预审批 API 时新增的 delegate-to-preapproval 也会在这里注册。
 */
export function getBuiltinNonInteractiveResolver(
  name: "fail-to-deny" | "fail-to-expired",
): NonInteractiveResolver {
  switch (name) {
    case "fail-to-deny":
      return failToDenyResolver;
    case "fail-to-expired":
      return failToExpiredResolver;
  }
}
