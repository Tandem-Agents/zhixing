/**
 * `zhixing status` — 查询知行运行四态
 *
 * 四态：
 *   running            —— PID 活 + /api/health 200 + heartbeat < 2×阈值
 *   running-unhealthy  —— PID 活但 health 挂 / heartbeat stale
 *   stopped            —— 无 PID 文件（干净停机）
 *   stale              —— 有 PID 文件但进程已死（崩溃残留）
 *
 * 输出：
 *   默认：彩色一行摘要 + pid/port/uptime/log 细节
 *   json 选项仅供内部调用与测试使用，不暴露为用户命令参数。
 *
 * 所有外部依赖通过 deps 注入，测试可 mock 掉 health HTTP + state 文件读取。
 */

import chalk from "chalk";
import http from "node:http";
import { canonicalize } from "@zhixing/core/protocol";
import {
  readLock,
  isProcessAlive,
  ServerStateFile,
  getDefaultStatePath,
  getDefaultReadyMarkerPath,
  type PidFileContents,
  type ServerStateSnapshot,
  projectManagedHostStatus,
  type ManagedHostActionCode,
  type ManagedHostPublicState,
  type ManagedHostPublicStatus,
} from "@zhixing/server";
import {
  createManagedServiceAdapter,
  ManagedServiceError,
  type ManagedServiceAdapter,
} from "./managed-service.js";
import { resolveHostLaunchPlan } from "@zhixing/mesh/bootstrap";
import { loadCurrentManagedServiceState } from "./managed-service-runtime.js";
import type { ManagedServiceCurrentState } from "./managed-service-reconciler.js";

export type ServerLiveStatus = "running" | "running-unhealthy" | "stopped" | "stale";

/** 2×heartbeat 间隔（2×60s=120s）；heartbeat 缺失 1 次告警，2 次确认僵尸 */
const STALE_HEARTBEAT_MS = 120_000;

export interface StatusOptions {
  json?: boolean;
  deps?: StatusDeps;
}

export interface StatusDeps {
  readLockFn?: typeof readLock;
  isProcessAliveFn?: typeof isProcessAlive;
  httpGetFn?: (url: string, timeoutMs: number) => Promise<number>;
  readStateFn?: () => Promise<ServerStateSnapshot | null>;
  clock?: () => Date;
  console?: Pick<Console, "log" | "error">;
  publicStatusFn?: (report: StatusReport) => Promise<ManagedHostPublicStatus>;
}

export interface StatusReport {
  status: ServerLiveStatus;
  pid?: number;
  port?: number;
  host?: string;
  uptimeSec?: number;
  logPath?: string;
  startedAt?: string;
  lastHeartbeat?: string;
  phase?: ServerStateSnapshot["phase"];
  /** 不健康原因（仅 running-unhealthy / stale）*/
  reason?: string;
}

export interface OfflineStatusSnapshot {
  readonly report: StatusReport;
  readonly lock: PidFileContents | null;
  readonly state: ServerStateSnapshot | null;
}

export { projectManagedHostStatus };
export type {
  ManagedHostActionCode,
  ManagedHostPublicState,
  ManagedHostPublicStatus,
};

export async function runStatusCommand(opts: StatusOptions = {}): Promise<StatusReport> {
  const deps = opts.deps ?? {};
  const con = deps.console ?? console;

  const report = await buildReport(deps);

  if (opts.json) {
    con.log(JSON.stringify(report, null, 2));
  } else {
    const publicStatus = deps.publicStatusFn
      ? await deps.publicStatusFn(report)
      : opts.deps
        ? projectManagedHostStatus({ desired: "on-demand", process: report.status, readiness: readinessFor(report) })
        : await buildManagedHostPublicStatus(report);
    printReportHuman(publicStatus, con);
  }

  return report;
}

/** Effect-free local projection for offline diagnostics; intentionally performs no HTTP probe. */
export async function buildOfflineStatusReport(deps: StatusDeps = {}): Promise<StatusReport> {
  return (await readOfflineStatusSnapshot(deps)).report;
}

/** Reads the process generation and its local state once for effect-free consumers. */
export async function readOfflineStatusSnapshot(
  deps: StatusDeps = {},
): Promise<OfflineStatusSnapshot> {
  const readLockFn = deps.readLockFn ?? readLock;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const readState = deps.readStateFn ?? defaultReadState;
  const lock = await readLockFn().catch(() => null);
  if (!lock) {
    return { report: { status: "stopped" }, lock: null, state: null };
  }
  if (!isAlive(lock.pid)) {
    return { report: { status: "stale" }, lock, state: null };
  }
  const state = await readState().catch(() => null);
  return {
    report: {
      status: state?.phase === "unhealthy" || state?.phase === "stopping"
        ? "running-unhealthy"
        : "running",
      pid: lock.pid,
      port: lock.port,
      host: lock.host,
      startedAt: lock.startedAt,
      phase: state?.phase,
      lastHeartbeat: state?.lastHeartbeat,
    },
    lock,
    state,
  };
}

export async function buildManagedHostPublicStatus(
  processReport: StatusReport,
  options: {
    readonly readiness?: Parameters<typeof projectManagedHostStatus>[0]["readiness"];
    readonly deps?: ManagedHostStatusSnapshotDeps;
  } = {},
): Promise<ManagedHostPublicStatus> {
  return projectManagedHostStatus(await buildManagedHostStatusSnapshot(processReport, options));
}

export interface ManagedHostStatusSnapshotDeps {
  readonly loadCurrent?: () => Promise<ManagedServiceCurrentState>;
  readonly adapter?: Pick<ManagedServiceAdapter, "inspect">;
}

export async function buildManagedHostStatusSnapshot(
  processReport: StatusReport,
  options: {
    readonly readiness?: Parameters<typeof projectManagedHostStatus>[0]["readiness"];
    readonly deps?: ManagedHostStatusSnapshotDeps;
  } = {},
): Promise<Parameters<typeof projectManagedHostStatus>[0]> {
  const loadCurrent = options.deps?.loadCurrent ?? (() => loadCurrentManagedServiceState("inspect"));
  const adapter = options.deps?.adapter ?? createManagedServiceAdapter();
  const readiness = options.readiness ?? readinessFor(processReport);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let current: ManagedServiceCurrentState;
    try {
      current = await loadCurrent();
    } catch (error) {
      return {
        desired: "managed",
        process: processReport.status,
        readiness,
        errorCode: publicStatusError(error),
      };
    }
    const identity = managedStatusIdentity(current);
    try {
      const plan = resolveHostLaunchPlan(current);
      const service = current.spec
        ? await adapter.inspect(current.spec, new AbortController().signal)
        : undefined;
      const latest = await loadCurrent();
      if (managedStatusIdentity(latest) !== identity) continue;
      return {
        desired: plan.mode,
        ...(service ? { service } : {}),
        process: processReport.status,
        readiness,
      };
    } catch (error) {
      try {
        const latest = await loadCurrent();
        if (managedStatusIdentity(latest) !== identity) continue;
      } catch (reloadError) {
        return {
          desired: "managed",
          process: processReport.status,
          readiness,
          errorCode: publicStatusError(reloadError),
        };
      }
      return {
        desired: safeDesiredMode(current),
        process: processReport.status,
        readiness,
        errorCode: publicStatusError(error),
      };
    }
  }
  return {
    desired: "managed",
    process: processReport.status,
    readiness,
    errorCode: "configuration-invalid",
  };
}

function managedStatusIdentity(current: ManagedServiceCurrentState): string {
  return canonicalize(current);
}

function safeDesiredMode(current: ManagedServiceCurrentState): "managed" | "on-demand" | "none" {
  try {
    return resolveHostLaunchPlan(current).mode;
  } catch {
    return "managed";
  }
}

function publicStatusError(error: unknown): ManagedHostActionCode {
  if (error instanceof Error && error.message === "local-credentials-unavailable") {
    return "credentials-locked";
  }
  if (error instanceof ManagedServiceError) {
    if (error.code === "permission-required") return "permission-required";
    if (error.code === "manager-unavailable") return "login-required";
  }
  return "configuration-invalid";
}

async function buildReport(deps: StatusDeps): Promise<StatusReport> {
  const readLockFn = deps.readLockFn ?? readLock;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const httpGet = deps.httpGetFn ?? defaultHttpGet;
  const readState = deps.readStateFn ?? defaultReadState;
  const now = (deps.clock ?? (() => new Date()))();

  const lock = await readLockFn().catch(() => null);
  if (!lock) {
    return { status: "stopped" };
  }

  if (!isAlive(lock.pid)) {
    return {
      status: "stale",
      pid: lock.pid,
      port: lock.port,
      logPath: lock.logPath,
      startedAt: lock.startedAt,
      reason: "PID file present but process is not alive (crash residue)",
    };
  }

  // PID alive → 进一步看 /api/health + heartbeat
  const [healthOk, state] = await Promise.all([
    checkHealth(lock, httpGet),
    readState(),
  ]);

  const uptimeSec = parseUptimeSec(lock, now);
  const baseReport: StatusReport = {
    status: "running",
    pid: lock.pid,
    port: lock.port,
    host: lock.host,
    logPath: lock.logPath,
    uptimeSec,
    startedAt: lock.startedAt,
    phase: state?.phase,
    lastHeartbeat: state?.lastHeartbeat,
  };

  if (!healthOk) {
    return { ...baseReport, status: "running-unhealthy", reason: "health endpoint not OK" };
  }

  if (state) {
    const hbAgeMs = now.getTime() - new Date(state.lastHeartbeat).getTime();
    if (state.phase === "running" && hbAgeMs >= STALE_HEARTBEAT_MS) {
      return {
        ...baseReport,
        status: "running-unhealthy",
        reason: `heartbeat stale (${Math.round(hbAgeMs / 1000)}s since last)`,
      };
    }
    if (state.phase === "stopping") {
      return { ...baseReport, status: "running-unhealthy", reason: "phase=stopping" };
    }
    if (state.phase === "unhealthy") {
      return { ...baseReport, status: "running-unhealthy", reason: "phase=unhealthy" };
    }
  }

  return baseReport;
}

function parseUptimeSec(lock: PidFileContents, now: Date): number | undefined {
  if (!lock.startedAt) return undefined;
  const started = Date.parse(lock.startedAt);
  if (!Number.isFinite(started)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - started) / 1000));
}

async function checkHealth(
  lock: PidFileContents,
  httpGet: (url: string, timeoutMs: number) => Promise<number>,
): Promise<boolean> {
  const host = lock.host ?? "127.0.0.1";
  try {
    const status = await httpGet(`http://${host}:${lock.port}/api/health`, 1000);
    return status === 200;
  } catch {
    return false;
  }
}

async function defaultReadState(): Promise<ServerStateSnapshot | null> {
  const f = new ServerStateFile({
    statePath: getDefaultStatePath(),
    readyMarkerPath: getDefaultReadyMarkerPath(),
  });
  return f.read();
}

function defaultHttpGet(url: string, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

function printReportHuman(
  report: ManagedHostPublicStatus,
  con: Pick<Console, "log">,
): void {
  const dot = report.state === "ready"
    ? chalk.green("●")
    : report.state === "needs-attention"
      ? chalk.yellow("●")
      : chalk.gray("○");
  con.log(`  ${chalk.bold(dot)} ${chalk.bold(report.label)}`);
  if (report.action) con.log(chalk.dim(`    ${report.action}`));
}

function readinessFor(
  report: StatusReport,
): "recovering" | "ready" | "degraded" | "stopping" {
  if (report.phase === "stopping") return "stopping";
  if (report.status === "running" && report.phase === "running") return "ready";
  if (report.status === "running-unhealthy") return "degraded";
  return "recovering";
}
