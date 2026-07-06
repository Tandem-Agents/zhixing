import fs from "node:fs/promises";
import path from "node:path";

export type WorkdirProbeResult =
  | { kind: "directory" }
  | { kind: "missing" }
  | { kind: "non_directory" }
  | { kind: "inaccessible"; code: string }
  | { kind: "error"; code: string };

export function normalizeSceneName(input: string): string {
  const name = input.trim();
  if (!name) {
    throw new Error("工作场景名称不能为空");
  }
  return name;
}

export function normalizeWorkdir(input: string): string {
  const workdir = input.trim();
  if (!workdir) {
    throw new Error("工作目录不能为空");
  }
  return path.normalize(workdir);
}

export async function probeWorkdir(
  workdir: string,
): Promise<WorkdirProbeResult> {
  try {
    const stat = await fs.stat(workdir);
    return stat.isDirectory()
      ? { kind: "directory" }
      : { kind: "non_directory" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "EACCES" || code === "EPERM") {
      return { kind: "inaccessible", code };
    }
    return { kind: "error", code };
  }
}
