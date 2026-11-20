/** Configuration decisions shared by both terminal surfaces. No renderer or input owner. */
/**
 * L2 / L4b 列表面板：通用"选一项"交互。
 *
 * 两种 list 共用同一渲染 + 导航逻辑，items 由 descriptor.kind 决定来源：
 *   - provider-list：SUPPORTED_PROVIDERS（model role 选服务商）
 *   - model-list：preset.knownModels[].id + credentials.providers.<id>.models + [+ 添加自定义]
 *
 * 导航：↑↓ 选 / Enter 进入 / Esc pop / Ctrl+C 退出
 */
import {
  DEFAULT_MODEL_CATALOG_PORT,
  getPreset,
  isLLMConfigV2,
  ROLE_SPECS,
  synthesizeConnectionModels,
  type LLMConfigV2,
  type ModelCatalogPort,
} from "@zhixing-ai/providers/configuration";
import type { ThinkingConfig, ThinkingControl } from "@zhixing-ai/core";
import type { ConfigEditorRuntime, PanelAction, PanelDescriptor, WorkingState } from "../types.js";
import {
  buildPresetConnection,
  clearModelRole,
  clearModelThinking,
  countMigrationRepairItems,
  dismissMigrationPendingItem,
  hideConnectionModel,
  listBlockedLegacyProviders,
  listPresetUpdateSuggestions,
  nextCustomConnectionId,
  readConnection,
  readConnections,
  readModelMaxOutputPreference,
  readModelRole,
  readModelThinking,
  readProviderEntry,
  recordDraftDiscoveryResult,
  redactProtectedLegacyEndpoint,
  unhideConnectionModel,
  upsertConnection,
  writeModelRole,
  writeModelThinking,
} from "../state.js";
import { connectionCredentialStatus } from "../checks/model.js";
import { listSupportedProviders } from "../../registries/index.js";
import { isThinkingCompatible } from "../../terminal/model-command.js";
import type { KeyEvent } from "../../tui/key-event.js";

export interface ListItem {
  label: string;
  /**
   * 右侧辅助描述——纯展示文本（如 provider description / "预设默认"），
   * dim 渲染。**不是业务状态**——list 项无 ready/pending/disabled 概念。
   * 与 entity panel 的 row.status 区分：那是带 level 的业务状态。
   */
  description?: string;
  /** 是否是用户当前已选项（model-list 等场景用）——渲染时左侧加绿色 ● 标记 */
  current?: boolean;
  /** Enter 时执行的动作 */
  onEnter: (state: WorkingState) => PanelAction;
}

export interface ListPanelMeta {
  title: string;
  /** 列表整体说明——chrome body 单行，给用户当前选择场景的上下文 */
  description: string;
  /** 列表是否有 current 概念——影响 marker 槽位是否保留 */
  hasCurrentConcept: boolean;
  items: ListItem[];
}

export function buildConnectionListMeta(
  state: WorkingState,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const connections = readConnections(state);
  const items: ListItem[] = Object.entries(connections).map(([connectionId, conn]): ListItem => {
    const status = connectionCredentialStatus(conn, state.credentials);
    const statusLabel =
      status === "none"
        ? "免密就绪"
        : status === "ready"
          ? "已就绪"
          : status === "compromised"
            ? "已封禁 · 存在但不可读取（需替换）"
            : status === "revoked"
              ? "凭据已撤销"
              : "待补凭据";
    const hasSuggestion = Boolean(catalog.getPresetUpdateSuggestion(connectionId, conn));
    return {
      label: conn.name,
      description: `${conn.endpoint} · ${conn.adapter} · ${statusLabel}${hasSuggestion ? " · 有预设更新建议" : ""}`,
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: { kind: "connection-config", connectionId },
      }),
    };
  });

  items.push({
    label: "+ 新增服务商连接",
    description: "选择官方预设或添加自定义/本地免密连接",
    onEnter: (s) => ({
      type: "navigate",
      state: s,
      panel: { kind: "connection-add" },
    }),
  });

  const suggestions = listPresetUpdateSuggestions(state, catalog);
  if (suggestions.length > 0) {
    items.push({
      label: `预设更新建议（${suggestions.length}）`,
      description: "并排对比当前固定值与官方预设建议值，决定采纳或忽略",
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: { kind: "preset-update-list" },
      }),
    });
  }

  const repairCount = countMigrationRepairItems(state);
  if (repairCount > 0) {
    items.push({
      label: `修复迁移待确认项（${repairCount}）`,
      description: "确认旧自定义端点或清理未归属覆盖",
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: { kind: "migration-repair" },
      }),
    });
  }

  return {
    title: "服务商连接",
    description: "统一管理模型服务商连接、凭据轮换与删除；改动仅在主界面点击「完成」后原子保存",
    hasCurrentConcept: false,
    items,
  };
}

export function buildConnectionAddMeta(
  state: WorkingState,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const providers = listSupportedProviders(catalog);
  const existing = readConnections(state);
  const mainRec = catalog.getRoleRecommendation("main");
  const items: ListItem[] = providers.map((p): ListItem => ({
    label: p.requiresUpgrade ? `${p.label}（需升级知行）` : p.label,
    description: p.requiresUpgrade
      ? "当前客户端版本未包含该预设所需的协议或参数能力，请升级知行后启用"
      : existing[p.id]
        ? `${p.description}（已添加，将新建独立连接）`
        : p.description,
    onEnter: (s) => {
      if (p.requiresUpgrade) {
        return { type: "stay", state: s };
      }
      const presetEntry = catalog.getPreset(p.id);
      const connectionId = existing[p.id] ? nextCustomConnectionId(s, p.id) : p.id;
      const defaultModel =
        mainRec?.provider === p.id
          ? mainRec.model
          : presetEntry?.preset.knownModels?.[0]?.id;
      const built =
        buildPresetConnection(p.id, catalog, connectionId) ?? {
          name: connectionId === p.id ? p.label : `${p.label} (${connectionId})`,
          presetId: p.id,
          adapter: presetEntry?.preset.protocol ?? "openai-compatible",
          endpoint: (presetEntry?.preset.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, ""),
          auth: { mode: "api-key", secretRef: connectionId },
          network: { proxy: "inherit" },
        };
      const next = upsertConnection(s, connectionId, built);
      // 免密本地预设（如 Ollama）：进入连接页时自动触发一次只读原生发现（可按 Esc 取消，绝不阻塞保存）
      if (built.auth.mode === "none" && runtime?.discoverModels) {
        const draftRev = next.draftRevision ?? 0;
        return {
          type: "loading",
          state: next,
          message: `正在自动探测 ${built.name} 本机可用模型（按 Esc 可跳过）…`,
          run: async (signal) => {
            const result = await runtime.discoverModels!({
              connectionId,
              ...(built.presetId ? { presetId: built.presetId } : {}),
              adapter: built.adapter,
              endpoint: built.endpoint,
              auth: built.auth,
              network: built.network,
              ...(next.config.network?.proxy !== undefined
                ? { networkProxy: next.config.network.proxy }
                : {}),
              catalog: catalog.bundle,
              ...(next.draftSessionId ? { requestSessionId: next.draftSessionId } : {}),
              draftRevision: draftRev,
              signal,
            });
            const discoveredState = recordDraftDiscoveryResult(next, connectionId, result);
            const firstDiscovered =
              result.status === "discovered" ? result.models[0]?.id : undefined;
            const initialModel = firstDiscovered ?? defaultModel;
            return {
              type: "replace",
              state: discoveredState,
              panel: {
                kind: "connection-config",
                connectionId,
                isNew: true,
                ...(initialModel ? { initialModel } : {}),
              },
            };
          },
        };
      }
      return {
        type: "replace",
        state: next,
        panel: {
          kind: "connection-config",
          connectionId,
          isNew: true,
          ...(defaultModel ? { initialModel: defaultModel } : {}),
        },
      };
    },
  }));

  items.push({
    label: "+ 自定义连接（兼容 / 本地免密 / 自定义认证头）",
    description: "支持 Ollama / vLLM / 企业网关与无 API Key 本地服务",
    onEnter: (s) => {
      const connectionId = nextCustomConnectionId(s, "custom");
      const next = upsertConnection(s, connectionId, {
        name: `自定义连接 (${connectionId})`,
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:11434/v1",
        auth: { mode: "none" },
        network: { proxy: "direct", allowPrivateOrigin: true },
      });
      return {
        type: "replace",
        state: next,
        panel: { kind: "connection-config", connectionId, isNew: true },
      };
    },
  });

  return {
    title: "新增服务商连接",
    description: "选择官方预设或创建自定义/本地免密连接",
    hasCurrentConcept: false,
    items,
  };
}

export function buildMigrationRepairMeta(state: WorkingState): ListPanelMeta {
  const items: ListItem[] = [];
  const protectedIds = new Set<string>();
  for (const [providerId, entry] of Object.entries(
    state.credentials.protectedLegacyProviders ?? {},
  )) {
    protectedIds.add(providerId);
    items.push({
      label: `旧服务商 · ${providerId}`,
      description: `受保护自定义端点待确认（${redactProtectedLegacyEndpoint(entry.baseUrl)}）`,
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: { kind: "migration-repair-provider", providerId },
      }),
    });
  }
  for (const providerId of listBlockedLegacyProviders(state)) {
    if (protectedIds.has(providerId)) continue;
    const entry = state.credentials.providers?.[providerId];
    items.push({
      label: `被阻断旧服务商 · ${providerId}`,
      description: `旧端点含敏感认证信息待替换（${redactProtectedLegacyEndpoint(entry?.baseUrl)}）`,
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: { kind: "migration-repair-provider", providerId },
      }),
    });
  }
  const raw = state.config.llm as unknown;
  const pendingItems = isLLMConfigV2(raw) ? ((raw as LLMConfigV2).migrationPending ?? []) : [];
  for (const item of pendingItems) {
    if (item.kind === "protected-legacy-roles" && protectedIds.has(item.sourceProviderId)) {
      continue;
    }
    items.push({
      label:
        item.kind === "protected-legacy-roles"
          ? `残留旧用途记录 · ${item.sourceProviderId}`
          : `未归属覆盖 · ${item.sourceProviderId}`,
      description: `${item.summary}（按 Enter 确认忽略并清理）`,
      onEnter: (s) => ({
        type: "stay",
        state: dismissMigrationPendingItem(s, item.id),
      }),
    });
  }
  if (items.length === 0) {
    items.push({
      label: "已无待修复迁移项",
      description: "按 Enter 返回上级",
      onEnter: (s) => ({ type: "pop", state: s }),
    });
  }
  return {
    title: "迁移待修复项",
    description: "逐项确认旧自定义端点归属或清理未归属覆盖；确认后随主界面「完成」原子落盘",
    hasCurrentConcept: false,
    items,
  };
}

export function buildProviderListMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "provider-list" }>,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const roleLabel = ROLE_SPECS.find(spec => spec.id === descriptor.role)!.labelZh;
  const revert: ListItem[] = descriptor.role !== "main" && readModelRole(state, descriptor.role) ? [{
    label: "沿用主模型",
    description: `不再单独配置${roleLabel}，改用主模型`,
    onEnter: (s) => ({ type: "pop", state: clearModelRole(s, descriptor.role) }),
  }] : [];
  const currentProvider = readModelRole(state, descriptor.role)?.provider;
  const v2Connections = readConnections(state);
  const customConnectionItems: ListItem[] = [];
  const seenIds = new Set<string>();

  for (const [connId, conn] of Object.entries(v2Connections)) {
    seenIds.add(connId);
    const status = connectionCredentialStatus(conn, state.credentials);
    const tag =
      status === "none"
        ? "免密"
        : status === "ready"
          ? "已就绪"
          : status === "compromised"
            ? "已封禁"
            : status === "revoked"
              ? "已撤销"
              : "待补凭据";
    customConnectionItems.push({
      label: conn.name,
      description: `${conn.endpoint} · ${tag}`,
      current: connId === currentProvider,
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: { kind: "provider-config", role: descriptor.role, providerId: connId },
      }),
    });
  }

  const presetItems: ListItem[] = listSupportedProviders(catalog)
    .filter((p) => !seenIds.has(p.id))
    .map(
      (p): ListItem => ({
        label: p.requiresUpgrade ? `${p.label}（需升级知行）` : p.label,
        description: p.requiresUpgrade
          ? "当前客户端版本未包含该预设所需的协议或参数能力，请升级知行后启用"
          : p.description,
        current: p.id === currentProvider,
        onEnter: (s) =>
          p.requiresUpgrade
            ? { type: "stay", state: s }
            : {
                type: "navigate",
                state: s,
                panel: { kind: "provider-config", role: descriptor.role, providerId: p.id },
              },
      }),
    );

  const hasCurrent =
    customConnectionItems.some((item) => item.current) ||
    presetItems.some((item) => item.current);

  const currentRoleSel = readModelRole(state, descriptor.role);
  const currentMaxOutput = readModelMaxOutputPreference(state, descriptor.role);
  const outputPrefItems: ListItem[] =
    currentRoleSel?.provider && currentRoleSel.model
      ? [
          {
            label: `调整当前${roleLabel}输出偏好（maxOutputPreference）`,
            description:
              currentMaxOutput !== undefined
                ? `当前：${currentMaxOutput} tokens（请求级偏好，不改物理规格；按 Enter 修改或输入 0 清除）`
                : "未设置（使用模型默认；请求级偏好，与物理 maxOutputTokens 独立）",
            onEnter: (s) => ({
              type: "navigate",
              state: s,
              panel: {
                kind: "input",
                fieldId: `role-max-output:${descriptor.role}:${currentRoleSel.provider}`,
              },
            }),
          },
        ]
      : [];

  return {
    title: `${roleLabel} · 选择服务商`,
    description: `选择 API 服务商作为${roleLabel}来源${hasCurrent ? "；带 ● 的是当前已选" : ""}`,
    hasCurrentConcept: true,
    items: [...revert, ...customConnectionItems, ...presetItems, ...outputPrefItems],
  };
}

export function buildModelListMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "model-list" }>,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.providerId);
  const presetLookupId = conn?.presetId ?? descriptor.providerId;
  const providers = listSupportedProviders(catalog);
  const provider = providers.find((p) => p.id === presetLookupId);
  const preset = catalog.getPreset(presetLookupId)?.preset ?? getPreset(presetLookupId);
  const userModels = conn?.customModels ?? readProviderEntry(state, descriptor.providerId)?.models ?? [];

  const draftDiscovery = state.draftDiscoveryByConnection?.[descriptor.providerId];
  const synthesized = conn
    ? synthesizeConnectionModels({
        connectionId: descriptor.providerId,
        connection: conn,
        catalog: catalog.bundle,
        discoveredModels:
          draftDiscovery?.status === "discovered" ? draftDiscovery.models : undefined,
        discoveredAuthoritative: draftDiscovery?.authoritativeNativeFacts,
        adapterImplemented: catalog.isAdapterImplemented(conn.adapter),
      })
    : undefined;

  const seen = new Set<string>();
  const allModels: string[] = [];
  const candidateById = new Map<
    string,
    NonNullable<typeof synthesized>["models"][number]
  >();
  if (synthesized) {
    for (const c of synthesized.models) {
      if (!seen.has(c.id)) {
        allModels.push(c.id);
        seen.add(c.id);
        candidateById.set(c.id, c);
      }
    }
  } else {
    for (const m of preset?.knownModels ?? []) {
      if (!seen.has(m.id)) {
        allModels.push(m.id);
        seen.add(m.id);
      }
    }
    for (const m of userModels) {
      if (!seen.has(m)) {
        allModels.push(m);
        seen.add(m);
      }
    }
  }

  const roleRec = catalog.getRoleRecommendation(descriptor.role);
  const recommendedModel =
    roleRec?.provider === presetLookupId ? roleRec.model : undefined;

  const currentRole = readModelRole(state, descriptor.role);
  const userSelectedModel =
    currentRole?.provider === descriptor.providerId
      ? currentRole?.model
      : undefined;
  if (userSelectedModel && !seen.has(userSelectedModel)) {
    allModels.push(userSelectedModel);
    seen.add(userSelectedModel);
  }
  const items: ListItem[] = allModels.map((modelId) => {
    const candidate = candidateById.get(modelId);
    const verify = state.draftVerificationByConnection?.[descriptor.providerId]?.[modelId];
    const tags: string[] = [];
    if (modelId === recommendedModel) tags.push(`${descriptor.role} 推荐`);
    if (candidate?.discovered) tags.push("已发现");
    if (verify?.status === "verified") tags.push("已验证");
    if (candidate?.lifecycle === "deprecated") tags.push("已弃用");
    if (candidate?.lifecycle === "retired") tags.push("已停供");
    if (candidate?.requiresUpgrade) tags.push("需升级知行");
    if (candidate?.metadataStatus === "unknown") tags.push("资料不足/未知");
    if (candidate && candidate.overrideConflicts.length > 0) tags.push("覆盖受硬约束限制");
    const description = tags.length > 0 ? tags.join(" · ") : undefined;
    return {
      label: modelId,
      description,
      current: modelId === userSelectedModel,
      onEnter: (s) => {
        if (candidate?.lifecycle === "retired" || candidate?.requiresUpgrade) {
          return { type: "stay", state: s };
        }
        const prevRole = readModelRole(s, descriptor.role);
        const prevThinking = readModelThinking(s, descriptor.role);
        const switchedModel =
          prevRole?.provider !== descriptor.providerId || prevRole?.model !== modelId;
        let next = writeModelRole(
          s,
          descriptor.role,
          descriptor.providerId,
          modelId,
        );
        const control = resolveThinkingControl(descriptor.providerId, modelId, next, catalog);
        const compat = isThinkingCompatible(control, prevThinking);
        if (switchedModel && prevThinking && compat.compatible) {
          next = writeModelThinking(next, descriptor.role, prevThinking);
        }
        if (control && control.type !== "none") {
          const notice =
            switchedModel && prevThinking && !compat.compatible
              ? `原思考参数与 ${modelId} 不兼容（${compat.reason}），已按新型号重建合法控件，请重新选择或采用默认`
              : undefined;
          return {
            type: "navigate",
            state: next,
            panel: {
              kind: "thinking-config",
              role: descriptor.role,
              providerId: descriptor.providerId,
              model: modelId,
              ...(notice ? { notice } : {}),
            },
          };
        }
        return { type: "pop", state: next };
      },
    };
  });

  // 末尾追加 "+ 添加自定义模型"
  items.push({
    label: "+ 添加自定义模型",
    onEnter: (s) => ({
      type: "navigate",
      state: s,
      panel: {
        kind: "add-model",
        role: descriptor.role,
        providerId: descriptor.providerId,
      },
    }),
  });

  return {
    title: `${conn?.name ?? provider?.label ?? descriptor.providerId} · 选择模型`,
    description: "选择具体使用的 model id；带 ● 的是当前已选",
    hasCurrentConcept: true,
    items,
  };
}

export function resolveThinkingControl(
  providerId: string,
  modelId: string,
  state?: WorkingState,
  catalog?: ModelCatalogPort,
): ThinkingControl | undefined {
  const conn = state ? readConnection(state, providerId) : undefined;
  if (conn?.modelOverrides?.[modelId]?.supportsThinking === false) {
    return { type: "none" };
  }
  if (conn?.modelOverrides?.[modelId]?.thinkingControl) {
    return conn.modelOverrides[modelId]!.thinkingControl;
  }
  const presetId = conn?.presetId ?? providerId;
  return (
    catalog?.getModelInfo(presetId, modelId)?.thinkingControl ??
    getPreset(presetId)?.knownModels?.find((m) => m.id === modelId)?.thinkingControl
  );
}

export function sameThinking(
  a: ThinkingConfig | undefined,
  b: ThinkingConfig,
): boolean {
  if (!a || a.mode !== b.mode) return false;
  if (a.mode === "effort" && b.mode === "effort") return a.effort === b.effort;
  if (a.mode === "budget" && b.mode === "budget") return a.budget === b.budget;
  return true;
}

export function buildThinkingConfigMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "thinking-config" }>,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const control = resolveThinkingControl(descriptor.providerId, descriptor.model, state, catalog);
  const current = readModelThinking(state, descriptor.role);

  // 选定一个固定形态 → 写入并返回 model-list（pop）
  const pick = (thinking: ThinkingConfig) => (s: WorkingState): PanelAction => ({
    type: "pop",
    state: writeModelThinking(s, descriptor.role, thinking),
  });

  const items: ListItem[] = [
    {
      label: "关闭思考",
      description: "不发送思考参数中的开启项（off）",
      current: sameThinking(current, { mode: "off" }),
      onEnter: pick({ mode: "off" }),
    },
  ];

  let description = "选择该模型的思考控制；带 ● 的是当前已选";

  if (control?.type === "toggle") {
    items.push({
      label: "开启思考",
      description: "开启模型思考（on）",
      current: sameThinking(current, { mode: "on" }),
      onEnter: pick({ mode: "on" }),
    });
  } else if (control?.type === "effort") {
    items.push({
      label: "开启（服务端默认强度）",
      current: sameThinking(current, { mode: "on" }),
      onEnter: pick({ mode: "on" }),
    });
    for (const effort of control.efforts) {
      items.push({
        label: `强度 ${effort}`,
        description: effort === control.default ? "官方默认档" : undefined,
        current: sameThinking(current, { mode: "effort", effort }),
        onEnter: pick({ mode: "effort", effort }),
      });
    }
  } else if (control?.type === "budget") {
    if (control.range) {
      description = `选择该模型的思考控制；自定义预算需在 ${control.range[0]}–${control.range[1]} token 内`;
    }
    items.push({
      label: "开启（服务端默认预算）",
      current: sameThinking(current, { mode: "on" }),
      onEnter: pick({ mode: "on" }),
    });
    items.push({
      label: "自定义预算…",
      description: "输入思考 token 预算",
      current: current?.mode === "budget",
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: {
          kind: "thinking-budget",
          role: descriptor.role,
          providerId: descriptor.providerId,
          model: descriptor.model,
        },
      }),
    });
  }

  items.push({
    label: "采用默认（清除思考覆盖）",
    description: "不显式发送思考参数，由服务端默认决定",
    onEnter: (s) => ({ type: "pop", state: clearModelThinking(s, descriptor.role) }),
  });

  if (descriptor.notice) {
    description = `${descriptor.notice}；${description}`;
  }

  return {
    title: `${descriptor.model} · 思考控制`,
    description,
    hasCurrentConcept: true,
    items,
  };
}

export function buildPresetUpdateListMeta(
  state: WorkingState,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const suggestions = listPresetUpdateSuggestions(state, catalog);
  const items: ListItem[] = suggestions.map((s) => {
    const conn = readConnection(state, s.connectionId);
    const changes = [
      s.endpointChanged ? "官方地址变更" : undefined,
      s.adapterChanged ? "建议协议变更" : undefined,
    ]
      .filter(Boolean)
      .join(" / ");
    return {
      label: `${conn?.name ?? s.connectionId}（${s.presetId}）`,
      description: `${changes || "预设修订更新"} · ${s.currentPresetRevision ?? "未记录"} → ${s.nextPresetRevision}`,
      onEnter: (st) => ({
        type: "navigate",
        state: st,
        panel: { kind: "preset-update-review", connectionId: s.connectionId },
      }),
    };
  });
  if (items.length === 0) {
    items.push({
      label: "已无待处理的预设更新建议",
      description: "按 Enter 返回上级",
      onEnter: (s) => ({ type: "pop", state: s }),
    });
  }
  return {
    title: "预设更新建议",
    description: "官方预设地址或协议有新建议；绝不静默改写既有连接，请逐项对比后决定采纳或忽略",
    hasCurrentConcept: false,
    items,
  };
}

export function buildConnectionCustomModelsMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "connection-custom-models" }>,
): ListPanelMeta {
  const conn = readConnection(state, descriptor.connectionId);
  const customModels = conn?.customModels ?? [];
  const items: ListItem[] = customModels.map((modelId) => ({
    label: modelId,
    description: conn?.modelOverrides?.[modelId]
      ? "自定义型号 · 已设规格覆盖（按 Enter 重命名 / 改覆盖 / 删除）"
      : "自定义型号（按 Enter 重命名 / 设规格覆盖 / 删除）",
    onEnter: (s) => ({
      type: "navigate",
      state: s,
      panel: {
        kind: "connection-custom-model-detail",
        connectionId: descriptor.connectionId,
        modelId,
      },
    }),
  }));
  items.push({
    label: "+ 新增自定义型号",
    description: "登记该连接下的精确 model id",
    onEnter: (s) => ({
      type: "navigate",
      state: s,
      panel: { kind: "input", fieldId: `conn-custom-add:${descriptor.connectionId}` },
    }),
  });
  return {
    title: `${conn?.name ?? descriptor.connectionId} · 自定义型号`,
    description: "管理该连接下手动登记的自定义 model id（支持增、改、删）",
    hasCurrentConcept: false,
    items,
  };
}

export function buildConnectionModelOverridesMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "connection-model-overrides" }>,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.connectionId);
  const overrides = conn?.modelOverrides ?? {};
  const draftDiscovery = state.draftDiscoveryByConnection?.[descriptor.connectionId];
  const synthesized = conn
    ? synthesizeConnectionModels({
        connectionId: descriptor.connectionId,
        connection: conn,
        catalog: catalog.bundle,
        discoveredModels: draftDiscovery?.status === "discovered" ? draftDiscovery.models : undefined,
        discoveredAuthoritative: draftDiscovery?.authoritativeNativeFacts,
        adapterImplemented: catalog.isAdapterImplemented(conn.adapter),
        includeHidden: true,
        includeOverrideOnlyIds: true,
      })
    : undefined;
  const conflictMap = new Map(
    (synthesized?.models ?? []).map((m) => [m.id, m.overrideConflicts.length]),
  );

  const items: ListItem[] = Object.entries(overrides).map(([modelId, ov]) => {
    const parts: string[] = [];
    if (ov.contextWindow !== undefined) parts.push(`窗口 ${ov.contextWindow}`);
    if (ov.maxOutputTokens !== undefined) parts.push(`输出 ${ov.maxOutputTokens}`);
    if (ov.supportsImages !== undefined) parts.push(`图片=${ov.supportsImages ? "是" : "否"}`);
    if (ov.supportsTools !== undefined) parts.push(`工具=${ov.supportsTools ? "是" : "否"}`);
    if (ov.supportsThinking !== undefined) parts.push(`思考=${ov.supportsThinking ? "是" : "否"}`);
    const conflicts = conflictMap.get(modelId) ?? 0;
    if (conflicts > 0) parts.push(`⚠ ${conflicts} 项受硬约束钳制`);
    return {
      label: modelId,
      description: parts.join(" · ") || "空覆盖",
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: {
          kind: "model-override-edit",
          connectionId: descriptor.connectionId,
          modelId,
        },
      }),
    };
  });

  items.push({
    label: "+ 为指定型号添加规格覆盖",
    description: "输入精确 model id，微调上下文窗口、输出上限或能力标志",
    onEnter: (s) => ({
      type: "navigate",
      state: s,
      panel: { kind: "input", fieldId: `conn-override-add:${descriptor.connectionId}` },
    }),
  });

  return {
    title: `${conn?.name ?? descriptor.connectionId} · 规格覆盖`,
    description: "按精确 model id 覆盖规格；删除覆盖前会明示将恢复的上游来源与具体值",
    hasCurrentConcept: false,
    items,
  };
}

export function buildConnectionHiddenModelsMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "connection-hidden-models" }>,
  _runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const conn = readConnection(state, descriptor.connectionId);
  const hidden = conn?.hiddenModels ?? [];
  const items: ListItem[] = hidden.map((modelId) => ({
    label: `恢复显示 · ${modelId}`,
    description: "按 Enter 从隐藏列表中移除（恢复到可选模型列表）",
    onEnter: (s) => ({
      type: "stay",
      state: unhideConnectionModel(s, descriptor.connectionId, modelId),
    }),
  }));

  items.push({
    label: "+ 隐藏供应方型号…",
    description: "选择该连接下的供应方/目录型号加入隐藏列表（目录刷新不复活）",
    onEnter: (s) => ({
      type: "navigate",
      state: s,
      panel: { kind: "connection-hide-picker", connectionId: descriptor.connectionId },
    }),
  });

  return {
    title: `${conn?.name ?? descriptor.connectionId} · 已隐藏型号（${hidden.length}）`,
    description:
      hidden.length > 0
        ? "已隐藏的供应方型号不会随目录刷新复活；选中任意项可一键恢复显示"
        : "当前没有隐藏型号；可从下方隐藏不需要展示的供应方型号",
    hasCurrentConcept: false,
    items,
  };
}

export function buildConnectionHidePickerMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "connection-hide-picker" }>,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const conn = readConnection(state, descriptor.connectionId);
  const draftDiscovery = state.draftDiscoveryByConnection?.[descriptor.connectionId];
  const synthesized = conn
    ? synthesizeConnectionModels({
        connectionId: descriptor.connectionId,
        connection: conn,
        catalog: catalog.bundle,
        discoveredModels: draftDiscovery?.status === "discovered" ? draftDiscovery.models : undefined,
        discoveredAuthoritative: draftDiscovery?.authoritativeNativeFacts,
        adapterImplemented: catalog.isAdapterImplemented(conn.adapter),
        includeHidden: false,
      })
    : undefined;

  const hideable = (synthesized?.models ?? []).filter((m) => !m.isCustom);
  const items: ListItem[] = hideable.map((m) => ({
    label: m.id,
    description: `${m.discovered ? "已发现" : "目录收录"} · 按 Enter 隐藏此供应方型号`,
    onEnter: (s) => ({
      type: "pop",
      state: hideConnectionModel(s, descriptor.connectionId, m.id),
    }),
  }));

  if (items.length === 0) {
    items.push({
      label: "当前没有可隐藏的供应方型号",
      description: "自定义型号请在「自定义型号」中直接删除",
      onEnter: (s) => ({ type: "pop", state: s }),
    });
  }

  return {
    title: `${conn?.name ?? descriptor.connectionId} · 选择要隐藏的型号`,
    description: "隐藏供应方型号仅影响显示偏好，后续目录刷新不会复活，随时可恢复显示",
    hasCurrentConcept: false,
    items,
  };
}

export function resolveListMeta(
  state: WorkingState,
  descriptor: PanelDescriptor,
  runtime?: ConfigEditorRuntime,
): ListPanelMeta | null {
  switch (descriptor.kind) {
    case "connection-list":
      return buildConnectionListMeta(state, runtime);
    case "connection-add":
      return buildConnectionAddMeta(state, runtime);
    case "migration-repair":
      return buildMigrationRepairMeta(state);
    case "preset-update-list":
      return buildPresetUpdateListMeta(state, runtime);
    case "connection-custom-models":
      return buildConnectionCustomModelsMeta(state, descriptor);
    case "connection-model-overrides":
      return buildConnectionModelOverridesMeta(state, descriptor, runtime);
    case "connection-hidden-models":
      return buildConnectionHiddenModelsMeta(state, descriptor, runtime);
    case "connection-hide-picker":
      return buildConnectionHidePickerMeta(state, descriptor, runtime);
    case "provider-list":
      return buildProviderListMeta(state, descriptor, runtime);
    case "model-list":
      return buildModelListMeta(state, descriptor, runtime);
    case "thinking-config":
      return buildThinkingConfigMeta(state, descriptor, runtime);
    default:
      return null;
  }
}

export interface ListPanelKeyResult {
  action: PanelAction;
  cursor: { index: number };
}

export function handleListPanelKey(
  state: WorkingState,
  descriptor: PanelDescriptor,
  cursor: { index: number },
  key: KeyEvent,
  runtime?: ConfigEditorRuntime,
): ListPanelKeyResult {
  const meta = resolveListMeta(state, descriptor, runtime);
  if (!meta) {
    return { action: { type: "pop", state }, cursor };
  }
  const max = meta.items.length - 1;

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
      const item = meta.items[cursor.index];
      if (!item) return { action: { type: "stay", state }, cursor };
      return { action: item.onEnter(state), cursor };
    }
    default:
      return { action: { type: "stay", state }, cursor };
  }
}
