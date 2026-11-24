import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Writable, type Readable } from "node:stream";
import { TextDecoder } from "node:util";
import {
  encodeProgramConversationTicket,
  estimateProgramSendWireBytes,
  PROGRAM_MAX_WAIT_SLICE_MS,
  PROGRAM_SINGLE_FRAME_MAX_BYTES,
  ProgramConversationError,
  programHomeId,
  verifyProgramConversationTicket,
  type ProgramConversationApplication,
  type ProgramConversationErrorCode,
  type ProgramConversationPendingInputEntry,
  type ProgramConversationReadMessageEntry,
  type ProgramConversationResultOutput,
  type ProgramConversationScopeFilter,
} from "@zhixing-ai/core/conversation/application";
import { getZhixingHome } from "@zhixing-ai/core/paths";
import { isProtocolIdentifier } from "@zhixing-ai/core/protocol";
import {
  RPC_ERROR_CODES,
  RpcClientClosedError,
  RpcClientError,
  RpcRequestInterruptedError,
} from "@zhixing-ai/server/client";
import { CoreHostUnavailableError } from "../runtime/core-host-connection.js";

export const CONVERSATION_HELP_EXAMPLES = `\n跨智能体对话示例：
  zz conversation list --json
  zz conversation new --scene <sceneId>
  zz conversation send <conversationId> --file message.md
  zz conversation result <ticket> --wait 60   # 或 --to <conversationId> --id <requestId>
`;

const VALID_SCOPES = new Set<ProgramConversationScopeFilter>([
  "all",
  "main",
  "workscene",
  "channel",
  "local",
]);

const DEFAULT_SEND_WAIT_SECONDS = 60;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ProgramConversationClientPort
  extends ProgramConversationApplication {
  ensureConnected(): Promise<void>;
  maxSendParamsBytes?(): Promise<number | undefined>;
}

export interface ProgramConversationClientHandle {
  readonly facade: ProgramConversationClientPort;
  dispose(): Promise<void>;
}

export interface ConversationCommandRuntimeIO {
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
  readonly stdin?: Readable;
  readonly zhixingHome?: string;
  readonly openClient?: (
    zhixingHome: string,
  ) => Promise<ProgramConversationClientHandle> | ProgramConversationClientHandle;
  readonly signals?: Pick<NodeJS.Process, "on" | "off">;
}

interface ExtractedProgramError {
  readonly code: ProgramConversationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly exitCode: 1 | 2 | 3;
}

function extractProgramError(
  err: unknown,
  opts: {
    readonly written: boolean;
    readonly knownAdmitted?: boolean;
    readonly priorAcceptancePossible?: boolean;
  },
): ExtractedProgramError {
  if (err instanceof ProgramConversationError) {
    const retryable = err.options?.retryable === true;
    const exitCode =
      err.options?.exitCode === 1 ||
      err.options?.exitCode === 2 ||
      err.options?.exitCode === 3
        ? err.options.exitCode
        : retryable
          ? 3
          : 1;
    if (
      opts.knownAdmitted &&
      err.code !== "target_deleted" &&
      err.code !== "cleared" &&
      err.code !== "idempotency_conflict" &&
      err.code !== "invalid_cursor" &&
      err.code !== "invalid_params" &&
      err.code !== "invalid_ticket" &&
      err.code !== "payload_too_large"
    ) {
      return {
        code:
          err.code === "unknown"
            ? "unknown"
            : err.code === "unsupported_host_version"
              ? "unsupported_host_version"
              : "temporarily_unavailable",
        message: err.message,
        retryable: err.code !== "unsupported_host_version",
        exitCode: 3,
      };
    }
    if (
      opts.priorAcceptancePossible &&
      (err.code === "unsupported_host_version" || err.code === "unauthorized")
    ) {
      return {
        code: err.code,
        message: err.message,
        retryable: false,
        exitCode: 3,
      };
    }
    return {
      code: err.code,
      message: err.message,
      retryable,
      exitCode,
    };
  }

  if (err instanceof RpcClientError) {
    if (
      err.data &&
      typeof err.data === "object" &&
      "programError" in err.data &&
      err.data.programError &&
      typeof err.data.programError === "object"
    ) {
      const payload = err.data.programError as {
        code?: unknown;
        retryable?: unknown;
        exitCode?: unknown;
      };
      if (typeof payload.code === "string") {
        const retryable = payload.retryable === true;
        const exitCode =
          payload.exitCode === 1 ||
          payload.exitCode === 2 ||
          payload.exitCode === 3
            ? payload.exitCode
            : retryable
              ? 3
              : 1;
        if (
          opts.knownAdmitted &&
          payload.code !== "target_deleted" &&
          payload.code !== "cleared" &&
          payload.code !== "idempotency_conflict" &&
          payload.code !== "invalid_cursor" &&
          payload.code !== "invalid_params" &&
          payload.code !== "invalid_ticket" &&
          payload.code !== "payload_too_large"
        ) {
          return {
            code:
              payload.code === "unknown"
                ? "unknown"
                : payload.code === "unsupported_host_version"
                  ? "unsupported_host_version"
                  : "temporarily_unavailable",
            message: err.message,
            retryable: payload.code !== "unsupported_host_version",
            exitCode: 3,
          };
        }
        if (
          opts.priorAcceptancePossible &&
          (payload.code === "unsupported_host_version" ||
            payload.code === "unauthorized")
        ) {
          return {
            code: payload.code,
            message: err.message,
            retryable: false,
            exitCode: 3,
          };
        }
        return {
          code: payload.code as ProgramConversationErrorCode,
          message: err.message,
          retryable,
          exitCode,
        };
      }
    }
    if (opts.knownAdmitted) {
      const nonRetryableRpc =
        err.code === RPC_ERROR_CODES.METHOD_NOT_FOUND ||
        err.code === RPC_ERROR_CODES.UNAUTHORIZED;
      return {
        code:
          err.code === RPC_ERROR_CODES.METHOD_NOT_FOUND
            ? "unsupported_host_version"
            : "temporarily_unavailable",
        message: `消息已耐久接纳，但本次取回结果失败 (${err.message})`,
        retryable: !nonRetryableRpc,
        exitCode: 3,
      };
    }
    if (err.code === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
      if (opts.priorAcceptancePossible) {
        return {
          code: "unsupported_host_version",
          message:
            "当前运行的知行宿主版本不支持 conversation.program.* 接口，无法核实该请求既有状态，请保留票据升级或重启宿主后查询",
          retryable: false,
          exitCode: 3,
        };
      }
      return {
        code: "unsupported_host_version",
        message: "当前运行的知行宿主版本不支持 conversation.program.* 接口，请升级或重启宿主",
        retryable: false,
        exitCode: 1,
      };
    }
    if (err.code === RPC_ERROR_CODES.UNAUTHORIZED) {
      if (opts.priorAcceptancePossible) {
        return {
          code: "unauthorized",
          message: `当前宿主鉴权状态无法核实该请求既有结果 (${err.message})`,
          retryable: false,
          exitCode: 3,
        };
      }
      return {
        code: "unauthorized",
        message: err.message,
        retryable: false,
        exitCode: 1,
      };
    }
    if (!opts.written && !opts.priorAcceptancePossible && err.code === RPC_ERROR_CODES.INVALID_PARAMS) {
      return {
        code: "invalid_params",
        message: err.message,
        retryable: false,
        exitCode: 1,
      };
    }
  }

  if (err instanceof CoreHostUnavailableError) {
    if (err.restriction && !opts.written && !opts.knownAdmitted && !opts.priorAcceptancePossible) {
      return {
        code: "unauthorized",
        message: err.publicReason,
        retryable: false,
        exitCode: 1,
      };
    }
    return {
      code: "temporarily_unavailable",
      message: err.publicReason || err.message,
      retryable: true,
      exitCode: 3,
    };
  }

  if (err instanceof RpcRequestInterruptedError || err instanceof RpcClientClosedError) {
    return {
      code:
        opts.knownAdmitted
          ? "temporarily_unavailable"
          : opts.written
            ? "unknown"
            : "temporarily_unavailable",
      message: err.message,
      retryable: true,
      exitCode: 3,
    };
  }

  return {
    code:
      opts.knownAdmitted
        ? "temporarily_unavailable"
        : opts.written
          ? "unknown"
          : "temporarily_unavailable",
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
    exitCode: 3,
  };
}

function sanitizeCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function writeOut(
  io: ConversationCommandRuntimeIO,
  text: string,
): void {
  (io.stdout ?? process.stdout).write(text);
}

function writeErr(
  io: ConversationCommandRuntimeIO,
  text: string,
): void {
  const target = io.stderr ?? process.stderr;
  const state = target as unknown as {
    destroyed?: boolean;
    writableEnded?: boolean;
    errored?: unknown;
    listenerCount?: (event: string) => number;
    once?: (event: string, listener: () => void) => void;
  };
  if (state.destroyed || state.writableEnded || state.errored) {
    return;
  }
  if (
    typeof state.listenerCount === "function" &&
    typeof state.once === "function" &&
    state.listenerCount("error") === 0
  ) {
    state.once("error", () => {});
  }
  try {
    target.write(text);
  } catch {
    // Best-effort diagnostic write when stderr is closed.
  }
}

async function flushRecoveryLine(
  io: ConversationCommandRuntimeIO,
  text: string,
): Promise<void> {
  const target = io.stderr ?? process.stderr;
  const usesAsyncCallback =
    target instanceof Writable ||
    typeof (target as { once?: unknown }).once === "function" ||
    target.write.length >= 2;
  if (!usesAsyncCallback) {
    const out = (target.write as (chunk: string) => unknown)(text);
    if (out && typeof (out as PromiseLike<unknown>).then === "function") {
      await (out as PromiseLike<unknown>);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const emitter = target as unknown as {
      once?: (event: string, listener: (err: unknown) => void) => void;
      off?: (event: string, listener: (err: unknown) => void) => void;
      removeListener?: (event: string, listener: (err: unknown) => void) => void;
    };
    const cleanup = () => {
      if (typeof emitter.off === "function") {
        emitter.off("error", onError);
      } else if (typeof emitter.removeListener === "function") {
        emitter.removeListener("error", onError);
      }
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    if (typeof emitter.once === "function") {
      emitter.once("error", onError);
    }
    try {
      (
        target.write as (
          chunk: string,
          cb: (err?: Error | null) => void,
        ) => boolean
      )(text, (err?: Error | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          // Node Writable invokes write callback BEFORE emitting 'error' on nextTick;
          // absorb that paired stream 'error' event if no other error listener exists.
          const countFn = (
            target as unknown as { listenerCount?: (ev: string) => number }
          ).listenerCount;
          if (
            typeof emitter.once === "function" &&
            (typeof countFn !== "function" || countFn.call(target, "error") === 0)
          ) {
            const swallow = () => {};
            emitter.once("error", swallow);
            setTimeout(() => {
              if (typeof emitter.off === "function") {
                emitter.off("error", swallow);
              } else if (typeof emitter.removeListener === "function") {
                emitter.removeListener("error", swallow);
              }
            }, 50).unref?.();
          }
          reject(err);
          return;
        }
        resolve();
      });
    } catch (err) {
      onError(err);
    }
  });
}

function emitCliError(
  io: ConversationCommandRuntimeIO,
  json: boolean | undefined,
  error: {
    readonly code: ProgramConversationErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly exitCode: 1 | 2 | 3;
    readonly extra?: Record<string, unknown>;
  },
): 1 | 2 | 3 {
  if (json) {
    writeOut(
      io,
      `${JSON.stringify({
        v: 1,
        ...(error.extra ?? {}),
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      })}\n`,
    );
  }
  writeErr(io, `错误 [${error.code}]: ${error.message}\n`);
  return error.exitCode;
}

async function openProgramClient(
  io: ConversationCommandRuntimeIO,
  zhixingHome: string,
): Promise<ProgramConversationClientHandle> {
  if (!io.openClient) {
    throw new Error("openClient must be provided by the CLI composition owner");
  }
  return await io.openClient(zhixingHome);
}

function parsePositiveInteger(
  raw: string,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^\d+$/u.test(raw)) {
    return { ok: false, message: `${label} 必须是 ${min} 到 ${max} 的整数` };
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    return { ok: false, message: `${label} 必须在 ${min} 到 ${max} 之间` };
  }
  return { ok: true, value: num };
}

function parseWaitSeconds(
  raw: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) {
    return { ok: false, message: "--wait 必须是非负秒数" };
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0 || num > 86_400) {
    return { ok: false, message: "--wait 必须在 0 到 86400 秒之间" };
  }
  return { ok: true, value: num };
}

async function readStreamAllUtf8(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
  }
  return STRICT_UTF8_DECODER.decode(Buffer.concat(chunks));
}

export async function runConversationListCommand(
  options: {
    readonly query?: string;
    readonly scope?: string;
    readonly limit?: string;
    readonly cursor?: string;
    readonly json?: boolean;
  },
  io: ConversationCommandRuntimeIO = {},
): Promise<number> {
  const scope = (options.scope ?? "all") as ProgramConversationScopeFilter;
  if (!VALID_SCOPES.has(scope)) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "--scope 必须是 all、main、workscene、channel 或 local",
      retryable: false,
      exitCode: 1,
    });
  }
  if (options.query !== undefined && options.query.length > 256) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "--query 长度不能超过 256 个字符",
      retryable: false,
      exitCode: 1,
    });
  }
  let limit: number | undefined;
  if (options.limit !== undefined) {
    const parsed = parsePositiveInteger(options.limit, 1, 100, "--limit");
    if (!parsed.ok) {
      return emitCliError(io, options.json, {
        code: "invalid_params",
        message: parsed.message,
        retryable: false,
        exitCode: 1,
      });
    }
    limit = parsed.value;
  }

  const zhixingHome = io.zhixingHome ?? getZhixingHome();
  let handle: ProgramConversationClientHandle | undefined;
  try {
    handle = await openProgramClient(io, zhixingHome);
    const res = await handle.facade.list({
      ...(options.query !== undefined ? { query: options.query } : {}),
      scope,
      ...(limit !== undefined ? { limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
    if (options.json) {
      writeOut(io, `${JSON.stringify(res)}\n`);
      return 0;
    }
    for (const entry of res.entries) {
      if (entry.entryKind === "conversation") {
        writeOut(
          io,
          `conversation\t${entry.conversationId}\t${entry.scope}\t${sanitizeCell(entry.sceneName ?? "-")}\t${sanitizeCell(entry.name)}\t${entry.lastActiveAt}\n`,
        );
      } else {
        writeOut(
          io,
          `workscene-candidate\t${entry.sceneId}\tworkscene\t${sanitizeCell(entry.sceneName)}\t(未初始化工作场景)\t${entry.lastActiveAt}\n`,
        );
      }
    }
    if (res.partial) {
      const devices = res.unreachableDevices?.length
        ? `（离线设备: ${res.unreachableDevices.join(", ")}）`
        : "";
      writeErr(io, `提示：部分配对设备当前不可达${devices}，目录结果可能不完整。\n`);
    }
    if (res.nextCursor) {
      writeErr(io, `下一页游标: ${res.nextCursor}\n`);
    }
    return 0;
  } catch (err) {
    const mapped = extractProgramError(err, { written: false });
    return emitCliError(io, options.json, mapped);
  } finally {
    await handle?.dispose().catch(() => {});
  }
}

export async function runConversationNewCommand(
  options: {
    readonly name?: string;
    readonly scene?: string;
    readonly id?: string;
    readonly json?: boolean;
  },
  io: ConversationCommandRuntimeIO = {},
): Promise<number> {
  if (options.name !== undefined && options.scene !== undefined) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "--name 与 --scene 互斥，不能同时指定",
      retryable: false,
      exitCode: 1,
    });
  }
  if (options.name !== undefined) {
    const trimmed = options.name.trim();
    if (!trimmed || trimmed.length > 200) {
      return emitCliError(io, options.json, {
        code: "invalid_params",
        message: "--name 必须是非空且不超过 200 字符的标题",
        retryable: false,
        exitCode: 1,
      });
    }
  }
  if (options.scene !== undefined && !isProtocolIdentifier(options.scene)) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "--scene 必须是合法的工作场景 ID",
      retryable: false,
      exitCode: 1,
    });
  }
  const requestId = options.id ?? `req-${randomUUID()}`;
  if (!isProtocolIdentifier(requestId)) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "--id 必须是合法的协议请求标识",
      retryable: false,
      exitCode: 1,
    });
  }

  // Flush recovery requestId to stderr and await write completion BEFORE opening client or writing RPC.
  try {
    await flushRecoveryLine(io, `requestId=${requestId}\n`);
  } catch (err) {
    if (options.json) {
      writeOut(
        io,
        `${JSON.stringify({
          v: 1,
          requestId,
          error: {
            code: "invalid_params",
            message: `无法向 stderr 写出恢复标识 requestId，已中止提交: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
          },
        })}\n`,
      );
    }
    return 1;
  }

  const zhixingHome = io.zhixingHome ?? getZhixingHome();
  let handle: ProgramConversationClientHandle | undefined;
  let requestSent = false;
  try {
    handle = await openProgramClient(io, zhixingHome);
    await handle.facade.ensureConnected();
    requestSent = true;
    const res = await handle.facade.create({
      requestId,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.scene !== undefined ? { sceneId: options.scene } : {}),
    });
    if (options.json) {
      writeOut(io, `${JSON.stringify(res)}\n`);
    } else {
      writeOut(io, `${res.conversationId}\n`);
    }
    return 0;
  } catch (err) {
    const mapped = extractProgramError(err, {
      written: requestSent,
      priorAcceptancePossible: options.id !== undefined,
    });
    const finalExitCode: 1 | 2 | 3 =
      mapped.exitCode === 3 ||
      (requestSent &&
        mapped.code !== "not_found" &&
        mapped.code !== "idempotency_conflict" &&
        mapped.code !== "target_deleted" &&
        mapped.code !== "invalid_params" &&
        mapped.code !== "unsupported_host_version" &&
        mapped.code !== "unauthorized")
        ? 3
        : mapped.exitCode;
    return emitCliError(io, options.json, {
      ...mapped,
      exitCode: finalExitCode,
      extra: { requestId },
    });
  } finally {
    await handle?.dispose().catch(() => {});
  }
}

function formatReadEntriesAsText(
  entries: readonly ProgramConversationReadMessageEntry[],
  pendingInputs: readonly ProgramConversationPendingInputEntry[],
): string {
  // Group fragments by (runId, messageIndex, blockIndex) sorted by offset, then by (runId, messageIndex)
  interface BlockAccum {
    readonly blockIndex: number;
    readonly parts: { readonly offset: number; readonly text: string }[];
  }
  interface MessageAccum {
    readonly runId: string;
    readonly messageIndex: number;
    readonly role: string;
    readonly sourceConversationId?: string;
    readonly programOrigin?: true;
    readonly blocks: Map<number, BlockAccum>;
  }
  const messages: MessageAccum[] = [];
  const messageKeyMap = new Map<string, MessageAccum>();
  for (const entry of entries) {
    const mKey = `${entry.runId}:${entry.messageIndex}`;
    let msg = messageKeyMap.get(mKey);
    if (!msg) {
      msg = {
        runId: entry.runId,
        messageIndex: entry.messageIndex,
        role: entry.role,
        ...(entry.sourceConversationId
          ? { sourceConversationId: entry.sourceConversationId }
          : {}),
        ...(entry.programOrigin ? { programOrigin: true } : {}),
        blocks: new Map(),
      };
      messageKeyMap.set(mKey, msg);
      messages.push(msg);
    }
    let blk = msg.blocks.get(entry.blockIndex);
    if (!blk) {
      blk = { blockIndex: entry.blockIndex, parts: [] };
      msg.blocks.set(entry.blockIndex, blk);
    }
    blk.parts.push({ offset: entry.offset, text: entry.text });
  }

  const sections: string[] = [];
  for (const msg of messages) {
    const orderedBlocks = [...msg.blocks.values()]
      .sort((a, b) => a.blockIndex - b.blockIndex)
      .map((blk) =>
        [...blk.parts]
          .sort((a, b) => a.offset - b.offset)
          .map((p) => p.text)
          .join(""),
      );
    const body = orderedBlocks.join("\n");
    const header =
      msg.role === "user"
        ? msg.sourceConversationId
          ? `◇ 来自对话 ${msg.sourceConversationId}:`
          : msg.programOrigin
            ? "◇ 来自外部程序:"
            : "❯ 用户:"
        : msg.role === "assistant"
          ? "● 助手:"
          : `[${msg.role}]`;
    sections.push(`${header}\n${body}`);
  }

  for (const pending of pendingInputs) {
    const provenance = pending.sourceConversationId
      ? `来自对话 ${pending.sourceConversationId}`
      : pending.programOrigin
        ? "来自外部程序"
        : "用户";
    sections.push(`[待处理输入 · ${provenance} · ${pending.disposition}]\n${pending.text}`);
  }

  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

export async function runConversationReadCommand(
  conversationId: string,
  options: {
    readonly limit?: string;
    readonly before?: string;
    readonly json?: boolean;
  },
  io: ConversationCommandRuntimeIO = {},
): Promise<number> {
  if (!isProtocolIdentifier(conversationId)) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "conversationId 格式不合法",
      retryable: false,
      exitCode: 1,
    });
  }
  let limit = 20;
  if (options.limit !== undefined) {
    const parsed = parsePositiveInteger(options.limit, 1, 200, "--limit");
    if (!parsed.ok) {
      return emitCliError(io, options.json, {
        code: "invalid_params",
        message: parsed.message,
        retryable: false,
        exitCode: 1,
      });
    }
    limit = parsed.value;
  }

  const zhixingHome = io.zhixingHome ?? getZhixingHome();
  let handle: ProgramConversationClientHandle | undefined;
  try {
    handle = await openProgramClient(io, zhixingHome);
    if (options.json) {
      const res = await handle.facade.read({
        conversationId,
        limit,
        ...(options.before !== undefined ? { before: options.before } : {}),
      });
      writeOut(io, `${JSON.stringify(res)}\n`);
      return 0;
    }

    // Text mode: automatically assemble across < 1 MiB frames up to `limit` runs.
    let resetAttempts = 0;
    for (;;) {
      try {
        const pageChunks: (readonly ProgramConversationReadMessageEntry[])[] = [];
        let pendingInputs: readonly ProgramConversationPendingInputEntry[] = [];
        const seenRunIds = new Set<string>();
        let cursor = options.before;
        let finalHasMore = false;
        let finalNextBefore: string | undefined;

        for (;;) {
          const remainingRuns = Math.max(1, limit - seenRunIds.size);
          const page = await handle.facade.read({
            conversationId,
            limit: remainingRuns,
            ...(cursor !== undefined ? { before: cursor } : {}),
          });
          if (pageChunks.length === 0 && options.before === undefined) {
            pendingInputs = page.inputsOutsideHistory;
          }
          pageChunks.unshift(page.entries);
          for (const e of page.entries) {
            seenRunIds.add(e.runId);
          }
          finalHasMore = page.hasMore;
          finalNextBefore = page.nextBefore;

          // Keep fetching if the earliest run in `page.entries` may have been split mid-run
          // across the < 1 MiB frame boundary, or if we haven't reached `limit` runs yet.
          const earliestEntry = page.entries[0];
          const splitMidRun =
            page.hasMore &&
            page.nextBefore !== undefined &&
            earliestEntry !== undefined &&
            (earliestEntry.messageIndex > 0 ||
              earliestEntry.blockIndex > 0 ||
              earliestEntry.offset > 0);
          if (
            page.hasMore &&
            page.nextBefore !== undefined &&
            (seenRunIds.size < limit || splitMidRun)
          ) {
            cursor = page.nextBefore;
            continue;
          }
          break;
        }

        const mergedEntries = pageChunks.flat();
        const textOut = formatReadEntriesAsText(mergedEntries, pendingInputs);
        if (textOut.length > 0) {
          writeOut(io, textOut);
        }
        if (finalHasMore && finalNextBefore) {
          writeErr(io, `更早历史游标: ${finalNextBefore}\n`);
        }
        return 0;
      } catch (err) {
        const mapped = extractProgramError(err, { written: false });
        if (
          mapped.code === "cursor_expired" &&
          options.before === undefined &&
          resetAttempts < 2
        ) {
          resetAttempts += 1;
          continue;
        }
        return emitCliError(io, false, mapped);
      }
    }
  } catch (err) {
    const mapped = extractProgramError(err, { written: false });
    return emitCliError(io, options.json, mapped);
  } finally {
    await handle?.dispose().catch(() => {});
  }
}

async function assembleFullCompletedAnswer(
  facade: ProgramConversationClientPort,
  firstPage: ProgramConversationResultOutput,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok"; readonly answer: string; readonly emptyReason?: "no_assistant_text" }
  | { readonly kind: "output"; readonly page: ProgramConversationResultOutput }
> {
  let current = firstPage;
  let retriesOnExpire = 0;

  for (;;) {
    if (current.state !== "completed") {
      return { kind: "output", page: current };
    }
    if (!current.answerTruncated || !current.nextCursor) {
      return {
        kind: "ok",
        answer: current.answer ?? "",
        ...(current.emptyReason ? { emptyReason: current.emptyReason } : {}),
      };
    }

    let assembled = current.answer ?? "";
    let cursor: string | undefined = current.nextCursor;
    let expired = false;

    while (cursor) {
      const nextPage = await facade.result(
        {
          conversationId: firstPage.conversationId,
          requestId: firstPage.requestId,
          waitMs: 0,
          cursor,
        },
        signal,
      );
      if (nextPage.state === "cursor_expired") {
        if (retriesOnExpire < 2) {
          retriesOnExpire += 1;
          expired = true;
          break;
        }
        return { kind: "output", page: nextPage };
      }
      if (nextPage.state !== "completed") {
        return { kind: "output", page: nextPage };
      }
      assembled += nextPage.answer ?? "";
      cursor = nextPage.answerTruncated ? nextPage.nextCursor : undefined;
    }

    if (expired) {
      current = await facade.result(
        {
          conversationId: firstPage.conversationId,
          requestId: firstPage.requestId,
          waitMs: 0,
        },
        signal,
      );
      continue;
    }

    return { kind: "ok", answer: assembled };
  }
}

async function pollAndRenderProgramResult(input: {
  readonly facade: ProgramConversationClientPort;
  readonly ticket: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly waitSeconds: number;
  readonly cursor?: string;
  readonly json?: boolean;
  readonly knownAdmitted?: { readonly runId: string };
  readonly initiallyDetached?: boolean;
  readonly io: ConversationCommandRuntimeIO;
}): Promise<number> {
  const {
    facade,
    ticket,
    conversationId,
    requestId,
    waitSeconds,
    cursor,
    json,
    knownAdmitted,
    initiallyDetached,
    io,
  } = input;
  const overallDeadlineMs = Date.now() + Math.round(waitSeconds * 1000);
  const waitAbort = new AbortController();
  let detachedBySignal = initiallyDetached === true;
  if (detachedBySignal) {
    waitAbort.abort();
  }
  let observedAdmitted:
    | {
        readonly runId: string;
        readonly runState?: ProgramConversationResultOutput["runState"];
        readonly completedInterrupt?: boolean;
      }
    | undefined = knownAdmitted ? { runId: knownAdmitted.runId } : undefined;
  const signalTarget = io.signals ?? process;
  const onSignal = () => {
    detachedBySignal = true;
    waitAbort.abort();
  };
  signalTarget.on("SIGINT", onSignal);
  signalTarget.on("SIGTERM", onSignal);

  try {
    for (;;) {
      if (detachedBySignal) {
        if (observedAdmitted && !observedAdmitted.completedInterrupt) {
          if (json) {
            writeOut(
              io,
              `${JSON.stringify({
                v: 1,
                state: "pending",
                ...(knownAdmitted ? { admitted: true } : {}),
                ticket,
                conversationId,
                requestId,
                runId: observedAdmitted.runId,
                ...(observedAdmitted.runState
                  ? { runState: observedAdmitted.runState }
                  : {}),
              })}\n`,
            );
          } else {
            writeOut(io, `${ticket}\n`);
            writeErr(io, "已结束本地等待（后台运行未取消），可凭票据继续查询。\n");
          }
          return 2;
        }
        if (json) {
          writeOut(
            io,
            `${JSON.stringify({
              v: 1,
              state: observedAdmitted?.completedInterrupt
                ? "temporarily_unavailable"
                : "unknown",
              ticket,
              conversationId,
              requestId,
              ...(observedAdmitted?.runId ? { runId: observedAdmitted.runId } : {}),
              error: {
                code: observedAdmitted?.completedInterrupt
                  ? "temporarily_unavailable"
                  : "unknown",
                message: observedAdmitted?.completedInterrupt
                  ? "本地读取完整回复中途已中断（后台结果未丢失），可凭票据继续获取"
                  : "本地等待在取得权威状态前已中断，可凭票据继续查询",
                retryable: true,
              },
            })}\n`,
          );
        } else {
          writeOut(io, `${ticket}\n`);
          writeErr(io, "本地等待在确认状态前已中断，可凭票据继续查询。\n");
        }
        return 3;
      }

      const now = Date.now();
      const remainingMs = Math.max(0, overallDeadlineMs - now);
      const sliceWaitMs =
        waitSeconds > 0 && cursor === undefined
          ? Math.min(PROGRAM_MAX_WAIT_SLICE_MS, remainingMs)
          : 0;

      let res: ProgramConversationResultOutput;
      try {
        res = await facade.result(
          {
            conversationId,
            requestId,
            waitMs: sliceWaitMs,
            ...(cursor !== undefined ? { cursor } : {}),
          },
          waitAbort.signal,
        );
      } catch (err) {
        if (detachedBySignal) continue;
        const mapped = extractProgramError(err, {
          written: Boolean(observedAdmitted) || waitSeconds > 0,
          knownAdmitted: Boolean(observedAdmitted),
          priorAcceptancePossible: true,
        });
        // If connection dropped mid-wait (e.g. host restart / migration) and budget remains, retry slice.
        if (
          mapped.retryable &&
          waitSeconds > 0 &&
          Date.now() + 300 < overallDeadlineMs
        ) {
          await new Promise<void>((r) => setTimeout(r, 200));
          continue;
        }
        if (mapped.exitCode === 3) {
          if (json) {
            writeOut(
              io,
              `${JSON.stringify({
                v: 1,
                state:
                  mapped.code === "unknown" ? "unknown" : "temporarily_unavailable",
                ...(knownAdmitted ? { admitted: true } : {}),
                ...(observedAdmitted ? { runId: observedAdmitted.runId } : {}),
                ticket,
                conversationId,
                requestId,
                error: {
                  code: mapped.code,
                  message: mapped.message,
                  retryable: mapped.retryable,
                },
              })}\n`,
            );
          } else {
            writeOut(io, `${ticket}\n`);
            writeErr(io, `待核对 [${mapped.code}]: ${mapped.message}\n`);
          }
          return 3;
        }
        return emitCliError(io, json, {
          ...mapped,
          extra: {
            ...(knownAdmitted ? { admitted: true } : {}),
            ...(observedAdmitted ? { runId: observedAdmitted.runId } : {}),
            ticket,
            conversationId,
            requestId,
          },
        });
      }

      if (res.state === "pending") {
        if (res.runId) {
          observedAdmitted = {
            runId: res.runId,
            ...(res.runState ? { runState: res.runState } : {}),
          };
        }
        if (
          waitSeconds > 0 &&
          cursor === undefined &&
          !detachedBySignal &&
          Date.now() < overallDeadlineMs
        ) {
          continue;
        }
        if (json) {
          writeOut(
            io,
            `${JSON.stringify({
              ...(knownAdmitted ? { admitted: true } : {}),
              ...res,
              ticket,
            })}\n`,
          );
        } else {
          writeOut(io, `${ticket}\n`);
        }
        return 2;
      }

      if (res.state === "completed") {
        if (json) {
          writeOut(io, `${JSON.stringify({ ...res, ticket })}\n`);
          return 0;
        }
        if (res.runId) {
          observedAdmitted = {
            runId: res.runId,
            runState: "committed",
            completedInterrupt: true,
          };
        }
        try {
          const assembled = await assembleFullCompletedAnswer(
            facade,
            res,
            waitAbort.signal,
          );
          if (assembled.kind === "output") {
            res = assembled.page;
          } else {
            if (assembled.answer.length > 0) {
              writeOut(
                io,
                assembled.answer.endsWith("\n")
                  ? assembled.answer
                  : `${assembled.answer}\n`,
              );
            } else if (assembled.emptyReason === "no_assistant_text") {
              writeErr(io, "提示：本次运行已完成，未生成助手文本回复。\n");
            }
            return 0;
          }
        } catch (err) {
          if (detachedBySignal) continue;
          const mapped = extractProgramError(err, { written: true });
          if (mapped.exitCode === 1 && !mapped.retryable) {
            return emitCliError(io, json, {
              ...mapped,
              extra: {
                ...(knownAdmitted ? { admitted: true } : {}),
                ...(observedAdmitted ? { runId: observedAdmitted.runId } : {}),
                ticket,
                conversationId,
                requestId,
              },
            });
          }
          writeOut(io, `${ticket}\n`);
          writeErr(io, `待核对 [${mapped.code}]: ${mapped.message}\n`);
          return 3;
        }
      }

      if (
        res.state === "unknown" ||
        res.state === "temporarily_unavailable" ||
        res.state === "uncertain" ||
        res.state === "cursor_expired"
      ) {
        if (json) {
          writeOut(io, `${JSON.stringify({ ...res, ticket })}\n`);
        } else {
          writeOut(io, `${ticket}\n`);
          if (res.error?.message) {
            writeErr(io, `待核对 [${res.error.code}]: ${res.error.message}\n`);
          }
        }
        return 3;
      }

      // Terminal failure states: failed | cancelled | cleared | target_deleted
      if (json) {
        writeOut(io, `${JSON.stringify({ ...res, ticket })}\n`);
      } else {
        writeErr(
          io,
          `错误 [${res.error?.code ?? res.state}]: ${res.error?.message ?? `运行未成功 (${res.state})`}\n`,
        );
      }
      return 1;
    }
  } finally {
    signalTarget.off("SIGINT", onSignal);
    signalTarget.off("SIGTERM", onSignal);
  }
}

export async function runConversationSendCommand(
  conversationId: string,
  options: {
    readonly text?: string;
    readonly stdin?: boolean;
    readonly file?: string;
    readonly wait?: string | boolean;
    readonly sawWaitValue?: boolean;
    readonly sawNoWait?: boolean;
    readonly id?: string;
    readonly json?: boolean;
  },
  io: ConversationCommandRuntimeIO = {},
): Promise<number> {
  if (!isProtocolIdentifier(conversationId)) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "conversationId 格式不合法",
      retryable: false,
      exitCode: 1,
    });
  }
  if (options.sawWaitValue && options.sawNoWait) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "--wait 与 --no-wait 互斥，不能同时指定",
      retryable: false,
      exitCode: 1,
    });
  }

  const inputModes = [
    options.text !== undefined,
    options.stdin === true,
    options.file !== undefined,
  ].filter(Boolean).length;
  if (inputModes !== 1) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "必须且只能指定 --text、--stdin 或 --file 其中一种输入方式",
      retryable: false,
      exitCode: 1,
    });
  }

  let noWait = false;
  let waitSeconds = DEFAULT_SEND_WAIT_SECONDS;
  if (options.sawNoWait || options.wait === false) {
    noWait = true;
    waitSeconds = 0;
  } else if (typeof options.wait === "string") {
    const parsed = parseWaitSeconds(options.wait);
    if (!parsed.ok) {
      return emitCliError(io, options.json, {
        code: "invalid_params",
        message: parsed.message,
        retryable: false,
        exitCode: 1,
      });
    }
    waitSeconds = parsed.value;
  }

  const requestId = options.id ?? `req-${randomUUID()}`;
  if (!isProtocolIdentifier(requestId)) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "--id 必须是合法的协议请求标识",
      retryable: false,
      exitCode: 1,
    });
  }

  let bodyText: string;
  try {
    if (options.text !== undefined) {
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(options.text)) {
        throw new Error("文本包含非法 UTF-16 代理项");
      }
      bodyText = options.text;
    } else if (options.file !== undefined) {
      const rawBytes = await readFile(options.file);
      bodyText = STRICT_UTF8_DECODER.decode(rawBytes);
    } else {
      bodyText = await readStreamAllUtf8(io.stdin ?? process.stdin);
    }
  } catch (err) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: `无法读取有效 UTF-8 输入正文: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
      exitCode: 1,
    });
  }

  if (bodyText.trim().length === 0) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "发送正文不能为空或纯空白",
      retryable: false,
      exitCode: 1,
    });
  }

  const estimatedBytes = estimateProgramSendWireBytes({
    conversationId,
    requestId,
    text: bodyText,
  });
  if (estimatedBytes > PROGRAM_SINGLE_FRAME_MAX_BYTES) {
    return emitCliError(io, options.json, {
      code: "payload_too_large",
      message: `单次发送请求超出 1 MiB 帧上限 (${estimatedBytes} bytes > ${PROGRAM_SINGLE_FRAME_MAX_BYTES} bytes)`,
      retryable: false,
      exitCode: 1,
      extra: { admitted: false, conversationId, requestId },
    });
  }

  const zhixingHome = io.zhixingHome ?? getZhixingHome();
  const homeId = await programHomeId(zhixingHome);
  const ticket = encodeProgramConversationTicket({
    homeId,
    conversationId,
    requestId,
  });

  // Pre-flush recovery token to stderr and await write completion BEFORE opening client or sending RPC write.
  try {
    await flushRecoveryLine(
      io,
      `ticket=${ticket} conversationId=${conversationId} requestId=${requestId}\n`,
    );
  } catch (err) {
    if (options.json) {
      writeOut(
        io,
        `${JSON.stringify({
          v: 1,
          admitted: false,
          ticket,
          conversationId,
          requestId,
          error: {
            code: "invalid_params",
            message: `无法向 stderr 写出恢复票据 ticket，已中止发送: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
          },
        })}\n`,
      );
    }
    return 1;
  }

  let handle: ProgramConversationClientHandle | undefined;
  let requestSent = false;
  try {
    handle = await openProgramClient(io, zhixingHome);
    await handle.facade.ensureConnected();
    const maxParamsBytes = await handle.facade.maxSendParamsBytes?.();
    if (maxParamsBytes !== undefined) {
      const paramsBytes = Buffer.byteLength(
        JSON.stringify({
          conversationId,
          requestId,
          text: bodyText,
        }),
        "utf8",
      );
      if (paramsBytes > maxParamsBytes) {
        return emitCliError(io, options.json, {
          code: "payload_too_large",
          message: `单次跨设备发送请求超出 1 MiB 单帧净荷上限 (${paramsBytes} bytes > ${maxParamsBytes} bytes)`,
          retryable: false,
          exitCode: 1,
          extra: { admitted: false, ticket, conversationId, requestId },
        });
      }
    }
    const signalTarget = io.signals ?? process;
    let detachedDuringSend = false;
    const onSendSignal = () => {
      detachedDuringSend = true;
    };
    signalTarget.on("SIGINT", onSendSignal);
    signalTarget.on("SIGTERM", onSendSignal);
    let sendRes: Awaited<ReturnType<typeof handle.facade.send>>;
    try {
      requestSent = true;
      sendRes = await handle.facade.send({
        conversationId,
        requestId,
        text: bodyText,
      });
    } finally {
      signalTarget.off("SIGINT", onSendSignal);
      signalTarget.off("SIGTERM", onSendSignal);
    }

    if (!sendRes.admitted) {
      if (options.json) {
        writeOut(io, `${JSON.stringify({ ...sendRes, ticket })}\n`);
      }
      writeErr(io, `错误 [${sendRes.error.code}]: ${sendRes.error.message}\n`);
      return 1;
    }

    if (noWait) {
      if (options.json) {
        writeOut(
          io,
          `${JSON.stringify({
            v: 1,
            state: "pending",
            admitted: true,
            ticket,
            conversationId,
            requestId,
            runId: sendRes.runId,
            ...(sendRes.replayed ? { replayed: true } : {}),
          })}\n`,
        );
      } else {
        writeOut(io, `${ticket}\n`);
      }
      return 2;
    }

    return await pollAndRenderProgramResult({
      facade: handle.facade,
      ticket,
      conversationId,
      requestId,
      waitSeconds,
      json: options.json,
      knownAdmitted: { runId: sendRes.runId },
      initiallyDetached: detachedDuringSend,
      io,
    });
  } catch (err) {
    const mapped = extractProgramError(err, {
      written: requestSent,
      priorAcceptancePossible: options.id !== undefined,
    });
    if (mapped.exitCode === 1 && !mapped.retryable) {
      return emitCliError(io, options.json, {
        ...mapped,
        exitCode: 1,
        extra: { admitted: false, ticket, conversationId, requestId },
      });
    }

    // Either host was unreachable, prior history could not be ruled out, or transport failed after writing: preserve ticket and exit 3!
    if (options.json) {
      writeOut(
        io,
        `${JSON.stringify({
          v: 1,
          state:
            requestSent && mapped.code === "unknown"
              ? "unknown"
              : "temporarily_unavailable",
          ticket,
          conversationId,
          requestId,
          error: {
            code: mapped.code,
            message: mapped.message,
            retryable: mapped.retryable,
          },
        })}\n`,
      );
    } else {
      writeOut(io, `${ticket}\n`);
    }
    writeErr(
      io,
      `待核对 [${mapped.code}]: ${mapped.message}（请凭票据执行 zz conversation result ${ticket} 核对，勿改号重发）\n`,
    );
    return 3;
  } finally {
    await handle?.dispose().catch(() => {});
  }
}

export async function runConversationResultCommand(
  ticketArg: string | undefined,
  options: {
    readonly to?: string;
    readonly id?: string;
    readonly wait?: string;
    readonly cursor?: string;
    readonly json?: boolean;
  },
  io: ConversationCommandRuntimeIO = {},
): Promise<number> {
  const hasTicket = ticketArg !== undefined;
  const hasExplicitPair = options.to !== undefined || options.id !== undefined;
  if ((hasTicket && hasExplicitPair) || (!hasTicket && !hasExplicitPair)) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "必须指定 <ticket>，或同时指定 --to <conversationId> 与 --id <requestId>（二者互斥）",
      retryable: false,
      exitCode: 1,
    });
  }
  if (options.cursor !== undefined && !options.json) {
    return emitCliError(io, options.json, {
      code: "invalid_params",
      message: "--cursor 仅用于 --json 分页续读；默认文本模式会自动跨页拼齐整篇回复",
      retryable: false,
      exitCode: 1,
    });
  }

  let waitSeconds = 0;
  if (options.wait !== undefined) {
    const parsed = parseWaitSeconds(options.wait);
    if (!parsed.ok) {
      return emitCliError(io, options.json, {
        code: "invalid_params",
        message: parsed.message,
        retryable: false,
        exitCode: 1,
      });
    }
    waitSeconds = parsed.value;
  }

  const zhixingHome = io.zhixingHome ?? getZhixingHome();
  const currentHomeId = await programHomeId(zhixingHome);
  let conversationId: string;
  let requestId: string;
  let canonicalTicket: string;

  if (ticketArg !== undefined) {
    const verified = verifyProgramConversationTicket(ticketArg, currentHomeId);
    if (!verified.ok) {
      return emitCliError(io, options.json, {
        code: verified.code,
        message: verified.message,
        retryable: false,
        exitCode: 1,
      });
    }
    conversationId = verified.payload.conversationId;
    requestId = verified.payload.requestId;
    canonicalTicket = ticketArg;
  } else {
    if (!options.to || !options.id) {
      return emitCliError(io, options.json, {
        code: "invalid_params",
        message: "使用显式定位时必须同时提供 --to <conversationId> 与 --id <requestId>",
        retryable: false,
        exitCode: 1,
      });
    }
    if (!isProtocolIdentifier(options.to) || !isProtocolIdentifier(options.id)) {
      return emitCliError(io, options.json, {
        code: "invalid_params",
        message: "--to 与 --id 必须是合法的协议标识符",
        retryable: false,
        exitCode: 1,
      });
    }
    conversationId = options.to;
    requestId = options.id;
    canonicalTicket = encodeProgramConversationTicket({
      homeId: currentHomeId,
      conversationId,
      requestId,
    });
  }

  let handle: ProgramConversationClientHandle | undefined;
  try {
    handle = await openProgramClient(io, zhixingHome);
    return await pollAndRenderProgramResult({
      facade: handle.facade,
      ticket: canonicalTicket,
      conversationId,
      requestId,
      waitSeconds,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      json: options.json,
      io,
    });
  } finally {
    await handle?.dispose().catch(() => {});
  }
}
