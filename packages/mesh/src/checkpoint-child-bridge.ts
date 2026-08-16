import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

interface NativeCheckpointChildBridge {
  openPath(path: string, create: boolean): bigint;
  openDirectory(parent: bigint, name: string, create: boolean): bigint;
  identity(handle: bigint): string;
  writeFile(parent: bigint, name: string, bytes: Buffer): void;
  readFile(parent: bigint, name: string, declaredBytes: number, offset: number, limit: number): Buffer;
  listEntries(parent: bigint, maximumEntries: number): string[];
  writeRange(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer): number;
  renameEntry(sourceParent: bigint, sourceName: string, targetParent: bigint, targetName: string): void;
  unlinkEntry(parent: bigint, name: string, directory: boolean): void;
  sync(handle: bigint): void;
  close(handle: bigint): void;
}

interface BridgeApi {
  openPath(path: string, create: boolean): Promise<bigint>;
  openDirectory(parent: bigint, name: string, create: boolean): Promise<bigint>;
  identity(handle: bigint): Promise<string>;
  writeFile(parent: bigint, name: string, bytes: Buffer): Promise<void>;
  readFile(parent: bigint, name: string, declaredBytes: number, offset: number, limit: number): Promise<Buffer>;
  listEntries(parent: bigint, maximumEntries: number): Promise<readonly string[]>;
  writeRange(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer): Promise<number>;
  renameEntry(sourceParent: bigint, sourceName: string, targetParent: bigint, targetName: string): Promise<void>;
  unlinkEntry(parent: bigint, name: string, directory: boolean): Promise<void>;
  sync(handle: bigint): Promise<void>;
  close(handle: bigint): Promise<void>;
}

const bridge: BridgeApi = process.platform === "win32" ? windowsBridge() : nativeBridge();
const handle = Symbol("checkpoint-child-handle");

export class CheckpointDirectoryHandle {
  readonly identity: string;
  readonly [handle]: bigint;
  #closed = false;

  private constructor(value: bigint, identity: string) {
    this[handle] = value;
    this.identity = identity;
  }

  static async openPath(path: string, create: boolean): Promise<CheckpointDirectoryHandle> {
    const value = await bridge.openPath(path, create);
    return new CheckpointDirectoryHandle(value, await bridge.identity(value));
  }

  async openDirectory(name: string, create: boolean): Promise<CheckpointDirectoryHandle> {
    await this.#assertOpen();
    const value = await bridge.openDirectory(this[handle], childName(name), create);
    return new CheckpointDirectoryHandle(value, await bridge.identity(value));
  }

  async writeFile(name: string, bytes: Uint8Array): Promise<void> {
    await this.#assertOpen();
    await bridge.writeFile(this[handle], childName(name), Buffer.from(bytes));
  }

  async readFile(name: string, declaredBytes: number, offset: number, limit: number): Promise<Buffer> {
    await this.#assertOpen();
    return bridge.readFile(this[handle], childName(name), declaredBytes, offset, limit);
  }

  async listEntries(maximumEntries: number): Promise<readonly string[]> {
    await this.#assertOpen();
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new TypeError("Checkpoint directory entry bound is invalid");
    }
    const entries = await bridge.listEntries(this[handle], maximumEntries);
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new TypeError("Checkpoint directory entries are invalid");
    }
    return [...entries].sort();
  }

  async writeRange(name: string, maximumBytes: number, offset: number, bytes: Uint8Array): Promise<number> {
    await this.#assertOpen();
    return bridge.writeRange(this[handle], childName(name), maximumBytes, offset, Buffer.from(bytes));
  }

  async renameTo(name: string, target: CheckpointDirectoryHandle, targetName: string): Promise<void> {
    await this.#assertOpen();
    await target.#assertOpen();
    await bridge.renameEntry(this[handle], childName(name), target[handle], childName(targetName));
  }

  async unlink(name: string, directory: boolean): Promise<void> {
    await this.#assertOpen();
    await bridge.unlinkEntry(this[handle], childName(name), directory);
  }

  async sync(): Promise<void> {
    await this.#assertOpen();
    await bridge.sync(this[handle]);
  }

  async assertIdentity(): Promise<void> {
    await this.#assertOpen();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await bridge.close(this[handle]);
  }

  async #assertOpen(): Promise<void> {
    if (this.#closed) throw new Error("Checkpoint directory handle is closed");
    if (await bridge.identity(this[handle]) !== this.identity) {
      throw new TypeError("Checkpoint directory handle identity changed");
    }
  }
}

function nativeBridge(): BridgeApi {
  const native = createRequire(import.meta.url)(
    fileURLToPath(new URL("../build/Release/checkpoint_child_bridge.node", import.meta.url)),
  ) as NativeCheckpointChildBridge;
  return {
    openPath: async (...args) => native.openPath(...args),
    openDirectory: async (...args) => native.openDirectory(...args),
    identity: async (...args) => native.identity(...args),
    writeFile: async (...args) => native.writeFile(...args),
    readFile: async (...args) => native.readFile(...args),
    listEntries: async (...args) => native.listEntries(...args),
    writeRange: async (...args) => native.writeRange(...args),
    renameEntry: async (...args) => native.renameEntry(...args),
    unlinkEntry: async (...args) => native.unlinkEntry(...args),
    sync: async (...args) => native.sync(...args),
    close: async (...args) => native.close(...args),
  };
}

function windowsBridge(): BridgeApi {
  let nextId = 1;
  let process: ChildProcessWithoutNullStreams | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  let verifiedArtifact: Promise<string> | undefined;
  const request = async <T>(op: string, input: Record<string, unknown>): Promise<T> => {
    if (!process) {
      const executable = await (verifiedArtifact ??= verifyWindowsBridgeArtifact());
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

  const id = (value: bigint): number => {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new TypeError("Checkpoint bridge handle is invalid");
    return numeric;
  };
  return {
    openPath: async (path, create) => BigInt(await request<number>("openPath", { path, create })),
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
    unlinkEntry: (parent, name, directory) => request<void>("unlinkEntry", { parent: id(parent), name, directory }),
    sync: (value) => request<void>("sync", { handle: id(value) }),
    close: (value) => request<void>("close", { handle: id(value) }),
  };
}

interface CheckpointBridgeDescriptor {
  readonly schemaVersion: 1;
  readonly os: "win32";
  readonly arch: "x64";
  readonly packageVersion: string;
  readonly file: "checkpoint_child_bridge.exe";
  readonly bytes: number;
  readonly sha256: string;
}

async function verifyWindowsBridgeArtifact(): Promise<string> {
  const executable = fileURLToPath(
    new URL("../build/Release/checkpoint_child_bridge.exe", import.meta.url),
  );
  const [binary, descriptorBytes, packageBytes] = await Promise.all([
    readFile(executable),
    readFile(
      fileURLToPath(
        new URL("../build/Release/checkpoint_child_bridge.descriptor.json", import.meta.url),
      ),
      "utf8",
    ),
    readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ]).catch(() => {
    throw new Error("Windows checkpoint helper 不完整；请重新安装 @zhixing/cli");
  });
  let descriptor: CheckpointBridgeDescriptor;
  let packageVersion: string;
  try {
    descriptor = JSON.parse(descriptorBytes) as CheckpointBridgeDescriptor;
    packageVersion = (JSON.parse(packageBytes) as { readonly version?: unknown }).version as string;
  } catch {
    throw new Error("Windows checkpoint helper 描述无效；请重新安装 @zhixing/cli");
  }
  const digest = createHash("sha256").update(binary).digest("hex");
  const descriptorKeys = Object.keys(descriptor).sort();
  if (
    descriptorKeys.join("\0") !== [
      "arch", "bytes", "file", "os", "packageVersion", "schemaVersion", "sha256",
    ].sort().join("\0") ||
    descriptor.schemaVersion !== 1 || descriptor.os !== "win32" ||
    descriptor.arch !== "x64" || descriptor.file !== "checkpoint_child_bridge.exe" ||
    descriptor.packageVersion !== packageVersion || descriptor.bytes !== binary.byteLength ||
    !/^[0-9a-f]{64}$/u.test(descriptor.sha256) || descriptor.sha256 !== digest
  ) {
    throw new Error("Windows checkpoint helper 与当前包不匹配；请重新安装 @zhixing/cli");
  }
  return executable;
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
