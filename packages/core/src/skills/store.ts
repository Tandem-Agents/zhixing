/**
 * SkillStore —— 技能库的唯一磁盘访问点(读路径)。
 *
 * 存在性以磁盘目录(own / linked)为唯一真相;index.json 只是状态旁路,
 * 损坏不致命(技能仍在、状态重置)。所有文件读都经库根 realpath 边界一处收口
 * (复用权限模块 PathGuard,防 own 内软链指向库外越权读取)。坏 SKILL.md /
 * 无 name / 越界的技能一律隔离跳过,不污染全局。
 *
 * 并发:单一 index 锁串行 index.json 的读-改-写;per-id 锁串行同技能 usage 写。
 * 两类锁互不嵌套(投影只取 index 锁、loadText 只取 id 锁),无死锁。范式同
 * workscene/registry。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../transcript/serializer.js";
import { PathGuard } from "../security/path-guard.js";
import { parseFrontmatter } from "../memory/frontmatter.js";
import { skillNameToId } from "./id.js";
import {
  getSkillsRoot,
  skillsIndexPath,
  sourceRoot,
  usageDir,
  usagePath,
} from "./paths.js";
import type {
  SkillMode,
  SkillRecord,
  SkillSource,
  SkillState,
  SkillUsage,
} from "./types.js";

const SKILL_FILE = "SKILL.md";
/** 先扫 linked、再扫 own —— own 对同 id 后写遮蔽 linked。 */
const SCAN_SOURCES: readonly SkillSource[] = ["linked", "own"];

/** scan 阶段的一条技能(尚未并入 index 状态)。 */
interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  dir: string;
}

export class SkillStore {
  private readonly root: string;
  private readonly idLocks = new Map<string, Promise<unknown>>();
  private indexLock: Promise<unknown> = Promise.resolve();

  constructor(root: string = getSkillsRoot()) {
    this.root = root;
  }

  /** 全量(剔 disabled),供 `/<name>` 补全。与 queryTopN 共享同一投影管线。 */
  async listAll(): Promise<SkillRecord[]> {
    return this.project({});
  }

  /** 按 mode 过滤 + 排序 + 取前 n,供索引产生。与 listAll 共享单一过滤点。 */
  async queryTopN(mode: SkillMode, n: number): Promise<SkillRecord[]> {
    return this.project({ mode, limit: n });
  }

  /**
   * 取技能全文(正文)+ 记一次命中度量。读前经库根 realpath 边界收口,越界即拒;
   * 不存在即抛。usage 写不标 dirty(频次只被动影响下次排序)。
   */
  async loadText(
    id: string,
  ): Promise<{ id: string; name: string; body: string }> {
    const located = (await this.scan()).get(id);
    if (!located) throw new Error(`技能 "${id}" 不存在`);
    const file = path.join(located.dir, SKILL_FILE);
    this.assertWithinRoot(file);
    const raw = await fs.readFile(file, "utf-8");
    const { content } = parseFrontmatter(raw);
    await this.recordHit(id);
    return { id, name: located.name, body: content };
  }

  // ─── 投影:单一过滤 + 排序 + 限量 ───

  private async project(opts: {
    mode?: SkillMode;
    limit?: number;
  }): Promise<SkillRecord[]> {
    const records = await this.discoverWithState();
    let filtered = records.filter((r) => !r.disabled);
    if (opts.mode) filtered = filtered.filter((r) => r.mode === opts.mode);
    const ranked = await this.rank(filtered);
    return opts.limit !== undefined ? ranked.slice(0, opts.limit) : ranked;
  }

  /** pinned 优先;其余按 (usage.lastHitAt ?? createdAt) 降序,hitCount 作 tiebreaker。 */
  private async rank(records: SkillRecord[]): Promise<SkillRecord[]> {
    const keyed = await Promise.all(
      records.map(async (r) => {
        const usage = await this.readUsage(r.id);
        return {
          r,
          recency: usage?.lastHitAt ?? r.createdAt,
          hitCount: usage?.hitCount ?? 0,
        };
      }),
    );
    keyed.sort((a, b) => {
      if (a.r.pinned !== b.r.pinned) return a.r.pinned ? -1 : 1;
      if (a.recency !== b.recency) return a.recency < b.recency ? 1 : -1;
      return b.hitCount - a.hitCount;
    });
    return keyed.map((k) => k.r);
  }

  // ─── 扫描发现 ───

  private async scan(): Promise<Map<string, DiscoveredSkill>> {
    const map = new Map<string, DiscoveredSkill>();
    for (const source of SCAN_SOURCES) {
      const base = sourceRoot(this.root, source);
      const entries = await fs
        .readdir(base, { withFileTypes: true })
        .catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillDir = path.join(base, entry.name);
        const file = path.join(skillDir, SKILL_FILE);
        try {
          // realpath 边界:own 内软链指向库外即越界 → 抛 → 隔离跳过。
          this.assertWithinRoot(file);
          const raw = await fs.readFile(file, "utf-8");
          const { data } = parseFrontmatter(raw);
          const name = typeof data.name === "string" ? data.name.trim() : "";
          if (!name) continue; // 无 name:坏 SKILL.md,隔离
          const id = skillNameToId(name);
          if (!id) continue; // 退化名 → 空 id,隔离
          const description =
            typeof data.description === "string" ? data.description.trim() : "";
          map.set(id, { id, name, description, source, dir: skillDir });
        } catch {
          continue; // 不可读 / 解析失败 / 越界:隔离该技能,不污染全局
        }
      }
    }
    return map;
  }

  /** 扫描 + 并入 index 状态;首次扫到的技能持久化默认状态(持久化失败不阻塞读)。 */
  private async discoverWithState(): Promise<SkillRecord[]> {
    const discovered = await this.scan();
    const states = await this.withIndexLock(async () => {
      const cur = await this.readIndex();
      let changed = false;
      const now = new Date().toISOString();
      for (const id of discovered.keys()) {
        if (!cur.has(id)) {
          cur.set(id, {
            id,
            mode: "main",
            pinned: false,
            disabled: false,
            createdAt: now,
          });
          changed = true;
        }
      }
      if (changed) {
        try {
          await this.writeIndex(cur);
        } catch {
          // 状态持久化失败不阻塞读:本次用内存默认状态,下次扫描再试落盘。
        }
      }
      return cur;
    });

    const records: SkillRecord[] = [];
    for (const d of discovered.values()) {
      const st = states.get(d.id);
      if (!st) continue; // 上面已 ensure;防御性跳过
      records.push({
        id: d.id,
        name: d.name,
        description: d.description,
        source: d.source,
        dir: d.dir,
        mode: st.mode,
        pinned: st.pinned,
        disabled: st.disabled,
        createdAt: st.createdAt,
      });
    }
    return records;
  }

  // ─── 库根 realpath 边界(一处强制) ───

  private assertWithinRoot(filePath: string): void {
    if (!PathGuard.isWithinWorkspace(filePath, this.root, this.root)) {
      throw new Error(`路径越界,拒绝访问:${filePath}`);
    }
  }

  // ─── index.json 状态旁路(单一锁) ───

  private async readIndex(): Promise<Map<string, SkillState>> {
    try {
      const raw = await fs.readFile(skillsIndexPath(this.root), "utf-8");
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return new Map();
      const entries: [string, SkillState][] = [];
      for (const s of arr as SkillState[]) {
        if (s && typeof s.id === "string") entries.push([s.id, s]);
      }
      return new Map(entries);
    } catch {
      return new Map();
    }
  }

  private async writeIndex(states: Map<string, SkillState>): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await writeAtomic(
      skillsIndexPath(this.root),
      JSON.stringify([...states.values()], null, 2),
    );
  }

  // ─── usage 度量旁路(per-id 锁) ───

  private async readUsage(id: string): Promise<SkillUsage | null> {
    try {
      const raw = await fs.readFile(usagePath(this.root, id), "utf-8");
      const u = JSON.parse(raw) as SkillUsage;
      return u && typeof u.hitCount === "number" ? u : null;
    } catch {
      return null;
    }
  }

  private async recordHit(id: string): Promise<void> {
    await this.withIdLock(id, async () => {
      const cur = await this.readUsage(id);
      const next: SkillUsage = {
        lastHitAt: new Date().toISOString(),
        hitCount: (cur?.hitCount ?? 0) + 1,
      };
      await fs.mkdir(usageDir(this.root), { recursive: true });
      await writeAtomic(usagePath(this.root, id), JSON.stringify(next, null, 2));
    });
  }

  // ─── 锁(范式仿 workscene/registry) ───

  private async withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.indexLock.then(fn);
    this.indexLock = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async withIdLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.idLocks.get(id) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.idLocks.set(id, tail);
    tail.then(() => {
      if (this.idLocks.get(id) === tail) this.idLocks.delete(id);
    });
    return result;
  }
}
