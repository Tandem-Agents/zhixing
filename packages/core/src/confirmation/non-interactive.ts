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
 * **DANGER —— 仅供测试 / 开发场景使用,严禁生产环境注入**
 *
 * 把任意 confirmation 请求 auto-approve 为 `allow-once`,绕过所有审批流程。
 * 价值场景:
 *   - 子 agent 集成测希望快速跑过权限检查,不构造完整 PermissionStore alwaysAllow 规则
 *   - 渲染器 / hub 单测里隔离 broker 行为验证
 *
 * 生产环境严禁注入 —— 等价于完全关闭安全管道,违反知行 fail-to-deny 默认安全姿态。
 *
 * **唯一启用路径(仅测试)**:测试代码必须**直接构造 broker 注入**:
 * ```typescript
 * import { ConfirmationBroker, failToAllowResolver } from "@zhixing/core";
 * const testBroker = new ConfirmationBroker({ nonInteractiveResolver: failToAllowResolver });
 * ```
 *
 * **任何高层 API 都不暴露本 resolver 的字符串路径** —— sub-agent 的
 * `SubAgentConfirmationPolicy` 字面量类型仅含生产安全策略(`inherit-or-deny`)，
 * 配置文件 / API caller 不可能通过字符串误传到本 resolver。
 * 该设计让"显式构造 broker"成为唯一启用路径,刻意的动作即是最好的 misuse 防御。
 */
export const failToAllowResolver: NonInteractiveResolver = {
  name: "fail-to-allow",
  resolve(): ConfirmationDecision {
    return { kind: "allow-once" };
  },
};

