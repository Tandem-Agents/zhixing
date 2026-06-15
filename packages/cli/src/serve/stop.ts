/**
 * `zhixing serve stop` — 停止后台宿主
 *
 * POSIX 流程：
 *   readLock → RPC server.shutdown → 轮询 isProcessAlive → 失败时 SIGTERM/SIGKILL → 强制清理
 *
 * Windows 流程（SIGTERM 在 Windows 等价 force-kill，必须走应用层）：
 *   readLock → RPC server.shutdown (15s) → 轮询 → 超时 taskkill /T → 再超时 taskkill /F /T → 强制清理
 *
 * 所有外部依赖通过 deps 注入，单测 mock 信号 / RPC / taskkill 不真的触发系统调用。
 */

import chalk from "chalk";
import { stat, unlink, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readLock,
  isProcessAlive,
  releaseLock,
  createRpcClient,
  getDefaultStatePath,
  getDefaultReadyMarkerPath,
  getDefaultTokenPath,
  type PidFileContents,
} from "@zhixing/server";

const execFileAsync = promisify(execFile);

export interface StopOptions {
  /** 优雅停机上限，默认 30_000ms */
  timeoutMs?: number;
  /** 轮询间隔，默认 300ms */
  pollMs?: number;
  /** RPC graceful 超时，默认 15_000ms */
  rpcTimeoutMs?: number;
  /** 是否打印进度（默认 true）*/
  verbose?: boolean;
  /** 仅当当前 PID 文件仍指向此宿主时才停止；用于连接层僵死替换防误杀。 */
  expectedLock?: PidFileContents;
  /** 依赖注入，测试用 */
  deps?: StopDeps;
}

export interface StopDeps {
  readLockFn?: typeof readLock;
  isProcessAliveFn?: typeof isProcessAlive;
  releaseLockFn?: typeof releaseLock;
  killFn?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Windows 分支：发送 RPC server.shutdown */
  rpcShutdownFn?: (lock: PidFileContents, timeoutMs: number) => Promise<void>;
  /** Windows 分支：调用 taskkill */
  taskkillFn?: (pid: number, force: boolean) => Promise<void>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  console?: Pick<Console, "log" | "warn" | "error">;
  /** 测试覆盖 platform 判定 */
  platform?: NodeJS.Platform;
  /** 删除 state / ready 文件的路径（测试覆盖）*/
  statePath?: string;
  readyMarkerPath?: string;
}

export type StopResult =
  | { status: "nothing-to-stop" }
  | { status: "stopped"; pid: number; tookMs: number; path: "signal" | "rpc" }
  | { status: "force-killed"; pid: number; tookMs: number }
  | { status: "refused"; pid: number; reason: string; blockers: string[] }
  | { status: "error"; pid: number; reason: string };

export class StopRefusedError extends Error {
  override readonly name = "StopRefusedError";

  constructor(
    message: string,
    readonly blockers: string[],
  ) {
    super(message);
  }
}

export async function runStopCommand(opts: StopOptions = {}): Promise<StopResult> {
  const deps = opts.deps ?? {};
  const con = deps.console ?? console;
  const readLockFn = deps.readLockFn ?? readLock;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const releaseLockFn = deps.releaseLockFn ?? releaseLock;
  const platform = deps.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 300;
  const verbose = opts.verbose ?? true;
  const statePath = deps.statePath ?? getDefaultStatePath();
  const readyMarkerPath = deps.readyMarkerPath ?? getDefaultReadyMarkerPath();

  // 1. readLock
  const lock = await readLockFn().catch(() => null);
  if (!lock) {
    if (verbose) con.log(chalk.dim("Server is not running (no PID file)"));
    return { status: "nothing-to-stop" };
  }
  if (opts.expectedLock && !isSameLock(lock, opts.expectedLock)) {
    if (verbose) con.log(chalk.dim("Server lock changed; skip stopping newer host"));
    return { status: "nothing-to-stop" };
  }
  const { pid } = lock;

  if (!isAlive(pid)) {
    if (verbose) con.log(chalk.yellow(`Found stale PID file (pid=${pid} not alive), cleaning up`));
    await forceCleanup({
      releaseLockFn,
      readLockFn,
      statePath,
      readyMarkerPath,
      expectedLock: opts.expectedLock,
    });
    return { status: "nothing-to-stop" };
  }

  // 2. 平台分支
  if (platform === "win32") {
    return runStopWindows({
      lock,
      timeoutMs,
      pollMs,
      rpcTimeoutMs: opts.rpcTimeoutMs ?? 15_000,
      verbose,
      deps,
      expectedLock: opts.expectedLock,
    });
  }
  return runStopPosix({
    lock,
    timeoutMs,
    pollMs,
    rpcTimeoutMs: opts.rpcTimeoutMs ?? 15_000,
    verbose,
    deps,
    expectedLock: opts.expectedLock,
  });
}

// ─── POSIX 分支 ───

interface StopInnerOpts {
  lock: PidFileContents;
  timeoutMs: number;
  pollMs: number;
  rpcTimeoutMs: number;
  verbose: boolean;
  deps: StopDeps;
  expectedLock?: PidFileContents;
}

async function runStopPosix(opts: StopInnerOpts): Promise<StopResult> {
  const { lock, timeoutMs, pollMs, rpcTimeoutMs, verbose, deps } = opts;
  const con = deps.console ?? console;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const killFn = deps.killFn ?? ((pid, sig) => process.kill(pid, sig));
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const releaseLockFn = deps.releaseLockFn ?? releaseLock;
  const rpcShutdown = deps.rpcShutdownFn ?? defaultRpcShutdown;
  const statePath = deps.statePath ?? getDefaultStatePath();
  const readyMarkerPath = deps.readyMarkerPath ?? getDefaultReadyMarkerPath();
  const start = clock();

  if (verbose) con.log(chalk.dim(`Graceful stop via server.shutdown RPC (pid=${lock.pid})...`));
  try {
    await rpcShutdown(lock, rpcTimeoutMs);
    const exited = await waitForExit({
      pid: lock.pid,
      deadline: clock() + timeoutMs,
      pollMs,
      clock,
      sleep,
      isAlive,
    });
    if (exited) {
      const took = clock() - start;
      if (verbose) {
        con.log(chalk.green(`Server stopped via RPC (pid=${lock.pid}, took=${(took / 1000).toFixed(1)}s)`));
      }
      await forceCleanup({
        releaseLockFn,
        readLockFn: deps.readLockFn ?? readLock,
        statePath,
        readyMarkerPath,
        expectedLock: opts.expectedLock,
      });
      return { status: "stopped", pid: lock.pid, tookMs: took, path: "rpc" };
    }
    if (verbose) con.warn(chalk.yellow("RPC ack'd but process still alive, falling back to SIGTERM"));
  } catch (err) {
    if (err instanceof StopRefusedError) {
      if (verbose) {
        con.warn(chalk.yellow(`Stop refused: ${err.message}`));
        for (const blocker of err.blockers) {
          con.warn(chalk.yellow(`  - ${blocker}`));
        }
      }
      return {
        status: "refused",
        pid: lock.pid,
        reason: err.message,
        blockers: err.blockers,
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    if (verbose) con.warn(chalk.yellow(`RPC shutdown failed: ${reason}. Falling back to SIGTERM.`));
  }

  if (verbose) con.log(chalk.dim(`Sending SIGTERM to pid ${lock.pid}...`));
  try {
    killFn(lock.pid, "SIGTERM");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    con.error(chalk.red(`Failed to send SIGTERM: ${reason}`));
    return { status: "error", pid: lock.pid, reason };
  }

  const exited = await waitForExit({
    pid: lock.pid,
    deadline: clock() + timeoutMs,
    pollMs,
    clock,
    sleep,
    isAlive,
  });

  if (exited) {
    const took = exited.tookMs;
    if (verbose) {
      con.log(chalk.green(`Server stopped (pid=${lock.pid}, took=${(took / 1000).toFixed(1)}s)`));
    }
    await forceCleanup({
      releaseLockFn,
      readLockFn: deps.readLockFn ?? readLock,
      statePath,
      readyMarkerPath,
      expectedLock: opts.expectedLock,
    });
    return { status: "stopped", pid: lock.pid, tookMs: took, path: "signal" };
  }

  // 超时 → SIGKILL
  if (verbose) {
    con.warn(
      chalk.yellow(
        `Graceful shutdown timed out after ${(timeoutMs / 1000).toFixed(0)}s, sending SIGKILL`,
      ),
    );
  }
  try {
    killFn(lock.pid, "SIGKILL");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    con.warn(chalk.yellow(`SIGKILL errored (likely already dead): ${reason}`));
  }
  await sleep(pollMs);
  await forceCleanup({
    releaseLockFn,
    readLockFn: deps.readLockFn ?? readLock,
    statePath,
    readyMarkerPath,
    expectedLock: opts.expectedLock,
  });
  return { status: "force-killed", pid: lock.pid, tookMs: timeoutMs };
}

// ─── Windows 分支 ───

async function runStopWindows(opts: StopInnerOpts & { rpcTimeoutMs: number }): Promise<StopResult> {
  const { lock, timeoutMs, pollMs, rpcTimeoutMs, verbose, deps } = opts;
  const con = deps.console ?? console;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const releaseLockFn = deps.releaseLockFn ?? releaseLock;
  const rpcShutdown = deps.rpcShutdownFn ?? defaultRpcShutdown;
  const taskkill = deps.taskkillFn ?? defaultTaskkill;
  const statePath = deps.statePath ?? getDefaultStatePath();
  const readyMarkerPath = deps.readyMarkerPath ?? getDefaultReadyMarkerPath();

  const start = clock();

  // 1. 尝试 RPC graceful
  let rpcOk = false;
  if (verbose) con.log(chalk.dim(`Graceful stop via server.shutdown RPC (pid=${lock.pid})...`));
  try {
    await rpcShutdown(lock, rpcTimeoutMs);
    rpcOk = true;
  } catch (err) {
    if (err instanceof StopRefusedError) {
      if (verbose) {
        con.warn(chalk.yellow(`Stop refused: ${err.message}`));
        for (const blocker of err.blockers) {
          con.warn(chalk.yellow(`  - ${blocker}`));
        }
      }
      return {
        status: "refused",
        pid: lock.pid,
        reason: err.message,
        blockers: err.blockers,
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    if (verbose) con.warn(chalk.yellow(`RPC shutdown failed: ${reason}. Falling back to taskkill.`));
  }

  if (rpcOk) {
    const exited = await waitForExit({
      pid: lock.pid,
      deadline: clock() + timeoutMs,
      pollMs,
      clock,
      sleep,
      isAlive,
    });
    if (exited) {
      const took = clock() - start;
      if (verbose) con.log(chalk.green(`Server stopped via RPC (pid=${lock.pid}, took=${(took / 1000).toFixed(1)}s)`));
      await forceCleanup({
        releaseLockFn,
        readLockFn: deps.readLockFn ?? readLock,
        statePath,
        readyMarkerPath,
        expectedLock: opts.expectedLock,
      });
      return { status: "stopped", pid: lock.pid, tookMs: took, path: "rpc" };
    }
    // 进程仍活 → 降级 taskkill
    if (verbose) con.warn(chalk.yellow("RPC ack'd but process still alive, escalating to taskkill"));
  }

  // 2. taskkill /T（graceful kill + children）
  if (verbose) con.log(chalk.dim(`Running taskkill /T for pid ${lock.pid}...`));
  try {
    await taskkill(lock.pid, false);
  } catch (err) {
    if (verbose) con.warn(chalk.yellow(`taskkill /T errored: ${errMsg(err)}`));
  }
  const taskkillExited = await waitForExit({
    pid: lock.pid,
    deadline: clock() + Math.min(timeoutMs, 10_000),
    pollMs,
    clock,
    sleep,
    isAlive,
  });
  if (taskkillExited) {
    const took = clock() - start;
    if (verbose) con.log(chalk.green(`Server stopped via taskkill (pid=${lock.pid}, took=${(took / 1000).toFixed(1)}s)`));
    await forceCleanup({
      releaseLockFn,
      readLockFn: deps.readLockFn ?? readLock,
      statePath,
      readyMarkerPath,
      expectedLock: opts.expectedLock,
    });
    return { status: "stopped", pid: lock.pid, tookMs: took, path: "signal" };
  }

  // 3. taskkill /F /T（强杀）
  if (verbose) con.warn(chalk.yellow(`taskkill /T timed out; escalating to /F /T`));
  try {
    await taskkill(lock.pid, true);
  } catch (err) {
    if (verbose) con.warn(chalk.yellow(`taskkill /F /T errored: ${errMsg(err)}`));
  }
  await sleep(pollMs);
  await forceCleanup({
    releaseLockFn,
    readLockFn: deps.readLockFn ?? readLock,
    statePath,
    readyMarkerPath,
    expectedLock: opts.expectedLock,
  });
  return { status: "force-killed", pid: lock.pid, tookMs: clock() - start };
}

// ─── 共用工具 ───

interface WaitForExitArgs {
  pid: number;
  deadline: number;
  pollMs: number;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
}

async function waitForExit(args: WaitForExitArgs): Promise<{ tookMs: number } | null> {
  const start = args.clock();
  while (args.clock() < args.deadline) {
    if (!args.isAlive(args.pid)) {
      return { tookMs: args.clock() - start };
    }
    await args.sleep(args.pollMs);
  }
  return null;
}

interface ForceCleanupOpts {
  releaseLockFn: typeof releaseLock;
  readLockFn?: typeof readLock;
  statePath: string;
  readyMarkerPath: string;
  expectedLock?: PidFileContents;
}

async function forceCleanup(opts: ForceCleanupOpts): Promise<void> {
  if (opts.expectedLock) {
    if (!opts.readLockFn) return;
    const current = await opts.readLockFn().catch(() => null);
    if (!current || !isSameLock(current, opts.expectedLock)) return;
  }
  await opts.releaseLockFn().catch(() => {});
  await safeUnlink(opts.statePath);
  await safeUnlink(opts.readyMarkerPath);
}

function isSameLock(a: PidFileContents, b: PidFileContents): boolean {
  return (
    a.pid === b.pid &&
    a.port === b.port &&
    a.startTime === b.startTime &&
    a.startedAt === b.startedAt
  );
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await stat(path);
    await unlink(path);
  } catch {
    /* 不存在 / 权限 → 忽略 */
  }
}

async function defaultRpcShutdown(lock: PidFileContents, timeoutMs: number): Promise<void> {
  const host = lock.host ?? "127.0.0.1";
  const url = `ws://${host}:${lock.port}/ws`;
  const tokenPath = getDefaultTokenPath();
  const token = (await readFile(tokenPath, "utf-8")).trim();
  if (!token) throw new Error("token file missing or empty");

  const client = createRpcClient({ url, timeout: timeoutMs });
  await client.connect();
  try {
    await client.authenticate(token);
    const info = await client.request<ServerStopInfo>("server.info");
    const blockers = getStopBlockers(info);
    if (blockers.length > 0) {
      throw new StopRefusedError(
        "当前还有接入面或工作在运行，请在交互模式使用 /stop",
        blockers,
      );
    }
    await client.request("server.shutdown", {
      reason: "serve-stop",
      timeoutMs,
      strategy: "immediate",
    });
  } finally {
    await client.close().catch(() => {});
  }
}

interface ServerStopInfo {
  connectionCount?: number;
  channels?: Array<{ channelId: string; state: string }>;
  accessSurfaces?: {
    otherRpcConnections?: number;
    liveChannels?: Array<{ channelId: string; state: string }>;
  };
  activeWork?: { count?: number };
  keepAliveWork?: Array<{ label?: string; count?: number }>;
}

function getStopBlockers(info: ServerStopInfo): string[] {
  const blockers: string[] = [];
  const otherConnections =
    typeof info.accessSurfaces?.otherRpcConnections === "number"
      ? info.accessSurfaces.otherRpcConnections
      : Math.max(0, (info.connectionCount ?? 1) - 1);
  if (otherConnections > 0) {
    blockers.push(`还有 ${otherConnections} 个终端连接`);
  }

  const liveChannels =
    info.accessSurfaces?.liveChannels ??
    (info.channels ?? []).filter(
      (s) => s.state === "connected" || s.state === "connecting",
    );
  if (liveChannels.length > 0) {
    blockers.push(`还有接入面在线：${liveChannels.map((s) => s.channelId).join("、")}`);
  }

  const activeWork = Math.max(0, info.activeWork?.count ?? 0);
  if (activeWork > 0) {
    blockers.push(`还有 ${activeWork} 项运行中的工作`);
  }

  const keepAlive = (info.keepAliveWork ?? []).reduce(
    (sum, item) => sum + Math.max(0, item.count ?? 0),
    0,
  );
  if (keepAlive > 0) {
    blockers.push(`还有 ${keepAlive} 个已启用定时任务`);
  }
  return blockers;
}

async function defaultTaskkill(pid: number, force: boolean): Promise<void> {
  const args = force ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  await execFileAsync("taskkill", args, { timeout: 10_000, windowsHide: true });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
