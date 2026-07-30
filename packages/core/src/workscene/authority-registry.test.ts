import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "../authority/index.js";
import {
  AnchorWorksceneRegistry,
  WorksceneConflictError,
  WorksceneRevisionError,
  worksceneImportSetDigest,
} from "./authority-registry.js";

const NOW = "2026-07-30T00:00:00.000Z";
describe("AnchorWorksceneRegistry", () => {
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

  it("keeps legacy imports invisible until an exact atomic activation", async () => {
    const fixture = await createRegistry();
    const scene = {
      id: "legacy-a",
      revision: 1,
      name: "Legacy",
      workspace: { deviceId: "device-a", bindingRef: "workspace-a" },
      createdAt: NOW,
      lastActiveAt: NOW,
    };
    await fixture.registry.applyMigration(
      {
        kind: "workscene-import-legacy",
        migrationId: "migration-a",
        sourceSnapshotToken: "snapshot-a",
        scene,
      },
      { requestId: "import-a" },
    );
    expect(await fixture.registry.get(scene.id)).toBeNull();
    await expect(
      fixture.registry.applyMigration(
        {
          kind: "workscene-activate-device-registry",
          migrationId: "migration-a",
          sourceSnapshotToken: "snapshot-a",
          importSetDigest: worksceneImportSetDigest([]),
        },
        { requestId: "activate-wrong" },
      ),
    ).rejects.toBeInstanceOf(WorksceneConflictError);
    await fixture.registry.applyMigration(
      {
        kind: "workscene-activate-device-registry",
        migrationId: "migration-a",
        sourceSnapshotToken: "snapshot-a",
        importSetDigest: worksceneImportSetDigest([scene]),
      },
      { requestId: "activate-a" },
    );
    expect(await fixture.registry.get(scene.id)).toMatchObject({
      id: scene.id,
      name: scene.name,
      revision: 1,
    });

    const restarted = new AnchorWorksceneRegistry({
      log: fixture.log,
      clock: () => NOW,
    });
    expect(await restarted.get(scene.id)).toEqual(
      await fixture.registry.get(scene.id),
    );
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
