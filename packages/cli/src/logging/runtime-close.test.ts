import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { DEFAULT_LOG_POLICY } from "@zhixing/core/logging";
import { beginRuntimeLogging } from "./runtime.js";
import { closeWriterDeclaration } from "./writer-admission.js";
import type { StoreWorkerInput } from "./store-worker-protocol.js";

vi.mock("./writer-admission.js", () => ({
  beginWriterDeclaration: vi.fn(async () => {}),
  closeWriterDeclaration: vi.fn(async () => {}),
}));

it.each(["complete", "store-exit-pending", "append-pending"] as const)(
  "reports the actual recorder drain and store completion: %s", async mode => {
    const events: string[] = [];
    const worker = Object.assign(new EventEmitter(), {
      connected: true, ref() {}, unref() {}, kill() {},
      send(message: StoreWorkerInput, callback: (error?: Error | null) => void) {
        callback();
        if (message.kind === "close") {
          if (mode !== "store-exit-pending") queueMicrotask(() => worker.emit("close", 0));
        } else if (message.kind === "call") {
          if (message.operation === "append") events.push(...(message.records ?? []).map(row => row.record.event));
          if (mode === "append-pending" && message.operation === "append") return;
          queueMicrotask(() => worker.emit("message", { kind: "result", id: message.id,
            value: { policy: { effective: DEFAULT_LOG_POLICY }, storageDegraded: false } }));
        }
      },
    });
    const capacity = { arbiter: { acquire: vi.fn(), snapshot: vi.fn() }, retainActivity: () => () => {}, close: vi.fn() };
    const logging = beginRuntimeLogging("fixture-home", "repl", undefined,
      () => ({ worker, ready: Promise.resolve() }), capacity as never, { requireCompleteClose: true });
    try {
      const result = logging.finish("success", "user-exit", 40);
      if (mode === "complete") await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow(mode === "store-exit-pending" ? "close-pending" : "close-incomplete");
      expect(events).toContain("stopped");
      expect(closeWriterDeclaration).toHaveBeenCalled();
      expect(capacity.close).not.toHaveBeenCalled();
      expect(logging.finish("success", "again", 5000)).toBe(result);
    } finally {
      worker.emit("close", 0);
    }
  },
);
