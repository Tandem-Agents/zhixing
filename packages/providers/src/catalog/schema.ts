/**
 * 单一策展模型目录 Schema、严格校验、前向兼容读取器与 Ollama 路径归一（设计 §1.3、§2.2.3、§4.1、注意项 #4）。
 *
 * 契约边界：
 * - schemaVersion === 1 内允许旧端忽略未知可选说明字段；
 * - 参数控件与语义只允许引用本地已注册的受控语义 ID，拒绝任意请求字段路径或可执行脚本；
 * - 单条目声明本地未实现的 `requiredCapabilities` 时仅将该条目标为 `requiresUpgrade`，不整包作废；
 * - Ollama 严格区分兼容推理基路径（`<origin>/v1`）与原生发现路径（`<origin>/api/tags`、`<origin>/api/show`），
 *   绝不重复 `/v1`，绝不误给 `/api/tags` 加 `/v1`，且不改写用户显式指定的自定义 `basePath`。
 */

import type { ModelAdapterId, ModelRoleId, ThinkingControl } from "@zhixing-ai/core";
import type { Protocol, ProviderQuirks } from "../types.js";

export const CURATED_CATALOG_SCHEMA_VERSION = 1 as const;

export const REGISTERED_PARAM_SEMANTICS = [
  "thinking.toggle",
  "thinking.effort",
  "thinking.budget",
  "output.maxTokensPreference",
] as const;

export type RegisteredParamSemanticId = (typeof REGISTERED_PARAM_SEMANTICS)[number];

const REGISTERED_PARAM_SEMANTICS_SET = new Set<string>(REGISTERED_PARAM_SEMANTICS);

/** 当前版本客户端声明已实现的受控能力集合，用于目录级/条目级兼容门控。 */
export const LOCAL_SUPPORTED_CATALOG_CAPABILITIES = [
  "adapter:openai-compatible",
  "adapter:openai-responses",
  "adapter:anthropic-messages",
  "adapter:google-interactions",
  "auth:none",
  "auth:api-key",
  "auth:header",
  "param:thinking.toggle",
  "param:thinking.effort",
  "param:thinking.budget",
  "param:output.maxTokensPreference",
] as const;

const LOCAL_CAPABILITIES_SET = new Set<string>(LOCAL_SUPPORTED_CATALOG_CAPABILITIES);

export type CatalogLifecycle = "active" | "deprecated" | "retired";

export type ModelPurpose =
  | "chat"
  | "embedding"
  | "rerank"
  | "tts"
  | "stt"
  | "image"
  | "video"
  | "moderation"
  | "audio";

export type DiscoveryKind =
  | "openai-models"
  | "dashscope-native"
  | "anthropic-models"
  | "siliconflow-models"
  | "openrouter-models"
  | "google-models"
  | "ollama-tags";

export interface DiscoveryTemplate {
  /** `native` = 官方文档核实原生发现；`optional-compat` = 未核实通用列表，默认走策展+手填，仅允许可选兼容探测。 */
  readonly mode: "native" | "optional-compat";
  readonly kind: DiscoveryKind;
  /** `baseUrl` = 相对兼容基路径 `<baseUrl><path>`；`origin` = 相对来源根 `<origin><path>`。 */
  readonly urlBase: "baseUrl" | "origin";
  readonly path: string;
  /** 仅匹配已核实来源列表时启用原生发现（如百炼 DashScope 地域域）。 */
  readonly verifiedOrigins?: readonly string[];
  /** 原生发现字段是否具备当前连接权威硬约束资格（第三方聚合端如 OpenRouter 为 false，仅落资料层）。 */
  readonly authoritativeNativeFacts: boolean;
  readonly docUrl?: string;
}

export interface PresetUiMetadata {
  readonly label: string;
  readonly description: string;
  readonly apiKeyHint: string;
  readonly apiKeyExample: string;
  readonly docUrl?: string;
  readonly modelListDocUrl?: string;
  readonly modelExample?: string;
}

export interface CuratedPreset {
  readonly id: string;
  readonly name: string;
  readonly presetRevision: string;
  readonly baseUrl: string;
  readonly alternateBaseUrls?: readonly string[];
  readonly protocol: Protocol;
  readonly allowedProtocols?: readonly Protocol[];
  readonly defaultAuthMode: "none" | "api-key" | "header";
  readonly defaultHeaderName?: string;
  readonly defaultNetwork?: {
    readonly proxy: "inherit" | "direct";
    readonly allowPrivateOrigin?: boolean;
  };
  readonly quirks?: Partial<ProviderQuirks>;
  readonly discovery: DiscoveryTemplate;
  readonly ui: PresetUiMetadata;
  readonly lifecycle?: CatalogLifecycle;
  readonly requiredCapabilities?: readonly string[];
}

export interface ModelPricingInfo {
  readonly currency: string;
  readonly inputPerMillion?: number;
  readonly outputPerMillion?: number;
  readonly cachedInputPerMillion?: number;
  readonly note?: string;
}

export interface CuratedModelEntry {
  readonly presetId: string;
  readonly id: string;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly purpose?: ModelPurpose;
  readonly lifecycle?: CatalogLifecycle;
  readonly replacementModelId?: string;
  readonly lifecycleReason?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly recommendedMaxOutputTokens?: number;
  readonly supportsTools?: boolean;
  readonly supportsImages?: boolean;
  readonly supportsThinking?: boolean;
  readonly thinkingControl?: ThinkingControl;
  readonly paramSemantics?: readonly RegisteredParamSemanticId[];
  readonly pricing?: ModelPricingInfo;
  readonly verifiedAt?: string;
  readonly evidenceSource?: string;
  readonly requiredCapabilities?: readonly string[];
}

export interface CuratedRecommendation {
  readonly role: ModelRoleId;
  readonly presetId: string;
  readonly modelId: string;
  readonly rationale: string;
  readonly evidenceSource: string;
  readonly verifiedAt: string;
  readonly replacementReason?: string;
  readonly requiredCapabilities?: readonly string[];
}

export interface CuratedAttentionThreshold {
  readonly modelKey: string;
  readonly optimalMaxTokens: number;
  readonly riskMaxTokens: number;
  readonly source: string;
  readonly verifiedAt?: string;
}

export interface CatalogUpgradeNotice {
  readonly minAppVersion: string;
  readonly message: string;
  readonly transitionEndsAt?: string;
}

export interface CuratedCatalogBundle {
  readonly schemaVersion: 1;
  readonly catalogRevision: string;
  readonly publishedAt: string;
  readonly minCapabilities?: readonly string[];
  readonly upgradeNotice?: CatalogUpgradeNotice;
  readonly presets: readonly CuratedPreset[];
  readonly models: readonly CuratedModelEntry[];
  readonly recommendations: readonly CuratedRecommendation[];
  readonly attentionThresholds: Readonly<Record<string, CuratedAttentionThreshold>>;
}

export interface CatalogCapabilityGate {
  readonly supported: boolean;
  readonly requiresUpgrade: boolean;
  readonly missingCapabilities: readonly string[];
}

export class CatalogSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogSchemaError";
  }
}

// ─── 严格 RFC 3339 时间戳校验（与 TUF 外包校验共用单一实现） ───

const STRICT_RFC3339_UTC_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 严格 RFC 3339 UTC 时间戳校验（关闭宽松 `Date.parse` 漏洞：拒绝不存在日历日期如 2026-02-30、
 * 拒绝非 UTC 偏移或自然语言日期，但保留时间比较语义留给调用阶段判断过期）。
 */
export function isStrictRfc3339Utc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = STRICT_RFC3339_UTC_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month]!;
  if (day < 1 || day > maxDay) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

// ─── 能力门控（单条目降级提示升级，不整包作废） ───

export function evaluateCapabilities(
  required: readonly string[] | undefined,
  supported: ReadonlySet<string> | readonly string[] = LOCAL_CAPABILITIES_SET,
): CatalogCapabilityGate {
  if (!required || required.length === 0) {
    return { supported: true, requiresUpgrade: false, missingCapabilities: [] };
  }
  const supportedSet = supported instanceof Set ? supported : new Set(supported);
  const missing = required.filter((cap) => !supportedSet.has(cap));
  return {
    supported: missing.length === 0,
    requiresUpgrade: missing.length > 0,
    missingCapabilities: missing,
  };
}

// ─── 安全 URL 与反注入检查 ───

const FORBIDDEN_INJECTION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "requestFieldPath",
  "requestPath",
  "rawRequestPatch",
  "bodyTemplate",
  "script",
  "eval",
  "code",
  "handler",
]);

const VALID_ADAPTERS = new Set<string>([
  "openai-compatible",
  "openai-responses",
  "anthropic-messages",
  "google-interactions",
]);

const VALID_LIFECYCLES = new Set<string>(["active", "deprecated", "retired"]);
const VALID_ROLES = new Set<string>(["main", "light", "power"]);
const VALID_PURPOSES = new Set<string>([
  "chat",
  "embedding",
  "rerank",
  "tts",
  "stt",
  "image",
  "video",
  "moderation",
  "audio",
]);
const VALID_DISCOVERY_KINDS = new Set<string>([
  "openai-models",
  "dashscope-native",
  "anthropic-models",
  "siliconflow-models",
  "openrouter-models",
  "google-models",
  "ollama-tags",
]);

function assertSafeObject(value: unknown, pathLabel: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogSchemaError(`${pathLabel} 必须是对象`);
  }
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (FORBIDDEN_INJECTION_KEYS.has(key)) {
      throw new CatalogSchemaError(`${pathLabel} 包含禁止的脚本或任意请求字段注入键：${key}`);
    }
  }
  return rec;
}

function assertNonEmptyString(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogSchemaError(`${pathLabel} 必须是非空字符串`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    throw new CatalogSchemaError(`${pathLabel} 包含非法控制字符`);
  }
  return value.trim();
}

function assertSafeHttpUrl(
  value: unknown,
  pathLabel: string,
  allowLocalHttp: boolean,
): string {
  const str = assertNonEmptyString(value, pathLabel);
  let parsed: URL;
  try {
    parsed = new URL(str);
  } catch {
    throw new CatalogSchemaError(`${pathLabel} 不是合法 URL：${str}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CatalogSchemaError(`${pathLabel} 禁止内嵌 URL 凭据`);
  }
  if (parsed.protocol === "https:") return str;
  if (
    allowLocalHttp &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1")
  ) {
    return str;
  }
  throw new CatalogSchemaError(`${pathLabel} 必须使用 https://（或已允许的本机 http://）`);
}

function assertOptionalStringArray(value: unknown, pathLabel: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CatalogSchemaError(`${pathLabel} 必须是字符串数组`);
  }
  return value.map((item, idx) => assertNonEmptyString(item, `${pathLabel}[${idx}]`));
}

function validateThinkingControl(value: unknown, pathLabel: string): ThinkingControl {
  const rec = assertSafeObject(value, pathLabel);
  const type = rec["type"];
  if (type === "none") {
    return { type: "none" };
  }
  if (type === "toggle") {
    return { type: "toggle" };
  }
  if (type === "effort") {
    const efforts = rec["efforts"];
    const allowedEfforts = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
    if (!Array.isArray(efforts) || efforts.length === 0) {
      throw new CatalogSchemaError(`${pathLabel}.efforts 必须是非空档位数组`);
    }
    const validatedEfforts = efforts.map((e, idx) => {
      if (typeof e !== "string" || !allowedEfforts.has(e)) {
        throw new CatalogSchemaError(`${pathLabel}.efforts[${idx}] 包含未注册思考档位：${String(e)}`);
      }
      return e as "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    });
    const def = rec["default"];
    if (def !== undefined && (typeof def !== "string" || !validatedEfforts.includes(def as never))) {
      throw new CatalogSchemaError(`${pathLabel}.default 必须属于已声明 efforts 枚举`);
    }
    const resolvedDefault = (def ?? validatedEfforts[0]!) as
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max";
    return {
      type: "effort",
      efforts: validatedEfforts,
      default: resolvedDefault,
    };
  }
  if (type === "budget") {
    const range = rec["range"];
    if (range === undefined) {
      return { type: "budget" };
    }
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      typeof range[0] !== "number" ||
      typeof range[1] !== "number" ||
      !Number.isSafeInteger(range[0]) ||
      !Number.isSafeInteger(range[1]) ||
      range[0] <= 0 ||
      range[1] < range[0]
    ) {
      throw new CatalogSchemaError(`${pathLabel}.range 必须是合法正整数区间 [min, max]`);
    }
    return {
      type: "budget",
      range: [range[0], range[1]],
    };
  }
  throw new CatalogSchemaError(`${pathLabel}.type 包含未注册控件形态：${String(type)}`);
}

/**
 * 校验并规范化外部或随包 `CuratedCatalogBundle`。
 *
 * - 严格拒绝非 schemaVersion=1、非法 RFC 3339 时间、任意请求字段/脚本注入与未注册参数语义；
 * - 宽容忽略旧端不认识的可选说明字段（如未来新增 `releaseNote`、`tags`），保障同 schema 前向兼容；
 * - 对单条目声明的 `requiredCapabilities` 仅透传保留，由上层读口按 `evaluateCapabilities` 标为“需升级知行”，绝不整包作废。
 */
export function parseCuratedCatalogBundle(
  raw: unknown,
  options: { readonly supportedCapabilities?: ReadonlySet<string> } = {},
): CuratedCatalogBundle {
  const root = assertSafeObject(raw, "catalog");
  if (root["schemaVersion"] !== CURATED_CATALOG_SCHEMA_VERSION) {
    throw new CatalogSchemaError(
      `不支持的目录 schemaVersion：${String(root["schemaVersion"])}（当前版本支持 ${CURATED_CATALOG_SCHEMA_VERSION}）`,
    );
  }
  const catalogRevision = assertNonEmptyString(root["catalogRevision"], "catalog.catalogRevision");
  if (!isStrictRfc3339Utc(root["publishedAt"])) {
    throw new CatalogSchemaError(`catalog.publishedAt 必须是严格 RFC 3339 UTC 时间：${String(root["publishedAt"])}`);
  }
  const minCapabilities = assertOptionalStringArray(root["minCapabilities"], "catalog.minCapabilities");
  if (minCapabilities) {
    const gate = evaluateCapabilities(minCapabilities, options.supportedCapabilities);
    if (!gate.supported) {
      throw new CatalogSchemaError(
        `目录要求当前客户端尚不支持的最低能力：${gate.missingCapabilities.join(", ")}`,
      );
    }
  }

  let upgradeNotice: CatalogUpgradeNotice | undefined;
  if (root["upgradeNotice"] !== undefined) {
    const noticeRec = assertSafeObject(root["upgradeNotice"], "catalog.upgradeNotice");
    const minAppVersion = assertNonEmptyString(noticeRec["minAppVersion"], "catalog.upgradeNotice.minAppVersion");
    const message = assertNonEmptyString(noticeRec["message"], "catalog.upgradeNotice.message");
    const transitionEndsAt = noticeRec["transitionEndsAt"];
    if (transitionEndsAt !== undefined && !isStrictRfc3339Utc(transitionEndsAt)) {
      throw new CatalogSchemaError("catalog.upgradeNotice.transitionEndsAt 必须是严格 RFC 3339 UTC 时间");
    }
    upgradeNotice = {
      minAppVersion,
      message,
      ...(transitionEndsAt ? { transitionEndsAt } : {}),
    };
  }

  if (!Array.isArray(root["presets"]) || root["presets"].length === 0) {
    throw new CatalogSchemaError("catalog.presets 必须是非空数组");
  }
  const presetIds = new Set<string>();
  const presets: CuratedPreset[] = root["presets"].map((item, idx) => {
    const label = `catalog.presets[${idx}]`;
    const rec = assertSafeObject(item, label);
    const id = assertNonEmptyString(rec["id"], `${label}.id`);
    if (presetIds.has(id)) {
      throw new CatalogSchemaError(`${label}.id 重复：${id}`);
    }
    presetIds.add(id);
    const name = assertNonEmptyString(rec["name"], `${label}.name`);
    const presetRevision = assertNonEmptyString(rec["presetRevision"], `${label}.presetRevision`);
    const allowLocalHttp =
      rec["defaultAuthMode"] === "none" ||
      (typeof rec["defaultNetwork"] === "object" &&
        rec["defaultNetwork"] !== null &&
        (rec["defaultNetwork"] as Record<string, unknown>)["allowPrivateOrigin"] === true);
    const baseUrl = assertSafeHttpUrl(rec["baseUrl"], `${label}.baseUrl`, allowLocalHttp);
    const alternateBaseUrls =
      rec["alternateBaseUrls"] !== undefined
        ? (assertOptionalStringArray(rec["alternateBaseUrls"], `${label}.alternateBaseUrls`) ?? []).map(
            (u, i) => assertSafeHttpUrl(u, `${label}.alternateBaseUrls[${i}]`, allowLocalHttp),
          )
        : undefined;
    const protocol = assertNonEmptyString(rec["protocol"], `${label}.protocol`);
    if (!VALID_ADAPTERS.has(protocol)) {
      // 允许前向条目携带尚未实现的 protocol（通过 requiredCapabilities 局部标“需升级知行”）
      const reqCaps = assertOptionalStringArray(rec["requiredCapabilities"], `${label}.requiredCapabilities`);
      if (!reqCaps || reqCaps.length === 0) {
        throw new CatalogSchemaError(`${label}.protocol 未注册且未声明 requiredCapabilities：${protocol}`);
      }
    }
    const defaultAuthMode = rec["defaultAuthMode"];
    if (defaultAuthMode !== "none" && defaultAuthMode !== "api-key" && defaultAuthMode !== "header") {
      throw new CatalogSchemaError(`${label}.defaultAuthMode 非法：${String(defaultAuthMode)}`);
    }
    const discoveryRec = assertSafeObject(rec["discovery"], `${label}.discovery`);
    const mode = discoveryRec["mode"];
    if (mode !== "native" && mode !== "optional-compat") {
      throw new CatalogSchemaError(`${label}.discovery.mode 非法：${String(mode)}`);
    }
    const kind = assertNonEmptyString(discoveryRec["kind"], `${label}.discovery.kind`);
    if (!VALID_DISCOVERY_KINDS.has(kind)) {
      throw new CatalogSchemaError(`${label}.discovery.kind 未注册：${kind}`);
    }
    const urlBase = discoveryRec["urlBase"];
    if (urlBase !== "baseUrl" && urlBase !== "origin") {
      throw new CatalogSchemaError(`${label}.discovery.urlBase 非法：${String(urlBase)}`);
    }
    const discoveryPath = assertNonEmptyString(discoveryRec["path"], `${label}.discovery.path`);
    if (!discoveryPath.startsWith("/")) {
      throw new CatalogSchemaError(`${label}.discovery.path 必须以 / 开头`);
    }
    const uiRec = assertSafeObject(rec["ui"], `${label}.ui`);
    const ui: PresetUiMetadata = {
      label: assertNonEmptyString(uiRec["label"], `${label}.ui.label`),
      description: assertNonEmptyString(uiRec["description"], `${label}.ui.description`),
      apiKeyHint: assertNonEmptyString(uiRec["apiKeyHint"], `${label}.ui.apiKeyHint`),
      apiKeyExample: typeof uiRec["apiKeyExample"] === "string" ? uiRec["apiKeyExample"] : "",
      ...(uiRec["docUrl"] !== undefined
        ? { docUrl: assertSafeHttpUrl(uiRec["docUrl"], `${label}.ui.docUrl`, false) }
        : {}),
      ...(uiRec["modelListDocUrl"] !== undefined
        ? { modelListDocUrl: assertSafeHttpUrl(uiRec["modelListDocUrl"], `${label}.ui.modelListDocUrl`, false) }
        : {}),
      ...(typeof uiRec["modelExample"] === "string" && uiRec["modelExample"].trim()
        ? { modelExample: uiRec["modelExample"].trim() }
        : {}),
    };
    const lifecycle = rec["lifecycle"];
    if (lifecycle !== undefined && (typeof lifecycle !== "string" || !VALID_LIFECYCLES.has(lifecycle))) {
      throw new CatalogSchemaError(`${label}.lifecycle 非法：${String(lifecycle)}`);
    }
    const requiredCapabilities = assertOptionalStringArray(
      rec["requiredCapabilities"],
      `${label}.requiredCapabilities`,
    );

    return {
      id,
      name,
      presetRevision,
      baseUrl,
      ...(alternateBaseUrls && alternateBaseUrls.length > 0 ? { alternateBaseUrls } : {}),
      protocol: protocol as Protocol,
      ...(Array.isArray(rec["allowedProtocols"])
        ? { allowedProtocols: rec["allowedProtocols"] as Protocol[] }
        : {}),
      defaultAuthMode,
      ...(typeof rec["defaultHeaderName"] === "string" && rec["defaultHeaderName"].trim()
        ? { defaultHeaderName: rec["defaultHeaderName"].trim() }
        : {}),
      ...(rec["defaultNetwork"] && typeof rec["defaultNetwork"] === "object"
        ? { defaultNetwork: rec["defaultNetwork"] as CuratedPreset["defaultNetwork"] }
        : {}),
      ...(rec["quirks"] && typeof rec["quirks"] === "object"
        ? { quirks: rec["quirks"] as Partial<ProviderQuirks> }
        : {}),
      discovery: {
        mode,
        kind: kind as DiscoveryKind,
        urlBase,
        path: discoveryPath,
        ...(discoveryRec["verifiedOrigins"] !== undefined
          ? {
              verifiedOrigins: assertOptionalStringArray(
                discoveryRec["verifiedOrigins"],
                `${label}.discovery.verifiedOrigins`,
              ),
            }
          : {}),
        authoritativeNativeFacts: Boolean(discoveryRec["authoritativeNativeFacts"]),
        ...(discoveryRec["docUrl"] !== undefined
          ? { docUrl: assertSafeHttpUrl(discoveryRec["docUrl"], `${label}.discovery.docUrl`, false) }
          : {}),
      },
      ui,
      ...(lifecycle ? { lifecycle: lifecycle as CatalogLifecycle } : {}),
      ...(requiredCapabilities ? { requiredCapabilities } : {}),
    };
  });

  if (!Array.isArray(root["models"])) {
    throw new CatalogSchemaError("catalog.models 必须是数组");
  }
  const seenModelKey = new Set<string>();
  const models: CuratedModelEntry[] = root["models"].map((item, idx) => {
    const label = `catalog.models[${idx}]`;
    const rec = assertSafeObject(item, label);
    const presetId = assertNonEmptyString(rec["presetId"], `${label}.presetId`);
    if (!presetIds.has(presetId)) {
      throw new CatalogSchemaError(`${label}.presetId 引用不存在的预设：${presetId}`);
    }
    const id = assertNonEmptyString(rec["id"], `${label}.id`);
    const dedupeKey = `${presetId}::${id}`;
    if (seenModelKey.has(dedupeKey)) {
      throw new CatalogSchemaError(`${label} 重复声明模型：${dedupeKey}`);
    }
    seenModelKey.add(dedupeKey);

    const purpose = rec["purpose"];
    if (purpose !== undefined && (typeof purpose !== "string" || !VALID_PURPOSES.has(purpose))) {
      throw new CatalogSchemaError(`${label}.purpose 非法：${String(purpose)}`);
    }
    const lifecycle = rec["lifecycle"];
    if (lifecycle !== undefined && (typeof lifecycle !== "string" || !VALID_LIFECYCLES.has(lifecycle))) {
      throw new CatalogSchemaError(`${label}.lifecycle 非法：${String(lifecycle)}`);
    }
    const requiredCapabilities = assertOptionalStringArray(
      rec["requiredCapabilities"],
      `${label}.requiredCapabilities`,
    );
    const paramSemanticsRaw = assertOptionalStringArray(rec["paramSemantics"], `${label}.paramSemantics`);
    let paramSemantics: RegisteredParamSemanticId[] | undefined;
    if (paramSemanticsRaw) {
      for (const sem of paramSemanticsRaw) {
        if (!REGISTERED_PARAM_SEMANTICS_SET.has(sem)) {
          if (!requiredCapabilities || requiredCapabilities.length === 0) {
            throw new CatalogSchemaError(
              `${label}.paramSemantics 包含未注册参数语义 "${sem}" 且未声明 requiredCapabilities`,
            );
          }
        }
      }
      paramSemantics = paramSemanticsRaw.filter((s) =>
        REGISTERED_PARAM_SEMANTICS_SET.has(s),
      ) as RegisteredParamSemanticId[];
    }
    const thinkingControl =
      rec["thinkingControl"] !== undefined
        ? validateThinkingControl(rec["thinkingControl"], `${label}.thinkingControl`)
        : undefined;
    const contextWindow = validateOptionalPositiveInt(rec["contextWindow"], `${label}.contextWindow`);
    const maxOutputTokens = validateOptionalPositiveInt(rec["maxOutputTokens"], `${label}.maxOutputTokens`);
    const recommendedMaxOutputTokens = validateOptionalPositiveInt(
      rec["recommendedMaxOutputTokens"],
      `${label}.recommendedMaxOutputTokens`,
    );
    const verifiedAt = rec["verifiedAt"];
    if (verifiedAt !== undefined && !isStrictRfc3339Utc(verifiedAt)) {
      throw new CatalogSchemaError(`${label}.verifiedAt 必须是严格 RFC 3339 UTC 时间`);
    }

    return {
      presetId,
      id,
      ...(typeof rec["name"] === "string" && rec["name"].trim() ? { name: rec["name"].trim() } : {}),
      ...(rec["aliases"] !== undefined
        ? { aliases: assertOptionalStringArray(rec["aliases"], `${label}.aliases`) }
        : {}),
      ...(purpose ? { purpose: purpose as ModelPurpose } : {}),
      ...(lifecycle ? { lifecycle: lifecycle as CatalogLifecycle } : {}),
      ...(typeof rec["replacementModelId"] === "string" && rec["replacementModelId"].trim()
        ? { replacementModelId: rec["replacementModelId"].trim() }
        : {}),
      ...(typeof rec["lifecycleReason"] === "string" && rec["lifecycleReason"].trim()
        ? { lifecycleReason: rec["lifecycleReason"].trim() }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(recommendedMaxOutputTokens !== undefined ? { recommendedMaxOutputTokens } : {}),
      ...(typeof rec["supportsTools"] === "boolean" ? { supportsTools: rec["supportsTools"] } : {}),
      ...(typeof rec["supportsImages"] === "boolean" ? { supportsImages: rec["supportsImages"] } : {}),
      ...(typeof rec["supportsThinking"] === "boolean" ? { supportsThinking: rec["supportsThinking"] } : {}),
      ...(thinkingControl ? { thinkingControl } : {}),
      ...(paramSemantics && paramSemantics.length > 0 ? { paramSemantics } : {}),
      ...(rec["pricing"] && typeof rec["pricing"] === "object"
        ? { pricing: rec["pricing"] as ModelPricingInfo }
        : {}),
      ...(verifiedAt ? { verifiedAt } : {}),
      ...(typeof rec["evidenceSource"] === "string" && rec["evidenceSource"].trim()
        ? { evidenceSource: rec["evidenceSource"].trim() }
        : {}),
      ...(requiredCapabilities ? { requiredCapabilities } : {}),
    };
  });

  if (!Array.isArray(root["recommendations"])) {
    throw new CatalogSchemaError("catalog.recommendations 必须是数组");
  }
  const recommendations: CuratedRecommendation[] = root["recommendations"].map((item, idx) => {
    const label = `catalog.recommendations[${idx}]`;
    const rec = assertSafeObject(item, label);
    const role = assertNonEmptyString(rec["role"], `${label}.role`);
    if (!VALID_ROLES.has(role)) {
      throw new CatalogSchemaError(`${label}.role 非法：${role}`);
    }
    const presetId = assertNonEmptyString(rec["presetId"], `${label}.presetId`);
    if (!presetIds.has(presetId)) {
      throw new CatalogSchemaError(`${label}.presetId 引用不存在的预设：${presetId}`);
    }
    const modelId = assertNonEmptyString(rec["modelId"], `${label}.modelId`);
    const rationale = assertNonEmptyString(rec["rationale"], `${label}.rationale`);
    const evidenceSource = assertNonEmptyString(rec["evidenceSource"], `${label}.evidenceSource`);
    if (!isStrictRfc3339Utc(rec["verifiedAt"])) {
      throw new CatalogSchemaError(`${label}.verifiedAt 必须是严格 RFC 3339 UTC 时间`);
    }
    const requiredCapabilities = assertOptionalStringArray(
      rec["requiredCapabilities"],
      `${label}.requiredCapabilities`,
    );
    return {
      role: role as ModelRoleId,
      presetId,
      modelId,
      rationale,
      evidenceSource,
      verifiedAt: rec["verifiedAt"],
      ...(typeof rec["replacementReason"] === "string" && rec["replacementReason"].trim()
        ? { replacementReason: rec["replacementReason"].trim() }
        : {}),
      ...(requiredCapabilities ? { requiredCapabilities } : {}),
    };
  });

  const thresholdsRaw =
    root["attentionThresholds"] !== undefined
      ? assertSafeObject(root["attentionThresholds"], "catalog.attentionThresholds")
      : {};
  const attentionThresholds: Record<string, CuratedAttentionThreshold> = {};
  for (const [key, val] of Object.entries(thresholdsRaw)) {
    const label = `catalog.attentionThresholds[${key}]`;
    const rec = assertSafeObject(val, label);
    const modelKey = assertNonEmptyString(rec["modelKey"] ?? key, `${label}.modelKey`).toLowerCase();
    const optimalMaxTokens = validateOptionalPositiveInt(rec["optimalMaxTokens"], `${label}.optimalMaxTokens`);
    const riskMaxTokens = validateOptionalPositiveInt(rec["riskMaxTokens"], `${label}.riskMaxTokens`);
    if (optimalMaxTokens === undefined || riskMaxTokens === undefined || riskMaxTokens < optimalMaxTokens) {
      throw new CatalogSchemaError(`${label} 需要合法的 optimalMaxTokens <= riskMaxTokens`);
    }
    const source = assertNonEmptyString(rec["source"], `${label}.source`);
    const verifiedAt = rec["verifiedAt"];
    if (verifiedAt !== undefined && !isStrictRfc3339Utc(verifiedAt)) {
      throw new CatalogSchemaError(`${label}.verifiedAt 必须是严格 RFC 3339 UTC 时间`);
    }
    attentionThresholds[modelKey] = {
      modelKey,
      optimalMaxTokens,
      riskMaxTokens,
      source,
      ...(verifiedAt ? { verifiedAt } : {}),
    };
  }

  return {
    schemaVersion: CURATED_CATALOG_SCHEMA_VERSION,
    catalogRevision,
    publishedAt: root["publishedAt"],
    ...(minCapabilities ? { minCapabilities } : {}),
    ...(upgradeNotice ? { upgradeNotice } : {}),
    presets,
    models,
    recommendations,
    attentionThresholds,
  };
}

function validateOptionalPositiveInt(value: unknown, pathLabel: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new CatalogSchemaError(`${pathLabel} 必须是正整数`);
  }
  return value;
}

// ─── Ollama 兼容推理与原生发现路径归一（实施期注意项 #4） ───

export interface NormalizedOllamaEndpoints {
  /** OpenAI 兼容推理基路径（给 OpenAI SDK，确保 `/v1` 不缺也不重复，且保留显式自定义 basePath）。 */
  readonly inferenceBaseUrl: string;
  /** Ollama 原生 `/api/tags` 发现地址（绝不误加 `/v1`，且保留显式自定义 basePath）。 */
  readonly nativeTagsUrl: string;
  /** Ollama 原生 `/api/show` 详情地址（绝不误加 `/v1`，且保留显式自定义 basePath）。 */
  readonly nativeShowUrl: string;
}

/**
 * 统一解析 Ollama 端点（实施期注意项 #4）：
 * - `http://127.0.0.1:11434` / `http://127.0.0.1:11434/`：
 *   推理 → `http://127.0.0.1:11434/v1`；原生 → `http://127.0.0.1:11434/api/tags` & `/api/show`
 * - `http://127.0.0.1:11434/v1` / `http://127.0.0.1:11434/v1/`：
 *   推理 → `http://127.0.0.1:11434/v1`（绝不重复 `/v1/v1`）；原生 → `http://127.0.0.1:11434/api/tags`（绝不误加 `/v1`）
 * - 用户显式指定自定义 `basePath`（如 `https://gw.example.com/ollama-proxy` 或 `https://gw.example.com/ollama-proxy/v1`）：
 *   保留自定义 `basePath` 不改写：`https://gw.example.com/ollama-proxy` 推理按原样保留，
 *   原生剥除末尾可选 `/v1` 拼 `/api/tags` 与 `/api/show`。
 */
export function normalizeOllamaEndpoints(endpoint: string): NormalizedOllamaEndpoints {
  const trimmed = endpoint.trim().replace(/\/+$/u, "");
  const parsed = new URL(trimmed);
  const cleanPath = parsed.pathname.replace(/\/+$/u, "");
  const origin = parsed.origin;

  // 默认根路径（无自定义 basePath）
  if (cleanPath === "") {
    return {
      inferenceBaseUrl: `${origin}/v1`,
      nativeTagsUrl: `${origin}/api/tags`,
      nativeShowUrl: `${origin}/api/show`,
    };
  }
  // 标准根 `/v1`
  if (cleanPath === "/v1") {
    return {
      inferenceBaseUrl: `${origin}/v1`,
      nativeTagsUrl: `${origin}/api/tags`,
      nativeShowUrl: `${origin}/api/show`,
    };
  }
  // 用户显式指定了自定义 basePath（如 `/my-ollama` 或 `/my-ollama/v1`）：绝不改写推理 basePath
  const nativePrefix = cleanPath.endsWith("/v1")
    ? cleanPath.slice(0, -3)
    : cleanPath;
  return {
    inferenceBaseUrl: `${origin}${cleanPath}`,
    nativeTagsUrl: `${origin}${nativePrefix}/api/tags`,
    nativeShowUrl: `${origin}${nativePrefix}/api/show`,
  };
}

/**
 * 为推理适配器解析最终 `baseUrl`：
 * 仅对 `ollama` 预设且 `openai-compatible` 协议执行根路径 `/v1` 归一，
 * 其他预设及用户显式自定义 `basePath` 均保持原样（仅去尾斜杠）。
 */
export function resolveInferenceBaseUrl(
  endpoint: string,
  adapter: ModelAdapterId,
  presetId?: string,
): string {
  const trimmed = endpoint.trim().replace(/\/+$/u, "");
  if (presetId === "ollama" && adapter === "openai-compatible") {
    try {
      return normalizeOllamaEndpoints(trimmed).inferenceBaseUrl;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
