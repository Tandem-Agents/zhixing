import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Native delivery targets, not a restriction on the agent's domain model. */
export const CHECKPOINT_BRIDGE_TARGETS = [
  { id: "win32-x64", os: "win32", arch: "x64", file: "checkpoint_child_bridge.exe" },
  { id: "darwin-x64", os: "darwin", arch: "x64", file: "checkpoint_child_bridge.node" },
  { id: "darwin-arm64", os: "darwin", arch: "arm64", file: "checkpoint_child_bridge.node" },
  { id: "linux-x64", os: "linux", arch: "x64", file: "checkpoint_child_bridge.node" },
  { id: "linux-arm64", os: "linux", arch: "arm64", file: "checkpoint_child_bridge.node" },
] as const;

export type CheckpointBridgeTarget = (typeof CHECKPOINT_BRIDGE_TARGETS)[number];

export function checkpointBridgeTarget(os: string = process.platform, arch: string = process.arch): CheckpointBridgeTarget {
  const target = CHECKPOINT_BRIDGE_TARGETS.find((value) => value.os === os && value.arch === arch);
  if (!target) throw new Error(`当前安装包尚未提供 ${os}/${arch} 原生产物；未执行任何配置、身份或服务操作`);
  return target;
}

export function assertCheckpointBridgeHost(target: CheckpointBridgeTarget, glibcVersion?: string): void {
  if (target.os !== "linux") return;
  const [major, minor] = (glibcVersion ?? "").split(".").map(Number);
  if (major === undefined || minor === undefined || !Number.isInteger(major) || !Number.isInteger(minor) ||
    major < 2 || (major === 2 && minor < 35)) {
    throw new Error("当前 Linux 安装包需要 glibc 2.35 或更高版本；未执行任何配置、身份或服务操作");
  }
}

export function currentGlibcVersion(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return report.header?.glibcVersionRuntime;
}

export function checkpointBridgeArtifactDirectory(packageRoot: string, target: CheckpointBridgeTarget): string {
  return path.join(packageRoot, "build", "prebuilt", target.id);
}

/** Check identity and integrity before loading code, on every supported OS. */
export function verifyCheckpointBridgeArtifact(packageRoot: string, target: CheckpointBridgeTarget): string {
  const directory = checkpointBridgeArtifactDirectory(packageRoot, target);
  const file = path.join(directory, target.file);
  try {
    const binary = readFileSync(file);
    const descriptor: unknown = JSON.parse(readFileSync(path.join(directory, "descriptor.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new Error("invalid descriptor");
    const value = descriptor as Record<string, unknown>;
    if (Object.keys(value).sort().join("\0") !== ["arch", "bytes", "file", "os", "packageVersion", "schemaVersion", "sha256"].sort().join("\0") ||
      value.schemaVersion !== 1 || value.os !== target.os || value.arch !== target.arch ||
      value.file !== target.file || value.packageVersion !== manifest.version || value.bytes !== binary.byteLength ||
      value.sha256 !== createHash("sha256").update(binary).digest("hex")) throw new Error("invalid descriptor");
  } catch (cause) {
    throw new Error(`${target.id} checkpoint helper 缺失或与当前包不匹配；请重新安装 @zhixing/cli`, { cause });
  }
  return file;
}
