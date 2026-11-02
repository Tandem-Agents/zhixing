import { parseConversationId } from "../conversation/scope-id.js";
import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiFactEvent,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";

/** Trust Administration's own stable context identity. */
export type TrustAdministrationContext =
  | { readonly kind: "main" }
  | { readonly kind: "workspace"; readonly hash: string; readonly revision?: number }
  | { readonly kind: "scene"; readonly sceneId: string };

export interface TrustAdministrationContribution {
  readonly origin: "user" | "steward";
  readonly timestamp: number;
}

/**
 * Stable management projection. It deliberately does not reuse Security's
 * execution or persistence contracts.
 */
interface TrustAdministrationRuleRecord<Scope extends string> {
  readonly id: string;
  readonly pattern: {
    readonly tool: string;
    readonly argument: string;
  };
  readonly decision: "allow" | "deny";
  readonly scope: Scope;
  readonly createdAt: number;
  readonly lastMatchedAt: number;
  readonly matchCount: number;
  readonly contextId?: TrustAdministrationContext;
  readonly contextPath?: string;
  readonly contributors?: readonly TrustAdministrationContribution[];
}

export interface TrustAdministrationRule
  extends TrustAdministrationRuleRecord<"context" | "global"> {}

/** Finite persistence projection shared with the final Security mechanism adapter. */
export interface TrustAdministrationRepositoryRule
  extends TrustAdministrationRuleRecord<
    "session" | "context" | "global" | "builtin"
  > {}

export type TrustAdministrationQuery = {
  readonly kind: "list";
  readonly conversationId?: string;
  /** 同时按页列出当前范围以外的其他范围（显式工作区、已失效工作区、旧格式等）。 */
  readonly otherScopes?: { readonly after?: string; readonly limit?: number };
};

export type TrustAdministrationCommand = {
  readonly kind: "revoke";
  readonly ruleId: string;
  readonly conversationId?: string;
  /** 规则所在的其他范围（取自列表结果的分组）；不传为当前对话的范围。 */
  readonly context?: TrustAdministrationContext;
};

export interface TrustAdministrationScopeGroup {
  readonly context: TrustAdministrationContext;
  readonly label: string;
  /** false：该范围不再对任何运行生效（目录已变更、已移除或旧格式），规则只供撤销。 */
  readonly effective: boolean;
  readonly note?: string;
  readonly rules: readonly TrustAdministrationRule[];
}

export interface TrustAdministrationRuleView {
  readonly rules: readonly TrustAdministrationRule[];
  readonly otherScopes?: {
    readonly groups: readonly TrustAdministrationScopeGroup[];
    /** 下一页游标；没有更多时缺省。 */
    readonly next?: string;
  };
}

/** 范围的展示描述（名称与是否仍对运行生效），由宿主按本机登记给出。 */
export type TrustAdministrationScopeDescriber = (
  context: TrustAdministrationContext,
  rules: readonly TrustAdministrationRule[],
) => Promise<{ readonly label: string; readonly effective: boolean; readonly note?: string }>;

export interface TrustAdministrationRuleRevokedFact {
  readonly kind: "trust-administration-rule-revoked";
  readonly ruleId: string;
}

export interface TrustAdministrationCommandResult {
  readonly revoked: true;
  readonly fact: TrustAdministrationRuleRevokedFact;
}

export interface TrustAdministrationApplication {
  query(query: TrustAdministrationQuery): Promise<TrustAdministrationRuleView>;
  execute(command: TrustAdministrationCommand): Promise<TrustAdministrationCommandResult>;
}

/** Persistence mechanism port; management visibility and semantics stay here. */
export interface TrustAdministrationRepository {
  list(
    context: TrustAdministrationContext,
  ): Promise<readonly TrustAdministrationRepositoryRule[]>;
  revoke(context: TrustAdministrationContext, ruleId: string): Promise<boolean>;
  /** 按页列出有落盘规则的范围（只按范围身份排序分页，不读规则以外的数据）。 */
  listScopes?(input: { readonly after?: string; readonly limit: number }): Promise<{
    readonly scopes: readonly {
      readonly cursor: string;
      readonly context: TrustAdministrationContext;
      readonly rules: readonly TrustAdministrationRepositoryRule[];
    }[];
    readonly next?: string;
  }>;
}

export interface TrustAdministrationApplicationOptions {
  readonly repository: TrustAdministrationRepository;
  readonly defaultContext: () => TrustAdministrationContext;
  readonly describeScope?: TrustAdministrationScopeDescriber;
}

export {
  TrustAdministrationExecutionApplicationService,
  suggestTrustAdministrationPatterns,
  trustSedimentIsConsistent,
} from "./execution.js";
export { conversationRunTrustScope, jobRunTrustScopeInput, resolveExecutionTrustScope, workspaceTrustIdentity } from "./scope.js";
export type { ExecutionTrustScopeInput } from "./scope.js";
export type {
  TrustAdministrationApproval,
  TrustAdministrationApprovalResult,
  TrustAdministrationExecutionApplication,
  TrustAdministrationExecutionApplicationOptions,
  TrustAdministrationExecutionRepository,
  TrustAdministrationExecutionSnapshot,
  TrustAdministrationObservation,
  TrustAdministrationOperation,
  TrustAdministrationRiskLevel,
  TrustAdministrationSuggestedPattern,
  TrustSedimentSubmission,
  TrustSedimentSubmissionPort,
  TrustSedimentSubmissionResult,
} from "./execution.js";

export type TrustAdministrationApplicationErrorCode =
  | "invalid-command"
  | "not-found";

export class TrustAdministrationApplicationError extends Error {
  constructor(
    readonly code: TrustAdministrationApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TrustAdministrationApplicationError";
  }
}

/** The sole application owner for user-manageable trust rules. */
export class TrustAdministrationApplicationService
  implements TrustAdministrationApplication
{
  constructor(private readonly options: TrustAdministrationApplicationOptions) {}

  async query(query: TrustAdministrationQuery): Promise<TrustAdministrationRuleView> {
    if (query.kind !== "list") {
      throw new TrustAdministrationApplicationError(
        "invalid-command",
        "Unsupported Trust Administration query",
      );
    }
    const context = this.#contextFor(query.conversationId);
    const rules = await this.options.repository.list(context);
    const otherScopes = query.otherScopes && this.options.repository.listScopes
      ? await this.#otherScopes(context, query.otherScopes)
      : undefined;
    return Object.freeze({
      rules: Object.freeze(
        rules
          .filter(isManageableTrustAdministrationRule)
          .map(freezeTrustAdministrationRule),
      ),
      ...(otherScopes ? { otherScopes } : {}),
    });
  }

  /** 当前范围以外、有可管规则的范围，按页给出；全局规则已在当前列表里，不重复。 */
  async #otherScopes(
    current: TrustAdministrationContext,
    page: NonNullable<TrustAdministrationQuery["otherScopes"]>,
  ): Promise<NonNullable<TrustAdministrationRuleView["otherScopes"]>> {
    const limit = Math.max(1, Math.min(50, Math.trunc(page.limit ?? 20)));
    const listed = await this.options.repository.listScopes!({
      ...(page.after ? { after: page.after } : {}),
      limit,
    });
    const groups: TrustAdministrationScopeGroup[] = [];
    for (const scope of listed.scopes) {
      const context = freezeTrustAdministrationContext(scope.context);
      if (sameScopeIdentity(context, current)) continue;
      const rules = scope.rules
        .filter(isManageableTrustAdministrationRule)
        .filter((rule) => rule.scope === "context")
        .map(freezeTrustAdministrationRule);
      if (rules.length === 0) continue;
      const described = await this.options.describeScope?.(context, rules)
        .catch(() => undefined) ?? { label: defaultScopeLabel(context), effective: true };
      groups.push(Object.freeze({
        context,
        label: described.label,
        effective: described.effective,
        ...(described.note ? { note: described.note } : {}),
        rules: Object.freeze(rules),
      }));
    }
    return Object.freeze({
      groups: Object.freeze(groups),
      ...(listed.next ? { next: listed.next } : {}),
    });
  }

  async execute(
    command: TrustAdministrationCommand,
  ): Promise<TrustAdministrationCommandResult> {
    if (command.kind !== "revoke") {
      throw new TrustAdministrationApplicationError(
        "invalid-command",
        "Unsupported Trust Administration command",
      );
    }
    const ruleId = requireNonEmpty(command.ruleId, "Trust rule id");
    // 其他范围的撤销同样先核该范围下可见（与列表同一可管口径），不扩大可撤销的规则
    const context = command.context
      ? freezeTrustAdministrationContext(command.context)
      : this.#contextFor(command.conversationId);
    const visible = await this.options.repository.list(context);
    if (
      !visible.some(
        (rule) => rule.id === ruleId && isManageableTrustAdministrationRule(rule),
      )
    ) {
      throw notFound(ruleId);
    }
    if (!(await this.options.repository.revoke(context, ruleId))) {
      throw notFound(ruleId);
    }
    const fact = Object.freeze({
      kind: "trust-administration-rule-revoked" as const,
      ruleId,
    });
    return Object.freeze({ revoked: true as const, fact });
  }

  #contextFor(conversationId: string | undefined): TrustAdministrationContext {
    if (conversationId !== undefined) {
      const id = requireNonEmpty(conversationId, "Conversation id");
      const { scope } = parseConversationId(id);
      if (scope.kind === "workscene") {
        return Object.freeze({ kind: "scene", sceneId: scope.sceneId });
      }
    }
    return freezeTrustAdministrationContext(this.options.defaultContext());
  }
}

export const TRUST_ADMINISTRATION_RULE_REVOKED_FACT_EVENT =
  defineProductApiFactEvent<
    "trust-administration-rule-revoked",
    TrustAdministrationRuleRevokedFact
  >("trust-administration-rule-revoked");

export const TRUST_ADMINISTRATION_LIST_QUERY = defineProductApiQuery<
  "trust-administration.query.list",
  TrustAdministrationQuery,
  TrustAdministrationRuleView
>("trust-administration.query.list");

export const TRUST_ADMINISTRATION_REVOKE_COMMAND = defineProductApiCommand<
  "trust-administration.command.revoke",
  TrustAdministrationCommand,
  TrustAdministrationCommandResult,
  TrustAdministrationRuleRevokedFact
>("trust-administration.command.revoke", [
  TRUST_ADMINISTRATION_RULE_REVOKED_FACT_EVENT,
]);

export const TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET =
  defineProductApiExactSet({
    operations: [
      TRUST_ADMINISTRATION_LIST_QUERY,
      TRUST_ADMINISTRATION_REVOKE_COMMAND,
    ],
    factEvents: [TRUST_ADMINISTRATION_RULE_REVOKED_FACT_EVENT],
  });

export function createTrustAdministrationProductApiContribution(
  application: TrustAdministrationApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(TRUST_ADMINISTRATION_LIST_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(
        TRUST_ADMINISTRATION_REVOKE_COMMAND,
        async (command) => {
          const result = await application.execute(command);
          return { result, facts: [result.fact] };
        },
      ),
    ],
    factEvents: [TRUST_ADMINISTRATION_RULE_REVOKED_FACT_EVENT],
  });
}

function notFound(ruleId: string): TrustAdministrationApplicationError {
  return new TrustAdministrationApplicationError(
    "not-found",
    `Trust rule not found: ${ruleId}`,
  );
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TrustAdministrationApplicationError(
      "invalid-command",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

/** 同一范围身份（工作区按绑定身份，不看修订）。 */
function sameScopeIdentity(left: TrustAdministrationContext, right: TrustAdministrationContext): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "workspace" && right.kind === "workspace") return left.hash === right.hash;
  if (left.kind === "scene" && right.kind === "scene") return left.sceneId === right.sceneId;
  return true;
}

function defaultScopeLabel(context: TrustAdministrationContext): string {
  switch (context.kind) {
    case "main":
      return "主模式";
    case "scene":
      return `工作场景 ${context.sceneId}`;
    case "workspace":
      return `工作区 ${context.hash.slice(0, 8)}`;
  }
}

function freezeTrustAdministrationContext(
  context: TrustAdministrationContext,
): TrustAdministrationContext {
  switch (context.kind) {
    case "main":
      return Object.freeze({ kind: "main" });
    case "workspace":
      return Object.freeze({
        kind: "workspace",
        hash: requireNonEmpty(context.hash, "Workspace identity"),
        ...(context.revision === undefined ? {} : { revision: context.revision }),
      });
    case "scene":
      return Object.freeze({
        kind: "scene",
        sceneId: requireNonEmpty(context.sceneId, "Scene identity"),
      });
  }
}

function freezeTrustAdministrationRule(
  rule: TrustAdministrationRule,
): TrustAdministrationRule {
  const contextId = rule.contextId
    ? freezeTrustAdministrationContext(rule.contextId)
    : undefined;
  const contributors = rule.contributors
    ? Object.freeze(
        rule.contributors.map((contribution) =>
          Object.freeze({
            origin: contribution.origin,
            timestamp: contribution.timestamp,
          }),
        ),
      )
    : undefined;
  return Object.freeze({
    id: rule.id,
    pattern: Object.freeze({ ...rule.pattern }),
    decision: rule.decision,
    scope: rule.scope,
    createdAt: rule.createdAt,
    lastMatchedAt: rule.lastMatchedAt,
    matchCount: rule.matchCount,
    ...(contextId ? { contextId } : {}),
    ...(rule.contextPath === undefined ? {} : { contextPath: rule.contextPath }),
    ...(contributors ? { contributors } : {}),
  });
}

function isManageableTrustAdministrationRule(
  rule: TrustAdministrationRepositoryRule,
): rule is TrustAdministrationRule {
  return rule.scope === "context" || rule.scope === "global";
}
