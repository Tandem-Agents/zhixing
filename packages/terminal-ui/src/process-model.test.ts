import { describe, expect, it } from 'vitest';
import { thinkingTail, processCellWidth, processThinkingBodyBlock, processBodyBlock, processBodyColor, processViewRows, validateProcessView } from './process-model.js';
import { renderedToSource } from './body/layout.js';
describe('pure process presentation', () => {
  it('renders the completed turn as one compact metadata row without concealing a gap', () => {
    const view = { revision: 1, phase: '本轮已结束', durationMs: 8200, tools: [], children: [], usage: { inputTokens: 20, outputTokens: 100, contextTokens: 7300 } };
    expect(processViewRows(view, 80, 6)).toEqual([{ text: '◆ 用时 8s  │  ~ 7.3k' }]);
    expect(processViewRows({ ...view, notice: '本轮已结束；正文存在缺口' }, 80, 6)[0]!.text).toContain('正文存在缺口');
    expect(validateProcessView({ ...view, durationMs: Infinity })).toBe(false);
  });
  it.each([1, 2, 8, 40, 80])('limits rolling thinking to two display rows at width %i', width => {
    const rows = thinkingTail('开头\n' + '汉🦞e\u0301'.repeat(1000) + '尾部', width);
    expect(rows.length).toBeLessThanOrEqual(2);
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const row of rows) expect([...segmenter.segment(row)].reduce((n, g) => n + processCellWidth(g.segment), 0)).toBeLessThanOrEqual(width);
  });
  it('keeps emoji/combining graphemes intact and removes terminal controls', () => {
    expect(thinkingTail('\x1b[31m测试👩‍💻e\u0301', 6).join('')).toBe('测试👩‍💻e\u0301');
    expect(thinkingTail('a\nb\nc', 20)).toEqual(['b', 'c']);
  });
  it('reprojects the same cached thinking on resize while preserving source anchors', () => {
    const text = '0123456789'.repeat(20);
    const runs = [{ from: 1000, to: 1200, text, style: 0 }];
    const block = { key: 'thinking', blockId: 'b', role: 'thinking', text, runs,
      node: { kind: 'paragraph' as const, from: 1000, to: 1200, runs } };
    const wide = processThinkingBodyBlock(block, 40), narrow = processThinkingBodyBlock(block, 10);
    expect(wide.text.split('\n')).toHaveLength(2); expect(narrow.text.split('\n')).toHaveLength(2);
    expect(narrow.text.replace(/\n/gu, '')).toHaveLength(20);
    expect(renderedToSource(narrow, 0)).toEqual({ blockId: 'b', contentOffset: 1180 });
    expect(block.text).toHaveLength(200);
  });
  it('does not transform ordinary body blocks and validates finite DTO rows', () => {
    const block = { key: 'answer', blockId: 'b', role: 'assistant', text: 'full', runs: [], node: { kind: 'paragraph' as const, from: 0, to: 4, runs: [] } };
    expect(processThinkingBodyBlock(block, 2)).toBe(block);
    expect(validateProcessView({ revision: 1, phase: '处理', tools: [], children: [], usage: {} })).toBe(true);
    expect(validateProcessView({ revision: 1, phase: '处理', tools: [], children: [], usage: { inputTokens: Infinity } })).toBe(false);
  });
  it('keeps one aggregate child row and puts failure before long optional descriptions', () => {
    const children = Array.from({ length: 8 }, (_, i) => ({ id: 'child' + i, parentToolCallId: 'task' + i,
      label: '很长的任务描述'.repeat(50), status: i === 0 ? 'failed' as const : 'running' as const }));
    const rows = processViewRows({ revision: 1, phase: '正在处理', tools: [], children, usage: { inputTokens: 0 } }, 24, 8);
    expect(rows.filter(row => row.text.startsWith('子任务'))).toHaveLength(1);
    expect(rows.find(row => row.failed)?.text).toContain('1失败');
    expect(rows.at(-1)?.text).toContain('输入 0');
    expect(rows[0]?.text.startsWith('◆')).toBe(true);
  });
  it('preserves diff source at narrow widths for shared soft wrap and copying', () => {
    const text = '◆ 已修改 file.ts\n+ 1  汉字汉字汉字\n-    old value';
    const runs = [{ from: 200, to: 200 + text.length, text, style: 0 }];
    const block = { key: 'diff', blockId: 'b', role: 'tool-diff', text, runs,
      node: { kind: 'paragraph' as const, from: 200, to: 200 + text.length, runs } };
    const projected = processBodyBlock(block, 9);
    const lines = projected.text.split('\n');
    expect(lines[1]).toBe('+ 1  汉字汉字汉字');
    expect(projected.text).toBe(text);
    expect(renderedToSource(projected, lines[0]!.length + 1)).toEqual({ blockId: 'b', contentOffset: 200 + text.indexOf('+ 1') });
    // Diff color comes from typed source spans, never inferred from user text.
    expect(processBodyColor('tool-diff', lines[1]!)).toBe('dim');
    expect(processBodyColor('tool-diff', lines[2]!)).toBe('dim');
    expect(block.text).toBe(text);
  });
});
