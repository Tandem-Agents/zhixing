import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  PROGRAM_MAX_WAIT_SLICE_MS,
  PROGRAM_SINGLE_FRAME_MAX_BYTES,
  ProgramConversationError,
  type ConversationDirectorySourceVersion,
  type ProgramConversationErrorCode,
  type ProgramConversationExistingEntry,
  type ProgramConversationListInput,
  type ProgramConversationListResult,
  type ProgramConversationNewInput,
  type ProgramConversationNewResult,
  type ProgramConversationReadInput,
  type ProgramConversationReadResult,
  type ProgramConversationResultInput,
  type ProgramConversationResultOutput,
  type ProgramConversationSendInput,
  type ProgramConversationSendResult,
  type RawDirectoryCandidate,
} from "@zhixing-ai/core/conversation/application";
import { canonicalize, isProtocolIdentifier } from "@zhixing-ai/core/protocol";
import { MeshProtocolError, type MeshServiceClient } from "@zhixing-ai/mesh";
import type { MeshServiceRegistry } from "@zhixing-ai/mesh/service-registry";
import { RPC_ERROR_CODES, RpcAppError } from "@zhixing-ai/server";
import { RpcClientError } from "@zhixing-ai/server/client";
import type { HostProgramConversationController } from "./program-conversation-host.js";

export const PROGRAM_CONVERSATION_MESH_SERVICE = "conversation.program";

export const PROGRAM_CONVERSATION_RPC_METHODS = Object.freeze([
  "conversation.program.list",
  "conversation.program.new",
  "conversation.program.read",
  "conversation.program.send",
  "conversation.program.result",
] as const);

const PROGRAM_RPC_METHOD_SET = new Set<string>(PROGRAM_CONVERSATION_RPC_METHODS);

export function isProgramConversationRpcMethod(method: string): boolean {
  return PROGRAM_RPC_METHOD_SET.has(method);
}

export type OwnedRichMetadata = Omit<
  ProgramConversationExistingEntry,
  "entryKind" | "canonicalKey" | "conversationId" | "scope" | "name" | "lastActiveAt"
>;

export interface OwnedDirectoryRecord {
  readonly candidate: Extract<RawDirectoryCandidate, { entryKind: "conversation" }>;
  readonly rich: OwnedRichMetadata;
}

export interface OwnedListRequest {
  readonly query?: string;
  readonly limit: number;
  readonly after?: {
    readonly lastActiveAt: string;
    readonly canonicalKey: string;
  };
}

export interface OwnedListResponse {
  readonly records: readonly OwnedDirectoryRecord[];
  readonly hasMore: boolean;
  readonly version: ConversationDirectorySourceVersion;
}

export interface OwnedProbeResponse {
  readonly state: "current" | "deleted" | "migrating" | "absent";
}

export interface ProgramConversationLocalOwnedHandler {
  ownedList(input: OwnedListRequest, signal?: AbortSignal): Promise<OwnedListResponse>;
  ownedProbe(conversationId: string, signal?: AbortSignal): Promise<OwnedProbeResponse>;
  ownedRead(
    input: ProgramConversationReadInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationReadResult>;
  ownedSend(
    input: ProgramConversationSendInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationSendResult>;
  ownedResult(
    input: ProgramConversationResultInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationResultOutput>;
}

export type ProgramConversationOwnedRemotePort = ProgramConversationLocalOwnedHandler;

export interface ProgramConversationEntryRemotePort {
  dispatchParamsByteLimit(method: string): number;
  dispatchRpc<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  list(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationListResult>;
  create(
    input: ProgramConversationNewInput,
    signal?: AbortSignal,
    creatorConversationId?: string,
  ): Promise<ProgramConversationNewResult>;
  read(
    input: ProgramConversationReadInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationReadResult>;
  send(
    input: ProgramConversationSendInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationSendResult>;
  result(
    input: ProgramConversationResultInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationResultOutput>;
  discoverInternal(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<HostProgramConversationController["discoverInternal"]>>>;
}

type EntryAction =
  | "list"
  | "new"
  | "read"
  | "send"
  | "result"
  | "cancel-wait"
  | "discover-internal";

type OwnedAction =
  | "owned-list"
  | "owned-probe"
  | "owned-read"
  | "owned-send"
  | "owned-result"
  | "owned-cancel-wait";

interface WireEntryCommand {
  readonly v: 1;
  readonly op: "entry";
  readonly action: EntryAction;
  readonly params: unknown;
  readonly creatorConversationId?: string;
  readonly waitId?: string;
}

interface WireOwnedCommand {
  readonly v: 1;
  readonly op: "owned";
  readonly action: OwnedAction;
  readonly params: unknown;
  readonly waitId?: string;
}

type WireCommand = WireEntryCommand | WireOwnedCommand;

interface WireErrorPayload {
  readonly code: ProgramConversationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly exitCode: 1 | 2 | 3;
  readonly leafAuthorityState?: string;
}

type WireResponse =
  | { readonly v: 1; readonly ok: true; readonly result: unknown }
  | { readonly v: 1; readonly ok: false; readonly error: WireErrorPayload };

const ENTRY_ACTIONS = new Set<string>([
  "list",
  "new",
  "read",
  "send",
  "result",
  "cancel-wait",
  "discover-internal",
]);

const OWNED_ACTIONS = new Set<string>([
  "owned-list",
  "owned-probe",
  "owned-read",
  "owned-send",
  "owned-result",
  "owned-cancel-wait",
]);

function encodeFrame(value: WireCommand | WireResponse): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function decodeFrame(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateWireCommand(raw: unknown): WireCommand {
  if (!isPlainObject(raw) || raw.v !== 1 || typeof raw.op !== "string") {
    throw new ProgramConversationError(
      "invalid_params",
      "conversation.program 协议帧格式无效",
      { retryable: false, exitCode: 1 },
    );
  }
  const keys = Object.keys(raw).sort();
  if (raw.op === "entry") {
    const allowed = [
      "action",
      ...(raw.creatorConversationId !== undefined ? ["creatorConversationId"] : []),
      "op",
      "params",
      "v",
      ...(raw.waitId !== undefined ? ["waitId"] : []),
    ].sort();
    if (
      canonicalize(keys) !== canonicalize(allowed) ||
      typeof raw.action !== "string" ||
      !ENTRY_ACTIONS.has(raw.action)
    ) {
      throw new ProgramConversationError(
        "invalid_params",
        "conversation.program entry 请求结构无效",
        { retryable: false, exitCode: 1 },
      );
    }
    if (
      raw.creatorConversationId !== undefined &&
      (typeof raw.creatorConversationId !== "string" ||
        !isProtocolIdentifier(raw.creatorConversationId) ||
        raw.action !== "new")
    ) {
      throw new ProgramConversationError(
        "invalid_params",
        "creatorConversationId 仅允许用于内部受控 new 操作",
        { retryable: false, exitCode: 1 },
      );
    }
    if (
      raw.waitId !== undefined &&
      (typeof raw.waitId !== "string" ||
        !isProtocolIdentifier(raw.waitId) ||
        raw.action !== "result")
    ) {
      throw new ProgramConversationError(
        "invalid_params",
        "waitId 仅允许用于 result 观察等待操作",
        { retryable: false, exitCode: 1 },
      );
    }
    return raw as unknown as WireEntryCommand;
  }
  if (raw.op === "owned") {
    const allowed = [
      "action",
      "op",
      "params",
      "v",
      ...(raw.waitId !== undefined ? ["waitId"] : []),
    ].sort();
    if (
      canonicalize(keys) !== canonicalize(allowed) ||
      typeof raw.action !== "string" ||
      !OWNED_ACTIONS.has(raw.action)
    ) {
      throw new ProgramConversationError(
        "invalid_params",
        "conversation.program owned 请求结构无效",
        { retryable: false, exitCode: 1 },
      );
    }
    if (
      raw.waitId !== undefined &&
      (typeof raw.waitId !== "string" ||
        !isProtocolIdentifier(raw.waitId) ||
        raw.action !== "owned-result")
    ) {
      throw new ProgramConversationError(
        "invalid_params",
        "waitId 仅允许用于 owned-result 观察等待操作",
        { retryable: false, exitCode: 1 },
      );
    }
    return raw as unknown as WireOwnedCommand;
  }
  throw new ProgramConversationError(
    "invalid_params",
    "conversation.program 操作类型未知",
    { retryable: false, exitCode: 1 },
  );
}

function toWireError(err: unknown): WireErrorPayload {
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
    const leafState = err.options?.details?.leafAuthorityState;
    return {
      code: err.code,
      message: err.message,
      retryable,
      exitCode,
      ...(typeof leafState === "string" ? { leafAuthorityState: leafState } : {}),
    };
  }
  return {
    code: "temporarily_unavailable",
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
    exitCode: 3,
  };
}

function encodeBoundedResponse(response: WireResponse): Uint8Array {
  const encoded = encodeFrame(response);
  if (encoded.byteLength <= PROGRAM_SINGLE_FRAME_MAX_BYTES) {
    return encoded;
  }
  return encodeFrame({
    v: 1,
    ok: false,
    error: {
      code: "payload_too_large",
      message: `conversation.program 响应超出 1 MiB 单帧上限 (${encoded.byteLength} bytes)`,
      retryable: false,
      exitCode: 1,
    },
  });
}

function clampWaitInput(params: unknown): ProgramConversationResultInput {
  if (!isPlainObject(params)) {
    throw new ProgramConversationError("invalid_params", "result 参数无效", {
      retryable: false,
      exitCode: 1,
    });
  }
  if (
    typeof params.conversationId !== "string" ||
    !isProtocolIdentifier(params.conversationId) ||
    typeof params.requestId !== "string" ||
    !isProtocolIdentifier(params.requestId)
  ) {
    throw new ProgramConversationError(
      "invalid_params",
      "result 需要合法的 conversationId 与 requestId",
      { retryable: false, exitCode: 1 },
    );
  }
  const rawWait = params.waitMs;
  const waitMs =
    rawWait === undefined
      ? 0
      : typeof rawWait === "number" && Number.isFinite(rawWait) && rawWait >= 0
        ? Math.min(Math.floor(rawWait), PROGRAM_MAX_WAIT_SLICE_MS)
        : -1;
  if (waitMs < 0) {
    throw new ProgramConversationError("invalid_params", "waitMs 参数无效", {
      retryable: false,
      exitCode: 1,
    });
  }
  if (params.cursor !== undefined && typeof params.cursor !== "string") {
    throw new ProgramConversationError("invalid_params", "cursor 参数无效", {
      retryable: false,
      exitCode: 1,
    });
  }
  return {
    conversationId: params.conversationId,
    requestId: params.requestId,
    waitMs,
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
}

export interface RegisterProgramConversationMeshOptions {
  readonly registry: MeshServiceRegistry;
  readonly isActiveMember: (deviceId: string) => boolean;
  readonly peerHasRole: (deviceId: string, role: "anchor" | "executor" | "surface") => boolean;
  readonly isCurrentAnchor: () => boolean;
  readonly currentAnchorDeviceId: () => string;
  readonly isAnchorReady?: () => boolean;
  readonly anchorCoordinator?: () => HostProgramConversationController | undefined;
  readonly localOwned?: () => ProgramConversationLocalOwnedHandler | undefined;
  readonly onActivity?: () => void;
}

/**
 * Registers the singleton versioned `conversation.program` service at most once per Mesh node.
 * Strictly separates `op: "entry"` (current Anchor only) and `op: "owned"` (localConversationOwner
 * from verified current Anchor only).
 */
export function registerProgramConversationMeshService(
  options: RegisterProgramConversationMeshOptions,
): () => void {
  const activeWaits = new Map<string, AbortController>();
  const recentlyCancelledWaits = new Map<string, number>();

  const pruneCancelledWaits = (now: number) => {
    for (const [k, ts] of recentlyCancelledWaits) {
      if (now - ts > 30_000) recentlyCancelledWaits.delete(k);
    }
    while (recentlyCancelledWaits.size > 256) {
      const oldest = recentlyCancelledWaits.keys().next().value;
      if (oldest === undefined) break;
      recentlyCancelledWaits.delete(oldest);
    }
  };

  const cancelPeerWait = (peerId: string, params: unknown) => {
    if (
      !isPlainObject(params) ||
      typeof params.waitId !== "string" ||
      !isProtocolIdentifier(params.waitId)
    ) {
      throw new ProgramConversationError(
        "invalid_params",
        "cancel-wait 需要合法的 waitId",
        { retryable: false, exitCode: 1 },
      );
    }
    const waitKey = `${peerId}:${params.waitId}`;
    const ctrl = activeWaits.get(waitKey);
    if (ctrl) {
      ctrl.abort();
      return { cancelled: true };
    }
    const now = Date.now();
    pruneCancelledWaits(now);
    recentlyCancelledWaits.set(waitKey, now);
    return { cancelled: false };
  };

  const runCancellableWait = async <T>(
    peerId: string,
    waitId: string | undefined,
    baseSignal: AbortSignal,
    fn: (sig: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (!waitId) return fn(baseSignal);
    const waitKey = `${peerId}:${waitId}`;
    const ctrl = new AbortController();
    const onBaseAbort = () => ctrl.abort();
    if (baseSignal.aborted || recentlyCancelledWaits.delete(waitKey)) {
      ctrl.abort();
    } else {
      baseSignal.addEventListener("abort", onBaseAbort, { once: true });
    }
    activeWaits.set(waitKey, ctrl);
    try {
      return await fn(ctrl.signal);
    } finally {
      activeWaits.delete(waitKey);
      baseSignal.removeEventListener("abort", onBaseAbort);
    }
  };

  return options.registry.register(PROGRAM_CONVERSATION_MESH_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => options.isActiveMember(connection.peer.deviceId),
    handler: async (payload, connection, signal) => {
      try {
        const peerId = connection.peer.deviceId;
        if (!options.isActiveMember(peerId)) {
          throw new ProgramConversationError(
            "unauthorized",
            "对端设备不在当前家庭活跃信任成员中",
            { retryable: false, exitCode: 1 },
          );
        }
        const cmd = validateWireCommand(decodeFrame(payload));

        if (cmd.op === "entry") {
          const coordinator = options.anchorCoordinator?.();
          if (!options.isCurrentAnchor() || !coordinator) {
            throw new ProgramConversationError(
              "unauthorized",
              "仅当值主控（Anchor）节点可受理 conversation.program entry 操作",
              { retryable: false, exitCode: 1 },
            );
          }
          if (options.isAnchorReady?.() === false) {
            throw new ProgramConversationError(
              "temporarily_unavailable",
              "当值主控设备正在完成权威迁移恢复，请稍后重试",
              { retryable: true, exitCode: 3 },
            );
          }
          const peerIsInternalHost =
            options.peerHasRole(peerId, "executor") ||
            options.peerHasRole(peerId, "anchor");

          if (
            (cmd.action === "discover-internal" ||
              cmd.creatorConversationId !== undefined) &&
            !peerIsInternalHost
          ) {
            throw new ProgramConversationError(
              "unauthorized",
              "仅配对宿主角色可调用内部会话发现或带源会话新建",
              { retryable: false, exitCode: 1 },
            );
          }

          options.onActivity?.();
          let result: unknown;
          switch (cmd.action) {
            case "list":
              result = await coordinator.list(
                (isPlainObject(cmd.params) ? cmd.params : {}) as ProgramConversationListInput,
                signal,
              );
              break;
            case "discover-internal":
              result = await coordinator.discoverInternal(
                (isPlainObject(cmd.params) ? cmd.params : {}) as ProgramConversationListInput,
                signal,
              );
              break;
            case "new": {
              if (!isPlainObject(cmd.params) || typeof cmd.params.requestId !== "string") {
                throw new ProgramConversationError(
                  "invalid_params",
                  "new 需要合法的 requestId",
                  { retryable: false, exitCode: 1 },
                );
              }
              const newInput = cmd.params as unknown as ProgramConversationNewInput;
              result = cmd.creatorConversationId
                ? await coordinator.createForPrincipal(
                    `conversation:${cmd.creatorConversationId}`,
                    newInput,
                    signal,
                  )
                : await coordinator.create(newInput, signal);
              break;
            }
            case "read": {
              if (!isPlainObject(cmd.params) || typeof cmd.params.conversationId !== "string") {
                throw new ProgramConversationError(
                  "invalid_params",
                  "read 需要合法的 conversationId",
                  { retryable: false, exitCode: 1 },
                );
              }
              result = await coordinator.read(
                cmd.params as unknown as ProgramConversationReadInput,
                signal,
              );
              break;
            }
            case "send": {
              if (
                !isPlainObject(cmd.params) ||
                typeof cmd.params.conversationId !== "string" ||
                typeof cmd.params.requestId !== "string" ||
                typeof cmd.params.text !== "string"
              ) {
                throw new ProgramConversationError(
                  "invalid_params",
                  "send 需要合法的 conversationId、requestId 与 text",
                  { retryable: false, exitCode: 1 },
                );
              }
              result = await coordinator.send(
                cmd.params as unknown as ProgramConversationSendInput,
                signal,
              );
              break;
            }
            case "result":
              result = await runCancellableWait(
                peerId,
                cmd.waitId,
                signal,
                (waitSignal) =>
                  coordinator.result(clampWaitInput(cmd.params), waitSignal),
              );
              break;
            case "cancel-wait":
              result = cancelPeerWait(peerId, cmd.params);
              break;
          }
          options.onActivity?.();
          return encodeBoundedResponse({ v: 1, ok: true, result });
        }

        // cmd.op === "owned"
        const localOwned = options.localOwned?.();
        if (
          !localOwned ||
          peerId !== options.currentAnchorDeviceId() ||
          !options.peerHasRole(peerId, "anchor")
        ) {
          throw new ProgramConversationError(
            "unauthorized",
            "conversation.program owned 操作仅允许当值主控向持有本机对话权威的执行节点发起",
            { retryable: false, exitCode: 1 },
          );
        }

        if (cmd.action === "owned-send") {
          options.onActivity?.();
        }

        let result: unknown;
        switch (cmd.action) {
          case "owned-list": {
            if (!isPlainObject(cmd.params) || typeof cmd.params.limit !== "number") {
              throw new ProgramConversationError(
                "invalid_params",
                "owned-list 参数无效",
                { retryable: false, exitCode: 1 },
              );
            }
            result = await localOwned.ownedList(
              cmd.params as unknown as OwnedListRequest,
              signal,
            );
            break;
          }
          case "owned-probe": {
            if (
              !isPlainObject(cmd.params) ||
              typeof cmd.params.conversationId !== "string" ||
              !isProtocolIdentifier(cmd.params.conversationId)
            ) {
              throw new ProgramConversationError(
                "invalid_params",
                "owned-probe 需要合法的 conversationId",
                { retryable: false, exitCode: 1 },
              );
            }
            result = await localOwned.ownedProbe(cmd.params.conversationId, signal);
            break;
          }
          case "owned-read": {
            if (!isPlainObject(cmd.params) || typeof cmd.params.conversationId !== "string") {
              throw new ProgramConversationError(
                "invalid_params",
                "owned-read 参数无效",
                { retryable: false, exitCode: 1 },
              );
            }
            result = await localOwned.ownedRead(
              cmd.params as unknown as ProgramConversationReadInput,
              signal,
            );
            break;
          }
          case "owned-send": {
            if (
              !isPlainObject(cmd.params) ||
              typeof cmd.params.conversationId !== "string" ||
              typeof cmd.params.requestId !== "string" ||
              typeof cmd.params.text !== "string"
            ) {
              throw new ProgramConversationError(
                "invalid_params",
                "owned-send 参数无效",
                { retryable: false, exitCode: 1 },
              );
            }
            result = await localOwned.ownedSend(
              cmd.params as unknown as ProgramConversationSendInput,
              signal,
            );
            options.onActivity?.();
            break;
          }
          case "owned-result":
            result = await runCancellableWait(
              peerId,
              cmd.waitId,
              signal,
              (waitSignal) =>
                localOwned.ownedResult(clampWaitInput(cmd.params), waitSignal),
            );
            break;
          case "owned-cancel-wait":
            result = cancelPeerWait(peerId, cmd.params);
            break;
        }
        return encodeBoundedResponse({ v: 1, ok: true, result });
      } catch (err) {
        return encodeBoundedResponse({
          v: 1,
          ok: false,
          error: toWireError(err),
        });
      }
    },
  });
}

function methodToEntryAction(
  method: string,
): Exclude<EntryAction, "discover-internal" | "cancel-wait"> {
  switch (method) {
    case "conversation.program.list":
      return "list";
    case "conversation.program.new":
      return "new";
    case "conversation.program.read":
      return "read";
    case "conversation.program.send":
      return "send";
    case "conversation.program.result":
      return "result";
    default:
      throw new TypeError(`Unsupported conversation.program RPC method: ${method}`);
  }
}

function toProgramErrorFromWire(error: WireErrorPayload): ProgramConversationError {
  return new ProgramConversationError(error.code, error.message, {
    retryable: error.retryable,
    exitCode: error.exitCode,
    ...(error.leafAuthorityState
      ? { details: { leafAuthorityState: error.leafAuthorityState } }
      : {}),
  });
}

function extractMeshErrorCode(err: unknown): string | undefined {
  if (err instanceof MeshProtocolError) return err.code;
  if (
    err instanceof Error &&
    err.name === "MeshProtocolError" &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    return (err as unknown as { code: string }).code;
  }
  return undefined;
}

function toProgramErrorFromMesh(err: unknown, written: boolean): ProgramConversationError {
  if (err instanceof ProgramConversationError) return err;
  const meshCode = extractMeshErrorCode(err);
  if (meshCode !== undefined) {
    if (meshCode === "incompatible-version" && !written) {
      return new ProgramConversationError(
        "unsupported_host_version",
        "目标知行节点版本不支持 conversation.program 服务",
        { retryable: false, exitCode: 1 },
      );
    }
    if (meshCode === "unauthorized-peer" && !written) {
      return new ProgramConversationError(
        "unauthorized",
        "对端节点拒绝了当前设备的组网授权",
        { retryable: false, exitCode: 1 },
      );
    }
    return new ProgramConversationError(
      written ? "unknown" : "temporarily_unavailable",
      `跨设备会话服务暂不可用 (${meshCode}: ${err instanceof Error ? err.message : String(err)})`,
      { retryable: true, exitCode: 3 },
    );
  }
  return new ProgramConversationError(
    written ? "unknown" : "temporarily_unavailable",
    err instanceof Error ? err.message : String(err),
    { retryable: true, exitCode: 3 },
  );
}

export class ProgramConversationMeshClient
  implements ProgramConversationEntryRemotePort, ProgramConversationOwnedRemotePort
{
  constructor(private readonly client: () => MeshServiceClient) {}

  dispatchParamsByteLimit(method: string): number {
    const action = methodToEntryAction(method);
    const entryEnvelope: WireEntryCommand = {
      v: 1,
      op: "entry",
      action,
      params: null,
    };
    const entryOverhead =
      Buffer.byteLength(JSON.stringify(entryEnvelope), "utf8") - 4;
    const ownedOverhead =
      action === "send" || action === "read" || action === "result"
        ? Buffer.byteLength(
            JSON.stringify({
              v: 1,
              op: "owned",
              action: `owned-${action}`,
              params: null,
            }),
            "utf8",
          ) - 4
        : 0;
    // Deduct outer Mesh envelope overhead across entry + owned hops plus 256B framing safety margin.
    return (
      PROGRAM_SINGLE_FRAME_MAX_BYTES -
      Math.max(entryOverhead, ownedOverhead) -
      256
    );
  }

  async #sendCommand<T>(
    cmd: WireCommand,
    signal?: AbortSignal,
    mutating = false,
  ): Promise<T> {
    const waitId =
      signal && (cmd.action === "result" || cmd.action === "owned-result")
        ? `wait-${randomUUID()}`
        : undefined;
    const wireCmd: WireCommand = waitId ? { ...cmd, waitId } : cmd;
    const encoded = encodeFrame(wireCmd);
    if (encoded.byteLength > PROGRAM_SINGLE_FRAME_MAX_BYTES) {
      throw new ProgramConversationError(
        "payload_too_large",
        `跨设备请求超出 1 MiB 单帧净荷上限 (${encoded.byteLength} bytes > ${PROGRAM_SINGLE_FRAME_MAX_BYTES} bytes)`,
        { retryable: false, exitCode: 1 },
      );
    }
    const onCallerAbort =
      waitId && signal
        ? () => {
            const cancelFrame: WireCommand =
              cmd.op === "entry"
                ? { v: 1, op: "entry", action: "cancel-wait", params: { waitId } }
                : {
                    v: 1,
                    op: "owned",
                    action: "owned-cancel-wait",
                    params: { waitId },
                  };
            void Promise.resolve()
              .then(() =>
                this.client().request(
                  PROGRAM_CONVERSATION_MESH_SERVICE,
                  encodeFrame(cancelFrame),
                ),
              )
              .catch(() => undefined);
          }
        : undefined;
    if (onCallerAbort && signal) {
      if (signal.aborted) {
        onCallerAbort();
      } else {
        signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    let rawReply: Uint8Array;
    try {
      rawReply = await this.client().request(
        PROGRAM_CONVERSATION_MESH_SERVICE,
        encoded,
        signal,
      );
    } catch (err) {
      // Notice: `incompatible-version` fails during service capability check BEFORE frame delivery;
      // other Mesh transport errors (`service-unavailable`, `connection-closed`, `request-timeout`)
      // on mutating commands cannot rule out remote delivery, so mark `written = mutating`.
      const meshCode = extractMeshErrorCode(err);
      const isPreSendNegotiationError =
        meshCode === "incompatible-version" || meshCode === "unauthorized-peer";
      throw toProgramErrorFromMesh(err, mutating && !isPreSendNegotiationError);
    } finally {
      if (onCallerAbort && signal) {
        signal.removeEventListener("abort", onCallerAbort);
      }
    }
    const decoded = decodeFrame(rawReply);
    if (
      !isPlainObject(decoded) ||
      decoded.v !== 1 ||
      typeof decoded.ok !== "boolean"
    ) {
      throw new ProgramConversationError(
        mutating ? "unknown" : "temporarily_unavailable",
        "对端返回了无法解析的 conversation.program 响应",
        { retryable: true, exitCode: 3 },
      );
    }
    if (!decoded.ok) {
      const errObj = decoded.error;
      if (
        !isPlainObject(errObj) ||
        typeof errObj.code !== "string" ||
        typeof errObj.message !== "string"
      ) {
        throw new ProgramConversationError(
          mutating ? "unknown" : "temporarily_unavailable",
          "对端返回了格式异常的错误载荷",
          { retryable: true, exitCode: 3 },
        );
      }
      throw toProgramErrorFromWire({
        code: errObj.code as ProgramConversationErrorCode,
        message: errObj.message,
        retryable: errObj.retryable === true,
        exitCode:
          errObj.exitCode === 1 || errObj.exitCode === 2 || errObj.exitCode === 3
            ? errObj.exitCode
            : errObj.retryable === true
              ? 3
              : 1,
        ...(typeof errObj.leafAuthorityState === "string"
          ? { leafAuthorityState: errObj.leafAuthorityState }
          : {}),
      });
    }
    return decoded.result as T;
  }

  async dispatchRpc<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const action = methodToEntryAction(method);
    const mutating = action === "new" || action === "send";
    try {
      let forwardedParams = params ?? {};
      if (action === "result" && isPlainObject(forwardedParams) && typeof forwardedParams.waitMs === "number") {
        // Deduct modest client-side framing margin so multi-hop wait stays safely within 30s channel timeout
        forwardedParams = {
          ...forwardedParams,
          waitMs: Math.max(0, Math.min(PROGRAM_MAX_WAIT_SLICE_MS, forwardedParams.waitMs)),
        };
      }
      return await this.#sendCommand<T>(
        {
          v: 1,
          op: "entry",
          action,
          params: forwardedParams,
        },
        signal,
        mutating,
      );
    } catch (err) {
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
        const rpcCode =
          err.code === "unsupported_host_version"
            ? RPC_ERROR_CODES.METHOD_NOT_FOUND
            : err.code === "unauthorized"
              ? RPC_ERROR_CODES.UNAUTHORIZED
              : err.code === "invalid_params" ||
                  err.code === "invalid_cursor" ||
                  err.code === "invalid_ticket" ||
                  err.code === "payload_too_large" ||
                  err.code === "idempotency_conflict"
                ? RPC_ERROR_CODES.INVALID_PARAMS
                : RPC_ERROR_CODES.INTERNAL_ERROR;
        // Throw RpcClientError (with RpcAppError shape compatibility) so CLI extractProgramError
        // and CurrentAnchorSurfaceRpcClient both preserve structured `programError` data!
        throw new RpcClientError(rpcCode, err.message, {
          programError: {
            code: err.code,
            retryable,
            exitCode,
          },
        });
      }
      throw new RpcAppError(
        RPC_ERROR_CODES.INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  list(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationListResult> {
    return this.#sendCommand(
      { v: 1, op: "entry", action: "list", params: input },
      signal,
      false,
    );
  }

  create(
    input: ProgramConversationNewInput,
    signal?: AbortSignal,
    creatorConversationId?: string,
  ): Promise<ProgramConversationNewResult> {
    return this.#sendCommand(
      {
        v: 1,
        op: "entry",
        action: "new",
        params: input,
        ...(creatorConversationId ? { creatorConversationId } : {}),
      },
      signal,
      true,
    );
  }

  read(
    input: ProgramConversationReadInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationReadResult> {
    return this.#sendCommand(
      { v: 1, op: "entry", action: "read", params: input },
      signal,
      false,
    );
  }

  send(
    input: ProgramConversationSendInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationSendResult> {
    return this.#sendCommand(
      { v: 1, op: "entry", action: "send", params: input },
      signal,
      true,
    );
  }

  result(
    input: ProgramConversationResultInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationResultOutput> {
    return this.#sendCommand(
      { v: 1, op: "entry", action: "result", params: input },
      signal,
      false,
    );
  }

  discoverInternal(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<HostProgramConversationController["discoverInternal"]>>> {
    return this.#sendCommand(
      { v: 1, op: "entry", action: "discover-internal", params: input },
      signal,
      false,
    );
  }

  ownedList(input: OwnedListRequest, signal?: AbortSignal): Promise<OwnedListResponse> {
    return this.#sendCommand(
      { v: 1, op: "owned", action: "owned-list", params: input },
      signal,
      false,
    );
  }

  ownedProbe(conversationId: string, signal?: AbortSignal): Promise<OwnedProbeResponse> {
    return this.#sendCommand(
      { v: 1, op: "owned", action: "owned-probe", params: { conversationId } },
      signal,
      false,
    );
  }

  ownedRead(
    input: ProgramConversationReadInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationReadResult> {
    return this.#sendCommand(
      { v: 1, op: "owned", action: "owned-read", params: input },
      signal,
      false,
    );
  }

  ownedSend(
    input: ProgramConversationSendInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationSendResult> {
    return this.#sendCommand(
      { v: 1, op: "owned", action: "owned-send", params: input },
      signal,
      true,
    );
  }

  ownedResult(
    input: ProgramConversationResultInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationResultOutput> {
    return this.#sendCommand(
      { v: 1, op: "owned", action: "owned-result", params: input },
      signal,
      false,
    );
  }
}
