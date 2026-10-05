import { isProtocolIdentifier } from "@zhixing/core/protocol";
import type { ConversationRecoveryRequest } from '@zhixing/core/contracts';
import { RpcErrors, type MethodEntry } from "../handlers.js";

export function parseConversationRecoveryRequest(raw: unknown): ConversationRecoveryRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('mode' in raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const fail = (): never => { throw RpcErrors.invalidParams('对话恢复分页游标无效。'); };
  const object = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail();
    return item as Record<string, unknown>;
  };
  const integer = (item: unknown): boolean => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  const keys = (item: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(item).every(key => allowed.includes(key));
  const checkpoint = (item: unknown): void => {
    const point = object(item);
    if (!keys(point, ['logId', 'lsn', 'frameEndOffset', 'prefixDigest']) || !isProtocolIdentifier(point.logId) ||
        !integer(point.lsn) || !integer(point.frameEndOffset) || typeof point.prefixDigest !== 'string' || point.prefixDigest.length > 128) fail();
  };
  if (!['control-page', 'input-page'].includes(value.mode as string) || !isProtocolIdentifier(value.conversationId) ||
      !keys(value, value.mode === 'input-page' ? ['mode', 'conversationId', 'runId', 'cursor'] : ['mode', 'conversationId', 'cursor', 'historyRunIds'])) fail();
  if (value.historyRunIds !== undefined && (!Array.isArray(value.historyRunIds) || value.historyRunIds.length > 4 ||
      value.historyRunIds.some(id => !isProtocolIdentifier(id)) || value.cursor !== undefined)) fail();
  if (value.mode === 'input-page' && !isProtocolIdentifier(value.runId)) fail();
  if (value.cursor !== undefined) {
    const cursor = object(value.cursor);
    const fields = value.mode === 'control-page' ? ['after', 'item', 'baseItem', 'historyThroughCommitRevision'] : ['runId', 'position', 'part', 'offset', 'contentOffset', 'inputKey', 'imported'];
    if (!keys(cursor, ['conversationId', 'ownerEpoch', 'clearedThroughLsn', 'clearId', 'baseId', 'upper', ...fields]) || cursor.conversationId !== value.conversationId ||
        !integer(cursor.ownerEpoch) || cursor.ownerEpoch === 0 || !integer(cursor.clearedThroughLsn)) fail();
    for (const key of ['clearId', 'baseId', 'inputKey']) if (cursor[key] !== undefined && !isProtocolIdentifier(cursor[key])) fail();
    if (cursor.imported !== undefined && cursor.imported !== true) fail();
    checkpoint(cursor.upper);
    if (value.mode === 'control-page') { checkpoint(cursor.after); if (!integer(cursor.item) || !integer(cursor.baseItem) || (cursor.historyThroughCommitRevision !== undefined && !integer(cursor.historyThroughCommitRevision))) fail(); }
    else if (cursor.runId !== value.runId || ['position', 'part', 'offset', 'contentOffset'].some(key => !integer(cursor[key]))) fail();
  }
  return value as unknown as ConversationRecoveryRequest;
}

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
      const recovery = parseConversationRecoveryRequest(raw);
      if (recovery) {
        const read = ctx.server.serverInfoRuntime?.conversationRecovery;
        if (!read) throw RpcErrors.busy('对话恢复记录暂不可读取，请稍后重试。');
        return read(recovery);
      }
      const requests = parseConversationStatusRequest(raw);
      const read = ctx.server.serverInfoRuntime?.conversationStatus;
      if (!read) throw RpcErrors.busy("对话运行状态暂不可读取，请稍后重试。");
      return read(requests);
    },
  };
}
