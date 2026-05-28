/**
 * 安全系统类型定义
 *
 * 核心设计原则：
 * - 操作按影响范围分类，而非按工具限制
 * - 每条放行都追溯到用户选择（自动放行 = 低影响 或 用户规则）
 * - 平台无关：所有安全行为全平台一致
 *
 * 覆盖 SecurityRule、SecurityRequest、SecurityDecision、SecurityMiddleware、
 * PermissionRule、OperationClassifier 等安全子系统的全部类型与枚举。
 */

export type { TrustContext, TrustLevel } from "./trust.js";

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

// ─── 威胁边界 ───

/**
 * 威胁边界类型——需要被保护的资源类别。
 * 工具通过声明自己会跨越哪些边界来获得自动的安全保护。
 */
export type BoundaryType =
  | "filesystem"
  | "network"
  | "process"
  | "secrets"
  | "system"
  | "messaging"
  | "calendar"
  | "external-service"
  | "financial"
  | "agent-context"
  /** 知行应用本地状态（~/.zhixing 下 memory / schedule / skill 数据）：写=internal、读=observe */
  | "app-state";

/**
 * 工具声明的边界跨越。
 * 每个工具在定义时附带一组 BoundaryCrossing，描述它会触及哪些安全边界。
 */
export interface BoundaryCrossing {
  /** 被跨越的边界类型 */
  boundaryType: BoundaryType;
  /**
   * 访问模式——工具自由定义的字符串。
   * 常见值：read / write / exec / send / egress / query / list / create / delete / invite
   * 读类访问（read / list / query / view / fetch）由分类器识别为 observe。
   */
  access: string;
  /**
   * 是否需要运行时解析才能确定是否真正触发。
   * 静态边界（如 ReadTool 的 filesystem.read）始终生效；
   * 动态边界（如 BashTool 的 filesystem.write）需要解析命令内容才知道是否触发。
   */
  dynamic: boolean;
}

/**
 * 工具边界查询接口（read-only）。
 *
 * 消费者契约：将分类器与完整工具系统解耦——`BoundaryImpactClassifier` 只需知道
 * 某个工具声明了什么边界，不需要持有 ToolRegistry 完整引用。
 *
 * 注入到 `SecurityPipelineOptions.toolBoundaryRegistry` 时使用此 read-only 接口；
 * 拥有 registry 的 caller（cli 入口 / MCP 接入处）可改持 `MutableToolBoundaryRegistry`
 * 子接口以调用 register/unregister。LSP 安全：消费方对 mutable 能力无感知。
 */
export interface ToolBoundaryRegistry {
  getBoundaries(toolName: string): BoundaryCrossing[] | undefined;
}

/**
 * 工具边界注册表的可变子接口——caller 持有此类型以支持注册（含装配期补注册）。
 *
 * 设计目的（ADR-TPE-009）：让 caller 依赖**接口**而非具体类，未来 swap 实现
 * （如 immutable + observable / 远程同步等）零成本——只要新实现 implements
 * 同接口即可。当前唯一实现是 `BoundaryRegistry`。
 *
 * 用法：
 * - **静态启动**：`BoundaryRegistry.fromTools(tools)` 一次性 snapshot 所有工具边界
 * - **装配期补注册**：`registry.register(name, [...])`（如 Task 工具晚于 fromTools 装配）
 *
 * 注意：运行时动态增删工具（如 MCP 连接变更）走 reload 整体重建后重新 fromTools
 * snapshot，**不**走 in-place 增删——故本接口不提供 unregister。
 */
export interface MutableToolBoundaryRegistry extends ToolBoundaryRegistry {
  /**
   * 注册或覆盖单工具的边界声明。
   * - 重复注册同 toolName：覆盖旧声明
   * - **拒绝空数组**（fail-fast）：传入 `[]` 必须 throw。与
   *   `IToolArgumentExtractor.register` 拒空 key throw 对偶
   * - 工具名小写归一化；内部独立深拷贝防止 caller mutate 污染
   */
  register(toolName: string, boundaries: readonly BoundaryCrossing[]): void;
  /** 调试 / 可观测性：列出已注册的工具名（小写）。 */
  list(): string[];
}

/**
 * 工具参数提取器接口——`PermissionStore.match` 通过 `extractArgument` 函数式注入消费，
 * 但 caller 在持有 extractor 实例时使用此接口以支持注册（含装配期补注册）。
 *
 * 设计目的（ADR-TPE-009）：与 `MutableToolBoundaryRegistry` 对偶——caller 依赖接口
 * 而非具体类，未来 swap 实现零成本。当前唯一实现是 `ToolArgumentExtractor`。
 *
 * 函数式契约保留在 `PermissionStoreOptions.extractArgument: (req) => string`，
 * caller 用 `(req) => extractor.extract(req)` 桥接（store 端不感知本接口）。
 */
export interface IToolArgumentExtractor {
  /**
   * 从 SecurityRequest 提取用于权限匹配的 argument 字符串。
   * - 显式声明命中：取 `arguments[explicitKey]`
   * - 未命中或非 string：降级到内部 fallback（priority list + first-string）
   */
  extract(request: SecurityRequest): string;
  /** 注册或覆盖单工具的 argument key。空 / 非 string key throw。 */
  register(toolName: string, key: string): void;
  /** 调试 / 可观测性：列出已注册的工具名（小写）。 */
  list(): string[];
}

// ─── 操作分类器接口 ───

/**
 * 操作分类器——判断一个操作的影响范围。
 * 不做决策，只做分类：决策由管线根据分类结果 + 策略 + 权限综合得出。
 */
export interface OperationClassifier {
  classify(request: SecurityRequest): OperationClass;
}

// ─── 权限规则 ───

/**
 * 权限决策——用户的明确选择。
 * 不存在"自动积累的信任分数"，每一条规则都来自用户在确认对话框中的主动选择。
 */
export type PermissionDecision = "allow" | "deny";

/**
 * 权限规则的作用域。
 *
 * 三种**用户授权**作用域：
 * - session：本次会话有效（进程重启后消失，不落盘）
 * - workspace：当前工作区内有效，落盘到 ~/.zhixing/permissions/<workspace-hash>.json
 * - global：跨所有工作区有效，落盘到 ~/.zhixing/permissions/global.json
 *
 * 一种**系统预置**作用域：
 * - builtin：代码定义的默认规则（如未来 web_fetch 的 preapproved 域名 allow 列表），
 *   仅 in-memory，启动时由 `registerBuiltinRules` 注入，不落盘。匹配时严格让位
 *   于用户池（user 池任一命中 → 完全决定结果，builtin 池不参与；user 池空 →
 *   builtin 池接管），保证用户拥有最终决定权。
 *
 * 见 [tool-permission-execution.md §4.3](../../../../research/design/specifications/tool-permission-execution.md)
 * 与 ADR-TPE-002 / ADR-TPE-008。
 */
export type PermissionScope =
  | "session"
  | "workspace"
  | "global"
  | "builtin";

/**
 * 权限规则——用户创建的明确授权或拒绝。
 * 匹配通过 pattern.tool + pattern.argument 的 glob 匹配进行。
 */
export interface PermissionRule {
  id: string;
  /** 匹配模式：工具名 + 参数 glob */
  pattern: {
    /** 工具名（小写），或 "*" 表示任意工具 */
    tool: string;
    /** 参数 glob 模式，如 "npm install *"、"src/**"、"*" */
    argument: string;
  };
  decision: PermissionDecision;
  scope: PermissionScope;
  createdAt: number;
  /** 最近一次匹配时间；从未匹配为 0 */
  lastMatchedAt: number;
  /** 累计匹配次数 */
  matchCount: number;
  /**
   * 工作区路径（仅 workspace 作用域需要记录，便于 /trust list 展示）。
   * 实际定位规则使用 workspaceId（hash）。
   */
  workspace?: string;
  /**
   * 规则来源："user" = 用户显式创建 / 确认沉淀；"steward" = AI 安全管家放行沉淀。
   * 缺省视为 user。用于 /trust 区分展示与撤销 steward 自动沉淀的规则。
   */
  origin?: "user" | "steward";
}

/**
 * 权限规则存储接口。
 * 负责管理三种作用域的规则集合，提供匹配、创建、查询、撤销等操作。
 */
export interface IPermissionStore {
  /**
   * 查询匹配的权限规则。
   * 按 deny > allow、精确 > 宽泛 的顺序解决冲突。
   * @param workspaceId 当前工作区标识（null 表示无工作区上下文）
   * @param request 工具调用请求
   * @returns 最匹配的规则，或 null 表示无匹配
   */
  match(
    workspaceId: string | null,
    request: SecurityRequest,
  ): PermissionRule | null;

  /**
   * 创建一条规则。
   * - session 作用域：不落盘
   * - workspace 作用域：落盘到该工作区文件
   * - global 作用域：落盘到全局文件
   */
  create(workspaceId: string | null, rule: PermissionRule): void;

  /** 列出给定工作区可见的所有规则（session + 该工作区 + global） */
  list(workspaceId: string | null): PermissionRule[];

  /** 撤销某条规则。返回是否找到并撤销。 */
  revoke(ruleId: string): boolean;

  /** 清除给定工作区的所有规则（session + workspace 作用域，不影响 global） */
  reset(workspaceId: string | null): void;

  /** 清除全部规则（包括 global 和所有工作区）。不影响 builtin（boot-time 系统配置）。 */
  resetAll(): void;
}

/**
 * 注：`registerBuiltinRules(namespace, rules)` 是 `PermissionStore` 类的具体能力，
 * 不在 `IPermissionStore` 接口上——builtin 规则池是该实现的特定职责，不属于
 * "权限存储"通用契约（其他实现/mock 不必负担）。caller (cli run-agent) 持有
 * `new PermissionStore(...)` 具体类，能正常调用该方法。
 */

// ─── 匹配规格（判别联合） ───

export type MatchSpec =
  | { type: "command"; pattern: string; flags?: string }
  | { type: "command_prefix"; prefixes: string[] }
  | { type: "path"; paths: string[]; access: "read" | "write" | "any" }
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
    /** 信任上下文 —— 当前会话所处的用户授予信任范围（取代早期的裸 workspace 字段）。 */
    trust: import("./trust.js").TrustContext;
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
    /** bash/shell 命令的结构化分析（由 CommandAnalyzerMiddleware 填充） */
    commandAnalysis?: import("./command-analyzer.js").CommandAnalysis;
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
  /** 操作影响分类（由 OperationClassifierMiddleware 写入） */
  operationClass?: OperationClass;
  /** 信任等级（由 TrustClassifierMiddleware 写入） */
  trustLevel?: import("./trust.js").TrustLevel;
  /** 匹配到的权限规则（由 PermissionMatcherMiddleware 写入） */
  matchedPermissionRule?: PermissionRule;
  /** 执行约束（由 ExecutionGuardMiddleware 写入） */
  executionConstraints?: import("./execution-guard.js").ExecutionConstraints;
  resolvedPaths?: string[];
  [key: string]: unknown;
}

/** 安全中间件的执行结果 */
export interface SecurityMiddlewareResult {
  /**
   * 是否允许继续执行（block 时为 false）。
   * 注意：allowed=true 但 requiresConfirmation=true 时仍需用户确认才能放行。
   */
  allowed: boolean;
  /** 是否需要用户确认（external/critical 或策略规则 confirm 动作） */
  requiresConfirmation?: boolean;
  /** 操作影响分类 */
  operationClass?: OperationClass;
  /** 信任等级（当前会话上下文的有效信任级） */
  trustLevel?: import("./trust.js").TrustLevel;
  /** 最终安全决策（包含所有匹配规则、风险等级） */
  decision?: SecurityDecision;
  /** 匹配到的权限规则（若有） */
  matchedPermissionRule?: PermissionRule;
  /** 执行约束（timeout / output limit / rate limit 状态） */
  executionConstraints?: import("./execution-guard.js").ExecutionConstraints;
  /** 原因说明 */
  reason?: string;
  /** 规范化后的路径（realpath，由 PathResolveMiddleware 提供） */
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
    operationClass?: OperationClass;
  };

  /** 操作被分类——按影响范围归类 */
  "security:classified": {
    tool: string;
    operation: string;
    operationClass: OperationClass;
  };

  /** 匹配到用户权限规则 */
  "security:permission_matched": {
    tool: string;
    operation: string;
    ruleId: string;
    decision: PermissionDecision;
    scope: PermissionScope;
  };

  /** 操作被阻止 */
  "security:blocked": {
    tool: string;
    operation: string;
    reason: string;
    riskLevel: RiskLevel;
    matchedRules: string[];
  };

  /** 路径规范化 */
  "security:path_resolved": {
    originalPath: string;
    resolvedPath: string;
    withinWorkspace: boolean;
  };

  /** AI 安全管家对灰色 external 操作的三态研判裁决 */
  "security:steward_review": {
    tool: string;
    operation: string;
    decision: "safe" | "needs-confirm" | "escalate";
    reason: string;
    confidence: number;
  };
};
