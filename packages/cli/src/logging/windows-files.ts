import path from "node:path";
import {
  CheckpointDirectoryHandle,
  type CheckpointFilesystemSession,
} from "@zhixing/mesh/filesystem";
import type { LogFileInfo, LogFileSystem } from "@zhixing/core/logging/storage";

/** The parent directly owns the asynchronous native process and its OS lock. */
export class WindowsLogFiles implements LogFileSystem {
  readonly #home: string;
  readonly #timeout: number;
  #session: CheckpointFilesystemSession | undefined;
  #directory: CheckpointDirectoryHandle | undefined;
  #release: (() => Promise<void>) | undefined;
  #readOnly = true;
  #closed = false;
  constructor(home: string, timeout: number) {
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
    }
    if (this.#closed) throw Error("日志文件进程已关闭");
    this.#session ??= CheckpointDirectoryHandle.createWindowsSession(this.#timeout);
    if (this.#directory && this.#readOnly === readOnly) {
      await this.#directory.assertIdentity();
      return;
    }
    await this.#release?.();
    this.#release = undefined;
    await this.#directory?.close();
    this.#directory = undefined;
    this.#readOnly = readOnly;
    if (!path.isAbsolute(this.#home)) throw Error("日志数据根必须为绝对路径");
    if (readOnly)
      this.#directory = await this.#session.openPath(
        path.join(this.#home, "logs", "runtime"),
        false,
        true,
      );
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
  list(limit: number): Promise<readonly string[]> {
    return this.#root().listEntries(limit);
  }
  stat(name: string): Promise<LogFileInfo> {
    return this.#root().statFile(name);
  }
  read(name: string, size: number, offset: number, limit: number): Promise<Uint8Array> {
    return this.#root().readFile(name, size, offset, limit);
  }
  write(name: string, bytes: Uint8Array): Promise<void> {
    return this.#root(true).writeFile(name, bytes);
  }
  rename(from: string, to: string): Promise<void> {
    const root = this.#root(true);
    return root.renameTo(from, root, to);
  }
  truncate(name: string, identity: string, bytes: number): Promise<void> {
    return this.#root(true).truncateFile(name, identity, bytes);
  }
  async remove(name: string): Promise<void> {
    const root = this.#root(true),
      info = await root.statFile(name);
    await root.removeRetired(name, info.identity);
  }
  sync(): Promise<void> {
    return this.#root(true).sync();
  }
  async tryLock(): Promise<boolean> {
    if (this.#release) throw Error("日志互斥不可重入");
    this.#release = await this.#root(true).tryLock("writer.lock");
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
