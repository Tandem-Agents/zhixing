/**
 * RpcWorksceneFacade —— 方法 → RPC (method, params) 映射与返回还原。
 */

import { describe, it, expect } from "vitest";
import { RpcWorksceneFacade } from "../rpc-workscene-facade.js";
import { makeFakeHostLink } from "./fake-host-link.js";

const scene = {
  sceneId: "scene-1",
  revision: 1,
  name: "写作",
  workspace: {
    deviceId: "device-local",
    bindingRef: "workspace-writing",
    deviceName: "本机",
    workspaceName: "写作",
  },
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

  it("create / rename / setWorkdir 携带参数并返回场景摘要", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder(() => scene);
    const facade = new RpcWorksceneFacade(fake.link);

    const workspace = {
      deviceId: "device-local",
      bindingRef: "workspace-writing",
    };
    expect(await facade.create("写作", workspace)).toEqual(scene);
    expect(await facade.rename("scene-1", "写作二期")).toEqual(scene);
    expect(await facade.setWorkdir("scene-1", null)).toEqual(scene);
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[0]).toMatchObject({
      method: "workscene.create",
      params: { name: "写作", workspace },
    });
    expect(fake.requests[1]).toMatchObject({
      method: "workscene.rename",
      params: { sceneId: "scene-1", name: "写作二期" },
    });
    expect(fake.requests[2]).toMatchObject({
      method: "workscene.setWorkdir",
      params: { sceneId: "scene-1", workspace: null },
    });
    for (const request of fake.requests) {
      expect(request.params).toMatchObject({ requestId: expect.any(String) });
    }
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

    await facade.exit("scene-1", "ws:scene-1:conv-3");
    await facade.delete("scene-1");

    expect(fake.requests.map((r) => [r.method, r.params])).toEqual([
      [
        "workscene.enter",
        { sceneId: "scene-1", requestId: expect.any(String) },
      ],
      [
        "workscene.exit",
        {
          sceneId: "scene-1",
          conversationId: "ws:scene-1:conv-3",
          requestId: expect.any(String),
        },
      ],
      [
        "workscene.delete",
        { sceneId: "scene-1", requestId: expect.any(String) },
      ],
    ]);
  });

});
