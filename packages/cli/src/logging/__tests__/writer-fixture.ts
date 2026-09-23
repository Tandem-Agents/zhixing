import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";

// Capture only this fixture's real native owner. No production PID discovery.
const spawn = childProcess.spawn;
let ownerPid: number | undefined;
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args);
  ownerPid = child.pid;
  return child;
}) as typeof spawn;
syncBuiltinESMExports();
const { LocalLogStore } = await import("../../../../core/src/logging/storage.js");
const { captureLog, bindLogSource } = await import("../../../../core/src/logging/capture.js");
const { DEFAULT_LOG_POLICY } = await import("../../../../core/src/logging/policy.js");
const { createDeviceCapacityRuntime } = await import("../../serve/device-capacity-runtime.js");
const { LogFilesProcess } = await import("../files-process.js");
const [home, mode] = process.argv.slice(2) as [string, string];
const files = new LogFilesProcess(home);
let now = Date.now();
const store = new LocalLogStore({
  files,
  capacity: createDeviceCapacityRuntime(home).arbiter,
  now: () => now,
});
const initial = await store.initialize();
const source = bindLogSource({
  id: "crash-fixture",
  version: 1,
  events: {
    event: {
      message: "crash fixture",
      level: "info",
      tier: "critical",
      fields: { text: "text" },
    },
  },
});
const capture = captureLog(
  source,
  { scope: "storage" },
  {
    event: "event",
    data: { text: mode === "detail" ? "d".repeat(60_000) : "evidence" },
  },
  DEFAULT_LOG_POLICY,
  randomUUID(),
  1,
);
const pause = async (): Promise<never> => {
  process.send?.({
    phase: "paused",
    ownerPid,
    storeId: initial.storeId,
    id: capture.record.id,
  });
  return new Promise<never>(() => undefined);
};
if (mode === "native") {
  await store.append([capture]);
  process.send?.({
    phase: "paused",
    ownerPid,
    storeId: initial.storeId,
    id: capture.record.id,
  });
  await new Promise<void>((resolve) => process.once("message", () => resolve()));
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await store.initialize();
      break;
    } catch {
      /* First call may observe owner death. */
    }
  }
  process.send?.({
    phase: "recovered",
    storeId: result?.storeId,
    upper: result?.upper,
  });
} else if (mode === "truncate") {
  await store.append([capture]);
  now += DEFAULT_LOG_POLICY.criticalTtlMs + 1;
  const truncate = files.truncate.bind(files);
  files.truncate = async (name, identity, bytes) => {
    await truncate(name, identity, bytes);
    if (name.startsWith("segment-") && bytes === 0) await pause();
  };
  await store.maintain();
} else {
  const write = files.write.bind(files);
  files.write = async (name, bytes) => {
    await write(name, bytes);
    if (
      (mode === "segment" && name.startsWith("segment-")) ||
      (mode === "detail" && name.startsWith("detail-")) ||
      (mode === "published" && name.startsWith("published-"))
    )
      await pause();
  };
  await store.append([capture]);
}
await store.close();
process.disconnect?.();
