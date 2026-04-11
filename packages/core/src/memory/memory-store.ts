/**
 * MemoryStore — 记忆持久化存储
 *
 * 统一管理 ~/.zhixing/me/ 下所有记忆文件的 CRUD 操作。
 * Phase M2 核心模块，被 memory 工具调用。
 *
 * 存储结构：
 *   ~/.zhixing/me/
 *   ├── profile.md          ← Phase M1
 *   ├── people/<slug>.md    ← Phase M3
 *   ├── skills/<slug>.md    ← Phase M4
 *   └── journal/YYYY-MM-DD.md ← Phase M6
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { getMemoryDir } from "./types.js";

// ─── 类型 ───

export type MemoryCategory = "profile" | "person" | "skill" | "journal";

export interface MemoryEntry {
  category: MemoryCategory;
  id: string;
  /** frontmatter 元数据 */
  meta: Record<string, unknown>;
  /** Markdown 正文 */
  content: string;
  /** 文件完整路径 */
  filePath: string;
}

export interface SaveOptions {
  category: MemoryCategory;
  id: string;
  meta: Record<string, unknown>;
  content: string;
}

// ─── MemoryStore ───

export class MemoryStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? getMemoryDir();
  }

  /**
   * 保存一条记忆。如果文件已存在则覆盖。
   * 自动创建目录结构。
   */
  async save(options: SaveOptions): Promise<string> {
    const filePath = this.resolvePath(options.category, options.id);
    const dir = path.dirname(filePath);

    await fs.mkdir(dir, { recursive: true });

    const fileContent = stringifyFrontmatter(options.meta, options.content);
    await fs.writeFile(filePath, fileContent, "utf-8");

    return filePath;
  }

  /**
   * 读取一条记忆。
   * 不存在时返回 null。
   */
  async load(category: MemoryCategory, id: string): Promise<MemoryEntry | null> {
    const filePath = this.resolvePath(category, id);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    const parsed = parseFrontmatter(raw);

    return {
      category,
      id,
      meta: parsed.data as Record<string, unknown>,
      content: parsed.content,
      filePath,
    };
  }

  /**
   * 删除一条记忆。
   * 不存在时静默返回 false。
   */
  async delete(category: MemoryCategory, id: string): Promise<boolean> {
    const filePath = this.resolvePath(category, id);

    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出某个类别下的所有记忆。
   * 返回 id 列表（不含扩展名）。
   */
  async list(category: MemoryCategory): Promise<MemoryEntry[]> {
    const dir = this.categoryDir(category);

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }

    const entries: MemoryEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      // 跳过 .archive 等隐藏目录的文件
      const id = file.slice(0, -3);
      const entry = await this.load(category, id);
      if (entry) entries.push(entry);
    }

    return entries;
  }

  /**
   * 搜索所有类别中与关键词匹配的记忆。
   * 简单子串匹配（搜索 title/name/content 字段）。
   */
  async search(query: string): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    const q = query.toLowerCase();

    for (const category of ["profile", "person", "skill"] as MemoryCategory[]) {
      const entries = await this.list(category);
      for (const entry of entries) {
        const searchable = [
          entry.id,
          String(entry.meta.title ?? ""),
          String(entry.meta.name ?? ""),
          String(entry.meta.tags ?? ""),
          entry.content,
        ].join(" ").toLowerCase();

        if (searchable.includes(q)) {
          results.push(entry);
        }
      }
    }

    return results;
  }

  // ─── 路径工具 ───

  private categoryDir(category: MemoryCategory): string {
    switch (category) {
      case "profile": return this.baseDir;
      case "person": return path.join(this.baseDir, "people");
      case "skill": return path.join(this.baseDir, "skills");
      case "journal": return path.join(this.baseDir, "journal");
    }
  }

  private resolvePath(category: MemoryCategory, id: string): string {
    if (category === "profile") {
      return path.join(this.baseDir, "profile.md");
    }
    return path.join(this.categoryDir(category), `${id}.md`);
  }
}
