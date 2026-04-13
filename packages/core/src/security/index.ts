// Security — 安全系统模块的公开 API

// 类型导出
export type {
  IPolicyEngine,
  MatchSpec,
  OperationClass,
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
} from "./types.js";

// 策略引擎
export { PolicyEngine } from "./policy-engine.js";

// 内置规则
export { BUILTIN_RULES } from "./builtin-rules.js";

// 执行守卫
export { EnvSanitize } from "./env-sanitize.js";
export { PathGuard } from "./path-guard.js";

// 安全审计
export { SecurityAuditor } from "./security-auditor.js";
export type { AgentEventMapWithSecurity } from "./security-auditor.js";

// 安全管线
export { SecurityPipeline } from "./security-pipeline.js";
export type { SecurityPipelineOptions } from "./security-pipeline.js";
