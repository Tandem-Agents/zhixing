import { describe, expect, it } from 'vitest';
import { terminalTextureGlyph } from '../supervisor.js';

// 选中纹理字形的宿主判定：只有确认能画出“░”的宿主才用它，其余一律 ASCII 后备，绝不出缺字方框
describe('selected row texture glyph by host', () => {
  it('keeps the shade in ordinary terminals with font fallback and on non-Windows platforms', () => {
    expect(terminalTextureGlyph('win32', { kind: 'other' })).toBeUndefined();
    expect(terminalTextureGlyph('linux', undefined)).toBeUndefined();
    expect(terminalTextureGlyph('darwin', undefined)).toBeUndefined();
  });
  it('always uses the ASCII texture in the classic console, whatever the startup font reports', () => {
    // 界面画在备用屏幕缓冲区上，其字体不一定是启动时主缓冲区的字体，提示符的探测结果也不能代用
    expect(terminalTextureGlyph('win32', { kind: 'conhost', promptGlyph: 'present' })).toBe('ascii');
    expect(terminalTextureGlyph('win32', { kind: 'conhost', promptGlyph: 'missing' })).toBe('ascii');
    expect(terminalTextureGlyph('win32', { kind: 'conhost' })).toBe('ascii');
  });
  it('falls back when the console measurement itself failed and the host is unknown', () => {
    expect(terminalTextureGlyph('win32', undefined)).toBe('ascii');
  });
});
