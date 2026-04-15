/**
 * CommandProvider —— slash 命令补全的核心 provider
 *
 * 职责（spec §8.1 条目 `command`，priority=100）：
 *   1. matchTrigger: 检测 `/` 触发（prompt 模式；bash 模式下不响应）
 *   2. query: 把 query 交给 Fuse + §6.2 resort，或空 query 时走分类 + MRU
 *   3. 构造 SuggestionItem 的 AcceptPayload：
 *      - 无参数命令：execute=true（零键执行）
 *      - 有必填参数：execute=false，accept 后填充 `/cmd ` 留给 ArgumentProvider
 *
 * 本 provider 不碰 async —— 命令列表是同步的。ArgumentProvider（Step 8）
 * 和 FileProvider（Step 6）才是 async 的首个实例。
 */

import { getCommandFuse, type CommandIndexItem } from "../fuzzy-index.js";
import { sortCandidates, type SortableCandidate } from "../sort.js";
import { findTriggerToken } from "../trigger-matcher.js";
import type {
  CommandCategory,
  CommandDef,
  ICommandRegistry,
  IUsageTracker,
  SuggestionItem,
  SuggestionProvider,
  TriggerContext,
  TriggerMatch,
} from "../types.js";

// ─── 选项 ───

export interface CommandProviderOptions {
  readonly registry: ICommandRegistry;
  readonly usageTracker?: IUsageTracker;
  /** 空 query 时 MRU 段展示多少条（剩下的走分类） */
  readonly mruTopN?: number;
}

const DEFAULT_MRU_TOP_N = 5;

/**
 * 默认分类显示顺序（spec §6.3）。未列出的 category 排在末尾。
 */
const CATEGORY_ORDER: readonly CommandCategory[] = [
  "session",
  "config",
  "info",
  "tools",
  "debug",
  "plugin",
];

// ─── 实现 ───

export class CommandProvider implements SuggestionProvider {
  readonly id = "command";
  readonly priority = 100;
  readonly supportsGhostText = true;
  readonly supportsChaining = true; // 留给 ArgumentProvider 的两段式

  private readonly registry: ICommandRegistry;
  private readonly usageTracker: IUsageTracker | undefined;
  private readonly mruTopN: number;

  constructor(options: CommandProviderOptions) {
    this.registry = options.registry;
    this.usageTracker = options.usageTracker;
    this.mruTopN = options.mruTopN ?? DEFAULT_MRU_TOP_N;
  }

  // ── Trigger 检测 ──

  matchTrigger(ctx: TriggerContext): TriggerMatch | null {
    // spec §12.2 锁定决策 #6：bash mode 不触发 slash 补全
    if (ctx.mode === "bash") return null;

    const token = findTriggerToken(ctx.draft, ctx.cursor, {
      triggerChar: "/",
      requireBoundary: true, // Phase 1：严格 —— mid-input 留给 Phase 3 Step 9
    });
    if (!token) return null;

    return {
      providerId: this.id,
      tokenStart: token.tokenStart,
      tokenEnd: token.tokenEnd,
      token: token.token,
      query: token.query,
      runtime: ctx.runtime,
    };
  }

  // ── Query ──

  query(match: TriggerMatch, _signal: AbortSignal): SuggestionItem[] {
    const lowerQuery = match.query.toLowerCase();
    const commands = this.registry.list(match.runtime);

    if (lowerQuery === "") {
      return this.buildEmptyQueryResults(commands);
    }
    return this.buildFuzzyResults(commands, lowerQuery);
  }

  // ── 空 query：MRU + 分类 ──

  private buildEmptyQueryResults(
    commands: readonly CommandDef[],
  ): SuggestionItem[] {
    // MRU top N（跨分类）
    const mruIds = new Set<string>();
    const mruItems: SuggestionItem[] = [];

    if (this.usageTracker) {
      const top = this.usageTracker.topN(this.mruTopN);
      for (const { commandId } of top) {
        const cmd = commands.find((c) => c.id === commandId);
        if (!cmd) continue;
        mruIds.add(cmd.id);
        mruItems.push(this.toSuggestionItem(cmd));
      }
    }

    // 剩下的按分类 + 字母序
    const byCategory = new Map<CommandCategory, CommandDef[]>();
    for (const cmd of commands) {
      if (mruIds.has(cmd.id)) continue;
      const bucket = byCategory.get(cmd.category) ?? [];
      bucket.push(cmd);
      byCategory.set(cmd.category, bucket);
    }

    const categoryItems: SuggestionItem[] = [];
    const unknownCategory: CommandDef[] = [];

    for (const category of CATEGORY_ORDER) {
      const bucket = byCategory.get(category);
      if (!bucket) continue;
      bucket.sort((a, b) => a.name.localeCompare(b.name));
      for (const cmd of bucket) {
        categoryItems.push(this.toSuggestionItem(cmd));
      }
      byCategory.delete(category);
    }
    // 任何未列出的 category（插件定义的新分类）排在末尾
    for (const bucket of byCategory.values()) {
      for (const cmd of bucket) unknownCategory.push(cmd);
    }
    unknownCategory.sort((a, b) => a.name.localeCompare(b.name));
    for (const cmd of unknownCategory) {
      categoryItems.push(this.toSuggestionItem(cmd));
    }

    return [...mruItems, ...categoryItems];
  }

  // ── 非空 query：Fuse + resort ──

  private buildFuzzyResults(
    commands: readonly CommandDef[],
    lowerQuery: string,
  ): SuggestionItem[] {
    if (commands.length === 0) return [];

    const { fuse } = getCommandFuse(commands);
    const fuseResults = fuse.search(lowerQuery);

    // 把 FuseResult 投影到 SortableCandidate
    const candidates: SortableCandidate<CommandDef>[] = fuseResults.map(
      (r: { item: CommandIndexItem; score?: number }) => {
        const cmd = r.item.command;
        const usageScore = this.usageTracker?.getScore(cmd.id) ?? 0;
        return {
          name: cmd.name,
          aliases: cmd.aliases ?? [],
          fuseScore: r.score ?? 0,
          usageScore,
          payload: cmd,
        };
      },
    );

    const sorted = sortCandidates(candidates, lowerQuery);
    return sorted.map((c) => this.toSuggestionItem(c.payload));
  }

  // ── Item 构造 ──

  private toSuggestionItem(cmd: CommandDef): SuggestionItem {
    const hasRequiredArgs =
      cmd.args?.some((arg) => arg.required) ?? false;
    // 无必填参数 → 零键执行（execute=true）
    // 有必填参数 → 填充 `/cmd ` 留给 ArgumentProvider（execute=false）
    const execute = !hasRequiredArgs;
    const replacement = execute ? `/${cmd.name}` : `/${cmd.name} `;

    return {
      id: cmd.id,
      providerId: this.id,
      displayText: `/${cmd.name}`,
      description: cmd.description,
      icon: cmd.icon,
      tag: cmd.tag === "builtin" ? undefined : cmd.tag,
      acceptPayload: {
        replacement,
        execute,
        executionHint: cmd.execution,
        metadata: { commandId: cmd.id },
      },
    };
  }

}
