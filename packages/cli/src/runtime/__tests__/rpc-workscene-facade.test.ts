/**
 * RpcWorksceneFacade —— 方法 → RPC (method, params) 映射与返回还原。
 */

import { describe, it, expect } from "vitest";
import { RpcWorksceneFacade } from "../rpc-workscene-facade.js";
import { makeFakeHostLink } from "./fake-host-link.js";

const scene = {
  sceneId: "scene-1",
  name: "写作",
  workdir: "E:\\work\\writing",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
};

describe("RpcWorksceneFacade", () => {
  it("list 还原 scenes 数组", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder(() => ({ scenes: [scene] }));
    const facade = new RpcWorksceneFacade(fake.link);

    expect(await facade.list()).toEqual([scene]);
    expect(fake.requests[0]?.method).toBe("workscene.list");
  });

  it("create / rename 携带参数并返回场景摘要", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder(() => scene);
    const facade = new RpcWorksceneFacade(fake.link);

    expect(await facade.create("写作", "E:\\work\\writing")).toEqual(scene);
    expect(await facade.rename("scene-1", "写作二期")).toEqual(scene);
    expect(fake.requests).toEqual([
      {
        method: "workscene.create",
        params: { name: "写作", workdir: "E:\\work\\writing" },
      },
      {
        method: "workscene.rename",
        params: { sceneId: "scene-1", name: "写作二期" },
      },
    ]);
  });

  it("enter 返回场景当前对话的全域键,exit / delete 携带 sceneId", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder((method) =>
      method === "workscene.enter"
        ? { conversationId: "ws:scene-1:conv-3", scene }
        : {},
    );
    const facade = new RpcWorksceneFacade(fake.link);

    const entered = await facade.enter("scene-1");
    expect(entered.conversationId).toBe("ws:scene-1:conv-3");
    expect(entered.scene).toEqual(scene);

    await facade.exit("scene-1");
    await facade.delete("scene-1");

    expect(fake.requests.map((r) => [r.method, r.params])).toEqual([
      ["workscene.enter", { sceneId: "scene-1" }],
      ["workscene.exit", { sceneId: "scene-1" }],
      ["workscene.delete", { sceneId: "scene-1" }],
    ]);
  });
});
