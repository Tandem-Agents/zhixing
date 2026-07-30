import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AnchorWorksceneGlobalStateAdapter,
  getWorkSceneDir,
  getWorkSceneIndexPath,
  type WorkScene,
} from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type {
  LocalWorkspaceBinding,
  WorkspaceBindingMigrationPort,
} from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyWorkscenes } from "../workscene-legacy-migration.js";

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  home = await createTempDir("workscene-legacy-migration");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = originalHome;
});

describe("workscene legacy migration", () => {
  it("groups the same path, activates atomically and resumes without leaking paths", async () => {
    const workspacePath = path.join(home, "user-workspace");
    const [first, second] = await seedLegacyScenes([
      { id: "alpha", name: "Alpha", workdir: workspacePath },
      { id: "beta", name: "Beta", workdir: workspacePath },
    ]);
    const fixture = await createRegistry();
    const binding: LocalWorkspaceBinding = {
      bindingRef: "binding-a",
      revision: 1,
      displayName: "Alpha",
      absolutePath: workspacePath,
      workspaceBindingRevision: 1,
    };
    const migration: WorkspaceBindingMigrationPort = {
      importLegacy: vi.fn(async () => binding),
      activateLegacy: vi.fn(async () => undefined),
      abandonLegacy: vi.fn(async () => undefined),
    };
    const rootDir = path.join(home, "migration");

    await migrateLegacyWorkscenes({
      rootDir,
      deviceId: "device-a",
      anchorEpoch: 1,
      globalState: fixture.globalState,
      bindings: migration,
    });

    expect(migration.importLegacy).toHaveBeenCalledTimes(1);
    expect(migration.activateLegacy).toHaveBeenCalledTimes(1);
    const listed = await fixture.globalState.read(
      { kind: "workscene-list" },
      readContext("list-imported"),
    );
    expect(listed.kind === "workscene-list" ? listed.scenes : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          workspace: { deviceId: "device-a", bindingRef: "binding-a" },
        }),
        expect.objectContaining({
          id: second.id,
          workspace: { deviceId: "device-a", bindingRef: "binding-a" },
        }),
      ]),
    );
    const report = await readFile(
      path.join(rootDir, "workscene-legacy-migration.json"),
      "utf8",
    );
    expect(report).not.toContain(workspacePath);
    expect(JSON.parse(report)).toMatchObject({
      status: "activated",
      scenes: [],
    });

    await migrateLegacyWorkscenes({
      rootDir,
      deviceId: "device-a",
      anchorEpoch: 1,
      globalState: fixture.globalState,
      bindings: migration,
    });
    expect(migration.importLegacy).toHaveBeenCalledTimes(1);
    expect(migration.activateLegacy).toHaveBeenCalledTimes(1);
  });

  it("imports unprovable device ownership as an unbound workscene", async () => {
    const [scene] = await seedLegacyScenes([{
      id: "portable",
      name: "Portable",
      workdir: path.join(home, "unknown-device-workspace"),
    }]);
    const fixture = await createRegistry();

    await migrateLegacyWorkscenes({
      rootDir: path.join(home, "migration-without-device-owner"),
      deviceId: "device-a",
      anchorEpoch: 1,
      globalState: fixture.globalState,
    });

    const imported = await fixture.globalState.read(
      { kind: "workscene-get", sceneId: scene.id },
      readContext("get-imported"),
    );
    expect(imported.kind === "workscene-get" ? imported.scene : null).toMatchObject({
      id: scene.id,
      name: scene.name,
    });
    expect(
      imported.kind === "workscene-get" ? imported.scene : null,
    ).not.toHaveProperty("workspace");
  });

  it("holds the legacy write fence through source recheck and makes the old write surface read-only", async () => {
    await seedLegacyScenes([{ id: "legacy", name: "Legacy" }]);
    const fixture = await createRegistry();
    await migrateLegacyWorkscenes({
      rootDir: path.join(home, "migration-fenced"),
      deviceId: "device-a",
      anchorEpoch: 1,
      globalState: fixture.globalState,
    });
    const { FsWorkSceneRegistry } = await import(
      "../../../../core/src/workscene/registry.js"
    );
    const legacy = new FsWorkSceneRegistry();
    await expect(legacy.add({ name: "Late writer" })).rejects.toMatchObject({
      code: "WORKSCENE_LEGACY_READ_ONLY",
    });
  });
});

async function seedLegacyScenes(
  inputs: readonly Array<{ id: string; name: string; workdir?: string }>,
): Promise<WorkScene[]> {
  const now = "2026-07-30T00:00:00.000Z";
  const scenes = inputs.map((input) => ({
    ...input,
    createdAt: now,
    lastActiveAt: now,
  }));
  await mkdir(path.dirname(getWorkSceneIndexPath()), { recursive: true });
  await writeFile(
    getWorkSceneIndexPath(),
    JSON.stringify({ scenes: scenes.map(({ id }) => id) }, null, 2),
  );
  for (const scene of scenes) {
    await mkdir(getWorkSceneDir(scene.id), { recursive: true });
    await writeFile(
      path.join(getWorkSceneDir(scene.id), "meta.json"),
      JSON.stringify(scene, null, 2),
    );
  }
  return scenes;
}

async function createRegistry() {
  const artifacts = new FileArtifactStore(path.join(home, "authority-artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(home, "authority-log"),
    artifacts,
  );
  return {
    globalState: new AnchorWorksceneGlobalStateAdapter({
      log,
      anchorEpoch: 1,
      removeScene: async () => {},
    }),
  };
}

function readContext(requestId: string) {
  return {
    principal: { kind: "host" as const, component: "migration-test" },
    requestId,
    authority: { domain: "global" as const, anchorEpoch: 1 },
    deadlineAt: "2099-01-01T00:00:00.000Z",
  };
}
