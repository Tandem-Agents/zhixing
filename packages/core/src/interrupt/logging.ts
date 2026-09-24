import type { LogSource } from "../logging/contracts.js";
export const PROCESS_LOG_SOURCE: LogSource = {
  id: "process", version: 1,
  events: {
    fallback: { message: "进程树停止失败，已改用直接停止", level: "warn", tier: "critical", fields: { pid: "number", error: "text" } },
    stopped: { message: "受控子进程已退出", level: "info", tier: "critical", fields: { pid: "number" } },
  },
};
