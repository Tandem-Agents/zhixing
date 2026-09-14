import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadOnlyConversationStorage } from "../conversation-storage-infrastructure.js";
import { extractFirstText } from "@zhixing/core";
import { toSafePathSegment } from "@zhixing/core/paths";
import { worksceneConversationId } from "@zhixing/core/conversation";
import { createTempDir } from "@zhixing/test-utils";
import { createConversationStorageInfrastructure } from "../conversation-storage-infrastructure.js";
import { createWorksceneStorageCleanupInfrastructure } from "../workscene-storage-cleanup.js";

let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = await createTempDir("conversation-storage");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = previousHome;
});

describe("conversation storage infrastructure", () => {
  it("keeps metadata, content, lazy scenes, naming and maintenance on the explicit home", async () => {
    const root = await createTempDir("storage-owner-root");
    const other = await createTempDir("storage-other-root");
    process.env.ZHIXING_HOME = other;
    const storage = createConversationStorageInfrastructure({
      zhixingHome: root, optimalMaxTokens: 20_000,
      worksceneConversationStorageRemoval: createWorksceneStorageCleanupInfrastructure({ zhixingHome: root }).conversations,
    });
    process.env.ZHIXING_HOME = await createTempDir("storage-later-root");
    const user = await storage.directory.create();
    const scene = worksceneConversationId("late-scene", "late-conversation");
    const tasks = { items: [{ id: "one", content: "retained", status: "pending" as const }] };
    for (const id of [user.conversationId, scene]) {
      await storage.directory.ensure(id);
      await storage.runtime.appendCommittedRun(id, run(id, 0));
      await storage.committedViews.persistTaskList(id, tasks);
      expect(await storage.taskLists.load(id)).toEqual(tasks);
      expect((await storage.runtime.loadHistory(id))?.turnCount).toBe(1);
      expect(await storage.maintenance.isConversationDataAlive(toSafePathSegment(id))).toBe(true);
    }
    await storage.runtime.writeSnapshot(user.conversationId, {
      coveredThroughRunIndex: 0, structuredSummary: { facts: "facts", state: "state", active: "active" },
      tokensBefore: 20, tokensAfter: 5,
    });
    expect(await fs.readdir(path.join(root, "conversations", toSafePathSegment(user.conversationId), "snapshots"))).toHaveLength(1);
    await storage.naming.rename(user.conversationId, "Owner root");
    expect((await storage.naming.get(user.conversationId))?.name).toBe("Owner root");
    await storage.maintenance.runRetentionSweep();
    const reader = createReadOnlyConversationStorage(root);
    expect((await reader.list()).some((entry) => entry.conversationId === user.conversationId)).toBe(true);
    expect((await reader.readHistory(user.conversationId, { limit: 1 })).runs).toHaveLength(1);
    await expect(fs.stat(path.join(other, "conversations"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(process.env.ZHIXING_HOME!, "workscenes"))).rejects.toMatchObject({ code: "ENOENT" });
    await storage.directory.deleteStoredConversation(scene);
    expect(await storage.maintenance.isConversationDataAlive(toSafePathSegment(scene))).toBe(false);
  });

  it("routes user and Workscene through one finite runtime/directory contract", async () => {
    const storage = createConversationStorageInfrastructure({
      zhixingHome: process.env.ZHIXING_HOME!,
      optimalMaxTokens: 20_000,
      worksceneConversationStorageRemoval:
        createWorksceneStorageCleanupInfrastructure({
          zhixingHome: process.env.ZHIXING_HOME!,
        }).conversations,
    });
    const user = await storage.directory.create();
    const workscene = worksceneConversationId("scene-storage", "conversation-1");
    await storage.directory.ensure(workscene);

    await storage.runtime.appendCommittedRun(user.conversationId, run("user", 0));
    await storage.runtime.appendCommittedRun(workscene, run("scene", 0));

    const userPage = await storage.directory.readHistory(user.conversationId, {
      limit: 1,
    });
    const scenePage = await storage.directory.readHistory(workscene, { limit: 1 });
    expect(extractFirstText(userPage.runs[0]!.record.messages[0]!)).toBe("user");
    expect(extractFirstText(scenePage.runs[0]!.record.messages[0]!)).toBe("scene");
    await expect(storage.runtime.loadHistory(user.conversationId)).resolves.toMatchObject({
      turnCount: 1,
    });
    await expect(storage.runtime.loadHistory(workscene)).resolves.toMatchObject({
      turnCount: 1,
    });
  });

  it("shares committed views, clear/delete, and maintenance routing without exposing stores", async () => {
    const storage = createConversationStorageInfrastructure({
      zhixingHome: process.env.ZHIXING_HOME!,
      optimalMaxTokens: 20_000,
      worksceneConversationStorageRemoval:
        createWorksceneStorageCleanupInfrastructure({
          zhixingHome: process.env.ZHIXING_HOME!,
        }).conversations,
    });
    const conversationId = worksceneConversationId("scene-storage", "conversation-2");
    await storage.directory.ensure(conversationId);
    await storage.runtime.appendCommittedRun(conversationId, run("before-clear", 0));

    const taskList = {
      items: [{ id: "task-1", content: "verify", status: "pending" as const }],
    };
    await storage.committedViews.persistTaskList(conversationId, taskList);
    await expect(storage.taskLists.load(conversationId)).resolves.toEqual(taskList);

    await expect(storage.directory.clearStoredView(conversationId)).resolves.toBe(true);
    await expect(storage.taskLists.load(conversationId)).resolves.toBeUndefined();
    await expect(storage.directory.readHistory(conversationId, { limit: 1 })).resolves.toEqual({
      runs: [],
      hasMore: false,
    });

    const encoded = toSafePathSegment(conversationId);
    await expect(storage.maintenance.isConversationDataAlive(encoded)).resolves.toBe(true);
    await expect(storage.directory.deleteStoredConversation(conversationId)).resolves.toBe(true);
    await expect(storage.maintenance.isConversationDataAlive(encoded)).resolves.toBe(false);
  });
});

function run(text: string, runIndex: number) {
  return {
    type: "run" as const,
    runId: `run-${runIndex}`,
    runIndex,
    timestamp: "2026-09-01T00:00:00.000Z",
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text }] },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `reply:${text}` }],
      },
    ],
  };
}
