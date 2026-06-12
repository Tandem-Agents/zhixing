/**
 * trust.* RPC 方法 —— 信任规则管理面(/trust 查看与撤销的执行体)。
 *
 * 操作对象是盘上持久规则(global / context 作用域);规则的沉淀走确认链路
 * (可信面 allow-session/context/global 决策经 broker 落 permissionStore),
 * 此处只承接管理面读与撤销。
 */

import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import type { TrustDirectory } from "../../runtime/management-directories.js";

function requireTrust(server: ServerContext): TrustDirectory {
  if (!server.trust) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "TrustDirectory not configured on server",
    );
  }
  return server.trust;
}

function optionalConversationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw RpcErrors.invalidParams(
      "'conversationId' must be a non-empty string when provided",
    );
  }
  return value;
}

export function buildTrustListMethod(): MethodEntry {
  return {
    name: "trust.list",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as { conversationId?: unknown };
      const rules = await requireTrust(ctx.server).list(
        optionalConversationId(params.conversationId),
      );
      return { rules };
    },
  };
}

export function buildTrustRevokeMethod(): MethodEntry {
  return {
    name: "trust.revoke",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as {
        ruleId?: string;
        conversationId?: unknown;
      };
      if (typeof params.ruleId !== "string" || params.ruleId.length === 0) {
        throw RpcErrors.invalidParams("trust.revoke requires 'ruleId'");
      }
      const revoked = await requireTrust(ctx.server).revoke(
        params.ruleId,
        optionalConversationId(params.conversationId),
      );
      if (!revoked) {
        throw RpcErrors.notFound(`Trust rule not found: ${params.ruleId}`);
      }
      return { revoked: true };
    },
  };
}
