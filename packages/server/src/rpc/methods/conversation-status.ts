import { isProtocolIdentifier } from "@zhixing/core/protocol";
import { RpcErrors, type MethodEntry } from "../handlers.js";

/** 单对话查询沿现有 session 路由选 Owner；游标是水位，不是 hasMore 标志。 */
export function parseConversationStatusRequest(raw: unknown): {
  conversationId: string;
  runId: string;
  afterStatusRevision: number;
}[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw RpcErrors.invalidParams("运行状态查询格式无效。");
  }
  const params = raw as Record<string, unknown>;
  if (!isProtocolIdentifier(params.conversationId) || !Array.isArray(params.cursors) ||
      params.cursors.length === 0 || params.cursors.length > 64 ||
      Object.keys(params).some(key => key !== "conversationId" && key !== "cursors")) {
    throw RpcErrors.invalidParams("运行状态查询需要对话标识及 1 至 64 个游标。");
  }
  const seen = new Set<string>();
  const conversationId = params.conversationId;
  return params.cursors.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw RpcErrors.invalidParams("运行状态游标无效。");
    }
    const cursor = value as Record<string, unknown>;
    if (!isProtocolIdentifier(cursor.runId) || typeof cursor.afterStatusRevision !== "number" ||
        !Number.isSafeInteger(cursor.afterStatusRevision) || cursor.afterStatusRevision < 0 ||
        Object.keys(cursor).some(key => key !== "runId" && key !== "afterStatusRevision") ||
        seen.has(cursor.runId)) {
      throw RpcErrors.invalidParams("运行状态游标无效或重复。");
    }
    seen.add(cursor.runId);
    return { conversationId, runId: cursor.runId, afterStatusRevision: cursor.afterStatusRevision };
  });
}

export function buildSessionStatusHistoryMethod(): MethodEntry {
  return {
    name: "session.statusHistory",
    requiresAuth: true,
    async handler(raw, ctx) {
      const requests = parseConversationStatusRequest(raw);
      const read = ctx.server.serverInfoRuntime?.conversationStatus;
      if (!read) throw RpcErrors.busy("对话运行状态暂不可读取，请稍后重试。");
      return read(requests);
    },
  };
}
