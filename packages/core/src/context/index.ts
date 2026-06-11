// 上下文管理模块公开 API

export type {
  BudgetStatus,
  BudgetThresholds,
  ContextBudget,
  ITokenEstimator,
} from "./types.js";
export { DEFAULT_THRESHOLDS, MAX_OUTPUT_RESERVE } from "./types.js";

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
  buildStartupBootstrapPair,
  buildWorksceneDigestMessage,
  detectSystemMetaKind,
  stripSummaryPlaceholderPair,
  SYSTEM_META_PROMPT_SECTION,
} from "./system-meta.js";

export * from "./bootstrap/index.js";

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
  WindowCompact,
  WindowFoldOutcome,
  WindowResetReason,
} from "./window/index.js";
export { createAttentionWindow } from "./window/index.js";

