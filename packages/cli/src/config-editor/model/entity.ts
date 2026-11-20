/** Configuration decisions shared by both terminal surfaces. No renderer or input owner. */
/**
 * L3 实体配置面板：
 *   - provider-config：服务商配置（API Key 字段 + 模型选择 + 确认/返回按钮）
 *   - channel-config：channel 配置（appId / appSecret 等字段 + 启用/取消启用按钮）
 *
 * 布局共性：
 *   - 顶部：标题
 *   - 中部：字段列表（每行 label + 已填状态）
 *   - 底部：操作按钮
 *   - ↑↓ 在字段 + 按钮间移动；Enter 进入字段编辑或触发按钮
 *
 * 行/按钮统一接口：两者 `onEnter` 都返回 `OnEnterResult`，由 nav/pop/stay 组合子构造。
 * 这层统一让"按钮校验失败"和未来"行进入前 precondition 失败"用同一机制，无需扩接口。
 */
import {
  DEFAULT_MODEL_CATALOG_PORT,
  discoverConnectionModels,
  getPreset,
  hasExplicitUrlCredentialsOrQueryAuth,
  IMPLEMENTED_MODEL_ADAPTERS,
  isLLMConfigV2,
  ROLE_SPECS,
  synthesizeConnectionModels,
  type LLMConfigV2,
  type ModelConnectionConfig,
} from "@zhixing-ai/providers/configuration";
import { isLocalOrPrivateHostname, validateSingleHopHeaderName } from "@zhixing-ai/network";
import type { ConfigEditorRuntime, PanelAction, PanelDescriptor, Status, WorkingState } from "../types.js";
import {
  adoptPresetUpdateSuggestion,
  computeConnectionDraftFingerprint,
  confirmAuthRejectedSave,
  confirmProtectedLegacyProvider,
  deleteConnection,
  disableMessaging,
  discardProtectedLegacyProvider,
  enableMessaging,
  ignorePresetUpdateSuggestion,
  inspectConnectionDeleteImpact,
  isMessagingEnabled,
  messagingEnabledProjection,
  previewModelOverrideRestore,
  readChannelEntry,
  readConnection,
  readConnections,
  readConnectionSecretStatus,
  readConnectionSecretValue,
  readModelMaxOutputPreference,
  readModelRole,
  readProviderEntry,
  readRepairableLegacyProvider,
  recordDraftDiscoveryResult,
  recordDraftVerificationResult,
  redactProtectedLegacyEndpoint,
  removeCustomModel,
  removeModelOverride,
  upsertConnection,
  upsertModelOverride,
  writeModelRole,
} from "../state.js";
import { listSupportedProviders, listSupportedChannels, findSupportedChannel } from "../../registries/index.js";
import { maskForDisplay } from "../ui/mask.js";
import { checkModel, connectionCredentialStatus } from "../checks/model.js";
import { checkMessaging } from "../checks/messaging.js";
import type { KeyEvent } from "../../tui/key-event.js";

export interface OnEnterResult {
  action: PanelAction;
  errorMessage?: string;
}

export const nav = (state: WorkingState, panel: PanelDescriptor): OnEnterResult => ({
  action: { type: "navigate", state, panel },
});

export const pop = (state: WorkingState): OnEnterResult => ({
  action: { type: "pop", state },
});

export const stay = (state: WorkingState, errorMessage?: string): OnEnterResult => ({
  action: { type: "stay", state },
  errorMessage,
});

export interface EntityRow {
  label: string;
  status: Status;
  onEnter: (state: WorkingState) => OnEnterResult;
}

export interface EntityButton {
  label: string;
  /** 按钮右侧的 dim 说明文本（不含括号——渲染时自动加） */
  hint?: string;
  /** 主按钮：success 色边框 + label，视觉作为"建议动作"突出 */
  primary?: boolean;
  onEnter: (state: WorkingState) => OnEnterResult;
}

export interface EntityMeta {
  title: string;
  /** chrome body 内的简短描述——给用户当前实体的上下文 */
  description: string;
  rows: EntityRow[];
  buttons: EntityButton[];
}

export function buildProviderConfigMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "provider-config" }>,
  runtime?: ConfigEditorRuntime,
): EntityMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.providerId);
  const presetLookupId = conn?.presetId ?? descriptor.providerId;
  const provider = listSupportedProviders(catalog).find((p) => p.id === presetLookupId);
  const providerLabel = conn?.name ?? provider?.label ?? descriptor.providerId;
  const roleLabel = ROLE_SPECS.find(spec => spec.id === descriptor.role)!.labelZh;

  const credStatus = conn
    ? connectionCredentialStatus(conn, state.credentials)
    : undefined;
  const apiKey =
    conn && (conn.auth.mode === "api-key" || conn.auth.mode === "header")
      ? readConnectionSecretValue(state, conn.auth.secretRef)
      : readProviderEntry(state, descriptor.providerId)?.apiKey;
  const currentRole = readModelRole(state, descriptor.role);
  const userSelectedModel =
    currentRole?.provider === descriptor.providerId
      ? currentRole?.model
      : undefined;
  const roleRec = catalog.getRoleRecommendation(descriptor.role);
  const recommendedModel =
    roleRec?.provider === presetLookupId ? roleRec.model : undefined;
  const displayModel = userSelectedModel ?? recommendedModel;

  const secretRowStatus: Status =
    conn?.auth.mode === "none"
      ? { level: "ready", text: "免密连接（无需凭据）" }
      : credStatus === "compromised"
        ? { level: "pending", text: "已封禁 · 存在但不可读取（点击替换）" }
        : credStatus === "revoked"
          ? { level: "pending", text: "已撤销（点击重填）" }
          : apiKey
            ? { level: "ready", text: maskForDisplay(apiKey) }
            : { level: "pending", text: "待填" };

  const rows: EntityRow[] = [
    ...(conn?.auth.mode === "none"
      ? [
          {
            label: "认证方式",
            status: secretRowStatus,
            onEnter: (s: WorkingState) =>
              nav(s, { kind: "connection-config", connectionId: descriptor.providerId }),
          },
        ]
      : [
          {
            label: conn?.auth.mode === "header" ? `认证头 (${conn.auth.headerName})` : "API Key",
            status: secretRowStatus,
            onEnter: (s: WorkingState) =>
              nav(s, {
                kind: "input",
                fieldId: conn
                  ? `conn-secret:${descriptor.providerId}`
                  : `provider-apikey:${descriptor.role}:${descriptor.providerId}`,
              }),
          },
        ]),
    {
      label: "使用模型",
      status: !displayModel
        ? { level: "pending", text: "待选" }
        : userSelectedModel
          ? { level: "ready", text: userSelectedModel }
          : { level: "disabled", text: `(${descriptor.role} 推荐) ${recommendedModel}` },
      onEnter: (s) =>
        nav(s, {
          kind: "model-list",
          role: descriptor.role,
          providerId: descriptor.providerId,
        }),
    },
  ];

  const previewModel = userSelectedModel ?? recommendedModel ?? "";
  const previewState = writeModelRole(
    state,
    descriptor.role,
    descriptor.providerId,
    previewModel,
  );
  const myIssues = checkModel(
    previewState.config,
    previewState.credentials,
  ).filter((i) => i.role === descriptor.role);
  const canProceed = myIssues.length === 0;

  const currentMaxOutput =
    currentRole?.provider === descriptor.providerId
      ? readModelMaxOutputPreference(state, descriptor.role)
      : undefined;

  const buttons: EntityButton[] = [
    {
      label: "完成",
      hint: canProceed ? "保存此服务商配置" : "请先补全必填项",
      primary: canProceed,
      onEnter: (s) => {
        const current = readModelRole(s, descriptor.role);
        const model =
          current?.provider === descriptor.providerId
            ? current?.model
            : recommendedModel;
        const next = writeModelRole(s, descriptor.role, descriptor.providerId, model ?? "");
        const issues = checkModel(next.config, next.credentials).filter(
          (i) => i.role === descriptor.role,
        );
        if (issues.length > 0) {
          return stay(
            s,
            `请先填${issues.map((i) => i.fieldLabel).join(" 和 ")}`,
          );
        }
        return pop(next);
      },
    },
    ...(displayModel
      ? [
          {
            label: "调输出",
            hint:
              currentMaxOutput !== undefined
                ? `输出偏好（当前：${currentMaxOutput} tokens · 请求级偏好，与物理 maxOutputTokens 独立）`
                : "设置输出偏好（当前默认 · 请求级上限偏好，与物理规格覆盖独立）",
            onEnter: (s: WorkingState) =>
              nav(s, {
                kind: "input",
                fieldId: `role-max-output:${descriptor.role}:${descriptor.providerId}`,
              }),
          },
        ]
      : []),
  ];

  return {
    title: `${roleLabel} · ${providerLabel}`,
    description:
      currentMaxOutput !== undefined
        ? `配置 ${providerLabel} 的凭据、使用的模型与请求参数（当前输出偏好：${currentMaxOutput} tokens）`
        : `配置 ${providerLabel} 的凭据与使用的模型`,
    rows,
    buttons,
  };
}

export function buildConnectionConfigMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "connection-config" }>,
  runtime?: ConfigEditorRuntime,
): EntityMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.connectionId);
  if (!conn) {
    return {
      title: `连接 · ${descriptor.connectionId}`,
      description: "连接不存在",
      rows: [],
      buttons: [{ label: "返回", onEnter: (s) => pop(s) }],
    };
  }

  let isPrivateEndpoint = false;
  try {
    isPrivateEndpoint = isLocalOrPrivateHostname(new URL(conn.endpoint).hostname);
  } catch {
    isPrivateEndpoint = false;
  }

  const credStatus = readConnectionSecretStatus(state, descriptor.connectionId);
  const secretValue =
    conn.auth.mode === "api-key" || conn.auth.mode === "header"
      ? readConnectionSecretValue(state, conn.auth.secretRef)
      : undefined;
  const hasExistingMain = Boolean(
    readModelRole(state, "main")?.provider && readModelRole(state, "main")?.model,
  );
  const draftDiscovery = state.draftDiscoveryByConnection?.[descriptor.connectionId];
  const discoveredFirstModel =
    draftDiscovery?.status === "discovered" ? draftDiscovery.models[0]?.id : undefined;
  const defaultModelCandidate =
    descriptor.initialModel ??
    conn.customModels?.[0] ??
    discoveredFirstModel ??
    (conn.presetId ? (catalog.getPreset(conn.presetId)?.preset ?? getPreset(conn.presetId))?.knownModels?.[0]?.id : undefined);
  const draftVerify = defaultModelCandidate
    ? state.draftVerificationByConnection?.[descriptor.connectionId]?.[defaultModelCandidate]
    : undefined;

  const authModeLabel =
    conn.auth.mode === "none"
      ? "免密（无认证头）"
      : conn.auth.mode === "header"
        ? `自定义认证头（${conn.auth.headerName || "未设"}）`
        : "API Key";

  const rows: EntityRow[] = [
    {
      label: "连接名称",
      status: conn.name.trim()
        ? { level: "ready", text: conn.name }
        : { level: "pending", text: "待填" },
      onEnter: (s) => nav(s, { kind: "input", fieldId: `conn-name:${descriptor.connectionId}` }),
    },
    {
      label: "接口端点",
      status: conn.endpoint.trim()
        ? { level: "ready", text: conn.endpoint }
        : { level: "pending", text: "待填" },
      onEnter: (s) => nav(s, { kind: "input", fieldId: `conn-endpoint:${descriptor.connectionId}` }),
    },
    {
      label: "受控协议",
      status: { level: "ready", text: conn.adapter },
      onEnter: (s) => {
        const current = readConnection(s, descriptor.connectionId);
        if (!current) return stay(s);
        const curIdx = IMPLEMENTED_MODEL_ADAPTERS.indexOf(current.adapter);
        const nextAdapter =
          IMPLEMENTED_MODEL_ADAPTERS[
            (curIdx + 1) % IMPLEMENTED_MODEL_ADAPTERS.length
          ] ?? "openai-compatible";
        return stay(
          upsertConnection(s, descriptor.connectionId, { ...current, adapter: nextAdapter }),
        );
      },
    },
    {
      label: "认证方式",
      status: { level: "ready", text: authModeLabel },
      onEnter: (s) => {
        const current = readConnection(s, descriptor.connectionId);
        if (!current) return stay(s);
        const nextAuth: ModelConnectionConfig["auth"] =
          current.auth.mode === "api-key"
            ? { mode: "none" }
            : current.auth.mode === "none"
              ? { mode: "header", headerName: "X-Api-Key", secretRef: descriptor.connectionId }
              : { mode: "api-key", secretRef: descriptor.connectionId };
        return stay(
          upsertConnection(s, descriptor.connectionId, { ...current, auth: nextAuth }),
        );
      },
    },
  ];

  if (conn.auth.mode === "header") {
    const headerErr = validateSingleHopHeaderName(conn.auth.headerName);
    rows.push({
      label: "认证头名称",
      status: headerErr
        ? { level: "pending", text: headerErr }
        : { level: "ready", text: conn.auth.headerName },
      onEnter: (s) => nav(s, { kind: "input", fieldId: `conn-header:${descriptor.connectionId}` }),
    });
  }

  if (conn.auth.mode === "api-key" || conn.auth.mode === "header") {
    const status: Status =
      credStatus === "compromised"
        ? { level: "pending", text: "已封禁 · 存在但不可读取（点击录入新密钥替换）" }
        : credStatus === "revoked"
          ? { level: "pending", text: "已撤销（点击重填新密钥）" }
          : secretValue
            ? { level: "ready", text: maskForDisplay(secretValue) }
            : { level: "pending", text: "待填写" };
    rows.push({
      label: conn.auth.mode === "header" ? "认证头凭据" : "API Key",
      status,
      onEnter: (s) => nav(s, { kind: "input", fieldId: `conn-secret:${descriptor.connectionId}` }),
    });
  }

  rows.push({
    label: "代理策略",
    status: {
      level: "ready",
      text: conn.network.proxy === "direct" ? "直连（不走全局代理）" : "跟随全局代理",
    },
    onEnter: (s) => {
      const current = readConnection(s, descriptor.connectionId);
      if (!current) return stay(s);
      const nextProxy = current.network.proxy === "direct" ? "inherit" : "direct";
      return stay(
        upsertConnection(s, descriptor.connectionId, {
          ...current,
          network: { ...current.network, proxy: nextProxy },
        }),
      );
    },
  });

  if (isPrivateEndpoint) {
    rows.push({
      label: "本机/私网访问许可",
      status: conn.network.allowPrivateOrigin
        ? { level: "ready", text: "已允许此明确端点" }
        : { level: "pending", text: "未允许（点击开启）" },
      onEnter: (s) => {
        const current = readConnection(s, descriptor.connectionId);
        if (!current) return stay(s);
        return stay(
          upsertConnection(s, descriptor.connectionId, {
            ...current,
            network: {
              ...current.network,
              allowPrivateOrigin: !current.network.allowPrivateOrigin,
            },
          }),
        );
      },
    });
  }

  if (!hasExistingMain) {
    rows.push({
      label: "首次默认主模型",
      status: defaultModelCandidate
        ? { level: "ready", text: defaultModelCandidate }
        : { level: "pending", text: "待填（保存连接后将自动设为 main）" },
      onEnter: (s) =>
        nav(s, { kind: "input", fieldId: `conn-init-model:${descriptor.connectionId}` }),
    });
  }

  const discoveryStatus: Status = !draftDiscovery
    ? { level: "disabled", text: "未探测（按 Enter 在本地执行只读模型发现）" }
    : draftDiscovery.status === "discovered"
      ? {
          level: "ready",
          text: draftDiscovery.emptyList
            ? "已发现 · 列表接口可达但返回空（可保留手填）"
            : `已发现 ${draftDiscovery.models.length} 项（列表接口可达，未验证具体生成）`,
        }
      : draftDiscovery.status === "unsupported"
        ? { level: "disabled", text: "不支持列表发现（未验证凭据，不阻止保存）" }
        : draftDiscovery.status === "auth-rejected"
          ? { level: "pending", text: "401 鉴权被拒绝（请核对凭据或二次确认先存待修）" }
          : draftDiscovery.status === "restricted"
            ? { level: "pending", text: `403 受限（${draftDiscovery.errorSubcode ?? "待确认"}）` }
            : { level: "pending", text: "连通未确认（可切代理或离线保存草稿）" };

  rows.push({
    label: "发现 / 刷新模型列表",
    status: discoveryStatus,
    onEnter: (s) => {
      const current = readConnection(s, descriptor.connectionId);
      if (!current) return stay(s, "连接不存在");
      const draftRev = s.draftRevision ?? 0;
      const secret =
        current.auth.mode === "api-key" || current.auth.mode === "header"
          ? readConnectionSecretValue(s, current.auth.secretRef)
          : undefined;
      const runDiscovery = runtime?.discoverModels ?? discoverConnectionModels;
      return {
        action: {
          type: "loading",
          state: s,
          message: `正在发现 ${current.name} 的可用模型（按 Esc 可随时取消）…`,
          run: async (signal) => {
            const result = await runDiscovery({
              connectionId: descriptor.connectionId,
              ...(current.presetId ? { presetId: current.presetId } : {}),
              adapter: current.adapter,
              endpoint: current.endpoint,
              auth: current.auth,
              ...(secret ? { secretValue: secret } : {}),
              network: current.network,
              ...(s.config.network?.proxy !== undefined
                ? { networkProxy: s.config.network.proxy }
                : {}),
              catalog: catalog.bundle,
              ...(s.draftSessionId ? { requestSessionId: s.draftSessionId } : {}),
              draftRevision: draftRev,
              signal,
            });
            const nextState = recordDraftDiscoveryResult(s, descriptor.connectionId, result);
            return { type: "stay", state: nextState };
          },
        },
      };
    },
  });

  if (defaultModelCandidate) {
    const verifyStatus: Status =
      draftVerify?.status === "verified"
        ? { level: "ready", text: `已验证（${defaultModelCandidate}，${draftVerify.latencyMs}ms）` }
        : draftVerify?.status === "truncated"
          ? { level: "pending", text: `预算截断（${defaultModelCandidate} 未完成生成）` }
          : draftVerify?.status === "empty"
            ? { level: "pending", text: `空回复（${defaultModelCandidate} 未返回可见文本）` }
            : draftVerify?.status === "failed"
              ? { level: "pending", text: `验证失败（${draftVerify.userMessage.slice(0, 48)}）` }
              : { level: "disabled", text: `未验证（自愿可选，确认后验证 ${defaultModelCandidate}）` };
    rows.push({
      label: "可选生成验证（自愿）",
      status: verifyStatus,
      onEnter: (s) =>
        nav(s, {
          kind: "model-verify-confirm",
          connectionId: descriptor.connectionId,
          modelId: defaultModelCandidate,
        }),
    });
  }

  const presetSuggestion = catalog.getPresetUpdateSuggestion(descriptor.connectionId, conn);
  if (presetSuggestion) {
    rows.push({
      label: "预设更新建议",
      status: {
        level: "pending",
        text: `新修订 ${presetSuggestion.nextPresetRevision} 有地址或协议建议（按 Enter 并排对比）`,
      },
      onEnter: (s) =>
        nav(s, { kind: "preset-update-review", connectionId: descriptor.connectionId }),
    });
  }

  const customCount = conn.customModels?.length ?? 0;
  rows.push({
    label: "自定义型号",
    status:
      customCount > 0
        ? { level: "ready", text: `已登记 ${customCount} 个（增 / 改 / 删）` }
        : { level: "disabled", text: "未添加（按 Enter 登记自定义 model id）" },
    onEnter: (s) =>
      nav(s, { kind: "connection-custom-models", connectionId: descriptor.connectionId }),
  });

  const overrideCount = Object.keys(conn.modelOverrides ?? {}).length;
  const hiddenCount = conn.hiddenModels?.length ?? 0;
  let conflictedCount = 0;

  // 若当前连接存在 modelOverrides 与权威硬约束冲突，展示受限提示（保留原输入，运行侧按硬约束钳制）
  if (overrideCount > 0) {
    const synthesized = synthesizeConnectionModels({
      connectionId: descriptor.connectionId,
      connection: conn,
      catalog: catalog.bundle,
      discoveredModels: draftDiscovery?.status === "discovered" ? draftDiscovery.models : undefined,
      discoveredAuthoritative: draftDiscovery?.authoritativeNativeFacts,
      adapterImplemented: catalog.isAdapterImplemented(conn.adapter),
      includeHidden: true,
      includeOverrideOnlyIds: true,
    });
    const conflicted = synthesized.models.filter((m) => m.overrideConflicts.length > 0);
    conflictedCount = conflicted.length;
    if (conflicted.length > 0) {
      rows.push({
        label: "规格覆盖与硬约束提示",
        status: {
          level: "pending",
          text: `${conflicted.length} 个型号覆盖受硬约束钳制（已保留原输入，运行时按上限生效）`,
        },
        onEnter: (s) =>
          stay(
            s,
            conflicted
              .slice(0, 2)
              .map((m) => `${m.id}: ${m.overrideConflicts[0]!.message}`)
              .join("；"),
          ),
      });
    }
  }

  rows.push({
    label: "规格覆盖",
    status:
      overrideCount > 0
        ? {
            level: conflictedCount > 0 ? "pending" : "ready",
            text: `已设 ${overrideCount} 个型号覆盖${conflictedCount > 0 ? `（${conflictedCount} 个受硬约束限制）` : ""}（编辑 / 删除恢复预览）`,
          }
        : { level: "disabled", text: "无（按 Enter 为指定型号微调窗口或能力）" },
    onEnter: (s) =>
      nav(s, { kind: "connection-model-overrides", connectionId: descriptor.connectionId }),
  });

  rows.push({
    label: `已隐藏型号（${hiddenCount}）`,
    status:
      hiddenCount > 0
        ? { level: "ready", text: `已隐藏 ${hiddenCount} 个供应方型号（按 Enter 查看并恢复显示）` }
        : { level: "disabled", text: "无（按 Enter 可隐藏不需要的供应方型号）" },
    onEnter: (s) =>
      nav(s, { kind: "connection-hidden-models", connectionId: descriptor.connectionId }),
  });

  const currentDraftFingerprint = computeConnectionDraftFingerprint(state, descriptor.connectionId);
  const authRejectedUnconfirmed =
    draftDiscovery?.status === "auth-rejected" &&
    state.draftAuthRejectedConfirmed?.[descriptor.connectionId] !== currentDraftFingerprint;

  const validateBeforeSave = (s: WorkingState): string | null => {
    const current = readConnection(s, descriptor.connectionId);
    if (!current) return "连接不存在";
    if (!current.name.trim()) return "请填写连接名称";
    try {
      const parsed = new URL(current.endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "端点必须以 http:// 或 https:// 开头";
      }
      if (parsed.username || parsed.password) {
        return "端点 URL 禁止内嵌凭据";
      }
    } catch {
      return "端点 URL 格式无效";
    }
    if (current.auth.mode === "header") {
      const err = validateSingleHopHeaderName(current.auth.headerName);
      if (err) return err;
    }
    if (current.auth.mode !== "none") {
      const st = readConnectionSecretStatus(s, descriptor.connectionId);
      if (st === "compromised") return "当前凭据已封禁（存在但不可读取），请录入新密钥替换";
      if (st === "revoked") return "当前凭据已撤销，请重新录入密钥";
      if (st !== "ready") return "请先填写连接凭据";
    }
    return null;
  };

  const validationError = validateBeforeSave(state);
  const buttons: EntityButton[] = [
    {
      label: "保存",
      hint: validationError
        ? validationError
        : authRejectedUnconfirmed
          ? "401 鉴权被拒绝：请先修正凭据，或选择下方「先存」二次确认"
          : !hasExistingMain && defaultModelCandidate
            ? `保存此连接并自动绑定为主模型（${defaultModelCandidate}）`
            : "保存此连接（保留现有用途默认不变）",
      primary: validationError === null && !authRejectedUnconfirmed,
      onEnter: (s) => {
        const err = validateBeforeSave(s);
        if (err) return stay(s, err);
        const fp = computeConnectionDraftFingerprint(s, descriptor.connectionId);
        const disc = s.draftDiscoveryByConnection?.[descriptor.connectionId];
        if (
          disc?.status === "auth-rejected" &&
          s.draftAuthRejectedConfirmed?.[descriptor.connectionId] !== fp
        ) {
          return stay(
            s,
            "401 鉴权被拒绝：请重填 API Key / 认证头，或点击「先存」显式二次确认（不会冒充已验证）",
          );
        }
        const current = readConnection(s, descriptor.connectionId)!;
        const modelForFirstRun =
          current.customModels?.[0] ??
          descriptor.initialModel ??
          (disc?.status === "discovered" ? disc.models[0]?.id : undefined) ??
          (current.presetId ? (catalog.getPreset(current.presetId)?.preset ?? getPreset(current.presetId))?.knownModels?.[0]?.id : undefined);
        // 首次配置（尚无 main）自动同次绑定 main；常规新增绝不覆盖既有用途默认
        const next = upsertConnection(s, descriptor.connectionId, current, {
          ...(modelForFirstRun ? { autoBindMainModel: modelForFirstRun } : {}),
        });
        return pop(next);
      },
    },
  ];

  if (authRejectedUnconfirmed && validationError === null) {
    buttons.push({
      label: "先存",
      hint: "先存待修（确认保留 401 凭据草稿；仍标鉴权失败/待核对，不冒充已验证）",
      onEnter: (s) => {
        const err = validateBeforeSave(s);
        if (err) return stay(s, err);
        const confirmed = confirmAuthRejectedSave(s, descriptor.connectionId);
        const current = readConnection(confirmed, descriptor.connectionId)!;
        const next = upsertConnection(confirmed, descriptor.connectionId, current, {
          ...(defaultModelCandidate ? { autoBindMainModel: defaultModelCandidate } : {}),
        });
        return pop(next);
      },
    });
  }

  if (!descriptor.isNew) {
    buttons.push({
      label: "删除",
      hint: "删除此连接（先预览影响范围、用途重绑与在途策略）",
      onEnter: (s) =>
        nav(s, {
          kind: "connection-delete",
          connectionId: descriptor.connectionId,
          inFlightMode: "retire",
        }),
    });
  }

  return {
    title: `服务商连接 · ${conn.name}`,
    description: !hasExistingMain
      ? "首次连接配置完成后将自动绑定主模型默认；凭据保存在本地 SecretStore"
      : "修改连接信息不会覆盖现有主/轻/强力模型用途默认",
    rows,
    buttons,
  };
}

export function buildConnectionDeleteMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "connection-delete" }>,
): EntityMeta {
  const impact = inspectConnectionDeleteImpact(state, descriptor.connectionId);
  const connections = readConnections(state);
  const conn = connections[descriptor.connectionId];
  const mode = descriptor.inFlightMode ?? "retire";
  const selectedRebindId =
    descriptor.rebindMainConnectionId ?? impact.candidateRebindConnections[0];
  const rebindConn = selectedRebindId ? connections[selectedRebindId] : undefined;
  const selectedRebindModel =
    descriptor.rebindMainModel ??
    rebindConn?.customModels?.[0] ??
    (rebindConn?.presetId ? getPreset(rebindConn.presetId)?.knownModels?.[0]?.id : undefined) ??
    "default";

  const roleDesc =
    impact.referencedRoles.length > 0
      ? `受影响用途：${impact.referencedRoles.join(" / ")}（轻量/强力将回退主模型${impact.affectsMain ? "；主模型必须同时改绑" : ""}）`
      : "当前无用途默认引用此连接";
  const secretDesc = !impact.secretRef
    ? "免密连接，不涉及凭据清退"
    : impact.secretSharedWith.length > 0
      ? `逻辑凭据 "${impact.secretRef}" 与其他连接共用（${impact.secretSharedWith.join("、")}），普通删除将保留共用凭据`
      : `逻辑凭据 "${impact.secretRef}" 为本连接独占`;

  const rows: EntityRow[] = [];
  if (impact.affectsMain) {
    rows.push({
      label: "主模型改绑连接",
      status: selectedRebindId && rebindConn
        ? { level: "ready", text: `${rebindConn.name} (${selectedRebindId})` }
        : { level: "pending", text: "无其他可用连接，请先新增替代连接" },
      onEnter: (s) => {
        if (impact.candidateRebindConnections.length === 0) {
          return stay(s, "请先新增至少一条替代连接，再删除当前主模型连接");
        }
        const curIdx = selectedRebindId
          ? impact.candidateRebindConnections.indexOf(selectedRebindId)
          : -1;
        const nextId =
          impact.candidateRebindConnections[
            (curIdx + 1) % impact.candidateRebindConnections.length
          ]!;
        return {
          action: {
            type: "replace",
            state: s,
            panel: {
              ...descriptor,
              rebindMainConnectionId: nextId,
              rebindMainModel: undefined,
            },
          },
        };
      },
    });
    if (selectedRebindId) {
      rows.push({
        label: "主模型改绑模型 ID",
        status: { level: "ready", text: selectedRebindModel },
        onEnter: (s) =>
          nav(s, { kind: "input", fieldId: `conn-init-model:${selectedRebindId}` }),
      });
    }
  }

  rows.push({
    label: "在途调用与凭据处置",
    status: {
      level: "ready",
      text:
        mode === "retire"
          ? "等待在途调用自然结束后清退（retire）"
          : "立即中止在途调用并撤销凭据（revoke）",
    },
    onEnter: (s) => ({
      action: {
        type: "replace",
        state: s,
        panel: {
          ...descriptor,
          inFlightMode: mode === "retire" ? "revoke" : "retire",
        },
      },
    }),
  });

  const canDelete = !impact.affectsMain || Boolean(selectedRebindId && selectedRebindModel.trim());
  const buttons: EntityButton[] = [
    {
      label: "删连接",
      hint: canDelete
        ? "确认删除此连接（将在主界面点击「完成」后原子提交并生效）"
        : "主模型正在使用此连接，需先选择替代连接",
      primary: false,
      onEnter: (s) => {
        if (!canDelete) {
          return stay(s, "请先选择主模型替代连接，或先新增一条替代连接");
        }
        const next = deleteConnection(s, {
          connectionId: descriptor.connectionId,
          ...(impact.affectsMain && selectedRebindId
            ? {
                rebindMain: {
                  connectionId: selectedRebindId,
                  model: selectedRebindModel,
                },
              }
            : {}),
          mode,
        });
        return pop(next);
      },
    },
  ];

  return {
    title: `删除连接 · ${conn?.name ?? descriptor.connectionId}`,
    description: `${roleDesc}\n${secretDesc}`,
    rows,
    buttons,
  };
}

export function buildMigrationRepairProviderMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "migration-repair-provider" }>,
): EntityMeta {
  const found = readRepairableLegacyProvider(state, descriptor.providerId);
  if (!found) {
    return {
      title: `迁移修复 · ${descriptor.providerId}`,
      description: "该旧服务商条目已处理完毕",
      rows: [],
      buttons: [{ label: "返回", onEnter: (s) => pop(s) }],
    };
  }
  const legacy = found.entry;
  const confirmedOverride =
    descriptor.overrideEndpoint ?? state.confirmedRepairEndpoints?.[descriptor.providerId];
  const hasCleanOverride = Boolean(
    confirmedOverride && !hasExplicitUrlCredentialsOrQueryAuth(confirmedOverride),
  );
  const effectiveEndpoint = hasCleanOverride
    ? confirmedOverride!
    : found.blockedV1
      ? ""
      : (legacy.baseUrl ?? "");

  // 绝不在普通界面状态文本中直接回显未确认的受保护原始 URL 路径/查询参数
  const endpointStatus: Status = hasCleanOverride
    ? { level: "ready", text: confirmedOverride! }
    : found.blockedV1
      ? {
          level: "pending",
          text: `${redactProtectedLegacyEndpoint(legacy.baseUrl)} · 含敏感认证信息，请按 Enter 替换为纯净端点`,
        }
      : legacy.baseUrl
        ? { level: "ready", text: redactProtectedLegacyEndpoint(legacy.baseUrl) }
        : { level: "pending", text: "待填有效端点" };

  let isPrivate = false;
  try {
    isPrivate = effectiveEndpoint
      ? isLocalOrPrivateHostname(new URL(effectiveEndpoint).hostname)
      : false;
  } catch {
    isPrivate = false;
  }
  const allowPrivate = descriptor.allowPrivateOrigin ?? isPrivate;

  const preservedRoles: string[] = [];
  const rawLlm = state.config.llm as unknown;
  if (isLLMConfigV2(rawLlm)) {
    const matching = ((rawLlm as LLMConfigV2).migrationPending ?? []).find(
      (item) =>
        item.kind === "protected-legacy-roles" && item.sourceProviderId === descriptor.providerId,
    );
    if (matching?.legacyRoles) {
      for (const role of ["main", "light", "power"] as const) {
        if (matching.legacyRoles[role]) {
          preservedRoles.push(`${role}=${matching.legacyRoles[role]!.model}`);
        }
      }
    }
  } else if (state.config.llm) {
    for (const role of ["main", "light", "power"] as const) {
      const r = state.config.llm[role];
      if (r?.provider === descriptor.providerId) {
        preservedRoles.push(`${role}=${r.model}`);
      }
    }
  }

  const rows: EntityRow[] = [
    {
      label: "旧自定义端点",
      status: endpointStatus,
      onEnter: (s) =>
        nav(s, { kind: "input", fieldId: `repair-endpoint:${descriptor.providerId}` }),
    },
    {
      label: "本机/私网访问许可",
      status: allowPrivate
        ? { level: "ready", text: "允许访问此明确端点" }
        : { level: "disabled", text: "按公开 HTTPS 校验" },
      onEnter: (s) => ({
        action: {
          type: "replace",
          state: s,
          panel: { ...descriptor, allowPrivateOrigin: !allowPrivate },
        },
      }),
    },
  ];

  const canConfirm = Boolean(effectiveEndpoint.trim()) && !hasExplicitUrlCredentialsOrQueryAuth(effectiveEndpoint);
  const buttons: EntityButton[] = [
    {
      label: "迁入",
      hint: found.blockedV1 && !hasCleanOverride
        ? "旧端点含敏感认证信息，请先在上方替换为纯净端点 URL"
        : "确认迁入 v2 连接（写入纯净端点并恢复用途绑定，密钥保留在本地 SecretStore）",
      primary: canConfirm,
      onEnter: (s) => {
        try {
          const next = confirmProtectedLegacyProvider(s, descriptor.providerId, {
            ...(effectiveEndpoint ? { endpoint: effectiveEndpoint } : {}),
            allowPrivateOrigin: allowPrivate,
          });
          return pop(next);
        } catch (err) {
          return stay(s, err instanceof Error ? err.message : "迁移修复失败");
        }
      },
    },
    {
      label: "放弃",
      hint: "放弃并移除此受保护旧服务商条目与凭据",
      onEnter: (s) => pop(discardProtectedLegacyProvider(s, descriptor.providerId)),
    },
  ];

  const roleHint =
    preservedRoles.length > 0
      ? `\n确认后将自动恢复原用途默认：${preservedRoles.join("、")}`
      : "";
  return {
    title: `迁移修复 · ${descriptor.providerId}`,
    description:
      (found.blockedV1
        ? "旧自定义端点含 URL 内嵌凭据或敏感查询参数，已阻止自动迁移；请替换为不含认证信息的纯净端点后迁入 v2"
        : "旧配置中存在无法自动确认公开性质的自定义 baseUrl（已在界面隐去路径与参数）；确认后转为正式 v2 连接") +
      roleHint,
    rows,
    buttons,
  };
}

export function buildChannelConfigMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "channel-config" }>,
): EntityMeta {
  const channel = findSupportedChannel(state.channelCatalog ?? listSupportedChannels(), descriptor.channelId,
    state.config.messaging?.[descriptor.channelId]?.type ?? state.channelStates?.[descriptor.channelId]?.type);
  const channelLabel = channel?.label ?? descriptor.channelId;
  const channelCreds = readChannelEntry(state, descriptor.channelId) ?? {};
  const enabled = isMessagingEnabled(state, descriptor.channelId);

  const rows: EntityRow[] =
    channel?.requiredFields.map((field) => {
      const value = channelCreds[field.id];
      const status: Status = !value
        ? field.capabilityGroup
          ? { level: "pending", text: "选填·能力未启" }
          : { level: "pending", text: "待填" }
        : { level: "ready", text: field.sensitive ? maskForDisplay(value) : value };
      return {
        label: field.label,
        status,
        onEnter: (s) =>
          nav(s, {
            kind: "input",
            fieldId: `channel-field:${descriptor.channelId}:${field.id}`,
          }),
      };
    }) ?? [];

  // Preview 校验：未启用态——虚拟启用后跑 checkMessaging，决定 primary 与 hint
  // 已启用态：禁用是破坏性动作，永不 primary
  let canEnable = false;
  if (!enabled) {
    const previewState = enableMessaging(state, descriptor.channelId);
    const myIssues = checkMessaging(
      previewState.config,
      { channels: previewState.credentials.channels },
      messagingEnabledProjection(previewState),
      state.channelCatalog,
    ).filter((i) => i.channelId === descriptor.channelId);
    canEnable = myIssues.length === 0;
  }

  const buttons: EntityButton[] = [
    {
      label: enabled ? "禁用" : "启用",
      hint: enabled
        ? "停止接收外部消息"
        : canEnable
          ? "开始接收外部消息"
          : "请先补全必填项",
      // 启用按钮：仅凭证齐全时 primary（建议动作）；禁用按钮：始终非 primary（破坏性）
      primary: !enabled && canEnable,
      onEnter: (s) => {
        if (enabled) {
          return pop(disableMessaging(s, descriptor.channelId));
        }
        // 点击态再算一次 preview——defensive
        const next = enableMessaging(s, descriptor.channelId);
        const issues = checkMessaging(next.config, { channels: next.credentials.channels }, messagingEnabledProjection(next), state.channelCatalog).filter(
          (i) => i.channelId === descriptor.channelId,
        );
        if (issues.length > 0) {
          return stay(
            s,
            `请先填${issues.map((i) => i.fieldLabel).join(" 和 ")}`,
          );
        }
        return pop(next);
      },
    },
  ];

  return {
    title: `消息通道 · ${channelLabel}`,
    description: `配置 ${channelLabel} 的连接凭证${state.channelSetup?.[descriptor.channelId] ? `\n${state.channelSetup[descriptor.channelId]}` : ""}`,
    rows,
    buttons,
  };
}

export function buildModelVerifyConfirmMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "model-verify-confirm" }>,
  runtime?: ConfigEditorRuntime,
): EntityMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.connectionId);
  if (!conn) {
    return {
      title: "可选生成验证",
      description: "连接不存在",
      rows: [],
      buttons: [{ label: "返回", onEnter: (s) => pop(s) }],
    };
  }
  const draftDiscovery = state.draftDiscoveryByConnection?.[descriptor.connectionId];
  const synthesized = synthesizeConnectionModels({
    connectionId: descriptor.connectionId,
    connection: conn,
    catalog: catalog.bundle,
    discoveredModels: draftDiscovery?.status === "discovered" ? draftDiscovery.models : undefined,
    discoveredAuthoritative: draftDiscovery?.authoritativeNativeFacts,
    adapterImplemented: catalog.isAdapterImplemented(conn.adapter),
    includeHidden: true,
    includeOverrideOnlyIds: true,
  });
  const candidate = synthesized.models.find((m) => m.id === descriptor.modelId);
  const modelInfo = candidate?.modelInfo ?? catalog.getModelInfo(conn.presetId, descriptor.modelId);
  const effectiveCap = candidate?.fields.maxOutputTokens.value ?? modelInfo?.maxOutputTokens;
  const effectiveMaxTokens =
    effectiveCap !== undefined && Number.isFinite(effectiveCap) && effectiveCap >= 2
      ? Math.min(Math.floor(effectiveCap), 128)
      : 64;

  return {
    title: `可选生成验证 · ${descriptor.modelId}`,
    description: [
      `发送内容："Reply with OK."（按所选型号有效输出上限采用合法参数 maxTokens=${effectiveMaxTokens}，绝不使用固定 1 token 探针）`,
      "费用说明：本次自愿验证可能产生少量模型调用费用；结果仅证明本次生成可达，不代表永久可用。",
      "可随时按 Esc 取消；草稿凭据仅在当前编辑进程本地使用，不跨普通 RPC 传递。",
    ].join("\n"),
    rows: [
      {
        label: "目标连接与型号",
        status: { level: "ready", text: `${conn.name} · ${descriptor.modelId}` },
        onEnter: (s) => stay(s),
      },
    ],
    buttons: [
      {
        label: "发验证",
        hint: "确认发送 1 次极简受控生成验证（自愿，可按 Esc 取消）",
        primary: true,
        onEnter: (s) => {
          const current = readConnection(s, descriptor.connectionId);
          if (!current) return pop(s);
          const draftRev = s.draftRevision ?? 0;
          const secret =
            current.auth.mode === "api-key" || current.auth.mode === "header"
              ? readConnectionSecretValue(s, current.auth.secretRef)
              : undefined;
          return {
            action: {
              type: "loading",
              state: s,
              message: `正在验证模型 ${descriptor.modelId}（按 Esc 可随时取消）…`,
              run: async (signal) => {
                const verifyFn =
                  runtime?.verifyModelGeneration ??
                  (await import("@zhixing-ai/providers")).verifyModelGeneration;
                const result = await verifyFn({
                  connectionId: descriptor.connectionId,
                  ...(current.presetId ? { presetId: current.presetId } : {}),
                  adapter: current.adapter,
                  endpoint: current.endpoint,
                  auth: current.auth,
                  ...(secret ? { secretValue: secret } : {}),
                  network: current.network,
                  ...(s.config.network?.proxy !== undefined
                    ? { networkProxy: s.config.network.proxy }
                    : {}),
                  ...(current.dialect ? { dialect: current.dialect } : {}),
                  modelId: descriptor.modelId,
                  ...(modelInfo ? { modelInfo } : {}),
                  ...(effectiveCap !== undefined ? { effectiveMaxOutputTokens: effectiveCap } : {}),
                  catalog: catalog.bundle,
                  userConfirmed: true,
                  ...(s.draftSessionId ? { requestSessionId: s.draftSessionId } : {}),
                  draftRevision: draftRev,
                  signal,
                });
                const nextState = recordDraftVerificationResult(s, descriptor.connectionId, result);
                return { type: "pop", state: nextState };
              },
            },
          };
        },
      },
      {
        label: "返回",
        hint: "不发送验证请求，不产生网络请求或费用",
        onEnter: (s) => pop(s),
      },
    ],
  };
}

export function buildCatalogConfigMeta(
  _state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "catalog-config" }>,
  runtime?: ConfigEditorRuntime,
): EntityMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const status = runtime?.catalogStatus?.();
  const sourceLabel =
    status?.source === "trusted-remote"
      ? "官方可信目录（TUF 已验签）"
      : status?.source === "recovered-previous"
        ? "已恢复上一已验签版本"
        : "随包基线";
  const lastStatusLabel = !status
    ? "仅读取随包基线"
    : status.lastStatus === "updated"
      ? "已更新"
      : status.lastStatus === "up-to-date"
        ? "已是最新"
        : status.lastStatus === "offline"
          ? "离线（已保留当前目录）"
          : status.lastStatus === "failed"
            ? "更新失败（已保留当前目录）"
            : status.lastStatus === "disabled"
              ? "已关闭自动检查"
              : "待检查";

  const rows: EntityRow[] = [
    {
      label: "当前目录来源",
      status: { level: "ready", text: sourceLabel },
      onEnter: (s) => stay(s),
    },
    {
      label: "当前目录修订",
      status: {
        level: "ready",
        text: `${status?.activeRevision ?? catalog.revision}（发布于 ${status?.publishedAt ?? catalog.bundle.publishedAt}）`,
      },
      onEnter: (s) => stay(s),
    },
    {
      label: "最近检查状态",
      status: {
        level: status?.lastStatus === "failed" || status?.lastStatus === "offline" ? "pending" : "ready",
        text: [
          lastStatusLabel,
          status?.lastCheckedAt ? `检查时间：${status.lastCheckedAt}` : undefined,
          status?.lastError ? `说明：${status.lastError}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      },
      onEnter: (s) => stay(s),
    },
  ];

  if (status?.upgradeNotice) {
    rows.push({
      label: "客户端升级提示",
      status: { level: "pending", text: status.upgradeNotice.message },
      onEnter: (s) => stay(s),
    });
  }

  const autoEnabled = status?.autoCheckEnabled ?? true;
  rows.push({
    label: "后台自动检查更新",
    status: autoEnabled
      ? { level: "ready", text: "已开启（默认每 6 小时检查；按 Enter 切换）" }
      : { level: "disabled", text: "已关闭（仅手动刷新；按 Enter 开启）" },
    onEnter: (s) => {
      if (!runtime?.setCatalogAutoCheck) {
        return stay(s, "当前环境未接入目录协调器，无法切换自动检查开关");
      }
      const nextEnabled = !autoEnabled;
      return {
        action: {
          type: "loading",
          state: s,
          message: nextEnabled ? "正在开启目录自动检查…" : "正在关闭目录自动检查…",
          run: async () => {
            const updated = await runtime.setCatalogAutoCheck!(nextEnabled);
            return {
              type: "replace",
              state: s,
              panel: {
                kind: "catalog-config",
                notice: updated.autoCheckEnabled
                  ? "✓ 已开启模型目录后台自动检查。"
                  : "✓ 已关闭模型目录后台自动检查。",
              },
            };
          },
        },
      };
    },
  });

  const buttons: EntityButton[] = [
    {
      label: "刷新",
      hint: "立即刷新模型目录（从可信目录源验签更新，不改连接地址与用途默认）",
      primary: true,
      onEnter: (s) => {
        if (!runtime?.refreshModelCatalog) {
          return stay(s, "当前环境未接入目录刷新能力");
        }
        return {
          action: {
            type: "loading",
            state: s,
            message: "正在检查并验证可信模型目录更新（按 Esc 可取消）…",
            run: async (signal) => {
              const receipt = await runtime.refreshModelCatalog!(signal);
              const notice =
                receipt.status === "updated"
                  ? `✓ 目录已更新至修订 ${receipt.activeRevision}。`
                  : receipt.status === "up-to-date"
                    ? `✓ 模型目录已是最新（修订 ${receipt.activeRevision}）。`
                    : receipt.status === "offline"
                      ? `⚠ 当前离线，已保留当前目录（修订 ${receipt.activeRevision}）。`
                      : `⚠ 刷新未更新（${receipt.status}）：${receipt.error ?? receipt.message ?? "已保留当前目录"}`;
              return {
                type: "replace",
                state: s,
                panel: { kind: "catalog-config", notice },
              };
            },
          },
        };
      },
    },
    {
      label: "返回",
      onEnter: (s) => pop(s),
    },
  ];

  return {
    title: "模型资料与更新",
    description: [
      "统一管理单一模型策展目录的来源、修订与可信刷新；更新绝不静默改写既有连接地址、用途默认或个人偏好。",
      ...(descriptor.notice ? [descriptor.notice] : []),
    ].join("\n"),
    rows,
    buttons,
  };
}

export function buildPresetUpdateReviewMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "preset-update-review" }>,
  runtime?: ConfigEditorRuntime,
): EntityMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.connectionId);
  const suggestion = conn
    ? catalog.getPresetUpdateSuggestion(descriptor.connectionId, conn)
    : undefined;
  if (!conn || !suggestion) {
    return {
      title: `预设更新建议 · ${descriptor.connectionId}`,
      description: "该连接当前没有待处理的预设更新建议",
      rows: [],
      buttons: [{ label: "返回", onEnter: (s) => pop(s) }],
    };
  }

  const rows: EntityRow[] = [
    {
      label: "预设与修订对比",
      status: {
        level: "ready",
        text: `${suggestion.presetId}：当前 ${suggestion.currentPresetRevision ?? "未记录"} → 建议 ${suggestion.nextPresetRevision}`,
      },
      onEnter: (s) => stay(s),
    },
    {
      label: "接口端点对比",
      status: {
        level: suggestion.endpointChanged ? "pending" : "ready",
        text: `当前固定：${suggestion.currentEndpoint} ｜ 预设建议：${suggestion.suggestedEndpoint}`,
      },
      onEnter: (s) => stay(s),
    },
    {
      label: "受控协议对比",
      status: {
        level: suggestion.adapterChanged ? "pending" : "ready",
        text: `当前固定：${suggestion.currentAdapter} ｜ 预设建议：${suggestion.suggestedAdapter}`,
      },
      onEnter: (s) => stay(s),
    },
  ];

  const buttons: EntityButton[] = [
    {
      label: "采纳",
      hint: "采纳最新建议并重新发现模型（随本次保存生效）",
      primary: true,
      onEnter: (s) => {
        const adopted = adoptPresetUpdateSuggestion(s, descriptor.connectionId, suggestion);
        const updatedConn = readConnection(adopted, descriptor.connectionId);
        if (!updatedConn || !runtime?.discoverModels) {
          return pop(adopted);
        }
        const draftRev = adopted.draftRevision ?? 0;
        const secret =
          updatedConn.auth.mode === "api-key" || updatedConn.auth.mode === "header"
            ? readConnectionSecretValue(adopted, updatedConn.auth.secretRef)
            : undefined;
        return {
          action: {
            type: "loading",
            state: adopted,
            message: `已采纳建议，正在重新发现 ${updatedConn.name} 的可用模型（按 Esc 可跳过）…`,
            run: async (signal) => {
              const result = await runtime.discoverModels!({
                connectionId: descriptor.connectionId,
                ...(updatedConn.presetId ? { presetId: updatedConn.presetId } : {}),
                adapter: updatedConn.adapter,
                endpoint: updatedConn.endpoint,
                auth: updatedConn.auth,
                ...(secret ? { secretValue: secret } : {}),
                network: updatedConn.network,
                ...(adopted.config.network?.proxy !== undefined
                  ? { networkProxy: adopted.config.network.proxy }
                  : {}),
                catalog: catalog.bundle,
                ...(adopted.draftSessionId ? { requestSessionId: adopted.draftSessionId } : {}),
                draftRevision: draftRev,
                signal,
              });
              return {
                type: "pop",
                state: recordDraftDiscoveryResult(adopted, descriptor.connectionId, result),
              };
            },
          },
        };
      },
    },
    {
      label: "忽略",
      hint: `忽略修订 ${suggestion.nextPresetRevision}，保持当前固定值不变`,
      onEnter: (s) =>
        pop(
          ignorePresetUpdateSuggestion(
            s,
            descriptor.connectionId,
            suggestion.nextPresetRevision,
          ),
        ),
    },
  ];

  return {
    title: `预设更新对比 · ${conn.name}`,
    description:
      "并排对比当前连接固定值与官方预设最新建议值；系统绝不静默修改已确认的连接地址或协议。",
    rows,
    buttons,
  };
}

export function buildConnectionCustomModelDetailMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "connection-custom-model-detail" }>,
): EntityMeta {
  const conn = readConnection(state, descriptor.connectionId);
  const exists = Boolean(conn?.customModels?.includes(descriptor.modelId));
  if (!conn || !exists) {
    return {
      title: `自定义型号 · ${descriptor.modelId}`,
      description: "该自定义型号已更新或移除",
      rows: [],
      buttons: [{ label: "返回", onEnter: (s) => pop(s) }],
    };
  }
  const hasOverride = Boolean(conn.modelOverrides?.[descriptor.modelId]);
  return {
    title: `${conn.name} · ${descriptor.modelId}`,
    description: "自定义型号支持重命名（自动迁移对应规格覆盖与用途引用）、微调规格或直接删除。",
    rows: [
      {
        label: "重命名模型 ID",
        status: { level: "ready", text: descriptor.modelId },
        onEnter: (s) => ({
          action: {
            type: "replace",
            state: s,
            panel: {
              kind: "input",
              fieldId: `conn-custom-rename:${descriptor.connectionId}:${descriptor.modelId}`,
            },
          },
        }),
      },
      {
        label: "规格覆盖",
        status: hasOverride
          ? { level: "ready", text: "已设置规格覆盖（按 Enter 编辑或删除）" }
          : { level: "disabled", text: "未设置（按 Enter 添加上下文/能力覆盖）" },
        onEnter: (s) =>
          nav(s, {
            kind: "model-override-edit",
            connectionId: descriptor.connectionId,
            modelId: descriptor.modelId,
          }),
      },
    ],
    buttons: [
      {
        label: "删除",
        hint: "删除此自定义型号（仅移出自定义列表，不影响供应方目录型号）",
        onEnter: (s) => pop(removeCustomModel(s, descriptor.connectionId, descriptor.modelId)),
      },
      {
        label: "返回",
        onEnter: (s) => pop(s),
      },
    ],
  };
}

export function buildModelOverrideEditMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "model-override-edit" }>,
  runtime?: ConfigEditorRuntime,
): EntityMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.connectionId);
  if (!conn) {
    return {
      title: `规格覆盖 · ${descriptor.modelId}`,
      description: "连接不存在",
      rows: [],
      buttons: [{ label: "返回", onEnter: (s) => pop(s) }],
    };
  }
  const ov = conn.modelOverrides?.[descriptor.modelId];
  const cycleBool = (cur: boolean | undefined): boolean | undefined =>
    cur === undefined ? true : cur === true ? false : undefined;
  const boolText = (cur: boolean | undefined): Status =>
    cur === true
      ? { level: "ready", text: "支持 (true)（按 Enter 切换）" }
      : cur === false
        ? { level: "ready", text: "不支持 (false)（按 Enter 切换）" }
        : { level: "disabled", text: "未覆盖（沿用上游；按 Enter 设为支持）" };

  const draftDiscovery = state.draftDiscoveryByConnection?.[descriptor.connectionId];
  const synthesized = synthesizeConnectionModels({
    connectionId: descriptor.connectionId,
    connection: conn,
    catalog: catalog.bundle,
    discoveredModels: draftDiscovery?.status === "discovered" ? draftDiscovery.models : undefined,
    discoveredAuthoritative: draftDiscovery?.authoritativeNativeFacts,
    adapterImplemented: catalog.isAdapterImplemented(conn.adapter),
    includeHidden: true,
    includeOverrideOnlyIds: true,
  });
  const candidate = synthesized.models.find((m) => m.id === descriptor.modelId);
  const conflictLines = (candidate?.overrideConflicts ?? []).map((c) => `⚠ ${c.message}`);

  const rows: EntityRow[] = [
    {
      label: "上下文窗口（contextWindow）",
      status:
        ov?.contextWindow !== undefined
          ? { level: "ready", text: `${ov.contextWindow} tokens` }
          : { level: "disabled", text: "未覆盖（按 Enter 输入正整数，输入 0 清除）" },
      onEnter: (s) =>
        nav(s, {
          kind: "input",
          fieldId: `conn-override-ctx:${descriptor.connectionId}:${descriptor.modelId}`,
        }),
    },
    {
      label: "最大输出（maxOutputTokens）",
      status:
        ov?.maxOutputTokens !== undefined
          ? { level: "ready", text: `${ov.maxOutputTokens} tokens` }
          : { level: "disabled", text: "未覆盖（按 Enter 输入正整数，输入 0 清除）" },
      onEnter: (s) =>
        nav(s, {
          kind: "input",
          fieldId: `conn-override-out:${descriptor.connectionId}:${descriptor.modelId}`,
        }),
    },
    {
      label: "图片输入（supportsImages）",
      status: boolText(ov?.supportsImages),
      onEnter: (s) =>
        stay(
          upsertModelOverride(s, descriptor.connectionId, descriptor.modelId, {
            supportsImages: cycleBool(
              readConnection(s, descriptor.connectionId)?.modelOverrides?.[descriptor.modelId]
                ?.supportsImages,
            ),
          }),
        ),
    },
    {
      label: "工具调用（supportsTools）",
      status: boolText(ov?.supportsTools),
      onEnter: (s) =>
        stay(
          upsertModelOverride(s, descriptor.connectionId, descriptor.modelId, {
            supportsTools: cycleBool(
              readConnection(s, descriptor.connectionId)?.modelOverrides?.[descriptor.modelId]
                ?.supportsTools,
            ),
          }),
        ),
    },
    {
      label: "思考能力（supportsThinking）",
      status: boolText(ov?.supportsThinking),
      onEnter: (s) =>
        stay(
          upsertModelOverride(s, descriptor.connectionId, descriptor.modelId, {
            supportsThinking: cycleBool(
              readConnection(s, descriptor.connectionId)?.modelOverrides?.[descriptor.modelId]
                ?.supportsThinking,
            ),
          }),
        ),
    },
  ];

  const buttons: EntityButton[] = [];
  if (ov && Object.keys(ov).length > 0) {
    buttons.push({
      label: "删覆盖",
      hint: "删除此规格覆盖（先预览各字段将恢复的上游来源与具体值）",
      onEnter: (s) =>
        nav(s, {
          kind: "model-override-delete-confirm",
          connectionId: descriptor.connectionId,
          modelId: descriptor.modelId,
        }),
    });
  }
  buttons.push({
    label: "返回",
    primary: true,
    onEnter: (s) => pop(s),
  });

  return {
    title: `规格覆盖 · ${descriptor.modelId}`,
    description: [
      `连接：${conn.name}。硬约束不可被覆盖突破；若超出权威限制会保留原输入并在运行时按上限钳制。`,
      ...conflictLines,
    ].join("\n"),
    rows,
    buttons,
  };
}

export function buildModelOverrideDeleteConfirmMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "model-override-delete-confirm" }>,
  runtime?: ConfigEditorRuntime,
): EntityMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.connectionId);
  const restoreFields = previewModelOverrideRestore(
    state,
    descriptor.connectionId,
    descriptor.modelId,
    catalog,
  );

  const rows: EntityRow[] = restoreFields.map((item) => ({
    label: item.labelZh,
    status: {
      level: "ready",
      text: `当前覆盖：${item.currentValue} → 恢复为：${item.restoredValue}（来源：${item.restoredSource}）`,
    },
    onEnter: (s) => stay(s),
  }));

  return {
    title: `确认删除规格覆盖 · ${descriptor.modelId}`,
    description:
      restoreFields.length > 0
        ? `删除 ${conn?.name ?? descriptor.connectionId} 下 ${descriptor.modelId} 的规格覆盖后，不删除该型号条目，上述字段将恢复为对应的上游值与来源：`
        : "当前型号没有已设置的规格覆盖。",
    rows,
    buttons: [
      {
        label: "确认删",
        hint: "确认删除规格覆盖并恢复上述上游值（随主界面「完成」保存）",
        onEnter: (s) => pop(removeModelOverride(s, descriptor.connectionId, descriptor.modelId)),
      },
      {
        label: "取消",
        hint: "不删除，返回上一页",
        primary: true,
        onEnter: (s) => pop(s),
      },
    ],
  };
}

export function resolveEntityMeta(
  state: WorkingState,
  descriptor: PanelDescriptor,
  runtime?: ConfigEditorRuntime,
): EntityMeta | null {
  switch (descriptor.kind) {
    case "connection-config":
      return buildConnectionConfigMeta(state, descriptor, runtime);
    case "model-verify-confirm":
      return buildModelVerifyConfirmMeta(state, descriptor, runtime);
    case "connection-delete":
      return buildConnectionDeleteMeta(state, descriptor);
    case "migration-repair-provider":
      return buildMigrationRepairProviderMeta(state, descriptor);
    case "catalog-config":
      return buildCatalogConfigMeta(state, descriptor, runtime);
    case "preset-update-review":
      return buildPresetUpdateReviewMeta(state, descriptor, runtime);
    case "connection-custom-model-detail":
      return buildConnectionCustomModelDetailMeta(state, descriptor);
    case "model-override-edit":
      return buildModelOverrideEditMeta(state, descriptor, runtime);
    case "model-override-delete-confirm":
      return buildModelOverrideDeleteConfirmMeta(state, descriptor, runtime);
    case "provider-config":
      return buildProviderConfigMeta(state, descriptor, runtime);
    case "channel-config":
      return buildChannelConfigMeta(state, descriptor);
    default:
      return null;
  }
}

export interface EntityPanelKeyResult {
  action: PanelAction;
  cursor: { index: number };
  /** 校验失败时的错误信息——由 runner.ts 存到 PanelFrame 在下次 render 时显示 */
  errorMessage?: string;
}

export function handleEntityPanelKey(
  state: WorkingState,
  descriptor: PanelDescriptor,
  cursor: { index: number },
  key: KeyEvent,
  runtime?: ConfigEditorRuntime,
): EntityPanelKeyResult {
  const meta = resolveEntityMeta(state, descriptor, runtime);
  if (!meta) return { action: { type: "pop", state }, cursor };

  const total = meta.rows.length + meta.buttons.length;
  const max = total - 1;

  switch (key.type) {
    case "arrow-up":
      return {
        action: { type: "stay", state },
        cursor: { index: cursor.index > 0 ? cursor.index - 1 : max },
      };
    case "arrow-down":
      return {
        action: { type: "stay", state },
        cursor: { index: cursor.index < max ? cursor.index + 1 : 0 },
      };
    case "ctrl-c":
      return { action: { type: "exit", result: { kind: "cancelled" } }, cursor };
    case "escape":
      return { action: { type: "pop", state }, cursor };
    case "enter": {
      const idx = cursor.index;
      const elem =
        idx < meta.rows.length
          ? meta.rows[idx]!
          : meta.buttons[idx - meta.rows.length];
      if (!elem) return { action: { type: "stay", state }, cursor };
      const result = elem.onEnter(state);
      return {
        action: result.action,
        cursor,
        errorMessage: result.errorMessage,
      };
    }
    default:
      return { action: { type: "stay", state }, cursor };
  }
}
