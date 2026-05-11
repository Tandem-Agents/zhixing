/**
 * @zhixing/orchestrator/runtime — 公共 API barrel。
 *
 * 仅导出真正面向消费者的契约,避免 internal helper 误入公共 API 表面。
 *
 * **公共 API 分类**:
 *
 * 1. 核心入口与类型
 *    - `createAgentRuntime` + `AgentRuntime` / `CreateAgentRuntimeOptions` /
 *      `RunParams` / `RunResult` / `RunBusContext` / `DecorateRunBusFn` /
 *      `ForceCompactResult`
 *
 * 2. M2 子 agent 实现需要的 system prompt 装配能力
 *    - `buildSystemPrompt` / `MAIN_AGENT_SEGMENTS` / `SUB_AGENT_SEGMENTS` /
 *      `CACHE_BOUNDARY` / `renderIdentity` / 相关类型
 *
 * 3. RunParams 字段引用的类型(契约级类型)
 *    - `EnrichOptions` (RunParams.enrichOptions 的类型)
 *
 * **不导出**(internal helper,仅 createAgentRuntime 内部装配使用):
 *   - `subscribeCompactAccumulator` / `CompactAccumulator`
 *   - `trackMessages`
 *   - `createCompactionFlush`
 *   - `loadProjectContext` / `enrichContext` / `injectContext` /
 *     `REFLECTION_THRESHOLD` / `ProjectContext`
 *
 * 这些 helper 同包测试通过 `import "../X.js"` 直接消费 sub-module 文件,
 * 不依赖 barrel 暴露。未来如确实需要外部消费,在此处显式追加导出 +
 * 同步标注公共 API 契约。
 */

export {
  buildSystemPrompt,
  CACHE_BOUNDARY,
  MAIN_AGENT_SEGMENTS,
  SUB_AGENT_SEGMENTS,
  renderIdentity,
  type PromptBuildContext,
  type SystemPromptSegment,
} from "./system-prompt.js";
export {
  createAgentRuntime,
  type AgentRuntime,
  type CreateAgentRuntimeOptions,
  type DecorateRunBusFn,
  type ForceCompactResult,
  type RunBusContext,
  type RunParams,
  type RunResult,
} from "./create-agent-runtime.js";
export type { EnrichOptions } from "./project-context.js";
export { runContextStorage, type RunContext } from "./run-context.js";
