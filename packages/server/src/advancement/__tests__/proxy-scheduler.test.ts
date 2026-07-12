/**
 * ProxyMessageScheduler —— 推进代理消息投递调度。
 */

import { describe, expect, it } from "vitest";
import { WorksceneBusyError } from "@zhixing/owner-kernel";
import { ProxyMessageScheduler } from "@zhixing/owner-services";
import { createAdvancementProxyTurnPort } from "../adapters.js";

describe("ProxyMessageScheduler", () => {
  it("admitTurn 撞工作场景静默闸时返回 busy 状态", async () => {
    const scheduler = new ProxyMessageScheduler({
      proxyTurns: createAdvancementProxyTurnPort({
        manager: {
          admitTurn: async () => {
            throw new WorksceneBusyError("quiescing");
          },
        } as never,
      }),
    });

    await expect(
      scheduler.schedule({
        session: { conversationId: "ws:scene-1:conv-main" } as never,
        proxyMessage: { id: "proxy-1", content: "继续" } as never,
      }),
    ).resolves.toEqual({ status: "busy" });
  });
});
