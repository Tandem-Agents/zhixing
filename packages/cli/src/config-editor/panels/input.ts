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
} from "../state.js";
import { maskForDisplay, maskForInput } from "../ui/mask.js";
import { SUPPORTED_PROVIDERS, SUPPORTED_CHANNELS } from "../../registries/index.js";
import {
  tone,
  layout,
  renderChrome,
  renderFooter,
  osc8Hyperlink,
  stringWidth,
} from "../../tui/index.js";

const CONTENT_INDENT = " ".repeat(layout.contentIndent);
const INPUT_FOOTER_HINTS = [
  "Enter 保存",
  "Esc 取消",
  "Ctrl+C 退出",
] as const;
const ADD_MODEL_FOOTER_HINTS = [
  "Enter 添加",
  "Esc 取消",
  "Ctrl+C 退出",
] as const;

/**
 * 输入行写在 footer 上面（form 惯例：input → 提示），写完后回跳 cursor 到 buffer
 * 末尾——这样用户既能看到 footer 提示，又能看到光标停在自己输入位置。
 *
 * 回跳距离 = INPUT 之后的 writeLine 数 + 1（因为最后一次 writeLine 后 cursor
 * 自动下移到 footer 之下的"未写区"，多 1 行）。
 */
function writeInputThenFooterAndRestoreCursor(
  renderer: Renderer,
  inputLineContent: string,
  footerHints: readonly string[],
): void {
  renderer.writeLine(inputLineContent);
  renderer.writeLine("");
  renderer.writeLines(
    renderFooter({ width: renderer.terminalWidth(), hints: footerHints }),
  );
  // INPUT 之后 3 次 writeLine（empty + footer separator + footer hint）
  // → cursor 现在位于 INPUT 下方 4 行处，回跳 4 行落到 INPUT 行
  renderer.moveCursorUp(4);
  // 列定位到 buffer 末尾的下一列（1-based）
  renderer.setCursorColumn(stringWidth(inputLineContent) + 1);
}

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
  /** 文档链接——单独渲染为可点击行（OSC 8）；可选 */
  docUrl?: string;
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
      docUrl: provider.docUrl,
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
      docUrl: field.docUrl,
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
    renderer.writeLine(tone.error(`未知字段：${descriptor.fieldId}`));
    return;
  }

  renderer.clear();
  renderer.showCursor();

  const width = renderer.terminalWidth();

  // Chrome body：hint 多行 + 可选 docUrl 链接 + example
  const bodyLines: string[] = [];
  for (const line of meta.hint.split("\n")) {
    bodyLines.push(line);
  }
  if (meta.docUrl) {
    bodyLines.push(`${tone.dim("文档：")}${osc8Hyperlink(meta.docUrl)}`);
  }
  bodyLines.push("");
  bodyLines.push(tone.dim(`示例：${meta.example}`));

  renderer.writeLines(
    renderChrome({ title: meta.title, body: bodyLines, width }),
  );
  renderer.writeLine("");

  // 已有值提示：buffer 空 + 字段已暂存值时显示，让用户知道有值且能直接 Enter 保留
  const existingValue = meta.currentValue(state);
  const hasExisting = Boolean(existingValue);
  const isFreshInput = state.inputBuffer === "";

  if (hasExisting && isFreshInput) {
    const masked = meta.sensitive
      ? maskForDisplay(existingValue!)
      : existingValue;
    renderer.writeLine(
      `${CONTENT_INDENT}${tone.dim(`当前：${masked}（Enter 保留 / 输入新值覆盖）`)}`,
    );
    renderer.writeLine("");
  }

  // input 行写在 footer 上面（form 惯例），写完后回跳 cursor 到 buffer 末尾
  const display = meta.sensitive
    ? maskForInput(state.inputBuffer)
    : state.inputBuffer;
  writeInputThenFooterAndRestoreCursor(
    renderer,
    `${CONTENT_INDENT}> ${display}`,
    INPUT_FOOTER_HINTS,
  );
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
  const provider = SUPPORTED_PROVIDERS.find(
    (p) => p.id === descriptor.providerId,
  );
  const providerLabel = provider?.label ?? "服务商";

  renderer.clear();
  renderer.showCursor();

  const width = renderer.terminalWidth();

  // Chrome body：使用说明 + 可选文档链接 + 可选示例
  const bodyLines: string[] = [`输入 model id（按${providerLabel}文档命名）`];
  if (provider?.modelListDocUrl) {
    bodyLines.push(
      `${tone.dim("文档：")}${osc8Hyperlink(provider.modelListDocUrl)}`,
    );
  }
  if (provider?.modelExample) {
    bodyLines.push("");
    bodyLines.push(tone.dim(`示例：${provider.modelExample}`));
  }

  renderer.writeLines(
    renderChrome({
      title: `${providerLabel} · 添加模型`,
      body: bodyLines,
      width,
    }),
  );
  renderer.writeLine("");

  writeInputThenFooterAndRestoreCursor(
    renderer,
    `${CONTENT_INDENT}> ${state.inputBuffer}`,
    ADD_MODEL_FOOTER_HINTS,
  );
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
