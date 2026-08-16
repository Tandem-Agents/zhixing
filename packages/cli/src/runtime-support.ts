const MINIMUM_NODE_MAJOR = 24;

export interface RuntimeSupportInput {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly nodeVersion?: string;
}

export function assertSupportedRuntime(input: RuntimeSupportInput = {}): void {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const major = Number.parseInt(nodeVersion.split(".", 1)[0] ?? "", 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error("当前 Node.js 版本不受支持；请安装 Node.js 24 或更高版本后重试");
  }
  if (platform !== "win32" || arch !== "x64") {
    throw new Error("当前版本仅支持 Windows x64；未执行任何配置、身份或服务操作");
  }
}
