import { describe, expect, it } from 'vitest';
import type { TerminalSummary } from '@zhixing-ai/terminal-ui/protocol';
import { informationCompactLines, informationContextSummary, informationLines, informationModelLines,
  informationText, informationUsageSummary, type TerminalUsageProjection } from '../information-presentation.js';
import { summaryLines } from '../../summary-projection.js';

const budget = { currentTokens: 40_000, effectiveWindow: 80_000, contextWindow: 100_000, usageRatio: 0.5, status: 'normal' } as const;
const usage = (change: Partial<TerminalUsageProjection> = {}): TerminalUsageProjection => ({ budget, turnCount: 4, calibrationFactor: 1, subUsages: [], ...change });
const text = (lines: readonly string[]) => lines.join('\n');
const section = (summary: TerminalSummary, title: string) => {
  const found = summary.sections.find(item => item.title === title);
  if (!found) throw Error(`missing section ${title}: ${summary.sections.map(item => item.title).join('、')}`);
  return found;
};
const usageOne = (view: TerminalUsageProjection) => { const pages = informationUsageSummary(view); expect(pages).toHaveLength(1); return pages[0]!; };
const values = (summary: TerminalSummary, title: string) => Object.fromEntries((section(summary, title).rows ?? []).map(row => [row.label, row.value]));

describe('terminal information presentation', () => {
  it('displays only the supplied current model projection, including unconfigured state', () => {
    expect(informationModelLines({ model: 'model-a', providerId: 'provider-a' })).toEqual(['模型：model-a', '服务商：provider-a']);
    expect(informationModelLines({ model: '', providerId: '' })).toEqual(['模型：(未配置)', '服务商：(未配置)']);
  });
  it('distinguishes request capacity, effective window, nominal window and optional calibration, keeping the scope sentence', () => {
    const summary = usageOne(usage());
    expect(summary.lead).toEqual([[{ text: '主对话 · 上下文容量估算', tone: 'accent' }]]);
    expect(values(summary, '容量')).toEqual({ 容量占比: '50% (40.0k / 80.0k)', 有效容量: '80.0k tokens', 标称上下文窗口: '100.0k tokens',
      会话轮次: '4 轮', 估算校准: '1.000（未校准）' });
    expect(section(summary, '容量').notes).toEqual(['以上是请求容量估算，不是累计消耗或费用。']);
    expect(summary.sections.map(item => item.title)).toEqual(['容量']);
    expect(values(usageOne(usage({ calibrationFactor: 1.125 })), '容量').估算校准).toBe('1.125（已校准）');
    expect(values(usageOne(usage({ calibrationFactor: undefined })), '容量')).not.toHaveProperty('估算校准');
  });
  it('keeps successful, failed and aborted subtask costs separate from the main estimate, one row each', () => {
    const summary = usageOne(usage({ subUsages: [
      { index: 1, description: '搜集资料', status: 'succeeded', tokens: 1200, toolUses: 2, durationMs: 800, subId: 'first' },
      { index: 2, description: '读取失败', status: 'failed', tokens: 2300, toolUses: 3, durationMs: 1500 },
      { index: 3, description: '用户中止', status: 'aborted', tokens: 0, toolUses: 0, durationMs: 60_000 },
    ] }));
    expect(section(summary, '子任务（3 个）').rows).toEqual([
      { label: '#1', value: '✓ 成功 · 1.2k tokens · 工具调用 2 次 · 耗时 800ms', note: '搜集资料 · sub first' },
      { label: '#2', value: '⚠ 失败 · 2.3k tokens · 工具调用 3 次 · 耗时 1.5s', note: '读取失败', tone: 'warn' },
      { label: '#3', value: '⏵ 中止 · 0 tokens · 工具调用 0 次 · 耗时 1m 0s', note: '用户中止' },
    ]);
    expect(values(summary, '子任务合计')).toEqual({ 子任务总计: '3.5k tokens', 工具调用合计: '5 次', 耗时合计: '1m 2s' });
    expect(section(summary, '子任务合计').notes).toEqual(['子任务合计仅覆盖这些任务，不是全会话总成本。']);
    expect(values(summary, '容量').容量占比).toBe('50% (40.0k / 80.0k)');
  });
  it('never treats missing or invalid statistics as zero, including aggregate duration', () => {
    const summary = usageOne(usage({ budget: {}, turnCount: undefined, calibrationFactor: undefined, subUsages: [
      { index: 1, description: '缺统计', status: 'succeeded' },
      { index: 2, tokens: 0, toolUses: 0, durationMs: 0 },
    ] }));
    expect(values(summary, '容量')).toEqual({ 容量占比: '未知 (未知 / 未知)', 有效容量: '未知 tokens', 标称上下文窗口: '未知 tokens', 会话轮次: '未知 轮' });
    expect(values(summary, '子任务合计')).toEqual({ 子任务总计: '未知 tokens', 工具调用合计: '未知 次', 耗时合计: '未知' });
    expect(section(summary, '子任务（2 个）').rows).toEqual([
      { label: '#1', value: '✓ 成功 · 未知 tokens · 工具调用 未知 次 · 耗时 未知', note: '缺统计' },
      { label: '#2', value: '状态未知 · 0 tokens · 工具调用 0 次 · 耗时 0ms', note: '未命名' },
    ]);
    const malformed = JSON.stringify(usageOne(usage({ budget: { ...budget, currentTokens: NaN, usageRatio: -1 }, subUsages: [{ tokens: Infinity, toolUses: -1, durationMs: NaN }] })));
    expect(malformed).not.toMatch(/NaN|Infinity|-1%/u); expect(malformed).toContain('未知');
  });
  it('takes the threshold ratios from the host constants and marks reached tiers only by the host status', () => {
    const normal = informationContextSummary(budget);
    expect(normal.lead).toEqual([[{ text: '50%', tone: 'accent' }, { text: ' · 40.0k / 80.0k tokens' }]]);
    expect(values(normal, '容量')).toEqual({ 有效上下文容量: '80.0k tokens', 当前估算: '40.0k tokens', 容量占比: '[██████████░░░░░░░░░░] 50%' });
    expect(section(normal, '阈值').rows).toEqual([
      { label: '预警 (75%)', value: '60.0k tokens' }, { label: '压缩 (85%)', value: '68.0k tokens' }, { label: '上限 (95%)', value: '76.0k tokens' }]);
    expect(section(normal, '阈值').notes).toBeUndefined();
    // 占比已超过预警线，但宿主给的状态仍是 normal：不在呈现层重新判断
    expect(section(informationContextSummary({ ...budget, usageRatio: 0.8 }), '阈值').rows!.every(row => row.tone === undefined)).toBe(true);
    const compact = section(informationContextSummary({ ...budget, usageRatio: 0.5, status: 'compact' }), '阈值');
    expect(compact.rows!.map(row => [row.value, row.tone])).toEqual([['60.0k tokens · 已达到', 'warn'], ['68.0k tokens · 已达到', 'warn'], ['76.0k tokens', undefined]]);
    expect(compact.notes).toEqual(['提示：使用 /compact 手动触发压缩。']);
    expect(section(informationContextSummary({ ...budget, status: 'warning' }), '阈值').rows!.filter(row => row.tone === 'warn')).toHaveLength(1);
    const overloaded = informationContextSummary({ ...budget, usageRatio: 1.25, status: 'critical' });
    expect(values(overloaded, '容量').容量占比).toBe(`[${'█'.repeat(20)}] 125%`);
    expect(section(overloaded, '阈值').rows!.filter(row => row.tone === 'warn')).toHaveLength(3);
    const unknown = informationContextSummary({});
    expect(unknown.lead).toEqual([[{ text: '容量占比：未知' }]]);
    expect(values(unknown, '容量').容量占比).toBe('未知');
    expect(values(informationContextSummary({ ...budget, usageRatio: 0 }), '容量').容量占比).toBe(`[${'░'.repeat(20)}] 0%`);
  });
  it('renders each compression result and puts mechanical truncation cost before success', () => {
    expect(informationCompactLines({ modified: false })).toEqual(['已无可压缩内容。']);
    expect(text(informationCompactLines({ modified: true, tokensBefore: 82_000, tokensAfter: 12_000 }))).toContain('82.0k → 12.0k');
    // 与 /usage 同一格式：剩余几百 token 时如实显示，不取整成 0k
    expect(text(informationCompactLines({ modified: true, tokensBefore: 10_300, tokensAfter: 240 }))).toContain('10.3k → 240 tokens');
    expect(text(informationCompactLines({ modified: true, tokensAfter: 0 }))).toContain('窗口已折叠');
    const emergency = informationCompactLines({ modified: true, tokensBefore: 20_000, tokensAfter: 0,
      emergencyFloor: { droppedTurns: 7, priorContext: 'removed', error: 'summary parser returned empty triplet' } });
    // 先原因、再代价，结果只报容量变化，不接“压缩完成”；内部英文原因换成用户语言
    expect(emergency[0]).toBe('⚠ 未能生成摘要：模型没有按要求返回摘要。');
    expect(emergency[1]).toBe('已改为机械截断：较早的 7 轮对话、此前的摘要或恢复内容已移出模型上下文；完整原文仍在对话历史中。');
    expect(emergency[2]).toBe('上下文 20.0k → 0 tokens。');
    expect(text(emergency)).not.toContain('压缩完成'); expect(text(emergency)).not.toContain('summary parser');
    // 替换的只是先前的截断说明：不报新的内容损失
    const again = informationCompactLines({ modified: true, tokensBefore: 9_000, tokensAfter: 8_000,
      emergencyFloor: { droppedTurns: 0, priorContext: 'already-truncated', error: 'summary parser returned empty triplet' } });
    expect(again[1]).toBe('已改为机械截断：更早的对话此前已截断；完整原文仍在对话历史中。');
    expect(text(again)).not.toContain('摘要或恢复内容');
  });
  it('separates an unfinished compression from nothing to compress and maps known model failures', () => {
    expect(informationCompactLines({ modified: false, failure: { error: 'summary parser returned empty triplet' } }))
      .toEqual(['⚠ 压缩未完成：模型没有按要求返回摘要。', '当前上下文已保留，可稍后重试。']);
    expect(text(informationCompactLines({ modified: false, failure: { error: 'fetch failed' } })))
      .toContain('无法连接模型服务：请检查网络、代理或服务地址后重试。');
    // 未知原因按现行规则保留原文
    expect(text(informationCompactLines({ modified: false, failure: { error: 'odd upstream state' } }))).toContain('odd upstream state');
    expect(text(informationCompactLines({ modified: false, failure: { error: 'fetch failed' } }))).not.toContain('已无可压缩内容');
  });
  it('removes terminal and directional controls while retaining Chinese, emoji and line structure', () => {
    const rendered = informationText('\x1b[31m中文👩‍💻\x1b[0m\r\n下一行\x1b]0;title\x07‮\x00');
    expect(rendered).toContain('中文👩‍💻\n下一行'); expect(rendered).not.toMatch(/[\x1b\x00‮]/u); expect(rendered).not.toContain('title');
    const note = section(usageOne(usage({ subUsages: [{ description: 'A\nB\x1b[2J', tokens: 0 }] })), '子任务（1 个）').rows![0]!.note;
    expect(note).toBe('A B'); expect(text(summaryLines(usageOne(usage())))).not.toMatch(/[\x00-\x08\x1b]/u);
  });
  it('bounds raw projections, and pages long subtask lists so every row stays reachable within the overall capacity', () => {
    expect(() => informationModelLines({ model: 'm'.repeat(2 * 1024 * 1024), providerId: 'p' })).toThrow('容量');
    expect(() => informationLines(['x'.repeat(256 * 1024)])).toThrow('容量');
    const subUsages = (length: number) => Array.from({ length }, (_, index) => ({ index: index + 1, description: '子任务'.repeat(30), tokens: 1, toolUses: 0, status: 'succeeded' as const }));
    const rowsOf = (pages: ReturnType<typeof informationUsageSummary>) => pages.flatMap(page => page.sections).filter(item => item.title.startsWith('子任务（')).flatMap(item => item.rows ?? []);
    const many = informationUsageSummary(usage({ subUsages: subUsages(2500) }));
    expect(many.length).toBeGreaterThan(1);
    expect(rowsOf(many)).toHaveLength(2500); expect(rowsOf(many).at(-1)!.label).toBe('#2500');
    expect(JSON.stringify(many)).not.toContain('未能显示');
    expect(many.at(-1)!.sections.at(-1)).toMatchObject({ title: '子任务合计', notes: ['子任务合计仅覆盖这些任务，不是全会话总成本。'] });
    // 原有的整体边界照旧：用量投影本身超过 1 MiB 时明确失败，不静默裁掉
    expect(() => informationUsageSummary(usage({ subUsages: subUsages(6000) }))).toThrow('容量');
  });
});
