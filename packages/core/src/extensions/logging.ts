import type { LogSource } from "../logging/contracts.js";

const fields = { method: "text", direction: "text", generation: "text", error: "text", attempt: "number", reportedOk: "boolean", code: "number", signal: "text" } as const;
export const EXTENSION_LOG_SOURCE: LogSource = {
  id: "extension", version: 1,
  events: {
    starting: { message: "扩展代际开始启动", level: "info", tier: "critical", fields },
    ready: { message: "扩展代际已通过握手", level: "info", tier: "critical", fields },
    stopped: { message: "扩展进程已退出", level: "info", tier: "critical", fields },
    failed: { message: "扩展运行受阻", level: "error", tier: "critical", fields },
    requested: { message: "扩展协议请求已观察到", level: "info", tier: "critical", fields },
    returned: { message: "扩展协议处理已返回", level: "info", tier: "critical", fields },
    uncertain: { message: "扩展协议结果未确认", level: "warn", tier: "critical", fields },
    unmatched: { message: "收到已超时或无法匹配的扩展回执", level: "warn", tier: "critical", fields },
    retry: { message: "扩展代际准备恢复", level: "warn", tier: "critical", fields },
  },
};
