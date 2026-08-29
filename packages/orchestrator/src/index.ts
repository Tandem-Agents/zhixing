/**
 * @zhixing/orchestrator 公共 API 入口。
 *
 * 同时提供两种导入风格,任选其一:
 *   - 顶级 barrel(本文件):适合一站式标准引入
 *       `import { createAgentRuntime, runChildAgent, createTaskTool } from "@zhixing/orchestrator"`
 *   - sub-path:适合细粒度 / tree-shake 友好
 *       `import { createAgentRuntime } from "@zhixing/orchestrator/runtime"`
 *       `import { mainProfile } from "@zhixing/orchestrator/profile"`
 *       `import { createSecureExecuteTool } from "@zhixing/orchestrator/security"`
 *       `import { runChildAgent } from "@zhixing/orchestrator/subagent"`
 *       `import { resolveSubAgentResolver } from "@zhixing/orchestrator/confirmation"`
 *       `import { createTaskTool } from "@zhixing/orchestrator/tools"`
 *       `import { createAdvancementRuntime } from "@zhixing/orchestrator/advancement"`
 *
 * 既有 sub-path 子树的导出名空间不重叠；runtime 根兼容面则显式列举，
 * 避免新的 Kernel 边界合同从宽泛 package root 泄漏。
 */

// Keep the package root compatible for the existing broad surface while new
// Kernel contracts remain available only from the explicit `./runtime` path.
export {
  AGENT_RUNTIME_LIFECYCLE_PHASES,
  buildSystemPrompt,
  CACHE_BOUNDARY,
  createAgentRuntime,
  createControlCompletionPort,
  createLightCallLLM,
  createLightCallLLMWithUsage,
  createMainCallLLM,
  createMainCallLLMWithUsage,
  emitPostTurnControlIntent,
  governToolExecution,
  hasPostTurnControlCapability,
  MAIN_AGENT_SEGMENTS,
  meteredProviderCall,
  renderIdentity,
  runContextStorage,
  SUB_AGENT_SEGMENTS,
  type AgentRuntime,
  type AgentRuntimeCapacityBinding,
  type AgentRuntimeLifecycle,
  type AttentionWindowChangeReason,
  type ControlCompletionPortOptions,
  type CreateAgentRuntimeOptions,
  type DataDrivenSegment,
  type DecorateRunBusFn,
  type DisposeReason,
  type ForceCompactResult,
  type KernelRunEnvelope,
  type LifecycleAfterRunContext,
  type LifecycleBeforeRunContext,
  type LifecycleContextBase,
  type LifecycleWindowCloseContext,
  type LifecycleWindowOpenContext,
  type MessagePrefixContribution,
  type PromptBuildContext,
  type RunBusContext,
  type RunContext,
  type RunOrchestrationV1Params,
  type RuntimeKind,
  type SystemPromptSegment,
  type TextCallOptions,
  type WindowCloseReason,
  type WindowOpenReason,
} from "./runtime/index.js";
export * from "./profile/index.js";
export * from "./security/index.js";
export * from "./subagent/index.js";
export * from "./confirmation/index.js";
export * from "./tools/index.js";
export * from "./orchestration/index.js";
export * from "./advancement/index.js";
