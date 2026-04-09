// 上下文管理模块公开 API

export type {
  BudgetStatus,
  BudgetThresholds,
  CompactionContext,
  CompactionResult,
  CompactionStrategy,
  ContextBudget,
  ContextManagerHook,
  ContextManagerInput,
  ContextManagerOutput,
  ITokenEstimator,
} from "./types.js";
export { DEFAULT_THRESHOLDS, MAX_OUTPUT_RESERVE } from "./types.js";

export type { ContextEngineConfig } from "./engine.js";
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

export type { ToolResultTrimConfig } from "./strategies/tool-result-trim.js";
export {
  ToolResultTrimStrategy,
  calculateMessageTurns,
  createToolResultTrimStrategy,
} from "./strategies/tool-result-trim.js";

export type { MessageDropConfig } from "./strategies/message-drop.js";
export {
  MessageDropStrategy,
  createMessageDropStrategy,
} from "./strategies/message-drop.js";
