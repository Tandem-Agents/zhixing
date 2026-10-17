import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";
import { freezeProjectionInputs, projectionConsumes } from "../projection-inputs.js";

const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance()));
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await createTempDir("b1-projection-inputs");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"),
    new FileArtifactStore(path.join(root, "artifacts")), { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 57)) });
  logs.push(log); return log;
}
it("matches every declared input of a mixed envelope and conservatively consumes undeclared inputs", () => {
  const inputs = freezeProjectionInputs({ streams: ["control"], families: ["run:"] });
  expect(projectionConsumes(inputs, [{ stream: "job:other", body: {} }, { stream: "control", body: {} }])).toBe(true);
  expect(projectionConsumes(inputs, [{ stream: "run:selected", body: {} }])).toBe(true);
  expect(projectionConsumes(inputs, [{ stream: "job:other", body: {} }])).toBe(false);
  expect(projectionConsumes(undefined, [{ stream: "job:other", body: {} }])).toBe(true);
  expect(() => freezeProjectionInputs({})).toThrow();
  expect(() => freezeProjectionInputs({ families: ["unknown:"] })).toThrow();
});
it("does not invoke a failed unrelated reducer when another WAL stream commits", async () => {
  const log = await fixture();
  const reduce = vi.fn(() => { throw new Error("control projection unavailable"); });
  log.durableProjection({ projectionId: "input-isolation", reducerVersion: 1, authenticated: true,
    inputs: { streams: ["control"] }, reduce });
  await log.append([{ stream: "job:unrelated", body: { value: 1 } }]);
  expect(reduce).not.toHaveBeenCalled();
  await expect(log.append([{ stream: "control", body: { value: 2 } }])).rejects.toThrow("control projection unavailable");
  expect((await log.checkpoint()).lsn).toBe(1);
});
it("advances a proven current projection across unrelated commits and preserves exact replay", async () => {
  const log = await fixture();
  const reduce = vi.fn((envelope: { lsn: number }) => [{ kind: "put" as const, key: "last", value: envelope.lsn }]);
  const index = log.durableProjection({ projectionId: "input-progress", reducerVersion: 1, authenticated: true,
    inputs: { streams: ["control"] }, reduce });
  await log.append([{ stream: "control", body: { value: 1 } }]);
  for (let n = 0; n < 4; n++) await log.append([{ stream: "job:other", body: { value: n } }]);
  expect(reduce).toHaveBeenCalledTimes(1);
  expect((await index.checkpoints()).authority?.lsn).toBe(5);
  expect(await index.get("last")).toBe(1);
  await log.append([{ stream: "job:other", body: {} }, { stream: "control", body: {} }]);
  expect(await index.get("last")).toBe(6);
  expect(reduce).toHaveBeenCalledTimes(2);
});
