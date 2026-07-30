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
