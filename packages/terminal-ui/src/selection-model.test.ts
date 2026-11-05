import { afterEach, describe, expect, it } from 'vitest';
import { configureSelectionTexture, selectionSegments, selectionTextureGlyph, selectionTextureLayer } from './selection-model.js';

describe('selected row texture rules', () => {
  afterEach(() => configureSelectionTexture(false, () => 1));
  it('opens only runs of two or more spaces; single spaces and text cover the texture', () => {
    expect(selectionSegments('» a b  c')).toEqual([{ text: '» a b', open: false }, { text: '  ', open: true }, { text: 'c', open: false }]);
    expect(selectionSegments('  ★⊘ 名称')).toEqual([{ text: '  ', open: true }, { text: '★⊘ 名称', open: false }]);
    expect(selectionSegments('» ')).toEqual([{ text: '» ', open: false }]);
    expect(selectionSegments('')).toEqual([]);
    // 文字原样：各段拼回即原文
    const text = '  主模型（必填 · 主对话）   ⚠ 待配置  ';
    expect(selectionSegments(text).map(part => part.text).join('')).toBe(text);
  });
  it('uses the migrated shade glyph unless the host declares ascii or the shade is not one column', () => {
    configureSelectionTexture(false, () => 1); expect(selectionTextureGlyph()).toBe('░');
    configureSelectionTexture(true, () => 1); expect(selectionTextureGlyph()).toBe(':');
    configureSelectionTexture(false, text => text === '░' ? 2 : 1); expect(selectionTextureGlyph()).toBe(':');
    configureSelectionTexture(false, () => 0); expect(selectionTextureGlyph()).toBe(':');
  });
  it('generates exactly the row box area', () => {
    configureSelectionTexture(false, () => 1);
    expect(selectionTextureLayer(3, 2)).toBe('░░░\n░░░');
    expect(selectionTextureLayer(0, 2)).toBe('');
    expect(selectionTextureLayer(4, 0)).toBe('');
  });
});
