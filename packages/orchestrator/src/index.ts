/**
 * @zhixing/orchestrator 公共 API 入口。
 *
 * 顶级 barrel 只保留既有非 Kernel 能力；Kernel runtime 合同只从窄
 * sub-path 暴露:
 *       `import { createAgentRuntime } from "@zhixing/orchestrator/runtime"`
 *       `import { mainProfile } from "@zhixing/orchestrator/profile"`
 *       `import { createSecureExecuteTool } from "@zhixing/orchestrator/security"`
 *       `import { runChildAgent } from "@zhixing/orchestrator/subagent"`
 *       `import { resolveSubAgentResolver } from "@zhixing/orchestrator/confirmation"`
 *       `import { createTaskTool } from "@zhixing/orchestrator/tools"`
 *       `import { createAdvancementRuntime } from "@zhixing/orchestrator/advancement"`
 *
 * 既有 sub-path 子树的导出名空间不重叠；runtime 根兼容面显式列举，
 * 且不得重新暴露 AgentRuntime 或 Kernel Run 合同。
 */

// Keep the package root compatible for existing non-Kernel helpers while the
// executable Kernel contract remains available only from `./runtime`.
export {
  AGENT_RUNTIME_LIFECYCLE_PHASES,
  buildSystemPrompt,
  CACHE_BOUNDARY,
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
  type AgentRuntimeCapacityBinding,
  type AgentRuntimeLifecycle,
  type AttentionWindowChangeReason,
  type ControlCompletionPortOptions,
  type DataDrivenSegment,
  type DecorateRunBusFn,
  type DisposeReason,
  type ForceCompactResult,
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
export {
  ADVANCEMENT_SUBMIT_REVIEW_TOOL,
  completeMissingRequiredEvidence,
  createAdvancementJudgeTool,
  createAdvancementRuntime,
  createFirstPartyEvidenceProvider,
  detectEvidenceCapabilities,
  EvidenceJournal,
  ExecutorEvidenceHandler,
  requiresIndependentEvidence,
  summarizeRunRecord,
  type AdvancementEvidenceCollectionInput,
  type AdvancementEvidenceProvider,
  type AdvancementReviewRunInput,
  type AdvancementReviewRunOutcome,
  type AdvancementRuntime,
  type AdvancementRuntimeOptions,
  type EvidenceJournalOptions,
  type ExecutorEvidenceHandlerOptions,
  type FirstPartyEvidenceProviderOptions,
  type GitExecFn,
} from "./advancement/index.js";
