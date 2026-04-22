/**
 * `zhixing serve stop` — 停止后台 daemon
 *
 * POSIX 流程：
 *   readLock → SIGTERM → 轮询 isProcessAlive → 超时 SIGKILL → 强制清理
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
  /** RPC graceful 超时（Windows 路径），默认 15_000ms */
  rpcTimeoutMs?: number;
  /** 是否打印进度（默认 true）*/
  verbose?: boolean;
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
  | { status: "error"; pid: number; reason: string };

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
  const { pid } = lock;

  if (!isAlive(pid)) {
    if (verbose) con.log(chalk.yellow(`Found stale PID file (pid=${pid} not alive), cleaning up`));
    await forceCleanup({ releaseLockFn, statePath, readyMarkerPath });
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
    });
  }
  return runStopPosix({ lock, timeoutMs, pollMs, verbose, deps });
}

// ─── POSIX 分支 ───

interface StopInnerOpts {
  lock: PidFileContents;
  timeoutMs: number;
  pollMs: number;
  verbose: boolean;
  deps: StopDeps;
}

async function runStopPosix(opts: StopInnerOpts): Promise<StopResult> {
  const { lock, timeoutMs, pollMs, verbose, deps } = opts;
  const con = deps.console ?? console;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const killFn = deps.killFn ?? ((pid, sig) => process.kill(pid, sig));
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const releaseLockFn = deps.releaseLockFn ?? releaseLock;
  const statePath = deps.statePath ?? getDefaultStatePath();
  const readyMarkerPath = deps.readyMarkerPath ?? getDefaultReadyMarkerPath();

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
    await forceCleanup({ releaseLockFn, statePath, readyMarkerPath });
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
  await forceCleanup({ releaseLockFn, statePath, readyMarkerPath });
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
      await forceCleanup({ releaseLockFn, statePath, readyMarkerPath });
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
    await forceCleanup({ releaseLockFn, statePath, readyMarkerPath });
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
  await forceCleanup({ releaseLockFn, statePath, readyMarkerPath });
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
  statePath: string;
  readyMarkerPath: string;
}

async function forceCleanup(opts: ForceCleanupOpts): Promise<void> {
  await opts.releaseLockFn().catch(() => {});
  await safeUnlink(opts.statePath);
  await safeUnlink(opts.readyMarkerPath);
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
    await client.request("server.shutdown", { reason: "serve-stop", timeoutMs });
  } finally {
    await client.close().catch(() => {});
  }
}

async function defaultTaskkill(pid: number, force: boolean): Promise<void> {
  const args = force ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  await execFileAsync("taskkill", args, { timeout: 10_000, windowsHide: true });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
