import { afterEach, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { IsolatedLogStore } from "./store-process.js";
import { createDeviceCapacityRuntime } from "../__tests__/device-capacity-fixture.js";
import { LogRecorder } from "@zhixing/core/logging";
import { createLocalLogStore } from "./runtime.js";
import type { DeviceCapacityArbiterPort } from "@zhixing/core/resources";
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const stores: IsolatedLogStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

it("releases the real disk lock while the business event loop is suspended", async () => {
  const home = await createTempDir("isolated-log-stall"), proof = path.join(home, "unlocked-proof");
  const child = fork(new URL("./__tests__/isolated-store-fixture.ts", import.meta.url), [home, String(process.pid), proof], {
    execArgv: ["--import=tsx/esm"], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
  });
  let error = "";
  child.stderr?.on("data", chunk => { error = (error + String(chunk)).slice(-2048); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error(error || "writer proof timed out")), 10_000);
      child.on("message", (message: any) => {
        if (message.kind === "acquire") child.send({ kind: "capacity", id: message.id, result: { kind: "granted", budget: message.request.atomic } });
        if (message.kind === "locked") {
          const started = Date.now();
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
          try {
            const unlocked = Number(readFileSync(proof, "utf8"));
            expect(unlocked).toBeGreaterThanOrEqual(started);
            expect(unlocked).toBeLessThan(Date.now());
            clearTimeout(deadline); resolve();
          } catch (failure) { clearTimeout(deadline); reject(failure); }
        }
      });
      child.send({ kind: "call", id: 1, operation: "initialize" });
    });
  } finally {
    if (child.connected) child.send({ kind: "close" });
    await exited;
  }
}, 15_000);

it("uses the existing capacity owner, persists drained records, and releases its reservations", async () => {
  const home = await createTempDir("isolated-log-store");
  const capacity = createDeviceCapacityRuntime(home);
  const store = new IsolatedLogStore(home, capacity.arbiter); stores.push(store);
  const recorder = new LogRecorder(store);
  const records = recorder.bind({ id: "isolated-fixture", version: 1, events: {
    sample: { message: "evidence", level: "info", tier: "critical", fields: {} },
  } }, { scope: "storage" });
  records.record({ event: "sample" });
  await recorder.flush(10_000);
  expect(recorder.health(), JSON.stringify(recorder.health())).toMatchObject({ state: "ready", queued: 0, lost: 0, unconfirmed: 0 });
  await recorder.close(5000);
  expect(capacity.arbiter.snapshot().occupancyInUse).toEqual({ slots: 0, temporaryBytes: 0, memoryReservationBytes: 0 });
  const read = createLocalLogStore(home);
  try { await read.store.read(async snapshot => { expect(snapshot.upper).toBeGreaterThan(0); }); }
  finally { await read.store.close(); read.capacity.close(); }
}, 20_000);

it("preserves capacity refusal and cancels pending admission on close", async () => {
  const home = await createTempDir("isolated-log-capacity");
  let pending = false;
  const capacity: DeviceCapacityArbiterPort = {
    snapshot: () => { throw Error("not used"); },
    acquire: async (_request, signal) => {
      pending = true;
      return new Promise(resolve => {
        if (signal.aborted) resolve({ kind: "cancelled" });
        else signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
      });
    },
  };
  const store = new IsolatedLogStore(home, capacity); stores.push(store);
  const result = store.initialize().catch(error => error);
  await expect.poll(() => pending, { timeout: 5000 }).toBe(true);
  await store.close();
  expect(await result).toBeInstanceOf(Error);
  await expect(store.initialize()).rejects.toMatchObject({ code: "owner-unavailable" });
}, 15_000);
