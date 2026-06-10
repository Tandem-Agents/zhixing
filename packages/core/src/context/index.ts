// 上下文管理模块公开 API

export type {
  BudgetStatus,
  BudgetThresholds,
  CompactionContext,
  CompactionResult,
  CompactionStrategy,
  CompactionStrategyKind,
  CompactStrategyContribution,
  CompactLLMFn,
  ContextBudget,
  ContextManagerHook,
  ContextManagerInput,
  ContextManagerOutput,
  ITokenEstimator,
} from "./types.js";
export { DEFAULT_THRESHOLDS, MAX_OUTPUT_RESERVE } from "./types.js";

export type { ContextEngineConfig } from "./engine.js";
export { ContextEngine, createContextEngine } from "./engine.js";

export type { ContextTermination } from "./termination.js";
export { resolveContextManager } from "./termination.js";

export {
  TokenEstimator,
  createTokenEstimator,
  estimateTextTokensRaw,
} from "./token-estimator.js";

export type { ModelBudgetInfo } from "./budget.js";
export {
  calculateBudget,
  calculateEffectiveWindow,
  getBudgetStatus,
} from "./budget.js";

export type {
  ResolutionSource,
  ResolutionWarning,
  ResolutionWarningCode,
  ResolveModelInfoInput,
  ResolvedModelInfo,
} from "./model-info-resolver.js";
export {
  CONSERVATIVE_FALLBACK,
  resolveModelInfo,
} from "./model-info-resolver.js";

export type { SplitResult } from "./message-turns.js";
export {
  assertToolPairingIntact,
  calculateMessageTurns,
  splitMessagesPairAware,
} from "./message-turns.js";

export type { SystemMetaKind } from "./system-meta.js";
export {
  buildCompactSummaryPair,
  buildDroppedTurnsMessage,
  buildWorksceneDigestMessage,
  detectSystemMetaKind,
  stripSummaryPlaceholderPair,
  SYSTEM_META_PROMPT_SECTION,
} from "./system-meta.js";

export type { MessageDropConfig } from "./strategies/message-drop.js";
export {
  MessageDropStrategy,
  createMessageDropStrategy,
} from "./strategies/message-drop.js";

export type {
  LLMSummarizeConfig,
  SummarizeLLMFn,
} from "./strategies/llm-summarize.js";
export {
  LLMSummarizeStrategy,
  createLLMSummarizeStrategy,
  createSummarizeFn,
} from "./strategies/llm-summarize.js";

export type { SummarizationTemplate } from "./prompts.js";
export {
  MAIN_SESSION_PROMPT,
  SUB_AGENT_PROMPT,
  MERGE_SUMMARIES_PROMPT,
  buildRetryPrompt,
  getSummarizationPrompt,
  wrapCustomInstructions,
} from "./prompts.js";

export type { ValidationResult } from "./validation.js";
export {
  REQUIRED_MAIN_SECTIONS,
  REQUIRED_SUB_SECTIONS,
  validateSummary,
} from "./validation.js";

export type {
  TurnContextSection,
  TurnContextProvider,
  SchedulerProviderOptions,
} from "./turn-context.js";
export {
  TimeProvider,
  SchedulerProvider,
  TaskListProvider,
  TurnContextInjector,
} from "./turn-context.js";

export * from "./segment/index.js";

export type {
  AcceptRunInput,
  AttentionWindowState,
  CreateAttentionWindowOptions,
  RestoreTailGuard,
  WindowCompact,
  WindowFoldOutcome,
  WindowResetReason,
} from "./window/index.js";
export {
  createAttentionWindow,
  restoreAttentionWindowFromCanonical,
  windowCompactFromMarker,
} from "./window/index.js";

