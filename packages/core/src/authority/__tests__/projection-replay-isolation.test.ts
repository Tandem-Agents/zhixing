import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { StorageMaintenanceAdmissionError } from "../../resources/storage-maintenance.js";
const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => { await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance())); vi.restoreAllMocks(); });
async function open() {
  const root = await createTempDir("b1-replay-isolation");
  const log = new FileAuthorityCommitLog(root, new FileArtifactStore(path.join(root, "artifacts")));
  logs.push(log); return log;
}
const retry = () => new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "slots", retryAfterMs: 1 });
it("does not clone an unchanged caller-owned projection", async () => {
  const log = await open();
  const initial = { values: new Map(Array.from({ length: 4096 }, (_, i) => [i, i])) };
  const clone = vi.spyOn(globalThis, "structuredClone");
  const result = await log.transactProjection(initial, state => state, () => ({ kind: "return", value: undefined }));
  expect(result.state).toBe(initial);
  expect(clone.mock.calls.filter(([value]) => value === initial)).toHaveLength(0);
});
it("retries mutable replay from a fresh explicit draft without contaminating the verified basis", async () => {
  const log = await open();
  await log.append([{ stream: "control", body: { add: 2 } }]);
  await log.append([{ stream: "control", body: { add: 3 } }]);
  const initial = { total: 7 };
  let fail = true, attempts = 0;
  const result = await log.transactProjection(initial, (state, entry) => {
    state.total += (entry.body as { add: number }).add;
    if (fail) { fail = false; throw retry(); }
    return state;
  }, state => ({ kind: "return", value: state.total }), {
    stream: "control", createState: () => { attempts++; return { ...initial }; },
  });
  expect(result.value).toBe(12);
  expect(initial.total).toBe(7);
  expect(attempts).toBe(2);
});
it("keeps copy-on-first-write reducers lazy and leaves their source unchanged after a failed attempt", async () => {
  const log = await open();
  await log.append([{ stream: "control", body: { value: 2 } }]);
  const initial = new Map([["value", 1]]);
  let fail = true;
  const result = await log.transactProjection(initial, (state, entry) => {
    const next = state === initial ? new Map(state) : state;
    next.set("value", (entry.body as { value: number }).value);
    if (fail) { fail = false; throw retry(); }
    return next;
  }, state => ({ kind: "return", value: state.get("value") }), { stream: "control" });
  expect(result.value).toBe(2);
  expect(initial.get("value")).toBe(1);
});
