import fs from "node:fs/promises";
import path from "node:path";
import { toSafePathSegment } from "../paths.js";
import { PathGuard } from "../security/path-guard.js";
import { writeAtomic } from "../transcript/serializer.js";
import {
  parseRubricDocument,
  rubricDocumentId,
  stringifyRubricDraft,
} from "./document.js";
import {
  RUBRIC_FILE,
  getRubricsRoot,
  rubricSourceRoot,
  rubricsArchivedRoot,
  rubricsIndexPath,
} from "./paths.js";
import type {
  RubricAsset,
  RubricDraft,
  RubricIndexEntry,
  RubricRecord,
  RubricSource,
  RubricState,
} from "./types.js";

const SCAN_SOURCES: readonly RubricSource[] = ["linked", "own"];

interface DiscoveredRubric {
  id: string;
  title: string;
  description: string;
  source: RubricSource;
  dir: string;
  file: string;
}

export class RubricStore {
  private readonly root: string;
  private indexLock: Promise<unknown> = Promise.resolve();

  constructor(root: string = getRubricsRoot()) {
    this.root = root;
  }

  async listForMatching(): Promise<RubricIndexEntry[]> {
    return (await this.discoverWithState()).map(
      ({ id, title, description, source, createdAt, updatedAt }) => ({
        id,
        title,
        description,
        source,
        createdAt,
        updatedAt,
      }),
    );
  }

  async load(id: string): Promise<RubricAsset> {
    const located = await this.locate(id);
    this.assertWithinRoot(located.file);
    const raw = await fs.readFile(located.file, "utf-8");
    const document = parseRubricDocument(raw);
    const state = await this.ensureState(located.id);
    return {
      id: located.id,
      title: document.title,
      description: document.description,
      source: located.source,
      dir: located.dir,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      document,
      file: located.file,
    };
  }

  async saveOwn(draft: RubricDraft): Promise<RubricRecord> {
    const raw = stringifyRubricDraft(draft);
    const document = parseRubricDocument(raw);
    const id = rubricDocumentId(document);
    if (!id) throw new Error(`Rubric title 无效:${document.title}`);
    if ((await this.scan()).has(id)) {
      throw new Error(`Rubric id "${id}" 已存在,不能重复创建`);
    }

    const dir = await this.reserveDir(
      rubricSourceRoot(this.root, "own"),
      toSafePathSegment(id),
    );
    const file = path.join(dir, RUBRIC_FILE);
    this.assertWithinRoot(file);
    await writeAtomic(file, raw);

    const now = new Date().toISOString();
    await this.withIndexLock(async () => {
      const cur = await this.readIndex();
      cur.set(id, { id, createdAt: now, updatedAt: now });
      await this.writeIndex(cur);
    });

    return {
      id,
      title: document.title,
      description: document.description,
      source: "own",
      dir,
      createdAt: now,
      updatedAt: now,
    };
  }

  async archive(id: string): Promise<void> {
    const located = await this.locate(id);
    await fs.mkdir(rubricsArchivedRoot(this.root), { recursive: true });
    const dest = await this.reserveDir(
      rubricsArchivedRoot(this.root),
      path.basename(located.dir),
    );
    await this.movePath(located.dir, dest);
  }

  private async locate(id: string): Promise<DiscoveredRubric> {
    const found = (await this.scan()).get(id);
    if (!found) throw new Error(`Rubric "${id}" 不存在`);
    return found;
  }

  private async scan(): Promise<Map<string, DiscoveredRubric>> {
    const map = new Map<string, DiscoveredRubric>();
    for (const source of SCAN_SOURCES) {
      for (const [id, rubric] of await this.scanSource(source)) {
        map.set(id, rubric);
      }
    }
    return map;
  }

  private async scanSource(
    source: RubricSource,
  ): Promise<Map<string, DiscoveredRubric>> {
    const map = new Map<string, DiscoveredRubric>();
    const base = rubricSourceRoot(this.root, source);
    const entries = await fs
      .readdir(base, { withFileTypes: true })
      .catch(() => []);

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(base, entry.name);
      const file = path.join(dir, RUBRIC_FILE);
      try {
        this.assertWithinRoot(file);
        const raw = await fs.readFile(file, "utf-8");
        const document = parseRubricDocument(raw);
        const id = rubricDocumentId(document);
        if (!id) continue;
        map.set(id, {
          id,
          title: document.title,
          description: document.description,
          source,
          dir,
          file,
        });
      } catch {
        continue;
      }
    }
    return map;
  }

  private async discoverWithState(): Promise<RubricRecord[]> {
    const discovered = await this.scan();
    const states = await this.withIndexLock(async () => {
      const cur = await this.readIndex();
      let changed = false;
      const now = new Date().toISOString();
      for (const id of discovered.keys()) {
        if (!cur.has(id)) {
          cur.set(id, { id, createdAt: now, updatedAt: now });
          changed = true;
        }
      }
      if (changed) {
        try {
          await this.writeIndex(cur);
        } catch {
          // 索引旁路写失败不阻断读取，下次扫描会重新补齐。
        }
      }
      return cur;
    });

    const records: RubricRecord[] = [];
    for (const rubric of discovered.values()) {
      const state = states.get(rubric.id);
      if (!state) continue;
      records.push({
        id: rubric.id,
        title: rubric.title,
        description: rubric.description,
        source: rubric.source,
        dir: rubric.dir,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    }

    return records.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id.localeCompare(b.id);
    });
  }

  private async ensureState(id: string): Promise<RubricState> {
    return this.withIndexLock(async () => {
      const cur = await this.readIndex();
      const existing = cur.get(id);
      if (existing) return existing;
      const now = new Date().toISOString();
      const state = { id, createdAt: now, updatedAt: now };
      cur.set(id, state);
      await this.writeIndex(cur);
      return state;
    });
  }

  private async reserveDir(parent: string, baseSegment: string): Promise<string> {
    await fs.mkdir(parent, { recursive: true });
    let candidate = path.join(parent, baseSegment);
    for (let i = 2; await this.pathExists(candidate); i++) {
      candidate = path.join(parent, `${baseSegment}-${i}`);
    }
    return candidate;
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async movePath(src: string, dest: string): Promise<void> {
    try {
      await fs.rename(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EXDEV") {
        await fs.cp(src, dest, { recursive: true });
        await fs.rm(src, { recursive: true, force: true });
        return;
      }
      throw e;
    }
  }

  private assertWithinRoot(filePath: string): void {
    if (!PathGuard.isWithinWorkspace(filePath, this.root, this.root)) {
      throw new Error(`路径越界,拒绝访问:${filePath}`);
    }
  }

  private async readIndex(): Promise<Map<string, RubricState>> {
    try {
      const raw = await fs.readFile(rubricsIndexPath(this.root), "utf-8");
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return new Map();
      const entries: [string, RubricState][] = [];
      for (const item of arr) {
        if (!isRubricState(item)) continue;
        entries.push([item.id, item]);
      }
      return new Map(entries);
    } catch {
      return new Map();
    }
  }

  private async writeIndex(states: Map<string, RubricState>): Promise<void> {
    await writeAtomic(
      rubricsIndexPath(this.root),
      JSON.stringify([...states.values()], null, 2),
    );
  }

  private async withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.indexLock.then(fn);
    this.indexLock = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

function isRubricState(value: unknown): value is RubricState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<RubricState>;
  return (
    typeof state.id === "string" &&
    typeof state.createdAt === "string" &&
    typeof state.updatedAt === "string"
  );
}
