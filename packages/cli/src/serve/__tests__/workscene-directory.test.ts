/**
 * WorksceneDirectory 持久层实现 —— 真实注册表 + 场景对话库(临时 home)锁
 * 与 server 契约的对齐:enter 的取 / 建语义与全域键形态、不存在的表达
 * (rename null / remove false / enter null)。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  ConversationRepository,
  FsWorkSceneRegistry,
  parseConversationId,
} from "@zhixing/core";
import { createWorksceneDirectory } from "../workscene-directory.js";

let originalHome: string | undefined;
let directory: ReturnType<typeof createWorksceneDirectory>;

beforeEach(async () => {
  const tmp = await createTempDir("workscene-dir");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmp;
  directory = createWorksceneDirectory({ registry: new FsWorkSceneRegistry() });
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = originalHome;
});

describe("workscene directory(持久层实现)", () => {
  it("create/list/rename/remove 全链;不存在的表达为 null/false", async () => {
    expect(await directory.rename("ghost", "x")).toBeNull();
    expect(await directory.remove("ghost")).toBe(false);

    const scene = await directory.create({ name: "评审场景" });
    expect((await directory.list()).map((s) => s.id)).toContain(scene.id);

    const renamed = await directory.rename(scene.id, "新场景名");
    expect(renamed?.name).toBe("新场景名");

    expect(await directory.remove(scene.id)).toBe(true);
    expect(await directory.get(scene.id)).toBeNull();
  });

  it("enterConversation:首次创建场景对话、再次进入复用同一对话;全域键可解析回场景", async () => {
    const scene = await directory.create({ name: "开发场景" });

    const first = await directory.enterConversation(scene.id);
    expect(first).not.toBeNull();
    const parsed = parseConversationId(first!.conversationId);
    expect(parsed.scope).toEqual({ kind: "workscene", sceneId: scene.id });

    // 场景库内确实建了对话
    const repo = new ConversationRepository({
      kind: "workscene",
      sceneId: scene.id,
    });
    expect((await repo.list()).map((c) => c.id)).toContain(parsed.localId);

    // 再次进入:复用"场景当前对话",不重复创建
    const second = await directory.enterConversation(scene.id);
    expect(second!.conversationId).toBe(first!.conversationId);
    expect(await repo.list()).toHaveLength(1);

    // 场景不存在 → null
    expect(await directory.enterConversation("ghost")).toBeNull();
  });

  it("enter 并发原子性:同一空场景并发进入只建一个对话(per-scene 串行)", async () => {
    const scene = await directory.create({ name: "并发场景" });

    const [a, b, c] = await Promise.all([
      directory.enterConversation(scene.id),
      directory.enterConversation(scene.id),
      directory.enterConversation(scene.id),
    ]);

    expect(a!.conversationId).toBe(b!.conversationId);
    expect(b!.conversationId).toBe(c!.conversationId);
    const repo = new ConversationRepository({
      kind: "workscene",
      sceneId: scene.id,
    });
    expect(await repo.list()).toHaveLength(1);
  });
});
