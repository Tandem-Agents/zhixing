import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import {
  decideServerLogPathTransition,
  getDefaultServerLogPaths,
  type ServerLogPathTransition,
  type ServerLogPaths,
} from "./server-log.js";

export interface PrepareServerLogForWriteDeps {
  mkdir: typeof mkdir;
  stat: typeof stat;
  copyFile: typeof copyFile;
  unlink: typeof unlink;
}

export interface PrepareServerLogForWriteOptions {
  paths?: ServerLogPaths;
  deps?: Partial<PrepareServerLogForWriteDeps>;
  logger?: {
    error: (msg: string, err?: unknown) => void;
  };
}

export interface PreparedServerLogForWrite {
  logPath: string;
  transition: ServerLogPathTransition;
  migratedLegacy: boolean;
  removedLegacy: boolean;
}

export async function prepareServerLogForWrite(
  opts: PrepareServerLogForWriteOptions = {},
): Promise<PreparedServerLogForWrite> {
  const paths = opts.paths ?? getDefaultServerLogPaths();
  const deps: PrepareServerLogForWriteDeps = {
    mkdir,
    stat,
    copyFile,
    unlink,
    ...opts.deps,
  };

  await deps.mkdir(paths.dirPath, { recursive: true });
  const transition = decideServerLogPathTransition({
    activeExists: await pathExists(deps, paths.activeLogPath),
    legacyExists: await pathExists(deps, paths.legacyLogPath),
    paths,
  });

  let migratedLegacy = false;
  let removedLegacy = false;
  if (transition.kind === "migrate-legacy") {
    migratedLegacy = await copyLegacyLog(deps, transition);
    if (migratedLegacy) {
      removedLegacy = await removeLegacyLog(deps, transition.migrateFrom!, opts.logger);
    }
  }

  return {
    logPath: transition.writePath,
    transition,
    migratedLegacy,
    removedLegacy,
  };
}

async function pathExists(
  deps: Pick<PrepareServerLogForWriteDeps, "stat">,
  path: string,
): Promise<boolean> {
  try {
    await deps.stat(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function copyLegacyLog(
  deps: Pick<PrepareServerLogForWriteDeps, "copyFile">,
  transition: ServerLogPathTransition,
): Promise<boolean> {
  try {
    await deps.copyFile(
      transition.migrateFrom!,
      transition.migrateTo!,
      fsConstants.COPYFILE_EXCL,
    );
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}

async function removeLegacyLog(
  deps: Pick<PrepareServerLogForWriteDeps, "unlink">,
  path: string,
  logger: PrepareServerLogForWriteOptions["logger"],
): Promise<boolean> {
  try {
    await deps.unlink(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    logger?.error("failed to remove legacy server log after migration", error);
    return false;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
