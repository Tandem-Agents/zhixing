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
import type { PanelAction, PanelDescriptor, WorkingState } from "../types.js";
import { getPreset } from "@zhixing/providers";
import { addProviderModel, patchChannelEntry, patchProviderEntry, setInputBuffer, writeModelRole, writeModelThinking } from "../state.js";
import { SUPPORTED_PROVIDERS, listSupportedChannels, findSupportedChannel } from "../../registries/index.js";
import type { KeyEvent } from "../../tui/index.js";

export interface InputFieldMeta {
  title: string;
  hint: string;
  example: string;
  sensitive: boolean;
  /** 文档链接——单独渲染为可点击行（OSC 8）；可选 */
  docUrl?: string;
  /** 已存值——进入编辑面板时显示（敏感字段会 mask）；用户开始输入即覆盖 */
  currentValue: (state: WorkingState) => string | undefined;
  /** 提交时把 buffer 写入 state */
  apply: (state: WorkingState, value: string) => WorkingState;
}

export function resolveInputField(
  fieldId: string,
  state: WorkingState,
): InputFieldMeta | null {
  const providerMatch = /^provider-apikey:([^:]+):(.+)$/.exec(fieldId);
  if (providerMatch) {
    const [, _role, providerId] = providerMatch;
    const provider = SUPPORTED_PROVIDERS.find((p) => p.id === providerId);
    if (!provider) return null;
    return {
      title: `${provider.label} · API Key`,
      hint: provider.apiKeyHint,
      example: provider.apiKeyExample,
      sensitive: true,
      docUrl: provider.docUrl,
      currentValue: (state) => state.credentials.providers?.[providerId!]?.apiKey,
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

export function handleInputPanelKey(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "input" }>,
  key: KeyEvent,
): PanelAction {
  const meta = resolveInputField(descriptor.fieldId, state);
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
      const newState = setInputBuffer(meta.apply(state, value), "");
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
): readonly [number, number] | undefined {
  const control = getPreset(providerId)?.knownModels?.find(
    (m) => m.id === model,
  )?.thinkingControl;
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
