/**
 * trust.* RPC 方法 —— 信任规则管理面(/trust 查看与撤销的执行体)。
 *
 * 操作对象是盘上持久规则(global / context 作用域)；规则创建与沉淀由
 * Trust Administration 应用消费确认决定，此处只绑定管理 Query/Command。
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

function optionalScopePage(value: unknown): { after?: string; limit?: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RpcErrors.invalidParams("'otherScopes' must be an object when provided");
  }
  const page = value as { after?: unknown; limit?: unknown };
  if (page.after !== undefined && (typeof page.after !== "string" || page.after.length === 0 || page.after.length > 512)) {
    throw RpcErrors.invalidParams("'otherScopes.after' must be a non-empty cursor");
  }
  if (page.limit !== undefined && (!Number.isSafeInteger(page.limit) || (page.limit as number) < 1)) {
    throw RpcErrors.invalidParams("'otherScopes.limit' must be a positive integer");
  }
  return {
    ...(page.after !== undefined ? { after: page.after as string } : {}),
    ...(page.limit !== undefined ? { limit: page.limit as number } : {}),
  };
}

/** 撤销其他范围的规则时带上的范围（取自列表分组）；结构不对直接拒绝。 */
function optionalTrustContext(value: unknown):
  | { kind: "main" }
  | { kind: "scene"; sceneId: string }
  | { kind: "workspace"; hash: string }
  | undefined {
  if (value === undefined) return undefined;
  const context = value as { kind?: unknown; sceneId?: unknown; hash?: unknown } | null;
  if (context?.kind === "main") return { kind: "main" };
  if (context?.kind === "scene" && typeof context.sceneId === "string" && context.sceneId) {
    return { kind: "scene", sceneId: context.sceneId };
  }
  if (context?.kind === "workspace" && typeof context.hash === "string" && context.hash) {
    return { kind: "workspace", hash: context.hash };
  }
  throw RpcErrors.invalidParams("'context' must be a Trust scope from the list result");
}

export function buildTrustListMethod(): MethodEntry {
  return {
    name: "trust.list",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as { conversationId?: unknown; otherScopes?: unknown };
      const otherScopes = optionalScopePage(params.otherScopes);
      const result = await requireTrust(ctx.server).query(
        TRUST_ADMINISTRATION_LIST_QUERY,
        {
          kind: "list",
          conversationId: optionalConversationId(params.conversationId),
          ...(otherScopes ? { otherScopes } : {}),
        },
      );
      return { rules: result.rules, ...(result.otherScopes ? { otherScopes: result.otherScopes } : {}) };
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
        context?: unknown;
      };
      if (typeof params.ruleId !== "string" || params.ruleId.length === 0) {
        throw RpcErrors.invalidParams("trust.revoke requires 'ruleId'");
      }
      const context = optionalTrustContext(params.context);
      try {
        const result = await requireTrust(ctx.server).command(
          TRUST_ADMINISTRATION_REVOKE_COMMAND,
          {
            kind: "revoke",
            ruleId: params.ruleId,
            conversationId: optionalConversationId(params.conversationId),
            ...(context ? { context } : {}),
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
