/**
 * SkillsStore — 技能存储与检索
 *
 * Phase M4a 核心模块：技能 CRUD + Trigger 匹配 + 使用追踪。
 *
 * 技能通过 triggers 字段被动匹配用户消息，命中时自动注入上下文。
 * 这是知行的核心优势——只在相关时才注入，不浪费 token。
 *
 * 文件结构：
 *   ~/.zhixing/me/skills/<slug>.md     ← 活跃技能
 *   ~/.zhixing/me/skills/.archive/     ← 归档技能（Phase M4c）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { scanSkillContent, hasBlockingThreats, getWarnings, SkillSecurityError, type ThreatMatch } from "./skill-security.js";
import { getMemoryDir } from "./types.js";

// ─── 类型 ───

export type SkillSource =
  | "manual"
  | "conversation"
  | "reflection"
  | "flush"
  | "condensation";

export type SkillEffectiveness =
  | "unknown"
  | "helpful"
  | "needs-update"
  | "possibly-irrelevant";

export interface SkillRevision {
  version: number;
  date: string;
  reason: SkillUpdateReason;
  summary: string;
}

export type SkillUpdateReason =
  | "initial"
  | "user-update"
  | "reflection-update"
  | "flush-update"
  | "user-edit";

export interface SkillMeta {
  title: string;
  tags: string[];
  triggers: string[];
  created: string;
  updated?: string;
  source: SkillSource;
  version: number;
  useCount: number;
  lastUsedAt?: string;
  effectiveness: SkillEffectiveness;
  revisions?: SkillRevision[];
}

export type SkillStatus = "active" | "stale" | "archived";

export interface SkillEntry {
  id: string;
  meta: SkillMeta;
  content: string;
  filePath: string;
}

export interface SkillMatch {
  skill: SkillEntry;
  /** 命中的 trigger 或 tag */
  matchedTrigger: string;
  /** 匹配类型 */
  matchType: "trigger" | "tag";
}

// ─── SkillsStore ───

export class SkillsStore {
  private readonly skillsDir: string;
  private _lastScanWarnings: ThreatMatch[] = [];

  constructor(baseDir?: string) {
    const memDir = baseDir ?? getMemoryDir();
    this.skillsDir = path.join(memDir, "skills");
  }

  /** 最近一次 save() 操作产生的安全扫描警告（warn 级别）。 */
  get lastScanWarnings(): readonly ThreatMatch[] {
    return this._lastScanWarnings;
  }

  /**
   * 保存技能。新建或更新。
   *
   * 写入前执行安全扫描：
   * - block 级别威胁 → 抛出 SkillSecurityError，拒绝写入
   * - warn 级别威胁 → 允许写入，返回路径（警告通过 lastScanWarnings 获取）
   */
  async save(id: string, meta: SkillMeta, content: string): Promise<string> {
    const scanResult = scanSkillContent(meta, content);
    if (hasBlockingThreats(scanResult)) {
      throw new SkillSecurityError(scanResult.threats.filter(t => t.severity === "block"));
    }
    this._lastScanWarnings = getWarnings(scanResult);

    await fs.mkdir(this.skillsDir, { recursive: true });

    const filePath = this.resolvePath(id);
    const raw: Record<string, unknown> = {
      title: meta.title,
      tags: meta.tags,
      triggers: meta.triggers,
      created: meta.created,
      source: meta.source,
      version: meta.version,
      useCount: meta.useCount,
      effectiveness: meta.effectiveness,
    };

    if (meta.updated) raw.updated = meta.updated;
    if (meta.lastUsedAt) raw.lastUsedAt = meta.lastUsedAt;
    // revisions 序列化为 JSON 字符串存入 frontmatter（简单 YAML 不支持嵌套对象）
    if (meta.revisions && meta.revisions.length > 0) {
      raw.revisions = JSON.stringify(meta.revisions);
    }

    const fileContent = stringifyFrontmatter(raw, content);
    await fs.writeFile(filePath, fileContent, "utf-8");

    return filePath;
  }

  /**
   * 加载一个技能。
   */
  async load(id: string): Promise<SkillEntry | null> {
    const filePath = this.resolvePath(id);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    return this.parseSkillFile(id, filePath, raw);
  }

  /**
   * 删除技能。
   */
  async delete(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.resolvePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出所有活跃技能。
   */
  async listAll(): Promise<SkillEntry[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.skillsDir);
    } catch {
      return [];
    }

    const entries: SkillEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const id = file.slice(0, -3);
      const entry = await this.load(id);
      if (entry) entries.push(entry);
    }

    return entries;
  }

  /**
   * 根据用户消息匹配技能。
   *
   * 匹配规则：
   * 1. triggers 子串匹配（不区分大小写）
   * 2. tags 子串匹配作为兜底
   *
   * 返回所有匹配的技能，按匹配精确度排序（trigger > tag）。
   */
  async matchByMessage(userMessage: string): Promise<SkillMatch[]> {
    const skills = await this.listAll();
    const msg = userMessage.toLowerCase();
    const matches: SkillMatch[] = [];

    for (const skill of skills) {
      // 优先 trigger 匹配
      const matchedTrigger = skill.meta.triggers.find((t) =>
        msg.includes(t.toLowerCase()),
      );
      if (matchedTrigger) {
        matches.push({ skill, matchedTrigger, matchType: "trigger" });
        continue;
      }

      // tag 匹配作为兜底
      const matchedTag = skill.meta.tags.find((t) =>
        msg.includes(t.toLowerCase()),
      );
      if (matchedTag) {
        matches.push({ skill, matchedTrigger: matchedTag, matchType: "tag" });
      }
    }

    // trigger 匹配优先于 tag 匹配
    matches.sort((a, b) => {
      if (a.matchType !== b.matchType) {
        return a.matchType === "trigger" ? -1 : 1;
      }
      return 0;
    });

    return matches;
  }

  /**
   * 记录技能使用：递增 useCount，更新 lastUsedAt。
   * 返回更新后的 meta。
   */
  async recordUsage(id: string): Promise<SkillMeta | null> {
    const skill = await this.load(id);
    if (!skill) return null;

    const updatedMeta: SkillMeta = {
      ...skill.meta,
      useCount: skill.meta.useCount + 1,
      lastUsedAt: new Date().toISOString().slice(0, 10),
    };

    await this.save(id, updatedMeta, skill.content);
    return updatedMeta;
  }

  /**
   * 构建技能领域索引（轻量，用于系统提示）。
   * 格式："Docker 网络调试 · TypeScript Monorepo · Git 分支策略"
   * 返回 null 表示技能数量 <= 0。
   */
  async buildDomainIndex(): Promise<string | null> {
    const skills = await this.listAll();
    if (skills.length === 0) return null;

    const titles = skills.map((s) => s.meta.title);
    return titles.join(" · ");
  }

  // ─── 版本追踪与归档（Phase M4c）───

  /**
   * 更新技能并记录修订历史。
   * 自动递增 version，设置 updated，追加 revision（最多保留 10 条）。
   */
  async updateWithRevision(
    id: string,
    newContent: string,
    reason: SkillUpdateReason,
    summary: string,
    metaUpdates?: Partial<Pick<SkillMeta, "title" | "tags" | "triggers">>,
  ): Promise<SkillEntry | null> {
    const existing = await this.load(id);
    if (!existing) return null;

    const today = new Date().toISOString().slice(0, 10);
    const newVersion = existing.meta.version + 1;

    const revision: SkillRevision = {
      version: newVersion,
      date: today,
      reason,
      summary,
    };

    // 保留最近 10 条 revisions（总是保留 version 1 的初始记录）
    const prevRevisions = existing.meta.revisions ?? [];
    let revisions = [...prevRevisions, revision];
    if (revisions.length > 10) {
      const initial = revisions.find((r) => r.version === 1);
      revisions = revisions.slice(-9);
      if (initial && !revisions.some((r) => r.version === 1)) {
        revisions = [initial, ...revisions];
      }
    }

    const updatedMeta: SkillMeta = {
      ...existing.meta,
      ...metaUpdates,
      version: newVersion,
      updated: today,
      revisions,
    };

    await this.save(id, updatedMeta, newContent);
    return await this.load(id);
  }

  /**
   * 归档技能：移入 skills/.archive/ 目录。
   * 归档后不参与 trigger 匹配，但可通过 listArchived() 查询。
   */
  async archive(id: string): Promise<boolean> {
    const sourcePath = this.resolvePath(id);
    const archiveDir = path.join(this.skillsDir, ".archive");
    const destPath = path.join(archiveDir, `${id}.md`);

    try {
      await fs.mkdir(archiveDir, { recursive: true });
      await fs.rename(sourcePath, destPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 恢复归档的技能：从 .archive/ 移回 skills/ 目录。
   */
  async restore(id: string): Promise<boolean> {
    const archivePath = path.join(this.skillsDir, ".archive", `${id}.md`);
    const destPath = this.resolvePath(id);

    try {
      await fs.rename(archivePath, destPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出所有归档技能。
   */
  async listArchived(): Promise<SkillEntry[]> {
    const archiveDir = path.join(this.skillsDir, ".archive");
    let files: string[];
    try {
      files = await fs.readdir(archiveDir);
    } catch {
      return [];
    }

    const entries: SkillEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const id = file.slice(0, -3);
      const filePath = path.join(archiveDir, `${id}.md`);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const entry = this.parseSkillFile(id, filePath, raw);
        if (entry) entries.push(entry);
      } catch { /* skip unreadable files */ }
    }
    return entries;
  }

  /**
   * 获取技能状态。
   * - active: 90 天内使用过（或从未使用但创建于 90 天内）
   * - stale: 超过 90 天未使用
   * - archived: 在 .archive/ 目录中
   */
  getStatus(skill: SkillEntry, staleDays = 90): SkillStatus {
    const now = Date.now();
    const msPerDay = 86400000;

    const lastActive = skill.meta.lastUsedAt
      ? new Date(skill.meta.lastUsedAt).getTime()
      : new Date(skill.meta.created).getTime();

    const daysSinceActive = Math.floor((now - lastActive) / msPerDay);

    if (skill.filePath.includes(".archive")) return "archived";
    if (daysSinceActive > staleDays) return "stale";
    return "active";
  }

  // ─── 格式化 ───

  /**
   * 将匹配的技能格式化为上下文注入段落。
   */
  static formatForContext(matches: SkillMatch[]): string {
    if (matches.length === 0) return "";

    const sections = matches.map((m) => {
      const lines: string[] = [];
      lines.push(`### ${m.skill.meta.title}`);
      if (m.skill.meta.tags.length > 0) {
        lines.push(`Tags: ${m.skill.meta.tags.join(", ")}`);
      }
      lines.push("");
      lines.push(m.skill.content);
      return lines.join("\n");
    });

    return `# Relevant Skills\n\n${sections.join("\n\n---\n\n")}`;
  }

  // ─── 内部 ───

  private resolvePath(id: string): string {
    return path.join(this.skillsDir, `${id}.md`);
  }

  private parseSkillFile(
    id: string,
    filePath: string,
    raw: string,
  ): SkillEntry | null {
    const parsed = parseFrontmatter<Partial<SkillMeta>>(raw);
    const data = parsed.data;

    let revisions: SkillRevision[] | undefined;
    if (typeof data.revisions === "string") {
      try { revisions = JSON.parse(data.revisions); } catch { revisions = undefined; }
    } else if (Array.isArray(data.revisions)) {
      revisions = data.revisions as SkillRevision[];
    }

    const meta: SkillMeta = {
      title: String(data.title ?? id),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      triggers: Array.isArray(data.triggers) ? data.triggers.map(String) : [],
      created: String(data.created ?? new Date().toISOString().slice(0, 10)),
      updated: data.updated ? String(data.updated) : undefined,
      source: (data.source as SkillSource) ?? "manual",
      version: typeof data.version === "number" ? data.version : 1,
      useCount: typeof data.useCount === "number" ? data.useCount : 0,
      lastUsedAt: data.lastUsedAt ? String(data.lastUsedAt) : undefined,
      effectiveness: (data.effectiveness as SkillEffectiveness) ?? "unknown",
      revisions,
    };

    return { id, meta, content: parsed.content, filePath };
  }
}
