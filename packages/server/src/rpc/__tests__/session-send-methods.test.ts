/**
 * session.send 方法薄层测试 —— 不起 WebSocket,只验证 handler 的错误映射。
 */

import { describe, expect, it } from "vitest";
import type { ServerContext } from "../../context.js";
import { WorksceneBusyError } from "../../runtime/conversation-manager.js";
import { buildSessionSendMethod } from "../methods/session.js";
import { RPC_ERROR_CODES } from "../protocol.js";

describe("session.send 方法", () => {
  it("admitTurn 撞工作场景静默闸时返回 BUSY", async () => {
    const method = buildSessionSendMethod();
    const ctx = {
      server: {
        conversations: {
          admitTurn: async () => {
            throw new WorksceneBusyError("quiescing");
          },
        },
      } as unknown as ServerContext,
      connection: { id: "conn-1" },
    } as never;

    await expect(
      method.handler(
        {
          text: "继续",
          conversationId: "ws:scene-1:conv-main",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.BUSY });
  });
});
