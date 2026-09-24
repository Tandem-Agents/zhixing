import { WindowsLogFiles } from "./windows-files.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LogFileInfo, LogFileSystem } from "@zhixing/core/logging/storage";

/** Native operations are isolated from the event loop, including POSIX synchronous N-API. */
class NodeFilesProcess implements LogFileSystem {
  readonly #home: string;
  readonly #timeoutMs: number;
  #child: ChildProcess | undefined;
  #exit: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #id = 0;
  #pending:
    | {
        id: number;
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  #broken = false;
  #closed = false;
  constructor(home: string, timeoutMs = 5000) {
    this.#home = home;
    this.#timeoutMs = timeoutMs;
  }
  async open(readOnly: boolean): Promise<void> {
    if (this.#closed) throw Error("日志文件进程已关闭");
    if (this.#broken) {
      await this.#stop();
      this.#broken = false;
    }
    if (this.#closed) throw Error("日志文件进程已关闭");
    if (!this.#child) this.#spawn();
    await this.#call("open", [this.#home, readOnly]);
  }
  list(limit: number): Promise<readonly string[]> {
    return this.#call("list", [limit]);
  }
  stat(name: string): Promise<LogFileInfo> {
    return this.#call("stat", [name]);
  }
  read(name: string, size: number, offset: number, limit: number, identity?: string): Promise<Uint8Array> {
    return this.#call("read", [name, size, offset, limit, identity]);
  }
  write(name: string, bytes: Uint8Array): Promise<void> {
    return this.#call("write", [name, bytes]);
  }
  rename(from: string, to: string): Promise<void> {
    return this.#call("rename", [from, to]);
  }
  truncate(name: string, identity: string, bytes: number): Promise<void> {
    return this.#call("truncate", [name, identity, bytes]);
  }
  remove(name: string, identity?: string): Promise<void> {
    return this.#call("remove", [name, identity]);
  }
  sync(): Promise<void> {
    return this.#call("sync", []);
  }
  tryLock(): Promise<boolean> {
    return this.#call("tryLock", []);
  }
  async unlock(): Promise<void> {
    if (this.#broken || this.#closed) {
      await this.#stop();
      return;
    }
    try {
      await this.#call("unlock", []);
    } catch (error) {
      this.#broken = true;
      await this.#stop();
      throw error;
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#stop();
  }

  #spawn(): void {
    const built = new URL("./logging-files-worker.js", import.meta.url);
    const source = new URL("./logging-files-worker.ts", import.meta.url);
    const compiled = existsSync(fileURLToPath(built));
    const child = spawn(
      process.execPath,
      [...(compiled ? [] : ["--import=tsx/esm"]), fileURLToPath(compiled ? built : source)],
      {
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    this.#child = child;
    this.#exit = new Promise<void>((resolve) =>
      child.once("close", () => {
        this.#broken = true;
        this.#reject("日志文件进程已退出");
        resolve();
      }),
    );
    child.on("error", () => {
      this.#broken = true;
      void this.#stop();
    });
    child.on("message", (message: { id: number; value?: unknown; error?: string }) => {
      if (this.#broken || this.#closed || this.#stopping) return;
      const pending = this.#pending;
      if (!pending || message.id !== pending.id) return;
      clearTimeout(pending.timer);
      this.#pending = undefined;
      child.unref();
      child.channel?.unref();
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    });
    child.unref();
    child.channel?.unref();
  }
  #call<T>(op: string, args: unknown[]): Promise<T> {
    const child = this.#child;
    if (!child?.connected || this.#pending || this.#broken || this.#closed)
      return Promise.reject(Error("日志文件进程暂不可用"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.#id;
      child.ref();
      child.channel?.ref();
      const timer = setTimeout(() => {
        this.#broken = true;
        // Failure is reported only after the old owner process has actually exited.
        void this.#stop().then(() => reject(Error("日志文件操作超时")), reject);
      }, this.#timeoutMs);
      this.#pending = {
        id,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      };
      child.send({ id, op, args }, (error) => {
        if (error) {
          this.#broken = true;
          void this.#stop();
        }
      });
    });
  }
  #reject(message: string): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(Error(message));
    }
  }
  #stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = (async () => {
      const child = this.#child;
      if (!child) return;
      // Explicit close owns the remaining process lifetime, even without other callers.
      child.ref();
      child.channel?.ref();
      child.kill();
      await this.#exit;
      this.#child = undefined;
      this.#exit = undefined;
      this.#reject("日志文件进程已关闭");
    })().finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }
}

/** Windows has an asynchronous native owner; POSIX isolates synchronous N-API. */
export class LogFilesProcess implements LogFileSystem {
  readonly #files: LogFileSystem;
  constructor(home: string, timeoutMs = 5000) {
    this.#files =
      process.platform === "win32"
        ? new WindowsLogFiles(home, timeoutMs)
        : new NodeFilesProcess(home, timeoutMs);
  }
  async open(readOnly: boolean): Promise<void> {
    try {
      await this.#files.open(readOnly);
    } catch (error) {
      if (!readOnly) throw error;
      const missing =
        error instanceof Error &&
        (error.message === "checkpoint-child-missing" ||
          error.message === "日志文件操作 open 未完成（checkpoint-child-missing）");
      throw new Error(
        missing
          ? "日志目录尚不存在，当前没有可查询的运行日志存储；可用 zz logs location 查看位置。"
          : "日志存储当前不可读取；请用 zz logs location 核对目录位置与访问权限。",
        { cause: error },
      );
    }
  }
  list(limit: number): Promise<readonly string[]> {
    return this.#files.list(limit);
  }
  stat(name: string): Promise<LogFileInfo> {
    return this.#files.stat(name);
  }
  read(name: string, size: number, offset: number, limit: number, identity?: string): Promise<Uint8Array> {
    return this.#files.read(name, size, offset, limit, identity);
  }
  write(name: string, bytes: Uint8Array): Promise<void> {
    return this.#files.write(name, bytes);
  }
  rename(from: string, to: string): Promise<void> {
    return this.#files.rename(from, to);
  }
  truncate(name: string, identity: string, bytes: number): Promise<void> {
    return this.#files.truncate(name, identity, bytes);
  }
  remove(name: string, identity?: string): Promise<void> {
    return this.#files.remove(name, identity);
  }
  sync(): Promise<void> {
    return this.#files.sync();
  }
  tryLock(): Promise<boolean> {
    return this.#files.tryLock();
  }
  unlock(): Promise<void> {
    return this.#files.unlock();
  }
  close(): Promise<void> {
    return this.#files.close();
  }
}
