/**
 * 安全系统类型定义
 *
 * 核心设计原则：
 * - 操作按影响范围分类，而非按工具限制
 * - 每条放行都追溯到用户选择（自动放行 = 低影响 或 用户规则）
 * - 平台无关：所有安全行为全平台一致
 *
 * Phase 1 类型覆盖：SecurityRule、SecurityRequest、SecurityDecision、
 * SecurityMiddleware 以及所有基础枚举类型。
 * Phase 2+ 的类型（PermissionRule、OperationClassifier 等）在后续迭代中追加。
 */

// ─── 会话类型 ───

/** 会话模式决定了无匹配规则时的默认行为 */
export type SessionType = "interactive" | "ci" | "gateway" | "api";

// ─── 威胁分类 ───

export type ThreatCategory =
  | "data_exfiltration"
  | "privilege_escalation"
  | "code_injection"
  | "path_traversal"
  | "env_manipulation"
  | "network_abuse"
  | "destructive_operation"
  | "prompt_injection"
  | "supply_chain";

// ─── 风险等级 ───

export type RiskLevel = "low" | "medium" | "high" | "critical";

// ─── 安全决策动作 ───

export type SecurityAction = "allow" | "confirm" | "block";

// ─── 规则动作（策略规则使用的三种动作） ───

export type RuleAction = "block" | "confirm" | "audit";

// ─── 操作影响分类 ───

export type OperationClass = "observe" | "internal" | "external" | "critical";

// ─── 匹配规格（判别联合） ───

export type MatchSpec =
  | { type: "command"; pattern: string; flags?: string }
  | { type: "command_prefix"; prefixes: string[] }
  | { type: "path"; paths: string[]; access: "read" | "write" | "any" }
  | { type: "path_outside"; anchor: string }
  | {
      type: "network";
      hosts?: string[];
      ports?: number[];
      direction?: "inbound" | "outbound";
    }
  | { type: "env_var"; names: string[] }
  | { type: "tool"; tools: string[] }
  | { type: "interpreter"; languages: string[] }
  | { type: "composite"; op: "and" | "or" | "not"; specs: MatchSpec[] };

// ─── 安全规则 ───

export interface SecurityRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;

  match: MatchSpec;

  action: RuleAction;
  /**
   * bypassImmune 规则不可被任何配置覆盖，包括权限规则。
   * 用于绝对保护（如 .git/、~/.ssh/、LD_PRELOAD）
   */
  bypassImmune: boolean;

  severity: RiskLevel;
  category: ThreatCategory;
  source: "builtin" | "project" | "user" | "community";

  message: string;
  suggestion?: string;
}

// ─── 安全请求 ───

/**
 * 工具调用触发的安全评估请求。
 * 由 SecurityMiddleware 构造并传递给 PolicyEngine。
 */
export interface SecurityRequest {
  /** 工具名称 */
  tool: string;
  /** 工具的原始输入参数 */
  arguments: Record<string, unknown>;
  context: {
    /** 当前工作目录 */
    cwd: string;
    /** 工作区目录（用户指定的工作目录，null 表示无工作区上下文） */
    workspace: string | null;
    /** 会话类型 */
    sessionType: SessionType;
  };
  /**
   * 解析后的访问描述——从工具参数中提取的路径、命令、主机等。
   * 由各类解析器填充，策略引擎用于匹配规则。
   */
  resolvedAccess?: {
    paths?: string[];
    commands?: string[];
    hosts?: string[];
    envVars?: string[];
  };
}

// ─── 安全决策 ───

export interface SecurityDecision {
  action: SecurityAction;
  matchedRules: SecurityRule[];
  reason: string;
  riskLevel: RiskLevel;
  suggestion?: string;
}

// ─── 策略引擎接口 ───

export interface IPolicyEngine {
  evaluate(request: SecurityRequest): SecurityDecision;
  loadRules(rules: SecurityRule[]): void;
  getActiveRules(): SecurityRule[];
}

// ─── 安全中间件 ───

/**
 * 安全中间件接口。
 * 遵循 ADR-004 工具执行管线设计，在工具执行前/后插入安全检查。
 */
export interface SecurityMiddleware {
  /** 中间件名称（用于日志和调试） */
  name: string;
  /** 执行阶段 */
  phase: "authorize" | "guard" | "post-execute";
  /** 同阶段内的执行顺序（数字小的先执行） */
  order: number;
  /** 执行中间件逻辑 */
  execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult>;
}

/**
 * 安全中间件的执行上下文。
 * 提供工具调用信息、安全请求和共享状态给各中间件使用。
 */
export interface SecurityMiddlewareContext {
  /** 安全评估请求 */
  request: SecurityRequest;
  /** 工具名称 */
  toolName: string;
  /** 工具输入参数 */
  toolInput: Record<string, unknown>;
  /** 工作目录 */
  workingDirectory: string;
  /**
   * 共享状态——中间件之间传递数据。
   * 例如：PolicyEvaluator 的决策结果可以被后续中间件读取。
   */
  state: SecurityMiddlewareState;
}

export interface SecurityMiddlewareState {
  decision?: SecurityDecision;
  sanitizedEnv?: Record<string, string | undefined>;
  resolvedPaths?: string[];
  [key: string]: unknown;
}

/** 安全中间件的执行结果 */
export interface SecurityMiddlewareResult {
  /** 是否允许继续执行 */
  allowed: boolean;
  /** 原因说明 */
  reason?: string;
  /** 修改后的环境变量（由 EnvSanitize 提供） */
  sanitizedEnv?: Record<string, string | undefined>;
  /** 规范化后的路径（由 PathGuard 提供） */
  resolvedPaths?: string[];
}

// ─── 安全事件（扩展 AgentEventMap） ───

/**
 * 安全子系统发射的事件类型。
 * 这些事件通过 EventBus 传播，用于审计日志和可观测性。
 */
export type SecurityEventMap = {
  /** 策略评估结果 */
  "security:evaluation": {
    tool: string;
    operation: string;
    riskLevel: RiskLevel;
    decision: SecurityAction;
    matchedRules: string[];
    duration: number;
  };

  /** 操作被阻止 */
  "security:blocked": {
    tool: string;
    operation: string;
    reason: string;
    riskLevel: RiskLevel;
    matchedRules: string[];
  };

  /** 环境变量被净化 */
  "security:env_sanitized": {
    removedVars: string[];
    tool: string;
  };

  /** 路径规范化 */
  "security:path_resolved": {
    originalPath: string;
    resolvedPath: string;
    withinWorkspace: boolean;
  };
};
