/**
 * @zhixing/orchestrator/subagent — 子 agent 公共 API barrel
 *
 * 仅导出真正面向消费者的契约,避免 internal helper 泄漏到公共表面。
 *
 * **公共 API 分类**:
 *
 * 1. 主入口
 *    - `runChildAgent` + `RunChildAgentOptions` / `ChildAgentResult`
 *
 * 2. lineage 派生 + abort 文本格式化(Task 工具实现 / 状态条渲染会消费)
 *    - `deriveChildLineage`(从父 lineage + subAgentId 派生子 lineage)
 *    - `formatAbortReasonForLLM`(把 ChildAgentResult.abortReason 转 LLM 可读短语)
 *
 * 3. budget 配置
 *    - `SubAgentBudget` / `SubAgentConfirmationPolicy` /
 *      `DEFAULT_SUB_*` 常量(zhixing.config.json 覆盖配置时锚点)
 *
 * **不导出**(internal,仅同包消费):
 *   - `runSubAgentLoop` / `SubAgentLoopResult` / `RunSubAgentLoopOptions`
 *     (factory 内部驱动,使用门槛高 — 调用方需自备 system prompt / tools /
 *     messages / broker / bus,绕过 runChildAgent 的 cleanup discipline。
 *     未来若 background agent 等场景真正需要,在此处显式追加导出 +
 *     补完使用文档)
 *   - `classifyResult` / `extractFinalAssistantText` / `extractPartialText` /
 *     `ClassifiableLoopResult` / `ChildResultKind`(纯结果折叠工具)
 *   - `resolveSubAgentBudget` / `ResolvedSubAgentBudget`
 *     (factory 内 inline 调,不需要外部消费)
 *
 * 同包测试通过 `import "../X.js"` 直访 sub-module 文件,不依赖 barrel 暴露。
 */

export { runChildAgent } from "./factory.js";
export type { RunChildAgentOptions, ChildAgentResult } from "./factory.js";

export { deriveChildLineage } from "./lineage.js";
export { formatAbortReasonForLLM } from "./abort-format.js";

export {
  DEFAULT_SUB_CONFIRMATION_POLICY,
  DEFAULT_SUB_IDLE_TIMEOUT_MS,
  DEFAULT_SUB_MAX_TOKENS,
  DEFAULT_SUB_MAX_TURNS,
  DEFAULT_SUB_WALL_CLOCK_MS,
} from "./budget.js";
export type {
  SubAgentBudget,
  SubAgentConfirmationPolicy,
} from "./budget.js";
