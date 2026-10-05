import { LocalLogStore } from "@zhixing/core/logging/storage";
import { LogAppendIndeterminateError, logFailureEvidence, logStorageFailure } from "@zhixing/core/logging";
import type { DeviceCapacityAdmission, DeviceCapacityArbiterPort, DeviceCapacityDimension } from "@zhixing/core/resources";
import { LogFilesProcess } from "./files-process.js";
import { createLogWriterProbe } from "./writers.js";
import type { CapacityReply, StoreWorkerInput, StoreWorkerOutput } from "./store-worker-protocol.js";
import { consumeTerminalParentEndpoint, TerminalParentTransport } from '@zhixing/terminal-ui/parent-transport';
import { LOG_STORE_FRAME_BYTES } from './store-process.js';
import { consumeLogWorkerStdio, createTerminalLogWorker, runTerminalLogObserver } from './terminal-worker.js';
import { createTerminalOwnedProcessFactory } from '../terminal/host-launch.js';
import { CheckpointDirectoryHandle } from '@zhixing/mesh/filesystem';

const endpoint = consumeTerminalParentEndpoint('ZHIXING_LOG_STORE_PIPE');
const parent = endpoint !== undefined ? new TerminalParentTransport(endpoint, LOG_STORE_FRAME_BYTES) : consumeLogWorkerStdio();
const send = (message: StoreWorkerOutput): void => { if (parent?.connected) parent.send(message, () => {}); else if (process.connected) process.send!(message, () => {}); };
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
const createFiles = parent ? createTerminalOwnedProcessFactory('log-files') : undefined;
const files = new LogFilesProcess(home, 5000, parent ? {
  createWorker: args => createTerminalLogWorker('log-files', args),
  createWindowsSession: () => CheckpointDirectoryHandle.createWindowsSession(5000, (executable, args) =>
    createFiles!(executable, args ?? [], { deadline: Date.now() + 5000 }).child),
} : {});
const store = new LocalLogStore({ files, capacity, observeWriters: createLogWriterProbe(home, files, ownerPid, parent ? runTerminalLogObserver : undefined) });
let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  for (const settle of pending.values()) settle({ kind: "cancelled" });
  pending.clear();
  void store.close().then(() => { if (parent) parent.close(); else if (process.connected) process.disconnect(); }, () => {
    // Unknown nested completion must not look like an ordinary worker exit.
    // Keep the private parent lifetime until its existing supervisor deadline.
    if (!parent && process.connected) process.disconnect();
  });
};
(parent ?? process).once("disconnect", close);
parent?.on('error', close);
(parent ?? process).on("message", (message: StoreWorkerInput) => {
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
