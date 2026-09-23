import {
  LOG_APPLY_POLICY,
  LOG_READ,
  LOG_SEARCH,
  LOG_STATUS,
  parseLogPolicyRequest,
  parseLogReadRequest,
  parseLogSearchRequest,
} from "@zhixing/core/logging/application";
import type { LogReadContext } from "@zhixing/core/logging";
import {
  LogRequestError,
  publicLogErrorMessage,
} from "@zhixing/core/logging/application";
import {
  RpcAppError,
  RpcErrors,
  type HandlerContext,
  type MethodEntry,
} from "../handlers.js";

function logContext(ctx: HandlerContext): () => LogReadContext {
  // Home-token possession is the current server's identity contract. Self-reported client ids confer no rights.
  const connection = ctx.connection;
  const generation = connection.surfaceGeneration;
  return () => {
    if (
      !connection.authenticated ||
      connection.closed ||
      connection.surfaceGeneration !== generation
    )
      throw RpcErrors.unauthorized("日志访问身份已失效，请重新连接");
    return {
      subject: `home-rpc:${connection.id}`,
      revision: `home-token:${generation ?? 0}`,
      manageStorage: true,
      managePolicy: connection.loopback,
      scopes: [],
    };
  };
}
export function buildLogMethods(): MethodEntry[] {
  return [LOG_SEARCH, LOG_READ, LOG_STATUS, LOG_APPLY_POLICY].map(
    (operation) => ({
      name: operation.identity,
      requiresAuth: true,
      async handler(params: unknown, ctx: HandlerContext) {
        try {
          const api = ctx.server.productApi;
          if (!api?.supports(operation))
            throw RpcErrors.invalidParams("本设备日志访问尚不可用");
          const context = logContext(ctx);
          context();
          if (operation === LOG_SEARCH)
            return await api.query(LOG_SEARCH, {
              context,
              request: parseLogSearchRequest(params),
            });
          if (operation === LOG_READ)
            return await api.query(LOG_READ, {
              context,
              request: parseLogReadRequest(params),
            });
          if (operation === LOG_STATUS) {
            if (
              params !== undefined &&
              params !== null &&
              (typeof params !== "object" ||
                Array.isArray(params) ||
                Object.keys(params).length)
            )
              throw RpcErrors.invalidParams("日志状态查询不接受参数");
            return await api.query(LOG_STATUS, { context, request: undefined });
          }
          return (
            await api.command(LOG_APPLY_POLICY, {
              context,
              request: parseLogPolicyRequest(params),
            })
          ).result;
        } catch (error) {
          if (error instanceof RpcAppError) throw error;
          const message = publicLogErrorMessage(error);
          throw error instanceof LogRequestError
            ? RpcErrors.invalidParams(message)
            : RpcErrors.internal(message);
        }
      },
    }),
  );
}
