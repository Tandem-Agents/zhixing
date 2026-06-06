/**
 * PID / port 发现文件管理（schema v2）。
 *
 * **单例锁是端口 listen 的 EADDRINUSE（OS 原子），不是 PID 文件**。同 `ZHIXING_HOME` 派生
 * 同端口（见 `homeToPort`），两个宿主不可能同时 listen 成功。本模块只负责写 / 读
 * `~/.zhixing/server.pid`（按 `ZHIXING_HOME` 隔离），供 CLI 客户端发现 owner 的端口 / pid
 * 并发信号——PID 文件是**发现辅助、非第二把锁**。owner 由 listen 确立后调 `acquireLock`
 * 覆盖任何残留（stale 或被复用 PID 指向的活进程），不检测、不自杀（详见 `acquireLock` 注释）。
 *
 * Schema v2（对比 v1 扩展字段）：
 * - pidFileVersion: 2
 * - startTime: 进程启动时间。**曾用于 PID reuse 检测**（acquireLock 据此判 stale / 拒绝启动）——
 *   owner 改端口仲裁后该判活用途已移除（见 scheduler-architecture.md 决策 7）；现保留为 PID 文件
 *   诊断信息 + 未来 discoverServer 真实性探测的数据基础（写入，但当前无判活消费者）。
 * - argv / kind / version / logPath / host: 诊断 + daemon 级能力。
 *
 * v1 → v2 静默迁移：readPidFile 读到无 pidFileVersion 字段视为 v1，补 pidFileVersion=1,
 * startTime=null（兼容旧文件读取）。
 *
 * Windows 兼容性：
 * - process.kill(pid, 0) 在 Windows 可用（isProcessAlive 供 discoverServer 判进程存活）。
 * - resolveProcessStartTime 在 Windows / 非 Linux-macOS 返回 null（平台不支持，startTime 记 null）。
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
 * 写入本进程的 PID / port 发现文件（确立 owner 的发现记录）。
 *
 * **端口 listen 才是单例锁**——`startServer` 的 `listen` 由 OS 以 `EADDRINUSE` 原子仲裁，
 * 两个宿主不可能同时占住同一端口（同 `ZHIXING_HOME` 派生同端口，见 `homeToPort`）。调用方
 * 必须在 listen 成功**之后**调用本函数：此刻 owner 身份已由端口确立，PID / port 文件仅是
 * **发现辅助**（供 cli 客户端找到 owner 的端口 / pid 发信号），**不是第二把锁**。
 *
 * 故本函数遇任何残留文件（stale，或被复用 PID 指向的无关活进程）一律**覆盖**，绝不因 PID
 * 冲突拒绝或让宿主自杀——真正的“已在运行”由 listen 的 `EADDRINUSE` 表达，不由 PID 文件表达。
 * 残留来自异常崩溃（未走 `releaseLock`）；idle 高频起落会放大 PID 复用窗口（Windows 无
 * `startTime`、无 PID-reuse 检测），靠「端口才是真锁、PID 仅发现辅助」兜底。`startTime` 仍写入，
 * 作为 PID 文件的诊断信息（与 argv / version / logPath 同列）。
 */
export async function acquireLock(
  port: number,
  opts: AcquireLockOptions = {},
): Promise<void> {
  const pidPath = opts.pidPath ?? getDefaultPidPath();
  const portPath = opts.portPath ?? getDefaultPortPath();
  const resolveStartTime = opts.resolveStartTimeFn ?? resolveProcessStartTime;

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
  // 覆盖写：发现辅助文件，不读旧值 / 不检测冲突（端口 listen 已是单例仲裁）。
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
