import * as path from "node:path";
import type { GrepFileResult } from "./types.js";

export function toDisplayPath(
  absolutePath: string,
  workingDirectory: string,
): string {
  const resolvedPath = path.resolve(absolutePath);
  const resolvedWorkingDirectory = path.resolve(workingDirectory);
  const relativePath = relativePathWithin(
    resolvedWorkingDirectory,
    resolvedPath,
  );

  if (relativePath !== null) {
    return relativePath === "" ? "." : toPosixPath(relativePath);
  }

  return toPosixPath(resolvedPath);
}

export function relativePathWithin(
  rootPath: string,
  targetPath: string,
): string | null {
  const relativePath = path.relative(
    path.resolve(rootPath),
    path.resolve(targetPath),
  );

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return relativePath;
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

export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
