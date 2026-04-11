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
}

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

  constructor(baseDir?: string) {
    const memDir = baseDir ?? getMemoryDir();
    this.skillsDir = path.join(memDir, "skills");
  }

  /**
   * 保存技能。新建或更新。
   */
  async save(id: string, meta: SkillMeta, content: string): Promise<string> {
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
    };

    return { id, meta, content: parsed.content, filePath };
  }
}
