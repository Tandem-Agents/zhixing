import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { acquireFileLock } from "@zhixing/core/persistence";
import { canonicalize } from "@zhixing/core/protocol";

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 10_000;

export async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  await writeDurableBytes(filePath, Buffer.from(canonicalize(value), "utf8"));
}

export async function writeDurableBytes(
  filePath: string,
  bytes: Uint8Array,
  mode: number = 0o600,
): Promise<void> {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, mode);
    await rename(temporary, filePath);
    await syncDirectory(parent);
    const durable = await readFile(filePath);
    if (!durable.equals(Buffer.from(bytes))) throw new Error("Durable file read-back failed");
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !isNodeError(error, "EINVAL", "EPERM", "EISDIR")) throw error;
  } finally {
    await handle.close();
  }
}

export async function withProgramLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, ".program-update.lock");
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireFileLock(lockPath, {
      staleMs: LOCK_STALE_MS,
      waitMs: LOCK_WAIT_MS,
      retryMs: 50,
      resourceName: "Program update",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Program update lock is busy") {
      throw new Error("Program update is already running");
    }
    throw error;
  }
  try {
    return await task();
  } finally {
    await release();
  }
}

function isNodeError(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && codes.includes((error as NodeJS.ErrnoException).code ?? "");
}
