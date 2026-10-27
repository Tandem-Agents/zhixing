import path from "node:path";
import { createHash } from "node:crypto";
import type { CheckpointDirectoryHandle } from "@zhixing/mesh/filesystem";
import type { LogFileInfo } from "@zhixing/core/logging/storage";

const timestamp = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";
const dump = new RegExp(`^(?:keypress|llm-raw|llm-error)-[1-9]\\d*-${timestamp}\\.log$`, "u");
const families = [
  { parts: [], accepts: (name: string) => name === "server.log", single: "server.log" },
  { parts: ["logs"], accepts: (name: string) => dump.test(name) },
  { parts: ["logs", "llm-raw"], accepts: (name: string) => name.startsWith("llm-raw-") && dump.test(name) },
  { parts: ["logs", "llm-error"], accepts: (name: string) => name.startsWith("llm-error-") && dump.test(name) },
  { parts: ["logs", "server"], accepts: (name: string) => name === "server.log" || /^server-\d{8}-\d{6}-\d{3}-\d{4,}\.log$/u.test(name) },
];

/** Fixed historical locations only. Virtual names never become caller-supplied paths. */
type Family = (typeof families)[number];
const legacyKey = (family: Family, name: string): string =>
  `legacy-${createHash("sha256").update(`${family.parts.join("/")}/${name}`).digest("hex")}.log`;
/** 名字绑定的上限：一个步骤只需要它刚 stat 过的一批；超出时淘汰最久未用的，用到时再按登记路径重新绑定。 */
const MAX_BINDINGS = 4096;

export class LegacyLogFiles {
  readonly #handles = new Map<string, CheckpointDirectoryHandle>();
  /** 虚拟名到实际位置的绑定，只在按登记路径 stat 时建立，读、截断、删除都要先绑定；有上限，回收或缺失即移出。 */
  readonly #entries = new Map<string, { directory: CheckpointDirectoryHandle; name: string; relativePath: string }>();
  /** 本进程这一轮发现读到哪一族；reader 是该族专用的续读句柄，与族目录句柄分开，别的枚举不会重置它的位置。 */
  #scan: { family: number; reader: CheckpointDirectoryHandle | undefined; started: boolean } | undefined;
  /** directoryEntries 是原生目录枚举的单目录上限（Windows 100000、POSIX 4096），超过时枚举报错。 */
  constructor(readonly home: string, readonly openPath: (root: string, create: boolean, readOnly: boolean) => Promise<CheckpointDirectoryHandle>, readonly readOnly: boolean, readonly directoryEntries = 4096) {}

  /** 打开族目录；已打开过的必须仍是该路径上的同一目录。目录不存在（且从未打开过）时给 undefined。 */
  async #family(family: Family): Promise<CheckpointDirectoryHandle | undefined> {
    const root = path.join(this.home, ...family.parts);
    let directory = this.#handles.get(root);
    try {
      const current = await this.openPath(root, false, this.readOnly);
      if (directory) {
        try { if (current.identity !== directory.identity) throw Error("旧日志目录位置已变化"); }
        finally { await current.close(); }
        await directory.assertIdentity();
      } else { directory = current; this.#handles.set(root, directory); }
    } catch (error) {
      if (!directory && missing(error)) return undefined;
      throw error;
    }
    return directory;
  }
  /** 普通步骤只核对已打开的族目录仍在原位（至多每族一次打开），不枚举。 */
  async verify(): Promise<void> {
    for (const family of families) if (this.#handles.has(path.join(this.home, ...family.parts))) await this.#family(family);
  }
  /**
   * 存储的发现：沿各族目录的续读句柄读，本次实际扫描的目录项字节不超过 budget（POSIX 至多再多一项），返回其中
   * 属于固定族的名字与实际扫描量。restart 或本进程还没有这一轮的位置时从第一族开始（位置不跨进程保留，重启即从头
   * 有限重扫）。族目录不存在、单文件族、目录读尽的标记不占预算（至多每族一次打开或 stat）。
   * end 表示从第一族起连续读到了最后一族末尾。
   */
  async scan(restart: boolean, budget: number): Promise<{ entries: { name: string; path: string }[]; scanned: number; bytes: number; end: boolean; restarted: boolean }> {
    const restarted = restart || !this.#scan;
    if (restarted) {
      await this.#scan?.reader?.close().catch(() => undefined);
      this.#scan = { family: 0, reader: undefined, started: false };
    }
    const scan = this.#scan!;
    const entries: { name: string; path: string }[] = [];
    let scanned = 0, bytes = 0;
    while (scan.family < families.length) {
      const family = families[scan.family]!;
      const directory = await this.#family(family);
      if (!directory) { scan.family++; continue; }
      if (family.single) {
        scan.family++;
        try { await directory.statFile(family.single); }
        catch (error) { if (missing(error)) continue; throw error; }
        entries.push({ name: legacyKey(family, family.single), path: [...family.parts, family.single].join("/") });
        scanned++;
        continue;
      }
      // 原生一块至少 1024 字节：剩余预算不足一块就留给下一步
      if (budget - bytes < 1024) break;
      if (!scan.reader) {
        const reader = await this.openPath(path.join(this.home, ...family.parts), false, true);
        if (reader.identity !== directory.identity) { await reader.close(); throw Error("旧日志目录位置已变化"); }
        scan.reader = reader;
        scan.started = false;
      }
      const chunk = await scan.reader.readEntryChunk(!scan.started, budget - bytes);
      scan.started = true;
      scanned += chunk.scanned;
      bytes += chunk.bytes;
      // 只返回位置，不建绑定：登记、读取、回收时再按登记路径绑定
      for (const name of chunk.names) if (family.accepts(name)) entries.push({ name: legacyKey(family, name), path: [...family.parts, name].join("/") });
      if (chunk.end) {
        await scan.reader.close();
        scan.reader = undefined;
        scan.family++;
      }
    }
    return { entries, scanned, bytes, end: scan.family >= families.length, restarted };
  }
  /**
   * 离线诊断目录（未初始化、用户发起的查询，不在存储的普通路径上）：按虚拟名排序取 after 之后至多 limit 个。
   * 每次查询现读全部族目录，读完即弃，不在进程里保留全集，也不建绑定（读取前再按路径 stat 绑定）。
   */
  async page(after: string, limit: number): Promise<{ entries: { name: string; path: string }[]; end: boolean }> {
    const found = new Map<string, string>();
    for (const family of families) {
      const directory = await this.#family(family);
      if (!directory) continue;
      let names: readonly string[];
      if (family.single) {
        try { await directory.statFile(family.single); names = [family.single]; }
        catch (error) { if (missing(error)) continue; throw error; }
      } else names = await directory.listEntries(this.directoryEntries);
      // Identity is checked again by stat/read/truncate; links never become owned files.
      for (const name of names) if (family.accepts(name)) found.set(legacyKey(family, name), [...family.parts, name].join("/"));
    }
    const remaining = [...found.keys()].filter((name) => name > after).sort();
    const names = remaining.slice(0, limit);
    return { entries: names.map((name) => ({ name, path: found.get(name)! })), end: names.length >= remaining.length };
  }
  /** 按登记时记下的相对路径定位虚拟名并 stat；路径必须落在固定族里且与虚拟名摘要一致。不存在给 null。 */
  async stat(entries: readonly { name: string; path: string }[]): Promise<readonly (LogFileInfo | null)[]> {
    const result: (LogFileInfo | null)[] = [];
    const opened = new Map<Family, CheckpointDirectoryHandle | undefined>();
    for (const entry of entries) {
      const parts = entry.path.split("/"), name = parts.pop()!;
      const family = families.find((item) => item.parts.join("/") === parts.join("/") && item.accepts(name));
      if (!family || legacyKey(family, name) !== entry.name) throw Error("旧日志登记位置不在固定族目录");
      if (!opened.has(family)) opened.set(family, await this.#family(family));
      const directory = opened.get(family);
      if (!directory) { this.#entries.delete(entry.name); result.push(null); continue; }
      try {
        result.push({ ...await directory.statFile(name), legacyPath: entry.path });
        // 最近绑定的排在最后；超出上限淘汰最久未用的
        this.#entries.delete(entry.name);
        this.#entries.set(entry.name, { directory, name, relativePath: entry.path });
        while (this.#entries.size > MAX_BINDINGS) this.#entries.delete(this.#entries.keys().next().value!);
      } catch (error) {
        if (!missing(error)) throw error;
        this.#entries.delete(entry.name);
        result.push(null);
      }
    }
    return result;
  }
  /** 历史文件已回收：移出绑定。 */
  forget(name: string): void {
    this.#entries.delete(name);
  }
  /** 当前保留的名字绑定数（诊断与用例核对有界用）。 */
  get bindings(): number {
    return this.#entries.size;
  }
  resolve(name: string): { directory: CheckpointDirectoryHandle; name: string; relativePath: string } {
    const entry = this.#entries.get(name);
    if (!entry) throw Error("旧日志未在固定位置登记");
    return entry;
  }
  async sync(): Promise<void> {
    for (const directory of this.#handles.values()) await directory.sync();
  }
  async close(): Promise<void> {
    const handles = [...this.#handles.values(), ...(this.#scan?.reader ? [this.#scan.reader] : [])];
    this.#entries.clear(); this.#handles.clear(); this.#scan = undefined;
    await Promise.allSettled(handles.map((directory) => directory.close()));
  }
}
export function isLegacyLogFile(name: string): boolean { return /^legacy-[a-f0-9]{64}\.log$/u.test(name); }

/** Group the same safe stat operations at the transport boundary, preserving caller order. */
export async function statLogFiles(directory: CheckpointDirectoryHandle | undefined, legacy: LegacyLogFiles, names: readonly string[]): Promise<readonly LogFileInfo[]> {
  if (names.length > 4096) throw Error("日志文件清点超限");
  const groups = new Map<CheckpointDirectoryHandle, { index: number; name: string; relativePath?: string }[]>();
  for (const [index, name] of names.entries()) {
    const entry = isLegacyLogFile(name) ? legacy.resolve(name) : { directory, name };
    if (!entry.directory) throw Error("日志存储尚未打开");
    const entries = groups.get(entry.directory) ?? [];
    entries.push({ index, name: entry.name, ...("relativePath" in entry ? { relativePath: entry.relativePath } : {}) });
    groups.set(entry.directory, entries);
  }
  const result: LogFileInfo[] = new Array(names.length);
  for (const [owner, entries] of groups) {
    const observed = await owner.statFiles(entries.map(entry => entry.name));
    entries.forEach((entry, index) => { result[entry.index] = { ...observed[index]!, ...(entry.relativePath ? { legacyPath: entry.relativePath } : {}) }; });
  }
  return result;
}
function missing(error: unknown): boolean { return error instanceof Error && error.message === "checkpoint-child-missing"; }
