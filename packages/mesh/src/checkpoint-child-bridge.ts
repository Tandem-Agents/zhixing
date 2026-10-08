import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from "node:url";
import { assertCheckpointBridgeHost, checkpointBridgeTarget, currentGlibcVersion, verifyCheckpointBridgeArtifact, verifyCheckpointBridgeArtifactAsync } from "./checkpoint-bridge-artifact.js";

import { ownedPosixFilesystem, POSIX_FILESYSTEM_LIMITS } from './checkpoint-posix-session.js';
import { retainCheckpointFilesystemCompletion } from './checkpoint-filesystem-completion.js';
export { checkpointFilesystemCompletion } from './checkpoint-filesystem-completion.js';

interface NativeCheckpointChildBridge {
  availableDiskBytes(handle: bigint): number;
  statEntry(parent: bigint, name: string): CheckpointEntry;
  writeAt(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer, identity?: string): CheckpointEntry;
  copyRange(parent: bigint, source: string, sourceIdentity: string, sourceBytes: number, sourceOffset: number, target: string, targetIdentity: string, targetOffset: number, length: number): CheckpointEntry;
  listEntryPage(parent: bigint, offset: number, limit: number): { names: readonly string[]; end: boolean };
  readLocalProcessDeclaration(endpoint: string, pid: number): string;
  processBirth(pid: number): string;
  openPath(path: string, create: boolean, readOnly: boolean): bigint;
  statFile(parent: bigint, name: string): { bytes: number; identity: string };
  truncateFile(parent: bigint, name: string, identity: string, bytes: number): void;
  tryLock(parent: bigint, name: string): bigint;
  tryReadLock(parent: bigint, name: string): bigint;
  openDirectory(parent: bigint, name: string, create: boolean): bigint;
  identity(handle: bigint): string;
  writeFile(parent: bigint, name: string, bytes: Buffer): void;
  readFile(parent: bigint, name: string, declaredBytes: number, offset: number, limit: number, identity?: string, prefix?: boolean): Buffer;
  listEntries(parent: bigint, maximumEntries: number): string[];
  writeRange(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer, identity?: string): number;
  renameEntry(sourceParent: bigint, sourceName: string, targetParent: bigint, targetName: string, replace?: boolean): void;
  unlinkEntry(parent: bigint, name: string, directory: boolean, retiredIdentity?: string, expectedIdentity?: string): void;
  sync(handle: bigint): void;
  close(handle: bigint): void;
}

interface BridgeApi {
  readonly maximumTransferBytes?: number;
  copyRange(parent: bigint, source: string, sourceIdentity: string, sourceBytes: number, sourceOffset: number, target: string, targetIdentity: string | undefined, targetOffset: number, length: number): Promise<CheckpointEntry>;
  availableDiskBytes(handle: bigint): Promise<number>;
  statEntry(parent: bigint, name: string): Promise<CheckpointEntry>;
  writeAt(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer, identity?: string): Promise<CheckpointEntry>;
  readLocalProcessDeclaration(endpoint: string, pid: number): Promise<string>;
  observeNodeProcesses(): Promise<NodeProcessInventory>;
  openPath(path: string, create: boolean, readOnly: boolean): Promise<bigint>;
  statFile(parent: bigint, name: string): Promise<{ bytes: number; identity: string }>;
  statFiles(parent: bigint, names: readonly string[]): Promise<readonly { bytes: number; identity: string }[]>;
  truncateFile(parent: bigint, name: string, identity: string, bytes: number): Promise<void>;
  tryLock(parent: bigint, name: string): Promise<bigint>;
  waitLock(parent: bigint, name: string, waitMs: number, shared: boolean, assertOpen?: () => void): Promise<bigint>;
  openDirectory(parent: bigint, name: string, create: boolean): Promise<bigint>;
  identity(handle: bigint): Promise<string>;
  writeFile(parent: bigint, name: string, bytes: Buffer): Promise<void>;
  readFile(parent: bigint, name: string, declaredBytes: number, offset: number, limit: number, identity?: string, prefix?: boolean): Promise<Buffer>;
  listEntries(parent: bigint, maximumEntries: number): Promise<readonly string[]>;
  listEntryPage(parent: bigint, offset: number, limit: number): Promise<{ names: readonly string[]; end: boolean }>;
  writeRange(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer, identity?: string): Promise<number>;
  renameEntry(sourceParent: bigint, sourceName: string, targetParent: bigint, targetName: string, replace?: boolean): Promise<void>;
  unlinkEntry(parent: bigint, name: string, directory: boolean, retiredIdentity?: string, expectedIdentity?: string): Promise<void>;
  sync(handle: bigint): Promise<void>;
  close(handle: bigint): Promise<void>;
}

const bridge: BridgeApi = process.platform === "win32" ? windowsBridge() : nativeBridge();
const handle = Symbol("checkpoint-child-handle");

export interface CheckpointEntry {
  readonly kind: 'file' | 'directory';
  readonly bytes: number;
  readonly allocatedBytes: number;
  readonly identity: string;
}

/** The filesystem owner keeps its private protocol; a containing execution
 * domain may supply only creation and actual-exit ownership. */
export interface CheckpointFilesystemProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  ref(): unknown;
  unref(): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
/** POSIX supplies fixed Node helper arguments; the execution owner must preserve
 * both these arguments and the requested termination signal. */
export type CheckpointFilesystemProcessFactory = (verifiedExecutable: string, args?: readonly string[]) => CheckpointFilesystemProcess;

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

  /** Isolated asynchronous Windows owner. No automatic restart can reuse its
   * handles. Disposable storage may pin up to four bounded write names until
   * a name mutation, eviction or close; pins prevent external replacement. */
  static createWindowsSession(timeoutMs = 5000, createProcess?: CheckpointFilesystemProcessFactory, pinWrites = false): CheckpointFilesystemSession {
    if (process.platform !== "win32") throw Error("Windows filesystem session required");
    const owner = ownedWindowsBridge(timeoutMs, createProcess, pinWrites);
    return {
      get failed() { return owner.failed(); },
      observeNodeProcesses: () => owner.api.observeNodeProcesses(),
      readLocalProcessDeclaration: (endpoint, pid) => owner.api.readLocalProcessDeclaration(endpoint, pid),
      openPath: async (path, create, readOnly = false) => {
        if (readOnly && create) throw Error("Read-only directory cannot be created");
        const value = await owner.api.openPath(path, create, readOnly);
        return new CheckpointDirectoryHandle(value, await owner.api.identity(value), owner.api);
      },
      close: owner.stop,
    };
  }

  /** A successful close proves actual owner exit; a deadline failure does not. */
  static createPosixSession(timeoutMs = 5000, createProcess?: CheckpointFilesystemProcessFactory): CheckpointFilesystemSession {
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw Error('POSIX filesystem session required');
    const owner = ownedPosixFilesystem(timeoutMs, () => verifyCheckpointBridgeArtifactAsync(
      fileURLToPath(new URL('../', import.meta.url)), checkpointBridgeTarget(),
    ), createProcess);
    const api: BridgeApi = { ...windowsApi(owner.request), maximumTransferBytes: POSIX_FILESYSTEM_LIMITS.fileBytes };
    const writeFile = api.writeFile, writeRange = api.writeRange, readFile = api.readFile;
    // Reject before the shared wire adapter creates a base64 copy.
    api.writeFile = (parent, name, bytes) => bytes.length > POSIX_FILESYSTEM_LIMITS.fileBytes
      ? Promise.reject(Error('Filesystem write exceeds its byte bound')) : writeFile(parent, name, bytes);
    api.writeRange = (parent, name, maximum, offset, bytes, identity) => bytes.length > POSIX_FILESYSTEM_LIMITS.fileBytes
      ? Promise.reject(Error('Filesystem write exceeds its byte bound')) : writeRange(parent, name, maximum, offset, bytes, identity);
    api.readFile = (parent, name, declared, offset, limit, identity, prefix) => !Number.isSafeInteger(limit) || limit < 1 || limit > POSIX_FILESYSTEM_LIMITS.fileBytes
      ? Promise.reject(Error('Filesystem read exceeds its byte bound')) : readFile(parent, name, declared, offset, limit, identity, prefix);
    return {
      get failed() { return owner.failed(); },
      observeNodeProcesses: () => api.observeNodeProcesses(),
      readLocalProcessDeclaration: (endpoint, pid) => api.readLocalProcessDeclaration(endpoint, pid),
      openPath: async (path, create, readOnly = false) => {
        if (readOnly && create) throw Error('Read-only directory cannot be created');
        const value = await api.openPath(path, create, readOnly);
        try { return new CheckpointDirectoryHandle(value, await api.identity(value), api); }
        catch (cause) { await api.close(value).catch(() => {}); throw cause; }
      },
      close: owner.stop,
    };
  }

  static createSession(timeoutMs = 5000, createProcess?: CheckpointFilesystemProcessFactory, pinWrites = false): CheckpointFilesystemSession {
    return process.platform === 'win32'
      ? this.createWindowsSession(timeoutMs, createProcess, pinWrites)
      : this.createPosixSession(timeoutMs, createProcess);
  }

  async openDirectory(name: string, create: boolean): Promise<CheckpointDirectoryHandle> {
    await this.#assertOpen();
    const value = await this.#bridge.openDirectory(this.#openHandle(), childName(name), create);
    try {
      const identity = await this.#bridge.identity(value);
      this.#openHandle();
      return new CheckpointDirectoryHandle(value, identity, this.#bridge);
    }
    catch (cause) { await this.#bridge.close(value).catch(() => {}); throw cause; }
  }

  async writeFile(name: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > (this.#bridge.maximumTransferBytes ?? Infinity)) throw new TypeError('Filesystem write exceeds its byte bound');
    await this.#assertOpen();
    await this.#bridge.writeFile(this.#openHandle(), childName(name), Buffer.from(bytes));
  }

  async statFile(name: string): Promise<{ bytes: number; identity: string }> {
    await this.#assertOpen();
    return this.#bridge.statFile(this.#openHandle(), childName(name));
  }

  /** Physical inventory of one pinned child, rejecting reparse points/hard links. */
  async statEntry(name: string): Promise<CheckpointEntry> {
    await this.#assertOpen();
    return this.#bridge.statEntry(this.#openHandle(), childName(name));
  }
  async availableDiskBytes(): Promise<number> {
    await this.#assertOpen();
    const bytes = await this.#bridge.availableDiskBytes(this.#openHandle());
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid volume free space');
    return bytes;
  }

  /** Exclusive creation, or a bounded write to the caller's existing file identity. */
  async writeAt(name: string, maximumBytes: number, offset: number, bytes: Uint8Array, identity?: string): Promise<CheckpointEntry> {
    await this.#assertOpen();
    if (!Number.isSafeInteger(maximumBytes) || !Number.isSafeInteger(offset) || offset < 0 || maximumBytes < offset + bytes.byteLength || bytes.byteLength > 256 * 1024)
      throw new TypeError('Invalid bounded file write');
    return this.#bridge.writeAt(this.#openHandle(), childName(name), maximumBytes, offset, Buffer.from(bytes), identity);
  }

  async copyRange(source: string, sourceIdentity: string, sourceBytes: number, sourceOffset: number, target: string, targetIdentity: string | undefined, targetOffset: number, length: number): Promise<CheckpointEntry> {
    await this.#assertOpen();
    if (![sourceBytes, sourceOffset, targetOffset, length].every(Number.isSafeInteger) || sourceOffset < 0 || targetOffset < 0 || (!targetIdentity && targetOffset !== 0) || length <= 0 || length > 1024 * 1024 || sourceBytes - sourceOffset < length || !Number.isSafeInteger(targetOffset + length))
      throw new TypeError('Invalid bounded file copy');
    return this.#bridge.copyRange(this.#openHandle(), childName(source), sourceIdentity, sourceBytes, sourceOffset, childName(target), targetIdentity, targetOffset, length);
  }

  /** One bounded IPC operation; each child still receives the ordinary native safety checks. */
  async statFiles(names: readonly string[]): Promise<readonly { bytes: number; identity: string }[]> {
    if (names.length > 4096) throw new TypeError("Checkpoint file inventory exceeds its bound");
    const children = names.map(childName);
    await this.#assertOpen();
    const result = await this.#bridge.statFiles(this.#openHandle(), children);
    if (result.length !== children.length) throw new TypeError("Checkpoint file inventory is incomplete");
    return result;
  }

  /** Only the caller's already-retired object may be truncated. Never follows links. */
  async truncateFile(name: string, identity: string, bytes: number): Promise<void> {
    await this.#assertOpen();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Invalid truncate size");
    await this.#bridge.truncateFile(this.#openHandle(), childName(name), identity, bytes);
  }

  /** One permanent, empty control file; contention creates no temporary files. */
  async tryLock(name: string): Promise<(() => Promise<void>) | undefined> {
    await this.#assertOpen();
    const value = await this.#bridge.tryLock(this.#openHandle(), childName(name));
    if (value === 0n) return undefined;
    try { this.#openHandle(); }
    catch (cause) { await this.#bridge.close(value).catch(() => {}); throw cause; }
    let released = false;
    return async () => { if (!released) { released = true; await this.#bridge.close(value); } };
  }

  /** Bounded lock admission; Windows keeps a pending kernel request across releases. */
  async waitLock(name: string, waitMs: number, mode: "exclusive" | "shared" = "exclusive"): Promise<(() => Promise<void>) | undefined> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 2000) throw new TypeError("Invalid control lock wait bound");
    await this.#assertOpen();
    const value = await this.#bridge.waitLock(this.#openHandle(), childName(name), waitMs, mode === "shared", () => { this.#openHandle(); });
    if (value === 0n) return undefined;
    try { this.#openHandle(); }
    catch (cause) { await this.#bridge.close(value).catch(() => {}); throw cause; }
    let released = false;
    return async () => { if (!released) { released = true; await this.#bridge.close(value); } };
  }

  async readFile(name: string, declaredBytes: number, offset: number, limit: number, identity?: string, prefix = false): Promise<Buffer> {
    await this.#assertOpen();
    if (prefix && (!identity || declaredBytes < 0 || offset + limit > declaredBytes)) throw new TypeError("Invalid durable prefix read");
    return this.#bridge.readFile(this.#openHandle(), childName(name), declaredBytes, offset, limit, identity ?? "", prefix);
  }

  async listEntries(maximumEntries: number): Promise<readonly string[]> {
    await this.#assertOpen();
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new TypeError("Checkpoint directory entry bound is invalid");
    }
    const entries = await this.#bridge.listEntries(this.#openHandle(), maximumEntries);
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new TypeError("Checkpoint directory entries are invalid");
    }
    return [...entries].sort();
  }

  /** Ordinal page in native directory order. The owner must serialize deletion
   * or revalidate its mutation ledger; this is not a filesystem snapshot. */
  async listEntryPage(offset: number, limit: number): Promise<{ names: readonly string[]; end: boolean }> {
    await this.#assertOpen();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4096 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw Error('Invalid directory page');
    const page = await this.#bridge.listEntryPage(this.#openHandle(), offset, limit);
    if (!Array.isArray(page.names) || page.names.length > limit || page.names.some(name => typeof name !== 'string') || typeof page.end !== 'boolean' || (!page.end && !page.names.length)) throw Error('Invalid directory page result');
    return page;
  }

  async writeRange(name: string, maximumBytes: number, offset: number, bytes: Uint8Array, identity?: string): Promise<number> {
    if (bytes.byteLength > (this.#bridge.maximumTransferBytes ?? Infinity)) throw new TypeError('Filesystem write exceeds its byte bound');
    await this.#assertOpen();
    return this.#bridge.writeRange(this.#openHandle(), childName(name), maximumBytes, offset, Buffer.from(bytes), identity ?? "");
  }

  async renameTo(name: string, target: CheckpointDirectoryHandle, targetName: string, replace = false): Promise<void> {
    await this.#assertOpen();
    await target.#assertOpen();
    if (this.#bridge !== target.#bridge) throw Error("Cross-session filesystem rename");
    await this.#bridge.renameEntry(this.#openHandle(), childName(name), target.#openHandle(), childName(targetName), replace);
  }

  async unlink(name: string, directory: boolean, expectedIdentity?: string): Promise<void> {
    await this.#assertOpen();
    await this.#bridge.unlinkEntry(this.#openHandle(), childName(name), directory, undefined, expectedIdentity);
  }

  /** Remove only a verified zero-length retired file, even while a reader holds it. */
  async removeRetired(name: string, identity: string): Promise<void> {
    await this.#assertOpen();
    await this.#bridge.unlinkEntry(this.#openHandle(), childName(name), false, identity);
  }

  async sync(): Promise<void> {
    await this.#assertOpen();
    await this.#bridge.sync(this.#openHandle());
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
    if (await this.#bridge.identity(this.#openHandle()) !== this.identity) {
      throw new TypeError("Checkpoint directory handle identity changed");
    }
    this.#openHandle();
  }

  /** Recheck in the same turn as dispatch: an awaited identity check alone
   * permits close/reuse of a native fd before the operation resumes. */
  #openHandle(): bigint {
    if (this.#closed) throw new Error("Checkpoint directory handle is closed");
    return this[handle];
  }
}

let loadedNative: NativeCheckpointChildBridge | undefined;
function native(): NativeCheckpointChildBridge {
    let loaded = loadedNative;
    if (loaded) return loaded;
    const target = checkpointBridgeTarget();
    assertCheckpointBridgeHost(target, currentGlibcVersion());
    loaded = createRequire(import.meta.url)(verifyCheckpointBridgeArtifact(
      fileURLToPath(new URL("../", import.meta.url)), target,
    )) as NativeCheckpointChildBridge;
    loadedNative = loaded;
    return loaded;
}

/** OS incarnation, not a PID-liveness or second-resolution timestamp substitute. */
export function readDarwinProcessBirth(pid: number): string {
  if (process.platform !== "darwin") throw Error("Darwin process identity required");
  return native().processBirth(pid);
}

/** Same-connection OS peer proof; used only by isolated process observers. */
export function readLocalProcessDeclaration(endpoint: string, pid: number): string {
  if (process.platform !== "linux") throw Error("Native local peer observation unavailable");
  return native().readLocalProcessDeclaration(endpoint, pid);
}

function nativeBridge(): BridgeApi {
  return {
    availableDiskBytes: async (...args) => native().availableDiskBytes(...args),
    statEntry: async (...args) => native().statEntry(...args),
    writeAt: async (parent, name, maximum, offset, bytes, identity) => native().writeAt(parent, name, maximum, offset, bytes, identity ?? ''),
    copyRange: async (parent, source, sourceIdentity, sourceBytes, sourceOffset, target, targetIdentity, targetOffset, length) => native().copyRange(parent, source, sourceIdentity, sourceBytes, sourceOffset, target, targetIdentity ?? '', targetOffset, length),
    observeNodeProcesses: async () => { throw Error("Windows process inventory required"); },
    readLocalProcessDeclaration: async (...args) => native().readLocalProcessDeclaration(...args),
    openPath: async (...args) => native().openPath(...args),
    statFile: async (...args) => native().statFile(...args),
    statFiles: async (parent, names) => names.map(name => native().statFile(parent, name)),
    truncateFile: async (...args) => native().truncateFile(...args),
    tryLock: async (...args) => native().tryLock(...args),
    waitLock: async (parent, name, waitMs, shared, assertOpen) => {
      const deadline = performance.now() + waitMs;
      do {
        assertOpen?.();
        const value = shared ? native().tryReadLock(parent, name) : native().tryLock(parent, name);
        if (value !== 0n) return value;
        await delay(Math.min(10, Math.max(1, deadline - performance.now())));
      } while (performance.now() < deadline);
      return 0n;
    },
    openDirectory: async (...args) => native().openDirectory(...args),
    identity: async (...args) => native().identity(...args),
    writeFile: async (...args) => native().writeFile(...args),
    readFile: async (...args) => native().readFile(...args),
    listEntries: async (...args) => native().listEntries(...args),
    listEntryPage: async (...args) => native().listEntryPage(...args),
    writeRange: async (...args) => native().writeRange(...args),
    renameEntry: async (source, name, target, targetName, replace) => {
      native().renameEntry(source, name, target, targetName, replace ?? false);
    },
    unlinkEntry: async (parent, name, directory, retiredIdentity, expectedIdentity) => {
      // Native cooperation is implemented, but N/S complete-operation exclusion
      // and cleanup ownership must pass the same delivery before public use.
      if (expectedIdentity) throw Object.assign(Error('POSIX identity deletion awaits owner integration'), { code: 'ENOTSUP' });
      native().unlinkEntry(parent, name, directory, retiredIdentity ?? '', expectedIdentity ?? '');
    },
    sync: async (...args) => native().sync(...args),
    close: async (...args) => native().close(...args),
  };
}

/** One owned frame: finite JSON metadata followed by exact binary bytes. Raw
 * file data must not be expanded into base64 then parsed as a JSON string by
 * the native owner. The public filesystem methods retain their original bounds. */
function windowsRequest(id: number, op: string, input: Record<string, unknown>): Buffer {
  const data = Buffer.isBuffer(input.data) ? input.data : undefined;
  const fields = data ? { ...input, data: undefined, dataBytes: data.length } : input;
  const header = Buffer.from(JSON.stringify({ id, op, ...fields }) + '\n');
  if (header.length + (data?.length ?? 0) > 8 * 1024 * 1024) throw Error('Checkpoint request exceeds its bound');
  return data ? Buffer.concat([header, data]) : header;
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
    const frame = windowsRequest(id, op, input);
    return new Promise<T>((resolve, reject) => {
      process!.ref();
      refStream(process!.stdin);
      refStream(process!.stdout);
      refStream(process!.stderr);
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      process!.stdin.write(frame, (error) => {
        if (!error) return;
        pending.delete(id);
        releaseWindowsBridge(process, pending);
        reject(error);
      });
    });
  };

  return windowsApi(request);
}

export interface NodeProcessInventory {
  readonly complete: boolean;
  readonly entries: readonly { pid: number; birth: string; argv: readonly string[] | null }[];
  readonly failure?: { reason: "inventory-limit" | "identity-unavailable" | "arguments-unavailable"; pid?: number };
}

export interface CheckpointFilesystemSession {
  readonly failed: boolean;
  observeNodeProcesses(): Promise<NodeProcessInventory>;
  readLocalProcessDeclaration(endpoint: string, pid: number): Promise<string>;
  openPath(path: string, create: boolean, readOnly?: boolean): Promise<CheckpointDirectoryHandle>;
  /** POSIX can shorten its close bound to the containing owner's remaining
   * milliseconds. Repeated calls never extend the first close deadline. */
  close(remainingMs?: number): Promise<void>;
}

function ownedWindowsBridge(timeoutMs: number, createProcess?: CheckpointFilesystemProcessFactory, pinWrites = false): { api: BridgeApi; failed(): boolean; stop(remainingMs?: number): Promise<void> } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError('Invalid filesystem operation timeout');
  let child: CheckpointFilesystemProcess | undefined;
  let starting: Promise<void> | undefined, exited: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let closed = false, broken = false, nextId = 0;
  let firstFailure: Error | undefined;
  let closeDeadline = Infinity;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let closeReject: ((cause: Error) => void) | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (completion?: Promise<void>): void => {
    const cause = firstFailure ?? Error("Filesystem owner stopped");
    if (completion) retainCheckpointFilesystemCompletion(cause, completion);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(cause); }
    pending.clear();
  };
  const armCloseDeadline = (): void => {
    if (!closeReject) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => closeReject!(Object.assign(Error('Filesystem owner exit was not confirmed before the close deadline'),
      { code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' })), Math.max(0, closeDeadline - performance.now()));
  };
  const stop = (remainingMs = 1000): Promise<void> => {
    if (!Number.isFinite(remainingMs) || remainingMs < 0) return Promise.reject(new TypeError('Invalid filesystem close budget'));
    closed = true;
    const deadline = performance.now() + Math.min(remainingMs, 1000);
    if (deadline < closeDeadline) { closeDeadline = deadline; armCloseDeadline(); }
    return stopping ??= (async () => {
      const actualCompletion = (async () => {
        try { await starting; } catch { /* No native owner was started. */ }
        await exited;
      })();
      try {
        const completion = (async () => {
          try { await starting; } catch { /* No native owner was started. */ }
          if (child) {
            child.ref(); refStream(child.stdin); refStream(child.stdout); refStream(child.stderr);
            child.kill('SIGKILL');
          }
          await exited;
        })();
        await new Promise<void>((resolve, reject) => {
          closeReject = reject; armCloseDeadline();
          void completion.then(resolve, reject);
        });
      } catch (cause) {
        firstFailure ??= cause instanceof Error ? cause : Error('Filesystem owner termination failed');
        retainCheckpointFilesystemCompletion(cause, actualCompletion);
        throw cause;
      } finally {
        clearTimeout(closeTimer); closeReject = undefined;
        // Broken control pipes may never yield close. Fail within the budget,
        // but retain physical permits until the actual owner has ended.
        settle(actualCompletion);
      }
    })();
  };
  const fail = (error?: Error): void => { firstFailure ??= error ?? Object.assign(Error("Filesystem protocol failed"), { code: "ERR_CHILD_PROCESS_PROTOCOL" }); broken = true; void stop().catch(() => {}); };
  const start = (): Promise<void> => starting ??= Promise.resolve().then(async () => {
    if (closed) throw Error("Filesystem owner closed");
    const executable = await verifyCheckpointBridgeArtifactAsync(fileURLToPath(new URL("../", import.meta.url)), checkpointBridgeTarget());
    if (closed) throw Error("Filesystem owner closed");
    const current = createProcess ? createProcess(executable) : spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = current;
    exited = new Promise<void>((resolve) => {
      // close is also emitted for spawn failure, whereas exit need not be.
      current.once("close", (exitCode, signal) => {
        if (!closed) firstFailure ??= Object.assign(Error("Filesystem owner exited"), { code: "ERR_CHILD_PROCESS_EXITED", exitCode, signal });
        broken = true; settle(); resolve();
      });
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
  const request = <T>(op: string, input: Record<string, unknown>): Promise<T> => {
    if (closed || broken) return Promise.reject(firstFailure ?? Error("Filesystem owner unavailable"));
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => fail(Object.assign(Error("Filesystem operation timed out"), { code: "ETIMEDOUT" })), timeoutMs);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      void start().then(() => {
        if (closed || broken || !child || !pending.has(id)) return;
        const current = child;
        current.ref(); refStream(current.stdin); refStream(current.stdout); refStream(current.stderr);
        current.stdin.write(windowsRequest(id, op, input), (error) => { if (error) fail(error); });
      }).catch(fail);
    });
  };
  return { api: windowsApi(request, pinWrites), failed: () => closed || broken, stop };
}

function windowsApi(request: <T>(op: string, input: Record<string, unknown>) => Promise<T>, pinWrites = false): BridgeApi {
  const id = (value: bigint): number => {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new TypeError("Checkpoint bridge handle is invalid");
    return numeric;
  };
  return {
    statEntry: (parent, name) => request<CheckpointEntry>('statEntry', { parent: id(parent), name }),
    copyRange: (parent, source, sourceIdentity, sourceBytes, sourceOffset, target, targetIdentity, targetOffset, length) => request<CheckpointEntry>('copyRange', {
      parent: id(parent), source, sourceIdentity, sourceBytes, sourceOffset, target, targetOffset, length, ...(targetIdentity ? { targetIdentity } : {}),
    }),
    availableDiskBytes: (handle) => request<number>('availableDiskBytes', { handle: id(handle) }),
    writeAt: (parent, name, maximumBytes, offset, bytes, identity) => request<CheckpointEntry>('writeAt', {
      parent: id(parent), name, maximumBytes, offset, data: bytes, ...(identity ? { identity } : {}), ...(pinWrites ? { pin: true } : {}),
    }),
    observeNodeProcesses: () => request<NodeProcessInventory>("observeNodeProcesses", {}),
    readLocalProcessDeclaration: (endpoint, pid) => request<string>("readLocalProcessDeclaration", { endpoint, pid }),
    openPath: async (path, create, readOnly) => BigInt(await request<number>("openPath", { path, create, readOnly })),
    statFile: (parent, name) => request<{ bytes: number; identity: string }>("statFile", { parent: id(parent), name }),
    statFiles: (parent, names) => request<readonly { bytes: number; identity: string }[]>("statFiles", { parent: id(parent), names }),
    truncateFile: (parent, name, identity, bytes) => request<void>("truncateFile", { parent: id(parent), name, identity, bytes }),
    tryLock: async (parent, name) => BigInt(await request<number>("tryLock", { parent: id(parent), name })),
    waitLock: async (parent, name, waitMs, shared) => BigInt(await request<number>("waitLock", { parent: id(parent), name, waitMs, shared })),
    openDirectory: async (parent, name, create) => BigInt(await request<number>("openDirectory", { parent: id(parent), name, create })),
    identity: (value) => request<string>("identity", { handle: id(value) }),
    writeFile: (parent, name, bytes) => request<void>("writeFile", { parent: id(parent), name, data: bytes }),
    readFile: async (parent, name, declaredBytes, offset, limit, identity, prefix) => Buffer.from(
      await request<string>("readFile", { parent: id(parent), name, declaredBytes, offset, limit, prefix: prefix ?? false, ...(identity ? { identity } : {}) }),
      "base64",
    ),
    listEntries: (parent, maximumEntries) => request<readonly string[]>("listEntries", {
      parent: id(parent), maximumEntries,
    }),
    listEntryPage: (parent, offset, limit) => request<{ names: readonly string[]; end: boolean }>('listEntryPage', { parent: id(parent), offset, limit }),
    writeRange: (parent, name, maximumBytes, offset, bytes, identity) => request<number>("writeRange", {
      parent: id(parent), name, maximumBytes, offset, data: bytes, ...(identity ? { identity } : {}),
    }),
    renameEntry: (sourceParent, sourceName, targetParent, targetName, replace) => request<void>("renameEntry", {
      sourceParent: id(sourceParent), sourceName, targetParent: id(targetParent), targetName, replace: replace ?? false,
    }),
    unlinkEntry: (parent, name, directory, retiredIdentity, expectedIdentity) => request<void>("unlinkEntry", { parent: id(parent), name, directory, ...(retiredIdentity === undefined ? {} : { retiredIdentity }), ...(expectedIdentity ? { expectedIdentity } : {}) }),
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
  process: CheckpointFilesystemProcess | undefined,
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
