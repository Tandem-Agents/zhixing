import type { LogSource } from "@zhixing/core/logging";

export const CHANNEL_LOG_SOURCE: LogSource = {
  id: "channel", version: 1, events: {
    prepared: { message: "渠道消息已取得轮次身份", level: "info", tier: "critical", fields: {} },
    admitted: { message: "渠道轮次接纳结果已返回", level: "info", tier: "critical", fields: { status: "text", error: "text" } },
    received: { message: "宿主接纳渠道消息", level: "info", tier: "critical", fields: { inputChars: "number", chatType: "text" } },
    handled: { message: "渠道消息处理已返回", level: "info", tier: "critical", fields: { error: "text" } },
    sending: { message: "渠道投递开始", level: "info", tier: "critical", fields: { attempt: "number" } },
    delivered: { message: "渠道投递证据已返回", level: "info", tier: "critical", fields: { attempted: "boolean", retryable: "boolean", error: "text" } },
  },
};
