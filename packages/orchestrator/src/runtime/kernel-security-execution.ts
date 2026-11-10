import type { SuggestedPattern } from "@zhixing/core/confirmation";
import type {
  PermissionContextId,
  PermissionRule,
  PermissionRuleExecutionSource,
  RiskLevel,
  SecurityRequest,
  TrustContext,
} from "@zhixing/core/security";
import type { KernelToolPermissionRuleSet } from "./kernel-tool-implementation.js";

export type KernelSecurityApproval =
  | {
      readonly kind: "allow-once";
      readonly operation: {
        readonly tool: string;
        readonly arguments: Readonly<Record<string, unknown>>;
      };
      readonly riskLevel: RiskLevel;
      readonly origin: "user" | "steward";
      readonly bypassImmune: boolean;
      /** 用户批准所来自的确认请求（规则权威接纳沉淀时据此核对）。 */
      readonly requestId?: string;
    }
  | {
      readonly kind: "allow-session";
      readonly pattern: SuggestedPattern;
    }
  | {
      readonly kind: "allow-context" | "allow-global";
      readonly pattern: SuggestedPattern;
      /** 产生该决定的确认请求；显式持久批准的效果按它在决定生命周期上定位。 */
      readonly requestId: string;
    };

export type KernelSecurityApprovalResult =
  | { readonly kind: "recorded" }
  | {
      readonly kind: "rule-created" | "rule-sedimented";
      readonly rule: PermissionRule;
    };

/** Finite approval effect inherited by every execution in one runtime tree. */
export interface KernelSecurityApprovalPort {
  readonly contextId: PermissionContextId;
  /**
   * 本运行的答复路径是否支持显式持久批准（始终允许）。false 时确认不提供这些选项，
   * 端口收到也拒绝，不当成仅本次。
   */
  readonly persistentApprovals: boolean;
  /** 落盘规则在耐久写完成后才算记录成功；写失败时拒绝。 */
  recordApproval(approval: KernelSecurityApproval): Promise<KernelSecurityApprovalResult>;
  /**
   * 安全评价选出一条持久用户规则（context/global）时记一次匹配，交规则权威累计；不改变
   * 授权结论。规则命中计数的唯一生产入口；未装配时不计。
   */
  recordRuleHit?(hit: { readonly ruleId: string; readonly scope: "context" | "global" }): Promise<void>;
}

export interface KernelSecurityUserSnapshot {
  readonly contextId: PermissionContextId;
  readonly workspacePath: string | null;
  readonly permissionRules: readonly PermissionRule[];
  readonly confirmations: readonly {
    readonly key: string;
    readonly count: number;
    readonly highestRisk: RiskLevel;
  }[];
}

/**
 * One runtime-scoped Security/Confirmation binding.
 *
 * Product context and Trust application construction are already complete when
 * this value crosses the Kernel boundary. No repository, Store, path policy or
 * product identity is exposed here.
 */
export interface KernelSecurityExecution extends KernelSecurityApprovalPort {
  readonly trustContext: TrustContext;
  readonly permissionRuleSource: PermissionRuleExecutionSource;
  securitySnapshot(): KernelSecurityUserSnapshot;
  /**
   * 派发用的完整执行快照（内置＋会话＋范围持久＋全局）。传入范围时按该运行的范围
   * 组合（owner 在派发时用），不传时按本绑定自己的范围。
   */
  executionPermissionRules(scope?: PermissionContextId): readonly PermissionRule[];
}

/** Finite mechanism inputs discovered while the Kernel assembles its tool set. */
export interface KernelSecurityExecutionRequest {
  readonly extractArgument: (request: SecurityRequest) => string;
  readonly builtinRuleSets: readonly KernelToolPermissionRuleSet[];
  readonly workspacePath: string | null;
}

/** Product-bound Host adapter for one runtime's Security execution mechanism. */
export interface KernelSecurityExecutionFactory {
  readonly create: (
    request: KernelSecurityExecutionRequest,
  ) => KernelSecurityExecution;
}

export function assembleKernelSecurityExecution(
  factory: KernelSecurityExecutionFactory,
  request: KernelSecurityExecutionRequest,
): KernelSecurityExecution {
  if (
    !factory ||
    !Object.isFrozen(factory) ||
    typeof factory.create !== "function"
  ) {
    throw new TypeError("Kernel Security execution factory must be frozen");
  }
  if (
    !request ||
    !Object.isFrozen(request) ||
    typeof request.extractArgument !== "function" ||
    !Object.isFrozen(request.builtinRuleSets) ||
    (request.workspacePath !== null &&
      typeof request.workspacePath !== "string")
  ) {
    throw new TypeError("Kernel Security execution request must be finite and immutable");
  }
  const execution = factory.create(request);
  if (
    !execution ||
    !Object.isFrozen(execution) ||
    !execution.contextId ||
    !Object.isFrozen(execution.contextId) ||
    !execution.trustContext ||
    !Object.isFrozen(execution.trustContext) ||
    !execution.permissionRuleSource ||
    !Object.isFrozen(execution.permissionRuleSource) ||
    typeof execution.permissionRuleSource.match !== "function" ||
    typeof execution.permissionRuleSource.matchFrozen !== "function" ||
    typeof execution.recordApproval !== "function" ||
    (execution.recordRuleHit !== undefined && typeof execution.recordRuleHit !== "function") ||
    typeof execution.persistentApprovals !== "boolean" ||
    typeof execution.securitySnapshot !== "function" ||
    typeof execution.executionPermissionRules !== "function"
  ) {
    throw new TypeError("Kernel Security execution binding is incomplete");
  }
  return execution;
}
