import { describe, expect, it, vi } from "vitest";
import {
  RPC_ERROR_CODES,
  RpcClientError,
  type RpcClient,
} from "@zhixing/server";
import { RpcManagementFacade } from "../rpc-management-facade.js";
import type { CoreHostLink } from "../core-host-connection.js";

function linkWithRequest(
  request: RpcClient["request"],
): CoreHostLink {
  return {
    getClient: async () => ({ request }) as RpcClient,
    onNotification: () => () => {},
  };
}

describe("RpcManagementFacade", () => {
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
        "TrustDirectory not configured",
      );
    }) as unknown as RpcClient["request"];
    const facade = new RpcManagementFacade(linkWithRequest(request));

    await expect(facade.trustRevoke("rule-a")).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
    });
  });
});
