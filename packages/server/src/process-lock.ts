/**
 * 进程锁 + PID 文件管理（schema v2）
 *
 * 双层锁机制：
 * 1. 端口锁（startServer 监听已实现）：同端口冲突 → EADDRINUSE
 * 2. PID 文件：写入 ~/.zhixing/server.pid，供 CLI 客户端发现 server、发送信号
 *
 * Schema v2（对比 v1 扩展字段）：
 * - pidFileVersion: 2
 * - startTime: 进程启动时间（用于 PID reuse 检测，借鉴 Hermes 思路）
 * - argv / kind / version / logPath / host: 诊断 + daemon 级能力（M1-M8 逐步写入）
 *
 * v1 → v2 静默迁移：
 * - 读取时若无 pidFileVersion，视为 v1：补 pidFileVersion=1, startTime=null
 * - 不报 stale 警告，避免用户升级后的虚假告警
 *
 * Stale 判定：
 * - v1 文件：走 isProcessAlive（纯信号检测，PID reuse 无法识别）
 * - v2 文件：isProcessAlive + startTime 比对。runtime 能读到当前 pid 的 startTime
 *   且与文件记录的不一致 → 判 stale（PID 被复用）
 *
 * Windows 兼容性：
 * - process.kill(pid, 0) 在 Windows 可用（Node 抽象了底层差异）
 * - resolveProcessStartTime 在 Windows / 非 Linux-macOS 返回 null → 降级到纯 isProcessAlive
 */

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDefaultPidPath, getDefaultPortPath } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface ProcessLockPaths {
  pidPath?: string;
  portPath?: string;
}

/**
 * PID 文件内容。v2 schema；v1 读入时用 {pidFileVersion:1, startTime:null} 补齐。
 *
 * 扩展字段均可选——本次迁移先让 v2 字段可用，后续里程碑（M3 daemon 写 logPath、
 * M1 已有 argv）按需填充。保持字段可选避免 M2 一次性改太多调用方。
 */
export interface PidFileContents {
  /** 1 = 旧格式（读入时补）；2 = 当前格式 */
  pidFileVersion: number;
  pid: number;
  port: number;
  /** v1 为空，v2 可能为空（平台不支持）；用于 PID reuse 检测 */
  startTime: number | null;
  startedAt: string;
  host?: string;
  argv?: string[];
  kind?: string;
  version?: string;
  logPath?: string;
}

export class ProcessLockError extends Error {
  constructor(message: string, public existing?: PidFileContents) {
    super(message);
    this.name = "ProcessLockError";
  }
}

// ─── public API ───

export interface AcquireLockOptions extends ProcessLockPaths {
  /** 监听 host（默认 127.0.0.1），仅诊断用途 */
  host?: string;
  /** 进程类别，默认 "zhixing-server"；为 Level 2 worker 留扩展 */
  kind?: string;
  /** zhixing 版本号 */
  version?: string;
  /** daemon 日志文件路径（非 daemon 可省）*/
  logPath?: string;
  /** 参数向量；默认 process.argv */
  argv?: string[];
  /** 启动时间；默认从平台读取（Linux /proc，macOS ps）*/
  startTime?: number | null;
  /** 测试注入 startTime 读取器 */
  resolveStartTimeFn?: (pid: number) => Promise<number | null>;
}

/**
 * 尝试获取进程锁。
 * - 文件不存在 / stale → 写入新 PID 文件，成功返回
 * - 文件存在且进程仍在 → 抛 ProcessLockError
 *
 * Stale 判定优先级：
 *   1. isProcessAlive(pid) === false → stale
 *   2. 文件有 startTime + runtime 能读到 pid 的 startTime 且不相等 → stale (PID reuse)
 *   3. 否则视为活进程，抛 ProcessLockError
 */
export async function acquireLock(
  port: number,
  opts: AcquireLockOptions = {},
): Promise<void> {
  const pidPath = opts.pidPath ?? getDefaultPidPath();
  const portPath = opts.portPath ?? getDefaultPortPath();
  const resolveStartTime = opts.resolveStartTimeFn ?? resolveProcessStartTime;

  const existing = await readPidFile(pidPath);
  if (existing) {
    const stale = await detectStale(existing, resolveStartTime);
    if (!stale) {
      throw new ProcessLockError(
        `Server already running (pid=${existing.pid}, port=${existing.port}). ` +
          `Pid file: ${pidPath}`,
        existing,
      );
    }
    // stale → 静默清理
    await safeUnlink(pidPath);
    await safeUnlink(portPath);
  }

  const ownPid = process.pid;
  const ownStartTime =
    opts.startTime !== undefined ? opts.startTime : await resolveStartTime(ownPid);

  const contents: PidFileContents = {
    pidFileVersion: 2,
    pid: ownPid,
    port,
    host: opts.host,
    startedAt: new Date().toISOString(),
    startTime: ownStartTime,
    argv: opts.argv ?? [...process.argv],
    kind: opts.kind ?? "zhixing-server",
    version: opts.version,
    logPath: opts.logPath,
  };

  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, JSON.stringify(contents, null, 2), "utf-8");
  await writeFile(portPath, String(port), "utf-8");
}

/**
 * 释放进程锁（删除 PID + 端口文件）。文件不存在视为成功。
 */
export async function releaseLock(paths: ProcessLockPaths = {}): Promise<void> {
  const pidPath = paths.pidPath ?? getDefaultPidPath();
  const portPath = paths.portPath ?? getDefaultPortPath();
  await safeUnlink(pidPath);
  await safeUnlink(portPath);
}

/**
 * 读取当前 PID 文件。给 CLI 客户端用（发现 server），**不做 stale 检查**。
 *
 * v1 → v2 静默迁移：无 pidFileVersion 字段视为 v1，补 pidFileVersion=1, startTime=null。
 */
export async function readLock(paths: ProcessLockPaths = {}): Promise<PidFileContents | null> {
  const pidPath = paths.pidPath ?? getDefaultPidPath();
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
      // ESRCH: no such process; EPERM: exists but we can't signal it（视为活，更安全）
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
    return false;
  }
}

/**
 * 读取进程启动时间，用于 PID reuse 检测。
 *
 * 返回值只要求**同一 pid 的两次调用返回相同 number**，数值语义不要求跨平台一致：
 * - Linux：`/proc/<pid>/stat` 字段 22（starttime, jiffies since boot）
 * - macOS：`ps -o lstart= -p <pid>` 再转 Unix 时间戳
 * - Windows / 其他：返回 null（降级到纯 isProcessAlive）
 *
 * 读取失败一律返回 null，调用方自行决定降级策略。
 */
export async function resolveProcessStartTime(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    return readLinuxStartTime(pid);
  }
  if (process.platform === "darwin") {
    return readMacStartTime(pid);
  }
  return null; // Windows 或其他平台
}

// ─── 内部 ───

async function readPidFile(path: string): Promise<PidFileContents | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PidFileContents>;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return null;
    return normalizePidContents(parsed);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null; // 破损文件视为 "无"（与旧行为一致）
  }
}

/**
 * v1 → v2 静默迁移：补齐缺失字段。
 * v1 文件没有 pidFileVersion 字段——这是识别点。
 */
function normalizePidContents(parsed: Partial<PidFileContents>): PidFileContents {
  const version = typeof parsed.pidFileVersion === "number" ? parsed.pidFileVersion : 1;
  return {
    pidFileVersion: version,
    pid: parsed.pid!,
    port: parsed.port!,
    startedAt: parsed.startedAt ?? "",
    startTime: typeof parsed.startTime === "number" ? parsed.startTime : null,
    host: parsed.host,
    argv: parsed.argv,
    kind: parsed.kind,
    version: parsed.version,
    logPath: parsed.logPath,
  };
}

/**
 * 判定 PID 文件是否指向一个已死（或被复用）的进程。
 */
async function detectStale(
  existing: PidFileContents,
  resolveStartTime: (pid: number) => Promise<number | null>,
): Promise<boolean> {
  if (!isProcessAlive(existing.pid)) return true;

  // v2 且记录了 startTime + runtime 能读到 → PID reuse 检测
  if (existing.startTime !== null && existing.startTime !== undefined) {
    const currentStartTime = await resolveStartTime(existing.pid).catch(() => null);
    if (currentStartTime !== null && currentStartTime !== existing.startTime) {
      return true; // PID 被复用
    }
  }
  return false;
}

async function readLinuxStartTime(pid: number): Promise<number | null> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, "utf-8");
    // /proc/<pid>/stat 格式：`pid (comm) state ppid ... starttime ...`
    // comm 可能含空格和括号 —— 所以从最后一个 ')' 往后数第 20 个字段（1-indexed 的第 22 字段）
    const lastParen = content.lastIndexOf(")");
    if (lastParen < 0) return null;
    const rest = content.slice(lastParen + 1).trim().split(/\s+/);
    // rest[0] = state, rest[1] = ppid, ... 第 22 字段 = rest[22 - 3] = rest[19]
    const raw = rest[19];
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readMacStartTime(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: 2000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const ts = Date.parse(trimmed);
    return Number.isFinite(ts) ? ts : null;
  } catch {
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
