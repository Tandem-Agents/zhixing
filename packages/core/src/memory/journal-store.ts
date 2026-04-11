/**
 * JournalStore — 日志暂存层
 *
 * Phase M6 核心模块：管理 ~/.zhixing/me/journal/ 下的对话日志。
 *
 * 文件结构：
 *   ~/.zhixing/me/journal/YYYY-MM-DD.md  ← 每日日志（热）
 *   ~/.zhixing/me/journal/YYYY-MM.md     ← 月度凝练（冷）
 *
 * 生命周期：
 *   日志（<30天）→ 凝练（31天-12个月）→ 淘汰（>12个月）
 *
 * 设计要点：
 * - scan/expireOld 仅文件系统操作，<50ms
 * - condense 需要 LLM 调用，通过 CondenseLLM 接口解耦
 * - 触发源无关：CLI 和 Server 各自提供不同的触发策略
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { getMemoryDir } from "./types.js";

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

export interface CondenserResult {
  condensedMonths: string[];
  skillCandidates: string[];
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
    const now = new Date();

    const expiredFiles: string[] = [];
    const warmDailies: Map<string, string[]> = new Map();
    let hotCount = 0;
    let warmCount = 0;
    let condensedCount = 0;

    for (const entry of entries) {
      const phase = this.classifyPhase(entry.meta, now);
      entry.phase = phase;

      switch (phase) {
        case "hot":
          hotCount++;
          break;
        case "warm": {
          warmCount++;
          // 按月分组
          const month = entry.meta.date.slice(0, 7);
          const group = warmDailies.get(month) ?? [];
          group.push(entry.filePath);
          warmDailies.set(month, group);
          break;
        }
        case "condensed":
          condensedCount++;
          break;
        case "expired":
          expiredFiles.push(entry.filePath);
          break;
      }
    }

    const condensePlan: CondensePlan | null = warmDailies.size > 0
      ? { months: [...warmDailies.entries()].map(([month, files]) => ({ month, files })) }
      : null;

    return {
      expiredFiles,
      condensePlan,
      stats: {
        hotCount,
        warmCount,
        condensedCount,
        totalFiles: entries.length,
      },
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
    const skillCandidates: string[] = [];
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

      // 检测 [SKILL_CANDIDATE] 标记
      const candidateRegex = /\[SKILL_CANDIDATE\]\s*(.+)/g;
      let match: RegExpExecArray | null;
      while ((match = candidateRegex.exec(condensedContent)) !== null) {
        skillCandidates.push(match[1]!.trim());
      }

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

    return { condensedMonths, skillCandidates, deletedFiles };
  }

  // ─── 内部 ───

  /**
   * 判断日志所处的生命周期阶段。
   */
  private classifyPhase(meta: JournalMeta, now: Date): JournalPhase {
    // 凝练文件单独处理
    if (meta.condensed) {
      const monthDate = new Date(`${meta.date}-01`);
      const monthsAgo = (now.getFullYear() - monthDate.getFullYear()) * 12
        + (now.getMonth() - monthDate.getMonth());
      return monthsAgo > this.config.condensedRetentionMonths ? "expired" : "condensed";
    }

    // 日志文件
    const entryDate = new Date(meta.date);
    const msPerDay = 86400000;
    const daysAgo = Math.floor((now.getTime() - entryDate.getTime()) / msPerDay);

    if (daysAgo <= this.config.dailyRetentionDays) return "hot";
    return "warm";
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
