import { assertCheckpointBridgeHost, checkpointBridgeTarget, currentGlibcVersion } from "@zhixing/mesh/checkpoint-bridge-artifact";

const MINIMUM_NODE_MAJOR = 24;

export interface RuntimeSupportInput {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly nodeVersion?: string;
  readonly glibcVersion?: string;
}

export function assertSupportedRuntime(input: RuntimeSupportInput = {}): void {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const major = Number.parseInt(nodeVersion.split(".", 1)[0] ?? "", 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error("当前 Node.js 版本不受支持；请安装 Node.js 24 或更高版本后重试");
  }
  const target = checkpointBridgeTarget(platform, arch);
  assertCheckpointBridgeHost(target, input.glibcVersion ?? currentGlibcVersion());
}
