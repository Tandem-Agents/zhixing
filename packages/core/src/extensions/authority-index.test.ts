import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { createTempDir, captureFileIo } from "@zhixing/test-utils";
import { observeProjectionQueryWork } from "../test-support/projection-query-work.js";
import { FileAuthorityCommitLog } from "../authority/commit-log.js";
import { FileArtifactStore } from "../authority/artifact-store.js";
import { FileDurableProjectionIndex } from "../authority/durable-projection-index.js";
import { AuthorityCacheIntegrity } from "../authority/startup-proofs.js";
import { ExtensionApplication } from "./application.js";
import { extensionIndex, readExtensionSnapshot, readExtensionState, latestExtensionOperation, extensionWorkPage } from "./authority-index.js";

const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => {
  await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance()));
  vi.restoreAllMocks();
});
it("keeps completed operations exact without loading them into the candidate current-state index or pending page", async () => {
  const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 73));
  const root = await createTempDir("extension-history-growth");
  const open = () => {
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "facts")), { integrity });
    logs.push(log);
    return { log, index: extensionIndex(log), app: new ExtensionApplication({ log: () => log, assertOwner() {} }) };
  };
  const first = open();
  for (let n = 0; n < 24; n++) {
    await first.app.prepare("old-" + n, "item-" + n, { conversationId: "scene", request: "set up" });
    await first.app.cancel("old-" + n, 1);
    await first.app.notified("old-" + n, 2);
  }
  await first.log.stopStorageMaintenance();
  const next = open();
  const reads = vi.spyOn(FileDurableProjectionIndex.prototype, "scan");
  expect((await readExtensionSnapshot(next.index, false)).instances.size).toBe(0);
  expect((await extensionWorkPage(next.index)).operations).toEqual([]);
  expect((await readExtensionState(next.index, { operationId: "old-0" })).operations.get("old-0")?.phase).toBe("cancelled");
  expect((await latestExtensionOperation(next.index, "item-0"))?.id).toBe("old-0");
  expect(reads.mock.calls.some(([range]) => range.gte === "operation/")).toBe(false);
  const before = await next.log.checkpoint();
  expect((await next.app.prepare("old-0", "item-0", { conversationId: "scene", request: "set up" })).phase).toBe("cancelled");
  expect((await next.log.checkpoint()).lsn).toBe(before.lsn);
  expect((await next.app.list()).operations).toHaveLength(24);
}, 30_000);

it('keeps current extension discovery and exact replay fixed across 8/32/128 completed operations', async () => {
  const rows = [];
  for (const history of [8, 32, 128]) {
    const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 103)), root = await createTempDir('extension-query-growth');
    const open = () => {
      const log = new FileAuthorityCommitLog(path.join(root, 'authority'), new FileArtifactStore(path.join(root, 'facts')), { integrity });
      logs.push(log); extensionIndex(log);
      return { log, app: new ExtensionApplication({ log: () => log, assertOwner() {} }) };
    };
    const warm = open();
    for (let index = 0; index < history; index++) {
      await warm.app.prepare(`old-${index}`, `item-${index}`, { conversationId: 'scene', request: 'set up' });
      await warm.app.cancel(`old-${index}`, 1); await warm.app.notified(`old-${index}`, 2);
    }
    await warm.app.prepare('pending-current', 'current-item', { conversationId: 'scene', request: 'current setup' });
    const head = await warm.log.checkpoint(); await warm.log.stopStorageMaintenance();
    const io = await captureFileIo(root), cold = open(), work = observeProjectionQueryWork(cold.log);
    try {
      expect((await cold.app.current()).instances).toEqual([]);
      expect((await cold.app.workPage()).operations.map(item => item.id)).toEqual(['pending-current']);
      expect((await cold.app.operation('old-0'))?.phase).toBe('cancelled');
      expect((await cold.app.prepare('old-0', 'item-0', { conversationId: 'scene', request: 'set up' })).phase).toBe('cancelled');
      expect((await cold.log.checkpoint()).lsn).toBe(head.lsn);
      const query = io.snapshot(), materialized = work.snapshot(); work.restore();
      await cold.log.stopStorageMaintenance(); const stopped = io.snapshot();
      rows.push({ history, materialized, cold: { reads: query.reads, bytes: query.readBytes, writes: query.writeBytes,
        logBytes: query.byCategory.log?.readBytes ?? 0, probes: query.segmentEntryProbes },
        stop: { reads: stopped.readBytes - query.readBytes, writes: stopped.writeBytes - query.writeBytes } });
    } finally { work.restore(); }
  }
  console.log('C18 ' + JSON.stringify(rows));
  for (const row of rows.slice(1)) {
    expect({ ...row.materialized, valueBytes: 0 }).toEqual({ ...rows[0]!.materialized, valueBytes: 0 });
    expect(Math.abs(row.materialized.valueBytes - rows[0]!.materialized.valueBytes)).toBeLessThanOrEqual(1024);
  }
}, 180_000);
