import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { toSafePathSegment } from "@zhixing/core";
import { createConversationStorageInfrastructure } from "../conversation-storage-infrastructure.js";
import { createWorksceneStorageCleanup } from "../workscene-storage-cleanup.js";

let oldHome: string | undefined;
let home: string;

beforeEach(async () => {
  oldHome = process.env.ZHIXING_HOME;
  home = await createTempDir("advancement-gc-home");
  process.env.ZHIXING_HOME = home;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = oldHome;
});

describe("conversation storage maintenance", () => {
  it("user 对话按目录段还原判活", async () => {
    await fs.mkdir(path.join(home, "conversations", "chat-1"), {
      recursive: true,
    });
    const isAlive = createAliveCheck();

    expect(await isAlive(toSafePathSegment("chat-1"))).toBe(true);
    expect(await isAlive(toSafePathSegment("chat-gone"))).toBe(false);
  });

  it("workscene 对话的全域键目录段正确判活——不与对话侧短 id 目录名比对", async () => {
    // 对话侧落盘：workscenes/<sceneId>/conversations/<localId>
    await fs.mkdir(
      path.join(home, "workscenes", "scene-a", "conversations", "chat-9"),
      { recursive: true },
    );
    const isAlive = createAliveCheck();

    // 控制日志目录名是全域键的安全投影（含冒号，编码为 zid-*）
    const advancementDirName = toSafePathSegment("ws:scene-a:chat-9");
    expect(advancementDirName.startsWith("zid-")).toBe(true);
    expect(await isAlive(advancementDirName)).toBe(true);
    expect(await isAlive(toSafePathSegment("ws:scene-a:chat-gone"))).toBe(false);
    expect(await isAlive(toSafePathSegment("ws:scene-x:chat-9"))).toBe(false);
  });
});

function createAliveCheck(): (directoryName: string) => Promise<boolean> {
  return createConversationStorageInfrastructure({
    optimalMaxTokens: 20_000,
    worksceneStorageCleanup: createWorksceneStorageCleanup(),
  }).maintenance.isConversationDataAlive;
}
