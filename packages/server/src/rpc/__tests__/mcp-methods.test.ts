import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import { createMcpManagementProductApiContribution, MCP_MANAGEMENT_PRODUCT_API_EXACT_SET } from "@zhixing/core/mcp-management";
import { buildMcpPendingMethod } from "../methods/mcp.js";

describe("MCP pending secure UI projection", () => {
  function fixture(loopback = true) {
    const pending = vi.fn(async () => []);
    const productApi = new ProductApiDispatcher(MCP_MANAGEMENT_PRODUCT_API_EXACT_SET, [createMcpManagementProductApiContribution(pending)]);
    const context = { connection: { loopback }, server: { productApi } } as never;
    return { pending, context, method: buildMcpPendingMethod() };
  }
  it("uses the sealed product query behind authenticated local transport", async () => {
    const { pending, context, method } = fixture();
    expect(method.requiresAuth).toBe(true);
    expect(await method.handler({ conversationId: "main-1" }, context)).toEqual([]);
    expect(pending).toHaveBeenCalledExactlyOnceWith("main-1");
  });
  it("does not expose candidates to a nonlocal configuration client", async () => {
    const { pending, context, method } = fixture(false);
    await expect(method.handler({ conversationId: "main-1" }, context)).rejects.toThrow();
    expect(pending).not.toHaveBeenCalled();
  });
  it("keeps local management available on a device without autonomous connection requests", async () => {
    const { method } = fixture();
    expect(await method.handler({ conversationId: "main-1" }, {
      connection: { loopback: true }, server: {},
    } as never)).toEqual([]);
  });
  it.each([{}, { conversationId: "" }, { conversationId: "main-1", credential: "fixture" }, []])("rejects invalid or secret-bearing requests", async (input) => {
    const { pending, context, method } = fixture();
    await expect(method.handler(input, context)).rejects.toThrow();
    expect(pending).not.toHaveBeenCalled();
  });
});
