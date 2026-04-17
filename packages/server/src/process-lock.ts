/**
 * 进程锁 + PID 文件管理
 *
 * 双层锁机制：
 * 1. 端口锁（startServer 监听已实现）：同端口冲突 → EADDRINUSE
 * 2. PID 文件：写入 ~/.zhixing/server.pid（含 pid + port），
 *    供 CLI 客户端发现 server、发送信号
 *
 * Stale PID 检测：
 * - 启动时若 PID 文件存在 → 检查进程是否真的在运行
 * - 进程不存在 → 视为 stale，覆盖
 * - 进程存在 → 抛错（已有 server 在跑）
 *
 * 端口文件 ~/.zhixing/server.port 与 PID 文件并列，便于 shell 脚本读取。
 *
 * Windows 兼容性：
 * - process.kill(pid, 0) 在 Windows 也能用（Node 抽象了底层差异）
 * - 信号名走标准（SIGTERM 在 Windows 等价于强制终止）
 */

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DIR = join(homedir(), ".zhixing");
const DEFAULT_PID_PATH = join(DEFAULT_DIR, "server.pid");
const DEFAULT_PORT_PATH = join(DEFAULT_DIR, "server.port");

export interface ProcessLockPaths {
  pidPath?: string;
  portPath?: string;
}

export interface PidFileContents {
  pid: number;
  port: number;
  startedAt: string;
}

export class ProcessLockError extends Error {
  constructor(message: string, public existing?: PidFileContents) {
    super(message);
    this.name = "ProcessLockError";
  }
}

/**
 * 尝试获取进程锁。
 * - 文件不存在 / stale → 写入新 PID 文件，成功返回
 * - 文件存在且进程仍在 → 抛 ProcessLockError
 */
export async function acquireLock(
  port: number,
  paths: ProcessLockPaths = {},
): Promise<void> {
  const pidPath = paths.pidPath ?? DEFAULT_PID_PATH;
  const portPath = paths.portPath ?? DEFAULT_PORT_PATH;

  const existing = await readPidFile(pidPath);
  if (existing && isProcessAlive(existing.pid)) {
    throw new ProcessLockError(
      `Server already running (pid=${existing.pid}, port=${existing.port}). ` +
        `Pid file: ${pidPath}`,
      existing,
    );
  }

  if (existing) {
    // stale → 静默清理
    await safeUnlink(pidPath);
    await safeUnlink(portPath);
  }

  const contents: PidFileContents = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  };

  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, JSON.stringify(contents, null, 2), "utf-8");
  await writeFile(portPath, String(port), "utf-8");
}

/**
 * 释放进程锁（删除 PID + 端口文件）。
 * 文件不存在视为成功。
 */
export async function releaseLock(paths: ProcessLockPaths = {}): Promise<void> {
  const pidPath = paths.pidPath ?? DEFAULT_PID_PATH;
  const portPath = paths.portPath ?? DEFAULT_PORT_PATH;
  await safeUnlink(pidPath);
  await safeUnlink(portPath);
}

/**
 * 读取当前的 PID 文件（不做 stale 检查）。
 * 给 CLI 客户端用（发现 server）。
 */
export async function readLock(paths: ProcessLockPaths = {}): Promise<PidFileContents | null> {
  const pidPath = paths.pidPath ?? DEFAULT_PID_PATH;
  return readPidFile(pidPath);
}

/**
 * 检查进程是否存活（kill -0 语义）。
 * Node.js 在 Windows 也支持这个调用。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      ((err as NodeJS.ErrnoException).code === "ESRCH" ||
        (err as NodeJS.ErrnoException).code === "EPERM")
    ) {
      // ESRCH: no such process; EPERM: process exists but we can't signal it (treat as alive — safer)
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
    return false;
  }
}

// ─── 内部 ───

async function readPidFile(path: string): Promise<PidFileContents | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as PidFileContents;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return null;
    return parsed;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    // 其他错误吞掉——清理失败不应该阻塞停机
  }
}
