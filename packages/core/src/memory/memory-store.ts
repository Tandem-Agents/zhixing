/**
 * MemoryStore — filesystem compatibility projection for logical memory.
 *
 * Global memory authority is the production source of truth. The anchor
 * adapter uses this store only to import legacy Markdown and materialize the
 * compatibility view.
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { ensureDurableDirectory, syncDirectory } from "../persistence/durable-directory.js";
import { assertMemoryStorageIdentity } from "./canonical-identity.js";

// ─── 类型 ───

export type MemoryCategory = "profile" | "person" | "journal";

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

export interface LegacyMemoryEntry extends MemoryEntry {
  /** Stable path relative to the owned memory root. */
  sourceIdentity: string;
  modifiedAt: string;
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

  /**
   * root 必填 —— 调用方必须显式给出记忆域根（personal = getMemoryDir()，
   * workscene = getWorkSceneMemoryDir(id)）。不提供隐式默认是 by-construction
   * 的 scope 隔离前提：杜绝工作场景下误用而静默写穿个人记忆域。
   */
  constructor(root: string) {
    this.baseDir = root;
  }

  /**
   * 保存一条记忆。如果文件已存在则覆盖。
   * 自动创建目录结构。
   */
  async save(options: SaveOptions): Promise<string> {
    const filePath = this.resolvePath(options.category, options.id);
    const dir = path.dirname(filePath);

    await ensureDurableDirectory(dir);
    const fileContent = stringifyFrontmatter(options.meta, options.content);
    const temporary = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(fileContent, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, filePath);
      await syncDirectory(dir);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }

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
      await syncDirectory(path.dirname(filePath));
      return true;
    } catch (error) {
      if (isMissingPath(error)) return false;
      throw error;
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

    for (const category of ["profile", "person"] as MemoryCategory[]) {
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

  /** Reads the frozen legacy source without converting I/O failures into absence. */
  async readAuthorityTakeoverSnapshot(): Promise<LegacyMemoryEntry[]> {
    const profile = await this.readLegacyFile(
      "profile",
      "profile",
      path.join(this.baseDir, "profile.md"),
      "profile.md",
    );
    return [
      ...(profile ? [profile] : []),
      ...(await this.readLegacyTree("person")),
      ...(await this.readLegacyTree("journal")),
    ];
  }

  // ─── 路径工具 ───

  private categoryDir(category: MemoryCategory): string {
    switch (category) {
      case "profile": return this.baseDir;
      case "person": return path.join(this.baseDir, "people");
      case "journal": return path.join(this.baseDir, "journal");
    }
  }

  private resolvePath(category: MemoryCategory, id: string): string {
    assertMemoryStorageIdentity(category, id);
    const categoryRoot = path.resolve(this.categoryDir(category));
    if (category === "profile") {
      return path.join(categoryRoot, "profile.md");
    }
    const target = path.resolve(categoryRoot, `${id}.md`);
    if (path.dirname(target) !== categoryRoot) {
      throw new TypeError("Memory target must be a direct child of its category directory");
    }
    return target;
  }

  private async readLegacyTree(
    category: "person" | "journal",
  ): Promise<LegacyMemoryEntry[]> {
    const ownedRoot = path.resolve(this.categoryDir(category));
    const entries: LegacyMemoryEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      const resolved = path.resolve(directory);
      if (resolved !== ownedRoot && !resolved.startsWith(`${ownedRoot}${path.sep}`)) {
        throw new Error("Legacy memory source escaped its owned root");
      }
      let directoryStat;
      try {
        directoryStat = await fs.lstat(resolved);
      } catch (error) {
        if (resolved === ownedRoot && isMissingPath(error)) return;
        throw error;
      }
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error("Legacy memory owned root contains an unsafe directory entry");
      }
      const children = await fs.readdir(resolved, { withFileTypes: true });
      for (const child of children.sort((left, right) =>
        left.name.localeCompare(right.name, "en-US")
      )) {
        const childPath = path.resolve(resolved, child.name);
        if (!childPath.startsWith(`${ownedRoot}${path.sep}`)) {
          throw new Error("Legacy memory source escaped its owned root");
        }
        if (child.isSymbolicLink()) {
          throw new Error("Legacy memory source must not contain symbolic links");
        }
        if (child.isDirectory()) {
          await visit(childPath);
          continue;
        }
        if (!child.isFile() || !child.name.endsWith(".md")) continue;
        const relative = path.relative(ownedRoot, childPath);
        const id = relative.slice(0, -3).split(path.sep).join("/");
        const sourceIdentity = `${category === "person" ? "people" : "journal"}/${relative
          .split(path.sep)
          .join("/")}`;
        const entry = await this.readLegacyFile(
          category,
          id,
          childPath,
          sourceIdentity,
        );
        if (!entry) {
          throw new Error("Legacy memory changed while its source set was frozen");
        }
        entries.push(entry);
      }
    };
    await visit(ownedRoot);
    return entries;
  }

  private async readLegacyFile(
    category: MemoryCategory,
    id: string,
    filePath: string,
    sourceIdentity: string,
  ): Promise<LegacyMemoryEntry | null> {
    const ownedRoot = path.resolve(this.categoryDir(category));
    let pathStat: Stats;
    let resolvedSource: string;
    let resolvedRoot: string;
    try {
      [pathStat, resolvedSource, resolvedRoot] = await Promise.all([
        fs.lstat(filePath),
        fs.realpath(filePath),
        fs.realpath(ownedRoot),
      ]);
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw error;
    }
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error("Legacy memory source must be a regular owned file");
    }
    assertPathInside(resolvedRoot, resolvedSource);
    let handle;
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new Error("Legacy memory source must be a regular file");
      }
      const [openedPathStat, openedSource] = await Promise.all([
        fs.lstat(filePath),
        fs.realpath(filePath),
      ]);
      if (
        openedPathStat.isSymbolicLink() ||
        !openedPathStat.isFile() ||
        before.dev !== openedPathStat.dev ||
        before.ino !== openedPathStat.ino
      ) {
        throw new Error("Legacy memory source changed before its owned read");
      }
      assertPathInside(resolvedRoot, openedSource);
      const raw = await handle.readFile("utf-8");
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error("Legacy memory changed while its source set was frozen");
      }
      const parsed = parseFrontmatter(raw);
      return {
        category,
        id,
        meta: parsed.data as Record<string, unknown>,
        content: parsed.content,
        filePath,
        sourceIdentity,
        modifiedAt: after.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }
}

function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Legacy memory source escaped its owned root");
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
