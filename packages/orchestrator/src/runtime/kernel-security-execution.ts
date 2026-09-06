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
    }
  | {
      readonly kind: "allow-session" | "allow-context" | "allow-global";
      readonly pattern: SuggestedPattern;
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
  recordApproval(approval: KernelSecurityApproval): KernelSecurityApprovalResult;
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
  executionPermissionRules(): readonly PermissionRule[];
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
    typeof execution.securitySnapshot !== "function" ||
    typeof execution.executionPermissionRules !== "function"
  ) {
    throw new TypeError("Kernel Security execution binding is incomplete");
  }
  return execution;
}
