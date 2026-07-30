import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AnchorWorksceneRegistry,
  FsWorkSceneRegistry,
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
    const legacy = new FsWorkSceneRegistry();
    const workspacePath = path.join(home, "user-workspace");
    const first = await legacy.add({ name: "Alpha", workdir: workspacePath });
    const second = await legacy.add({ name: "Beta", workdir: workspacePath });
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
      registry: fixture.registry,
      bindings: migration,
    });

    expect(migration.importLegacy).toHaveBeenCalledTimes(1);
    expect(migration.activateLegacy).toHaveBeenCalledTimes(1);
    expect(await fixture.registry.list()).toEqual(
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
      registry: fixture.registry,
      bindings: migration,
    });
    expect(migration.importLegacy).toHaveBeenCalledTimes(1);
    expect(migration.activateLegacy).toHaveBeenCalledTimes(1);
  });

  it("imports unprovable device ownership as an unbound workscene", async () => {
    const legacy = new FsWorkSceneRegistry();
    const scene = await legacy.add({
      name: "Portable",
      workdir: path.join(home, "unknown-device-workspace"),
    });
    const fixture = await createRegistry();

    await migrateLegacyWorkscenes({
      rootDir: path.join(home, "migration-without-device-owner"),
      deviceId: "device-a",
      registry: fixture.registry,
    });

    expect(await fixture.registry.get(scene.id)).toMatchObject({
      id: scene.id,
      name: scene.name,
    });
    expect(await fixture.registry.get(scene.id)).not.toHaveProperty("workspace");
  });
});

async function createRegistry() {
  const artifacts = new FileArtifactStore(path.join(home, "authority-artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(home, "authority-log"),
    artifacts,
  );
  return {
    registry: new AnchorWorksceneRegistry({ log }),
  };
}
