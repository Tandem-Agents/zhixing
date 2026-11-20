/**
 * 十一预设原生发现器与可选兼容探测（设计 §1.3、§2.2.4、§3.3、注意项 #2 / #4）。
 *
 * 严格遵循：
 * - 全部经受控单跳网络 `createConnectionDeliveryFetch` 发出（尊重 `proxy: inherit | direct`、
 *   `allowPrivateOrigin`、SSRF/DNS 检查、拒绝 URL userinfo/query-secret、支持 `AbortSignal`）；
 * - 严格区分 `native`（官方文档核实发现路径）与 `optional-compat`（GLM / MiniMax / 未匹配百炼原生域 /
 *   自定义兼容端默认不臆测存在列表接口，仅在显式开启可选兼容探测时请求 `<baseUrl>/models`）；
 * - 严格分态：`discovered`（含空列表提示）、`unsupported`（404/405，不阻断保存）、`auth-rejected`（401）、
 *   `restricted`（403 按结构化子原因分流，绝不一律报 Key 错）、`unreachable`（超时/DNS/SSRF）、`aborted`；
 * - 绝不缓存或返回原始 HTTP 响应体或明文秘密；支持 `draftRevision` 防过时结果回写。
 */

import type { ModelAdapterId } from "@zhixing-ai/core";
import {
  classifyProviderErrorDetail,
  sanitizeProviderErrorMessage,
  type ProviderErrorSubcode,
} from "@zhixing-ai/core/resilience";
import { createConnectionDeliveryFetch } from "../adapters/delivery-transport.js";
import { BUILTIN_CURATED_CATALOG } from "../catalog/builtin-catalog.js";
import {
  normalizeOllamaEndpoints,
  type CuratedCatalogBundle,
  type CuratedPreset,
  type DiscoveryKind,
} from "../catalog/schema.js";
import type { DiscoveredModelRecord } from "../catalog/synthesis.js";
import type { ConnectionAuthConfig, ConnectionNetworkConfig, NetworkConfig } from "../types.js";
import {
  computeCredentialRevisionToken,
  sanitizeEndpointForCache,
  type DiscoveryCacheEntry,
  type DiscoveryProbeStatus,
  type ModelDiscoveryCache,
} from "./discovery-cache.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_DISCOVERY_PAGES = 5;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const OLLAMA_SHOW_MAX_MODELS = 16;
const OLLAMA_SHOW_CONCURRENCY = 4;

export interface DiscoverConnectionModelsInput {
  readonly connectionId: string;
  readonly presetId?: string;
  readonly adapter: ModelAdapterId;
  readonly endpoint: string;
  readonly auth: ConnectionAuthConfig;
  /** 仅驻留在当前调用进程（N 或 Host）内存中的秘密值，绝不持久化进缓存或随结果回传。 */
  readonly secretValue?: string;
  readonly credentialRevision?: string;
  readonly network: ConnectionNetworkConfig;
  readonly networkProxy?: NetworkConfig["proxy"];
  readonly catalog?: CuratedCatalogBundle;
  /** 对无官方原生列表的预设（GLM / MiniMax / 非百炼原生域）是否显式执行可选兼容 `<baseUrl>/models` 探测。 */
  readonly allowOptionalCompatProbe?: boolean;
  /** 是否对 Ollama 已发现型号按需调用 `POST <ollamaRoot>/api/show` 补全上下文与能力字段（默认 true）。 */
  readonly enrichOllamaShow?: boolean;
  /** 可选隔离派生缓存：发现完成后自动写入（`aborted` 不落盘）。 */
  readonly cache?: ModelDiscoveryCache;
  /** 可选调用会话 ID（如配置编辑器单次生命周期 UUID）；仅与 `draftRevision` 配对用于同会话内防乱序，不跨会话阻断新开编辑器。 */
  readonly requestSessionId?: string;
  /** 草稿修订号：原样透传回结果，便于调用方在输入变化/取消后丢弃过时结果。 */
  readonly draftRevision?: number | string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DiscoverConnectionModelsResult {
  readonly status: DiscoveryProbeStatus | "aborted";
  readonly draftRevision?: number | string;
  readonly checkedAt: string;
  readonly sanitizedEndpoint: string;
  readonly requestUrl?: string;
  readonly proxyRoute: "inherit" | "direct";
  readonly modeUsed: "native" | "optional-compat" | "none";
  readonly authoritativeNativeFacts: boolean;
  readonly emptyList?: boolean;
  readonly models: readonly DiscoveredModelRecord[];
  readonly errorSubcode?: ProviderErrorSubcode;
  readonly httpStatus?: number;
  readonly userMessage: string;
  readonly cacheEntry?: DiscoveryCacheEntry;
}

export interface ResolvedDiscoveryPlan {
  readonly mode: "native" | "optional-compat" | "none";
  readonly kind?: DiscoveryKind;
  readonly url?: string;
  readonly ollamaShowUrl?: string;
  /** 当前连接端点是否精确匹配该预设经核验的官方来源（第三方改址/代理必为 false）。 */
  readonly originVerified: boolean;
  readonly authoritativeNativeFacts: boolean;
  readonly reasonIfNone?: string;
}

function isPresetOfficialOrigin(preset: CuratedPreset, parsed: URL): boolean {
  const targetOrigin = parsed.origin.toLowerCase();
  const candidates = [
    preset.baseUrl,
    ...(preset.alternateBaseUrls ?? []),
    ...(preset.discovery.verifiedOrigins ?? []),
  ];
  for (const raw of candidates) {
    try {
      if (new URL(raw).origin.toLowerCase() === targetOrigin) {
        return true;
      }
    } catch {
      if (raw.trim().toLowerCase() === targetOrigin) {
        return true;
      }
    }
  }
  return false;
}

function resolveUnverifiedCustomDiscoveryUrl(
  parsed: URL,
  trimmed: string,
  tpl: CuratedPreset["discovery"],
): string {
  if (tpl.urlBase !== "origin") {
    return `${trimmed}${tpl.path}`;
  }
  const cleanPath = parsed.pathname.replace(/\/+$/u, "");
  // 标准根路径或协议版本根（"" / "/v1" / "/v1beta"）按协议路径落位；自定义反向代理前缀（如 "/proxy/google"）完整保留
  if (cleanPath === "" || cleanPath === "/v1" || cleanPath === "/v1beta") {
    return `${parsed.origin}${tpl.path}`;
  }
  return `${trimmed}${tpl.path.startsWith("/") ? tpl.path : `/${tpl.path}`}`;
}

/**
 * 按设计 §1.3、§2.2.4 与注意项 #4 决定连接的发现计划：
 * - 严格区分 `<baseUrl>/...`、`<origin>/...` 与 Ollama 路径归一；
 * - 除本地自托管 Ollama 外，所有云端预设仅在端点精确匹配官方已核实来源时方具 `mode: "native"` 与
 *   `authoritativeNativeFacts` 资格；改址至未核实第三方来源一律降级为 `optional-compat` 且
 *   `authoritativeNativeFacts: false`（第三方声明归资料层，绝不冒充官方硬约束）。
 */
export function resolveDiscoveryPlan(input: {
  readonly endpoint: string;
  readonly preset?: CuratedPreset;
  readonly allowOptionalCompatProbe?: boolean;
}): ResolvedDiscoveryPlan {
  const trimmed = input.endpoint.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      mode: "none",
      originVerified: false,
      authoritativeNativeFacts: false,
      reasonIfNone: "端点 URL 格式无效，无法发起发现。",
    };
  }
  const origin = parsed.origin;
  const preset = input.preset;

  // 自定义连接（无预设）：仅在允许可选兼容探测时探 `<baseUrl>/models`
  if (!preset) {
    if (input.allowOptionalCompatProbe === false) {
      return {
        mode: "none",
        originVerified: false,
        authoritativeNativeFacts: false,
        reasonIfNone: "自定义连接未启用可选兼容探测，可直接使用手填精确模型 ID。",
      };
    }
    return {
      mode: "optional-compat",
      kind: "openai-models",
      url: `${trimmed}/models`,
      originVerified: false,
      authoritativeNativeFacts: false,
    };
  }

  const tpl = preset.discovery;

  // Ollama 本机/自托管运行时专属路径归一（注意项 #4：绝不给 /api/tags 误加 /v1，且保留显式自定义 basePath）
  if (tpl.kind === "ollama-tags") {
    const normalized = normalizeOllamaEndpoints(trimmed);
    return {
      mode: "native",
      kind: "ollama-tags",
      url: normalized.nativeTagsUrl,
      ollamaShowUrl: normalized.nativeShowUrl,
      originVerified: true,
      authoritativeNativeFacts: tpl.authoritativeNativeFacts,
    };
  }

  const originVerified = isPresetOfficialOrigin(preset, parsed);

  // 百炼 DashScope：仅匹配已核实原生来源时走 `<origin>/api/v1/models`；未匹配来源不泛化，仅允许可选兼容探测
  if (tpl.kind === "dashscope-native") {
    if (originVerified) {
      return {
        mode: "native",
        kind: "dashscope-native",
        url: `${origin}${tpl.path}`,
        originVerified: true,
        authoritativeNativeFacts: tpl.authoritativeNativeFacts,
      };
    }
    if (input.allowOptionalCompatProbe) {
      return {
        mode: "optional-compat",
        kind: "openai-models",
        url: `${trimmed}/models`,
        originVerified: false,
        authoritativeNativeFacts: false,
      };
    }
    return {
      mode: "none",
      originVerified: false,
      authoritativeNativeFacts: false,
      reasonIfNone:
        "当前端点不属于已核实的百炼原生列表域（不支持列表发现，未验证凭据）；请使用策展基线、手填精确模型 ID 或启用可选兼容探测。",
    };
  }

  // GLM / MiniMax 等未核实通用列表的预设：默认不发列表探测，仅在显式请求可选兼容探测时探 `<baseUrl>/models`
  if (tpl.mode === "optional-compat") {
    if (!input.allowOptionalCompatProbe) {
      return {
        mode: "none",
        originVerified,
        authoritativeNativeFacts: false,
        reasonIfNone:
          `${preset.name} 公开文档未稳定承诺通用模型列表接口（不支持列表发现，未验证凭据）；请使用策展基线或手填精确模型 ID，也可启用可选兼容探测或可选生成验证。`,
      };
    }
    return {
      mode: "optional-compat",
      kind: tpl.kind,
      url: tpl.urlBase === "origin" ? resolveUnverifiedCustomDiscoveryUrl(parsed, trimmed, tpl) : `${trimmed}${tpl.path}`,
      originVerified,
      authoritativeNativeFacts: false,
    };
  }

  // 其余已核实原生发现预设（DeepSeek / Kimi / OpenAI / Anthropic / SiliconFlow / OpenRouter / Google）
  if (!originVerified) {
    if (input.allowOptionalCompatProbe === false) {
      return {
        mode: "none",
        originVerified: false,
        authoritativeNativeFacts: false,
        reasonIfNone:
          `当前连接端点不属于 ${preset.name} 已核实官方来源，已禁用自动探测（不将第三方声明视为官方硬约束）。`,
      };
    }
    return {
      mode: "optional-compat",
      kind: tpl.kind,
      url: resolveUnverifiedCustomDiscoveryUrl(parsed, trimmed, tpl),
      originVerified: false,
      authoritativeNativeFacts: false,
    };
  }

  const url = tpl.urlBase === "origin" ? `${origin}${tpl.path}` : `${trimmed}${tpl.path}`;
  return {
    mode: "native",
    kind: tpl.kind,
    url,
    originVerified: true,
    authoritativeNativeFacts: tpl.authoritativeNativeFacts,
  };
}

/**
 * 执行受控只读原生发现（或可选兼容探测）。
 */
export async function discoverConnectionModels(
  input: DiscoverConnectionModelsInput,
): Promise<DiscoverConnectionModelsResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const nowCheckedAt = () => new Date(Math.max(Date.now(), startedAtMs)).toISOString();
  const expectedEpoch = input.cache
    ? await input.cache.readConnectionEpoch(input.connectionId)
    : undefined;
  const catalog = input.catalog ?? BUILTIN_CURATED_CATALOG;
  const preset = input.presetId
    ? catalog.presets.find((p) => p.id === input.presetId)
    : undefined;
  const sanitizedEndpoint = sanitizeEndpointForCache(input.endpoint);
  const proxyRoute = input.network.proxy;
  const boundSecrets = input.secretValue ? [input.secretValue] : [];

  const plan = resolveDiscoveryPlan({
    endpoint: input.endpoint,
    preset,
    allowOptionalCompatProbe: input.allowOptionalCompatProbe,
  });

  const credentialRevision = computeCredentialRevisionToken({
    authMode: input.auth.mode,
    headerName: input.auth.mode === "header" ? input.auth.headerName : undefined,
    secretValue: input.secretValue,
    explicitRevision: input.credentialRevision,
  });

  const persistIfNeeded = async (
    result: DiscoverConnectionModelsResult,
  ): Promise<DiscoverConnectionModelsResult> => {
    if (!input.cache || result.status === "aborted" || input.signal?.aborted) return result;
    const sessionGeneration =
      input.requestSessionId &&
      typeof input.draftRevision === "number" &&
      Number.isFinite(input.draftRevision)
        ? input.draftRevision
        : undefined;
    const entry = await input.cache.writeProbeResult(
      {
        connectionId: input.connectionId,
        endpoint: input.endpoint,
        adapter: input.adapter,
        credentialRevision,
      },
      {
        status: result.status,
        checkedAt: result.checkedAt,
        ...(result.emptyList !== undefined ? { emptyList: result.emptyList } : {}),
        authoritativeNativeFacts: result.authoritativeNativeFacts,
        ...(result.status === "discovered" ? { models: result.models } : {}),
        ...(result.errorSubcode ? { errorSubcode: result.errorSubcode } : {}),
        userMessage: result.userMessage,
        proxyRoute: result.proxyRoute,
      },
      {
        startedAt,
        ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
        ...(input.requestSessionId && sessionGeneration !== undefined
          ? { sessionId: input.requestSessionId, generation: sessionGeneration }
          : {}),
      },
    );
    return entry ? { ...result, cacheEntry: entry } : result;
  };

  if (input.signal?.aborted) {
    return {
      status: "aborted",
      ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
      checkedAt: nowCheckedAt(),
      sanitizedEndpoint,
      proxyRoute,
      modeUsed: plan.mode,
      authoritativeNativeFacts: plan.authoritativeNativeFacts,
      models: [],
      userMessage: "已取消模型发现。",
    };
  }

  if (plan.mode === "none" || !plan.url || !plan.kind) {
    return persistIfNeeded({
      status: "unsupported",
      ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
      checkedAt: nowCheckedAt(),
      sanitizedEndpoint,
      proxyRoute,
      modeUsed: "none",
      authoritativeNativeFacts: false,
      models: [],
      userMessage:
        plan.reasonIfNone ??
        "不支持列表发现，未验证凭据；不影响保存配置，请使用策展目录或手填精确模型 ID。",
    });
  }

  // 构建受控单跳传输（严格按连接代理策略与私网许可）
  const transport = createConnectionDeliveryFetch({
    proxyPolicy: input.network.proxy,
    ...(input.networkProxy !== undefined ? { networkProxy: input.networkProxy } : {}),
    ...(input.network.allowPrivateOrigin ? { allowPrivateOrigin: true } : {}),
    confirmedOrigin: input.endpoint,
  });

  const headers = buildDiscoveryHeaders(plan.kind, input.auth, input.secretValue);
  const timeoutController = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`Discovery request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onParentAbort = () => {
    timeoutController.abort(input.signal?.reason ?? new DOMException("Aborted", "AbortError"));
  };
  input.signal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const models = await fetchModelsByKind({
      kind: plan.kind,
      url: plan.url,
      ollamaShowUrl: plan.ollamaShowUrl,
      headers,
      fetchFn: transport.fetch,
      signal: timeoutController.signal,
      enrichOllamaShow: input.enrichOllamaShow !== false,
    });

    if (input.signal?.aborted) {
      return {
        status: "aborted",
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        checkedAt: nowCheckedAt(),
        sanitizedEndpoint,
        requestUrl: sanitizeEndpointForCache(plan.url),
        proxyRoute,
        modeUsed: plan.mode,
        authoritativeNativeFacts: plan.authoritativeNativeFacts,
        models: [],
        userMessage: "已取消模型发现。",
      };
    }

    const emptyList = models.length === 0;
    const userMessage = emptyList
      ? "列表接口可达但返回空列表（仅证明列表接口可达，不冒充具体型号可用；可保留手填精确模型 ID）。"
      : `列表接口可达：发现 ${models.length} 个模型条目（仅证明列表接口可达，不冒充已验证具体型号生成可用）。`;

    return persistIfNeeded({
      status: "discovered",
      ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
      checkedAt: nowCheckedAt(),
      sanitizedEndpoint,
      requestUrl: sanitizeEndpointForCache(plan.url),
      proxyRoute,
      modeUsed: plan.mode,
      authoritativeNativeFacts: plan.authoritativeNativeFacts,
      emptyList,
      models,
      userMessage,
    });
  } catch (err) {
    if (input.signal?.aborted) {
      return {
        status: "aborted",
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        checkedAt: nowCheckedAt(),
        sanitizedEndpoint,
        requestUrl: sanitizeEndpointForCache(plan.url),
        proxyRoute,
        modeUsed: plan.mode,
        authoritativeNativeFacts: plan.authoritativeNativeFacts,
        models: [],
        userMessage: "已取消模型发现。",
      };
    }

    if (err instanceof DiscoveryHttpError) {
      const sanitizedDetail = sanitizeProviderErrorMessage(err.rawMessage, boundSecrets);
      if (err.status === 404 || err.status === 405) {
        return persistIfNeeded({
          status: "unsupported",
          ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
          checkedAt: nowCheckedAt(),
          sanitizedEndpoint,
          requestUrl: sanitizeEndpointForCache(plan.url),
          proxyRoute,
          modeUsed: plan.mode,
          authoritativeNativeFacts: false,
          models: [],
          httpStatus: err.status,
          userMessage: `接口返回 HTTP ${err.status}：不支持列表发现，未验证凭据；不阻止保存配置，可继续使用策展目录、手填精确模型 ID 或执行可选生成验证。`,
        });
      }
      if (err.status === 401) {
        return persistIfNeeded({
          status: "auth-rejected",
          ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
          checkedAt: nowCheckedAt(),
          sanitizedEndpoint,
          requestUrl: sanitizeEndpointForCache(plan.url),
          proxyRoute,
          modeUsed: plan.mode,
          authoritativeNativeFacts: false,
          models: [],
          httpStatus: 401,
          errorSubcode: "auth_invalid_credentials",
          userMessage:
            "凭据被拒绝（HTTP 401）：请重填 API Key、核对认证头或检查接口地址；若暂需离线保留可二次确认「先存待修」（标为鉴权失败，不会冒充已验证）。",
        });
      }
      if (err.status === 403) {
        const classified = classifyProviderErrorDetail({
          status: 403,
          message: `HTTP 403${err.code ? ` (${err.code})` : ""}: ${sanitizedDetail}`,
          ...(err.code ? { code: err.code } : {}),
        });
        return persistIfNeeded({
          status: "restricted",
          ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
          checkedAt: nowCheckedAt(),
          sanitizedEndpoint,
          requestUrl: sanitizeEndpointForCache(plan.url),
          proxyRoute,
          modeUsed: plan.mode,
          authoritativeNativeFacts: false,
          models: [],
          httpStatus: 403,
          errorSubcode: classified.subcode,
          userMessage: classified.userMessage,
        });
      }
      const classified = classifyProviderErrorDetail({
        status: err.status,
        message: `HTTP ${err.status}${err.code ? ` (${err.code})` : ""}: ${sanitizedDetail}`,
      });
      return persistIfNeeded({
        status: "unreachable",
        ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
        checkedAt: nowCheckedAt(),
        sanitizedEndpoint,
        requestUrl: sanitizeEndpointForCache(plan.url),
        proxyRoute,
        modeUsed: plan.mode,
        authoritativeNativeFacts: false,
        models: [],
        httpStatus: err.status,
        errorSubcode: classified.subcode,
        userMessage: `列表发现暂时不可达（目标 ${sanitizedEndpoint}，路线 ${proxyRoute}，HTTP ${err.status}）：${classified.userMessage}；可离线保存草稿后重试。`,
      });
    }

    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedReason = sanitizeProviderErrorMessage(rawMsg, boundSecrets);
    const isTimeout =
      timeoutController.signal.aborted && !input.signal?.aborted;
    return persistIfNeeded({
      status: "unreachable",
      ...(input.draftRevision !== undefined ? { draftRevision: input.draftRevision } : {}),
      checkedAt: nowCheckedAt(),
      sanitizedEndpoint,
      requestUrl: sanitizeEndpointForCache(plan.url),
      proxyRoute,
      modeUsed: plan.mode,
      authoritativeNativeFacts: false,
      models: [],
      errorSubcode: isTimeout ? "timeout" : "network",
      userMessage: isTimeout
        ? `列表发现超时（目标 ${sanitizedEndpoint}，路线 ${proxyRoute}）：可切换代理策略（inherit/direct）、检查私网许可或离线保存草稿后重试。`
        : `列表发现无法连通（目标 ${sanitizedEndpoint}，路线 ${proxyRoute}，原因：${sanitizedReason}）：可切换代理策略（inherit/direct）、确认私网许可或离线保存草稿。`,
    });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onParentAbort);
    await transport.close().catch(() => {});
  }
}

class DiscoveryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly rawMessage: string,
    readonly code?: string,
  ) {
    super(rawMessage);
    this.name = "DiscoveryHttpError";
  }
}

function buildDiscoveryHeaders(
  kind: DiscoveryKind,
  auth: ConnectionAuthConfig,
  secretValue?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (kind === "anthropic-models") {
    headers["anthropic-version"] = "2023-06-01";
  }
  if (auth.mode === "none" || !secretValue) {
    return headers;
  }
  if (auth.mode === "header") {
    headers[auth.headerName] = secretValue;
    return headers;
  }
  // api-key 模式按协议原生认证头填充
  if (kind === "anthropic-models") {
    headers["x-api-key"] = secretValue;
  } else if (kind === "google-models") {
    headers["x-goog-api-key"] = secretValue;
  } else {
    headers["Authorization"] = `Bearer ${secretValue}`;
  }
  return headers;
}

async function fetchJsonBounded(
  fetchFn: typeof fetch,
  url: string,
  init: {
    readonly method?: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal: AbortSignal;
  },
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal,
  });

  const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    let message = response.statusText || `HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const errJson = JSON.parse(text) as Record<string, unknown>;
      const nested =
        errJson["error"] && typeof errJson["error"] === "object"
          ? (errJson["error"] as Record<string, unknown>)
          : errJson;
      if (typeof nested["message"] === "string" && nested["message"].trim()) {
        message = nested["message"].trim();
      }
      const rawCode = nested["code"] ?? nested["type"] ?? nested["status"];
      if (typeof rawCode === "string" && rawCode.trim()) {
        code = rawCode.trim();
      }
    } catch {
      if (text.trim()) message = text.trim().slice(0, 512);
    }
    throw new DiscoveryHttpError(response.status, message, code);
  }
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`Discovery response exceeded ${maxBytes} bytes limit`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`Discovery response exceeded ${maxBytes} bytes limit`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchModelsByKind(args: {
  readonly kind: DiscoveryKind;
  readonly url: string;
  readonly ollamaShowUrl?: string;
  readonly headers: Record<string, string>;
  readonly fetchFn: typeof fetch;
  readonly signal: AbortSignal;
  readonly enrichOllamaShow: boolean;
}): Promise<DiscoveredModelRecord[]> {
  switch (args.kind) {
    case "dashscope-native":
      return fetchDashscopeModels(args.fetchFn, args.url, args.headers, args.signal);
    case "anthropic-models":
      return fetchAnthropicModels(args.fetchFn, args.url, args.headers, args.signal);
    case "google-models":
      return fetchGoogleModels(args.fetchFn, args.url, args.headers, args.signal);
    case "ollama-tags":
      return fetchOllamaModels(
        args.fetchFn,
        args.url,
        args.ollamaShowUrl!,
        args.headers,
        args.signal,
        args.enrichOllamaShow,
      );
    case "openrouter-models":
      return fetchOpenRouterModels(args.fetchFn, args.url, args.headers, args.signal);
    case "siliconflow-models":
      return fetchSiliconFlowModels(args.fetchFn, args.url, args.headers, args.signal);
    case "openai-models":
    default:
      return fetchOpenAIStyleModels(args.fetchFn, args.url, args.headers, args.signal);
  }
}

async function fetchOpenAIStyleModels(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModelRecord[]> {
  const payload = (await fetchJsonBounded(fetchFn, url, { headers, signal })) as Record<string, unknown>;
  const list = Array.isArray(payload["data"])
    ? payload["data"]
    : Array.isArray(payload["models"])
      ? payload["models"]
      : [];
  const results: DiscoveredModelRecord[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const contextWindow = readPositiveInt(
      rec["context_length"] ?? rec["context_window"] ?? rec["max_context_length"],
    );
    const maxOutputTokens = readPositiveInt(
      rec["max_output_tokens"] ?? rec["max_completion_tokens"],
    );
    const capabilities =
      rec["capabilities"] && typeof rec["capabilities"] === "object"
        ? (rec["capabilities"] as Record<string, unknown>)
        : undefined;
    const supportsImages =
      typeof rec["supports_vision"] === "boolean"
        ? rec["supports_vision"]
        : typeof capabilities?.["vision"] === "boolean"
          ? (capabilities["vision"] as boolean)
          : undefined;
    const supportsThinking =
      typeof rec["supports_reasoning"] === "boolean"
        ? rec["supports_reasoning"]
        : typeof capabilities?.["reasoning"] === "boolean"
          ? (capabilities["reasoning"] as boolean)
          : undefined;
    const supportsTools =
      typeof rec["supports_tools"] === "boolean"
        ? rec["supports_tools"]
        : typeof capabilities?.["function_calling"] === "boolean"
          ? (capabilities["function_calling"] as boolean)
          : undefined;

    const arch =
      rec["architecture"] && typeof rec["architecture"] === "object"
        ? (rec["architecture"] as Record<string, unknown>)
        : undefined;
    const rawOutputModalities = Array.isArray(rec["output_modalities"])
      ? rec["output_modalities"]
      : Array.isArray(arch?.["output_modalities"])
        ? arch["output_modalities"]
        : undefined;

    results.push({
      id,
      ...(typeof rec["name"] === "string" && rec["name"].trim() ? { name: rec["name"].trim() } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(supportsTools !== undefined ? { supportsTools } : {}),
      ...(supportsImages !== undefined ? { supportsImages } : {}),
      ...(supportsThinking !== undefined ? { supportsThinking } : {}),
      ...(typeof rec["type"] === "string" ? { nativeType: rec["type"] } : {}),
      ...(typeof rec["sub_type"] === "string" ? { nativeSubType: rec["sub_type"] } : {}),
      ...(rawOutputModalities
        ? { outputModalities: rawOutputModalities.filter((x): x is string => typeof x === "string") }
        : {}),
    });
  }
  return results;
}

async function fetchDashscopeModels(
  fetchFn: typeof fetch,
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModelRecord[]> {
  const results: DiscoveredModelRecord[] = [];
  const seen = new Set<string>();

  for (let pageNo = 1; pageNo <= MAX_DISCOVERY_PAGES; pageNo++) {
    const pageUrl = new URL(baseUrl);
    pageUrl.searchParams.set("page_no", String(pageNo));
    pageUrl.searchParams.set("page_size", "100");
    const payload = (await fetchJsonBounded(fetchFn, pageUrl.toString(), { headers, signal })) as Record<
      string,
      unknown
    >;
    const output =
      payload["output"] && typeof payload["output"] === "object"
        ? (payload["output"] as Record<string, unknown>)
        : payload;
    const list = Array.isArray(output["models"])
      ? output["models"]
      : Array.isArray(payload["data"])
        ? payload["data"]
        : [];

    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id =
        typeof rec["model"] === "string"
          ? rec["model"].trim()
          : typeof rec["id"] === "string"
            ? rec["id"].trim()
            : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const caps = Array.isArray(rec["capabilities"])
        ? rec["capabilities"].filter((c): c is string => typeof c === "string").map((c) => c.toLowerCase())
        : [];
      const features = Array.isArray(rec["features"])
        ? rec["features"].filter((c): c is string => typeof c === "string").map((c) => c.toLowerCase())
        : [];
      const allTags = new Set([...caps, ...features]);

      results.push({
        id,
        ...(typeof rec["name"] === "string" && rec["name"].trim() ? { name: rec["name"].trim() } : {}),
        ...(readPositiveInt(rec["context_length"]) !== undefined
          ? { contextWindow: readPositiveInt(rec["context_length"]) }
          : {}),
        ...(readPositiveInt(rec["max_output_tokens"]) !== undefined
          ? { maxOutputTokens: readPositiveInt(rec["max_output_tokens"]) }
          : {}),
        ...(allTags.has("function_calling") || allTags.has("tools") ? { supportsTools: true } : {}),
        ...(allTags.has("vision") || allTags.has("image_input") ? { supportsImages: true } : {}),
        ...(allTags.has("thinking") || allTags.has("reasoning") ? { supportsThinking: true } : {}),
        ...(typeof rec["type"] === "string" ? { nativeType: rec["type"] } : {}),
        ...(typeof rec["task"] === "string" ? { nativeSubType: rec["task"] } : {}),
      });
    }

    const total = typeof output["total"] === "number" ? output["total"] : undefined;
    const pageSize = typeof output["page_size"] === "number" ? output["page_size"] : 100;
    if (list.length === 0 || (total !== undefined && pageNo * pageSize >= total) || list.length < pageSize) {
      break;
    }
  }
  return results;
}

async function fetchAnthropicModels(
  fetchFn: typeof fetch,
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModelRecord[]> {
  const results: DiscoveredModelRecord[] = [];
  const seen = new Set<string>();
  let afterId: string | undefined;

  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const pageUrl = new URL(baseUrl);
    pageUrl.searchParams.set("limit", "100");
    if (afterId) pageUrl.searchParams.set("after_id", afterId);
    const payload = (await fetchJsonBounded(fetchFn, pageUrl.toString(), { headers, signal })) as Record<
      string,
      unknown
    >;
    const list = Array.isArray(payload["data"]) ? payload["data"] : [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const caps =
        rec["capabilities"] && typeof rec["capabilities"] === "object"
          ? (rec["capabilities"] as Record<string, unknown>)
          : undefined;
      const imageCap =
        caps?.["image_input"] && typeof caps["image_input"] === "object"
          ? (caps["image_input"] as Record<string, unknown>)["supported"]
          : undefined;
      const thinkingCap =
        caps?.["thinking"] && typeof caps["thinking"] === "object"
          ? (caps["thinking"] as Record<string, unknown>)["supported"]
          : undefined;

      results.push({
        id,
        ...(typeof rec["display_name"] === "string" && rec["display_name"].trim()
          ? { name: rec["display_name"].trim() }
          : {}),
        ...(readPositiveInt(rec["max_input_tokens"]) !== undefined
          ? { contextWindow: readPositiveInt(rec["max_input_tokens"]) }
          : {}),
        ...(readPositiveInt(rec["max_tokens"]) !== undefined
          ? { maxOutputTokens: readPositiveInt(rec["max_tokens"]) }
          : {}),
        ...(typeof imageCap === "boolean" ? { supportsImages: imageCap } : {}),
        ...(typeof thinkingCap === "boolean" ? { supportsThinking: thinkingCap } : {}),
        ...(rec["lifecycle"] === "deprecated" || rec["lifecycle"] === "retired"
          ? { lifecycle: rec["lifecycle"] }
          : {}),
      });
    }
    const hasMore = payload["has_more"] === true;
    const lastId = typeof payload["last_id"] === "string" ? payload["last_id"] : undefined;
    if (!hasMore || !lastId || lastId === afterId) break;
    afterId = lastId;
  }
  return results;
}

async function fetchSiliconFlowModels(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModelRecord[]> {
  const payload = (await fetchJsonBounded(fetchFn, url, { headers, signal })) as Record<string, unknown>;
  const list = Array.isArray(payload["data"]) ? payload["data"] : [];
  const results: DiscoveredModelRecord[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      ...(typeof rec["type"] === "string" ? { nativeType: rec["type"] } : {}),
      ...(typeof rec["sub_type"] === "string" ? { nativeSubType: rec["sub_type"] } : {}),
      ...(readPositiveInt(rec["context_length"]) !== undefined
        ? { contextWindow: readPositiveInt(rec["context_length"]) }
        : {}),
      ...(readPositiveInt(rec["max_output_tokens"]) !== undefined
        ? { maxOutputTokens: readPositiveInt(rec["max_output_tokens"]) }
        : {}),
    });
  }
  return results;
}

async function fetchOpenRouterModels(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModelRecord[]> {
  const payload = (await fetchJsonBounded(fetchFn, url, { headers, signal })) as Record<string, unknown>;
  const list = Array.isArray(payload["data"]) ? payload["data"] : [];
  const results: DiscoveredModelRecord[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const arch =
      rec["architecture"] && typeof rec["architecture"] === "object"
        ? (rec["architecture"] as Record<string, unknown>)
        : undefined;
    const inputModalities = Array.isArray(arch?.["input_modalities"])
      ? arch["input_modalities"].filter((m): m is string => typeof m === "string")
      : undefined;
    const outputModalities = Array.isArray(arch?.["output_modalities"])
      ? arch["output_modalities"].filter((m): m is string => typeof m === "string")
      : undefined;
    const topProvider =
      rec["top_provider"] && typeof rec["top_provider"] === "object"
        ? (rec["top_provider"] as Record<string, unknown>)
        : undefined;
    const supportedParams = Array.isArray(rec["supported_parameters"])
      ? rec["supported_parameters"].filter((p): p is string => typeof p === "string")
      : undefined;
    const pricingRec =
      rec["pricing"] && typeof rec["pricing"] === "object"
        ? (rec["pricing"] as Record<string, unknown>)
        : undefined;
    const promptRate = readPerMillionPrice(pricingRec?.["prompt"]);
    const completionRate = readPerMillionPrice(pricingRec?.["completion"]);

    results.push({
      id,
      ...(typeof rec["name"] === "string" && rec["name"].trim() ? { name: rec["name"].trim() } : {}),
      ...(readPositiveInt(rec["context_length"]) !== undefined
        ? { contextWindow: readPositiveInt(rec["context_length"]) }
        : {}),
      ...(readPositiveInt(topProvider?.["max_completion_tokens"]) !== undefined
        ? { maxOutputTokens: readPositiveInt(topProvider?.["max_completion_tokens"]) }
        : {}),
      ...(inputModalities ? { inputModalities } : {}),
      ...(outputModalities ? { outputModalities } : {}),
      ...(inputModalities !== undefined
        ? { supportsImages: inputModalities.some((m) => m.toLowerCase() === "image") }
        : {}),
      ...(supportedParams !== undefined
        ? {
            supportsTools: supportedParams.includes("tools"),
            supportedParameters: supportedParams,
          }
        : {}),
      ...(promptRate !== undefined || completionRate !== undefined
        ? {
            pricing: {
              currency: "USD",
              ...(promptRate !== undefined ? { inputPerMillion: promptRate } : {}),
              ...(completionRate !== undefined ? { outputPerMillion: completionRate } : {}),
            },
          }
        : {}),
    });
  }
  return results;
}

async function fetchGoogleModels(
  fetchFn: typeof fetch,
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModelRecord[]> {
  const results: DiscoveredModelRecord[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const pageUrl = new URL(baseUrl);
    pageUrl.searchParams.set("pageSize", "100");
    if (pageToken) pageUrl.searchParams.set("pageToken", pageToken);
    const payload = (await fetchJsonBounded(fetchFn, pageUrl.toString(), { headers, signal })) as Record<
      string,
      unknown
    >;
    const list = Array.isArray(payload["models"]) ? payload["models"] : [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const rawName = typeof rec["name"] === "string" ? rec["name"].trim() : "";
      if (!rawName) continue;
      const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const methods = Array.isArray(rec["supportedGenerationMethods"])
        ? rec["supportedGenerationMethods"].filter((m): m is string => typeof m === "string")
        : undefined;

      results.push({
        id,
        ...(typeof rec["displayName"] === "string" && rec["displayName"].trim()
          ? { name: rec["displayName"].trim() }
          : {}),
        ...(readPositiveInt(rec["inputTokenLimit"]) !== undefined
          ? { contextWindow: readPositiveInt(rec["inputTokenLimit"]) }
          : {}),
        ...(readPositiveInt(rec["outputTokenLimit"]) !== undefined
          ? { maxOutputTokens: readPositiveInt(rec["outputTokenLimit"]) }
          : {}),
        ...(methods ? { supportedGenerationMethods: methods } : {}),
        ...(typeof rec["thinking"] === "boolean" ? { supportsThinking: rec["thinking"] } : {}),
      });
    }
    const nextToken =
      typeof payload["nextPageToken"] === "string" && payload["nextPageToken"].trim()
        ? payload["nextPageToken"].trim()
        : undefined;
    if (!nextToken || nextToken === pageToken) break;
    pageToken = nextToken;
  }
  return results;
}

async function fetchOllamaModels(
  fetchFn: typeof fetch,
  tagsUrl: string,
  showUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  enrichShow: boolean,
): Promise<DiscoveredModelRecord[]> {
  const payload = (await fetchJsonBounded(fetchFn, tagsUrl, { headers, signal })) as Record<string, unknown>;
  const list = Array.isArray(payload["models"]) ? payload["models"] : [];
  const baseRecords: DiscoveredModelRecord[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id =
      typeof rec["name"] === "string"
        ? rec["name"].trim()
        : typeof rec["model"] === "string"
          ? rec["model"].trim()
          : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    baseRecords.push({ id, name: id });
  }

  if (!enrichShow || baseRecords.length === 0) {
    return baseRecords;
  }

  // 有界并发按需调用 POST <ollamaRoot>/api/show 获取上下文与能力声明（可取消，单条失败不拖垮整列表）
  const toInspect = baseRecords.slice(0, OLLAMA_SHOW_MAX_MODELS);
  const enrichedMap = new Map<string, DiscoveredModelRecord>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < toInspect.length && !signal.aborted) {
      const target = toInspect[cursor++]!;
      try {
        const showJson = (await fetchJsonBounded(fetchFn, showUrl, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: target.id }),
          signal,
        })) as Record<string, unknown>;
        enrichedMap.set(target.id, parseOllamaShowRecord(target, showJson));
      } catch {
        // 单模型 /api/show 失败保留基本条目并留未知字段
        enrichedMap.set(target.id, target);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(OLLAMA_SHOW_CONCURRENCY, toInspect.length) }, () => worker()),
  );

  return baseRecords.map((rec) => enrichedMap.get(rec.id) ?? rec);
}

function parseOllamaShowRecord(
  base: DiscoveredModelRecord,
  show: Record<string, unknown>,
): DiscoveredModelRecord {
  const caps = Array.isArray(show["capabilities"])
    ? show["capabilities"].filter((c): c is string => typeof c === "string").map((c) => c.toLowerCase())
    : undefined;
  const modelInfo =
    show["model_info"] && typeof show["model_info"] === "object"
      ? (show["model_info"] as Record<string, unknown>)
      : undefined;

  let contextWindow: number | undefined;
  if (modelInfo) {
    for (const [k, v] of Object.entries(modelInfo)) {
      if (k.endsWith(".context_length") || k === "context_length") {
        const parsed = readPositiveInt(v);
        if (parsed !== undefined) {
          contextWindow = parsed;
          break;
        }
      }
    }
  }

  const isEmbeddingOnly =
    caps !== undefined && caps.length > 0 && caps.every((c) => c === "embedding" || c === "embeddings");

  return {
    ...base,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(caps !== undefined
      ? {
          supportsTools: caps.includes("tools"),
          supportsImages: caps.includes("vision"),
          supportsThinking: caps.includes("thinking"),
          ...(isEmbeddingOnly ? { purpose: "embedding" as const } : {}),
        }
      : {}),
  };
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return undefined;
}

function readPerMillionPrice(value: unknown): number | undefined {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Math.round(num * 1_000_000 * 10000) / 10000;
}
