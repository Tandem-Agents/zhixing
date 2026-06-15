/**
 * SelfExec — 父进程如何重入自己作为 daemon child
 *
 * 职责边界：
 * - 决定用什么 command + args 重启自己（process.argv[1]）
 * - 过滤 TTY/彩色相关 env 变量（daemon 无 TTY，避免 chalk 误判）
 * - 标记子进程身份（env var ZHIXING_DAEMON_CHILD=1，不用 CLI flag）
 * - 构造 detached spawn 选项（stdio 重定向、windowsHide）
 *
 * 非职责：
 * - 不真的 spawn（daemon.ts 负责）
 * - 不关心日志 fd 的打开/关闭（daemon.ts 负责）
 * - 不感知 server 生命周期
 *
 * 扩展点（预留给 Level 2 OS 服务）：
 * - resolveSelfExec 签名允许注入"bundled binary path resolver"
 * - buildDaemonSpawnOptions 可扩容 uid/gid/资源限制
 */

import { existsSync } from "node:fs";
import type { SpawnOptions } from "node:child_process";

/** Child 通过这个 env 变量识别自己——刻意不用 CLI flag 避免 commander 报 unknown option */
export const DAEMON_CHILD_ENV_VAR = "ZHIXING_DAEMON_CHILD";

/** 父进程试图 daemonize 但环境不支持（bundled binary / REPL / 无标准入口）时抛此错 */
export class UnsupportedSelfExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSelfExecError";
  }
}

export interface SelfExecArgs {
  /** Node binary 绝对路径（process.execPath）*/
  command: string;
  /** [entryScript, ...forwardedArgs] */
  args: string[];
  /** 过滤后 + 附加 ZHIXING_DAEMON_CHILD=1 的 env */
  env: NodeJS.ProcessEnv;
}

export interface DaemonSpawnOptions
  extends Pick<SpawnOptions, "detached" | "stdio" | "windowsHide" | "env"> {}

export interface ResolveSelfExecDeps {
  argv?: NodeJS.Process["argv"];
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  fileExistsFn?: (path: string) => boolean;
}

/** 子进程判定自身身份 */
export function isDaemonChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DAEMON_CHILD_ENV_VAR] === "1";
}

/**
 * 解析自重入所需的 { command, args, env }。
 *
 * 设计决策：
 * - 用 `process.argv[1]`（实际 entry script）而非 `process.execPath`（node binary）。
 *   execPath 只是 node 二进制；argv[1] 才是 zhixing 的入口 .js 文件。
 * - 非 .js 入口（bundled binary / REPL）→ 抛 UnsupportedSelfExecError。
 *   Level 1 要求通过标准 CLI 启动；未来 Level 2 可注入 bundled resolver。
 */
export function resolveSelfExec(
  forwardedArgs: string[],
  deps: ResolveSelfExecDeps = {},
): SelfExecArgs {
  const argv = deps.argv ?? process.argv;
  const execPath = deps.execPath ?? process.execPath;
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExistsFn ?? existsSync;

  const entryScript = argv[1];
  if (!entryScript) {
    throw new UnsupportedSelfExecError(
      "Cannot resolve self-exec: process.argv[1] is undefined. " +
        "Daemon mode requires launching via the standard zhixing CLI.",
    );
  }

  const isJs =
    entryScript.endsWith(".js") ||
    entryScript.endsWith(".mjs") ||
    entryScript.endsWith(".cjs");
  if (!isJs) {
    throw new UnsupportedSelfExecError(
      `Cannot daemonize: entry script is not a JavaScript file (got "${entryScript}"). ` +
        "Daemon Level 1 requires standard Node entry; bundled binaries are not supported.",
    );
  }
  if (!fileExists(entryScript)) {
    throw new UnsupportedSelfExecError(
      `Cannot daemonize: entry script "${entryScript}" does not exist on disk.`,
    );
  }

  return {
    command: execPath,
    args: [entryScript, ...forwardedArgs],
    env: {
      ...filterDaemonChildEnv(env),
      [DAEMON_CHILD_ENV_VAR]: "1",
    },
  };
}

/**
 * 过滤 TTY/彩色相关的 env 变量。
 *
 * Daemon child 无 TTY，保留 TERM/COLUMNS 等会让 chalk 误判为彩色终端，
 * 导致日志文件里充满 ANSI 转义序列。强制写 NO_COLOR=1 是最保险的关颜色方式。
 */
export function filterDaemonChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped = new Set([
    "TERM",
    "COLUMNS",
    "LINES",
    "FORCE_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "COLORTERM",
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (stripped.has(key)) continue;
    if (key.startsWith("SSH_TTY")) continue;
    out[key] = value;
  }
  out.NO_COLOR = "1";
  return out;
}

/**
 * 构造 daemon spawn 选项。
 *
 * - detached: true —— 所有平台脱离父进程组
 * - stdio: ["ignore", logFd, logFd] —— stdin 关，stdout/stderr 合并到日志文件
 * - windowsHide: true —— 防 Windows 弹出新 console 窗口（POSIX 无效）
 */
export function buildDaemonSpawnOptions(
  logFd: number,
  env: NodeJS.ProcessEnv,
): DaemonSpawnOptions {
  return {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env,
  };
}
