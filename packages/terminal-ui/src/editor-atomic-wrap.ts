import { resolveRenderLib, TextBuffer, type TextareaRenderable, type WidthMethod } from '@opentui/core';

export interface AtomicRange { readonly start: number; readonly end: number }

/** Layout coordinates only. EditBuffer and its selection/cursor stay authoritative.
 * The owner passes sorted non-overlapping UTF-16 ranges from admitted handles. */
export function setEditorAtomicWrap(
  editor: TextareaRenderable, text: string, ranges: readonly AtomicRange[], width: WidthMethod,
): void {
  if (ranges.length > 65536) throw Error('输入原子区域超过有界布局容量，原文仍保留。');
  const lib = resolveRenderLib() as ReturnType<typeof resolveRenderLib> & {
    editorViewSetNoBreakRanges(view: TextareaRenderable['editorView']['ptr'], ranges: Uint32Array): boolean;
  };
  if (typeof lib.editorViewSetNoBreakRanges !== 'function') throw Error('原子换行原生资产不匹配。');
  const packed = new Uint32Array(ranges.length * 2);
  if (!ranges.length) {
    if (!lib.editorViewSetNoBreakRanges(editor.editorView.ptr, packed)) throw Error('输入原子区域布局未完成，原文仍保留。');
    editor.requestRender();
    return;
  }
  const measure = TextBuffer.create(width);
  let previous = 0, cellOffset = 0;
  try {
    measure.setTabWidth(editor.editBuffer.getTabWidth());
    const advance = (end: number) => {
      if (end < previous || end > text.length || !Number.isSafeInteger(end)) throw Error('输入原子区域坐标无效。');
      if (end !== previous) {
        measure.setText(text.slice(previous, end));
        cellOffset += lib.textBufferGetLength(measure.ptr) + measure.getLineCount() - 1;
        previous = end;
      }
      return cellOffset;
    };
    for (let index = 0; index < ranges.length; index++) {
      const range = ranges[index]!;
      if (range.end <= range.start || /[\r\n]/u.test(text.slice(range.start, range.end))) throw Error('输入原子区域无效。');
      packed[index * 2] = advance(range.start);
      packed[index * 2 + 1] = advance(range.end);
    }
  } finally { measure.destroy(); }
  if (!lib.editorViewSetNoBreakRanges(editor.editorView.ptr, packed)) throw Error('输入原子区域布局未完成，原文仍保留。');
  editor.requestRender();
}
