/**
 * trust.* RPC 方法 —— 信任规则管理面(/trust 查看与撤销的执行体)。
 *
 * 操作对象是盘上持久规则(global / context 作用域);规则的沉淀走确认链路
 * (可信面 allow-session/context/global 决策经 broker 落 permissionStore),
 * 此处只承接管理面读与撤销。
 */

import {
  TRUST_ADMINISTRATION_LIST_QUERY,
  TRUST_ADMINISTRATION_REVOKE_COMMAND,
  TrustAdministrationApplicationError,
} from "@zhixing/core/trust-administration";
import type { ProductApiDispatcher } from "@zhixing/core/product-api";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";

function requireTrust(server: ServerContext): ProductApiDispatcher {
  if (
    !server.productApi ||
    !server.productApi.supports(TRUST_ADMINISTRATION_LIST_QUERY) ||
    !server.productApi.supports(TRUST_ADMINISTRATION_REVOKE_COMMAND)
  ) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Trust Administration application not configured on server",
    );
  }
  return server.productApi;
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
      const result = await requireTrust(ctx.server).query(
        TRUST_ADMINISTRATION_LIST_QUERY,
        {
          kind: "list",
          conversationId: optionalConversationId(params.conversationId),
        },
      );
      return { rules: result.rules };
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
      try {
        const result = await requireTrust(ctx.server).command(
          TRUST_ADMINISTRATION_REVOKE_COMMAND,
          {
            kind: "revoke",
            ruleId: params.ruleId,
            conversationId: optionalConversationId(params.conversationId),
          },
        );
        return { revoked: result.result.revoked };
      } catch (error) {
        if (
          error instanceof TrustAdministrationApplicationError &&
          error.code === "not-found"
        ) {
          throw RpcErrors.notFound(error.message);
        }
        throw error;
      }
    },
  };
}
