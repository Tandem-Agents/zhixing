import { expect, it, vi } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { AuthorityWorkObserver } from "../logging.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { FileArtifactStore } from "../artifact-store.js";
import type { LogDraft, LogRecordPort } from "../../logging/contracts.js";
import { observeLogPhase } from "../../logging/phase.js";

function collector() {
  const entries: LogDraft[] = [];
  const records: LogRecordPort = { record: value => { entries.push(typeof value === "function" ? value() : value); } };
  return { records, entries };
}

it("real WAL work reports actual reads and queue time with the owning startup phase", async () => {
  const root = await createTempDir("authority-log-observation");
  const { records, entries } = collector();
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), { records });
  await observeLogPhase(records, "restore", async () => {
    await log.append([{ stream: "publish", body: { value: 1 } }]);
    await Promise.all([log.readSnapshot(), log.readSnapshot(), log.readSnapshot()]);
  });
  await log.stopStorageMaintenance();
  const summaries = entries.filter(item => item.event === "work");
  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries.every(item => item.refs?.some(ref => ref.kind === "authority") && item.refs?.some(ref => ref.kind === "phase"))).toBe(true);
  expect(summaries.reduce((sum, item) => sum + Number(item.data!.operations), 0)).toBeGreaterThanOrEqual(4);
  expect(summaries.every(item => Number(item.data!.readBytes) >= 0)).toBe(true);
  expect(summaries.some(item => item.data!.operation === "append")).toBe(true);
  const snapshots = summaries.filter(item => item.data!.operation === "readSnapshot");
  expect(snapshots.reduce((sum, item) => sum + Number(item.data!.operations), 0)).toBe(3);
  // Reuse avoids repeated decoding/recovery, not the current-byte checks.
  // Physical verification must remain visible in the work counters.
  expect(snapshots.reduce((sum, item) => sum + Number(item.data!.readBytes), 0)).toBeGreaterThan(0);
  expect(snapshots.reduce((sum, item) => sum + Number(item.data!.recoveries), 0)).toBeLessThanOrEqual(1);
  expect(summaries.every(item => Number(item.data!.queueMs) >= 0 && Number(item.data!.executionMs) >= 0)).toBe(true);
}, 20000);

it("reports a still-blocked dependency without fabricating a completion, and isolates a broken observer", async () => {
  vi.useFakeTimers();
  try {
    const { records, entries } = collector();
    const observer = new AuthorityWorkObserver(records, () => "authority-1");
    const work = observer.begin("readSnapshot"); work.stage("authority-file-lock");
    await vi.advanceTimersByTimeAsync(5000);
    expect(entries).toContainEqual(expect.objectContaining({ event: "waiting", data: expect.objectContaining({ waitFor: "authority-file-lock", durationMs: 5000 }) }));
    expect(entries.some(item => item.event === "work")).toBe(false);
    work.finish(Object.assign(new Error("private"), { code: "EACCES" })); observer.flush();
    expect(JSON.stringify(entries)).not.toContain("private");
    const broken = new AuthorityWorkObserver({ record() { throw Error("broken observer"); } }, () => undefined);
    const operation = broken.begin("append"); expect(() => { operation.finish(Error("business")); broken.flush(); }).not.toThrow();
    const brokenIdentity = new AuthorityWorkObserver(records, () => { throw Error("broken identity"); });
    const unknown = brokenIdentity.begin("append");
    expect(() => { unknown.finish(undefined); brokenIdentity.flush(); }).not.toThrow();
    const failed = observer.begin("append"); failed.stage("maintenance-retry"); failed.finish(undefined); observer.flush();
    expect(entries).toContainEqual(expect.objectContaining({ event: "failed", result: "failure", data: expect.objectContaining({ waitFor: "maintenance-retry", failure: { category: "non-error" } }) }));
  } finally { vi.useRealTimers(); }
});

it("a throwing observation port cannot change recovery or a durable append", async () => {
  const root = await createTempDir("authority-broken-observer");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
    records: { record() { throw Error("broken observer"); } },
  });
  try {
    await expect(log.append([{ stream: "publish", body: { value: 1 } }])).resolves.toMatchObject({ lsn: 1 });
    const snapshot = await log.readSnapshot();
    expect(snapshot.commits).toHaveLength(1);
  } finally { await log.stopStorageMaintenance(); }
}, 20000);
