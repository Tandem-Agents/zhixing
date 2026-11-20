/** Configuration decisions shared by both terminal surfaces. No renderer or input owner. */
/**
 * L4a / L5 单行输入面板：
 *   - input：编辑某个字段（API Key / appId / appSecret 等），用 PanelDescriptor.fieldId 路由到具体字段
 *   - add-model：输入自定义 model id
 *
 * 输入态特征：
 *   - 字符 / Backspace 累积或删除 inputBuffer
 *   - 敏感字段渲染为 `*`，非敏感字段明文显示
 *   - Enter：提交，写入 WorkingState（清空 buffer）+ pop 回上一级
 *   - Esc：取消，丢弃 buffer + pop 回上一级
 *   - Ctrl+C：退出整个编辑器
 */
import type { ConfigEditorRuntime, PanelAction, PanelDescriptor, WorkingState } from "../types.js";
import {
  DEFAULT_MODEL_CATALOG_PORT,
  getPreset,
  hasExplicitUrlCredentialsOrQueryAuth,
  ROLE_SPECS,
  synthesizeConnectionModels,
} from "@zhixing-ai/providers/configuration";
import {
  addProviderModel,
  clearModelMaxOutputPreference,
  patchChannelEntry,
  patchProviderEntry,
  readConnection,
  readConnectionSecretStatus,
  readConnectionSecretValue,
  readModelMaxOutputPreference,
  readModelRole,
  readRepairableLegacyProvider,
  recordDraftDiscoveryResult,
  redactProtectedLegacyEndpoint,
  renameCustomModel,
  setConfirmedRepairEndpoint,
  setInputBuffer,
  upsertConnection,
  upsertModelOverride,
  writeConnectionSecret,
  writeModelMaxOutputPreference,
  writeModelRole,
  writeModelThinking,
} from "../state.js";
import { listSupportedProviders, listSupportedChannels, findSupportedChannel } from "../../registries/index.js";
import { validateMaxOutputPreferenceInput } from "../../terminal/model-command.js";
import { resolveThinkingControl } from "./list.js";
import type { KeyEvent } from "../../tui/key-event.js";

export interface InputFieldMeta {
  title: string;
  hint: string;
  example: string;
  sensitive: boolean;
  /** 文档链接——单独渲染为可点击行（OSC 8）；可选 */
  docUrl?: string;
  /** 已存值——进入编辑面板时显示（敏感字段会 mask）；用户开始输入即覆盖 */
  currentValue: (state: WorkingState) => string | undefined;
  /** 可选校验：返回中文错误说明时留在当前输入页并保留用户已输入草稿，避免非法值被静默吃掉 */
  validate?: (value: string, state: WorkingState) => string | undefined;
  /** 提交时把 buffer 写入 state */
  apply: (state: WorkingState, value: string) => WorkingState;
}

export function resolveInputField(
  fieldId: string,
  state: WorkingState,
  runtime?: ConfigEditorRuntime,
): InputFieldMeta | null {
  const catalog = runtime?.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
  const supportedProviders = listSupportedProviders(catalog);
  const connNameMatch = /^conn-name:(.+)$/.exec(fieldId);
  if (connNameMatch) {
    const connectionId = connNameMatch[1]!;
    const conn = readConnection(state, connectionId);
    if (!conn) return null;
    return {
      title: `${conn.name} · 连接名称`,
      hint: "便于在用途默认和列表里区分此连接",
      example: "如：本地 Ollama / DeepSeek 生产",
      sensitive: false,
      currentValue: (s) => readConnection(s, connectionId)?.name,
      apply: (s, value) => {
        const cur = readConnection(s, connectionId);
        return cur ? upsertConnection(s, connectionId, { ...cur, name: value }) : s;
      },
    };
  }

  const connEndpointMatch = /^conn-endpoint:(.+)$/.exec(fieldId);
  if (connEndpointMatch) {
    const connectionId = connEndpointMatch[1]!;
    const conn = readConnection(state, connectionId);
    if (!conn) return null;
    return {
      title: `${conn.name} · 接口端点`,
      hint: "输入完整 HTTP(S) 端点 URL（禁止包含用户名密码或 query 密钥参数）",
      example: "如：https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1",
      sensitive: false,
      currentValue: (s) => readConnection(s, connectionId)?.endpoint,
      apply: (s, value) => {
        const cur = readConnection(s, connectionId);
        return cur
          ? upsertConnection(s, connectionId, { ...cur, endpoint: value.replace(/\/+$/u, "") })
          : s;
      },
    };
  }

  const connHeaderMatch = /^conn-header:(.+)$/.exec(fieldId);
  if (connHeaderMatch) {
    const connectionId = connHeaderMatch[1]!;
    const conn = readConnection(state, connectionId);
    if (!conn || conn.auth.mode !== "header") return null;
    return {
      title: `${conn.name} · 自定义认证头名称`,
      hint: "仅允许安全的自定义认证头名（禁止 Host / Proxy-* / X-Forwarded-* 等路由控制头）",
      example: "如：X-Api-Key 或 X-Gateway-Token",
      sensitive: false,
      currentValue: (s) => {
        const cur = readConnection(s, connectionId);
        return cur?.auth.mode === "header" ? cur.auth.headerName : undefined;
      },
      apply: (s, value) => {
        const cur = readConnection(s, connectionId);
        if (!cur || cur.auth.mode !== "header") return s;
        return upsertConnection(s, connectionId, {
          ...cur,
          auth: { ...cur.auth, headerName: value },
        });
      },
    };
  }

  const connSecretMatch = /^conn-secret:(.+)$/.exec(fieldId);
  if (connSecretMatch) {
    const connectionId = connSecretMatch[1]!;
    const conn = readConnection(state, connectionId);
    if (!conn || conn.auth.mode === "none") return null;
    const preset = conn.presetId
      ? supportedProviders.find((p) => p.id === conn.presetId)
      : undefined;
    const secretRef = conn.auth.secretRef;
    const secretKind = conn.auth.mode;
    return {
      title: `${conn.name} · ${secretKind === "header" ? "认证头凭据" : "API Key"}`,
      hint: preset?.apiKeyHint ?? "凭据仅加密写入本机 SecretStore，不落入公开配置文件；录入新值将解除封禁或撤销态",
      example: preset?.apiKeyExample ?? "sk-...",
      sensitive: true,
      docUrl: preset?.docUrl,
      currentValue: (s) => readConnectionSecretValue(s, secretRef),
      apply: (s, value) => writeConnectionSecret(s, secretRef, secretKind, value),
    };
  }

  const connInitModelMatch = /^conn-init-model:(.+)$/.exec(fieldId);
  if (connInitModelMatch) {
    const connectionId = connInitModelMatch[1]!;
    const conn = readConnection(state, connectionId);
    if (!conn) return null;
    return {
      title: `${conn.name} · 模型 ID`,
      hint: "输入该连接下要使用的完整 model id（将记入该连接的自定义模型列表）",
      example: "如：qwen2.5:14b / deepseek-chat",
      sensitive: false,
      currentValue: (s) => readConnection(s, connectionId)?.customModels?.[0],
      apply: (s, value) => {
        const cur = readConnection(s, connectionId);
        if (!cur) return s;
        const nextModels = [value, ...(cur.customModels ?? []).filter((m) => m !== value)];
        return upsertConnection(s, connectionId, { ...cur, customModels: nextModels });
      },
    };
  }

  const repairEndpointMatch = /^repair-endpoint:(.+)$/.exec(fieldId);
  if (repairEndpointMatch) {
    const providerId = repairEndpointMatch[1]!;
    const found = readRepairableLegacyProvider(state, providerId);
    if (!found) return null;
    const redactedOrigin = redactProtectedLegacyEndpoint(found.entry.baseUrl);
    return {
      title: `迁移修复 · ${providerId} 端点`,
      hint: `输入确认后的纯净 HTTP(S) 端点 URL（禁止包含用户名密码或 query 密钥；旧来源摘要：${redactedOrigin}）`,
      example: "如：https://gateway.company.example/v1 或 http://127.0.0.1:11434/v1",
      // 受保护旧自定义端点可能含路径令牌或内嵌认证信息：设为敏感输入且不回显原值
      sensitive: true,
      currentValue: () => undefined,
      apply: (s, value) => setConfirmedRepairEndpoint(s, providerId, value),
    };
  }

  const connCustomAddMatch = /^conn-custom-add:(.+)$/.exec(fieldId);
  if (connCustomAddMatch) {
    const connectionId = connCustomAddMatch[1]!;
    const conn = readConnection(state, connectionId);
    if (!conn) return null;
    return {
      title: `${conn.name} · 新增自定义型号`,
      hint: "输入该连接支持的精确 model id（去重保序写入 customModels）",
      example: "如：my-finetuned-model / qwen2.5:32b",
      sensitive: false,
      currentValue: () => undefined,
      apply: (s, value) => addProviderModel(s, connectionId, value),
    };
  }

  const connCustomRenameMatch = /^conn-custom-rename:([^:]+):(.+)$/.exec(fieldId);
  if (connCustomRenameMatch) {
    const [, connectionId, oldModelId] = connCustomRenameMatch;
    const conn = readConnection(state, connectionId!);
    if (!conn) return null;
    return {
      title: `${conn.name} · 重命名自定义型号`,
      hint: `输入新的 model id 替换「${oldModelId}」（同步迁移规格覆盖与指向此型号的用途默认）`,
      example: oldModelId!,
      sensitive: false,
      currentValue: () => oldModelId,
      apply: (s, value) => renameCustomModel(s, connectionId!, oldModelId!, value),
    };
  }

  const connOverrideAddMatch = /^conn-override-add:(.+)$/.exec(fieldId);
  if (connOverrideAddMatch) {
    const connectionId = connOverrideAddMatch[1]!;
    const conn = readConnection(state, connectionId);
    if (!conn) return null;
    return {
      title: `${conn.name} · 添加规格覆盖（型号 ID）`,
      hint: "输入要设置规格覆盖的精确 model id，随后编辑其上下文窗口、输出上限或能力标志",
      example: "如：deepseek-v4-pro / my-private-model",
      sensitive: false,
      currentValue: () => undefined,
      apply: (s) => s,
    };
  }

  const connOverrideCtxMatch = /^conn-override-ctx:([^:]+):(.+)$/.exec(fieldId);
  if (connOverrideCtxMatch) {
    const [, connectionId, modelId] = connOverrideCtxMatch;
    const conn = readConnection(state, connectionId!);
    if (!conn) return null;
    return {
      title: `${modelId} · 上下文窗口覆盖（tokens）`,
      hint: "输入正整数 token 数覆盖上下文窗口；输入 0 清除此字段覆盖",
      example: "如：128000 或 200000（输入 0 清除）",
      sensitive: false,
      currentValue: (s) => {
        const val = readConnection(s, connectionId!)?.modelOverrides?.[modelId!]?.contextWindow;
        return val !== undefined ? String(val) : undefined;
      },
      validate: (value) => {
        if (value === "0" || value === "-") return undefined;
        if (!/^\d+$/.test(value)) {
          return "请输入大于 0 的正整数上下文窗口 token 数，或输入 0 清除覆盖。";
        }
        const n = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(n) || n <= 0) {
          return "上下文窗口必须为大于 0 的正整数（输入 0 清除覆盖）。";
        }
        return undefined;
      },
      apply: (s, value) => {
        if (value === "0" || value === "-") {
          return upsertModelOverride(s, connectionId!, modelId!, { contextWindow: undefined });
        }
        if (!/^\d+$/.test(value)) return s;
        const n = Number.parseInt(value, 10);
        return n > 0
          ? upsertModelOverride(s, connectionId!, modelId!, { contextWindow: n })
          : s;
      },
    };
  }

  const connOverrideOutMatch = /^conn-override-out:([^:]+):(.+)$/.exec(fieldId);
  if (connOverrideOutMatch) {
    const [, connectionId, modelId] = connOverrideOutMatch;
    const conn = readConnection(state, connectionId!);
    if (!conn) return null;
    return {
      title: `${modelId} · 最大输出覆盖（tokens）`,
      hint: "输入正整数 token 数覆盖最大输出上限；输入 0 清除此字段覆盖",
      example: "如：8192 或 16384（输入 0 清除）",
      sensitive: false,
      currentValue: (s) => {
        const val = readConnection(s, connectionId!)?.modelOverrides?.[modelId!]?.maxOutputTokens;
        return val !== undefined ? String(val) : undefined;
      },
      validate: (value) => {
        if (value === "0" || value === "-") return undefined;
        if (!/^\d+$/.test(value)) {
          return "请输入大于 0 的正整数最大输出 token 数，或输入 0 清除覆盖。";
        }
        const n = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(n) || n <= 0) {
          return "最大输出上限必须为大于 0 的正整数（输入 0 清除覆盖）。";
        }
        return undefined;
      },
      apply: (s, value) => {
        if (value === "0" || value === "-") {
          return upsertModelOverride(s, connectionId!, modelId!, { maxOutputTokens: undefined });
        }
        if (!/^\d+$/.test(value)) return s;
        const n = Number.parseInt(value, 10);
        return n > 0
          ? upsertModelOverride(s, connectionId!, modelId!, { maxOutputTokens: n })
          : s;
      },
    };
  }

  const roleMaxOutputMatch = /^role-max-output:(main|light|power):(.+)$/.exec(fieldId);
  if (roleMaxOutputMatch) {
    const [, rawRole, providerId] = roleMaxOutputMatch;
    const role = rawRole as "main" | "light" | "power";
    const roleLabel = ROLE_SPECS.find((spec) => spec.id === role)?.labelZh ?? role;
    const conn = readConnection(state, providerId!);
    const presetLookupId = conn?.presetId ?? providerId!;
    const currentRole = readModelRole(state, role);
    const roleRec = catalog.getRoleRecommendation(role);
    const targetModel =
      currentRole?.provider === providerId
        ? currentRole.model
        : roleRec?.provider === presetLookupId
          ? roleRec.model
          : undefined;
    let physicalMaxOutput: number | undefined;
    let recommendedMaxOutput: number | undefined;
    if (targetModel && conn) {
      const draftDiscovery = state.draftDiscoveryByConnection?.[providerId!];
      const synthesized = synthesizeConnectionModels({
        connectionId: providerId!,
        connection: conn,
        catalog: catalog.bundle,
        discoveredModels:
          draftDiscovery?.status === "discovered" ? draftDiscovery.models : undefined,
        discoveredAuthoritative: draftDiscovery?.authoritativeNativeFacts,
        adapterImplemented: catalog.isAdapterImplemented(conn.adapter),
        includeHidden: true,
        includeOverrideOnlyIds: true,
      });
      const candidate = synthesized.models.find((m) => m.id === targetModel);
      physicalMaxOutput =
        candidate?.fields.maxOutputTokens.value ??
        catalog.getModelInfo(conn.presetId, targetModel)?.maxOutputTokens;
      recommendedMaxOutput = candidate?.recommendedMaxOutputTokens;
    } else if (targetModel) {
      physicalMaxOutput = catalog.getModelInfo(presetLookupId, targetModel)?.maxOutputTokens;
    }

    const limitNote =
      physicalMaxOutput !== undefined
        ? `当前模型物理最大输出上限 ${physicalMaxOutput} tokens${recommendedMaxOutput !== undefined ? `（参考建议 ${recommendedMaxOutput}）` : ""}`
        : "模型物理上限未知";

    return {
      title: `${roleLabel} · 请求输出偏好（maxOutputPreference）`,
      hint: `设置单次请求的软输出上限偏好（注册语义 output.maxTokensPreference，与物理 maxOutputTokens 规格覆盖独立）；${limitNote}；输入 0 清除恢复默认`,
      example:
        physicalMaxOutput !== undefined
          ? `输入 1–${physicalMaxOutput} 之间的正整数（如 ${Math.min(4096, physicalMaxOutput)}），输入 0 清除`
          : "如：4096 或 8192（输入 0 清除）",
      sensitive: false,
      currentValue: (s) => {
        const cur = readModelRole(s, role);
        if (cur?.provider !== providerId) return undefined;
        const val = readModelMaxOutputPreference(s, role);
        return val !== undefined ? String(val) : undefined;
      },
      validate: (value) => {
        if (value === "0" || value === "-") return undefined;
        if (!/^\d+$/.test(value)) {
          return "请输入大于 0 的正整数 token 数量，或输入 0 清除恢复默认。";
        }
        const check = validateMaxOutputPreferenceInput(value, physicalMaxOutput);
        if (!check.valid) {
          return check.error ?? "请输入大于 0 的正整数 token 数量，或输入 0 清除恢复默认。";
        }
        return undefined;
      },
      apply: (s, value) => {
        if (value === "0" || value === "-") {
          return clearModelMaxOutputPreference(s, role);
        }
        const check = validateMaxOutputPreferenceInput(value, physicalMaxOutput);
        if (!check.valid || check.value === undefined) return s;
        const cur = readModelRole(s, role);
        const fallbackModel =
          cur?.provider === providerId ? cur.model : targetModel;
        if (!fallbackModel) return s;
        const base =
          cur?.provider === providerId && cur.model === fallbackModel
            ? s
            : writeModelRole(s, role, providerId!, fallbackModel);
        return writeModelMaxOutputPreference(base, role, check.value, {
          connectionId: providerId!,
          model: fallbackModel,
        });
      },
    };
  }

  const providerMatch = /^provider-apikey:([^:]+):(.+)$/.exec(fieldId);
  if (providerMatch) {
    const [, _role, providerId] = providerMatch;
    const provider = supportedProviders.find((p) => p.id === providerId);
    if (!provider) return null;
    return {
      title: `${provider.label} · API Key`,
      hint: provider.apiKeyHint,
      example: provider.apiKeyExample,
      sensitive: true,
      docUrl: provider.docUrl,
      currentValue: (state) => readConnectionSecretValue(state, providerId!),
      apply: (state, value) =>
        patchProviderEntry(state, providerId!, { apiKey: value }),
    };
  }

  const channelMatch = /^channel-field:([^:]+):(.+)$/.exec(fieldId);
  if (channelMatch) {
    const [, channelId, channelFieldId] = channelMatch;
    const channel = findSupportedChannel(state.channelCatalog ?? listSupportedChannels(), channelId!,
      state.config.messaging?.[channelId!]?.type ?? state.channelStates?.[channelId!]?.type);
    if (!channel) return null;
    const field = channel.requiredFields.find((f) => f.id === channelFieldId);
    if (!field) return null;
    return {
      title: `${channel.label} · ${field.label}`,
      hint: field.hint,
      example: field.example,
      sensitive: field.sensitive,
      docUrl: field.docUrl,
      currentValue: (state) => state.credentials.channels?.[channelId!]?.[channelFieldId!],
      apply: (state, value) =>
        patchChannelEntry(state, channelId!, { [channelFieldId!]: value }),
    };
  }

  return null;
}

function isValidEndpointForAutoDiscovery(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !hasExplicitUrlCredentialsOrQueryAuth(endpoint)
    );
  } catch {
    return false;
  }
}

export function handleInputPanelKey(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "input" }>,
  key: KeyEvent,
  runtime?: ConfigEditorRuntime,
): PanelAction {
  const meta = resolveInputField(descriptor.fieldId, state, runtime);
  if (!meta) {
    return { type: "pop", state };
  }

  switch (key.type) {
    case "ctrl-c":
      return { type: "exit", result: { kind: "cancelled" } };
    case "escape":
      return { type: "pop", state: setInputBuffer(state, "") };
    case "enter": {
      const value = state.inputBuffer.trim();
      if (!value) {
        // 空 buffer + 已有值 → 保留原值不动；空 buffer + 无已有值 → 取消（无写入）
        // 两种 case 都是 pop + 清 buffer，state.credentials 未改动即保留原值
        return { type: "pop", state: setInputBuffer(state, "") };
      }
      const overrideAddMatch = /^conn-override-add:(.+)$/.exec(descriptor.fieldId);
      if (overrideAddMatch) {
        return {
          type: "replace",
          state: setInputBuffer(state, ""),
          panel: {
            kind: "model-override-edit",
            connectionId: overrideAddMatch[1]!,
            modelId: value,
          },
        };
      }
      const validationError = meta.validate?.(value, state);
      if (validationError) {
        return { type: "stay", state, errorMessage: `⚠ ${validationError}` };
      }
      const newState = setInputBuffer(meta.apply(state, value), "");
      // 设计 §3.3：在连接编辑页填完合法地址与必要凭据时，自动触发一次本地只读原生发现（可按 Esc 跳过）
      const autoDiscMatch = /^conn-(?:secret|endpoint):(.+)$/.exec(descriptor.fieldId);
      if (autoDiscMatch && runtime?.discoverModels) {
        const connectionId = autoDiscMatch[1]!;
        const conn = readConnection(newState, connectionId);
        const credStatus = conn ? readConnectionSecretStatus(newState, connectionId) : "missing";
        if (
          conn &&
          isValidEndpointForAutoDiscovery(conn.endpoint) &&
          (credStatus === "none" || credStatus === "ready")
        ) {
          const catalog = runtime.modelCatalog?.() ?? DEFAULT_MODEL_CATALOG_PORT;
          const draftRev = newState.draftRevision ?? 0;
          const secret =
            conn.auth.mode === "api-key" || conn.auth.mode === "header"
              ? readConnectionSecretValue(newState, conn.auth.secretRef)
              : undefined;
          return {
            type: "loading",
            state: newState,
            message: `正在发现 ${conn.name} 的可用模型（按 Esc 可跳过）…`,
            run: async (signal) => {
              const result = await runtime.discoverModels!({
                connectionId,
                ...(conn.presetId ? { presetId: conn.presetId } : {}),
                adapter: conn.adapter,
                endpoint: conn.endpoint,
                auth: conn.auth,
                ...(secret ? { secretValue: secret } : {}),
                network: conn.network,
                ...(newState.config.network?.proxy !== undefined
                  ? { networkProxy: newState.config.network.proxy }
                  : {}),
                catalog: catalog.bundle,
                ...(newState.draftSessionId ? { requestSessionId: newState.draftSessionId } : {}),
                draftRevision: draftRev,
                signal,
              });
              return {
                type: "pop",
                state: recordDraftDiscoveryResult(newState, connectionId, result),
              };
            },
          };
        }
      }
      return { type: "pop", state: newState };
    }
    case "backspace": {
      if (state.inputBuffer.length === 0) return { type: "stay", state };
      const chars = Array.from(state.inputBuffer);
      chars.pop();
      return { type: "stay", state: setInputBuffer(state, chars.join("")) };
    }
    case "char":
      return { type: "stay", state: setInputBuffer(state, state.inputBuffer + key.ch) };
    default:
      return { type: "stay", state };
  }
}

export function handleAddModelPanelKey(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "add-model" }>,
  key: KeyEvent,
): PanelAction {
  switch (key.type) {
    case "ctrl-c":
      return { type: "exit", result: { kind: "cancelled" } };
    case "escape":
      return { type: "pop", state: setInputBuffer(state, "") };
    case "enter": {
      const value = state.inputBuffer.trim();
      if (!value) {
        return { type: "pop", state: setInputBuffer(state, "") };
      }
      // 加入用户自定义模型列表 + 自动选定为当前角色的 model。
      //
      // provider 必须用 descriptor.providerId（不是 currentRole.provider）：
      // add-model 面板的语义是"在此 provider 下添加新模型"，descriptor 是当前
      // 面板的明确语境。沿用 currentRole.provider 会造成跨 provider 引用——
      // 用户在 B 的 add-model 输入 model 时，若 currentRole 仍指向之前选过的 C，
      // 会错误写入 (role, C, B 的新模型) → 启动校验时挂在"C 没有此模型"。
      let next = addProviderModel(state, descriptor.providerId, value);
      next = writeModelRole(next, descriptor.role, descriptor.providerId, value);
      next = setInputBuffer(next, "");
      return { type: "pop", state: next };
    }
    case "backspace": {
      if (state.inputBuffer.length === 0) return { type: "stay", state };
      const chars = Array.from(state.inputBuffer);
      chars.pop();
      return { type: "stay", state: setInputBuffer(state, chars.join("")) };
    }
    case "char":
      return { type: "stay", state: setInputBuffer(state, state.inputBuffer + key.ch) };
    default:
      return { type: "stay", state };
  }
}

export function resolveBudgetRange(
  providerId: string,
  model: string,
  state?: WorkingState,
  runtime?: ConfigEditorRuntime,
): readonly [number, number] | undefined {
  const control =
    resolveThinkingControl(providerId, model, state, runtime?.modelCatalog?.()) ??
    getPreset(providerId)?.knownModels?.find((m) => m.id === model)?.thinkingControl;
  return control?.type === "budget" ? control.range : undefined;
}

export function handleThinkingBudgetPanelKey(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "thinking-budget" }>,
  key: KeyEvent,
): PanelAction {
  switch (key.type) {
    case "ctrl-c":
      return { type: "exit", result: { kind: "cancelled" } };
    case "escape":
      return { type: "pop", state: setInputBuffer(state, "") };
    case "enter": {
      const raw = state.inputBuffer.trim();
      // 非法 / 空 → 取消不写（保留原 thinking 不动），与 input/add-model 一致
      if (!/^\d+$/.test(raw)) {
        return { type: "pop", state: setInputBuffer(state, "") };
      }
      const budget = Number.parseInt(raw, 10);
      const next = setInputBuffer(
        writeModelThinking(state, descriptor.role, { mode: "budget", budget }),
        "",
      );
      return { type: "pop", state: next };
    }
    case "backspace": {
      if (state.inputBuffer.length === 0) return { type: "stay", state };
      const chars = Array.from(state.inputBuffer);
      chars.pop();
      return { type: "stay", state: setInputBuffer(state, chars.join("")) };
    }
    case "char":
      return { type: "stay", state: setInputBuffer(state, state.inputBuffer + key.ch) };
    default:
      return { type: "stay", state };
  }
}
