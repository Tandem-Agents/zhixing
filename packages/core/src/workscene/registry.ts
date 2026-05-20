/**
 * FsWorkSceneRegistry — 工作场景登记的文件系统实现
 *
 * 持久化布局见 ./paths.ts。两类持久化分工：
 *   - index.json：已注册 id 集合（成员关系）—— 决定 list/get 能否看到该场景
 *   - <id>/meta.json：该场景权威记录（全部可变字段）
 *
 * 删除语义：`remove(id)` 同时摘 index 并物理 rm 系统目录（meta + me + conversations）—— 不可恢复。
 * 用户的 `workdir` 永远不动。"软隐藏可恢复" 走 `setArchived`，与 remove 语义分工独立。
 *
 * 并发安全同构复用 conversation repository：per-id meta 锁串行同场景读写、
 * 单一 index 锁串行 index.json 读-改-写、writeAtomic 保单文件写入完整。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../transcript/serializer.js";
import {
  getWorkSceneDir,
  getWorkSceneIndexPath,
} from "./paths.js";
import type { IWorkSceneRegistry, WorkScene } from "./types.js";

interface WorkSceneIndex {
  /** 已注册 id，按注册顺序追加；list 输出另按 lastActiveAt 排序。 */
  scenes: string[];
}

function metaPath(id: string): string {
  return path.join(getWorkSceneDir(id), "meta.json");
}

// ─── id 生成 ───

function autoSceneId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `scene-${date}-${rand}`;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || autoSceneId()
  );
}

export class FsWorkSceneRegistry implements IWorkSceneRegistry {
  /**
   * Per-id meta 写入/读取锁。同 id 的 meta 操作 FIFO 串行；跨 id 不互斥。
   * 锁尾链 + GC 防长寿进程锁表单调增长（同构复用 conversation repository）。
   */
  private readonly metaLocks = new Map<string, Promise<unknown>>();
  /** 单一 index.json 读-改-写串行锁。 */
  private indexLock: Promise<unknown> = Promise.resolve();

  async list(opts?: { includeArchived?: boolean }): Promise<WorkScene[]> {
    const ids = await this.withIndexLock(() => this.readIndex());
    const scenes: WorkScene[] = [];
    for (const id of ids.scenes) {
      const meta = await this.readMeta(id);
      if (!meta) continue;
      if (!opts?.includeArchived && meta.archived) continue;
      scenes.push(meta);
    }
    return scenes.sort(
      (a, b) =>
        new Date(b.lastActiveAt).getTime() -
        new Date(a.lastActiveAt).getTime(),
    );
  }

  async get(id: string): Promise<WorkScene | null> {
    return this.readMeta(id);
  }

  async add(opts: { name: string; workdir?: string }): Promise<WorkScene> {
    // 全程持 index 锁：ensureUnique → 写 meta → 追加 index 原子完成，
    // 避免并发 add 抢同一 slug。writeMeta 内层 per-id 锁不与之死锁
    // （不同锁、固定外 index → 内 meta 顺序）。
    return this.withIndexLock(async () => {
      const index = await this.readIndex();
      const taken = new Set(index.scenes);
      const id = this.uniqueId(slugify(opts.name), taken);
      const now = new Date().toISOString();
      const scene: WorkScene = {
        id,
        name: opts.name,
        ...(opts.workdir !== undefined ? { workdir: opts.workdir } : {}),
        createdAt: now,
        lastActiveAt: now,
      };
      // meta 先落盘再进 index：中途失败至多留未注册的孤儿目录（不被 list
      // 列出，语义等价"未注册"），不会出现 index 指向缺失 meta。
      await this.writeMeta(scene);
      await this.writeIndex({ scenes: [...index.scenes, id] });
      return scene;
    });
  }

  /**
   * 彻底移除：先从 index 摘 id（让 list/get 立即失效），再 fs.rm 物理删除系统目录
   * （meta.json + 记忆域 me/ + 会话域 conversations/）。**workdir 不动**。
   *
   * 顺序由不变量决定，与 `add`（meta 先落盘再进 index）对偶：
   *   - index 先摘 → 即便 rm 失败也不会出现"已 remove 但仍在 list"假象（一致性优先）
   *   - rm 用 `force: true` → 目录本就不存在 / 上一次 remove 中途崩溃留下的部分目录，
   *     统统能被清掉，幂等不抛错
   *
   * 锁协调：
   *   - `indexLock` 串行 index 读-改-写，防并发 remove 撞写
   *   - per-id `metaLock` 包住 fs.rm，防与并发 `readMeta` / `writeMeta` 撞 ENOENT
   *   - 不在 caller 显式 `metaLocks.delete(id)`：withMetaLock 内部 `tail.then` 已有
   *     "若当前 tail 仍是自己则 delete" 的 GC；caller 强制 delete 会抹掉并发 op 的
   *     tail 引用，破坏后续同 id 串行不变量
   */
  async remove(id: string): Promise<void> {
    await this.withIndexLock(async () => {
      const index = await this.readIndex();
      await this.writeIndex({
        scenes: index.scenes.filter((s) => s !== id),
      });
    });
    await this.withMetaLock(id, async () => {
      await fs.rm(getWorkSceneDir(id), { recursive: true, force: true });
    });
  }

  async rename(id: string, name: string): Promise<WorkScene> {
    return this.mutateMeta(id, (scene) => {
      scene.name = name;
    });
  }

  async setArchived(id: string, archived: boolean): Promise<WorkScene> {
    return this.mutateMeta(id, (scene) => {
      scene.archived = archived;
    });
  }

  async touch(id: string): Promise<void> {
    await this.mutateMeta(id, (scene) => {
      scene.lastActiveAt = new Date().toISOString();
    });
  }

  // ─── 内部：meta 读写（per-id 锁） ───

  private async readMeta(id: string): Promise<WorkScene | null> {
    // Per-id 锁保护读路径：Windows 原子写 unlink+rename 间有瞬态文件缺失窗口，
    // 并发 readFile 撞上会 ENOENT —— 读走同一把锁看到完整 meta（同构复用
    // conversation repository 的读路径锁）。
    return this.withMetaLock(id, async () => {
      try {
        const content = await fs.readFile(metaPath(id), "utf-8");
        return JSON.parse(content) as WorkScene;
      } catch {
        return null;
      }
    });
  }

  private async writeMeta(scene: WorkScene): Promise<void> {
    return this.withMetaLock(scene.id, async () => {
      await writeAtomic(
        metaPath(scene.id),
        JSON.stringify(scene, null, 2),
      );
    });
  }

  /** 在同一把 per-id 锁内做"读-改字段-写"原子操作；不存在则抛。 */
  private async mutateMeta(
    id: string,
    apply: (scene: WorkScene) => void,
  ): Promise<WorkScene> {
    return this.withMetaLock(id, async () => {
      const content = await fs
        .readFile(metaPath(id), "utf-8")
        .catch(() => null);
      if (content === null) {
        throw new Error(`工作场景 "${id}" 不存在`);
      }
      const scene = JSON.parse(content) as WorkScene;
      apply(scene);
      await writeAtomic(metaPath(id), JSON.stringify(scene, null, 2));
      return scene;
    });
  }

  private async withMetaLock<T>(
    id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.metaLocks.get(id) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.metaLocks.set(id, tail);
    tail.then(() => {
      if (this.metaLocks.get(id) === tail) {
        this.metaLocks.delete(id);
      }
    });
    return result;
  }

  // ─── 内部：index 读写（单一锁） ───

  private async readIndex(): Promise<WorkSceneIndex> {
    try {
      const content = await fs.readFile(getWorkSceneIndexPath(), "utf-8");
      const parsed = JSON.parse(content) as Partial<WorkSceneIndex>;
      return { scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [] };
    } catch {
      return { scenes: [] };
    }
  }

  private async writeIndex(index: WorkSceneIndex): Promise<void> {
    await writeAtomic(
      getWorkSceneIndexPath(),
      JSON.stringify(index, null, 2),
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

  private uniqueId(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base;
    for (let i = 2; i <= 100; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return autoSceneId();
  }
}
