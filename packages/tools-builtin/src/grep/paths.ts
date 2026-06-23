import * as path from "node:path";
import type { GrepFileResult } from "./types.js";

export function toDisplayPath(
  absolutePath: string,
  workingDirectory: string,
): string {
  const resolvedPath = path.resolve(absolutePath);
  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  const relativePath = path.relative(resolvedWorkingDirectory, resolvedPath);

  if (relativePath === "") return ".";
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return toPosixPath(relativePath);
  }

  return toPosixPath(resolvedPath);
}

export function sortGrepFiles<T extends Pick<GrepFileResult, "displayPath">>(
  files: readonly T[],
): T[] {
  return [...files].sort((a, b) =>
    comparePosixPathByCodePoint(a.displayPath, b.displayPath),
  );
}

export function comparePosixPathByCodePoint(a: string, b: string): number {
  const aChars = Array.from(a);
  const bChars = Array.from(b);
  const length = Math.min(aChars.length, bChars.length);

  for (let i = 0; i < length; i++) {
    const aCodePoint = aChars[i]!.codePointAt(0)!;
    const bCodePoint = bChars[i]!.codePointAt(0)!;
    if (aCodePoint !== bCodePoint) return aCodePoint - bCodePoint;
  }

  return aChars.length - bChars.length;
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
