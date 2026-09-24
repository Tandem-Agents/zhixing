import type { LogRecordPort, LogSource } from "@zhixing/core/logging";

export const STDIO_LOG_SOURCE: LogSource = {
  id: "stdio", version: 1,
  events: { output: { message: "后台标准输出已观察到；未分类正文未采集", level: "info", tier: "detail", fields: { stream: "text", size: "number", unit: "text" } } },
};

/** Background output has no private file/journal bypass. Original write owns callbacks and backpressure. */
export function observeBackgroundOutput(
  records: LogRecordPort,
  streams: readonly ["stdout" | "stderr", Pick<NodeJS.WriteStream, "write">][] = [["stdout", process.stdout], ["stderr", process.stderr]],
): () => void {
  let active = true, observing = false;
  for (const [name, stream] of streams) {
    const original = stream.write;
    stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...args: unknown[]): boolean {
      if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) return Reflect.apply(original, this, [chunk, ...args]);
      if (active && !observing) {
        observing = true;
        try {
          records.record(() => ({ event: "output", data: {
            stream: name,
            // No full-text scanning, object coercion or separate line buffer.
            size: typeof chunk === "string" ? chunk.length : chunk.byteLength,
            unit: typeof chunk === "string" ? "utf16" : "byte",
          } }));
        } finally { observing = false; }
      }
      // Even after Recorder closes, do not resume raw persistence in a service manager.
      return Reflect.apply(original, this, ["", ...args]);
    } as NodeJS.WriteStream["write"];
  }
  return () => { active = false; };
}
