/**
 * 确认追踪器 — 信任沉淀引擎
 *
 * 职责：
 *   1. 追踪同一模式被放行（用户确认 / AI 安全管家判 safe）的累计次数
 *   2. 累计达到风险等级对应阈值时，给出"该自动沉淀为持久放行规则"的信号
 *   3. 提供沉淀用的代表模式（persistencePattern）
 *
 * 沉淀的执行（创建规则）由编排层完成：放行后调 record，达阈值则按
 * persistencePattern 创建标记来源的 allow 规则。信任根源始终是用户意图
 * （用户确认、或管家在用户已授予信任的上下文内放行），沉淀规则可在 /trust 撤销。
 */

import type { RiskLevel, SecurityRequest, TrustContribution } from "./types.js";

// ─── 阈值定义 ───

/**
 * 沉淀阈值——同类操作被放行（用户确认 / 管家 safe）累计达此次数时自动沉淀为
 * 持久放行规则。风险越高越保守；critical 永不沉淀。
 */
const SUGGESTION_THRESHOLDS: Record<RiskLevel, number> = {
  low: 3,
  medium: 3,
  high: 10,
  critical: -1,
};

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ─── 候选模式 ───

/**
 * 候选权限规则模式。
 * UI 在用户选"始终允许"时展示，让用户选择泛化级别。
 */
export interface SuggestedPattern {
  pattern: { tool: string; argument: string };
  /** 给用户看的可读标签 */
  label: string;
}

/**
 * 推断给定操作的候选规则模式。
 *
 * 返回从最精确到最通用的多个建议：
 *   bash：完整命令 → executable + first-arg + * → executable + *
 *   write/edit：精确路径 → 父目录/**
 *   其他工具：catch-all *
 */
export function suggestPatterns(request: SecurityRequest): SuggestedPattern[] {
  const tool = request.tool.toLowerCase();
  const args = request.arguments;

  if (tool === "bash" || tool === "shell") {
    const cmd = typeof args["command"] === "string" ? args["command"].trim() : "";
    if (!cmd) return [];

    const parts = cmd.split(/\s+/);
    const out: SuggestedPattern[] = [];

    // 1. 完整命令（最精确）
    out.push({
      pattern: { tool: "bash", argument: cmd },
      label: `"${cmd}"`,
    });

    // 2. executable + subcommand + *（仅当 parts[1] 看起来像子命令）
    //
    // 启发式：子命令是短字母数字串（如 install / status / push）。
    // 排除 URL（含 ://）、路径（含 /）、选项（以 - 开头）、字面量值。
    // 这避免了 `curl URL` 被错误地泛化为 `curl URL *` 这种无意义模式，
    // 也确保 `npm install foo` 和 `npm install bar` 能落到同一分组 key。
    const second = parts[1];
    const looksLikeSubcommand =
      typeof second === "string" && /^[a-z][a-z0-9_-]{0,15}$/i.test(second);
    if (parts.length >= 2 && looksLikeSubcommand) {
      const arg = `${parts[0]} ${second} *`;
      if (arg !== cmd) {
        out.push({
          pattern: { tool: "bash", argument: arg },
          label: `"${arg}"`,
        });
      }
    }

    // 3. executable + *（最通用）
    if (parts.length >= 1) {
      const arg = `${parts[0]} *`;
      const alreadyHave = out.some((p) => p.pattern.argument === arg);
      if (arg !== cmd && !alreadyHave) {
        out.push({
          pattern: { tool: "bash", argument: arg },
          label: `"${arg}"`,
        });
      }
    }

    return out;
  }

  if (tool === "write" || tool === "edit" || tool === "multiedit") {
    const pathArg =
      (typeof args["path"] === "string" && args["path"]) ||
      (typeof args["file_path"] === "string" && args["file_path"]) ||
      "";
    if (!pathArg) return [];

    const out: SuggestedPattern[] = [
      {
        pattern: { tool, argument: pathArg },
        label: `写 "${pathArg}"`,
      },
    ];

    const lastSep = Math.max(pathArg.lastIndexOf("/"), pathArg.lastIndexOf("\\"));
    if (lastSep > 0) {
      const dir = pathArg.slice(0, lastSep);
      out.push({
        pattern: { tool, argument: `${dir}/**` },
        label: `写 "${dir}/" 下任意文件`,
      });
    }

    return out;
  }

  // 通用回退：所有该工具的操作
  return [
    {
      pattern: { tool, argument: "*" },
      label: `所有 ${tool} 操作`,
    },
  ];
}

/**
 * 选取用于累计 / 沉淀的"代表模式"——中间精度（如 `npm install *`），让同一类
 * 操作（不同末参）累计到同一 key、并沉淀为同一规则；累计与沉淀粒度由此保持一致。
 */
function selectKeyPattern(
  patterns: SuggestedPattern[],
): SuggestedPattern | null {
  if (patterns.length === 0) return null;
  return patterns.length >= 3 ? patterns[1]! : patterns[patterns.length - 1]!;
}

// ─── Tracker 接口和类型 ───

/**
 * shouldSuggest 的查询结果。
 *
 * 同一查询暴露完整 contributors 数组给调用方（secure-executor.maybePersistTrust
 * 在判 `suggest=true` 后直接据此构造 `PermissionRule.contributors`，无需二次查询）。
 *
 * **`contributors` 是独立副本**：shouldSuggest 内部已对 entry 数组与每条记录做
 * 深拷贝，调用方可直接持有 / 传给 createRule，无需再 .map 一次。隐式契约下沉
 * 到边界，避免调用方忘了拷贝把 tracker 内部数组反向污染。
 */
export interface SuggestionStatus {
  /** 是否达到沉淀阈值 */
  suggest: boolean;
  /** 候选模式列表（最精确到最通用） */
  patterns: SuggestedPattern[];
  /** 当前累计的贡献次数（= contributors.length，避免存储冗余字段） */
  count: number;
  /** 风险等级对应的阈值（-1 表示永不沉淀） */
  threshold: number;
  /** 完整贡献时间线 —— 用户确认与 AI 安全助理放行平权累积（独立副本，可放心持有） */
  contributors: TrustContribution[];
}

export interface IConfirmationTracker {
  record(
    request: SecurityRequest,
    riskLevel: RiskLevel,
    origin: TrustContribution["origin"],
  ): void;
  getCount(request: SecurityRequest): number;
  shouldSuggest(
    request: SecurityRequest,
    riskLevel: RiskLevel,
  ): SuggestionStatus;
  /** 返回沉淀用的代表模式（与累计 key 同粒度）；无可用模式时 null。 */
  persistencePattern(request: SecurityRequest): SuggestedPattern | null;
  reset(request?: SecurityRequest): void;
  /** 调试/可观测性：返回所有追踪条目（供 /security 展示） */
  snapshot(): Array<{ key: string; count: number; highestRisk: RiskLevel }>;
}

interface TrackerEntry {
  contributors: TrustContribution[];
  /** 已观察到的最高风险等级 */
  highestRisk: RiskLevel;
}

// ─── ConfirmationTracker 实现 ───

export class ConfirmationTracker implements IConfirmationTracker {
  private readonly entries = new Map<string, TrackerEntry>();

  record(
    request: SecurityRequest,
    riskLevel: RiskLevel,
    origin: TrustContribution["origin"],
  ): void {
    const key = this.buildKey(request);
    if (!key) return;

    const contribution: TrustContribution = { origin, timestamp: Date.now() };
    const existing = this.entries.get(key);
    if (existing) {
      existing.contributors.push(contribution);
      if (RISK_ORDER[riskLevel] > RISK_ORDER[existing.highestRisk]) {
        existing.highestRisk = riskLevel;
      }
    } else {
      this.entries.set(key, {
        contributors: [contribution],
        highestRisk: riskLevel,
      });
    }
  }

  getCount(request: SecurityRequest): number {
    const key = this.buildKey(request);
    if (!key) return 0;
    return this.entries.get(key)?.contributors.length ?? 0;
  }

  shouldSuggest(
    request: SecurityRequest,
    riskLevel: RiskLevel,
  ): SuggestionStatus {
    const patterns = suggestPatterns(request);
    const key = this.buildKey(request);
    const entry = key ? this.entries.get(key) : undefined;
    // 深拷贝 contributors —— 调用方持有 / 传给 createRule 时不会反向污染 tracker
    const contributors = entry
      ? entry.contributors.map((c) => ({ ...c }))
      : [];
    const count = contributors.length;
    const threshold = SUGGESTION_THRESHOLDS[riskLevel];

    if (patterns.length === 0 || threshold <= 0) {
      return { suggest: false, patterns, count, threshold, contributors };
    }

    return {
      suggest: count >= threshold,
      patterns,
      count,
      threshold,
      contributors,
    };
  }

  persistencePattern(request: SecurityRequest): SuggestedPattern | null {
    return selectKeyPattern(suggestPatterns(request));
  }

  reset(request?: SecurityRequest): void {
    if (!request) {
      this.entries.clear();
      return;
    }
    const key = this.buildKey(request);
    if (key) this.entries.delete(key);
  }

  /** 调试/可观测性：返回所有追踪条目 */
  snapshot(): Array<{ key: string; count: number; highestRisk: RiskLevel }> {
    return [...this.entries.entries()].map(([key, entry]) => ({
      key,
      count: entry.contributors.length,
      highestRisk: entry.highestRisk,
    }));
  }

  /**
   * 构造跨调用稳定的追踪 key。
   *
   * 使用"中间精度"建议作为 key：
   *   `npm install express` → key 是 `bash::npm install *`
   *   这样 `npm install lodash` 也会落到同一 key，跨调用累计计数。
   *
   * 如果只有 2 个建议（如 `ls`），用最通用的；如果只有 1 个（如未知工具），用唯一那个。
   */
  private buildKey(request: SecurityRequest): string | null {
    const chosen = selectKeyPattern(suggestPatterns(request));
    if (!chosen) return null;
    return `${chosen.pattern.tool}::${chosen.pattern.argument}`;
  }
}
