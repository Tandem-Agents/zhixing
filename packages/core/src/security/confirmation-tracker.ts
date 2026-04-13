/**
 * 确认追踪器 — 智能建议引擎
 *
 * 职责：
 *   1. 追踪用户手动确认（选 [y] 一次性允许）的次数
 *   2. 当同一模式累计达到风险等级对应的阈值时，建议创建持久规则
 *   3. 永不自动创建规则——决策权始终在用户手中
 *
 * 与确认 UI 的关系：
 *   - UI 在用户选 [y] 后调用 tracker.record(...)
 *   - 管线在 confirm 决策时调用 tracker.shouldSuggest(...) 检查是否需要建议
 *   - 这种分工让 tracker 同时服务 CLI / Web / API 多通道
 */

import type { RiskLevel, SecurityRequest } from "./types.js";

// ─── 阈值定义（规格 4.4） ───

/**
 * 建议阈值——同一模式被手动确认达到此次数时，建议创建持久规则。
 * 与风险等级关联：风险越高越保守。
 */
const SUGGESTION_THRESHOLDS: Record<RiskLevel, number> = {
  low: 3,
  medium: 5,
  high: 10,
  critical: -1, // critical 永不建议自动规则
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

// ─── Tracker 接口和类型 ───

/**
 * shouldSuggest 的查询结果。
 * 即使 suggest=false 也返回 patterns/count，方便 UI 展示当前进度。
 */
export interface SuggestionStatus {
  /** 是否达到建议阈值 */
  suggest: boolean;
  /** 候选模式列表（最精确到最通用） */
  patterns: SuggestedPattern[];
  /** 当前累计的手动确认次数 */
  count: number;
  /** 风险等级对应的阈值（-1 表示永不建议） */
  threshold: number;
}

export interface IConfirmationTracker {
  record(request: SecurityRequest, riskLevel: RiskLevel): void;
  getCount(request: SecurityRequest): number;
  shouldSuggest(
    request: SecurityRequest,
    riskLevel: RiskLevel,
  ): SuggestionStatus;
  reset(request?: SecurityRequest): void;
  /** 调试/可观测性：返回所有追踪条目（供 /security 展示） */
  snapshot(): Array<{ key: string; count: number; highestRisk: RiskLevel }>;
}

interface TrackerEntry {
  count: number;
  /** 已观察到的最高风险等级 */
  highestRisk: RiskLevel;
}

// ─── ConfirmationTracker 实现 ───

export class ConfirmationTracker implements IConfirmationTracker {
  private readonly entries = new Map<string, TrackerEntry>();

  record(request: SecurityRequest, riskLevel: RiskLevel): void {
    const key = this.buildKey(request);
    if (!key) return;

    const existing = this.entries.get(key);
    if (existing) {
      existing.count += 1;
      if (RISK_ORDER[riskLevel] > RISK_ORDER[existing.highestRisk]) {
        existing.highestRisk = riskLevel;
      }
    } else {
      this.entries.set(key, { count: 1, highestRisk: riskLevel });
    }
  }

  getCount(request: SecurityRequest): number {
    const key = this.buildKey(request);
    if (!key) return 0;
    return this.entries.get(key)?.count ?? 0;
  }

  shouldSuggest(
    request: SecurityRequest,
    riskLevel: RiskLevel,
  ): SuggestionStatus {
    const patterns = suggestPatterns(request);
    const key = this.buildKey(request);
    const count = key ? this.entries.get(key)?.count ?? 0 : 0;
    const threshold = SUGGESTION_THRESHOLDS[riskLevel];

    if (patterns.length === 0 || threshold <= 0) {
      return { suggest: false, patterns, count, threshold };
    }

    return {
      suggest: count >= threshold,
      patterns,
      count,
      threshold,
    };
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
      count: entry.count,
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
    const patterns = suggestPatterns(request);
    if (patterns.length === 0) return null;

    let chosen: SuggestedPattern;
    if (patterns.length >= 3) {
      chosen = patterns[1]!;
    } else {
      chosen = patterns[patterns.length - 1]!;
    }
    return `${chosen.pattern.tool}::${chosen.pattern.argument}`;
  }
}
