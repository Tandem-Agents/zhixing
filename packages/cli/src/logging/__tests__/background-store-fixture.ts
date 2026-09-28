import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { LogRecorder } from "@zhixing/core/logging";
import { IsolatedLogStore } from "../store-process.js";
import { createDeviceCapacityRuntime } from "../../serve/device-capacity-runtime.js";

// Observe the real fork without changing its executable or spawn options.
const originalFork = childProcess.fork;
let writer: ChildProcess | undefined;
childProcess.fork = ((...args: Parameters<typeof originalFork>) => {
  writer = originalFork(...args);
  return writer;
}) as typeof originalFork;
syncBuiltinESMExports();

const capacity = createDeviceCapacityRuntime(process.argv[2]!);
const recorder = new LogRecorder(new IsolatedLogStore(process.argv[2]!, capacity.arbiter));
const records = recorder.bind({ id: "background-console", version: 1, events: {
  sample: { message: "background evidence", level: "info", tier: "critical", fields: {} },
} }, { scope: "storage" });
let closing: Promise<void> | undefined;
const close = () => closing ??= recorder.close(5000).finally(() => {
  capacity.close();
  if (process.connected) process.disconnect();
});
const publish = async () => {
  records.record({ event: "sample" });
  await recorder.flush(10_000);
  process.send!({ kind: "ready", worker: writer?.pid, health: recorder.health() });
};
process.once("disconnect", () => { void close(); });
process.on("message", (command: string) => {
  void (async () => {
    if (command === "close") return close();
    if (command !== "recover" || !writer) throw Error("Unexpected fixture command");
    const exited = new Promise<void>(resolve => writer!.once("close", () => resolve()));
    writer.kill("SIGKILL");
    await exited;
    await publish();
  })().catch(async () => { process.exitCode = 1; await close(); });
});
await publish();
