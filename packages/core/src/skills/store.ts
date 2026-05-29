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
import { parseFrontmatter, stringifyFrontmatter } from "../memory/frontmatter.js";
import { skillNameToId } from "./id.js";
import {
  archivedRoot,
  getSkillsRoot,
  skillsIndexPath,
  sourceRoot,
  usageDir,
  usagePath,
} from "./paths.js";
import type {
  ManagedSkillRecord,
  SkillDraft,
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
   * 面向管理的全集读 —— 全集(own + linked,**含 disabled**)+ 每条 usage,供
   * `/skills` 管理器浏览:显示 ⊘ 并就地重新启用、显示使用度。与剔 disabled 的
   * `listAll` / `queryTopN`(补全 / 索引用)区分:本读返回全集、无过滤,故不经
   * `project` 的过滤点,直接 `discoverWithState`(全集发现、本含 disabled)+
   * `rankWithUsage`(与上述两者排序共用同一 usage 旁路读、并把 usage 一并带回)。
   */
  async listForManagement(): Promise<ManagedSkillRecord[]> {
    return this.rankWithUsage(await this.discoverWithState());
  }

  /**
   * 取技能全文(正文)+ 记一次命中度量。读前经库根 realpath 边界收口,越界即拒;
   * 不存在即抛。usage 写不标 dirty(频次只被动影响下次排序)。
   */
  async loadText(
    id: string,
  ): Promise<{ id: string; name: string; body: string }> {
    const located = await this.locate(id);
    const file = path.join(located.dir, SKILL_FILE);
    this.assertWithinRoot(file);
    const raw = await fs.readFile(file, "utf-8");
    const { content } = parseFrontmatter(raw);
    await this.recordHit(id);
    return { id, name: located.name, body: content };
  }

  /**
   * 改技能状态(mode / pinned / disabled)。技能须存在于磁盘,否则抛
   * (不创建孤儿状态);createdAt 等其余字段保持不变。
   */
  async setState(
    id: string,
    patch: { mode?: SkillMode; pinned?: boolean; disabled?: boolean },
  ): Promise<void> {
    if (!(await this.scan()).has(id)) {
      throw new Error(`技能 "${id}" 不存在`);
    }
    await this.withIndexLock(async () => {
      const cur = await this.readIndex();
      const base: SkillState = cur.get(id) ?? {
        id,
        mode: "main",
        pinned: false,
        disabled: false,
        createdAt: new Date().toISOString(),
      };
      cur.set(id, { ...base, ...patch, id });
      await this.writeIndex(cur);
    });
  }

  /**
   * 归档(删=可逆):把技能目录物理移到 archived/(同名追加序号防覆盖),不物理删。
   * 移走后扫不到、不进 listAll;index 状态保留以便恢复。own / linked 皆可;同 id
   * 同时存在时归档 own(扫描遮蔽侧),归档后 linked 版本重新可见。
   */
  async archive(id: string): Promise<void> {
    const located = await this.locate(id);
    await fs.mkdir(archivedRoot(this.root), { recursive: true });
    const dest = await this.reserveDir(
      archivedRoot(this.root),
      path.basename(located.dir),
    );
    await this.movePath(located.dir, dest);
  }

  /**
   * 从草稿创建一个 own 技能。id = skillNameToId(name);空 id 拒、撞名(own/linked
   * 已有同 id)拒。写 SKILL.md(frontmatter + 正文)+ 登记状态,返回记录。
   */
  async create(draft: SkillDraft): Promise<SkillRecord> {
    const id = skillNameToId(draft.name);
    if (!id) throw new Error(`技能名无效(产出空 id):"${draft.name}"`);
    if ((await this.scan()).has(id)) {
      throw new Error(`技能 id "${id}" 已存在,不能重复创建`);
    }
    const dir = await this.reserveDir(sourceRoot(this.root, "own"), id);
    const file = path.join(dir, SKILL_FILE);
    this.assertWithinRoot(file);
    await fs.mkdir(dir, { recursive: true });
    const content = stringifyFrontmatter(
      { name: draft.name, description: draft.description },
      draft.body,
    );
    await writeAtomic(file, content);
    const createdAt = new Date().toISOString();
    await this.withIndexLock(async () => {
      const cur = await this.readIndex();
      cur.set(id, {
        id,
        mode: draft.mode,
        pinned: false,
        disabled: false,
        createdAt,
      });
      await this.writeIndex(cur);
    });
    return {
      id,
      name: draft.name,
      description: draft.description,
      source: "own",
      dir,
      mode: draft.mode,
      pinned: false,
      disabled: false,
      createdAt,
    };
  }

  /**
   * fork(linked → own,copy-on-write):把一个 linked 技能整目录复制到 own/<id>,
   * 原 linked 不动(可继续同步上游),扫描时 own 同 id 遮蔽 linked → 改后版本生效。
   * 需 linked 版本存在、own 版本尚不存在,否则抛。状态(同 id)沿用。
   */
  async fork(id: string): Promise<SkillRecord> {
    const linked = (await this.scanSource("linked")).get(id);
    if (!linked) throw new Error(`技能 "${id}" 无 linked 版本,无需 fork`);
    // 按 id 判已有 own 版本(own 目录名未必等于 id,不能只看 own/<id> 是否存在)。
    if ((await this.scanSource("own")).has(id)) {
      throw new Error(`技能 "${id}" 已有 own 版本`);
    }
    const ownDir = await this.reserveDir(sourceRoot(this.root, "own"), id);
    this.assertWithinRoot(path.join(ownDir, SKILL_FILE));
    try {
      // 复用唯一内容复制路径:逐文件原子写、拒符号链接(与 admit 一致),不另起 fs.cp。
      await this.copyTreeContent(linked.dir, ownDir);
    } catch (e) {
      await fs.rm(ownDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    const st = (await this.readIndex()).get(id);
    return {
      id,
      name: linked.name,
      description: linked.description,
      source: "own",
      dir: ownDir,
      mode: st?.mode ?? "main",
      pinned: st?.pinned ?? false,
      disabled: st?.disabled ?? false,
      createdAt: st?.createdAt ?? new Date().toISOString(),
    };
  }

  /**
   * 按草稿更新一个已存在技能。linked-only 触发 fork-on-edit(先复制到 own 再改)。
   * 改名(name 派生出不同 id)时迁移 index 状态与 usage 到新 id,并校验新 id 不撞名;
   * pinned / disabled / createdAt 跨更新保持。
   */
  async update(id: string, draft: SkillDraft): Promise<SkillRecord> {
    const located = await this.locate(id);
    const ownDir =
      located.source === "own" ? located.dir : (await this.fork(id)).dir;

    const newId = skillNameToId(draft.name);
    if (!newId) throw new Error(`技能名无效(产出空 id):"${draft.name}"`);
    if (newId !== id && (await this.scan()).has(newId)) {
      throw new Error(`改名目标 id "${newId}" 已存在`);
    }

    const prior = (await this.readIndex()).get(id);
    const pinned = prior?.pinned ?? false;
    const disabled = prior?.disabled ?? false;
    const createdAt = prior?.createdAt ?? new Date().toISOString();

    const file = path.join(ownDir, SKILL_FILE);
    this.assertWithinRoot(file);
    await writeAtomic(
      file,
      stringifyFrontmatter(
        { name: draft.name, description: draft.description },
        draft.body,
      ),
    );

    await this.withIndexLock(async () => {
      const cur = await this.readIndex();
      if (newId !== id) cur.delete(id);
      cur.set(newId, { id: newId, mode: draft.mode, pinned, disabled, createdAt });
      await this.writeIndex(cur);
    });
    if (newId !== id) {
      await fs
        .rename(usagePath(this.root, id), usagePath(this.root, newId))
        .catch(() => {
          // 无 usage 或重命名失败:忽略,新 id 度量从零起。
        });
    }

    return {
      id: newId,
      name: draft.name,
      description: draft.description,
      source: "own",
      dir: ownDir,
      mode: draft.mode,
      pinned,
      disabled,
      createdAt,
    };
  }

  /**
   * 接入(从 staging 暂存目录落 linked):读暂存 SKILL.md 取 name → id;空 id /
   * 撞名(own/linked 已有同 id)即拒;**逐文件原子 copy**(非目录 rename —— Windows
   * 跨卷不原子)到 linked/<id>,拒符号链接(防越界、保内容副本),失败回滚已写目录;
   * 全部成功后登记状态。暂存的清理由调用方(Admission 流程)负责。
   */
  async admit(
    stagingDir: string,
    opts?: { mode?: SkillMode },
  ): Promise<SkillRecord> {
    const raw = await fs.readFile(path.join(stagingDir, SKILL_FILE), "utf-8");
    const { data } = parseFrontmatter(raw);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) throw new Error("暂存技能缺少 name,无法接入");
    const id = skillNameToId(name);
    if (!id) throw new Error(`技能名无效(产出空 id):"${name}"`);
    if ((await this.scan()).has(id)) {
      throw new Error(`技能 id "${id}" 已存在,先归档旧版再接入`);
    }
    const description =
      typeof data.description === "string" ? data.description.trim() : "";
    const destDir = await this.reserveDir(sourceRoot(this.root, "linked"), id);
    this.assertWithinRoot(path.join(destDir, SKILL_FILE));
    try {
      await this.copyTreeContent(stagingDir, destDir);
    } catch (e) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    const mode: SkillMode = opts?.mode ?? "main";
    const createdAt = new Date().toISOString();
    await this.withIndexLock(async () => {
      const cur = await this.readIndex();
      cur.set(id, { id, mode, pinned: false, disabled: false, createdAt });
      await this.writeIndex(cur);
    });
    return {
      id,
      name,
      description,
      source: "linked",
      dir: destDir,
      mode,
      pinned: false,
      disabled: false,
      createdAt,
    };
  }

  // ─── 定位与目录移动 ───

  /** 按 id 定位技能(own 遮蔽 linked);不存在即抛。 */
  private async locate(id: string): Promise<DiscoveredSkill> {
    const found = (await this.scan()).get(id);
    if (!found) throw new Error(`技能 "${id}" 不存在`);
    return found;
  }

  /**
   * 在 parent 下分配一个未被占用的目录路径:首选 base,被占则追加序号。
   *
   * 所有写入类操作(create / fork / admit / archive)统一经此分配物理目录 ——
   * 技能 id 是逻辑键(锚 frontmatter.name、由 scan 建 id→实际目录映射定位),
   * 目录名仅物理位置。故目标目录被占(改名遗留、或用户手放目录名≠id)时换名
   * 而非写入覆盖,从根上杜绝覆盖既有技能的数据丢失。
   */
  private async reserveDir(parent: string, base: string): Promise<string> {
    let candidate = path.join(parent, base);
    for (let i = 2; await this.pathExists(candidate); i++) {
      candidate = path.join(parent, `${base}-${i}`);
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

  /** 移动目录:同卷 rename;跨卷(EXDEV)退回 copy + rm。 */
  private async movePath(src: string, dest: string): Promise<void> {
    try {
      await fs.rename(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EXDEV") {
        await fs.cp(src, dest, { recursive: true });
        await fs.rm(src, { recursive: true, force: true });
      } else {
        throw e;
      }
    }
  }

  /**
   * 逐文件递归 content copy:目录递归、普通文件 read Buffer + 原子写(二进制安全);
   * 遇符号链接即抛(接入技能不允许软链 —— 防越界、保内容副本而非链接)。
   */
  private async copyTreeContent(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dest, e.name);
      if (e.isSymbolicLink()) {
        throw new Error(`接入技能含符号链接,拒绝:${e.name}`);
      }
      if (e.isDirectory()) {
        await this.copyTreeContent(s, d);
      } else if (e.isFile()) {
        await writeAtomic(d, await fs.readFile(s));
      }
      // 其它(设备文件 / FIFO 等):跳过
    }
  }

  // ─── 投影:单一过滤 + 排序 + 限量 ───

  private async project(opts: {
    mode?: SkillMode;
    limit?: number;
  }): Promise<SkillRecord[]> {
    const records = await this.discoverWithState();
    let filtered = records.filter((r) => !r.disabled);
    if (opts.mode) filtered = filtered.filter((r) => r.mode === opts.mode);
    const ranked = await this.rankWithUsage(filtered);
    return opts.limit !== undefined ? ranked.slice(0, opts.limit) : ranked;
  }

  /**
   * 唯一排序点:读 usage + 排序 + 带回 usage。pinned 优先,其余按
   * (usage.lastHitAt ?? createdAt) 降序、hitCount 作 tiebreaker。
   *
   * 返回 `ManagedSkillRecord`(带 usage):`listForManagement` 直接用;
   * `project`(listAll / queryTopN)取此结果当 `SkillRecord[]`——usage 字段在类型
   * 上收敛掉、消费方只按显式字段取,不外泄。usage 旁路一处读、无重复读。
   */
  private async rankWithUsage(
    records: SkillRecord[],
  ): Promise<ManagedSkillRecord[]> {
    const keyed = await Promise.all(
      records.map(async (r) => {
        const usage = await this.readUsage(r.id);
        return {
          record: { ...r, usage },
          recency: usage?.lastHitAt ?? r.createdAt,
          hitCount: usage?.hitCount ?? 0,
        };
      }),
    );
    keyed.sort((a, b) => {
      if (a.record.pinned !== b.record.pinned) return a.record.pinned ? -1 : 1;
      if (a.recency !== b.recency) return a.recency < b.recency ? 1 : -1;
      return b.hitCount - a.hitCount;
    });
    return keyed.map((k) => k.record);
  }

  // ─── 扫描发现 ───

  private async scan(): Promise<Map<string, DiscoveredSkill>> {
    const map = new Map<string, DiscoveredSkill>();
    for (const source of SCAN_SOURCES) {
      for (const [id, d] of await this.scanSource(source)) map.set(id, d);
    }
    return map;
  }

  /** 扫描单个区(own 或 linked);坏 SKILL.md / 无 name / 越界一律隔离跳过。 */
  private async scanSource(
    source: SkillSource,
  ): Promise<Map<string, DiscoveredSkill>> {
    const map = new Map<string, DiscoveredSkill>();
    const base = sourceRoot(this.root, source);
    const entries = await fs
      .readdir(base, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(base, entry.name);
      const file = path.join(skillDir, SKILL_FILE);
      try {
        // realpath 边界:区内软链指向库外即越界 → 抛 → 隔离跳过。
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
