import { LocalLogStore } from "@zhixing/core/logging/storage";
import { LogAppendIndeterminateError, logFailureEvidence, logStorageFailure } from "@zhixing/core/logging";
import type { DeviceCapacityAdmission, DeviceCapacityArbiterPort, DeviceCapacityDimension } from "@zhixing/core/resources";
import { LogFilesProcess } from "./files-process.js";
import { createLogWriterProbe } from "./writers.js";
import type { CapacityReply, StoreWorkerInput, StoreWorkerOutput } from "./store-worker-protocol.js";

const send = (message: StoreWorkerOutput): void => { if (process.connected) process.send!(message, () => {}); };
let nextCapacity = 0;
const pending = new Map<number, (reply: CapacityReply) => void>();
const capacity: DeviceCapacityArbiterPort = {
  snapshot: () => { throw Error("Log writer does not inspect capacity diagnostics"); },
  acquire: async (request, signal): Promise<DeviceCapacityAdmission> => {
    if (signal.aborted) return { kind: "cancelled" };
    const id = ++nextCapacity;
    const cancel = () => send({ kind: "cancel", id });
    signal.addEventListener("abort", cancel, { once: true });
    let reply: CapacityReply;
    try {
      reply = await new Promise<CapacityReply>(resolve => {
        pending.set(id, resolve);
        send({ kind: "acquire", id, request });
      });
    } finally { signal.removeEventListener("abort", cancel); }
    if (reply.kind !== "granted") return reply;
    const budget = reply.budget;
    const used = { readBytes: 0, writeBytes: 0, ioOperations: 0 };
    let released = false, began = false, completed = false;
    return { kind: "granted", permit: {
      granted: budget,
      tryBegin: bound => {
        if (began || released || JSON.stringify(bound) !== JSON.stringify(budget)) return undefined;
        began = true;
        return {
          claim: (dimension: DeviceCapacityDimension, amount: number) => {
            if (completed || released || !(dimension in used) || !Number.isSafeInteger(amount) || amount < 0)
              throw Error("Invalid reserved log I/O claim");
            const key = dimension as keyof typeof used;
            if (used[key] + amount > budget.quantum[key]) throw Error("Reserved log I/O budget exceeded");
            used[key] += amount;
          },
          complete: () => { completed = true; },
        };
      },
      release: () => { if (!released) { released = true; send({ kind: "release", id, used }); } },
    } };
  },
};
const [home, owner] = process.argv.slice(2) as [string, string];
const ownerPid = Number(owner);
if (!home || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw Error("Log writer owner is required");
const files = new LogFilesProcess(home);
const store = new LocalLogStore({ files, capacity, observeWriters: createLogWriterProbe(home, files, ownerPid) });
let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  for (const settle of pending.values()) settle({ kind: "cancelled" });
  pending.clear();
  void store.close().catch(() => {}).finally(() => { if (process.connected) process.disconnect(); });
};
process.once("disconnect", close);
process.on("message", (message: StoreWorkerInput) => {
  if (message.kind === "capacity") {
    const settle = pending.get(message.id);
    pending.delete(message.id); settle?.(message.result); return;
  }
  if (message.kind === "close") {
    close();
    return;
  }
  void (async () => {
    try {
      const value = message.operation === "append" ? await store.append(message.records ?? []) : await store[message.operation]();
      send({ kind: "result", id: message.id, value });
    } catch (error) {
      // Native exception text can contain local paths. Only finite classes cross this boundary.
      send({ kind: "failure", id: message.id,
        code: logStorageFailure(error), evidence: logFailureEvidence(error),
        indeterminate: error instanceof LogAppendIndeterminateError });
    }
  })();
});
