import { LocalLogStore } from "../../../../core/src/logging/storage.js";
import { LogRecorder } from "../../../../core/src/logging/recorder.js";
import { createDeviceCapacityRuntime } from "../../serve/device-capacity-runtime.js";
import { LogFilesProcess } from "../files-process.js";
import { createLogWriterProbe } from "../writers.js";

const [home, source] = process.argv.slice(2) as [string, string];
const files = new LogFilesProcess(home), capacity = createDeviceCapacityRuntime(home);
const degraded: string[] = [];
const store = new LocalLogStore({ files, capacity: capacity.arbiter, observeWriters: createLogWriterProbe(home, () => files.observeNodeProcesses()) });
const recorder = new LogRecorder(store, { onHealth: health => { if (health.state === "degraded") degraded.push(health.lastFailure ?? "unknown"); } });
try {
  const port = recorder.bind({ id: source, version: 1, events: {
    sample: { message: "concurrent process evidence", level: "info", tier: "critical", fields: { n: "number" } },
  } }, { scope: "storage" });
  for (let n = 0; n < 96; n++) port.record({ event: "sample", data: { n } });
  await recorder.flush(30_000);
  process.send?.({ health: recorder.health(), degraded });
} finally { await recorder.close(5000); capacity.close(); process.disconnect?.(); }
