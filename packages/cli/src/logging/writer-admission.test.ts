import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { declareLogWriter } from "./writer-admission.js";

vi.mock("node:worker_threads", async original => ({ ...await original<typeof import("node:worker_threads")>(), Worker: vi.fn() }));

it.skipIf(!["win32", "linux"].includes(process.platform))("retains declaration failure before fallback, even when the notification throws", async () => {
  const worker = Object.assign(new EventEmitter(), { unref() {}, async terminate() { return 0; } });
  vi.mocked(Worker).mockImplementation(function () { return worker as any; });
  const notice = vi.fn(() => { throw Error("observer unavailable"); });
  const declaration = declareLogWriter(process.cwd(), notice);
  worker.emit("error", Object.assign(Error("private worker path"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
  await declaration.ready;
  expect(notice).toHaveBeenCalledWith("worker-failed", { category: "system", code: "ERR_WORKER_OUT_OF_MEMORY" });
  await declaration.close();
});
