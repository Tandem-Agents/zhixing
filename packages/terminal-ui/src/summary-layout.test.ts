import { describe, expect, it } from 'vitest';
import type { TerminalSummary } from './protocol.js';
import { summaryPlan, SUMMARY_READING_WIDTH, type SummaryBlock } from './summary-layout.js';

// 测宽替身：CJK 与全角占 2 列，其余 1 列（产品里由渲染器自己的字素宽度决定）
const width = (grapheme: string) => (grapheme.codePointAt(0)! >= 0x2e80 ? 2 : 1);
const marker = '▎ ';
const of = <K extends SummaryBlock['kind']>(blocks: readonly SummaryBlock[], kind: K) => blocks.filter((block): block is Extract<SummaryBlock, { kind: K }> => block.kind === kind);

const summary: TerminalSummary = {
  lead: [[{ text: '主模式', tone: 'accent' }, { text: ' · 本对话的默认范围' }]],
  sections: [
    { title: '直接拦截 · 6 项', aside: '信任规则不能放行', items: ['Git 内部文件写保护', 'SSH 密钥保护', '环境变量注入防护'] },
    { title: '信任规则 · 共 0 条', items: ['本对话 0', '当前范围 0', '所有范围 0'], notes: ['浏览与撤销：在输入框输入 /trust 后加空格'] },
    { title: '允许累计', rows: [
      { label: 'bash · npm run test -- --coverage --reporter=verbose packages/cli/src/security', value: '已允许 12 次 · 最高风险 中' },
      { label: 'bash · command-1 *', value: '已允许 11 次 · 最高风险 高' }], empty: '暂无' },
    { title: '调用频率（当前窗口）', rows: [{ label: 'bash', value: '86 / 100 · 接近上限', tone: 'warn' }], empty: '当前窗口暂无调用记录' },
    { title: '空区块', rows: [], empty: '当前窗口暂无调用记录' },
  ],
};

describe('summary plan', () => {
  it('caps the reading width and keeps narrower windows as they are', () => {
    expect(summaryPlan(summary, 160, width, marker).width).toBe(SUMMARY_READING_WIDTH);
    expect(summaryPlan(summary, 45, width, marker).width).toBe(45);
  });

  it('puts an aside beside its title only when both fit, and separates sections with one gap', () => {
    const wide = of(summaryPlan(summary, 100, width, marker).blocks, 'header');
    expect(wide[0]).toEqual({ kind: 'header', title: '直接拦截 · 6 项', aside: '信任规则不能放行', asideInline: true, gap: true });
    expect(wide.every(header => header.gap)).toBe(true);
    // 2 列标记 + 15 列标题 + 2 列间距 + 16 列侧注 = 35 列
    expect(of(summaryPlan(summary, 35, width, marker).blocks, 'header')[0]!.asideInline).toBe(true);
    expect(of(summaryPlan(summary, 34, width, marker).blocks, 'header')[0]!.asideInline).toBe(false);
  });

  it('keeps items as whole entries and turns empty states and notes into dim paragraphs', () => {
    const blocks = summaryPlan(summary, 100, width, marker).blocks;
    expect(of(blocks, 'items')[0]).toEqual({ kind: 'items', items: ['Git 内部文件写保护', 'SSH 密钥保护', '环境变量注入防护'] });
    expect(of(blocks, 'note').map(note => note.text)).toEqual(['浏览与撤销：在输入框输入 /trust 后加空格', '当前窗口暂无调用记录']);
    expect(blocks.map(block => block.kind)).toEqual(['lead', 'header', 'items', 'header', 'items', 'note', 'header', 'row', 'row', 'header', 'row', 'header', 'note']);
  });

  it('aligns values page-wide on wide screens, stacks over-long labels without widening the column, and stacks every row on narrow screens', () => {
    const wide = summaryPlan(summary, 100, width, marker);
    // 能放下的最长标签是 “bash · command-1 *”（18 列）；超长命令单独成行，不拉宽列
    expect(wide.labelColumn).toBe(18);
    expect(of(wide.blocks, 'row').map(row => row.stacked)).toEqual([true, false, false]);
    expect(of(wide.blocks, 'row')[2]).toMatchObject({ label: 'bash', tone: 'warn', stacked: false });
    expect(of(summaryPlan(summary, 59, width, marker).blocks, 'row').every(row => row.stacked)).toBe(true);
  });
});
