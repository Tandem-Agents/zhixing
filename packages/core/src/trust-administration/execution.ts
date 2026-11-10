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
      /** 用户贡献所来自的确认请求；规则权威据此核对它是已答复的交互。 */
      readonly requestId?: string;
    }
  | {
      readonly kind: "allow-session" | "allow-context" | "allow-global";
      readonly pattern: TrustAdministrationSuggestedPattern;
    };

/** 达阈值的沉淀事实：交给规则权威接纳，不由执行端运行时自己写持久库。 */
export interface TrustSedimentSubmission {
  readonly pattern: TrustAdministrationSuggestedPattern["pattern"];
  readonly riskLevel: Exclude<TrustAdministrationRiskLevel, "critical">;
  readonly operation: TrustAdministrationOperation;
  readonly contributors: readonly {
    readonly origin: TrustAdministrationContribution["origin"];
    readonly timestamp: number;
    readonly requestId?: string;
  }[];
}

export type TrustSedimentSubmissionResult =
  /** 规则权威已接纳；本机可核对时带上规则。 */
  | { readonly kind: "accepted"; readonly rule?: TrustAdministrationRepositoryRule }
  /** 已记入回程，尚未得到接纳回执（成功反馈以接纳为准）。 */
  | { readonly kind: "submitted" }
  /** 本运行没有耐久回程：由规则权威所在宿主直接写入，其他宿主不沉淀。 */
  | { readonly kind: "unavailable" };

export interface TrustSedimentSubmissionPort {
  submit(sediment: TrustSedimentSubmission): Promise<TrustSedimentSubmissionResult>;
}

/** 安全评价选出的一条持久用户规则：只交规则权威累计匹配次数，不改变授权结论。 */
export interface TrustRuleHitSubmission {
  readonly ruleId: string;
  readonly scope: "context" | "global";
}

/**
 * 规则命中回程。`recorded`：已记入本运行的耐久回程，随既有镜像义务交规则权威；
 * `unavailable`：本运行没有耐久回程。
 */
export interface TrustRuleHitSubmissionPort {
  submit(hit: TrustRuleHitSubmission): Promise<"recorded" | "unavailable">;
}

/** recorded 走回程；direct 已由规则权威宿主直接记账；dropped 无回程且本宿主不是规则权威。 */
export type TrustRuleHitRecordResult = "recorded" | "direct" | "dropped";

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
  listExecutionRules(
    context: TrustAdministrationContext,
  ): readonly TrustAdministrationRepositoryRule[];
  snapshotExecutionRules(
    context: TrustAdministrationContext,
  ): readonly TrustAdministrationRepositoryRule[];
  /** 规则在耐久写完成后才对后续读取可见；写失败时拒绝。 */
  createExecutionRule(
    context: TrustAdministrationContext,
    rule: TrustAdministrationRepositoryRule,
  ): Promise<void>;
  /**
   * 规则权威宿主上没有耐久回程的运行直接累计规则命中；返回计入的条数。未提供时这类运行
   * 的命中不计。
   */
  recordExecutionRuleHits?(
    context: TrustAdministrationContext,
    hits: readonly (TrustRuleHitSubmission & { readonly at: number })[],
  ): Promise<number>;
}

export interface TrustAdministrationExecutionApplication {
  readonly context: TrustAdministrationContext;
  suggest(
    operation: TrustAdministrationOperation,
  ): readonly TrustAdministrationSuggestedPattern[];
  recordApproval(
    approval: TrustAdministrationApproval,
  ): Promise<TrustAdministrationApprovalResult>;
  /** 记一次持久用户规则的匹配；不改变授权结论。 */
  recordRuleHit(hit: TrustRuleHitSubmission): Promise<TrustRuleHitRecordResult>;
  securitySnapshot(): TrustAdministrationExecutionSnapshot;
  executionRules(): readonly TrustAdministrationRepositoryRule[];
}

export interface TrustAdministrationExecutionApplicationOptions {
  readonly repository: TrustAdministrationExecutionRepository;
  /** 本运行的授权范围，只由 resolveExecutionTrustScope 从已认证事实推导。 */
  readonly context: TrustAdministrationContext;
  /** 仅供 /security 与规则显示的工作目录，不参与范围身份。 */
  readonly workspacePath?: string | null;
  readonly now?: () => number;
  readonly createRuleId?: () => string;
  /**
   * 沉淀回程。返回 unavailable 时：directSediments 为 true（规则权威所在宿主）照旧直接
   * 写入，否则不沉淀。不传时直接写入。
   */
  readonly sediments?: TrustSedimentSubmissionPort;
  readonly directSediments?: boolean;
  /**
   * 规则命中回程。返回 unavailable 时与沉淀同一判断：directSediments 为 true（规则权威所在
   * 宿主）直接记账，否则不计。
   */
  readonly ruleHits?: TrustRuleHitSubmissionPort;
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
  /** 与 contributors 等长：用户贡献的确认请求 id。 */
  readonly requestIds: (string | undefined)[];
  highestRisk: TrustAdministrationRiskLevel;
  /** 本运行时已为该键沉淀过：派发快照在运行内冻结，后续同类批准不再重复沉淀。 */
  sedimented: boolean;
}

/**
 * 规则权威接纳沉淀时的语义核对：风险非 critical、贡献数达到该风险阈值、模式是触发
 * 操作的代表建议模式。与执行端累计用同一组阈值与选择规则。
 */
export function trustSedimentIsConsistent(sediment: TrustSedimentSubmission): boolean {
  const threshold = SUGGESTION_THRESHOLDS[sediment.riskLevel];
  if (!(threshold > 0) || sediment.contributors.length < threshold) return false;
  const representative = selectRepresentativePattern(
    suggestTrustAdministrationPatterns(sediment.operation),
  );
  return representative !== null &&
    representative.pattern.tool === sediment.pattern.tool &&
    representative.pattern.argument === sediment.pattern.argument;
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
  readonly #sediments: TrustSedimentSubmissionPort | undefined;
  readonly #directSediments: boolean;
  readonly #ruleHits: TrustRuleHitSubmissionPort | undefined;

  constructor(options: TrustAdministrationExecutionApplicationOptions) {
    this.#repository = options.repository;
    this.#workspacePath = options.workspacePath ?? null;
    this.#now = options.now ?? (() => Date.now());
    this.#createRuleId = options.createRuleId ?? randomUUID;
    this.#sediments = options.sediments;
    this.#directSediments = options.sediments ? options.directSediments === true : true;
    this.#ruleHits = options.ruleHits;
    this.context = freezeContext(options.context);
  }

  async recordRuleHit(hit: TrustRuleHitSubmission): Promise<TrustRuleHitRecordResult> {
    if (hit.scope !== "context" && hit.scope !== "global") return "dropped";
    if (typeof hit.ruleId !== "string" || hit.ruleId.length === 0) return "dropped";
    const submission = Object.freeze({ ruleId: hit.ruleId, scope: hit.scope });
    if (this.#ruleHits && await this.#ruleHits.submit(submission) === "recorded") return "recorded";
    // 没有耐久回程：与沉淀同一判断，只有规则权威所在宿主直接记账，执行端不自作权威
    if (!this.#directSediments || !this.#repository.recordExecutionRuleHits) return "dropped";
    await this.#repository.recordExecutionRuleHits(this.context, [{ ...submission, at: this.#now() }]);
    return "direct";
  }

  suggest(
    operation: TrustAdministrationOperation,
  ): readonly TrustAdministrationSuggestedPattern[] {
    return suggestTrustAdministrationPatterns(operation);
  }

  async recordApproval(
    approval: TrustAdministrationApproval,
  ): Promise<TrustAdministrationApprovalResult> {
    switch (approval.kind) {
      case "allow-once":
        return this.#recordContribution(approval);
      case "allow-session":
      case "allow-context":
      case "allow-global": {
        const rule = this.#createExplicitRule(approval.kind, approval.pattern);
        await this.#repository.createExecutionRule(this.context, rule);
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

  async #recordContribution(
    approval: Extract<TrustAdministrationApproval, { readonly kind: "allow-once" }>,
  ): Promise<TrustAdministrationApprovalResult> {
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
      existing.requestIds.push(approval.requestId);
      if (RISK_ORDER[approval.riskLevel] > RISK_ORDER[existing.highestRisk]) {
        existing.highestRisk = approval.riskLevel;
      }
    } else {
      this.#observations.set(key, {
        contributors: [contribution],
        requestIds: [approval.requestId],
        highestRisk: approval.riskLevel,
        sedimented: false,
      });
    }

    const entry = this.#observations.get(key)!;
    // 迁移前 ConfirmationTracker 的沉淀阈值始终由当前这次审批风险决定；
    // highestRisk 只用于 /security 观察，不能反向改变后续审批的规则创建语义。
    const threshold = SUGGESTION_THRESHOLDS[approval.riskLevel];
    if (entry.sedimented || threshold <= 0 || entry.contributors.length < threshold) {
      return Object.freeze({ kind: "recorded" });
    }

    if (this.#sediments && approval.riskLevel !== "critical") {
      // 沉淀交规则权威接纳；成功反馈以接纳回执为准
      const outcome = await this.#sediments.submit(Object.freeze({
        pattern: freezePattern(representative.pattern),
        riskLevel: approval.riskLevel,
        operation: approval.operation,
        contributors: Object.freeze(entry.contributors.map((item, index) => Object.freeze({
          ...item,
          ...(entry.requestIds[index] ? { requestId: entry.requestIds[index] } : {}),
        }))),
      }));
      if (outcome.kind !== "unavailable") {
        entry.sedimented = true;
        return outcome.kind === "accepted" && outcome.rule
          ? Object.freeze({ kind: "rule-sedimented" as const, rule: outcome.rule })
          : Object.freeze({ kind: "recorded" });
      }
      if (!this.#directSediments) return Object.freeze({ kind: "recorded" });
    }

    const rule = this.#createRule({
      pattern: representative.pattern,
      scope: "context",
      contributors: entry.contributors,
    });
    await this.#repository.createExecutionRule(this.context, rule);
    entry.sedimented = true;
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

function freezeContext(
  context: TrustAdministrationContext,
): TrustAdministrationContext {
  switch (context.kind) {
    case "main":
      return Object.freeze({ kind: "main" });
    case "workspace":
      return Object.freeze({
        kind: "workspace",
        hash: context.hash,
        ...(context.revision === undefined ? {} : { revision: context.revision }),
      });
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
