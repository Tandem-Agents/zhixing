import path from "node:path";
import {
  CheckpointDirectoryHandle,
  type CheckpointFilesystemSession,
  type NodeProcessInventory,
} from "@zhixing/mesh/filesystem";
import type { LogFileInfo, LogFileSystem } from "@zhixing/core/logging/storage";
import { LegacyLogFiles, isLegacyLogFile, statLogFiles } from "./legacy-files.js";

/** The parent directly owns the asynchronous native process and its OS lock. */
export class WindowsLogFiles implements LogFileSystem {
  readonly #home: string;
  readonly #timeout: number;
  #session: CheckpointFilesystemSession | undefined;
  #directory: CheckpointDirectoryHandle | undefined;
  #release: (() => Promise<void>) | undefined;
  #readOnly = true;
  #closed = false;
  #legacy: LegacyLogFiles | undefined;
  constructor(home: string, timeout: number, private readonly createSession?: () => CheckpointFilesystemSession) {
    this.#home = home;
    this.#timeout = timeout;
  }
  async open(readOnly: boolean): Promise<void> {
    if (this.#closed) throw Error("日志文件进程已关闭");
    if (this.#session?.failed) {
      await this.#session.close();
      this.#session = undefined;
      this.#directory = undefined;
      this.#release = undefined;
      this.#legacy = undefined;
    }
    if (this.#closed) throw Error("日志文件进程已关闭");
    this.#session ??= this.createSession?.() ?? CheckpointDirectoryHandle.createWindowsSession(this.#timeout);
    if (this.#directory && this.#readOnly === readOnly) {
      await this.#directory.assertIdentity();
      return;
    }
    await this.#release?.();
    this.#release = undefined;
    await this.#legacy?.close();
    this.#legacy = undefined;
    await this.#directory?.close();
    this.#directory = undefined;
    this.#readOnly = readOnly;
    this.#legacy = new LegacyLogFiles(this.#home, (root, create, ro) => this.#session!.openPath(root, create, ro), readOnly);
    if (!path.isAbsolute(this.#home)) throw Error("日志数据根必须为绝对路径");
    if (readOnly) {
      try { this.#directory = await this.#session.openPath(
        path.join(this.#home, "logs", "runtime"),
        false,
        true,
      ); } catch (error) { if (!(error instanceof Error) || error.message !== "checkpoint-child-missing") throw error; }
    }
    else {
      const root = await this.#session.openPath(this.#home, false);
      let logs: CheckpointDirectoryHandle | undefined;
      try {
        logs = await root.openDirectory("logs", true);
        await root.sync();
        this.#directory = await logs.openDirectory("runtime", true);
        await logs.sync();
        await this.#directory.sync();
      } finally {
        await logs?.close();
        await root.close();
      }
    }
  }
  #root(write = false): CheckpointDirectoryHandle {
    if (this.#closed || !this.#directory || this.#session?.failed || (write && this.#readOnly))
      throw Error("日志文件存储暂不可用");
    return this.#directory;
  }
  observeNodeProcesses(): Promise<NodeProcessInventory> {
    if (this.#closed || !this.#session || this.#session.failed) throw Error("日志文件存储暂不可用");
    return this.#session.observeNodeProcesses();
  }
  async list(limit: number): Promise<readonly string[]> {
    const own = this.#directory ? await this.#root().listEntries(limit) : [];
    if (own.some(isLegacyLogFile)) throw Error("日志根含保留的旧日志名称");
    const names = [...own, ...await this.#legacy!.list(limit)];
    if (names.length > limit) throw Error("日志文件清点超限");
    return names;
  }
  async stat(name: string): Promise<LogFileInfo> {
    if (isLegacyLogFile(name)) { const entry = this.#legacy!.resolve(name); return { ...await entry.directory.statFile(entry.name), legacyPath: entry.relativePath }; }
    return this.#root().statFile(name);
  }
  statMany(names: readonly string[]): Promise<readonly LogFileInfo[]> {
    if (this.#closed || this.#session?.failed || !this.#legacy) throw Error("日志文件存储暂不可用");
    return statLogFiles(this.#directory, this.#legacy, names);
  }
  read(name: string, size: number, offset: number, limit: number, identity?: string, prefix?: boolean): Promise<Uint8Array> {
    if (isLegacyLogFile(name)) { const entry = this.#legacy!.resolve(name); return entry.directory.readFile(entry.name, size, offset, limit, identity); }
    return this.#root().readFile(name, size, offset, limit, identity, prefix);
  }
  readLocalProcessDeclaration(endpoint: string, pid: number): Promise<string> {
    if (this.#closed || !this.#session || this.#session.failed) throw Error("日志文件存储暂不可用");
    return this.#session.readLocalProcessDeclaration(endpoint, pid);
  }
  async append(name: string, identity: string, offset: number, bytes: Uint8Array): Promise<void> {
    if (!/^segment-[a-f0-9-]{36}\.jsonl$/u.test(name)) throw Error("只能追加受管日志段");
    await this.#root(true).writeRange(name, offset + bytes.length, offset, bytes, identity);
  }
  write(name: string, bytes: Uint8Array): Promise<void> {
    if (isLegacyLogFile(name)) throw Error("不能改写旧日志");
    return this.#root(true).writeFile(name, bytes);
  }
  rename(from: string, to: string): Promise<void> {
    if (isLegacyLogFile(from) || isLegacyLogFile(to)) throw Error("不能迁移旧日志");
    const root = this.#root(true);
    return root.renameTo(from, root, to);
  }
  truncate(name: string, identity: string, bytes: number): Promise<void> {
    if (isLegacyLogFile(name)) {
      this.#root(true);
      if (bytes !== 0) throw Error("旧日志仅允许整文件回收");
      const entry = this.#legacy!.resolve(name); return entry.directory.truncateFile(entry.name, identity, 0);
    }
    return this.#root(true).truncateFile(name, identity, bytes);
  }
  async remove(name: string, identity?: string): Promise<void> {
    if (isLegacyLogFile(name)) {
      this.#root(true);
      if (!identity) throw Error("回收旧日志必须提供登记身份");
      const entry = this.#legacy!.resolve(name);
      await entry.directory.removeRetired(entry.name, identity); await entry.directory.sync(); return;
    }
    const root = this.#root(true),
      info = await root.statFile(name);
    await root.removeRetired(name, identity ?? info.identity);
  }
  async sync(): Promise<void> {
    await this.#root(true).sync();
    await this.#legacy?.sync();
  }
  async tryLock(): Promise<boolean> {
    if (this.#release) throw Error("日志互斥不可重入");
    this.#release = await this.#root(true).waitLock("writer.lock", 2000);
    return this.#release !== undefined;
  }
  async tryReadLock(): Promise<boolean> {
    if (this.#release) throw Error("日志互斥不可重入");
    this.#release = await this.#root().waitLock("writer.lock", 2000, "shared");
    return this.#release !== undefined;
  }
  async unlock(): Promise<void> {
    if (this.#session?.failed || this.#closed) {
      await this.#session?.close();
      this.#release = undefined;
      return;
    }
    const release = this.#release;
    this.#release = undefined;
    try {
      await release?.();
    } catch (error) {
      await this.#session?.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#session?.close();
  }
}
