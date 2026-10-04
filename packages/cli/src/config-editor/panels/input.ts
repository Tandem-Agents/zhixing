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
import type { PanelDescriptor, WorkingState } from "../types.js";
import { maskForDisplay, maskForInput } from "../ui/mask.js";
import { SUPPORTED_PROVIDERS } from "../../registries/index.js";
import { tone, layout, renderChrome, renderFooter, osc8Hyperlink, stringWidth, Renderer } from "../../tui/index.js";
import { resolveInputField, resolveBudgetRange } from '../model/input.js';
export { handleInputPanelKey, handleAddModelPanelKey, handleThinkingBudgetPanelKey } from '../model/input.js';



export const CONTENT_INDENT = " ".repeat(layout.contentIndent);

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

const THINKING_BUDGET_FOOTER_HINTS = [
  "Enter 保存",
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
export function writeInputThenFooterAndRestoreCursor(
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


// ─── input 面板 ───

export function renderInputPanel(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "input" }>,
  renderer: Renderer,
): void {
  const meta = resolveInputField(descriptor.fieldId, state);
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


export function renderThinkingBudgetPanel(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "thinking-budget" }>,
  renderer: Renderer,
): void {
  renderer.clear();
  renderer.showCursor();

  const width = renderer.terminalWidth();
  const range = resolveBudgetRange(descriptor.providerId, descriptor.model);

  const bodyLines: string[] = ["输入思考 token 预算（整数）"];
  if (range) {
    bodyLines.push("");
    bodyLines.push(tone.dim(`官方建议区间：${range[0]}–${range[1]} token`));
  }

  renderer.writeLines(
    renderChrome({
      title: `${descriptor.model} · 自定义思考预算`,
      body: bodyLines,
      width,
    }),
  );
  renderer.writeLine("");

  writeInputThenFooterAndRestoreCursor(
    renderer,
    `${CONTENT_INDENT}> ${state.inputBuffer}`,
    THINKING_BUDGET_FOOTER_HINTS,
  );
}
