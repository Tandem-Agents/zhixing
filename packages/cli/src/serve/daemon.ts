/**
 * Daemon 父进程分支
 *
 * 流程（对应 daemon-level-1-execution.md §3.1 父进程拓扑）：
 * 1. resolveSelfExec 拿 { command, args, env }
 * 2. 打开日志文件 fd（append）
 * 3. spawn + detach + unref + 父进程立即 close(fd)
 * 4. startupHandshake 5s 轮询：PID 文件 + .ready marker + /api/health 200（三项皆需）
 * 5. 成功 → 打印横幅
 *    失败 → 打印日志尾部 20 行 → 调用方 exit(1)
 *
 * 所有外部依赖通过 deps 注入，便于单测 mock 而不触发真实 spawn / 网络。
 */

import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { open, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import http from "node:http";
import chalk from "chalk";
import {
  readLock,
  isProcessAlive,
  getDefaultLogPath,
  getDefaultReadyMarkerPath,
  type PidFileContents,
} from "@zhixing/server";
import {
  resolveSelfExec,
  buildDaemonSpawnOptions,
  UnsupportedSelfExecError,
} from "./self-exec.js";

export interface SpawnDaemonOptions {
  /** 传给 child 的 CLI 参数（不含 --daemon；应含 "serve" 及其子选项）*/
  forwardedArgs: string[];
  /** 日志文件路径覆盖 */
  logPath?: string;
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
  readFileFn?: (path: string, encoding: BufferEncoding) => Promise<string>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  console?: Pick<Console, "log" | "error">;
  /** 覆盖 open/mkdir（测试用）*/
  openFn?: (path: string, flags: string) => Promise<{ fd: number; close: () => Promise<void> }>;
  mkdirFn?: (path: string, opts: { recursive: true }) => Promise<string | undefined>;
  /** .ready marker 路径覆盖（测试用；默认 ~/.zhixing/server.ready）*/
  readyMarkerPath?: string;
}

export interface SpawnDaemonResult {
  ok: boolean;
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
  const logPath = opts.logPath ?? getDefaultLogPath();
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5000;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const con = deps.console ?? console;

  // 1. resolveSelfExec
  let execArgs;
  try {
    execArgs = resolveSelfExec(opts.forwardedArgs);
  } catch (err) {
    if (err instanceof UnsupportedSelfExecError) {
      con.error(chalk.red(err.message));
      return { ok: false, reason: err.message, logPath };
    }
    throw err;
  }

  // 2. 打开日志文件 fd
  const mkdirFn = deps.mkdirFn ?? mkdir;
  const openFn = deps.openFn ?? (async (p, flags) => {
    const h = await open(p, flags);
    return { fd: h.fd, close: () => h.close() };
  });
  await mkdirFn(dirname(logPath), { recursive: true });
  const logHandle = await openFn(logPath, "a");
  const logFd = logHandle.fd;

  // 3. spawn + detach + unref + close fd
  const spawnOpts = buildDaemonSpawnOptions(logFd, execArgs.env);
  const spawnFn = deps.spawnFn ?? spawn;
  const child = spawnFn(execArgs.command, execArgs.args, spawnOpts);
  // child.unref() 允许父进程退出时不等子进程
  try {
    child.unref();
  } catch {
    /* child 已死或 mock 场景 */
  }
  // 父进程立刻关闭 fd（fd 已被复制给子进程）
  await logHandle.close();

  // 4. handshake
  const handshake = await startupHandshake({
    timeoutMs: handshakeTimeoutMs,
    pollIntervalMs,
    deps,
  });

  if (handshake.ok) {
    printSuccessBanner(handshake.pid!, handshake.port!, logPath, con);
    return { ok: true, pid: handshake.pid, port: handshake.port, logPath };
  }

  // 5. 失败路径
  con.error(chalk.red(`Daemon startup failed: ${handshake.reason ?? "unknown"}`));
  await printLogTail(logPath, 20, { readFileFn: deps.readFileFn, console: con });
  return { ok: false, reason: handshake.reason, logPath };
}

// ─── handshake ───

interface HandshakeResult {
  ok: boolean;
  pid?: number;
  port?: number;
  reason?: string;
}

interface HandshakeOpts {
  timeoutMs: number;
  pollIntervalMs: number;
  deps: SpawnDaemonDeps;
}

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
            return { ok: true, pid: lock.pid, port: lock.port };
          }
        }
      }
    }
    await sleep(opts.pollIntervalMs);
  }

  // 超时——给出具体原因
  if (!lastLock) {
    return {
      ok: false,
      reason: "PID file never appeared within timeout (child may have crashed during init)",
    };
  }
  if (!isAlive(lastLock.pid)) {
    return {
      ok: false,
      reason: `Child pid ${lastLock.pid} exited before becoming ready`,
    };
  }
  if (!sawReadyMarker) {
    return {
      ok: false,
      reason: ".ready marker never appeared (child reached PID-lock but never finished init)",
    };
  }
  return {
    ok: false,
    reason: "Health endpoint never returned 200 within timeout",
  };
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
  con.log(chalk.dim(`  Stop:  zhixing serve stop`));
  con.log();
}

async function printLogTail(
  logPath: string,
  n: number,
  opts: {
    readFileFn?: (path: string, encoding: BufferEncoding) => Promise<string>;
    console?: Pick<Console, "log" | "error">;
  },
): Promise<void> {
  const readFn = opts.readFileFn ?? ((p, e) => readFile(p, e));
  const con = opts.console ?? console;
  try {
    const content = await readFn(logPath, "utf-8");
    const lines = String(content).split("\n").filter((l) => l.length > 0);
    const tail = lines.slice(-n);
    con.error(chalk.dim(`\n--- Last ${tail.length} lines of ${logPath} ---`));
    for (const line of tail) con.error(chalk.dim(line));
  } catch {
    con.error(chalk.dim(`(no log found at ${logPath})`));
  }
}
