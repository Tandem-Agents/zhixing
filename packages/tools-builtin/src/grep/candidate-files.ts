import { globIterate } from "glob";
import * as path from "node:path";
import { GREP_DEFAULT_IGNORE_GLOBS } from "./constants.js";
import { relativePathWithin, toPosixPath } from "./paths.js";

export async function* listGrepCandidateFiles(
  searchRoot: string,
  globPattern: string | undefined,
): AsyncIterable<string> {
  const pattern = globPattern ?? "**/*";
  for await (const match of globIterate(pattern, {
    cwd: searchRoot,
    nodir: true,
    dot: true,
    ignore: GREP_DEFAULT_IGNORE_GLOBS,
    absolute: true,
  })) {
    yield path.resolve(String(match));
  }
}

export function toGrepCandidateRelativePath(
  searchRoot: string,
  absolutePath: string,
): string | null {
  const relativePath = relativePathWithin(searchRoot, absolutePath);
  if (relativePath === null || relativePath === "") return null;
  return toPosixPath(relativePath);
}
