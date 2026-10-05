import { resolveRenderLib, TextBuffer, TextareaRenderable, type WidthMethod } from '@opentui/core';

/** OpenTUI offsets are display columns plus newline weights. The application
 * draft uses UTF-16 offsets. Keep the native width policy at this boundary. */
export class TerminalTextarea extends TextareaRenderable {
  override get plainText(): string {
    const lib = resolveRenderLib();
    const bytes = lib.textBufferGetByteSize(lib.editBufferGetTextBuffer(this.editBuffer.ptr));
    if (!bytes) return '';
    const text = lib.editBufferGetText(this.editBuffer.ptr, bytes);
    if (!text || text.byteLength !== bytes) throw Error('输入读取未完成，原文仍保留在编辑区。');
    return lib.decoder.decode(text);
  }
}

export function editorUtf16Cursor(editor: TextareaRenderable): number {
  if (!editor.cursorOffset) return 0;
  const lib = resolveRenderLib(), bytes = lib.textBufferGetByteSize(lib.editBufferGetTextBuffer(editor.editBuffer.ptr));
  const prefix = lib.editBufferGetTextRange(editor.editBuffer.ptr, 0, editor.cursorOffset, bytes);
  return prefix ? lib.decoder.decode(prefix).length : 0;
}

export function setEditorUtf16Cursor(editor: TextareaRenderable, text: string, offset: number, width: WidthMethod): void {
  const prefix = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  if (!prefix) { editor.cursorOffset = 0; return; }
  const measure = TextBuffer.create(width);
  try {
    measure.setTabWidth(editor.editBuffer.getTabWidth()); measure.setText(prefix);
    const lib = resolveRenderLib();
    editor.cursorOffset = lib.textBufferGetLength(measure.ptr) + measure.getLineCount() - 1;
  } finally { measure.destroy(); }
}
