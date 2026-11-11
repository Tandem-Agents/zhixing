import { execFile } from 'node:child_process';
import path from 'node:path';
import { readPlatformProcessBirth, type PlatformProcessBirth } from '../platform/secret-platform.js';
import type { StopEndpointLock } from "@zhixing-ai/core/protocol";
import { isProcessAlive, resolveProcessStartTime } from "@zhixing-ai/server/client";
import type { BoundZhixingServer } from "@zhixing-ai/server";

/**
 * Proves that a live PID at an old endpoint is this process reusing the exact
 * home endpoint it already owns. A PID match without the same bound port is
 * never a successor proof.
 */
export function ownsCurrentSuccessorEndpoint(
  owner: Pick<BoundZhixingServer, "ownsEndpoint">,
  oldEndpoint: StopEndpointLock,
  currentEndpoint: StopEndpointLock,
  currentPid: number = process.pid,
): boolean {
  return oldEndpoint.pid === currentPid &&
    currentEndpoint.pid === currentPid &&
    oldEndpoint.port === currentEndpoint.port &&
    owner.ownsEndpoint(currentEndpoint.port);
}

/** A released listener proves no process exit. Only OS liveness or birth
 * identity may establish that this PID no longer denotes the old host. */
export async function endpointProcessMayBeOldHost(
  _owner: Pick<BoundZhixingServer, "ownsEndpoint">,
  oldEndpoint: StopEndpointLock,
  probes: RecordedHostProbes = {},
): Promise<boolean> {
  return recordedHostMayBeAlive(oldEndpoint, probes);
}

export interface RecordedHostProbes {
    readonly alive?: (pid: number) => boolean;
    readonly startTime?: (pid: number) => Promise<number | null>;
    readonly birth?: (pid: number) => Promise<PlatformProcessBirth>;
    /** 直接读取得不到出生身份时的系统后备查询。注入的探针代表整个系统视图：注入了其他探针而没注入它时不查询。 */
    readonly osBirth?: (pid: number) => Promise<OsProcessBirth>;
    readonly platform?: NodeJS.Platform;
}

/** Marker removal and listener replacement are not OS exit proofs. */
export async function recordedHostMayBeAlive(
  oldEndpoint: StopEndpointLock,
  probes: RecordedHostProbes = {},
): Promise<boolean> {
  const alive = probes.alive ?? isProcessAlive;
  const platform = probes.platform ?? process.platform;
  const birth = probes.birth ? await probes.birth(oldEndpoint.pid)
    : probes.startTime ? await readPlatformProcessBirth(oldEndpoint.pid, probes.startTime, null, alive)
    : await readPlatformProcessBirth(oldEndpoint.pid, resolveProcessStartTime, undefined, alive);
  // Windows kill(0) may report ESRCH while the old process handle is still
  // unsignaled. Native incarnation evidence therefore outranks that hint.
  if (birth.kind === 'absent') return false;
  if (birth.kind === 'unknown') {
    // 直接读取被拒（如旧宿主的 PID 已被系统服务进程复用）时再做一次有截止的只读系统出生查询。
    // 它只用于排除：出生明确晚于旧代才说明这个 PID 已归新进程；相同、模糊或更早都仍可能是旧宿主。
    const osBirth = probes.osBirth ?? (probes.birth || probes.startTime || platform !== 'win32' ? undefined : readWindowsProcessBirth);
    const fallback = osBirth ? await osBirth(oldEndpoint.pid) : undefined;
    if (fallback?.kind !== 'present') return true;
    const recorded = oldEndpoint.startTime ?? Date.parse(oldEndpoint.startedAt);
    const tolerance = OS_BIRTH_PRECISION_MS + (fallback.toleranceMs ?? 0);
    return !(Number.isFinite(recorded) && fallback.startTime > recorded + tolerance);
  }
  const live = birth.startTime;
  if (oldEndpoint.startTime !== null) return live === oldEndpoint.startTime;
  // Older Windows records have no birth field. A process born strictly after
  // the old host recorded its generation cannot be that host; all other cases
  // remain unresolved until actual exit. Windows start times are Unix ms.
  if (platform === 'win32') {
    const recorded = Date.parse(oldEndpoint.startedAt);
    if (Number.isFinite(recorded) && live > recorded) return false;
  }
  return true;
}

/** 系统后备给出的出生：toleranceMs 是这份出生时间自身可能的换算偏差，比较时一并计入。 */
export type OsProcessBirth = Exclude<PlatformProcessBirth, { readonly kind: 'present' }>
  | { readonly kind: 'present'; readonly startTime: number; readonly toleranceMs?: number };

/** 后备出生与记录的比较容差：两侧都是向下取整的 Unix 毫秒，超出才算不同代。 */
const OS_BIRTH_PRECISION_MS = 1;
const OS_BIRTH_DEADLINE_MS = 5_000;
/** 启动时发现文件核对与停止恢复会先后各问一次同一 PID；只在这个短窗口内复用，不长期缓存。 */
const OS_BIRTH_REUSE_MS = 10_000;
const osBirthReads = new Map<number, { readonly at: number; readonly birth: Promise<OsProcessBirth> }>();

function readWindowsProcessBirth(pid: number): Promise<OsProcessBirth> {
  const now = Date.now();
  for (const [key, read] of osBirthReads) if (now - read.at >= OS_BIRTH_REUSE_MS) osBirthReads.delete(key);
  const reused = osBirthReads.get(pid);
  if (reused) return reused.birth;
  const birth = queryWindowsProcessBirth(pid);
  osBirthReads.set(pid, { at: now, birth });
  return birth;
}

/** 经 WMI 读进程出生时间，不需要打开进程句柄；查询可能成功，拒绝、空值、超时或系统程序找不到一律 unknown。
 *  系统程序按受信的系统目录绝对路径调用，不经 PATH 与当前目录查找。 */
function queryWindowsProcessBirth(pid: number): Promise<OsProcessBirth> {
  const powershell = windowsSystemProgram('WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!Number.isSafeInteger(pid) || pid <= 0 || !powershell) return Promise.resolve({ kind: 'unknown' });
  return new Promise(resolve => execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-WmiObject -Class Win32_Process -Filter ProcessId=${pid} | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CreationDate }`],
  { timeout: OS_BIRTH_DEADLINE_MS, maxBuffer: 4096, windowsHide: true },
  (error, stdout) => resolve(error ? { kind: 'unknown' } : parseWindowsProcessBirth(String(stdout), pid))));
}

/**
 * 解析“PID 出生时间”一行。出生时间是 WMI 日期（yyyymmddHHMMSS.ffffff±分钟偏移，精确到微秒），
 * 以串内自带的偏移归一为 UTC（出生时与查询时偏移不同、跨夏令时都照样换算），换算成 Unix 毫秒时向下取整，与原生同口径。
 * 只接受恰好一行、PID 相符、字段换算回读一致、偏移在合法范围内。串内偏移与本机时区在该时刻的偏移不一致时，
 * 无法确定哪一个是写入时用的，把两者之差记为 toleranceMs，由比较方计入容差（同代不会因此被误排除）；
 * 出生晚于当前（计入容差后）按 unknown。
 */
export function parseWindowsProcessBirth(
  stdout: string,
  pid: number,
  offsetAt: (unixMs: number) => number = unixMs => -new Date(unixMs).getTimezoneOffset(),
  now = Date.now(),
): OsProcessBirth {
  const rows = stdout.trim().split(/\r?\n/u);
  const match = rows.length === 1
    ? /^(\d+) (\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/u.exec(rows[0]!.trim())
    : null;
  if (!match || Number(match[1]) !== pid) return { kind: 'unknown' };
  const [year, month, day, hour, minute, second, micros] = match.slice(2, 9).map(Number) as [number, number, number, number, number, number, number];
  const offset = (match[9] === '-' ? -1 : 1) * Number(match[10]);
  if (Math.abs(offset) > 14 * 60) return { kind: 'unknown' };
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const fields = `${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}`;
  if (!Number.isFinite(local) || !new Date(local).toISOString().startsWith(fields)) return { kind: 'unknown' };
  const startTime = local - offset * 60_000 + Math.floor(micros / 1000);
  const zone = offsetAt(startTime);
  const toleranceMs = Number.isFinite(zone) ? Math.abs(zone - offset) * 60_000 : Number.POSITIVE_INFINITY;
  if (startTime <= 0 || !Number.isFinite(toleranceMs) || startTime > now + toleranceMs) return { kind: 'unknown' };
  return { kind: 'present', startTime, toleranceMs };
}

/** 系统目录下的系统程序绝对路径；系统目录取不到或不是绝对路径时不调用。 */
function windowsSystemProgram(...segments: string[]): string | undefined {
  const root = process.env.SystemRoot ?? process.env.windir;
  return root && path.win32.isAbsolute(root) ? path.win32.join(root, 'System32', ...segments) : undefined;
}
