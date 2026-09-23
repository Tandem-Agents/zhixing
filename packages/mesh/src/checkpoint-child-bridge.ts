import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assertCheckpointBridgeHost, checkpointBridgeTarget, currentGlibcVersion, verifyCheckpointBridgeArtifact, verifyCheckpointBridgeArtifactAsync } from "./checkpoint-bridge-artifact.js";

interface NativeCheckpointChildBridge {
  openPath(path: string, create: boolean, readOnly: boolean): bigint;
  statFile(parent: bigint, name: string): { bytes: number; identity: string };
  truncateFile(parent: bigint, name: string, identity: string, bytes: number): void;
  tryLock(parent: bigint, name: string): bigint;
  openDirectory(parent: bigint, name: string, create: boolean): bigint;
  identity(handle: bigint): string;
  writeFile(parent: bigint, name: string, bytes: Buffer): void;
  readFile(parent: bigint, name: string, declaredBytes: number, offset: number, limit: number): Buffer;
  listEntries(parent: bigint, maximumEntries: number): string[];
  writeRange(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer): number;
  renameEntry(sourceParent: bigint, sourceName: string, targetParent: bigint, targetName: string): void;
  unlinkEntry(parent: bigint, name: string, directory: boolean, retiredIdentity?: string): void;
  sync(handle: bigint): void;
  close(handle: bigint): void;
}

interface BridgeApi {
  openPath(path: string, create: boolean, readOnly: boolean): Promise<bigint>;
  statFile(parent: bigint, name: string): Promise<{ bytes: number; identity: string }>;
  truncateFile(parent: bigint, name: string, identity: string, bytes: number): Promise<void>;
  tryLock(parent: bigint, name: string): Promise<bigint>;
  openDirectory(parent: bigint, name: string, create: boolean): Promise<bigint>;
  identity(handle: bigint): Promise<string>;
  writeFile(parent: bigint, name: string, bytes: Buffer): Promise<void>;
  readFile(parent: bigint, name: string, declaredBytes: number, offset: number, limit: number): Promise<Buffer>;
  listEntries(parent: bigint, maximumEntries: number): Promise<readonly string[]>;
  writeRange(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer): Promise<number>;
  renameEntry(sourceParent: bigint, sourceName: string, targetParent: bigint, targetName: string): Promise<void>;
  unlinkEntry(parent: bigint, name: string, directory: boolean, retiredIdentity?: string): Promise<void>;
  sync(handle: bigint): Promise<void>;
  close(handle: bigint): Promise<void>;
}

const bridge: BridgeApi = process.platform === "win32" ? windowsBridge() : nativeBridge();
const handle = Symbol("checkpoint-child-handle");

export class CheckpointDirectoryHandle {
  readonly identity: string;
  readonly [handle]: bigint;
  #closed = false;
  readonly #bridge: BridgeApi;

  private constructor(value: bigint, identity: string, api: BridgeApi = bridge) {
    this.#bridge = api;
    this[handle] = value;
    this.identity = identity;
  }

  static async openPath(path: string, create: boolean, readOnly = false): Promise<CheckpointDirectoryHandle> {
    if (readOnly && create) throw new TypeError("Read-only directory cannot be created");
    const value = await bridge.openPath(path, create, readOnly);
    return new CheckpointDirectoryHandle(value, await bridge.identity(value));
  }

  /** Isolated asynchronous Windows owner. No automatic restart can reuse its handles. */
  static createWindowsSession(timeoutMs = 5000): CheckpointFilesystemSession {
    if (process.platform !== "win32") throw Error("Windows filesystem session required");
    const owner = ownedWindowsBridge(timeoutMs);
    return {
      get failed() { return owner.failed(); },
      openPath: async (path, create, readOnly = false) => {
        if (readOnly && create) throw Error("Read-only directory cannot be created");
        const value = await owner.api.openPath(path, create, readOnly);
        return new CheckpointDirectoryHandle(value, await owner.api.identity(value), owner.api);
      },
      close: owner.stop,
    };
  }

  async openDirectory(name: string, create: boolean): Promise<CheckpointDirectoryHandle> {
    await this.#assertOpen();
    const value = await this.#bridge.openDirectory(this[handle], childName(name), create);
    return new CheckpointDirectoryHandle(value, await this.#bridge.identity(value), this.#bridge);
  }

  async writeFile(name: string, bytes: Uint8Array): Promise<void> {
    await this.#assertOpen();
    await this.#bridge.writeFile(this[handle], childName(name), Buffer.from(bytes));
  }

  async statFile(name: string): Promise<{ bytes: number; identity: string }> {
    await this.#assertOpen();
    return this.#bridge.statFile(this[handle], childName(name));
  }

  /** Only the caller's already-retired object may be truncated. Never follows links. */
  async truncateFile(name: string, identity: string, bytes: number): Promise<void> {
    await this.#assertOpen();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Invalid truncate size");
    await this.#bridge.truncateFile(this[handle], childName(name), identity, bytes);
  }

  /** One permanent, empty control file; contention creates no temporary files. */
  async tryLock(name: string): Promise<(() => Promise<void>) | undefined> {
    await this.#assertOpen();
    const value = await this.#bridge.tryLock(this[handle], childName(name));
    if (value === 0n) return undefined;
    let released = false;
    return async () => { if (!released) { released = true; await this.#bridge.close(value); } };
  }

  async readFile(name: string, declaredBytes: number, offset: number, limit: number): Promise<Buffer> {
    await this.#assertOpen();
    return this.#bridge.readFile(this[handle], childName(name), declaredBytes, offset, limit);
  }

  async listEntries(maximumEntries: number): Promise<readonly string[]> {
    await this.#assertOpen();
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new TypeError("Checkpoint directory entry bound is invalid");
    }
    const entries = await this.#bridge.listEntries(this[handle], maximumEntries);
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new TypeError("Checkpoint directory entries are invalid");
    }
    return [...entries].sort();
  }

  async writeRange(name: string, maximumBytes: number, offset: number, bytes: Uint8Array): Promise<number> {
    await this.#assertOpen();
    return this.#bridge.writeRange(this[handle], childName(name), maximumBytes, offset, Buffer.from(bytes));
  }

  async renameTo(name: string, target: CheckpointDirectoryHandle, targetName: string): Promise<void> {
    await this.#assertOpen();
    await target.#assertOpen();
    if (this.#bridge !== target.#bridge) throw Error("Cross-session filesystem rename");
    await this.#bridge.renameEntry(this[handle], childName(name), target[handle], childName(targetName));
  }

  async unlink(name: string, directory: boolean): Promise<void> {
    await this.#assertOpen();
    await this.#bridge.unlinkEntry(this[handle], childName(name), directory);
  }

  /** Remove only a verified zero-length retired file, even while a reader holds it. */
  async removeRetired(name: string, identity: string): Promise<void> {
    await this.#assertOpen();
    await this.#bridge.unlinkEntry(this[handle], childName(name), false, identity);
  }

  async sync(): Promise<void> {
    await this.#assertOpen();
    await this.#bridge.sync(this[handle]);
  }

  async assertIdentity(): Promise<void> {
    await this.#assertOpen();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#bridge.close(this[handle]);
  }

  async #assertOpen(): Promise<void> {
    if (this.#closed) throw new Error("Checkpoint directory handle is closed");
    if (await this.#bridge.identity(this[handle]) !== this.identity) {
      throw new TypeError("Checkpoint directory handle identity changed");
    }
  }
}

function nativeBridge(): BridgeApi {
  let loaded: NativeCheckpointChildBridge | undefined;
  const native = (): NativeCheckpointChildBridge => {
    if (loaded) return loaded;
    const target = checkpointBridgeTarget();
    assertCheckpointBridgeHost(target, currentGlibcVersion());
    loaded = createRequire(import.meta.url)(verifyCheckpointBridgeArtifact(
      fileURLToPath(new URL("../", import.meta.url)), target,
    )) as NativeCheckpointChildBridge;
    return loaded;
  };
  return {
    openPath: async (...args) => native().openPath(...args),
    statFile: async (...args) => native().statFile(...args),
    truncateFile: async (...args) => native().truncateFile(...args),
    tryLock: async (...args) => native().tryLock(...args),
    openDirectory: async (...args) => native().openDirectory(...args),
    identity: async (...args) => native().identity(...args),
    writeFile: async (...args) => native().writeFile(...args),
    readFile: async (...args) => native().readFile(...args),
    listEntries: async (...args) => native().listEntries(...args),
    writeRange: async (...args) => native().writeRange(...args),
    renameEntry: async (...args) => native().renameEntry(...args),
    unlinkEntry: async (...args) => native().unlinkEntry(...args),
    sync: async (...args) => native().sync(...args),
    close: async (...args) => native().close(...args),
  };
}

function windowsBridge(): BridgeApi {
  let nextId = 1;
  let process: ChildProcessWithoutNullStreams | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  let verifiedArtifact: Promise<string> | undefined;
  const request = async <T>(op: string, input: Record<string, unknown>): Promise<T> => {
    if (!process) {
      const executable = await (verifiedArtifact ??= Promise.resolve().then(() => verifyCheckpointBridgeArtifact(
        fileURLToPath(new URL("../", import.meta.url)), checkpointBridgeTarget(),
      )));
      process = spawn(executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      process.unref();
      unrefStream(process.stdin);
      unrefStream(process.stdout);
      unrefStream(process.stderr);
      createInterface({ input: process.stdout }).on("line", (line) => {
        const response = JSON.parse(line) as { id: number; ok: boolean; value?: unknown; error?: string };
        const waiter = pending.get(response.id);
        if (!waiter) return;
        pending.delete(response.id);
        response.ok ? waiter.resolve(response.value) : waiter.reject(new Error(response.error ?? "Checkpoint bridge failed"));
        releaseWindowsBridge(process, pending);
      });
      process.once("exit", (code) => {
        const error = new Error(`Checkpoint child bridge exited unexpectedly (${code ?? "signal"})`);
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
        process = undefined;
      });
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      process!.ref();
      refStream(process!.stdin);
      refStream(process!.stdout);
      refStream(process!.stderr);
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      process!.stdin.write(`${JSON.stringify({ id, op, ...input })}\n`, "utf8", (error) => {
        if (!error) return;
        pending.delete(id);
        releaseWindowsBridge(process, pending);
        reject(error);
      });
    });
  };

  return windowsApi(request);
}

export interface CheckpointFilesystemSession {
  readonly failed: boolean;
  openPath(path: string, create: boolean, readOnly?: boolean): Promise<CheckpointDirectoryHandle>;
  close(): Promise<void>;
}

function ownedWindowsBridge(timeoutMs: number): { api: BridgeApi; failed(): boolean; stop(): Promise<void> } {
  let child: ChildProcessWithoutNullStreams | undefined;
  let starting: Promise<void> | undefined, exited: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let closed = false, broken = false, nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (): void => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("Filesystem owner stopped")); }
    pending.clear();
  };
  const stop = (): Promise<void> => {
    closed = true;
    return stopping ??= (async () => {
      try { await starting; } catch { /* No native owner was started. */ }
      // An idle owner is unref'ed, but its explicit shutdown must finish before Node exits.
      if (child) {
        child.ref(); refStream(child.stdin); refStream(child.stdout); refStream(child.stderr);
      }
      child?.kill();
      await exited;
      settle();
    })();
  };
  const fail = (): void => { broken = true; void stop(); };
  const start = (): Promise<void> => starting ??= Promise.resolve().then(async () => {
    if (closed) throw Error("Filesystem owner closed");
    const executable = await verifyCheckpointBridgeArtifactAsync(fileURLToPath(new URL("../", import.meta.url)), checkpointBridgeTarget());
    if (closed) throw Error("Filesystem owner closed");
    const current = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = current;
    exited = new Promise<void>((resolve) => {
      // close is also emitted for spawn failure, whereas exit need not be.
      current.once("close", () => { broken = true; settle(); resolve(); });
    });
    current.on("error", fail); current.stdin.on("error", fail);
    current.stdout.on("error", fail); current.stderr.on("error", fail);
    createInterface({ input: current.stdout }).on("line", (line) => {
      if (closed || broken) return;
      try {
        const response = JSON.parse(line) as { id: number; ok: boolean; value?: unknown; error?: string };
        const waiter = pending.get(response.id);
        if (!waiter || typeof response.ok !== "boolean") { fail(); return; }
        pending.delete(response.id); clearTimeout(waiter.timer);
        response.ok ? waiter.resolve(response.value) : waiter.reject(Error(response.error ?? "Filesystem operation failed"));
        releaseWindowsBridge(current, pending);
      } catch { fail(); }
    });
    releaseWindowsBridge(current, pending);
  });
  const request = async <T>(op: string, input: Record<string, unknown>): Promise<T> => {
    if (closed || broken) { await stopping; throw Error("Filesystem owner unavailable"); }
    await start();
    if (closed || broken || !child) { await stopping; throw Error("Filesystem owner unavailable"); }
    const current = child, id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      current.ref(); refStream(current.stdin); refStream(current.stdout); refStream(current.stderr);
      const timer = setTimeout(fail, timeoutMs);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      current.stdin.write(`${JSON.stringify({ id, op, ...input })}\n`, "utf8", (error) => { if (error) fail(); });
    });
  };
  return { api: windowsApi(request), failed: () => closed || broken, stop };
}

function windowsApi(request: <T>(op: string, input: Record<string, unknown>) => Promise<T>): BridgeApi {
  const id = (value: bigint): number => {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new TypeError("Checkpoint bridge handle is invalid");
    return numeric;
  };
  return {
    openPath: async (path, create, readOnly) => BigInt(await request<number>("openPath", { path, create, readOnly })),
    statFile: (parent, name) => request<{ bytes: number; identity: string }>("statFile", { parent: id(parent), name }),
    truncateFile: (parent, name, identity, bytes) => request<void>("truncateFile", { parent: id(parent), name, identity, bytes }),
    tryLock: async (parent, name) => BigInt(await request<number>("tryLock", { parent: id(parent), name })),
    openDirectory: async (parent, name, create) => BigInt(await request<number>("openDirectory", { parent: id(parent), name, create })),
    identity: (value) => request<string>("identity", { handle: id(value) }),
    writeFile: (parent, name, bytes) => request<void>("writeFile", { parent: id(parent), name, data: bytes.toString("base64") }),
    readFile: async (parent, name, declaredBytes, offset, limit) => Buffer.from(
      await request<string>("readFile", { parent: id(parent), name, declaredBytes, offset, limit }),
      "base64",
    ),
    listEntries: (parent, maximumEntries) => request<readonly string[]>("listEntries", {
      parent: id(parent), maximumEntries,
    }),
    writeRange: (parent, name, maximumBytes, offset, bytes) => request<number>("writeRange", {
      parent: id(parent), name, maximumBytes, offset, data: bytes.toString("base64"),
    }),
    renameEntry: (sourceParent, sourceName, targetParent, targetName) => request<void>("renameEntry", {
      sourceParent: id(sourceParent), sourceName, targetParent: id(targetParent), targetName,
    }),
    unlinkEntry: (parent, name, directory, retiredIdentity) => request<void>("unlinkEntry", { parent: id(parent), name, directory, ...(retiredIdentity === undefined ? {} : { retiredIdentity }) }),
    sync: (value) => request<void>("sync", { handle: id(value) }),
    close: (value) => request<void>("close", { handle: id(value) }),
  };
}

function unrefStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  (stream as typeof stream & { unref?(): void }).unref?.();
}

function refStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  (stream as typeof stream & { ref?(): void }).ref?.();
}

function releaseWindowsBridge(
  process: ChildProcessWithoutNullStreams | undefined,
  pending: ReadonlyMap<number, unknown>,
): void {
  if (!process || pending.size > 0) return;
  process.unref();
  unrefStream(process.stdin);
  unrefStream(process.stdout);
  unrefStream(process.stderr);
}

function childName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(value) || value === "." || value === "..") {
    throw new TypeError("Checkpoint child name is invalid");
  }
  return value;
}
