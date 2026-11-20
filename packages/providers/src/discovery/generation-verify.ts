/**
 * 可选、自愿、可取消的生成式验证（设计 §3.3）。
 *
 * 契约边界：
 * - 绝不在列表发现或打开页面时自动触发；必须先告知发送内容、可能费用与证明边界，并经 `userConfirmed: true` 才发请求；
 * - 使用该型号合法参数（严禁固定 `max_tokens: 1` 探针）；
 * - 可通过 `AbortSignal` 随时取消，并携带 `draftRevision` 在改址/换 Key/取消后丢弃过时结果；
 * - 在无宿主首配场景下由持有草稿秘密的 N 进程本地执行，绝不经普通 RPC 传递草稿密钥。
 */

import type { ModelAdapterId, ModelInfo, StopReason, TokenUsage } from "@zhixing-ai/core";
import {
  classifyProviderErrorDetail,
  sanitizeProviderErrorMessage,
  type ProviderErrorSubcode,
} from "@zhixing-ai/core/resilience";
import { BUILTIN_CURATED_CATALOG } from "../catalog/builtin-catalog.js";
import { resolveInferenceBaseUrl, type CuratedCatalogBundle } from "../catalog/schema.js";
import { createProviderFromResolved } from "../create-provider.js";
import { computeSourceOriginKey } from "../resolve.js";
import {
  DEFAULT_QUIRKS,
  type ConnectionAuthConfig,
  type ConnectionDialectConfig,
  type ConnectionNetworkConfig,
  type NetworkConfig,
  type ResolvedProvider,
} from "../types.js";
import {
  computeCredentialRevisionToken,
  type GenerationVerificationReceipt,
  type ModelDiscoveryCache,
} from "./discovery-cache.js";

export const GENERATION_VERIFICATION_PROMPT = "Reply with OK.";
/** 无已知模型输出上限时的合法保守默认（绝不使用固定 `max_tokens: 1` 探针）。 */
export const MIN_LEGAL_VERIFICATION_MAX_TOKENS = 64;
export const DEFAULT_LEGAL_VERIFICATION_MAX_TOKENS = 128;

export interface GenerationVerificationNotice {
  readonly modelId: string;
  readonly promptText: string;
  readonly maxTokens: number;
  readonly costDisclosure: string;
  readonly scopeDisclosure: string;
  readonly cancelable: true;
}

export interface VerifyModelGenerationInput {
  readonly connectionId: string;
  readonly presetId?: string;
  readonly adapter: ModelAdapterId;
  readonly endpoint: string;
  readonly auth: ConnectionAuthConfig;
  /** 仅驻留在当前调用进程（N 或 Host）内存中的秘密值，绝不跨普通 RPC 传递。 */
  readonly secretValue?: string;
  readonly credentialRevision?: string;
  readonly network: ConnectionNetworkConfig;
  readonly networkProxy?: NetworkConfig["proxy"];
  readonly dialect?: ConnectionDialectConfig;
  readonly modelId: string;
  readonly modelInfo?: ModelInfo;
  /** 若调用方已完成三层合成，可显式传入该模型经硬约束钳制后的有效最大输出上限。 */
  readonly effectiveMaxOutputTokens?: number;
  readonly catalog?: CuratedCatalogBundle;
  /** 必须显式确认（自愿触发），未确认则拒绝发送计费请求。 */
  readonly userConfirmed: boolean;
  readonly cache?: ModelDiscoveryCache;
  /** 可选调用会话 ID（如配置编辑器单次生命周期 UUID）；仅与 `draftRevision` 配对用于同会话内防乱序。 */
  readonly requestSessionId?: string;
  readonly draftRevision?: number | string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type VerifyModelGenerationStatus =
  | "verified"
  | "truncated"
  | "empty"
  | "failed"
  | "aborted";

export interface VerifyModelGenerationResult {
  readonly status: VerifyModelGenerationStatus;
  readonly modelId: string;
  readonly draftRevision?: number | string;
  readonly verifiedAt: string;
  readonly latencyMs: number;
  readonly maxTokensUsed: number;
  readonly stopReason?: StopReason;
  readonly previewText?: string;
  readonly usage?: TokenUsage;
  readonly errorSubcode?: ProviderErrorSubcode;
  readonly userMessage: string;
  readonly receipt?: GenerationVerificationReceipt;
}

/**
 * 计算合法的验证输出上限：
 * - 当型号存在已知有效输出上限时严格尊重其上限（`min(128, effectiveMaxOutputTokens)`，绝不越界发送更大值）；
 * - 拒绝 `< 2` 的非法或固定 `1` token 探针；
 * - 未知上限时采用保守默认值 `64`（不发送 `1` token 探针）。
 */
export function resolveLegalVerificationMaxTokens(
  modelInfo?: ModelInfo,
  effectiveMaxOutputTokens?: number,
): number {
  const rawCap = effectiveMaxOutputTokens ?? modelInfo?.maxOutputTokens;
  if (rawCap !== undefined && Number.isFinite(rawCap)) {
    const cap = Math.floor(rawCap);
    if (cap < 2) {
      throw new Error(
        `所选模型有效最大输出上限（${cap}）不足以执行合法生成验证（禁止固定 1 token 探针）`,
      );
    }
    return Math.min(cap, DEFAULT_LEGAL_VERIFICATION_MAX_TOKENS);
  }
  return MIN_LEGAL_VERIFICATION_MAX_TOKENS;
}

/**
 * 触发验证前的透明告知信息（自愿确认、发送内容、费用说明、证明边界、合法参数）。
 */
export function describeGenerationVerification(input: {
  readonly modelId: string;
  readonly modelInfo?: ModelInfo;
  readonly effectiveMaxOutputTokens?: number;
}): GenerationVerificationNotice {
  const maxTokens = resolveLegalVerificationMaxTokens(
    input.modelInfo,
    input.effectiveMaxOutputTokens,
  );
  return {
    modelId: input.modelId,
    promptText: GENERATION_VERIFICATION_PROMPT,
    maxTokens,
    costDisclosure: `将向模型 "${input.modelId}" 发送 1 条极简文本消息（"${GENERATION_VERIFICATION_PROMPT}"，maxTokens=${maxTokens}），可能产生少量模型调用费用。`,
    scopeDisclosure: "仅证明本次所选连接与型号可完成一次受控生成，不代表永久可用；随时可按 Esc 取消。",
    cancelable: true,
  };
}

/**
 * 执行一次受控、自愿、可取消的生成式验证。
 */
export async function verifyModelGeneration(
  input: VerifyModelGenerationInput,
): Promise<VerifyModelGenerationResult> {
  if (!input.userConfirmed) {
    throw new Error("生成式验证必须由用户自愿显式确认后方可触发（禁止自动发送计费探针）");
  }
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const nowVerifiedAt = () => new Date(Math.max(Date.now(), startedAt)).toISOString();
  const expectedEpoch = input.cache
    ? await input.cache.readConnectionEpoch(input.connectionId)
    : undefined;
  const catalog = input.catalog ?? BUILTIN_CURATED_CATALOG;
  const curatedModel = input.presetId
    ? catalog.models.find((m) => m.presetId === input.presetId && m.id === input.modelId)
    : undefined;
  const effectiveCap =
    input.effectiveMaxOutputTokens ??
    input.modelInfo?.maxOutputTokens ??
    curatedModel?.maxOutputTokens;
  const maxTokensUsed = resolveLegalVerificationMaxTokens(input.modelInfo, effectiveCap);

  if (input.signal?.aborted) {
    return {
      status: "aborted",
      modelId: input.modelId,
      ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
      verifiedAt: nowVerifiedAt(),
      latencyMs: 0,
      maxTokensUsed,
      userMessage: "已取消生成验证。",
    };
  }

  const preset = input.presetId
    ? catalog.presets.find((p) => p.id === input.presetId)
    : undefined;
  const inferenceBaseUrl = resolveInferenceBaseUrl(
    input.endpoint,
    input.adapter,
    input.presetId,
  );
  const resolved: ResolvedProvider = {
    id: input.connectionId,
    connectionId: input.connectionId,
    name: preset?.name ?? input.connectionId,
    baseUrl: inferenceBaseUrl,
    sourceOriginKey: computeSourceOriginKey(inferenceBaseUrl, input.adapter),
    authMode: input.auth.mode,
    ...(input.auth.mode === "header" ? { authHeaderName: input.auth.headerName } : {}),
    ...(input.auth.mode !== "none" ? { secretRef: input.auth.secretRef } : {}),
    apiKey: input.auth.mode === "none" ? "" : (input.secretValue ?? ""),
    protocol: input.adapter,
    quirks: {
      ...DEFAULT_QUIRKS,
      ...preset?.quirks,
      ...(input.dialect?.thinking ? { thinkingDialect: input.dialect.thinking } : {}),
      ...(input.dialect?.usage ? { usageDialect: input.dialect.usage } : {}),
    },
    network: input.network,
    ...(input.networkProxy !== undefined ? { networkProxy: input.networkProxy } : {}),
    declaredModels: input.modelInfo ? [input.modelInfo] : [],
  };

  const boundSecrets = input.secretValue ? [input.secretValue] : [];
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 20_000;
  const timer = setTimeout(() => {
    controller.abort(new Error(`Generation verification timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onParentAbort = () => {
    controller.abort(input.signal?.reason ?? new DOMException("Aborted", "AbortError"));
  };
  input.signal?.addEventListener("abort", onParentAbort, { once: true });

  const provider = createProviderFromResolved(resolved);
  const credentialRevision = computeCredentialRevisionToken({
    authMode: input.auth.mode,
    headerName: input.auth.mode === "header" ? input.auth.headerName : undefined,
    secretValue: input.secretValue,
    explicitRevision: input.credentialRevision,
  });
  const cacheGeneration =
    input.requestSessionId &&
    typeof input.draftRevision === "number" &&
    Number.isFinite(input.draftRevision)
      ? input.draftRevision
      : undefined;
  const cacheWriteOptions = {
    startedAt: startedAtIso,
    ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
    ...(input.requestSessionId && cacheGeneration !== undefined
      ? { sessionId: input.requestSessionId, generation: cacheGeneration }
      : {}),
  };

  try {
    let textBuffer = "";
    let usage: TokenUsage | undefined;
    let stopReason: StopReason | undefined;
    let streamError: Error | undefined;
    let completed = false;

    for await (const event of provider.chat({
      model: input.modelId,
      messages: [{ role: "user", content: [{ type: "text", text: GENERATION_VERIFICATION_PROMPT }] }],
      maxTokens: maxTokensUsed,
      abortSignal: controller.signal,
    })) {
      if (event.type === "text_delta") {
        textBuffer += event.text;
      } else if (event.type === "message_end") {
        usage = event.usage;
        stopReason = event.stopReason;
        completed = true;
      } else if (event.type === "error") {
        streamError = event.error;
      }
    }

    const latencyMs = Math.max(0, Date.now() - startedAt);
    const verifiedAt = nowVerifiedAt();
    if (input.signal?.aborted) {
      return {
        status: "aborted",
        modelId: input.modelId,
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        verifiedAt,
        latencyMs,
        maxTokensUsed,
        userMessage: "已取消生成验证。",
      };
    }

    const recordReceipt = async (receipt: GenerationVerificationReceipt): Promise<void> => {
      if (!input.cache || input.signal?.aborted) return;
      await input.cache.recordGenerationVerification(
        {
          connectionId: input.connectionId,
          endpoint: input.endpoint,
          adapter: input.adapter,
          credentialRevision,
        },
        receipt,
        cacheWriteOptions,
      );
    };

    const stopReasonStr = stopReason as string | undefined;
    if (streamError || !completed || stopReasonStr === "error") {
      const errObj =
        streamError ??
        new Error(
          stopReasonStr === "error"
            ? "生成验证收到异常结束态（stopReason=error）"
            : "生成验证未收到完整协议结束事件",
        );
      const classified = classifyProviderErrorDetail(errObj);
      const sanitizedMsg = sanitizeProviderErrorMessage(classified.userMessage, boundSecrets);
      const receipt: GenerationVerificationReceipt = {
        modelId: input.modelId,
        status: "failed",
        verifiedAt,
        latencyMs,
        userMessage: sanitizedMsg,
        ...(stopReason ? { stopReason } : {}),
        errorSubcode: classified.subcode,
      };
      await recordReceipt(receipt);
      return {
        status: "failed",
        modelId: input.modelId,
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        verifiedAt,
        latencyMs,
        maxTokensUsed,
        ...(stopReason ? { stopReason } : {}),
        ...(usage ? { usage } : {}),
        errorSubcode: classified.subcode,
        userMessage: sanitizedMsg,
        receipt,
      };
    }

    const previewText = textBuffer.trim().slice(0, 120);

    // 预算截断（finish_reason=length / stopReason=max_tokens）不得冒充“完成生成已验证”
    if (stopReason === "max_tokens") {
      const userMessage =
        previewText.length > 0
          ? `生成验证被输出上限截断（maxTokens=${maxTokensUsed}，stopReason=max_tokens），未计为完整验证。`
          : `生成验证在达到输出上限（maxTokens=${maxTokensUsed}）时返回空文本（stopReason=max_tokens），未计为已验证。`;
      const receipt: GenerationVerificationReceipt = {
        modelId: input.modelId,
        status: "truncated",
        verifiedAt,
        latencyMs,
        stopReason,
        userMessage,
      };
      await recordReceipt(receipt);
      return {
        status: "truncated",
        modelId: input.modelId,
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        verifiedAt,
        latencyMs,
        maxTokensUsed,
        stopReason,
        ...(previewText ? { previewText } : {}),
        ...(usage ? { usage } : {}),
        userMessage,
        receipt,
      };
    }

    // 正常结束但无任何有效输出文本：不得冒充“已验证”
    if (previewText.length === 0) {
      const userMessage = `生成验证未产出有效文本内容（stopReason=${stopReason ?? "unknown"}），未计为已验证。`;
      const receipt: GenerationVerificationReceipt = {
        modelId: input.modelId,
        status: "empty",
        verifiedAt,
        latencyMs,
        ...(stopReason ? { stopReason } : {}),
        userMessage,
      };
      await recordReceipt(receipt);
      return {
        status: "empty",
        modelId: input.modelId,
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        verifiedAt,
        latencyMs,
        maxTokensUsed,
        ...(stopReason ? { stopReason } : {}),
        ...(usage ? { usage } : {}),
        userMessage,
        receipt,
      };
    }

    const userMessage = `已验证：模型 "${input.modelId}" 本次生成可达（耗时 ${latencyMs}ms；仅证明本次生成可达）。`;
    const receipt: GenerationVerificationReceipt = {
      modelId: input.modelId,
      status: "verified",
      verifiedAt,
      latencyMs,
      ...(stopReason ? { stopReason } : {}),
      userMessage,
    };
    await recordReceipt(receipt);

    return {
      status: "verified",
      modelId: input.modelId,
      ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
      verifiedAt,
      latencyMs,
      maxTokensUsed,
      ...(stopReason ? { stopReason } : {}),
      previewText,
      ...(usage ? { usage } : {}),
      userMessage,
      receipt,
    };
  } catch (err) {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const verifiedAt = nowVerifiedAt();
    if (input.signal?.aborted) {
      return {
        status: "aborted",
        modelId: input.modelId,
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        verifiedAt,
        latencyMs,
        maxTokensUsed,
        userMessage: "已取消生成验证。",
      };
    }
    const classified = classifyProviderErrorDetail(err);
    const sanitizedMsg = sanitizeProviderErrorMessage(classified.userMessage, boundSecrets);
    const receipt: GenerationVerificationReceipt = {
      modelId: input.modelId,
      status: "failed",
      verifiedAt,
      latencyMs,
      userMessage: sanitizedMsg,
      errorSubcode: classified.subcode,
    };
    if (input.cache && !input.signal?.aborted) {
      await input.cache.recordGenerationVerification(
        {
          connectionId: input.connectionId,
          endpoint: input.endpoint,
          adapter: input.adapter,
          credentialRevision,
        },
        receipt,
        cacheWriteOptions,
      );
    }
    return {
      status: "failed",
      modelId: input.modelId,
      ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
      verifiedAt,
      latencyMs,
      maxTokensUsed,
      errorSubcode: classified.subcode,
      userMessage: sanitizedMsg,
      receipt,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onParentAbort);
    await provider.close?.().catch(() => {});
  }
}
