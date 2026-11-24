import {
  estimateProgramSendWireBytes,
  PROGRAM_MAX_WAIT_SLICE_MS,
  PROGRAM_SINGLE_FRAME_MAX_BYTES,
  ProgramConversationError,
  type ProgramConversationApplication,
  type ProgramConversationScopeFilter,
} from "@zhixing-ai/core/conversation/application";
import { isProtocolIdentifier } from "@zhixing-ai/core/protocol";
import {
  RpcAppError,
  type HandlerContext,
  type MethodEntry,
} from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";

const VALID_SCOPES = new Set<ProgramConversationScopeFilter>([
  "all",
  "main",
  "workscene",
  "channel",
  "local",
]);

function requireLoopbackProgramApplication(
  ctx: HandlerContext,
): ProgramConversationApplication {
  if (!ctx.connection.loopback) {
    throw new RpcAppError(
      RPC_ERROR_CODES.UNAUTHORIZED,
      "conversation.program.* 仅接受本机回环连接",
      {
        programError: {
          code: "unauthorized",
          retryable: false,
          exitCode: 1,
        },
      },
    );
  }
  const app = ctx.server.programConversation;
  if (!app) {
    throw mapProgramConversationRpcError(
      new ProgramConversationError(
        "temporarily_unavailable",
        "当前宿主尚未装配外部对话协调端口",
        { retryable: true, exitCode: 3 },
      ),
    );
  }
  return app;
}

function requirePlainParams(
  raw: unknown,
  method: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw mapProgramConversationRpcError(
      new ProgramConversationError(
        "invalid_params",
        `${method} 参数必须是对象`,
        { retryable: false, exitCode: 1 },
      ),
    );
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw mapProgramConversationRpcError(
        new ProgramConversationError(
          "invalid_params",
          `${method} 不支持参数 '${key}'`,
          { retryable: false, exitCode: 1 },
        ),
      );
    }
  }
  return record;
}

export function mapProgramConversationRpcError(err: unknown): RpcAppError {
  if (err instanceof RpcAppError) return err;
  if (err instanceof ProgramConversationError) {
    const rpcCode =
      err.code === "unauthorized"
        ? RPC_ERROR_CODES.UNAUTHORIZED
        : err.code === "not_found" || err.code === "target_deleted"
          ? RPC_ERROR_CODES.NOT_FOUND
          : err.code === "temporarily_unavailable" ||
              err.code === "unknown" ||
              err.code === "uncertain" ||
              err.code === "cursor_expired" ||
              err.code === "queue_full" ||
              err.code === "host_draining"
            ? RPC_ERROR_CODES.BUSY
            : RPC_ERROR_CODES.INVALID_PARAMS;
    return new RpcAppError(rpcCode, err.message, {
      programError: {
        code: err.code,
        retryable: err.options?.retryable ?? false,
        ...(err.options?.exitCode !== undefined
          ? { exitCode: err.options.exitCode }
          : {}),
        ...(err.options?.details !== undefined
          ? { details: err.options.details }
          : {}),
      },
    });
  }
  return new RpcAppError(
    RPC_ERROR_CODES.INTERNAL_ERROR,
    err instanceof Error ? err.message : String(err),
  );
}

async function withConnectionSignal<T>(
  ctx: HandlerContext,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const off = ctx.connection.onClose(() => controller.abort());
  if (ctx.connection.closed) controller.abort();
  try {
    return await run(controller.signal);
  } catch (err) {
    throw mapProgramConversationRpcError(err);
  } finally {
    off();
  }
}

export function buildProgramConversationMethods(): MethodEntry[] {
  return [
    {
      name: "conversation.program.list",
      requiresAuth: true,
      async handler(rawParams, ctx) {
        const app = requireLoopbackProgramApplication(ctx);
        const params = requirePlainParams(
          rawParams,
          "conversation.program.list",
          ["query", "scope", "limit", "cursor"],
        );
        if (params.query !== undefined && typeof params.query !== "string") {
          throw mapProgramConversationRpcError(
            new ProgramConversationError("invalid_params", "query 必须是字符串", {
              retryable: false,
              exitCode: 1,
            }),
          );
        }
        if (
          params.scope !== undefined &&
          (typeof params.scope !== "string" ||
            !VALID_SCOPES.has(params.scope as ProgramConversationScopeFilter))
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError("invalid_params", "scope 取值无效", {
              retryable: false,
              exitCode: 1,
            }),
          );
        }
        if (
          params.limit !== undefined &&
          (typeof params.limit !== "number" ||
            !Number.isSafeInteger(params.limit) ||
            params.limit < 1 ||
            params.limit > 100)
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "limit 必须是 1 到 100 的整数",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (
          params.cursor !== undefined &&
          (typeof params.cursor !== "string" || !params.cursor.trim())
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError("invalid_cursor", "cursor 无效", {
              retryable: false,
              exitCode: 1,
            }),
          );
        }
        return withConnectionSignal(ctx, (signal) =>
          app.list(
            {
              ...(params.query !== undefined
                ? { query: params.query as string }
                : {}),
              ...(params.scope !== undefined
                ? { scope: params.scope as ProgramConversationScopeFilter }
                : {}),
              ...(params.limit !== undefined
                ? { limit: params.limit as number }
                : {}),
              ...(params.cursor !== undefined
                ? { cursor: params.cursor as string }
                : {}),
            },
            signal,
          ),
        );
      },
    },
    {
      name: "conversation.program.new",
      requiresAuth: true,
      async handler(rawParams, ctx) {
        const app = requireLoopbackProgramApplication(ctx);
        const params = requirePlainParams(
          rawParams,
          "conversation.program.new",
          ["requestId", "name", "sceneId"],
        );
        if (
          typeof params.requestId !== "string" ||
          !isProtocolIdentifier(params.requestId)
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "requestId 必须是非空合法标识",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (params.name !== undefined && params.sceneId !== undefined) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "--name 与 --scene 互斥，不能同时指定",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (
          params.name !== undefined &&
          (typeof params.name !== "string" || !params.name.trim())
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "name 必须是非空字符串",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (
          params.sceneId !== undefined &&
          (typeof params.sceneId !== "string" ||
            !isProtocolIdentifier(params.sceneId))
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "sceneId 必须是合法工作场景标识",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        return withConnectionSignal(ctx, (signal) =>
          app.create(
            {
              requestId: params.requestId as string,
              ...(params.name !== undefined
                ? { name: (params.name as string).trim() }
                : {}),
              ...(params.sceneId !== undefined
                ? { sceneId: params.sceneId as string }
                : {}),
            },
            signal,
          ),
        );
      },
    },
    {
      name: "conversation.program.read",
      requiresAuth: true,
      async handler(rawParams, ctx) {
        const app = requireLoopbackProgramApplication(ctx);
        const params = requirePlainParams(
          rawParams,
          "conversation.program.read",
          ["conversationId", "limit", "before"],
        );
        if (
          typeof params.conversationId !== "string" ||
          !isProtocolIdentifier(params.conversationId)
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "conversationId 必须是非空合法标识",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (
          params.limit !== undefined &&
          (typeof params.limit !== "number" ||
            !Number.isSafeInteger(params.limit) ||
            params.limit < 1 ||
            params.limit > 200)
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "limit 必须是 1 到 200 的整数",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (
          params.before !== undefined &&
          (typeof params.before !== "string" || !params.before.trim())
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError("invalid_cursor", "before 游标无效", {
              retryable: false,
              exitCode: 1,
            }),
          );
        }
        return withConnectionSignal(ctx, (signal) =>
          app.read(
            {
              conversationId: params.conversationId as string,
              ...(params.limit !== undefined
                ? { limit: params.limit as number }
                : {}),
              ...(params.before !== undefined
                ? { before: params.before as string }
                : {}),
            },
            signal,
          ),
        );
      },
    },
    {
      name: "conversation.program.send",
      requiresAuth: true,
      async handler(rawParams, ctx) {
        const app = requireLoopbackProgramApplication(ctx);
        const params = requirePlainParams(
          rawParams,
          "conversation.program.send",
          ["conversationId", "requestId", "text"],
        );
        const conversationId =
          typeof params.conversationId === "string"
            ? params.conversationId
            : "";
        const requestId =
          typeof params.requestId === "string" ? params.requestId : "";
        if (!isProtocolIdentifier(conversationId)) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "conversationId 必须是非空合法标识",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (!isProtocolIdentifier(requestId)) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "requestId 必须是非空合法标识",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (typeof params.text !== "string" || params.text.trim().length === 0) {
          return {
            v: 1 as const,
            admitted: false as const,
            conversationId,
            requestId,
            error: {
              code: "invalid_params" as const,
              message: "发送正文不能为空白",
              retryable: false,
            },
          };
        }
        const input = {
          conversationId,
          requestId,
          text: params.text,
        };
        if (estimateProgramSendWireBytes(input) > PROGRAM_SINGLE_FRAME_MAX_BYTES) {
          return {
            v: 1 as const,
            admitted: false as const,
            conversationId,
            requestId,
            error: {
              code: "payload_too_large" as const,
              message: "发送消息超出单帧 1 MiB 净荷上限",
              retryable: false,
            },
          };
        }
        return withConnectionSignal(ctx, (signal) => app.send(input, signal));
      },
    },
    {
      name: "conversation.program.result",
      requiresAuth: true,
      async handler(rawParams, ctx) {
        const app = requireLoopbackProgramApplication(ctx);
        const params = requirePlainParams(
          rawParams,
          "conversation.program.result",
          ["conversationId", "requestId", "waitMs", "cursor"],
        );
        if (
          typeof params.conversationId !== "string" ||
          !isProtocolIdentifier(params.conversationId)
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "conversationId 必须是非空合法标识",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (
          typeof params.requestId !== "string" ||
          !isProtocolIdentifier(params.requestId)
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              "requestId 必须是非空合法标识",
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (
          params.waitMs !== undefined &&
          (typeof params.waitMs !== "number" ||
            !Number.isSafeInteger(params.waitMs) ||
            params.waitMs < 0 ||
            params.waitMs > PROGRAM_MAX_WAIT_SLICE_MS)
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError(
              "invalid_params",
              `waitMs 必须是 0 到 ${PROGRAM_MAX_WAIT_SLICE_MS} 的整数`,
              { retryable: false, exitCode: 1 },
            ),
          );
        }
        if (
          params.cursor !== undefined &&
          (typeof params.cursor !== "string" || !params.cursor.trim())
        ) {
          throw mapProgramConversationRpcError(
            new ProgramConversationError("invalid_cursor", "cursor 无效", {
              retryable: false,
              exitCode: 1,
            }),
          );
        }
        return withConnectionSignal(ctx, (signal) =>
          app.result(
            {
              conversationId: params.conversationId as string,
              requestId: params.requestId as string,
              ...(params.waitMs !== undefined
                ? { waitMs: params.waitMs as number }
                : {}),
              ...(params.cursor !== undefined
                ? { cursor: params.cursor as string }
                : {}),
            },
            signal,
          ),
        );
      },
    },
  ];
}
