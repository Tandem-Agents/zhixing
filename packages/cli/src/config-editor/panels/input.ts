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

import type {
  ConfigEditorContext,
  KeyEvent,
  PanelAction,
  PanelDescriptor,
  WorkingState,
} from "../types.js";
import { Renderer } from "../ui/render.js";
import {
  addProviderModel,
  patchChannelEntry,
  patchProviderEntry,
  setInputBuffer,
  writeModelRole,
  readModelRole,
} from "../state.js";
import { maskForDisplay, maskForInput } from "../ui/mask.js";
import { SUPPORTED_PROVIDERS } from "../providers-registry.js";
import { SUPPORTED_CHANNELS } from "../channels-registry.js";

// ─── input 字段路由 ───

/**
 * 字段 ID 到字段元数据的映射——对应 PanelDescriptor.kind === "input" 时 fieldId 的取值。
 *
 * fieldId 格式：
 *   - "provider-apikey:<role>:<providerId>"   编辑某 provider 的 API Key
 *   - "channel-field:<channelId>:<fieldId>"   编辑某 channel 的某字段（含 appId / appSecret）
 */
interface InputFieldMeta {
  title: string;
  hint: string;
  example: string;
  sensitive: boolean;
  /** 已存值——进入编辑面板时显示（敏感字段会 mask）；用户开始输入即覆盖 */
  currentValue: (state: WorkingState) => string | undefined;
  /** 提交时把 buffer 写入 state */
  apply: (state: WorkingState, value: string) => WorkingState;
}

function resolveInputField(
  fieldId: string,
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
      currentValue: (state) => state.credentials.providers?.[providerId!]?.apiKey,
      apply: (state, value) =>
        patchProviderEntry(state, providerId!, { apiKey: value }),
    };
  }

  const channelMatch = /^channel-field:([^:]+):(.+)$/.exec(fieldId);
  if (channelMatch) {
    const [, channelId, channelFieldId] = channelMatch;
    const channel = SUPPORTED_CHANNELS.find((c) => c.id === channelId);
    if (!channel) return null;
    const field = channel.requiredFields.find((f) => f.id === channelFieldId);
    if (!field) return null;
    return {
      title: `${channel.label} · ${field.label}`,
      hint: field.hint,
      example: field.example,
      sensitive: field.sensitive,
      currentValue: (state) => state.credentials.channels?.[channelId!]?.[channelFieldId!],
      apply: (state, value) =>
        patchChannelEntry(state, channelId!, { [channelFieldId!]: value }),
    };
  }

  return null;
}

// ─── input 面板 ───

export function renderInputPanel(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "input" }>,
  renderer: Renderer,
): void {
  const meta = resolveInputField(descriptor.fieldId);
  if (!meta) {
    // 未识别的 fieldId——defensive 渲染
    renderer.clear();
    renderer.writeLine(renderer.red(`未知字段：${descriptor.fieldId}`));
    return;
  }

  renderer.clear();
  renderer.showCursor();

  renderer.separator();
  renderer.writeLine(`  ${renderer.bold(meta.title)}`);
  renderer.separator();
  renderer.writeLine("");

  for (const line of meta.hint.split("\n")) {
    renderer.writeLine(`  ${line}`);
  }
  renderer.writeLine("");
  renderer.writeLine(`  ${renderer.dim(`示例：${meta.example}`)}`);
  renderer.writeLine("");

  // 已有值提示：buffer 空 + 字段已暂存值时显示，让用户知道有值且能直接 Enter 保留
  const existingValue = meta.currentValue(state);
  const hasExisting = Boolean(existingValue);
  const isFreshInput = state.inputBuffer === "";

  if (hasExisting && isFreshInput) {
    const masked = meta.sensitive ? maskForDisplay(existingValue!) : existingValue;
    renderer.writeLine(
      `  ${renderer.dim(`当前已暂存：${masked}（直接 Enter 保留 / 输入新值替换）`)}`,
    );
    renderer.writeLine("");
    renderer.writeLine(
      renderer.dim("  Enter 保存    Esc 取消    Ctrl+C 退出向导"),
    );
  } else {
    renderer.writeLine(
      renderer.dim("  Enter 保存    Esc 取消    Ctrl+C 退出向导"),
    );
  }
  renderer.writeLine("");

  // 输入行写在最后且不带 \n——让终端光标自然停在 buffer 之后
  const display = meta.sensitive ? maskForInput(state.inputBuffer) : state.inputBuffer;
  renderer.writeRaw(`  > ${display}`);
}

export function handleInputPanelKey(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "input" }>,
  key: KeyEvent,
): PanelAction {
  const meta = resolveInputField(descriptor.fieldId);
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

// ─── add-model 面板 ───

export function renderAddModelPanel(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "add-model" }>,
  renderer: Renderer,
): void {
  const provider = SUPPORTED_PROVIDERS.find((p) => p.id === descriptor.providerId);

  renderer.clear();
  renderer.showCursor();

  renderer.separator();
  renderer.writeLine(`  ${renderer.bold(`${provider?.label ?? descriptor.providerId} · 添加模型`)}`);
  renderer.separator();
  renderer.writeLine("");
  renderer.writeLine(`  输入要添加的 model id（按 ${provider?.label ?? "服务商"} 文档命名）`);
  renderer.writeLine("");
  renderer.writeLine(renderer.dim("  Enter 添加    Esc 取消    Ctrl+C 退出向导"));
  renderer.writeLine("");

  // 输入行写在最后且不带 \n——让终端光标自然停在 buffer 之后
  renderer.writeRaw(`  > ${state.inputBuffer}`);
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
      // 加入用户自定义模型列表 + 自动选定为当前角色的 model
      let next = addProviderModel(state, descriptor.providerId, value);
      const currentRole = readModelRole(next, descriptor.role);
      next = writeModelRole(
        next,
        descriptor.role,
        currentRole?.provider ?? descriptor.providerId,
        value,
      );
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
