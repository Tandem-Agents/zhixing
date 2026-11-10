import { resolveRenderLib, TextBuffer, TextareaRenderable, type ColorInput, type RenderContext, type RGBA, type TextareaOptions, type WidthMethod } from '@opentui/core';
import { tone } from './theme.js';
import type { TerminalEditStep } from './draft-projection.js';

/** 原生编辑缓冲修改文本的全部入口（编辑视图另有删除选区）。撤销、重做各自成一类。 */
const EDIT_ENTRIES = [['insertChar', 'edit'], ['insertText', 'edit'], ['deleteChar', 'edit'], ['deleteCharBackward', 'edit'], ['deleteLine', 'edit'],
  ['deleteRange', 'edit'], ['newLine', 'edit'], ['undo', 'undo'], ['redo', 'redo']] as const;

/** 取步的接收方：只在它需要时才读取文本，避免无 CR 草稿的每次按键都多读两遍全文。 */
export interface TerminalEditStepListener { wanted(): boolean; step(step: TerminalEditStep): void }

/** OpenTUI offsets are display columns plus newline weights. The application
 * draft uses UTF-16 offsets. Keep the native width policy at this boundary.
 * 输入文字的前景：未聚焦（textColor）与聚焦（focusedTextColor）是两个独立字段，OpenTUI 缺省都是固定纯白，
 * 浅色背景上几乎看不见。调用方没给时都取宿主默认前景，清空时同样回到宿主前景；显式颜色照常优先。 */
export class TerminalTextarea extends TextareaRenderable {
  /**
   * 原生修改入口上的同步取步。内容与光标事件会合并到同一批操作之后才到，回调里读到的已是最后状态；
   * 只有在入口处逐次取前后文本，才能与原生撤销历史一步对一步。
   */
  editSteps?: TerminalEditStepListener;

  constructor(ctx: RenderContext, options: TextareaOptions) {
    const textColor = options.textColor ?? tone.text;
    super(ctx, { ...options, textColor, focusedTextColor: options.focusedTextColor ?? textColor });
    const buffer = this.editBuffer as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const [name, kind] of EDIT_ENTRIES) {
      const original = buffer[name]!.bind(this.editBuffer);
      buffer[name] = (...args: unknown[]) => this.#observe(kind, () => original(...args));
    }
    const view = this.editorView as unknown as Record<string, (...args: unknown[]) => unknown>;
    const deleteSelected = view.deleteSelectedText!.bind(this.editorView);
    view.deleteSelectedText = (...args: unknown[]) => this.#observe('edit', () => deleteSelected(...args));
  }

  #observe<T>(kind: TerminalEditStep['kind'], run: () => T): T {
    const listener = this.editSteps;
    if (!listener?.wanted()) return run();
    const before = this.plainText;
    const result = run();
    const after = this.plainText;
    if (after !== before) listener.step({ kind, before, after, cursorAfter: editorUtf16Cursor(this) });
    return result;
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
