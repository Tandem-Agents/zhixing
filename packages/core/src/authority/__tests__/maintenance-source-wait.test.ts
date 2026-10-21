import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { FileArtifactStore, FileAuthorityCommitLog, FileDurableProjectionIndex } from "../index.js";
import { SerialTaskQueue } from "../../persistence/serial-task-queue.js";
import { runDetachedMaintenanceContext, StorageMaintenanceCancelledError } from "../../resources/index.js";

it("queues detached checkpoint once behind its source owner and progresses before later work", async () => {
  const root = await createTempDir("source-maintenance-wait");
  const failures: unknown[] = [];
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")),
    { records: { record: (record: { event?: string }) => { if (record.event === "failed") failures.push(record); } } as never });
  let actual!: FileDurableProjectionIndex;
  let releaseSource: (() => void) | undefined;
  const initialize = FileDurableProjectionIndex.prototype.initialize;
  const spy = vi.spyOn(FileDurableProjectionIndex.prototype, "initialize").mockImplementation(function (...args) {
    if (this.projectionId === "source-wait") actual = this;
    return initialize.apply(this, args);
  });
  try {
    log.durableProjection({ projectionId: "source-wait", reducerVersion: 1, inputs: { streams: ["extensions"] },
      reduce: envelope => envelope.entries.map(record => ({ kind: "put", key: "current", value: record.body })) });
    await log.append([{ stream: "extensions", body: { n: 1 } }]);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    releaseSource = release.resolve;
    const owner = log.transactProjection(null, state => state, async () => {
      entered.resolve(); await release.promise; return { kind: "return", value: null };
    });
    await entered.promise;
    let settled = false;
    const background = runDetachedMaintenanceContext("background", () => actual.flushCheckpoint())
      .finally(() => { settled = true; });
    const observed = background.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    expect(failures).toEqual([]);
    const followers = Array.from({ length: 12 }, () => log.checkpoint());
    release.resolve(); await owner; expect(await observed).toBeUndefined(); await Promise.all(followers);
    expect(actual.publishedCheckpoints()).toEqual(actual.checkpoints());
  } finally { releaseSource?.(); spy.mockRestore(); await log.stopStorageMaintenance(); }
}, 15000);

it("initializes inside the source fence without joining a detached opener waiting on that fence", async () => {
  const root = await createTempDir("source-init-join");
  const queue = new SerialTaskQueue(), scope = new AsyncLocalStorage<boolean>();
  const requested = Promise.withResolvers<void>(), owned = Promise.withResolvers<void>();
  const checkpoint = { source: { logId: "init", lsn: 0, frameEndOffset: 64, prefixDigest: `sha256:${"0".repeat(64)}` as const } };
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: "init", reducerVersion: 1,
    withSourceLock: operation => scope.getStore() ? operation() : (requested.resolve(), queue.run(() => scope.run(true, operation))) });
  let completedInside = false;
  const owner = queue.run(() => scope.run(true, async () => {
    owned.resolve(); await requested.promise;
    completedInside = await Promise.race([index.initialize(checkpoint).then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 1000))]);
    if (completedInside) {
      index.publish(await index.prepare([{ kind: "put", key: "current", value: 1 }]), checkpoint);
      await index.flushCheckpoint();
    }
  }));
  await owned.promise;
  const background = index.initialize(checkpoint);
  try { await owner; await background; expect(completedInside).toBe(true); expect(await index.get("current")).toBe(1); }
  finally { await index.stopStorageMaintenance(); }
}, 10000);

it("cancels a queued source turn without running it or letting followers overtake the owner", async () => {
  const queue = new SerialTaskQueue(), release = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = queue.run(async () => { order.push("owner"); await release.promise; });
  const abort = new AbortController(), action = vi.fn(async () => { order.push("cancelled"); });
  const cancelled = queue.run(action, abort.signal);
  const failure = expect(cancelled).rejects.toBeInstanceOf(StorageMaintenanceCancelledError);
  const follower = queue.run(async () => { order.push("follower"); });
  abort.abort(new StorageMaintenanceCancelledError()); await failure;
  expect(action).not.toHaveBeenCalled(); expect(order).toEqual(["owner"]);
  release.resolve(); await first; await follower; expect(order).toEqual(["owner", "follower"]);
});

it("stops an index while its checkpoint waits for a busy source, without a late publication", async () => {
  const root = await createTempDir("source-stop-wait");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
  let actual!: FileDurableProjectionIndex;
  const initialize = FileDurableProjectionIndex.prototype.initialize;
  const capture = vi.spyOn(FileDurableProjectionIndex.prototype, "initialize").mockImplementation(function (...args) {
    if (this.projectionId === "stop-wait") actual = this;
    return initialize.apply(this, args);
  });
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>();
  const run = SerialTaskQueue.prototype.run;
  let watch = false;
  const queue = vi.spyOn(SerialTaskQueue.prototype, "run").mockImplementation(function (operation, signal) {
    if (watch && signal) queued.resolve();
    return run.call(this, operation, signal);
  });
  try {
    log.durableProjection({ projectionId: "stop-wait", reducerVersion: 1, inputs: { streams: ["extensions"] },
      reduce: envelope => envelope.entries.map(record => ({ kind: "put", key: "current", value: record.body })) });
    await log.append([{ stream: "extensions", body: { n: 1 } }]);
    const before = actual.publishedCheckpoints();
    const owner = log.transactProjection(null, state => state, async () => {
      entered.resolve(); await release.promise; return { kind: "return", value: null };
    });
    await entered.promise; watch = true;
    const background = runDetachedMaintenanceContext("background", () => actual.flushCheckpoint());
    const rejected = expect(background).rejects.toBeInstanceOf(StorageMaintenanceCancelledError);
    await queued.promise;
    const stopped = actual.stopStorageMaintenance();
    const timely = await Promise.race([stopped.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 1000))]);
    expect(timely).toBe(true); await rejected;
    release.resolve(); await owner;
    expect(actual.publishedCheckpoints()).toEqual(before);
  } finally { release.resolve(); queue.mockRestore(); capture.mockRestore(); await log.stopStorageMaintenance(); }
}, 10000);

it("finishes the required checkpoint inside the source fence instead of joining queued maintenance", async () => {
  const root = await createTempDir("source-inline-checkpoint");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
  let actual!: FileDurableProjectionIndex, watch = false, completedInside = false;
  const initialized = FileDurableProjectionIndex.prototype.initialize, queued = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const capture = vi.spyOn(FileDurableProjectionIndex.prototype, "initialize").mockImplementation(function (...args) {
    if (this.projectionId === "inline-checkpoint") actual = this;
    return initialized.apply(this, args);
  });
  const run = SerialTaskQueue.prototype.run;
  const queue = vi.spyOn(SerialTaskQueue.prototype, "run").mockImplementation(function (operation, signal) {
    if (watch && signal) queued.resolve();
    return run.call(this, operation, signal);
  });
  try {
    log.durableProjection({ projectionId: "inline-checkpoint", reducerVersion: 1, inputs: { streams: ["extensions"] },
      reduce: envelope => envelope.entries.map(record => ({ kind: "put", key: "current", value: record.body })) });
    await log.append([{ stream: "extensions", body: { n: 1 } }]);
    const owner = log.transactProjection(null, state => state, async () => {
      entered.resolve(); await queued.promise;
      completedInside = await Promise.race([actual.flushCheckpoint().then(() => true, () => false),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 1000))]);
      return { kind: "append", entries: [{ stream: "extensions", body: { n: 2 } }], value: null };
    });
    await entered.promise; watch = true;
    const background = runDetachedMaintenanceContext("background", () => actual.flushCheckpoint());
    await owner; await background;
    expect(completedInside).toBe(true);
    expect(await actual.get("current")).toEqual({ v: 1, key: "current", value: { n: 2 } });
  } finally { queued.resolve(); queue.mockRestore(); capture.mockRestore(); await log.stopStorageMaintenance(); }
}, 10000);
