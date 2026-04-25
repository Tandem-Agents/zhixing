// Security — 安全系统模块的公开 API

// 类型导出
export type {
  BoundaryCrossing,
  BoundaryType,
  IPermissionStore,
  IPolicyEngine,
  IToolArgumentExtractor,
  MatchSpec,
  MutableToolBoundaryRegistry,
  OperationClass,
  OperationClassifier,
  PermissionDecision,
  PermissionRule,
  PermissionScope,
  RiskLevel,
  RuleAction,
  SecurityAction,
  SecurityDecision,
  SecurityEventMap,
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
  SecurityMiddlewareState,
  SecurityRequest,
  SecurityRule,
  SessionType,
  ThreatCategory,
  ToolBoundaryRegistry,
} from "./types.js";

// 策略引擎
export { PolicyEngine } from "./policy-engine.js";

// 内置规则
export { BUILTIN_RULES } from "./builtin-rules.js";

// 操作分类器
export {
  BoundaryImpactClassifier,
  CompositeClassifier,
  EMPTY_BOUNDARY_REGISTRY,
  FileSystemClassifier,
  ShellClassifier,
  createDefaultClassifier,
} from "./classifier.js";
export type { CreateClassifierOptions } from "./classifier.js";

// 边界注册表（从 ToolDefinition 列表构造，供入口注入分类器；支持动态 register/unregister）
export { BoundaryRegistry } from "./boundary-registry.js";

// 权限存储
export {
  PermissionStore,
  globMatches,
  globSpecificity,
  globToRegex,
} from "./permission-store.js";
export type { PermissionStoreOptions } from "./permission-store.js";
// 注：`defaultExtractArgument` 不导出——仅作为 ToolArgumentExtractor 内部 fallback 使用，
// 避免外部 caller 误用绕过 tool-aware 路径破坏 M3 的"显式声明优先"语义。

// 参数提取器（从 ToolDefinition 列表构造，注入 PermissionStoreOptions.extractArgument）
export { ToolArgumentExtractor } from "./tool-aware-extractor.js";

// 权限匹配中间件
export { PermissionMatcherMiddleware } from "./permission-matcher.js";

// 确认追踪与建议
export {
  ConfirmationTracker,
  suggestPatterns,
} from "./confirmation-tracker.js";
export type {
  IConfirmationTracker,
  SuggestedPattern,
  SuggestionStatus,
} from "./confirmation-tracker.js";

// 命令预解析器
export {
  CommandAnalyzerMiddleware,
  analyzeCommand,
} from "./command-analyzer.js";
export type {
  CommandAnalysis,
  RedirectSpec,
  SubcommandInfo,
} from "./command-analyzer.js";

// 执行守卫
export { EnvSanitize } from "./env-sanitize.js";
export { PathGuard } from "./path-guard.js";
export {
  ExecutionGuardMiddleware,
  RateLimitError,
  TimeoutError,
  truncateOutput,
  wrapWithConstraints,
} from "./execution-guard.js";
export type {
  ExecutionConstraints,
  ExecutionGuardOptions,
  ToolExecutionProfile,
} from "./execution-guard.js";
export { SlidingWindowRateLimiter } from "./rate-limiter.js";
export type { RateLimitResult } from "./rate-limiter.js";

// 安全审计
export { SecurityAuditor } from "./security-auditor.js";
export type { AgentEventMapWithSecurity } from "./security-auditor.js";

// 安全管线
export { SecurityPipeline } from "./security-pipeline.js";
export type { SecurityPipelineOptions } from "./security-pipeline.js";
