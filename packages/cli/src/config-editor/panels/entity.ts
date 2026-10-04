import type { PanelDescriptor, WorkingState } from "../types.js";
import { tone, renderChrome, renderEntryRow, renderButtonRow, renderFooter, Renderer } from "../../tui/index.js";
import { resolveEntityMeta } from '../model/entity.js';
export { type OnEnterResult, type EntityPanelKeyResult, handleEntityPanelKey } from '../model/entity.js';



const FOOTER_HINTS = [
  "↑↓ 选择",
  "Enter 进入/确认",
  "Esc 返回",
  "Ctrl+C 退出",
] as const;


// ─── 渲染 + 处理 ───

export function renderEntityPanel(
  state: WorkingState,
  descriptor: PanelDescriptor,
  cursor: { index: number },
  renderer: Renderer,
  errorMessage?: string,
): void {
  const meta = resolveEntityMeta(state, descriptor);
  if (!meta) return;

  renderer.clear();
  renderer.hideCursor();

  const width = renderer.terminalWidth();

  renderer.writeLines(
    renderChrome({
      title: meta.title,
      body: [meta.description],
      width,
    }),
  );
  renderer.writeLine("");

  let index = 0;
  for (const row of meta.rows) {
    const selected = index === cursor.index;
    renderer.writeLines(
      renderEntryRow({
        label: row.label,
        status: { kind: row.status.level, text: row.status.text },
        selected,
        width,
      }),
    );
    index++;
  }
  renderer.writeLine("");

  // 按钮：cursor 外置在 middle 行左侧 + 右侧 hint，与 main 面板同款
  for (const btn of meta.buttons) {
    const selected = index === cursor.index;
    renderer.writeLines(
      renderButtonRow({
        label: btn.label,
        hint: btn.hint,
        primary: btn.primary,
        selected,
      }),
    );
    index++;
  }

  renderer.writeLine("");
  if (errorMessage) {
    renderer.writeLine(tone.error("  " + errorMessage));
    renderer.writeLine("");
  }
  renderer.writeLines(
    renderFooter({ width, hints: FOOTER_HINTS }),
  );
}
