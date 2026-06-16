/**
 * `zhixing status` — 查询知行运行四态
 *
 * `zhixing serve status` 仅作为兼容入口复用同一实现。
 *
 * 四态（spec §3.3.4）：
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
import {
  readLock,
  isProcessAlive,
  ServerStateFile,
  getDefaultStatePath,
  getDefaultReadyMarkerPath,
  type PidFileContents,
  type ServerStateSnapshot,
} from "@zhixing/server";

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

export async function runStatusCommand(opts: StatusOptions = {}): Promise<StatusReport> {
  const deps = opts.deps ?? {};
  const con = deps.console ?? console;

  const report = await buildReport(deps);

  if (opts.json) {
    con.log(JSON.stringify(report, null, 2));
  } else {
    printReportHuman(report, con);
  }

  return report;
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
  report: StatusReport,
  con: Pick<Console, "log">,
): void {
  const dot = chalk.bold(
    report.status === "running"
      ? chalk.green("●")
      : report.status === "running-unhealthy"
        ? chalk.yellow("●")
        : report.status === "stale"
          ? chalk.red("●")
          : chalk.gray("○"),
  );

  const label = chalk.bold(report.status);
  con.log(`  ${dot} ${label}`);
  if (report.pid !== undefined) con.log(chalk.dim(`    pid:       ${report.pid}`));
  if (report.port !== undefined) con.log(chalk.dim(`    port:      ${report.port}`));
  if (report.host !== undefined) con.log(chalk.dim(`    host:      ${report.host}`));
  if (report.uptimeSec !== undefined) {
    con.log(chalk.dim(`    uptime:    ${formatUptime(report.uptimeSec)}`));
  }
  if (report.phase) con.log(chalk.dim(`    phase:     ${report.phase}`));
  if (report.logPath) con.log(chalk.dim(`    log:       ${report.logPath}`));
  if (report.reason) con.log(chalk.yellow(`    reason:    ${report.reason}`));

  if (report.status === "stale") {
    con.log();
    con.log(chalk.dim("    Run `zhixing` to replace the background host on demand."));
  } else if (report.status === "stopped") {
    con.log();
    con.log(chalk.dim("    Run `zhixing` to start the background host on demand."));
  }
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}
