import { describe, expect, it, vi } from "vitest";
import {
  RPC_ERROR_CODES,
  RpcClientError,
  type RpcClient,
} from "@zhixing/server";
import { RpcManagementFacade } from "../rpc-management-facade.js";
import type { CoreHostRpcLink } from "../core-host-connection.js";
import { buildServerShutdownMethod } from "../../../../server/src/rpc/methods/server.js";
import { serverShutdownRequest } from "../server-shutdown-request.js";

function linkWithRequest(
  request: RpcClient["request"],
): CoreHostRpcLink {
  return {
    getClient: async () => ({ request }) as RpcClient,
    onNotification: () => () => {},
  };
}

describe("RpcManagementFacade", () => {
  it.each([undefined, "test-stop", { reason: "config-reload", strategy: "drain" as const }, { reason: "user-stop", strategy: "cancel" as const, timeoutMs: 30_000 }])("sends a durable stop accepted by the actual server contract: %j", async input => {
    const target = { pid: 123, startedAt: "2026-09-24T10:00:00.000Z" };
    const prepare = vi.fn(async params => ({ ...params, phase: "ready-to-stop" }));
    const request = vi.fn(async (method, params) => method === "server.info" ? target :
      buildServerShutdownMethod().handler(JSON.parse(JSON.stringify(params)), {
        connection: { loopback: true }, server: { lifecycleShutdown: { prepare }, requestShutdown: vi.fn() },
      } as never));
    const facade = new RpcManagementFacade(linkWithRequest(request as RpcClient["request"]));
    await facade.serverShutdown(input);
    await facade.serverShutdown(input);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]![0]).toEqual(prepare.mock.calls[1]![0]);
    expect(prepare.mock.calls[0]![0].requestId).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("retains stop identity on retry, while separating Host incarnations and intents", async () => {
    let target = { pid: 123, startedAt: "2026-09-24T10:00:00.000Z" };
    const stop = vi.fn().mockRejectedValueOnce(Error("transport failed")).mockResolvedValue({ accepted: true });
    const request = vi.fn(async (method, params) => method === "server.info" ? target : stop(params));
    const facade = new RpcManagementFacade(linkWithRequest(request as RpcClient["request"]));
    await expect(facade.serverShutdown("retry")).rejects.toThrow("transport failed");
    await facade.serverShutdown("retry");
    expect(stop.mock.calls[0]![0]).toEqual(stop.mock.calls[1]![0]);
    target = { ...target, startedAt: "2026-09-24T10:01:00.000Z" };
    await facade.serverShutdown("retry");
    expect(stop.mock.calls[2]![0].requestId).not.toEqual(stop.mock.calls[0]![0].requestId);
    expect(serverShutdownRequest(target, { reason: "retry", strategy: "cancel" }).requestId).not.toEqual(stop.mock.calls[2]![0].requestId);
  });

  it("trustRevoke 将宿主 NOT_FOUND 映射为 false,保持 /trust 不存在语义", async () => {
    const request = vi.fn(async () => {
      throw new RpcClientError(
        RPC_ERROR_CODES.NOT_FOUND,
        "Trust rule not found: ghost",
      );
    }) as unknown as RpcClient["request"];
    const facade = new RpcManagementFacade(linkWithRequest(request));

    await expect(facade.trustRevoke("ghost", "conv-1")).resolves.toBe(false);
    expect(request).toHaveBeenCalledWith("trust.revoke", {
      ruleId: "ghost",
      conversationId: "conv-1",
    });
  });

  it("trustRevoke 只吞 NOT_FOUND,其他 RPC 错误继续上抛", async () => {
    const request = vi.fn(async () => {
      throw new RpcClientError(
        RPC_ERROR_CODES.INTERNAL_ERROR,
        "Trust Administration application not configured",
      );
    }) as unknown as RpcClient["request"];
    const facade = new RpcManagementFacade(linkWithRequest(request));

    await expect(facade.trustRevoke("rule-a")).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
    });
  });
});
