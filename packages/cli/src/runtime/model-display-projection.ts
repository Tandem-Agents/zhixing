/**
 * 统一生效模型显示投影（设计 §3.1、§3.4 #4）。
 *
 * 供 `ReplLocalView`、`/status`、状态栏 `terminalEnvironment`、交互 `/model` 与非交互文本 `/model`
 * 共同消费，消除各表面各自读取启动期 `main` 配置造成的漂移：
 * - 同时兼容 v2 (`LLMConfigV2`) 与历史 v1 (`LegacyLLMConfigV1`)；
 * - 直接复用真实运行时解析合同（`resolveLLMRoles` / `resolveSessionOverride`）：当可选用途（`light`/`power`）
 *   显式配置失效且 `main` 可用时，如实将实际运行的 `main` 投影为“当前生效”，同时完整保留原配置意图与回退警示，
 *   绝不另造与运行期分裂的平行规则；
 * - 完整透传 `params` 与 `maxOutputPreference`（含本会话覆盖与三用途默认）；
 * - 不可用当前项（如主模型本身失效或本会话显式覆盖失效）始终保留可见并说明原因与修复入口。
 */

import type { ModelSelectionParams, SessionModelSelection } from "@zhixing-ai/core";
import {
  DEFAULT_MODEL_CATALOG_PORT,
  evaluateCapabilities,
  isLLMConfigV2,
  ProviderConfigError,
  resolveInferenceBaseUrl,
  resolveLLMRoles,
  resolveSessionOverride,
  ROLE_SPECS,
  type LegacyLLMConfigV1,
  type LLMConfigV2,
  type ModelCatalogPort,
  type ModelConnectionConfig,
  type ProviderCredentialProjection,
  type ResolvedLLMRole,
  type ResolvedLLMRoles,
  type RoleDegradation,
  type RoleId,
  type ZhixingConfig,
} from "@zhixing-ai/providers/configuration";
import { connectionCredentialStatus } from "./model-configuration-check.js";

export interface RoleDefaultDisplay {
  readonly role: RoleId;
  readonly labelZh: string;
  readonly configured: boolean;
  readonly followsMain: boolean;
  /** 可选用途（light / power）显式配置不可用且运行已回退至 main 时为 true。 */
  readonly degradedToMain?: boolean;
  /** 实际生效的连接 ID（发生回退时为 main 的连接 ID）。 */
  readonly connectionId: string;
  readonly connectionName: string;
  readonly model: string;
  readonly params?: ModelSelectionParams;
  readonly paramsSummary?: string;
  readonly maxOutputPreference?: number;
  /** 仅 `degradedToMain === true` 时保留用户原配置意图，便于展示与 `/config` 修复。 */
  readonly configuredConnectionId?: string;
  readonly configuredConnectionName?: string;
  readonly configuredModel?: string;
  readonly degradationReason?: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface EffectiveModelDegradation {
  readonly role: "light" | "power";
  readonly connectionId: string;
  readonly connectionName: string;
  readonly model: string;
  readonly reason: string;
}

export interface EffectiveModelDisplay {
  /** 兼容既有投影字段：实际生效的 connectionId（v1 为 provider）。 */
  readonly providerId: string;
  readonly model: string;
  readonly connectionId?: string;
  readonly connectionName?: string;
  readonly adapter?: string;
  readonly mode?: "follow-default" | "override";
  readonly defaultRole?: "main" | "power";
  readonly sourceLabel?: string;
  readonly params?: ModelSelectionParams;
  readonly paramsSummary?: string;
  readonly maxOutputPreference?: number;
  readonly available?: boolean;
  readonly unavailableReason?: string;
  /** 非阻断运行警示（如工作场景 power 配置失效，当前运行已回退至 main）。 */
  readonly warning?: string;
  readonly degradedFrom?: EffectiveModelDegradation;
  readonly roles?: Readonly<{
    readonly main: RoleDefaultDisplay;
    readonly light: RoleDefaultDisplay;
    readonly power: RoleDefaultDisplay;
  }>;
}

export interface ProjectEffectiveModelInput {
  readonly config: Pick<ZhixingConfig, "llm" | "network">;
  readonly credentials?: ProviderCredentialProjection;
  readonly sessionMode?: "normal" | "workscene";
  readonly sessionSelection?: SessionModelSelection;
  readonly catalog?: ModelCatalogPort;
}

export function formatModelParamsSummary(
  params?: ModelSelectionParams,
  maxOutputPreference?: number,
): string | undefined {
  const parts: string[] = [];
  const thinking = params?.thinking;
  if (thinking) {
    if (thinking.mode === "off") parts.push("思考：关闭");
    else if (thinking.mode === "on") parts.push("思考：开启（默认）");
    else if (thinking.mode === "effort") parts.push(`思考：强度 ${thinking.effort}`);
    else if (thinking.mode === "budget") parts.push(`思考：预算 ${thinking.budget} tokens`);
  }
  if (maxOutputPreference !== undefined && Number.isFinite(maxOutputPreference)) {
    parts.push(`输出偏好：${Math.floor(maxOutputPreference)} tokens`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

interface TargetAvailabilityCheck {
  readonly available: boolean;
  /** 是否触发 `resolveConnection` / `assertModelCapabilitySupported` 运行期失败（可选用途会据此回退 main）。 */
  readonly runtimeBlocked: boolean;
  readonly unavailableReason?: string;
}

function evaluateV2TargetAvailability(
  connectionId: string,
  modelId: string,
  connections: Readonly<Record<string, ModelConnectionConfig>>,
  credentials: ProviderCredentialProjection | undefined,
  catalog: ModelCatalogPort,
): TargetAvailabilityCheck {
  if (!connectionId || !modelId) {
    return {
      available: false,
      runtimeBlocked: true,
      unavailableReason: "尚未配置有效连接或模型，请打开 /config 完成配置",
    };
  }
  const conn = connections[connectionId];
  if (!conn) {
    return {
      available: false,
      runtimeBlocked: true,
      unavailableReason: `连接「${connectionId}」不存在，请打开 /config 补建或用 /model 改选`,
    };
  }
  if (!catalog.isAdapterImplemented(conn.adapter)) {
    return {
      available: false,
      runtimeBlocked: true,
      unavailableReason: `协议「${conn.adapter}」当前版本不支持，请升级知行或切换连接`,
    };
  }
  if (!resolveInferenceBaseUrl(conn.endpoint, conn.adapter, conn.presetId)) {
    return {
      available: false,
      runtimeBlocked: true,
      unavailableReason: `连接「${conn.name || connectionId}」缺少有效端点地址，请打开 /config 修复`,
    };
  }
  if (conn.presetId) {
    const presetEntry = catalog.getPreset(conn.presetId);
    if (
      presetEntry?.curated.requiredCapabilities &&
      !evaluateCapabilities(presetEntry.curated.requiredCapabilities).supported
    ) {
      return {
        available: false,
        runtimeBlocked: true,
        unavailableReason: `连接预设「${conn.presetId}」需要升级知行客户端后方可使用`,
      };
    }
  }
  if (credentials) {
    const status = connectionCredentialStatus(conn, credentials);
    if (status === "compromised") {
      return {
        available: false,
        runtimeBlocked: true,
        unavailableReason: "凭据已封禁（存在但不可读取），请打开 /config 录入新密钥轮换",
      };
    }
    if (status === "revoked") {
      return {
        available: false,
        runtimeBlocked: true,
        unavailableReason: "凭据已撤销，请打开 /config 重新填写凭据",
      };
    }
    if (status === "missing") {
      return {
        available: false,
        runtimeBlocked: true,
        unavailableReason: "缺少连接凭据，请打开 /config 补全凭据",
      };
    }
    if (conn.auth.mode === "api-key" || conn.auth.mode === "header") {
      const entry = credentials.modelSecrets?.[conn.auth.secretRef];
      if (entry && entry.kind !== conn.auth.mode) {
        return {
          available: false,
          runtimeBlocked: true,
          unavailableReason: `认证模式（${conn.auth.mode}）与凭据记录类型（${entry.kind}）不匹配，请打开 /config 修复`,
        };
      }
    }
  }
  const curated = conn.presetId ? catalog.getCuratedModel(conn.presetId, modelId) : undefined;
  if (curated?.requiredCapabilities && !evaluateCapabilities(curated.requiredCapabilities).supported) {
    return {
      available: false,
      runtimeBlocked: true,
      unavailableReason: "该型号需要升级知行客户端后方可使用",
    };
  }
  if (curated?.lifecycle === "retired") {
    return {
      available: false,
      runtimeBlocked: false,
      unavailableReason: `型号已停供${curated.replacementModelId ? `（建议改用 ${curated.replacementModelId}）` : ""}，请改选其他型号`,
    };
  }
  return { available: true, runtimeBlocked: false };
}

function buildRoleFromResolved(
  role: RoleId,
  resolvedRole: ResolvedLLMRole,
  configured: boolean,
  followsMain: boolean,
  degradation: RoleDegradation | undefined,
  configuredConnName: string | undefined,
  friendlyDegradationReason: string | undefined,
  effectiveAvail: TargetAvailabilityCheck,
): RoleDefaultDisplay {
  const spec = ROLE_SPECS.find((item) => item.id === role)!;
  const paramsSummary = formatModelParamsSummary(
    resolvedRole.params,
    resolvedRole.maxOutputPreference,
  );
  return Object.freeze({
    role,
    labelZh: spec.labelZh,
    configured,
    followsMain,
    ...(degradation ? { degradedToMain: true } : {}),
    connectionId: resolvedRole.resolved.connectionId,
    connectionName: resolvedRole.resolved.name || resolvedRole.resolved.connectionId,
    model: resolvedRole.model,
    ...(resolvedRole.params ? { params: resolvedRole.params } : {}),
    ...(paramsSummary ? { paramsSummary } : {}),
    ...(resolvedRole.maxOutputPreference !== undefined
      ? { maxOutputPreference: resolvedRole.maxOutputPreference }
      : {}),
    ...(degradation
      ? {
          configuredConnectionId: degradation.configured.provider,
          configuredConnectionName: configuredConnName ?? degradation.configured.provider,
          configuredModel: degradation.configured.model,
          degradationReason: friendlyDegradationReason ?? degradation.reason,
        }
      : {}),
    available: effectiveAvail.available,
    ...(effectiveAvail.unavailableReason
      ? { unavailableReason: effectiveAvail.unavailableReason }
      : {}),
  });
}

function buildV2RoleDisplayFallback(
  role: RoleId,
  llm: LLMConfigV2,
  mainDisplay: RoleDefaultDisplay | undefined,
  credentials: ProviderCredentialProjection | undefined,
  catalog: ModelCatalogPort,
): RoleDefaultDisplay {
  const spec = ROLE_SPECS.find((item) => item.id === role)!;
  const sel = llm[role];
  if (!sel && role !== "main" && mainDisplay) {
    return Object.freeze({
      role,
      labelZh: spec.labelZh,
      configured: false,
      followsMain: true,
      connectionId: mainDisplay.connectionId,
      connectionName: mainDisplay.connectionName,
      model: mainDisplay.model,
      ...(mainDisplay.params ? { params: mainDisplay.params } : {}),
      ...(mainDisplay.paramsSummary ? { paramsSummary: mainDisplay.paramsSummary } : {}),
      ...(mainDisplay.maxOutputPreference !== undefined
        ? { maxOutputPreference: mainDisplay.maxOutputPreference }
        : {}),
      available: mainDisplay.available,
      ...(mainDisplay.unavailableReason ? { unavailableReason: mainDisplay.unavailableReason } : {}),
    });
  }
  const connectionId = sel?.connectionId ?? "";
  const model = sel?.model ?? "";
  const conn = connectionId ? llm.connections[connectionId] : undefined;
  const connectionName = conn?.name ?? connectionId;
  const paramsSummary = formatModelParamsSummary(sel?.params, sel?.maxOutputPreference);
  const avail = evaluateV2TargetAvailability(connectionId, model, llm.connections, credentials, catalog);

  // 可选用途（light / power）显式配置遇到运行期阻塞错误且 main 可用时，与 resolveLLMRoles 保持一致回退 main
  if (
    role !== "main" &&
    sel &&
    avail.runtimeBlocked &&
    mainDisplay &&
    mainDisplay.available
  ) {
    return Object.freeze({
      role,
      labelZh: spec.labelZh,
      configured: true,
      followsMain: false,
      degradedToMain: true,
      connectionId: mainDisplay.connectionId,
      connectionName: mainDisplay.connectionName,
      model: mainDisplay.model,
      ...(mainDisplay.params ? { params: mainDisplay.params } : {}),
      ...(mainDisplay.paramsSummary ? { paramsSummary: mainDisplay.paramsSummary } : {}),
      ...(mainDisplay.maxOutputPreference !== undefined
        ? { maxOutputPreference: mainDisplay.maxOutputPreference }
        : {}),
      configuredConnectionId: connectionId,
      configuredConnectionName: connectionName,
      configuredModel: model,
      degradationReason: avail.unavailableReason ?? "所配连接当前不可用",
      available: mainDisplay.available,
      ...(mainDisplay.unavailableReason ? { unavailableReason: mainDisplay.unavailableReason } : {}),
    });
  }

  return Object.freeze({
    role,
    labelZh: spec.labelZh,
    configured: Boolean(sel?.connectionId && sel?.model),
    followsMain: false,
    connectionId,
    connectionName,
    model,
    ...(sel?.params ? { params: sel.params } : {}),
    ...(paramsSummary ? { paramsSummary } : {}),
    ...(sel?.maxOutputPreference !== undefined
      ? { maxOutputPreference: sel.maxOutputPreference }
      : {}),
    available: avail.available,
    ...(avail.unavailableReason ? { unavailableReason: avail.unavailableReason } : {}),
  });
}

function buildV1RoleDisplayFallback(
  role: RoleId,
  llm: LegacyLLMConfigV1 | undefined,
  mainDisplay: RoleDefaultDisplay | undefined,
  credentials: ProviderCredentialProjection | undefined,
): RoleDefaultDisplay {
  const spec = ROLE_SPECS.find((item) => item.id === role)!;
  const sel = llm?.[role];
  if (!sel && role !== "main" && mainDisplay) {
    return Object.freeze({
      role,
      labelZh: spec.labelZh,
      configured: false,
      followsMain: true,
      connectionId: mainDisplay.connectionId,
      connectionName: mainDisplay.connectionName,
      model: mainDisplay.model,
      ...(mainDisplay.params ? { params: mainDisplay.params } : {}),
      ...(mainDisplay.paramsSummary ? { paramsSummary: mainDisplay.paramsSummary } : {}),
      available: mainDisplay.available,
      ...(mainDisplay.unavailableReason ? { unavailableReason: mainDisplay.unavailableReason } : {}),
    });
  }
  const connectionId = sel?.provider ?? "";
  const model = sel?.model ?? "";
  const params: ModelSelectionParams | undefined = sel?.thinking
    ? { thinking: sel.thinking }
    : undefined;
  const paramsSummary = formatModelParamsSummary(params);
  let available = Boolean(connectionId && model);
  let unavailableReason: string | undefined = !available
    ? "尚未配置有效服务商或模型，请打开 /config 完成配置"
    : undefined;
  if (available && credentials) {
    const key =
      credentials.modelSecrets?.[connectionId]?.value ??
      credentials.providers?.[connectionId]?.apiKey;
    if (!key?.trim()) {
      available = false;
      unavailableReason = "缺少连接凭据，请打开 /config 补全凭据";
    }
  }
  if (role !== "main" && sel && !available && mainDisplay?.available) {
    return Object.freeze({
      role,
      labelZh: spec.labelZh,
      configured: true,
      followsMain: false,
      degradedToMain: true,
      connectionId: mainDisplay.connectionId,
      connectionName: mainDisplay.connectionName,
      model: mainDisplay.model,
      ...(mainDisplay.params ? { params: mainDisplay.params } : {}),
      ...(mainDisplay.paramsSummary ? { paramsSummary: mainDisplay.paramsSummary } : {}),
      configuredConnectionId: connectionId,
      configuredConnectionName: connectionId,
      configuredModel: model,
      degradationReason: unavailableReason ?? "凭证或必要配置缺失",
      available: mainDisplay.available,
    });
  }
  return Object.freeze({
    role,
    labelZh: spec.labelZh,
    configured: Boolean(sel?.provider && sel?.model),
    followsMain: false,
    connectionId,
    connectionName: connectionId,
    model,
    ...(params ? { params } : {}),
    ...(paramsSummary ? { paramsSummary } : {}),
    available,
    ...(unavailableReason ? { unavailableReason } : {}),
  });
}

function tryResolveRuntimeRoles(
  config: Pick<ZhixingConfig, "llm" | "network">,
  credentials: ProviderCredentialProjection | undefined,
  catalog: ModelCatalogPort,
): ResolvedLLMRoles | undefined {
  if (!credentials || !config.llm) return undefined;
  try {
    return resolveLLMRoles(config as ZhixingConfig, credentials, { catalog });
  } catch (err) {
    if (err instanceof ProviderConfigError) return undefined;
    return undefined;
  }
}

function buildWorksceneDegradationWarning(
  power: RoleDefaultDisplay,
  main: RoleDefaultDisplay,
): { readonly warning: string; readonly degradedFrom: EffectiveModelDegradation } | undefined {
  if (!power.degradedToMain || !power.configuredConnectionId || !power.configuredModel) {
    return undefined;
  }
  const configuredConnName = power.configuredConnectionName ?? power.configuredConnectionId;
  const reason = power.degradationReason ?? "当前不可用";
  return {
    degradedFrom: Object.freeze({
      role: "power" as const,
      connectionId: power.configuredConnectionId,
      connectionName: configuredConnName,
      model: power.configuredModel,
      reason,
    }),
    warning: `原配置 power（${configuredConnName} · ${power.configuredModel}）当前不可用（${reason}），运行已回退至 main（${main.connectionName || main.connectionId} · ${main.model}）`,
  };
}

export function projectEffectiveModelDisplay(
  input: ProjectEffectiveModelInput,
): EffectiveModelDisplay {
  const catalog = input.catalog ?? DEFAULT_MODEL_CATALOG_PORT;
  const sessionMode = input.sessionMode ?? "normal";
  const defaultRole: "main" | "power" = sessionMode === "workscene" ? "power" : "main";
  const rawLlm = input.config.llm as unknown;
  const resolvedRoles = tryResolveRuntimeRoles(input.config, input.credentials, catalog);

  if (isLLMConfigV2(rawLlm)) {
    let main: RoleDefaultDisplay;
    let light: RoleDefaultDisplay;
    let power: RoleDefaultDisplay;

    if (resolvedRoles) {
      const mainAvail = evaluateV2TargetAvailability(
        resolvedRoles.main.resolved.connectionId,
        resolvedRoles.main.model,
        rawLlm.connections,
        input.credentials,
        catalog,
      );
      main = buildRoleFromResolved(
        "main",
        resolvedRoles.main,
        true,
        false,
        undefined,
        undefined,
        undefined,
        mainAvail,
      );

      const buildAuxFromResolved = (role: "light" | "power"): RoleDefaultDisplay => {
        const deg = resolvedRoles.degradations.find((d) => d.role === role);
        const explicit = rawLlm[role];
        const target = resolvedRoles[role];
        const effectiveAvail = evaluateV2TargetAvailability(
          target.resolved.connectionId,
          target.model,
          rawLlm.connections,
          input.credentials,
          catalog,
        );
        const configuredConnName = deg
          ? (rawLlm.connections[deg.configured.provider]?.name ?? deg.configured.provider)
          : undefined;
        const friendlyReason = deg
          ? (evaluateV2TargetAvailability(
              deg.configured.provider,
              deg.configured.model,
              rawLlm.connections,
              input.credentials,
              catalog,
            ).unavailableReason ?? deg.reason)
          : undefined;
        return buildRoleFromResolved(
          role,
          target,
          Boolean(explicit?.connectionId && explicit?.model),
          !explicit,
          deg,
          configuredConnName,
          friendlyReason,
          effectiveAvail,
        );
      };

      light = buildAuxFromResolved("light");
      power = buildAuxFromResolved("power");
    } else {
      main = buildV2RoleDisplayFallback("main", rawLlm, undefined, input.credentials, catalog);
      light = buildV2RoleDisplayFallback("light", rawLlm, main, input.credentials, catalog);
      power = buildV2RoleDisplayFallback("power", rawLlm, main, input.credentials, catalog);
    }

    const roles = Object.freeze({ main, light, power });

    const sel = input.sessionSelection;
    if (sel?.mode === "override") {
      const conn = rawLlm.connections[sel.connectionId];
      const connectionName = conn?.name ?? sel.connectionId;
      let avail = evaluateV2TargetAvailability(
        sel.connectionId,
        sel.model,
        rawLlm.connections,
        input.credentials,
        catalog,
      );
      // 与真实 resolveSessionOverride 对齐（如 headerName 非法等其他 ProviderConfigError）
      if (avail.available && input.credentials) {
        try {
          resolveSessionOverride(input.config as ZhixingConfig, input.credentials, sel, { catalog });
        } catch (err) {
          if (err instanceof ProviderConfigError) {
            avail = { available: false, runtimeBlocked: true, unavailableReason: err.message };
          }
        }
      }
      const paramsSummary = formatModelParamsSummary(sel.params, sel.maxOutputPreference);
      return Object.freeze({
        providerId: sel.connectionId,
        model: sel.model,
        connectionId: sel.connectionId,
        connectionName,
        ...(conn?.adapter ? { adapter: conn.adapter } : {}),
        mode: "override" as const,
        defaultRole,
        sourceLabel: "本会话覆盖",
        ...(sel.params ? { params: sel.params } : {}),
        ...(paramsSummary ? { paramsSummary } : {}),
        ...(sel.maxOutputPreference !== undefined
          ? { maxOutputPreference: sel.maxOutputPreference }
          : {}),
        available: avail.available,
        ...(avail.unavailableReason ? { unavailableReason: avail.unavailableReason } : {}),
        roles,
      });
    }

    const baseRole = defaultRole === "power" ? power : main;
    const conn = baseRole.connectionId ? rawLlm.connections[baseRole.connectionId] : undefined;
    const degradationNote =
      defaultRole === "power" ? buildWorksceneDegradationWarning(power, main) : undefined;
    const sourceLabel =
      defaultRole === "power"
        ? power.degradedToMain
          ? "跟随工作场景（power 不可用，已回退 main）"
          : power.followsMain
            ? "跟随工作场景（power 未单配，沿用 main）"
            : "跟随工作场景 power"
        : "跟随 main";
    return Object.freeze({
      providerId: baseRole.connectionId,
      model: baseRole.model,
      connectionId: baseRole.connectionId,
      connectionName: baseRole.connectionName,
      ...(conn?.adapter ? { adapter: conn.adapter } : {}),
      mode: "follow-default" as const,
      defaultRole,
      sourceLabel,
      ...(baseRole.params ? { params: baseRole.params } : {}),
      ...(baseRole.paramsSummary ? { paramsSummary: baseRole.paramsSummary } : {}),
      ...(baseRole.maxOutputPreference !== undefined
        ? { maxOutputPreference: baseRole.maxOutputPreference }
        : {}),
      available: baseRole.available,
      ...(baseRole.unavailableReason ? { unavailableReason: baseRole.unavailableReason } : {}),
      ...(degradationNote
        ? { warning: degradationNote.warning, degradedFrom: degradationNote.degradedFrom }
        : {}),
      roles,
    });
  }

  const legacyLlm = rawLlm as LegacyLLMConfigV1 | undefined;
  let main: RoleDefaultDisplay;
  let light: RoleDefaultDisplay;
  let power: RoleDefaultDisplay;

  if (resolvedRoles) {
    const okAvail: TargetAvailabilityCheck = { available: true, runtimeBlocked: false };
    main = buildRoleFromResolved(
      "main",
      resolvedRoles.main,
      true,
      false,
      undefined,
      undefined,
      undefined,
      okAvail,
    );
    const buildLegacyAux = (role: "light" | "power"): RoleDefaultDisplay => {
      const deg = resolvedRoles.degradations.find((d) => d.role === role);
      const explicit = legacyLlm?.[role];
      return buildRoleFromResolved(
        role,
        resolvedRoles[role],
        Boolean(explicit?.provider && explicit?.model),
        !explicit,
        deg,
        deg?.configured.provider,
        deg?.reason,
        okAvail,
      );
    };
    light = buildLegacyAux("light");
    power = buildLegacyAux("power");
  } else {
    main = buildV1RoleDisplayFallback("main", legacyLlm, undefined, input.credentials);
    light = buildV1RoleDisplayFallback("light", legacyLlm, main, input.credentials);
    power = buildV1RoleDisplayFallback("power", legacyLlm, main, input.credentials);
  }
  const roles = Object.freeze({ main, light, power });

  const sel = input.sessionSelection;
  if (sel?.mode === "override") {
    const paramsSummary = formatModelParamsSummary(sel.params, sel.maxOutputPreference);
    return Object.freeze({
      providerId: sel.connectionId,
      model: sel.model,
      connectionId: sel.connectionId,
      connectionName: sel.connectionId,
      mode: "override" as const,
      defaultRole,
      sourceLabel: "本会话覆盖",
      ...(sel.params ? { params: sel.params } : {}),
      ...(paramsSummary ? { paramsSummary } : {}),
      ...(sel.maxOutputPreference !== undefined
        ? { maxOutputPreference: sel.maxOutputPreference }
        : {}),
      available: Boolean(sel.connectionId && sel.model),
      roles,
    });
  }

  const baseRole = defaultRole === "power" ? power : main;
  const degradationNote =
    defaultRole === "power" ? buildWorksceneDegradationWarning(power, main) : undefined;
  const sourceLabel =
    defaultRole === "power"
      ? power.degradedToMain
        ? "跟随工作场景（power 不可用，已回退 main）"
        : power.followsMain
          ? "跟随工作场景（power 未单配，沿用 main）"
          : "跟随工作场景 power"
      : "跟随 main";
  return Object.freeze({
    providerId: baseRole.connectionId,
    model: baseRole.model,
    connectionId: baseRole.connectionId,
    connectionName: baseRole.connectionName,
    mode: "follow-default" as const,
    defaultRole,
    sourceLabel,
    ...(baseRole.params ? { params: baseRole.params } : {}),
    ...(baseRole.paramsSummary ? { paramsSummary: baseRole.paramsSummary } : {}),
    ...(baseRole.maxOutputPreference !== undefined
      ? { maxOutputPreference: baseRole.maxOutputPreference }
      : {}),
    available: baseRole.available,
    ...(baseRole.unavailableReason ? { unavailableReason: baseRole.unavailableReason } : {}),
    ...(degradationNote
      ? { warning: degradationNote.warning, degradedFrom: degradationNote.degradedFrom }
      : {}),
    roles,
  });
}

export function formatRoleBrief(role: RoleDefaultDisplay): string {
  if (!role.connectionId || !role.model) {
    return role.followsMain ? "沿用主模型（未配置）" : "未配置";
  }
  const base = `${role.connectionName || role.connectionId} · ${role.model}`;
  const notes: string[] = [];
  if (role.degradedToMain && role.configuredModel) {
    notes.push(
      `原配 ${role.configuredConnectionName || role.configuredConnectionId} · ${role.configuredModel} 不可用，已回退 main`,
    );
  } else if (role.followsMain) {
    notes.push("沿用 main");
  }
  if (role.paramsSummary) notes.push(role.paramsSummary);
  if (!role.available) notes.push("不可用");
  return notes.length > 0 ? `${base}（${notes.join(" · ")}）` : base;
}
