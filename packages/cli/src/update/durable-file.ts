import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
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
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(canonicalize({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        await handle.sync();
        return await task();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
        await syncDirectory(root);
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const age = await stat(lockPath).then((entry) => Date.now() - entry.mtimeMs).catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Program update is already running");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

function isNodeError(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && codes.includes((error as NodeJS.ErrnoException).code ?? "");
}
