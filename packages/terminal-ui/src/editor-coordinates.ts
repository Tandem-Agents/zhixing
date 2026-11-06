import { resolveRenderLib, TextBuffer, TextareaRenderable, type ColorInput, type RenderContext, type RGBA, type TextareaOptions, type WidthMethod } from '@opentui/core';
import { tone } from './theme.js';

/** OpenTUI offsets are display columns plus newline weights. The application
 * draft uses UTF-16 offsets. Keep the native width policy at this boundary.
 * 输入文字的前景：未聚焦（textColor）与聚焦（focusedTextColor）是两个独立字段，OpenTUI 缺省都是固定纯白，
 * 浅色背景上几乎看不见。调用方没给时都取宿主默认前景，清空时同样回到宿主前景；显式颜色照常优先。 */
export class TerminalTextarea extends TextareaRenderable {
  constructor(ctx: RenderContext, options: TextareaOptions) {
    const textColor = options.textColor ?? tone.text;
    super(ctx, { ...options, textColor, focusedTextColor: options.focusedTextColor ?? textColor });
  }

  override get textColor(): RGBA {
    return super.textColor;
  }

  override set textColor(value: RGBA | string | undefined) {
    super.textColor = value ?? tone.text;
  }

  // 基类只有 setter，这里保持同样的语义
  override set focusedTextColor(value: ColorInput) {
    super.focusedTextColor = value ?? tone.text;
  }

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
