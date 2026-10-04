import type { PanelDescriptor, WorkingState } from "../types.js";
import { renderChrome, renderListRow, renderFooter, Renderer } from "../../tui/index.js";
import { resolveListMeta } from '../model/list.js';
export { type ListPanelKeyResult, handleListPanelKey } from '../model/list.js';



const FOOTER_HINTS = [
  "↑↓ 选择",
  "Enter 进入",
  "Esc 返回",
  "Ctrl+C 退出",
] as const;


// ─── 渲染 + 处理 ───

export function renderListPanel(
  state: WorkingState,
  descriptor: PanelDescriptor,
  cursor: { index: number },
  renderer: Renderer,
): void {
  const meta = resolveListMeta(state, descriptor);
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

  // 列表项紧贴排列——chrome 自带顶/底 padding 已提供呼吸；
  // current 概念由整个 list 决定（model-list 有、provider-list 没有），
  // 让所有行共享 marker 槽位以保证 label 起始列对齐
  for (let i = 0; i < meta.items.length; i++) {
    const item = meta.items[i]!;
    const selected = i === cursor.index;
    renderer.writeLines(
      renderListRow({
        label: item.label,
        description: item.description,
        current: meta.hasCurrentConcept ? Boolean(item.current) : undefined,
        selected,
        width,
      }),
    );
  }

  renderer.writeLine("");
  renderer.writeLines(
    renderFooter({ width, hints: FOOTER_HINTS }),
  );
}
