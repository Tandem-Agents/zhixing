import { globIterate } from "glob/raw";
import * as path from "node:path";
import type { ToolExecutionContext } from "@zhixing-ai/core";
import { canReadAuthorizedFile } from "../utils.js";
import { GREP_DEFAULT_IGNORE_GLOBS } from "./constants.js";
import { relativePathWithin, toPosixPath } from "./paths.js";

export async function* listGrepCandidateFiles(
  searchRoot: string,
  globPattern: string | undefined,
  authorizeFileAccess?: ToolExecutionContext["authorizeFileAccess"],
): AsyncIterable<string> {
  const pattern = globPattern ?? "**/*";
  for await (const match of globIterate(pattern, {
    cwd: searchRoot,
    nodir: true,
    dot: true,
    ignore: GREP_DEFAULT_IGNORE_GLOBS,
    absolute: true,
  })) {
    const resolved = path.resolve(String(match));
    if (!(await canReadAuthorizedFile(resolved, authorizeFileAccess))) {
      continue;
    }
    yield resolved;
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
