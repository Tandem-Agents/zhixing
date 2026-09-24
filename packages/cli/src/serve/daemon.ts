/**
 * Daemon 父进程分支
 *
 * 流程（对应 daemon-level-1-execution.md §3.1 父进程拓扑）：
 * 1. resolveSelfExec 拿 { command, args, env }
 * 2. 由 child 在固定 home 后装配统一 Recorder
 * 3. spawn + detach + unref（stdio 不连接文件）
 * 4. startupHandshake 轮询：PID 文件 + .ready marker + /api/health 200（三项皆需）
 * 5. 成功 → 打印横幅
 *    失败 → 统一日志应用查询本次启动证据
 *
 * 所有外部依赖通过 deps 注入，便于单测 mock 而不触发真实 spawn / 网络。
 */

import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { queryLocalLogs } from "../logging/local-query.js";
import { getZhixingHome } from "@zhixing/core/paths";
import http from "node:http";
import chalk from "chalk";
import {
  readLock,
  isProcessAlive,
  getDefaultLogPath,
  getDefaultPidPath,
  getDefaultPortPath,
  getDefaultReadyMarkerPath,
  type PidFileContents,
} from "@zhixing/server";
import {
  resolveSelfExec,
  buildDaemonSpawnOptions,
  UnsupportedSelfExecError,
} from "./self-exec.js";

export interface SpawnDaemonOptions {
  /** 本次启动与其发现、日志和 child 共用的数据根。 */
  zhixingHome?: string;
  /** 传给后台 child 的 CLI 参数；应含 "serve" 及其子选项。 */
  forwardedArgs: string[];
  /** handshake 上限，默认 5000ms */
  handshakeTimeoutMs?: number;
  /** 轮询间隔，默认 200ms */
  pollIntervalMs?: number;
  /** 依赖注入（测试用）*/
  deps?: SpawnDaemonDeps;
}

export interface SpawnDaemonDeps {
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  readLockFn?: typeof readLock;
  isProcessAliveFn?: typeof isProcessAlive;
  httpGetFn?: (url: string, timeoutMs: number) => Promise<number>;
  checkReadyMarkerFn?: () => Promise<boolean>;
  readLogsFn?: (home: string, since: number) => Promise<unknown>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  console?: Pick<Console, "log" | "error">;
  /** .ready marker 路径覆盖（测试用；默认 ~/.zhixing/server.ready）*/
  readyMarkerPath?: string;
}

export interface SpawnDaemonResult {
  ok: boolean;
  /**
   * ready: 已发现可连接服务。
   * starting: 本次 child 没有明确失败，但恢复窗口内尚未发现可连接服务。
   * failed: 本次 child 已失败，且没有其它健康 owner 可接管。
   */
  status: "ready" | "starting" | "failed";
  pid?: number;
  port?: number;
  /** 失败原因（仅 ok=false 时填）*/
  reason?: string;
  /** 日志路径（供调用方显示）*/
  logPath: string;
}

/**
 * 父进程主入口：spawn daemon child 并等待就绪。
 *
 * 调用方（command.ts）：
 *   const r = await spawnDaemon({ forwardedArgs: [...] });
 *   process.exit(r.ok ? 0 : 1);
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<SpawnDaemonResult> {
  const deps = opts.deps ?? {};
  const zhixingHome = opts.zhixingHome ?? getZhixingHome();
  const lockPaths = { pidPath: getDefaultPidPath(zhixingHome), portPath: getDefaultPortPath(zhixingHome) };
  const readyMarkerPath = deps.readyMarkerPath ?? getDefaultReadyMarkerPath(zhixingHome);
  const logPath = getDefaultLogPath(zhixingHome);
  const startedAt = Date.now();
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5000;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const con = deps.console ?? console;

  // 1. resolveSelfExec
  let execArgs;
  try {
    execArgs = resolveSelfExec(opts.forwardedArgs, {
      env: { ...process.env, ZHIXING_HOME: zhixingHome },
    });
  } catch (err) {
    if (err instanceof UnsupportedSelfExecError) {
      con.error(chalk.red(err.message));
      return { ok: false, status: "failed", reason: err.message, logPath };
    }
    throw err;
  }

  // The child owns its recorder; no append fd survives the parent.
  const spawnOpts = buildDaemonSpawnOptions(execArgs.env);
  const spawnFn = deps.spawnFn ?? spawn;
  const child = spawnFn(execArgs.command, execArgs.args, spawnOpts);
  let childExit: ChildExit | null = null;
  if (typeof child.once === "function") {
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
    });
  }
  // child.unref() 允许父进程退出时不等子进程
  try {
    child.unref();
  } catch {
    /* child 已死或 mock 场景 */
  }

  // 4. handshake
  const handshake = await startupHandshake({
    timeoutMs: handshakeTimeoutMs,
    pollIntervalMs,
    deps: {
      ...deps,
      readyMarkerPath,
      readLockFn: () => (deps.readLockFn ?? readLock)(lockPaths),
    },
    spawnedPid: child.pid,
    getChildExit: () => childExit,
  });

  if (handshake.ok) {
    printSuccessBanner(handshake.pid!, handshake.port!, logPath, con);
    return { ok: true, status: "ready", pid: handshake.pid, port: handshake.port, logPath };
  }

  // 5. 失败路径
  con.error(chalk.red(`知行服务启动未完成: ${handshake.reason ?? "unknown"}`));
  try {
    const evidence = await (deps.readLogsFn ?? ((home, from) => queryLocalLogs(home, { source: "runtime", from })))(zhixingHome, startedAt);
    con.error(JSON.stringify(evidence));
  } catch { con.error("启动日志暂不可用；可稍后运行 zz logs search --source runtime 查阅。"); }
  return { ok: false, status: handshake.status ?? "failed", reason: handshake.reason, logPath };
}

// ─── handshake ───

interface HandshakeResult {
  ok: boolean;
  status?: SpawnDaemonResult["status"];
  pid?: number;
  port?: number;
  reason?: string;
}

interface HandshakeOpts {
  timeoutMs: number;
  pollIntervalMs: number;
  deps: SpawnDaemonDeps;
  spawnedPid?: number;
  getChildExit?: () => ChildExit | null;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const CHILD_EXIT_DISCOVERY_GRACE_MS = 1000;

async function startupHandshake(opts: HandshakeOpts): Promise<HandshakeResult> {
  const clock = opts.deps.clock ?? Date.now;
  const sleep = opts.deps.sleep ?? defaultSleep;
  const readLockFn = opts.deps.readLockFn ?? readLock;
  const isAlive = opts.deps.isProcessAliveFn ?? isProcessAlive;
  const httpGet = opts.deps.httpGetFn ?? defaultHttpGet;
  const readyMarkerPath = opts.deps.readyMarkerPath ?? getDefaultReadyMarkerPath();
  const checkReadyMarker =
    opts.deps.checkReadyMarkerFn ?? (() => defaultCheckReadyMarker(readyMarkerPath));

  const start = clock();
  const deadline = start + opts.timeoutMs;

  let lastLock: PidFileContents | null = null;
  let sawReadyMarker = false;
  let childExitSeenAt: number | null = null;

  while (clock() < deadline) {
    const lock = await safeReadLock(readLockFn);
    if (lock) {
      lastLock = lock;
      if (isAlive(lock.pid)) {
        // 三项皆需：PID alive + .ready marker + /api/health 200
        const marker = await checkReadyMarker();
        sawReadyMarker = sawReadyMarker || marker;
        if (marker) {
          const healthOk = await checkHealth(lock, httpGet, 500);
          if (healthOk) {
            return { ok: true, status: "ready", pid: lock.pid, port: lock.port };
          }
        }
      }
    }
    const childExit = opts.getChildExit?.() ?? null;
    if (childExit && childExitSeenAt === null) {
      childExitSeenAt = clock();
    }
    if (
      childExit &&
      childExitSeenAt !== null &&
      clock() - childExitSeenAt >= CHILD_EXIT_DISCOVERY_GRACE_MS
    ) {
      return {
        ok: false,
        status: "failed",
        reason: formatChildExitReason(opts.spawnedPid, childExit),
      };
    }
    await sleep(opts.pollIntervalMs);
  }

  // 超时——给出具体原因
  const childExit = opts.getChildExit?.() ?? null;
  if (childExit) {
    return {
      ok: false,
      status: "failed",
      reason: formatChildExitReason(opts.spawnedPid, childExit),
    };
  }
  if (!lastLock) {
    return {
      ok: false,
      status: "starting",
      reason: "知行服务仍在启动，暂未进入可连接状态",
    };
  }
  if (!isAlive(lastLock.pid)) {
    if (opts.spawnedPid !== undefined && lastLock.pid !== opts.spawnedPid) {
      return {
        ok: false,
        status: "starting",
        reason: "旧的服务状态已失效，新的知行服务仍在启动",
      };
    }
    return {
      ok: false,
      status: "failed",
      reason: `知行服务进程 ${lastLock.pid} 已退出，且没有发现可用服务`,
    };
  }
  if (!sawReadyMarker) {
    return {
      ok: false,
      status: "starting",
      reason: "知行服务仍在启动，暂未进入可连接状态",
    };
  }
  return {
    ok: false,
    status: "starting",
    reason: "知行服务正在启动，但暂时还不能连接",
  };
}

function formatChildExitReason(
  spawnedPid: number | undefined,
  exit: ChildExit,
): string {
  const pid = spawnedPid === undefined ? "" : ` ${spawnedPid}`;
  const detail =
    exit.signal !== null
      ? `信号 ${exit.signal}`
      : `退出码 ${exit.code ?? "unknown"}`;
  return `知行服务进程${pid}已退出（${detail}），且没有发现可用服务`;
}

async function safeReadLock(fn: typeof readLock): Promise<PidFileContents | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function checkHealth(
  lock: PidFileContents,
  httpGet: (url: string, timeoutMs: number) => Promise<number>,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const status = await httpGet(`http://127.0.0.1:${lock.port}/api/health`, timeoutMs);
    return status === 200;
  } catch {
    return false;
  }
}

// ─── 默认实现 ───

async function defaultCheckReadyMarker(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function defaultHttpGet(url: string, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
  });
}

// ─── 输出 ───

function printSuccessBanner(
  pid: number,
  port: number,
  logPath: string,
  con: Pick<Console, "log" | "error">,
): void {
  con.log();
  con.log(chalk.green("  知行服务已启动（后台模式）"));
  con.log(chalk.dim(`  PID:   ${pid}`));
  con.log(chalk.dim(`  Port:  ${port}`));
  con.log(chalk.dim(`  Log:   ${logPath}`));
  con.log(chalk.dim(`  Stop:  zhixing stop`));
  con.log();
}
