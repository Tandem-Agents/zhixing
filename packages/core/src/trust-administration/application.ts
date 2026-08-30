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
  | { readonly kind: "workspace"; readonly hash: string }
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

/** Security persistence projection accepted only by the temporary bridge. */
export interface TrustAdministrationRepositoryRule
  extends TrustAdministrationRuleRecord<
    "session" | "context" | "global" | "builtin"
  > {}

export type TrustAdministrationQuery = {
  readonly kind: "list";
  readonly conversationId?: string;
};

export type TrustAdministrationCommand = {
  readonly kind: "revoke";
  readonly ruleId: string;
  readonly conversationId?: string;
};

export interface TrustAdministrationRuleView {
  readonly rules: readonly TrustAdministrationRule[];
}

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

/**
 * Temporary A5-TRUST-STORE-01 bridge. The adapter may translate this finite
 * domain projection to the existing Security persistence mechanism, but it cannot
 * decide visibility, management context, or not-found semantics.
 */
export interface TrustAdministrationRepository {
  list(
    context: TrustAdministrationContext,
  ): Promise<readonly TrustAdministrationRepositoryRule[]>;
  revoke(context: TrustAdministrationContext, ruleId: string): Promise<boolean>;
}

export interface TrustAdministrationApplicationOptions {
  readonly repository: TrustAdministrationRepository;
  readonly defaultContext: () => TrustAdministrationContext;
}

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
    return Object.freeze({
      rules: Object.freeze(
        rules
          .filter(isManageableTrustAdministrationRule)
          .map(freezeTrustAdministrationRule),
      ),
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
    const context = this.#contextFor(command.conversationId);
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
