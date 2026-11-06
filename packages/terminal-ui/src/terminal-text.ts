import { TextRenderable, type RGBA, type RenderContext, type TextOptions } from '@opentui/core';
import { tone } from './theme.js';

/**
 * 应用的普通文字：调用方没给前景时取宿主默认前景（tone.text），不用 OpenTUI 文字类的缺省固定纯白。
 * 固定纯白在浅色背景上几乎看不见；宿主默认前景在明暗配色里都由宿主保证可读。
 * 构造与清空都回到宿主前景：Solid 先只用 id 构造，再逐项写属性，显式颜色改为空值时同样经过 setter。
 * 显式前景照常优先；span 不给前景时继承这里的默认值。
 */
export class TerminalText extends TextRenderable {
  constructor(ctx: RenderContext, options: TextOptions) {
    super(ctx, { ...options, fg: options.fg ?? tone.text });
  }

  override get fg(): RGBA {
    return super.fg;
  }

  override set fg(value: RGBA | string | undefined) {
    super.fg = value ?? tone.text;
  }
}
