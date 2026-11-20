/**
 * 四协议适配器共享的来源身份、协议状态构造、绑定秘密收集与错误规范化/脱敏辅助函数（单一规则源）。
 */

import {
  isThinkingProtocolState,
  MAX_PROTOCOL_STATE_OPAQUE_BYTES,
  type ModelAdapterId,
  type TextProtocolState,
  type ThinkingProtocolState,
  type ThinkingSourceTarget,
} from "@zhixing-ai/core";
import {
  classifyProviderErrorDetail,
  isResponseStreamInterrupted,
  markRequestUndelivered,
  markResponseStreamInterrupted,
  sanitizeProviderErrorMessage,
} from "@zhixing-ai/core/resilience";
import { computeSourceOriginKey } from "../resolve.js";
import type { ResolvedProvider } from "../types.js";
import { provenUndelivered, type DeliveryRecord } from "./delivery-transport.js";

export interface AdapterProvenance {
  readonly protocol: ModelAdapterId;
  readonly sourceConnectionId: string;
  readonly sourceOriginKey: string;
}

export function resolveAdapterProvenance(
  resolved: ResolvedProvider,
  protocol: ModelAdapterId,
): AdapterProvenance {
  const sourceConnectionId = resolved.connectionId ?? resolved.id;
  const sourceOriginKey =
    resolved.sourceOriginKey ?? computeSourceOriginKey(resolved.baseUrl, protocol);
  return { protocol, sourceConnectionId, sourceOriginKey };
}

/**
 * 收集当前连接实际绑定的秘密原值，用于在适配器错误边界精确脱敏（覆盖无厂商前缀的自定义 Key 与自定义认证头值）。
 */
export function collectBoundSecrets(resolved: ResolvedProvider): readonly string[] {
  const secrets: string[] = [];
  if (typeof resolved.apiKey === "string" && resolved.apiKey.trim().length > 0) {
    secrets.push(resolved.apiKey.trim());
  }
  return secrets;
}

export function buildThinkingProtocolState(
  provenance: AdapterProvenance,
  sourceModel: string,
  extra?: {
    readonly signature?: string;
    readonly encryptedContent?: string;
    readonly opaqueStep?: string;
  },
): ThinkingProtocolState {
  return {
    protocol: provenance.protocol,
    sourceConnectionId: provenance.sourceConnectionId,
    sourceOriginKey: provenance.sourceOriginKey,
    sourceModel,
    payloadVersion: 1,
    ...(extra?.signature ? { signature: extra.signature } : {}),
    ...(extra?.encryptedContent ? { encryptedContent: extra.encryptedContent } : {}),
    ...(extra?.opaqueStep ? { opaqueStep: extra.opaqueStep } : {}),
  };
}

const MAX_SIGNATURE_BYTES = 65_536;

/**
 * 单一入站协议私有思考状态有界校验边界（设计 §2.3）：
 * 拒绝任何超出字节/字符上限或破坏封闭结构的载荷，绝不静默丢弃原生结构以伪造保真。
 */
export function validateInboundThinkingProtocolState(
  state: ThinkingProtocolState,
): string | null {
  if (
    state.signature !== undefined &&
    Buffer.byteLength(state.signature, "utf8") > MAX_SIGNATURE_BYTES
  ) {
    return `protocol_state_limit_exceeded: 协议私有思考签名超过有界上限（${MAX_SIGNATURE_BYTES} 字节），已中止本轮并保留可见部分输出`;
  }
  if (
    state.encryptedContent !== undefined &&
    Buffer.byteLength(state.encryptedContent, "utf8") > MAX_PROTOCOL_STATE_OPAQUE_BYTES
  ) {
    return `protocol_state_limit_exceeded: 协议私有思考加密态超过有界上限（${MAX_PROTOCOL_STATE_OPAQUE_BYTES} 字节），已中止本轮并保留可见部分输出`;
  }
  if (
    state.opaqueStep !== undefined &&
    Buffer.byteLength(state.opaqueStep, "utf8") > MAX_PROTOCOL_STATE_OPAQUE_BYTES
  ) {
    return `protocol_state_limit_exceeded: 协议私有思考状态超过有界上限（${MAX_PROTOCOL_STATE_OPAQUE_BYTES} 字节），已中止本轮并保留可见部分输出`;
  }
  if (!isThinkingProtocolState(state)) {
    return "protocol_state_limit_exceeded: 协议私有思考状态不符合封闭有界契约，已中止本轮并保留可见部分输出";
  }
  return null;
}

export function isSameTextProtocolSource(
  state: TextProtocolState | undefined,
  target: ThinkingSourceTarget,
): boolean {
  if (!state) return false;
  return (
    state.protocol === target.protocol &&
    state.sourceConnectionId === target.sourceConnectionId &&
    state.sourceOriginKey === target.sourceOriginKey
  );
}

const SAFE_MACHINE_CODE_RE = /^[A-Za-z][A-Za-z0-9._-]{1,64}$/u;

function isSafeMachineCode(value: unknown, boundSecrets: readonly string[]): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!SAFE_MACHINE_CODE_RE.test(trimmed)) return false;
  // 绝不把绑定秘密原值（哪怕形似标识符）当作安全错误码透出
  for (const secret of boundSecrets) {
    if (secret && (trimmed === secret || trimmed.includes(secret) || secret.includes(trimmed))) {
      return false;
    }
  }
  return true;
}

interface SafeStructuredErrorMetadata {
  readonly status?: number;
  readonly code?: string;
  readonly errorStatus?: string;
  readonly reason?: string;
  readonly safeTags: readonly string[];
}

function extractSafeStructuredMetadata(
  err: unknown,
  boundSecrets: readonly string[],
): SafeStructuredErrorMetadata {
  let status: number | undefined;
  let code: string | undefined;
  let errorStatus: string | undefined;
  let reason: string | undefined;
  const tagSet = new Set<string>();

  const recordTag = (val: unknown): void => {
    if (isSafeMachineCode(val, boundSecrets)) {
      tagSet.add(val.trim());
    }
  };

  let current: unknown = err;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const rec = current as Record<string, unknown>;
    if (status === undefined) {
      const s = rec["status"] ?? rec["statusCode"];
      if (typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599) {
        status = s;
      }
    }
    if (code === undefined && isSafeMachineCode(rec["code"], boundSecrets)) {
      code = rec["code"].trim();
    }
    if (errorStatus === undefined && isSafeMachineCode(rec["errorStatus"], boundSecrets)) {
      errorStatus = rec["errorStatus"].trim();
    }
    if (reason === undefined && isSafeMachineCode(rec["reason"], boundSecrets)) {
      reason = rec["reason"].trim();
    }
    recordTag(rec["code"]);
    recordTag(rec["errorStatus"]);
    recordTag(rec["reason"]);

    const nested = rec["error"];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nrec = nested as Record<string, unknown>;
      if (code === undefined && isSafeMachineCode(nrec["code"], boundSecrets)) {
        code = nrec["code"].trim();
      }
      if (errorStatus === undefined && isSafeMachineCode(nrec["status"], boundSecrets)) {
        errorStatus = nrec["status"].trim();
      }
      if (reason === undefined && isSafeMachineCode(nrec["reason"], boundSecrets)) {
        reason = nrec["reason"].trim();
      }
      recordTag(nrec["code"]);
      recordTag(nrec["status"]);
      recordTag(nrec["reason"]);
      const details = nrec["details"];
      if (Array.isArray(details)) {
        for (const item of details.slice(0, 4)) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const dr = item as Record<string, unknown>;
            if (reason === undefined && isSafeMachineCode(dr["reason"], boundSecrets)) {
              reason = dr["reason"].trim();
            }
            recordTag(dr["reason"]);
          }
        }
      }
    }

    current = rec["cause"];
  }

  return {
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    ...(errorStatus ? { errorStatus } : {}),
    ...(reason ? { reason } : {}),
    safeTags: [...tagSet],
  };
}

/**
 * 统一规范化并脱敏适配器捕获到的 SDK / HTTP / 传输错误：
 * - 先对结构化原始错误分类（获取 403 精确子原因），再精确脱敏本次连接绑定秘密原值（含无厂商前缀密钥）与通用凭据形态；
 * - 将 HTTP 状态码与安全结构化错误码/子原因显式写入规范化文本（例如 `HTTP 403 (model_access_denied): ...`），
 *   保证经 AgentError → RPC 字符串投影到达 CLI `modelFailureText` 时不降级为 generic；
 * - 返回洁净脱敏的新 Error，不挂接未脱敏原始 SDK `error`/`cause` 防止秘密经对象链泄露；
 * - 保留流截断不可重放标记与受控传输未送达标记。
 */
export function normalizeAdapterError(
  err: unknown,
  delivery: DeliveryRecord,
  boundSecrets: readonly string[] = [],
): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  const detailBeforeScrub = classifyProviderErrorDetail(err);
  const meta = extractSafeStructuredMetadata(err, boundSecrets);
  const status = meta.status ?? detailBeforeScrub.status;

  const rawMessage = base.message || String(err);
  let sanitized = sanitizeProviderErrorMessage(rawMessage, boundSecrets);

  const missingTags = meta.safeTags.filter(
    (tag) => !sanitized.toLowerCase().includes(tag.toLowerCase()),
  );

  // 若 403 具备已识别的结构化子原因但现有标签+正文仍无法让字符串分类保持一致，则追加安全子原因标识
  if (
    status === 403 &&
    detailBeforeScrub.subcode !== "forbidden_generic" &&
    detailBeforeScrub.subcode.startsWith("forbidden_")
  ) {
    const preview =
      missingTags.length > 0
        ? `HTTP 403 (${missingTags.join(" / ")}): ${sanitized}`
        : `HTTP 403: ${sanitized}`;
    if (classifyProviderErrorDetail(preview).subcode !== detailBeforeScrub.subcode) {
      missingTags.push(detailBeforeScrub.subcode);
    }
  }

  const tagClause = missingTags.length > 0 ? ` (${missingTags.join(" / ")})` : "";
  if (status !== undefined) {
    const hasStatusPrefix = new RegExp(`\\b(?:HTTP\\s+)?${status}\\b`, "iu").test(sanitized);
    if (!hasStatusPrefix) {
      sanitized = `HTTP ${status}${tagClause}: ${sanitized}`;
    } else if (tagClause) {
      // 将缺失的安全结构化子码插入到已有的状态码提示之后，供字符串消费者准确分类
      sanitized = sanitized.replace(
        new RegExp(`((?:HTTP\\s+)?${status})`, "iu"),
        `$1${tagClause}`,
      );
    }
  } else if (tagClause) {
    sanitized = `${missingTags.join(" / ")}: ${sanitized}`;
  }

  const wrapped: Error =
    base.name === "AbortError"
      ? (new DOMException(sanitized, "AbortError") as unknown as Error)
      : new Error(sanitized);
  if (base.name && base.name !== "AbortError" && !(wrapped instanceof DOMException)) {
    wrapped.name = base.name;
  }

  const targetRec = wrapped as unknown as Record<string, unknown>;
  if (status !== undefined) targetRec["status"] = status;
  if (meta.code) targetRec["code"] = meta.code;
  if (meta.errorStatus) targetRec["errorStatus"] = meta.errorStatus;
  if (meta.reason) targetRec["reason"] = meta.reason;

  if (isResponseStreamInterrupted(err)) {
    markResponseStreamInterrupted(wrapped);
  }
  if (provenUndelivered(delivery)) {
    markRequestUndelivered(wrapped);
  }
  return wrapped;
}
