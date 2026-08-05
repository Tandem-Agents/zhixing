/**
 * JournalStore — legacy journal file compatibility layer.
 *
 * 文件结构：
 *   ~/.zhixing/me/journal/YYYY-MM-DD.md  ← 每日日志（热）
 *   ~/.zhixing/me/journal/YYYY-MM.md     ← 月度凝练（冷）
 *
 * 生命周期：
 *   日志（<30天）→ 凝练（31天-12个月）→ 淘汰（>12个月）
 *
 * Production lifecycle decisions use the path-free planner below and commit
 * through global memory authority. This class remains only for import and
 * compatibility tests.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { getMemoryDir } from "./types.js";
import type { JsonValue } from "../contracts/index.js";
import type { Digest } from "../types/distributed.js";

// ─── 类型 ───

export interface JournalMeta {
  /** 日志日期（YYYY-MM-DD）或凝练周期（YYYY-MM） */
  date: string;
  /** 是否为月度凝练 */
  condensed?: boolean;
  /** 凝练来源数 */
  condensedFrom?: number;
  /** 凝练时间 */
  condensedAt?: string;
}

export interface JournalEntry {
  id: string;
  meta: JournalMeta;
  content: string;
  filePath: string;
  /** 生命周期阶段 */
  phase: JournalPhase;
}

export type JournalPhase = "hot" | "warm" | "condensed" | "expired";

export interface LifecyclePlan {
  /** 需要即时删除的过期凝练文件 */
  expiredFiles: string[];
  /** 需要凝练的月份及其日志文件 */
  condensePlan: CondensePlan | null;
  /** 当前 journal 状态摘要 */
  stats: JournalStats;
}

export interface JournalStats {
  hotCount: number;
  warmCount: number;
  condensedCount: number;
  totalFiles: number;
}

export interface CondensePlan {
  /** 按月分组的待凝练文件 */
  months: CondenseMonth[];
}

export interface CondenseMonth {
  month: string;
  files: string[];
}

/** Path-free journal fact consumed by authority-backed lifecycle planning. */
export interface JournalLifecycleEntry {
  id: string;
  meta: Record<string, JsonValue>;
  content: string;
  digest: Digest;
}

export interface JournalLifecycleMonth {
  month: string;
  sources: JournalLifecycleEntry[];
  target?: JournalLifecycleEntry;
}

export interface JournalAuthorityLifecyclePlan {
  expired: JournalLifecycleEntry[];
  condense: JournalLifecycleMonth[];
  stats: JournalStats;
}

export interface CondenserResult {
  condensedMonths: string[];
  deletedFiles: number;
}

/** 凝练需要的 LLM 能力（解耦，方便测试） */
export interface CondenseLLM {
  condense(dailyContents: string): Promise<string>;
}

export interface JournalConfig {
  /** 日志保留天数，超过此天数的日志参与凝练（默认 30） */
  dailyRetentionDays: number;
  /** 月度凝练保留月数（默认 12） */
  condensedRetentionMonths: number;
}

const DEFAULT_CONFIG: JournalConfig = {
  dailyRetentionDays: 30,
  condensedRetentionMonths: 12,
};

/**
 * Pure lifecycle planner. It consumes logical authority DTOs only; paths and
 * filesystem state cannot influence the decision.
 */
export function planJournalLifecycle(
  entries: readonly JournalLifecycleEntry[],
  options: {
    now?: Date;
    config?: Partial<JournalConfig>;
  } = {},
): JournalAuthorityLifecyclePlan {
  const now = options.now ?? new Date();
  const config = { ...DEFAULT_CONFIG, ...options.config };
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(config.dailyRetentionDays) ||
    config.dailyRetentionDays < 0 ||
    !Number.isSafeInteger(config.condensedRetentionMonths) ||
    config.condensedRetentionMonths < 0
  ) {
    throw new TypeError("Journal lifecycle configuration is invalid");
  }
  const expired: JournalLifecycleEntry[] = [];
  const warm = new Map<string, JournalLifecycleEntry[]>();
  const targets = new Map<string, JournalLifecycleEntry>();
  let hotCount = 0;
  let warmCount = 0;
  let condensedCount = 0;
  const seenIds = new Set<string>();

  for (const source of [...entries].sort((left, right) =>
    left.id.localeCompare(right.id, "en-US")
  )) {
    const entry = structuredClone(source);
    assertJournalLifecycleEntry(entry, seenIds);
    const phase = classifyJournalPhase(entry.id, entry.meta, now, config);
    if (entry.meta.condensed === true) {
      targets.set(journalDate(entry), entry);
    }
    if (phase === "hot") {
      hotCount++;
      continue;
    }
    if (phase === "warm") {
      warmCount++;
      const month = journalDate(entry).slice(0, 7);
      const group = warm.get(month) ?? [];
      group.push(entry);
      warm.set(month, group);
      continue;
    }
    if (phase === "condensed") {
      condensedCount++;
      continue;
    }
    expired.push(entry);
  }

  return {
    expired,
    condense: [...warm.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([month, sources]) => ({
        month,
        sources,
        ...(targets.get(month) ? { target: targets.get(month)! } : {}),
      })),
    stats: {
      hotCount,
      warmCount,
      condensedCount,
      totalFiles: entries.length,
    },
  };
}

// ─── JournalStore ───

export class JournalStore {
  private readonly journalDir: string;
  private readonly config: JournalConfig;

  constructor(baseDir?: string, config?: Partial<JournalConfig>) {
    const memDir = baseDir ?? getMemoryDir();
    this.journalDir = path.join(memDir, "journal");
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 追加当日日志。如果当天文件已存在则追加内容。
   */
  async append(content: string, date?: string): Promise<string> {
    const today = date ?? new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.journalDir, `${today}.md`);

    await fs.mkdir(this.journalDir, { recursive: true });

    let existing = "";
    try {
      existing = await fs.readFile(filePath, "utf-8");
    } catch { /* file doesn't exist yet */ }

    if (existing) {
      const parsed = parseFrontmatter<Partial<JournalMeta>>(existing);
      const newContent = parsed.content
        ? `${parsed.content}\n\n---\n\n${content}`
        : content;
      const fileContent = stringifyFrontmatter(
        { date: today },
        newContent,
      );
      await fs.writeFile(filePath, fileContent, "utf-8");
    } else {
      const fileContent = stringifyFrontmatter(
        { date: today },
        content,
      );
      await fs.writeFile(filePath, fileContent, "utf-8");
    }

    return filePath;
  }

  /**
   * 加载指定日期的日志。
   */
  async load(dateOrMonth: string): Promise<JournalEntry | null> {
    const filePath = path.join(this.journalDir, `${dateOrMonth}.md`);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    return this.parseJournalFile(dateOrMonth, filePath, raw);
  }

  /**
   * 列出所有日志（含阶段标记）。
   */
  async list(): Promise<JournalEntry[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.journalDir);
    } catch {
      return [];
    }

    const entries: JournalEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const id = file.slice(0, -3);
      const entry = await this.load(id);
      if (entry) entries.push(entry);
    }

    // 按日期降序
    entries.sort((a, b) => b.meta.date.localeCompare(a.meta.date));
    return entries;
  }

  /**
   * 快速扫描：检测生命周期操作需求。
   * 仅文件系统操作，<50ms。
   */
  async scan(): Promise<LifecyclePlan> {
    const entries = await this.list();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const plan = planJournalLifecycle(entries.map((entry) => ({
      id: entry.id,
      meta: entry.meta as unknown as Record<string, JsonValue>,
      content: entry.content,
      digest: `sha256:${"0".repeat(64)}`,
    })), { config: this.config });
    for (const entry of entries) {
      entry.phase = classifyJournalPhase(entry.id, entry.meta as unknown as Record<string, JsonValue>, new Date(), this.config);
    }
    const condensePlan: CondensePlan | null = plan.condense.length > 0
      ? {
          months: plan.condense.map((month) => ({
            month: month.month,
            files: month.sources.map((source) => byId.get(source.id)!.filePath),
          })),
        }
      : null;

    return {
      expiredFiles: plan.expired.map((entry) => byId.get(entry.id)!.filePath),
      condensePlan,
      stats: plan.stats,
    };
  }

  /**
   * 执行即时操作：删除过期凝练文件。
   * 不需要 LLM，纯文件系统操作。
   */
  async expireOld(): Promise<{ deleted: number }> {
    const plan = await this.scan();
    let deleted = 0;

    for (const filePath of plan.expiredFiles) {
      try {
        await fs.unlink(filePath);
        deleted++;
      } catch { /* ignore errors for already-deleted files */ }
    }

    return { deleted };
  }

  /**
   * 执行凝练：将指定月份的日志合并为月度摘要。
   * 需要 LLM 调用。
   */
  async condense(plan: CondensePlan, llm: CondenseLLM): Promise<CondenserResult> {
    const condensedMonths: string[] = [];
    let deletedFiles = 0;

    for (const monthPlan of plan.months) {
      // 读取所有日志内容
      const contents: string[] = [];
      for (const filePath of monthPlan.files) {
        try {
          const raw = await fs.readFile(filePath, "utf-8");
          const parsed = parseFrontmatter(raw);
          if (parsed.content) contents.push(parsed.content);
        } catch { /* skip unreadable */ }
      }

      if (contents.length === 0) continue;

      const combined = contents.join("\n\n---\n\n");
      const condensedContent = await llm.condense(combined);

      // 写入月度凝练文件
      const condensedPath = path.join(this.journalDir, `${monthPlan.month}.md`);
      const meta: Record<string, unknown> = {
        date: monthPlan.month,
        condensed: true,
        condensedFrom: monthPlan.files.length,
        condensedAt: new Date().toISOString().slice(0, 10),
      };
      await fs.writeFile(
        condensedPath,
        stringifyFrontmatter(meta, condensedContent),
        "utf-8",
      );

      // 删除原始日志文件
      for (const filePath of monthPlan.files) {
        try {
          await fs.unlink(filePath);
          deletedFiles++;
        } catch { /* ignore */ }
      }

      condensedMonths.push(monthPlan.month);
    }

    return { condensedMonths, deletedFiles };
  }

  // ─── 内部 ───

  /**
   * 判断日志所处的生命周期阶段。
   */
  private classifyPhase(meta: JournalMeta, now: Date): JournalPhase {
    return classifyJournalPhase(
      meta.date,
      meta as unknown as Record<string, JsonValue>,
      now,
      this.config,
    );
  }

  private parseJournalFile(
    id: string,
    filePath: string,
    raw: string,
  ): JournalEntry {
    const parsed = parseFrontmatter<Partial<JournalMeta>>(raw);

    const meta: JournalMeta = {
      date: String(parsed.data.date ?? id),
      condensed: parsed.data.condensed === true,
      condensedFrom: typeof parsed.data.condensedFrom === "number"
        ? parsed.data.condensedFrom
        : undefined,
      condensedAt: parsed.data.condensedAt
        ? String(parsed.data.condensedAt)
        : undefined,
    };

    // 阶段在 scan() 中动态计算
    const phase = this.classifyPhase(meta, new Date());

    return { id, meta, content: parsed.content, filePath, phase };
  }
}

function journalDate(entry: Pick<JournalLifecycleEntry, "id" | "meta">): string {
  const date = entry.meta.date;
  return typeof date === "string" ? date : entry.id;
}

function assertJournalLifecycleEntry(
  entry: JournalLifecycleEntry,
  seenIds: Set<string>,
): void {
  const date = journalDate(entry);
  const condensed = entry.meta.condensed === true;
  if (
    seenIds.has(entry.id) ||
    date !== entry.id ||
    !(condensed ? isCalendarMonth(date) : isCalendarDay(date)) ||
    !/^sha256:[a-f0-9]{64}$/u.test(entry.digest)
  ) {
    throw new TypeError("Journal lifecycle entry is invalid");
  }
  seenIds.add(entry.id);
}

function isCalendarMonth(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) return false;
  const parsed = new Date(`${value}-01T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 7) === value;
}

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function classifyJournalPhase(
  id: string,
  meta: Record<string, JsonValue>,
  now: Date,
  config: JournalConfig,
): JournalPhase {
  const date = typeof meta.date === "string" ? meta.date : id;
  if (meta.condensed === true) {
    const monthDate = new Date(`${date}-01T00:00:00.000Z`);
    const monthsAgo = (now.getUTCFullYear() - monthDate.getUTCFullYear()) * 12
      + (now.getUTCMonth() - monthDate.getUTCMonth());
    return monthsAgo > config.condensedRetentionMonths ? "expired" : "condensed";
  }
  const entryDate = new Date(`${date}T00:00:00.000Z`);
  const daysAgo = Math.floor((now.getTime() - entryDate.getTime()) / 86_400_000);
  return daysAgo <= config.dailyRetentionDays ? "hot" : "warm";
}
