/**
 * One-way compatibility boundary for the pre-authority Markdown memory tree.
 *
 * The authority log remains the only production fact source. This component
 * freezes legacy input for the one-time cutover and materializes an explicitly
 * derived compatibility view; it never exposes a second memory store API.
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDurableDirectory,
  syncDirectory,
} from "../persistence/durable-directory.js";
import { assertMemoryStorageIdentity } from "./canonical-identity.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

export type LegacyMemoryCategory = "profile" | "person" | "journal";

export interface LegacyMarkdownMemoryEntry {
  readonly category: LegacyMemoryCategory;
  readonly id: string;
  readonly meta: Record<string, unknown>;
  readonly content: string;
  readonly sourceIdentity: string;
  readonly modifiedAt: string;
}

interface MissingRootBinding {
  readonly kind: "missing";
  readonly lexicalPath: string;
}

interface DirectoryRootBinding {
  readonly kind: "directory";
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
}

type RootBinding = MissingRootBinding | DirectoryRootBinding;

export class LegacyMarkdownMemoryProjection {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async materialize(input: {
    readonly category: LegacyMemoryCategory;
    readonly id: string;
    readonly meta: Record<string, unknown>;
    readonly content: string;
  }): Promise<void> {
    const filePath = this.#resolvePath(input.category, input.id);
    const directory = path.dirname(filePath);
    await ensureDurableDirectory(directory);
    const temporary = path.join(
      directory,
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(
          stringifyFrontmatter(input.meta, input.content),
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, filePath);
      await syncDirectory(directory);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async remove(category: LegacyMemoryCategory, id: string): Promise<void> {
    const filePath = this.#resolvePath(category, id);
    try {
      await fs.unlink(filePath);
      await syncDirectory(path.dirname(filePath));
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }

  async readAuthorityTakeoverSnapshot(): Promise<LegacyMarkdownMemoryEntry[]> {
    const scopeRoot = await this.#bindRoot(this.#root);
    if (scopeRoot.kind === "missing") {
      await this.#assertRootBinding(scopeRoot);
      return [];
    }
    const peopleRoot = await this.#bindRoot(
      this.#categoryRoot("person"),
      scopeRoot,
    );
    const journalRoot = await this.#bindRoot(
      this.#categoryRoot("journal"),
      scopeRoot,
    );
    const bindings = [scopeRoot, peopleRoot, journalRoot] as const;
    await this.#assertRootBindings(bindings);

    const profile = await this.#readFile(
      "profile",
      "profile",
      path.join(this.#root, "profile.md"),
      "profile.md",
      scopeRoot,
      [scopeRoot],
    );
    const entries = [
      ...(profile ? [profile] : []),
      ...(peopleRoot.kind === "directory"
        ? await this.#readTree("person", scopeRoot, peopleRoot)
        : []),
      ...(journalRoot.kind === "directory"
        ? await this.#readTree("journal", scopeRoot, journalRoot)
        : []),
    ];
    await this.#assertRootBindings(bindings);
    return entries;
  }

  #categoryRoot(category: LegacyMemoryCategory): string {
    if (category === "profile") return this.#root;
    return path.join(this.#root, category === "person" ? "people" : "journal");
  }

  #resolvePath(category: LegacyMemoryCategory, id: string): string {
    assertMemoryStorageIdentity(category, id);
    const categoryRoot = path.resolve(this.#categoryRoot(category));
    if (category === "profile") return path.join(categoryRoot, "profile.md");
    const target = path.resolve(categoryRoot, `${id}.md`);
    if (path.dirname(target) !== categoryRoot) {
      throw new TypeError(
        "Derived Markdown memory target must be a direct child of its category directory",
      );
    }
    return target;
  }

  async #readTree(
    category: "person" | "journal",
    scopeRoot: DirectoryRootBinding,
    ownedRoot: DirectoryRootBinding,
  ): Promise<LegacyMarkdownMemoryEntry[]> {
    const rootBindings = [scopeRoot, ownedRoot] as const;
    const entries: LegacyMarkdownMemoryEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      await this.#assertRootBindings(rootBindings);
      const resolved = path.resolve(directory);
      if (
        resolved !== ownedRoot.lexicalPath &&
        !resolved.startsWith(`${ownedRoot.lexicalPath}${path.sep}`)
      ) {
        throw new Error("Legacy memory source escaped its owned root");
      }
      let directoryStat: Stats;
      try {
        directoryStat = await fs.lstat(resolved);
      } catch (error) {
        if (resolved === ownedRoot.lexicalPath && isMissingPath(error)) return;
        throw error;
      }
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error("Legacy memory owned root contains an unsafe directory entry");
      }
      const children = await fs.readdir(resolved, { withFileTypes: true });
      await this.#assertRootBindings(rootBindings);
      for (const child of children.sort((left, right) =>
        left.name.localeCompare(right.name, "en-US")
      )) {
        const childPath = path.resolve(resolved, child.name);
        if (!childPath.startsWith(`${ownedRoot.lexicalPath}${path.sep}`)) {
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
        const relative = path.relative(ownedRoot.lexicalPath, childPath);
        const id = relative.slice(0, -3).split(path.sep).join("/");
        const entry = await this.#readFile(
          category,
          id,
          childPath,
          `${category === "person" ? "people" : "journal"}/${relative
            .split(path.sep)
            .join("/")}`,
          ownedRoot,
          rootBindings,
        );
        if (!entry) {
          throw new Error("Legacy memory changed while its source set was frozen");
        }
        entries.push(entry);
      }
    };
    await visit(ownedRoot.lexicalPath);
    await this.#assertRootBindings(rootBindings);
    return entries;
  }

  async #readFile(
    category: LegacyMemoryCategory,
    id: string,
    filePath: string,
    sourceIdentity: string,
    ownedRoot: DirectoryRootBinding,
    rootBindings: readonly DirectoryRootBinding[],
  ): Promise<LegacyMarkdownMemoryEntry | null> {
    assertPathInside(ownedRoot.lexicalPath, path.resolve(filePath));
    await this.#assertRootBindings(rootBindings);
    let pathStat: Stats;
    let resolvedSource: string;
    try {
      [pathStat, resolvedSource] = await Promise.all([
        fs.lstat(filePath),
        fs.realpath(filePath),
      ]);
    } catch (error) {
      if (isMissingPath(error)) {
        await this.#assertRootBindings(rootBindings);
        return null;
      }
      throw error;
    }
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error("Legacy memory source must be a regular owned file");
    }
    assertPathInside(ownedRoot.canonicalPath, resolvedSource);
    const handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await handle.stat();
      const [openedPathStat, openedSource] = await Promise.all([
        fs.lstat(filePath),
        fs.realpath(filePath),
      ]);
      if (
        !before.isFile() ||
        openedPathStat.isSymbolicLink() ||
        !openedPathStat.isFile() ||
        !sameFile(before, openedPathStat)
      ) {
        throw new Error("Legacy memory source changed before its owned read");
      }
      assertPathInside(ownedRoot.canonicalPath, openedSource);
      await this.#assertRootBindings(rootBindings);
      const raw = await handle.readFile("utf8");
      const [after, finalPathStat, finalSource] = await Promise.all([
        handle.stat(),
        fs.lstat(filePath),
        fs.realpath(filePath),
      ]);
      if (
        !sameFile(before, after) ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        finalPathStat.isSymbolicLink() ||
        !finalPathStat.isFile() ||
        !sameFile(after, finalPathStat)
      ) {
        throw new Error("Legacy memory changed while its source set was frozen");
      }
      assertPathInside(ownedRoot.canonicalPath, finalSource);
      await this.#assertRootBindings(rootBindings);
      const parsed = parseFrontmatter(raw);
      return {
        category,
        id,
        meta: parsed.data as Record<string, unknown>,
        content: parsed.content,
        sourceIdentity,
        modifiedAt: after.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }

  async #bindRoot(
    rootPath: string,
    parent?: DirectoryRootBinding,
  ): Promise<RootBinding> {
    const lexicalPath = path.resolve(rootPath);
    let before: Stats;
    try {
      before = await fs.lstat(lexicalPath);
    } catch (error) {
      if (isMissingPath(error)) return { kind: "missing", lexicalPath };
      throw error;
    }
    assertSafeRoot(before);
    const canonicalPath = await fs.realpath(lexicalPath);
    const [after, canonical] = await Promise.all([
      fs.lstat(lexicalPath),
      fs.stat(canonicalPath),
    ]);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !canonical.isDirectory() ||
      !sameFile(before, after) ||
      !sameFile(after, canonical)
    ) {
      throw new Error("Legacy memory owned root changed while it was bound");
    }
    if (parent) assertPathInside(parent.canonicalPath, canonicalPath);
    return {
      kind: "directory",
      lexicalPath,
      canonicalPath,
      dev: after.dev,
      ino: after.ino,
    };
  }

  async #assertRootBindings(bindings: readonly RootBinding[]): Promise<void> {
    for (const binding of bindings) await this.#assertRootBinding(binding);
  }

  async #assertRootBinding(binding: RootBinding): Promise<void> {
    if (binding.kind === "missing") {
      try {
        await fs.lstat(binding.lexicalPath);
      } catch (error) {
        if (isMissingPath(error)) return;
        throw error;
      }
      throw new Error("Legacy memory owned root appeared while its source set was frozen");
    }
    let pathStat: Stats;
    let canonicalPath: string;
    try {
      [pathStat, canonicalPath] = await Promise.all([
        fs.lstat(binding.lexicalPath),
        fs.realpath(binding.lexicalPath),
      ]);
    } catch (error) {
      throw new Error(
        "Legacy memory owned root changed while its source set was frozen",
        { cause: error },
      );
    }
    const canonicalStat = await fs.stat(canonicalPath);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isDirectory() ||
      canonicalPath !== binding.canonicalPath ||
      pathStat.dev !== binding.dev ||
      pathStat.ino !== binding.ino ||
      !canonicalStat.isDirectory() ||
      !sameFile(pathStat, canonicalStat)
    ) {
      throw new Error("Legacy memory owned root changed while its source set was frozen");
    }
  }
}

function assertSafeRoot(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Legacy memory owned root must be a stable directory");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
