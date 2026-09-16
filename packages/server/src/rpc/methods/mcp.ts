import { RpcErrors, type MethodEntry } from "../handlers.js";
import { parseConversationId } from "@zhixing/core/conversation";
import { MCP_PENDING_QUERY } from "@zhixing/core/mcp-management";

/** Local authenticated configuration UI sees public candidates, never secrets or run internals. */
export function buildMcpPendingMethod(): MethodEntry {
  return {
    name: "mcp.pending",
    requiresAuth: true,
    async handler(params, ctx) {
      if (!ctx.connection.loopback)
        throw RpcErrors.invalidParams("MCP 凭据接入需在当前设备的安全管理入口完成");
      const input = params as { conversationId?: unknown } | undefined;
      if (
        !input ||
        Object.keys(input).join(",") !== "conversationId" ||
        typeof input.conversationId !== "string" ||
        !input.conversationId.trim() ||
        input.conversationId.length > 256
      )
        throw RpcErrors.invalidParams("需要当前对话标识");
      try {
        parseConversationId(input.conversationId);
      } catch {
        throw RpcErrors.invalidParams("对话标识无效");
      }
      if (!ctx.server.productApi?.supports(MCP_PENDING_QUERY))
        return [];
      return ctx.server.productApi.query(MCP_PENDING_QUERY, {
        conversationId: input.conversationId,
      });
    },
  };
}
