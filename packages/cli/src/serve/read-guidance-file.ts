import { constants } from "node:fs";
import { lstat as fsLstat, open as fsOpen } from "node:fs/promises";

import { PathGuard, type ReadGuidanceFile } from "@zhixing/core";

export interface GuidanceFileReaderDeps {
  readonly lstat: typeof fsLstat;
  readonly open: typeof fsOpen;
}

export function createGuidanceFileReader(
  deps: GuidanceFileReaderDeps = { lstat: fsLstat, open: fsOpen },
): ReadGuidanceFile {
  return async ({ scopeRoot, path: filePath, reportWarning }) => {
    const warn = (message: string): void => reportWarning({ message });

    if (!PathGuard.isWithinWorkspace(filePath, scopeRoot, scopeRoot)) {
      warn(`约定文件不在作用域根目录内，已跳过：${filePath}`);
      return null;
    }

    let stat;
    try {
      stat = await deps.lstat(filePath);
    } catch (err) {
      if (isMissingPathError(err)) return null;
      warn(`约定文件状态读取失败，已跳过：${filePath}：${errorMessage(err)}`);
      return null;
    }

    if (stat.isSymbolicLink()) {
      warn(`约定文件是符号链接或重解析点，已跳过：${filePath}`);
      return null;
    }

    if (!stat.isFile()) {
      warn(`约定路径不是普通文件，已跳过：${filePath}`);
      return null;
    }

    let handle;
    try {
      handle = await deps.open(filePath, constants.O_RDONLY | noFollowFlag());
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        warn(`约定路径打开后不是普通文件，已跳过：${filePath}`);
        return null;
      }
      return await handle.readFile("utf8");
    } catch (err) {
      if (isMissingPathError(err)) return null;
      warn(`约定文件读取失败，已跳过：${filePath}：${errorMessage(err)}`);
      return null;
    } finally {
      await handle?.close();
    }
  };
}

export const readGuidanceFile: ReadGuidanceFile = createGuidanceFileReader();

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isMissingPathError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return err.code === "ENOENT" || err.code === "ENOTDIR";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
