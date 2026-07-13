import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

export async function ensureDurableDirectory(directory: string): Promise<void> {
  const target = path.resolve(directory);
  const missing: string[] = [];
  let cursor = target;

  while (!(await isDirectory(cursor))) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Cannot create durable directory: ${target}`);
    }
    cursor = parent;
  }

  for (const current of missing.reverse()) {
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST") || !(await isDirectory(current))) {
        throw error;
      }
    }
    await syncDirectory(path.dirname(current));
    await syncDirectory(current);
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync().catch((error: unknown) => {
      if (
        process.platform === "win32" &&
        (isNodeError(error, "EPERM") || isNodeError(error, "EINVAL"))
      ) {
        return;
      }
      throw error;
    });
  } finally {
    await handle.close();
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new TypeError(`Durable directory cannot traverse a symbolic link: ${candidate}`);
    }
    if (!metadata.isDirectory()) {
      throw new TypeError(`Durable directory path is not a directory: ${candidate}`);
    }
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
