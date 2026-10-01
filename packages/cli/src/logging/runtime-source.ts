import { LOG_PHASE_EVENTS, LOG_FAILURE_FIELDS, type LogSource, type LogRecordPort } from "@zhixing/core/logging";
const shown = new WeakSet<LogRecordPort>();
export function recordFirstSurfaceOutput(records: LogRecordPort | undefined): void {
  if (!records || shown.has(records)) return;
  shown.add(records);
  records.record({ event: "firstOutput", result: "success", data: { sinceProcessStartMs: Math.round(process.uptime() * 1000) } });
}
export const RUNTIME_LOG_SOURCE: LogSource = {
  id: "runtime",
  version: 1,
  events: {
    ...LOG_PHASE_EVENTS,
    writerDeclarationUnavailable: { message: "日志写协议声明暂不可验证，继续使用保守准入", level: "warn", tier: "critical", fields: { reason: "text", failure: { fields: LOG_FAILURE_FIELDS } } },
    hostSpawnRequested: { message: "开始发起宿主进程交接", level: "info", tier: "critical", fields: {} },
    hostSpawned: { message: "已发起宿主进程交接", level: "info", tier: "critical", fields: { pid: "number" } },
    childExited: { message: "宿主在启动交接期间退出", level: "error", tier: "critical", fields: { pid: "number", exitCode: "number", signal: "text" } },
    coordinatorExited: { message: "后台启动协调者已正常完成", level: "info", tier: "critical", fields: { pid: "number", exitCode: "number", launchMode: "text" } },
    hostSpawnFailed: { message: "宿主进程交接发生错误", level: "error", tier: "critical", fields: { failure: { fields: LOG_FAILURE_FIELDS } } },
    hostReady: { message: "宿主已通过就绪握手", level: "info", tier: "critical", fields: { pid: "number", spawnedPid: "number", launchMode: "text" } },
    firstOutput: { message: "终端已首次输出启动内容", level: "info", tier: "critical", fields: { sinceProcessStartMs: "number" } },
    interactionReady: { message: "终端输入已就绪", level: "info", tier: "critical", fields: { sinceProcessStartMs: "number" } },
    started: {
      message: "运行入口已开始",
      level: "info",
      tier: "critical",
      fields: { mode: "text", implementation: "text", pid: "number", sinceProcessStartMs: "number" },
    },
    hostStarted: {
      message: "宿主开始装配",
      level: "info",
      tier: "critical",
      fields: {},
    },
    hostStopped: {
      message: "宿主运行与资源清理已结束",
      level: "info",
      tier: "critical",
      fields: { cleanupFailures: "number" },
    },
    stopped: {
      message: "运行入口已结束",
      level: "info",
      tier: "critical",
      fields: { reason: "text" },
    },
    hostConnected: { message: "前台已连接宿主", level: "info", tier: "critical", fields: { attempt: "number" } },
    startupPhase: { message: "启动阶段已结束", level: "info", tier: "critical", fields: { phase: "text", durationMs: "number" } },
    failed: { message: "运行入口发生错误", level: "error", tier: "critical", fields: {
      reason: "text", error: "text", attempt: "number", failure: { fields: LOG_FAILURE_FIELDS },
      issues: { items: { fields: { field: "text", reason: "text" } }, maxItems: 16 },
      missing: { items: "text", maxItems: 32 },
    } },
  },
};
