import {
  lstat,
  mkdir,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { createWorksceneStorageCleanup } from "./workscene-storage-cleanup.js";

describe("workscene storage cleanup owner", () => {
  it("removes a large tree through bounded admitted leaves", async () => {
    const root = await createTempDir("workscene-cleanup-pages");
    const scene = path.join(root, "scenes", "scene-a");
    const cursorDirectory = path.join(root, "cursors");
    for (let index = 0; index < 9; index += 1) {
      const directory = path.join(scene, `branch-${index % 3}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `file-${index}.txt`), `${index}`);
    }
    const admitted: string[] = [];
    const cleanup = createWorksceneStorageCleanup({
      pageSize: 2,
      sceneDirectory: () => scene,
      conversationDirectory: () => path.join(scene, "conversations", "unused"),
      cursorDirectory,
      async runCleanupStep(identity, operation) {
        admitted.push(identity);
        return operation();
      },
    });

    await cleanup.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(admitted.filter((identity) => identity.includes(":leaf")).length)
      .toBeGreaterThan(9);
    expect(admitted.some((identity) => identity.includes(":write"))).toBe(true);
  });

  it("resumes from a durable page cursor after an admitted step fails", async () => {
    const root = await createTempDir("workscene-cleanup-resume");
    const scene = path.join(root, "scenes", "scene-a");
    const cursorDirectory = path.join(root, "cursors");
    await mkdir(path.join(scene, "nested"), { recursive: true });
    await writeFile(path.join(scene, "nested", "a.txt"), "a");
    await writeFile(path.join(scene, "nested", "b.txt"), "b");
    let leaf = 0;
    const interrupted = createWorksceneStorageCleanup({
      pageSize: 1,
      sceneDirectory: () => scene,
      conversationDirectory: () => path.join(scene, "conversations", "unused"),
      cursorDirectory,
      async runCleanupStep(identity, operation) {
        if (identity.includes(":leaf") && ++leaf === 2) {
          throw new Error("injected page interruption");
        }
        return operation();
      },
    });

    await expect(interrupted.removeScene("scene-a")).rejects.toThrow(
      "injected page interruption",
    );
    expect(await readdir(cursorDirectory)).toHaveLength(1);

    const resumed = createWorksceneStorageCleanup({
      pageSize: 1,
      sceneDirectory: () => scene,
      conversationDirectory: () => path.join(scene, "conversations", "unused"),
      cursorDirectory,
      runCleanupStep: (_identity, operation) => operation(),
    });
    await resumed.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cursorFiles(cursorDirectory)).toEqual([]);
  });

  it("rebuilds a corrupt derived cursor without weakening authoritative deletion", async () => {
    const root = await createTempDir("workscene-cleanup-corrupt-cursor");
    const scene = path.join(root, "scenes", "scene-a");
    const cursorDirectory = path.join(root, "cursors");
    await mkdir(path.join(scene, "nested"), { recursive: true });
    await writeFile(path.join(scene, "nested", "a.txt"), "a");
    let leaf = 0;
    const interrupted = createWorksceneStorageCleanup({
      pageSize: 1,
      sceneDirectory: () => scene,
      conversationDirectory: () => path.join(scene, "conversations", "unused"),
      cursorDirectory,
      async runCleanupStep(identity, operation) {
        if (identity.includes(":leaf") && ++leaf === 2) {
          throw new Error("injected cursor interruption");
        }
        return operation();
      },
    });
    await expect(interrupted.removeScene("scene-a")).rejects.toThrow(
      "injected cursor interruption",
    );
    const [cursorPath] = await cursorFiles(cursorDirectory);
    expect(cursorPath).toBeDefined();
    await writeFile(cursorPath!, "{not-json", "utf8");

    const resumed = createWorksceneStorageCleanup({
      pageSize: 1,
      sceneDirectory: () => scene,
      conversationDirectory: () => path.join(scene, "conversations", "unused"),
      cursorDirectory,
      runCleanupStep: (_identity, operation) => operation(),
    });
    await resumed.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cursorFiles(cursorDirectory)).toEqual([]);
  });

  it("retires an interrupted conversation cursor before scene deletion completes", async () => {
    const root = await createTempDir("workscene-cleanup-retire-cursor");
    const scene = path.join(root, "scenes", "scene-a");
    const conversation = path.join(scene, "conversations", "primary");
    const cursorDirectory = path.join(root, "cursors");
    await mkdir(conversation, { recursive: true });
    await writeFile(path.join(conversation, "meta.json"), "{}");
    let leaf = 0;
    const interrupted = createWorksceneStorageCleanup({
      pageSize: 1,
      sceneDirectory: () => scene,
      conversationDirectory: () => conversation,
      cursorDirectory,
      async runCleanupStep(identity, operation) {
        if (identity.includes(":leaf") && ++leaf === 2) {
          throw new Error("injected conversation interruption");
        }
        return operation();
      },
    });

    await expect(
      interrupted.removeConversation("scene-a", "primary"),
    ).rejects.toThrow("injected conversation interruption");
    expect(await cursorFiles(cursorDirectory)).not.toEqual([]);

    const resumed = createWorksceneStorageCleanup({
      pageSize: 1,
      sceneDirectory: () => scene,
      conversationDirectory: () => conversation,
      cursorDirectory,
      runCleanupStep: (_identity, operation) => operation(),
    });
    await resumed.removeScene("scene-a");

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await cursorFiles(cursorDirectory)).toEqual([]);
  });

  it("unlinks a nested symlink without traversing or deleting its target", async () => {
    const root = await createTempDir("workscene-cleanup-symlink");
    const scene = path.join(root, "scenes", "scene-a");
    const external = path.join(root, "user-workspace");
    await mkdir(scene, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "keep.txt"), "keep");
    await symlink(
      external,
      path.join(scene, "workspace-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const cleanup = createWorksceneStorageCleanup({
      sceneDirectory: () => scene,
      conversationDirectory: () => path.join(scene, "conversations", "unused"),
      cursorDirectory: path.join(root, "cursors"),
      runCleanupStep: (_identity, operation) => operation(),
    });

    await cleanup.removeScene("scene-a");

    expect(await lstat(path.join(external, "keep.txt"))).toBeDefined();
    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes conversation and scene cleanup under one scene owner", async () => {
    const root = await createTempDir("workscene-cleanup-owner");
    const scene = path.join(root, "scenes", "scene-a");
    const conversation = path.join(scene, "conversations", "primary");
    await mkdir(conversation, { recursive: true });
    await writeFile(path.join(conversation, "meta.json"), "{}");
    const cleanup = createWorksceneStorageCleanup({
      pageSize: 1,
      sceneDirectory: () => scene,
      conversationDirectory: () => conversation,
      cursorDirectory: path.join(root, "cursors"),
      runCleanupStep: (_identity, operation) => operation(),
    });

    await Promise.all([
      cleanup.removeConversation("scene-a", "primary"),
      cleanup.removeScene("scene-a"),
    ]);

    await expect(lstat(scene)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

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
