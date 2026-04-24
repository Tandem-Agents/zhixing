// 上下文管理模块公开 API

export type {
  BudgetStatus,
  BudgetThresholds,
  CompactionContext,
  CompactionResult,
  CompactionStrategy,
  CompactLLMFn,
  ContextBudget,
  ContextManagerHook,
  ContextManagerInput,
  ContextManagerOutput,
  ITokenEstimator,
} from "./types.js";
export { DEFAULT_THRESHOLDS, MAX_OUTPUT_RESERVE } from "./types.js";

export type { BuildSystemPromptOptions, ContextEngineConfig } from "./engine.js";
export { ContextEngine, createContextEngine } from "./engine.js";

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
  detectSystemMetaKind,
  stripSummaryPlaceholderPair,
  SYSTEM_META_PROMPT_SECTION,
} from "./system-meta.js";

export type { ToolResultTrimConfig } from "./strategies/tool-result-trim.js";
export {
  ToolResultTrimStrategy,
  createToolResultTrimStrategy,
} from "./strategies/tool-result-trim.js";

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
  ContextProfile,
  ExhaustedAction,
  ScenarioHint,
  TierThresholds,
  ToolCategory,
} from "./context-profile.js";
export {
  AUTONOMOUS_PROFILE,
  INTERACTIVE_PROFILE,
  LOOKUP_PROFILE,
  hintLevel,
  hintToProfile,
} from "./context-profile.js";

export type {
  CurrentHintContext,
  InitialHintContext,
  KeywordClassification,
} from "./scenario-evaluator.js";
export {
  classifyByKeywords,
  evaluateScenario,
  resolveCurrentHint,
  resolveInitialHint,
} from "./scenario-evaluator.js";

export type { TurnDigest } from "./turn-digest.js";
export {
  DIGEST_PREVIEW_CHARS,
  MAX_DIGEST_COUNT,
  extractTurnDigest,
  formatDigestTrail,
} from "./turn-digest.js";

export type {
  LayerAssemblerInput,
  LayerResult,
  ToolDeclaration,
} from "./layer-assembler.js";
export {
  assembleLayers,
  assembleSystemPrompt,
  buildToolCatalog,
} from "./layer-assembler.js";

export type { TierLevel, TierStats } from "./tier-compressor.js";
export {
  TIER2_MAX_CHARS,
  TIER3_MAX_CHARS,
  applyTierCompression,
  determineTier,
} from "./tier-compressor.js";

export type { WindowConfig, WindowResult } from "./window-manager.js";
export {
  MIN_RETAIN_TURNS,
  defaultIsPinned,
  manageWindow,
} from "./window-manager.js";

export type {
  TurnContextSection,
  TurnContextProvider,
  SchedulerProviderOptions,
} from "./turn-context.js";
export {
  TimeProvider,
  SchedulerProvider,
  TurnContextInjector,
} from "./turn-context.js";
