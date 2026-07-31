import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDirectory } from "@zhixing/server";
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
      directory: {} as ConversationDirectory,
      authority: () => ({
        async touchWorksceneSession() {
          order.push("activity");
          throw new Error("activity unavailable");
        },
        async deleteWorksceneSession() {
          throw new Error("not used");
        },
      }),
      runCleanupStep: (_resourceIdentity, operation) => operation(),
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
      directory: {} as ConversationDirectory,
      authority: () => ({
        async touchWorksceneSession(input) {
          order.push(`activity:${input.conversationId}:${input.requestId}`);
          return { revision: 2, at: input.at };
        },
        async deleteWorksceneSession() {
          throw new Error("not used");
        },
      }),
      runCleanupStep: (_resourceIdentity, operation) => operation(),
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

  it("keeps authority writes outside capacity permits and admits each physical leaf", async () => {
    const order: string[] = [];
    const directory = {
      remove: vi.fn(async (conversationId: string) => {
        order.push(`remove:${conversationId}`);
        return true;
      }),
    } as unknown as ConversationDirectory;
    const owner = new WorksceneSessionOwner({
      conversations: () => null,
      directory,
      authority: () => ({
        async touchWorksceneSession() {
          throw new Error("not used");
        },
        async deleteWorksceneSession(input) {
          order.push(`authority:${input.conversationId}`);
          return { revision: 2, at: input.at };
        },
      }),
      async runCleanupStep(resourceIdentity, operation) {
        order.push(`permit:${resourceIdentity}:acquire`);
        try {
          return await operation();
        } finally {
          order.push(`permit:${resourceIdentity}:release`);
        }
      },
    });

    await owner.removeScene("scene-a", ["ws:scene-a:primary"]);

    expect(order).toEqual([
      "authority:ws:scene-a:primary",
      "permit:conversation:ws:scene-a:primary:acquire",
      "remove:ws:scene-a:primary",
      "permit:conversation:ws:scene-a:primary:release",
      "permit:workscene:scene-a:acquire",
      "permit:workscene:scene-a:release",
    ]);
  });
});
