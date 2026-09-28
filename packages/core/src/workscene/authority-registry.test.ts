import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileDurableProjectionIndex,
} from "../authority/index.js";
import {
  AnchorWorksceneRegistry,
  WorksceneConflictError,
  WorksceneRevisionError,
} from "./authority-registry.js";

const NOW = "2026-07-30T00:00:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;
describe("AnchorWorksceneRegistry", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("advances past unrelated commits without reading workscene state and retains mixed commits", async () => {
    const { log, registry } = await createRegistry();
    const reads = vi.spyOn(FileDurableProjectionIndex.prototype, "get");
    try {
      await log.append([{ stream: "intent:unrelated", body: { t: "unrelated" } }]);
      expect(reads.mock.contexts.filter((index) =>
        index.projectionId === "global-workscene-authority-v1"
      )).toHaveLength(0);
      await log.append([
        { stream: "intent:unrelated", body: { t: "unrelated" } },
        { stream: "intent:workscene-registry", body: { t: "workscene-registry-established", at: NOW } },
      ]);
      await registry.initialize();
      expect(await registry.get("missing")).toBeNull();
      const index = log.durableProjection({
        projectionId: "global-workscene-authority-v1", reducerVersion: 1, reduce: () => [],
      });
      expect((await index.checkpoints()).authority?.lsn).toBe(2);
    } finally {
      reads.mockRestore();
      await log.stopStorageMaintenance();
    }
  });

  it("linearizes CRUD, exact replay, CAS and tombstones", async () => {
    const fixture = await createRegistry();
    const created = await fixture.registry.apply(
      {
        kind: "workscene-create",
        name: "Project",
        workspace: { deviceId: "device-a", bindingRef: "workspace-a" },
      },
      { requestId: "create-1" },
    );
    expect(created).toMatchObject({
      kind: "workscene-applied",
      revision: 1,
      scene: { id: "project-a", revision: 1, name: "Project" },
    });
    await expect(
      fixture.registry.apply(
        {
          kind: "workscene-create",
          name: "Project",
          workspace: { deviceId: "device-a", bindingRef: "workspace-a" },
        },
        { requestId: "create-1" },
      ),
    ).resolves.toEqual(created);
    await expect(
      fixture.registry.apply(
        { kind: "workscene-create", name: "Other" },
        { requestId: "create-1" },
      ),
    ).rejects.toBeInstanceOf(WorksceneConflictError);

    expect(await fixture.registry.get("project-a")).toMatchObject({
      revision: 1,
      lastActiveAt: NOW,
    });
    await expect(
      fixture.registry.apply(
        {
          kind: "workscene-rename",
          sceneId: "project-a",
          name: "Renamed",
          expectedRevision: 2,
        },
        { requestId: "rename-stale" },
      ),
    ).rejects.toBeInstanceOf(WorksceneRevisionError);

    const removed = await fixture.registry.apply(
      {
        kind: "workscene-delete",
        sceneId: "project-a",
        expectedRevision: 1,
      },
      { requestId: "delete-1" },
    );
    expect(removed).toMatchObject({
      kind: "workscene-deleted",
      revision: 2,
      previousObjectRevision: 1,
    });
    expect(await fixture.registry.get("project-a")).toBeNull();
    expect(await fixture.registry.replay("delete-1")).toEqual(removed);
    expect((await fixture.registry.pendingDeletionPage()).items).toEqual([
      {
        sceneId: "project-a",
        deletionRevision: 2,
        previousObjectRevision: 1,
      },
    ]);

    const restarted = new AnchorWorksceneRegistry({
      log: fixture.log,
      clock: () => NOW,
    });
    expect((await restarted.pendingDeletionPage()).items).toEqual([
      {
        sceneId: "project-a",
        deletionRevision: 2,
        previousObjectRevision: 1,
      },
    ]);
    await restarted.confirmDeletionProjected("project-a", 2);
    await restarted.confirmDeletionProjected("project-a", 2);
    expect((await restarted.pendingDeletionPage()).items).toEqual([]);
    expect(
      await new AnchorWorksceneRegistry({
        log: fixture.log,
        clock: () => NOW,
      }).pendingDeletionPage(),
    ).toEqual({ items: [] });
  });

});

async function createRegistry() {
  const root = await createTempDir("zhixing-workscene-authority");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  });
  return {
    log,
    registry: new AnchorWorksceneRegistry({
      log,
      clock: () => NOW,
      sceneIdFactory: () => "project-a",
    }),
  };
}
