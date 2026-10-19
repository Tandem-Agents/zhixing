import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
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
