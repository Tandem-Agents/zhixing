import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractFirstText,
  toSafePathSegment,
  worksceneConversationId,
} from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { createConversationStorageInfrastructure } from "../conversation-storage-infrastructure.js";
import { createWorksceneStorageCleanup } from "../workscene-storage-cleanup.js";

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
  it("routes user and Workscene through one finite runtime/directory contract", async () => {
    const storage = createConversationStorageInfrastructure({
      optimalMaxTokens: 20_000,
      worksceneStorageCleanup: createWorksceneStorageCleanup(),
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
      optimalMaxTokens: 20_000,
      worksceneStorageCleanup: createWorksceneStorageCleanup(),
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
