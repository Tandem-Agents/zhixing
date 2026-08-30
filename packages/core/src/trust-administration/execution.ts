import { randomUUID } from "node:crypto";
import type {
  TrustAdministrationContext,
  TrustAdministrationContribution,
  TrustAdministrationRepositoryRule,
} from "./application.js";

export type TrustAdministrationRiskLevel =
  | "low"
  | "medium"
  | "high"
  | "critical";

export interface TrustAdministrationOperation {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface TrustAdministrationSuggestedPattern {
  readonly pattern: {
    readonly tool: string;
    readonly argument: string;
  };
  readonly label: string;
}

export interface TrustAdministrationObservation {
  readonly key: string;
  readonly count: number;
  readonly highestRisk: TrustAdministrationRiskLevel;
}

export interface TrustAdministrationExecutionSnapshot {
  readonly context: TrustAdministrationContext;
  readonly workspacePath: string | null;
  readonly userRules: readonly TrustAdministrationRepositoryRule[];
  readonly observations: readonly TrustAdministrationObservation[];
}

export type TrustAdministrationApproval =
  | {
      readonly kind: "allow-once";
      readonly operation: TrustAdministrationOperation;
      readonly riskLevel: TrustAdministrationRiskLevel;
      readonly origin: TrustAdministrationContribution["origin"];
      readonly bypassImmune: boolean;
    }
  | {
      readonly kind: "allow-session" | "allow-context" | "allow-global";
      readonly pattern: TrustAdministrationSuggestedPattern;
    };

export type TrustAdministrationApprovalResult =
  | { readonly kind: "recorded" }
  | {
      readonly kind: "rule-created";
      readonly rule: TrustAdministrationRepositoryRule;
    }
  | {
      readonly kind: "rule-sedimented";
      readonly rule: TrustAdministrationRepositoryRule;
    };

/**
 * Final mechanism boundary for runtime rule storage. Implementations translate
 * the domain projection to an existing store; they do not select scope,
 * identity, metadata, thresholds, or sedimentation outcomes.
 */
export interface TrustAdministrationExecutionRepository {
  workspaceIdentity(workspacePath: string): string;
  listExecutionRules(
    context: TrustAdministrationContext,
  ): readonly TrustAdministrationRepositoryRule[];
  snapshotExecutionRules(
    context: TrustAdministrationContext,
  ): readonly TrustAdministrationRepositoryRule[];
  createExecutionRule(
    context: TrustAdministrationContext,
    rule: TrustAdministrationRepositoryRule,
  ): void;
}

export interface TrustAdministrationExecutionApplication {
  readonly context: TrustAdministrationContext;
  suggest(
    operation: TrustAdministrationOperation,
  ): readonly TrustAdministrationSuggestedPattern[];
  recordApproval(
    approval: TrustAdministrationApproval,
  ): TrustAdministrationApprovalResult;
  securitySnapshot(): TrustAdministrationExecutionSnapshot;
  executionRules(): readonly TrustAdministrationRepositoryRule[];
}

export interface TrustAdministrationExecutionApplicationOptions {
  readonly repository: TrustAdministrationExecutionRepository;
  readonly sceneId?: string;
  readonly workspacePath?: string | null;
  readonly now?: () => number;
  readonly createRuleId?: () => string;
}

const SUGGESTION_THRESHOLDS: Readonly<
  Record<TrustAdministrationRiskLevel, number>
> = Object.freeze({
  low: 3,
  medium: 3,
  high: 10,
  critical: -1,
});

const RISK_ORDER: Readonly<Record<TrustAdministrationRiskLevel, number>> =
  Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

interface ObservationEntry {
  readonly contributors: TrustAdministrationContribution[];
  highestRisk: TrustAdministrationRiskLevel;
}

/** Sole runtime application owner for explicit and sedimented user trust. */
export class TrustAdministrationExecutionApplicationService
  implements TrustAdministrationExecutionApplication
{
  readonly context: TrustAdministrationContext;

  readonly #repository: TrustAdministrationExecutionRepository;
  readonly #workspacePath: string | null;
  readonly #now: () => number;
  readonly #createRuleId: () => string;
  readonly #observations = new Map<string, ObservationEntry>();

  constructor(options: TrustAdministrationExecutionApplicationOptions) {
    this.#repository = options.repository;
    this.#workspacePath = options.workspacePath ?? null;
    this.#now = options.now ?? (() => Date.now());
    this.#createRuleId = options.createRuleId ?? randomUUID;
    this.context = freezeExecutionContext(
      options.sceneId,
      this.#workspacePath,
      this.#repository,
    );
  }

  suggest(
    operation: TrustAdministrationOperation,
  ): readonly TrustAdministrationSuggestedPattern[] {
    return suggestTrustAdministrationPatterns(operation);
  }

  recordApproval(
    approval: TrustAdministrationApproval,
  ): TrustAdministrationApprovalResult {
    switch (approval.kind) {
      case "allow-once":
        return this.#recordContribution(approval);
      case "allow-session":
      case "allow-context":
      case "allow-global": {
        const rule = this.#createExplicitRule(approval.kind, approval.pattern);
        this.#repository.createExecutionRule(this.context, rule);
        return Object.freeze({ kind: "rule-created" as const, rule });
      }
    }
  }

  securitySnapshot(): TrustAdministrationExecutionSnapshot {
    return Object.freeze({
      context: freezeContext(this.context),
      workspacePath:
        this.context.kind === "workspace" ? this.#workspacePath : null,
      userRules: freezeRules(this.#repository.listExecutionRules(this.context)),
      observations: Object.freeze(
        [...this.#observations.entries()].map(([key, entry]) =>
          Object.freeze({
            key,
            count: entry.contributors.length,
            highestRisk: entry.highestRisk,
          }),
        ),
      ),
    });
  }

  executionRules(): readonly TrustAdministrationRepositoryRule[] {
    return freezeRules(this.#repository.snapshotExecutionRules(this.context));
  }

  #recordContribution(
    approval: Extract<TrustAdministrationApproval, { readonly kind: "allow-once" }>,
  ): TrustAdministrationApprovalResult {
    if (approval.bypassImmune) return Object.freeze({ kind: "recorded" });
    const representative = selectRepresentativePattern(
      suggestTrustAdministrationPatterns(approval.operation),
    );
    if (!representative) return Object.freeze({ kind: "recorded" });

    const key = `${representative.pattern.tool}::${representative.pattern.argument}`;
    const contribution = Object.freeze({
      origin: approval.origin,
      timestamp: this.#now(),
    });
    const existing = this.#observations.get(key);
    if (existing) {
      existing.contributors.push(contribution);
      if (RISK_ORDER[approval.riskLevel] > RISK_ORDER[existing.highestRisk]) {
        existing.highestRisk = approval.riskLevel;
      }
    } else {
      this.#observations.set(key, {
        contributors: [contribution],
        highestRisk: approval.riskLevel,
      });
    }

    const entry = this.#observations.get(key)!;
    // 迁移前 ConfirmationTracker 的沉淀阈值始终由当前这次审批风险决定；
    // highestRisk 只用于 /security 观察，不能反向改变后续审批的规则创建语义。
    const threshold = SUGGESTION_THRESHOLDS[approval.riskLevel];
    if (threshold <= 0 || entry.contributors.length < threshold) {
      return Object.freeze({ kind: "recorded" });
    }

    const rule = this.#createRule({
      pattern: representative.pattern,
      scope: "context",
      contributors: entry.contributors,
    });
    this.#repository.createExecutionRule(this.context, rule);
    return Object.freeze({ kind: "rule-sedimented" as const, rule });
  }

  #createExplicitRule(
    kind: "allow-session" | "allow-context" | "allow-global",
    suggestion: TrustAdministrationSuggestedPattern,
  ): TrustAdministrationRepositoryRule {
    const scope = kind === "allow-session"
      ? "session"
      : kind === "allow-context"
        ? "context"
        : "global";
    return this.#createRule({
      pattern: suggestion.pattern,
      scope,
      ...(scope === "session"
        ? {}
        : { contributors: [{ origin: "user" as const, timestamp: this.#now() }] }),
    });
  }

  #createRule(input: {
    readonly pattern: TrustAdministrationSuggestedPattern["pattern"];
    readonly scope: "session" | "context" | "global";
    readonly contributors?: readonly TrustAdministrationContribution[];
  }): TrustAdministrationRepositoryRule {
    const pattern = freezePattern(input.pattern);
    const contextBound = input.scope === "context";
    return Object.freeze({
      id: requireNonEmpty(this.#createRuleId(), "Trust rule id"),
      pattern,
      decision: "allow" as const,
      scope: input.scope,
      createdAt: this.#now(),
      lastMatchedAt: 0,
      matchCount: 0,
      ...(contextBound ? { contextId: freezeContext(this.context) } : {}),
      ...(contextBound && this.context.kind === "workspace" && this.#workspacePath
        ? { contextPath: this.#workspacePath }
        : {}),
      ...(input.contributors
        ? {
            contributors: Object.freeze(
              input.contributors.map((entry) => Object.freeze({ ...entry })),
            ),
          }
        : {}),
    });
  }
}

/** Shared readonly suggestion contract consumed by Trust and Confirmation. */
export function suggestTrustAdministrationPatterns(
  operation: TrustAdministrationOperation,
): readonly TrustAdministrationSuggestedPattern[] {
  const tool = requireNonEmpty(operation.tool, "Trust operation tool").toLowerCase();
  const args = operation.arguments;

  if (tool === "bash" || tool === "shell") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return Object.freeze([]);
    const parts = command.split(/\s+/);
    const patterns: TrustAdministrationSuggestedPattern[] = [
      suggestion("bash", command, `"${command}"`),
    ];
    const second = parts[1];
    if (
      parts.length >= 2 &&
      typeof second === "string" &&
      /^[a-z][a-z0-9_-]{0,15}$/i.test(second)
    ) {
      const argument = `${parts[0]} ${second} *`;
      if (argument !== command) {
        patterns.push(suggestion("bash", argument, `"${argument}"`));
      }
    }
    const generic = `${parts[0]} *`;
    if (
      generic !== command &&
      !patterns.some((candidate) => candidate.pattern.argument === generic)
    ) {
      patterns.push(suggestion("bash", generic, `"${generic}"`));
    }
    return Object.freeze(patterns);
  }

  if (tool === "write" || tool === "edit" || tool === "multiedit") {
    const path =
      (typeof args.path === "string" && args.path) ||
      (typeof args.file_path === "string" && args.file_path) ||
      "";
    if (!path) return Object.freeze([]);
    const patterns: TrustAdministrationSuggestedPattern[] = [
      suggestion(tool, path, `写 "${path}"`),
    ];
    const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (separator > 0) {
      const directory = path.slice(0, separator);
      patterns.push(
        suggestion(tool, `${directory}/**`, `写 "${directory}/" 下任意文件`),
      );
    }
    return Object.freeze(patterns);
  }

  return Object.freeze([suggestion(tool, "*", `所有 ${tool} 操作`)]);
}

function selectRepresentativePattern(
  patterns: readonly TrustAdministrationSuggestedPattern[],
): TrustAdministrationSuggestedPattern | null {
  if (patterns.length === 0) return null;
  return patterns.length >= 3 ? patterns[1]! : patterns[patterns.length - 1]!;
}

function suggestion(
  tool: string,
  argument: string,
  label: string,
): TrustAdministrationSuggestedPattern {
  return Object.freeze({ pattern: Object.freeze({ tool, argument }), label });
}

function freezeExecutionContext(
  sceneId: string | undefined,
  workspacePath: string | null,
  repository: TrustAdministrationExecutionRepository,
): TrustAdministrationContext {
  if (sceneId !== undefined) {
    return Object.freeze({
      kind: "scene",
      sceneId: requireNonEmpty(sceneId, "Scene identity"),
    });
  }
  if (workspacePath !== null) {
    return Object.freeze({
      kind: "workspace",
      hash: requireNonEmpty(
        repository.workspaceIdentity(workspacePath),
        "Workspace identity",
      ),
    });
  }
  return Object.freeze({ kind: "main" });
}

function freezeContext(
  context: TrustAdministrationContext,
): TrustAdministrationContext {
  switch (context.kind) {
    case "main":
      return Object.freeze({ kind: "main" });
    case "workspace":
      return Object.freeze({ kind: "workspace", hash: context.hash });
    case "scene":
      return Object.freeze({ kind: "scene", sceneId: context.sceneId });
  }
}

function freezeRules(
  rules: readonly TrustAdministrationRepositoryRule[],
): readonly TrustAdministrationRepositoryRule[] {
  return Object.freeze(
    rules.map((rule) =>
      Object.freeze({
        ...rule,
        pattern: freezePattern(rule.pattern),
        ...(rule.contextId ? { contextId: freezeContext(rule.contextId) } : {}),
        ...(rule.contributors
          ? {
              contributors: Object.freeze(
                rule.contributors.map((entry) => Object.freeze({ ...entry })),
              ),
            }
          : {}),
      }),
    ),
  );
}

function freezePattern(
  pattern: TrustAdministrationSuggestedPattern["pattern"],
): TrustAdministrationSuggestedPattern["pattern"] {
  return Object.freeze({
    tool: requireNonEmpty(pattern.tool, "Trust rule tool"),
    // 可信 confirmation.resolve 的既有 wire 合同允许空字符串 argument；
    // 这是精确规则值而非缺字段，领域不能在耐久 resolve 后追加收紧。
    argument: requireString(pattern.argument, "Trust rule argument"),
  });
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
