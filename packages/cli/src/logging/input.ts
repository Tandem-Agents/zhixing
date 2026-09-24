import type { LogRecordPort, LogSource } from "@zhixing/core/logging";

export const INPUT_LOG_SOURCE: LogSource = {
  id: "terminal-input", version: 1,
  events: { state: { message: "终端输入状态", level: "info", tier: "detail", fields: {
    stage: "text", isRaw: "boolean", isPaused: "boolean", keypressListenerCount: "number",
    dataListenerCount: "number", active: "boolean", suspended: "boolean", reason: "text",
  } } },
};
/** No keystroke, paste body, selection text or arbitrary input object is retained. */
export function recordInputEvent(records: LogRecordPort | undefined, stage: string, data: Record<string, unknown>): void {
  records?.record(() => ({ event: "state", data: {
    stage, active: data.active, suspended: data.suspended,
    reason: typeof data.reason === "string" ? data.reason : undefined,
  } }));
}
export function recordInputState(records: LogRecordPort | undefined, stage: string, stdin: NodeJS.ReadStream | null | undefined, extra?: Record<string, unknown>): void {
  records?.record(() => ({ event: "state", data: {
    stage, isRaw: stdin?.isRaw, isPaused: stdin?.isPaused(),
    keypressListenerCount: stdin?.listenerCount("keypress"), dataListenerCount: stdin?.listenerCount("data"),
    active: extra?.active, suspended: extra?.suspended,
  } }));
}
