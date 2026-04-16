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
  GhostText,
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

  // ── Ghost Text ──

  /**
   * 计算 ghost text —— prefix-based 精确补全（不用 fuzzy）。
   *
   * 逻辑：在所有命令的 name 和 aliases 中找 prefix match。
   * 如果恰好只有一个命令匹配（unambiguous），返回对应的 suffix + fullValue。
   * 多个命令匹配（ambiguous）或零匹配 → null。
   */
  computeGhostText(match: TriggerMatch): GhostText | null {
    const query = match.query;
    if (!query) return null;

    const commands = this.registry.list(match.runtime);
    return getBestPrefixMatch(query, commands);
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

// ─── 纯函数：prefix match for ghost text ───

/**
 * 在命令列表中找 unambiguous prefix match。
 *
 * 检查 name + aliases。如果恰好只有一个命令的某个名称以 query 开头，
 * 返回 `{ suffix, fullValue }`；多个匹配（ambiguous）或零匹配返回 null。
 *
 * 优先级：name > alias（同一命令有多个匹配时取 name）。
 */
export function getBestPrefixMatch(
  query: string,
  commands: readonly CommandDef[],
): GhostText | null {
  if (!query) return null;

  const lower = query.toLowerCase();

  // 收集所有匹配的 (command, matchedName)
  const matches: Array<{ cmd: CommandDef; matchedName: string }> = [];

  for (const cmd of commands) {
    // 检查 name
    if (cmd.name.toLowerCase().startsWith(lower)) {
      matches.push({ cmd, matchedName: cmd.name });
      continue; // 同一 command 不再查 aliases
    }
    // 检查 aliases
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        if (alias.toLowerCase().startsWith(lower)) {
          matches.push({ cmd, matchedName: alias });
          break; // 同一 command 只取第一个匹配的 alias
        }
      }
    }
  }

  // 必须恰好一个命令匹配 —— 不是"一个 name"，而是"一个 command"
  // 用 command id 去重：同一 command 的 name 和 alias 都匹配算一个
  const uniqueByCmd = new Map<string, { cmd: CommandDef; matchedName: string }>();
  for (const m of matches) {
    if (!uniqueByCmd.has(m.cmd.id)) {
      uniqueByCmd.set(m.cmd.id, m);
    }
  }

  if (uniqueByCmd.size !== 1) return null;

  const entry = [...uniqueByCmd.values()][0]!;
  const { matchedName } = entry;

  // 已经是完整匹配（query === matchedName）→ 不需要 ghost
  if (lower === matchedName.toLowerCase()) return null;

  return {
    suffix: matchedName.slice(query.length),
    fullValue: `/${matchedName}`,
  };
}
