/**
 * 把 AbortReason (来自 core/interrupt) 格式化为给主 LLM 看的简短英文短语
 *
 * 用途:Task 工具把子 agent 的 ChildAgentResult 转成 ToolResult 时,abort 文本要
 * 让主 LLM 一眼读懂"为什么子失败",再决定 retry / 重新 dispatch / 直接放弃。
 *
 * 设计取舍:
 *   - 英文:对齐 system prompt / 工具描述 / Anthropic 模型语料统计偏好,主 LLM
 *     在英文上下文中理解最稳定
 *   - 短语而非完整句子:留给主 agent 做更高层叙述,避免 tool_result 里塞过多
 *     "解释性"文本污染上下文 token 预算
 *   - parent-abort 不展开 parentReason 链:当前只回到第一层 reason 就够主 agent 决策,
 *     v2 引入背景 agent / 多层嵌套时再考虑"reason 链路完整还原"
 */
import type { AbortReason } from "@zhixing/core";

export function formatAbortReasonForLLM(reason: AbortReason): string {
  switch (reason.kind) {
    case "user-cancel":
      return "user cancelled the parent task";
    case "idle-timeout":
      return "sub-agent LLM stream idle for too long";
    case "parent-abort":
      return "parent agent was aborted";
    case "external":
      return reason.origin
        ? `external abort: ${reason.origin}`
        : "external abort";
  }
}
