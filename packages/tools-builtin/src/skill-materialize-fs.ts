import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolExecutionContext } from "@zhixing-ai/core";

export class SkillMaterializeBoundaryError extends Error {
  constructor(
    readonly code: "workspace-required" | "workspace-escape",
    message: string,
  ) {
    super(message);
    this.name = "SkillMaterializeBoundaryError";
  }
}

function escapesRoot(rootDir: string, targetPath: string): boolean {
  const rel = path.relative(rootDir, targetPath);
  return !rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * 在写入任何目录或字节之前校验 `skill_materialize` 的授权工作区实路径边界、
 * 逐级重解析点/符号链接与 `authorizeFileAccess` 权限，并在落盘后按原子策略写入。
 */
export async function writeMaterializedSkillFile(input: {
  readonly workingDirectory: string;
  readonly rawPath: string;
  readonly content: string;
  readonly overwrite: boolean;
  readonly authorizeFileAccess?: ToolExecutionContext["authorizeFileAccess"];
}): Promise<string> {
  const rawWs = input.workingDirectory.trim();
  if (!rawWs) {
    throw new SkillMaterializeBoundaryError(
      "workspace-required",
      "skill_materialize 需要当前运行具备已授权的工作区目录。",
    );
  }
  const workspaceRoot = await fs.realpath(rawWs);
  const wsStat = await fs.stat(workspaceRoot);
  if (!wsStat.isDirectory()) {
    throw new SkillMaterializeBoundaryError(
      "workspace-required",
      "skill_materialize 工作区根目录无效。",
    );
  }

  const candidateTarget = path.resolve(workspaceRoot, input.rawPath);
  if (escapesRoot(workspaceRoot, candidateTarget)) {
    throw new SkillMaterializeBoundaryError(
      "workspace-escape",
      "skill_materialize 目标路径必须位于当前已授权工作区内。",
    );
  }

  const relToWs = path.relative(workspaceRoot, candidateTarget);
  const segments = relToWs.split(path.sep);
  let walk = workspaceRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    walk = path.join(walk, segments[i]!);
    try {
      const st = await fs.lstat(walk);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new SkillMaterializeBoundaryError(
          "workspace-escape",
          "拒绝通过符号链接或重解析点目录写入文件。",
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }

  try {
    const targetLstat = await fs.lstat(candidateTarget);
    if (targetLstat.isSymbolicLink()) {
      throw new SkillMaterializeBoundaryError(
        "workspace-escape",
        "拒绝覆盖符号链接目标文件。",
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await input.authorizeFileAccess?.({ path: candidateTarget, access: "write" });

  await fs.mkdir(path.dirname(candidateTarget), { recursive: true });
  const realParent = await fs.realpath(path.dirname(candidateTarget));
  if (
    realParent !== workspaceRoot &&
    escapesRoot(workspaceRoot, realParent)
  ) {
    throw new SkillMaterializeBoundaryError(
      "workspace-escape",
      "skill_materialize 目标父目录在落盘前逃逸出工作区。",
    );
  }
  const finalTarget = path.join(realParent, path.basename(candidateTarget));

  if (!input.overwrite) {
    await fs.writeFile(finalTarget, input.content, { encoding: "utf8", flag: "wx" });
    return finalTarget;
  }

  try {
    const st = await fs.lstat(finalTarget);
    if (st.isSymbolicLink()) {
      throw new SkillMaterializeBoundaryError(
        "workspace-escape",
        "拒绝原子替换符号链接目标文件。",
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const tmpPath = path.join(realParent, `.skill-materialize-${process.pid}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, input.content, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmpPath, finalTarget);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  return finalTarget;
}
