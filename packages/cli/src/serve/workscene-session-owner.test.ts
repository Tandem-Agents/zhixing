import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { WorksceneSessionOwner } from "./workscene-session-owner.js";

let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = await createTempDir("workscene-session-owner");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = previousHome;
});

describe("WorksceneSessionOwner cleanup", () => {
  it("claims the observer before activity and rolls it back when owner persistence fails", async () => {
    const order: string[] = [];
    const manager = {
      addObserver(conversationId: string, observerId: string) {
        order.push(`claim:${conversationId}:${observerId}`);
        return true;
      },
      removeObserver(conversationId: string, observerId: string) {
        order.push(`release:${conversationId}:${observerId}`);
      },
      async getOrCreate(conversationId: string) {
        order.push(`activate:${conversationId}`);
      },
    };
    const owner = new WorksceneSessionOwner({
      conversations: () => manager as never,
      conversationStorageProjectionCleanup: {} as never,
      authority: () => ({
        async touchWorksceneSession() {
          order.push("activity");
          throw new Error("activity unavailable");
        },
        async deleteWorksceneSession() {
          throw new Error("not used");
        },
      }),
      sceneStorageRemoval: unusedSceneStorageRemoval(),
    });

    await expect(
      owner.enter("scene-a", "surface-a", { requestId: "enter-a" }),
    ).rejects.toThrow("activity unavailable");
    expect(order).toEqual([
      "claim:ws:scene-a:primary:surface-a",
      "activity",
      "release:ws:scene-a:primary:surface-a",
    ]);
  });

  it("keeps observer release and exit activity under the same session owner", async () => {
    const order: string[] = [];
    const manager = {
      removeObserver(conversationId: string, observerId: string) {
        order.push(`release:${conversationId}:${observerId}`);
        return true;
      },
    };
    const owner = new WorksceneSessionOwner({
      conversations: () => manager as never,
      conversationStorageProjectionCleanup: {} as never,
      authority: () => ({
        async touchWorksceneSession(input) {
          order.push(`activity:${input.conversationId}:${input.requestId}`);
          return { revision: 2, at: input.at };
        },
        async deleteWorksceneSession() {
          throw new Error("not used");
        },
      }),
      sceneStorageRemoval: unusedSceneStorageRemoval(),
    });

    await owner.exit(
      "scene-a",
      "ws:scene-a:primary",
      "surface-a",
      "exit-a",
      "2026-07-31T00:00:00.000Z",
    );

    expect(order).toEqual([
      "release:ws:scene-a:primary:surface-a",
      "activity:ws:scene-a:primary:exit-a",
    ]);
  });

  it("keeps every authority write ahead of physical cleanup and scene storage last", async () => {
    const order: string[] = [];
    const conversationStorageProjectionCleanup = {
      removeCommittedProjection: vi.fn(async ({ conversationId }) => {
        order.push(`projection:${conversationId}`);
        return true;
      }),
    };
    const owner = new WorksceneSessionOwner({
      conversations: () => null,
      conversationStorageProjectionCleanup,
      authority: () => ({
        async touchWorksceneSession() {
          throw new Error("not used");
        },
        async deleteWorksceneSession(input) {
          order.push(`authority:${input.conversationId}`);
          return { revision: 2, at: input.at };
        },
      }),
      sceneStorageRemoval: {
        async removeScene(sceneId) {
          order.push(`cleanup:${sceneId}`);
        },
      },
    });

    await owner.removeScene("scene-a", [
      "ws:scene-a:first",
      "ws:scene-a:second",
    ]);

    expect(order).toEqual([
      "authority:ws:scene-a:first",
      "projection:ws:scene-a:first",
      "authority:ws:scene-a:second",
      "projection:ws:scene-a:second",
      "cleanup:scene-a",
    ]);
  });

  it("redrives a partial projection failure with stable authority identities", async () => {
    const order: string[] = [];
    let failSecond = true;
    const owner = new WorksceneSessionOwner({
      conversations: () => null,
      conversationStorageProjectionCleanup: {
        async removeCommittedProjection({ conversationId }) {
          order.push(`projection:${conversationId}`);
          if (failSecond && conversationId.endsWith(":second")) {
            failSecond = false;
            throw new Error("projection unavailable");
          }
        },
      },
      authority: () => ({
        async touchWorksceneSession() {
          throw new Error("not used");
        },
        async deleteWorksceneSession(input) {
          order.push(`authority:${input.requestId}`);
          return { revision: 2, at: input.at };
        },
      }),
      sceneStorageRemoval: {
        async removeScene(sceneId) {
          order.push(`scene:${sceneId}`);
        },
      },
    });
    const conversations = ["ws:scene-a:first", "ws:scene-a:second"];

    await expect(owner.removeScene("scene-a", conversations)).rejects.toThrow(
      "projection unavailable",
    );
    expect(order).not.toContain("scene:scene-a");
    await owner.removeScene("scene-a", conversations);

    expect(order).toEqual([
      "authority:workscene-delete:scene-a:ws:scene-a:first",
      "projection:ws:scene-a:first",
      "authority:workscene-delete:scene-a:ws:scene-a:second",
      "projection:ws:scene-a:second",
      "authority:workscene-delete:scene-a:ws:scene-a:first",
      "projection:ws:scene-a:first",
      "authority:workscene-delete:scene-a:ws:scene-a:second",
      "projection:ws:scene-a:second",
      "scene:scene-a",
    ]);
  });

  it("rejects a cross-scene conversation before authority or projection effects", async () => {
    const deleteWorksceneSession = vi.fn();
    const removeCommittedProjection = vi.fn();
    const removeScene = vi.fn();
    const owner = new WorksceneSessionOwner({
      conversations: () => null,
      conversationStorageProjectionCleanup: { removeCommittedProjection },
      authority: () => ({
        touchWorksceneSession: vi.fn(),
        deleteWorksceneSession,
      }),
      sceneStorageRemoval: {
        removeScene,
      },
    });

    await expect(owner.removeScene("scene-a", ["ws:scene-b:primary"]))
      .rejects.toMatchObject({ code: "WORKSCENE_INPUT" });
    expect(deleteWorksceneSession).not.toHaveBeenCalled();
    expect(removeCommittedProjection).not.toHaveBeenCalled();
    expect(removeScene).not.toHaveBeenCalled();
  });
});

function unusedSceneStorageRemoval() {
  return {
    async removeScene() {
      throw new Error("not used");
    },
  };
}
