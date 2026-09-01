import {
  lstat,
  mkdir,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  StorageMaintenanceGovernorPort,
  StorageMaintenanceRequest,
} from "@zhixing/core/resources";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { createWorksceneStorageCleanupInfrastructure } from "./workscene-storage-cleanup.js";

describe("workscene storage cleanup owner", () => {
  it("removes a large tree through bounded admitted leaves", async () => {
    const root = await createTempDir("workscene-cleanup-pages");
    const scene = path.join(root, "workscenes", "scene-a");
    const cursorDirectory = path.join(root, "workscenes", ".cleanup");
    for (let index = 0; index < 70; index += 1) {
      const directory = path.join(scene, `branch-${index % 3}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `file-${index}.txt`), `${index}`);
    }
    const admitted: StorageMaintenanceRequest[] = [];
    const cleanup = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
      storageMaintenance: recordingGovernor(admitted),
    });

    await cleanup.scenes.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(admitted.length).toBeGreaterThan(70);
    expect(admitted.every((request) => request.kind === "workscene-cleanup"))
      .toBe(true);
    expect(await cursorFiles(cursorDirectory)).toEqual([]);
  });

  it("resumes from a durable page cursor after an admitted step fails", async () => {
    const root = await createTempDir("workscene-cleanup-resume");
    const scene = path.join(root, "workscenes", "scene-a");
    const cursorDirectory = path.join(root, "workscenes", ".cleanup");
    await createLargeTree(scene);
    const interrupted = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
      storageMaintenance: failingGovernor(67, "injected page interruption"),
    });

    await expect(interrupted.scenes.removeScene("scene-a")).rejects.toThrow(
      "injected page interruption",
    );
    expect(await cursorFiles(cursorDirectory)).not.toEqual([]);

    const resumed = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
    });
    await resumed.scenes.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cursorFiles(cursorDirectory)).toEqual([]);
  });

  it("rebuilds a corrupt derived cursor without weakening authoritative deletion", async () => {
    const root = await createTempDir("workscene-cleanup-corrupt-cursor");
    const scene = path.join(root, "workscenes", "scene-a");
    const cursorDirectory = path.join(root, "workscenes", ".cleanup");
    await createLargeTree(scene);
    const interrupted = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
      storageMaintenance: failingGovernor(67, "injected cursor interruption"),
    });
    await expect(interrupted.scenes.removeScene("scene-a")).rejects.toThrow(
      "injected cursor interruption",
    );
    const [cursorPath] = await cursorFiles(cursorDirectory);
    expect(cursorPath).toBeDefined();
    await writeFile(cursorPath!, "{not-json", "utf8");

    const resumed = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
    });
    await resumed.scenes.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cursorFiles(cursorDirectory)).toEqual([]);
  });

  it("retires an interrupted conversation cursor before scene deletion completes", async () => {
    const root = await createTempDir("workscene-cleanup-retire-cursor");
    const scene = path.join(root, "workscenes", "scene-a");
    const conversation = path.join(scene, "conversations", "primary");
    const cursorDirectory = path.join(root, "workscenes", ".cleanup");
    await createLargeTree(conversation);
    const interrupted = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
      storageMaintenance: failingGovernor(
        67,
        "injected conversation interruption",
      ),
    });

    await expect(
      interrupted.conversations.removeConversation("scene-a", "primary"),
    ).rejects.toThrow("injected conversation interruption");
    expect(await cursorFiles(cursorDirectory)).not.toEqual([]);

    const resumed = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
    });
    await resumed.scenes.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cursorFiles(cursorDirectory)).toEqual([]);
  });

  it("unlinks a nested symlink without traversing or deleting its target", async () => {
    const root = await createTempDir("workscene-cleanup-symlink");
    const scene = path.join(root, "workscenes", "scene-a");
    const external = path.join(root, "user-workspace");
    await mkdir(scene, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "keep.txt"), "keep");
    await symlink(
      external,
      path.join(scene, "workspace-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const cleanup = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
    });

    await cleanup.scenes.removeScene("scene-a");

    expect(await lstat(path.join(external, "keep.txt"))).toBeDefined();
    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes legacy scene-local data only with the authorized scene", async () => {
    const root = await createTempDir("workscene-cleanup-legacy-scene-data");
    const scene = path.join(root, "workscenes", "scene-a");
    const otherScene = path.join(root, "workscenes", "scene-b");
    const personal = path.join(root, "me");
    await mkdir(path.join(scene, "me"), { recursive: true });
    await mkdir(otherScene, { recursive: true });
    await mkdir(personal, { recursive: true });
    await writeFile(path.join(scene, "me", "legacy.txt"), "delete");
    await writeFile(path.join(otherScene, "keep.txt"), "keep");
    await writeFile(path.join(personal, "keep.txt"), "keep");
    const cleanup = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
    });

    await cleanup.scenes.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lstat(path.join(otherScene, "keep.txt"))).toBeDefined();
    expect(await lstat(path.join(personal, "keep.txt"))).toBeDefined();
  });

  it("serializes conversation and scene cleanup under one scene owner", async () => {
    const root = await createTempDir("workscene-cleanup-owner");
    const scene = path.join(root, "workscenes", "scene-a");
    const conversation = path.join(scene, "conversations", "primary");
    await mkdir(conversation, { recursive: true });
    await writeFile(path.join(conversation, "meta.json"), "{}");
    const cleanup = createWorksceneStorageCleanupInfrastructure({
      zhixingHome: root,
    });

    await Promise.all([
      cleanup.conversations.removeConversation("scene-a", "primary"),
      cleanup.scenes.removeScene("scene-a"),
    ]);

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createLargeTree(root: string): Promise<void> {
  for (let index = 0; index < 70; index += 1) {
    const directory = path.join(root, `branch-${index % 3}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `file-${index}.txt`), `${index}`);
  }
}

function recordingGovernor(
  requests: StorageMaintenanceRequest[],
): StorageMaintenanceGovernorPort {
  return governor((request) => requests.push(request));
}

function failingGovernor(
  failAt: number,
  message: string,
): StorageMaintenanceGovernorPort {
  let count = 0;
  return governor(() => {
    count += 1;
    if (count === failAt) throw new Error(message);
  });
}

function governor(
  onAcquire: (request: StorageMaintenanceRequest) => void,
): StorageMaintenanceGovernorPort {
  return {
    async acquire(request) {
      onAcquire(request);
      return {
        kind: "granted",
        permit: {
          granted: request.atomic,
          tryBegin: () => ({ claim() {}, complete() {} }),
          release() {},
        },
      };
    },
    snapshot: () => ({}) as never,
  };
}

async function cursorFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await visit(root);
  return files.sort();
}
