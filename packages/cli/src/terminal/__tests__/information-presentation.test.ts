import { describe, expect, it } from 'vitest';
import { informationCompactLines, informationContextLines, informationLines, informationModelLines,
  informationText, informationUsageLines, type TerminalUsageProjection } from '../information-presentation.js';

const budget = { currentTokens: 40_000, effectiveWindow: 80_000, contextWindow: 100_000, usageRatio: 0.5, status: 'normal' } as const;
const usage = (change: Partial<TerminalUsageProjection> = {}): TerminalUsageProjection => ({ budget, turnCount: 4, calibrationFactor: 1, subUsages: [], ...change });
const text = (lines: readonly string[]) => lines.join('\n');

describe('terminal information presentation', () => {
  it('displays only the supplied current model projection, including unconfigured state', () => {
    expect(informationModelLines({ model: 'model-a', providerId: 'provider-a' })).toEqual(['Model: model-a', 'Provider: provider-a']);
    expect(informationModelLines({ model: '', providerId: '' })).toEqual(['Model: (未配置)', 'Provider: (未配置)']);
  });
  it('distinguishes request capacity, effective window, nominal window and optional calibration', () => {
    const rendered = text(informationUsageLines(usage()));
    expect(rendered).toContain('50% (40.0k / 80.0k)'); expect(rendered).toContain('标称上下文窗口：100.0k');
    expect(rendered).toContain('会话轮次：4'); expect(rendered).toContain('1.000（未校准）');
    expect(rendered).toContain('不是累计消耗或费用'); expect(rendered).not.toContain('子任务总计');
    expect(text(informationUsageLines(usage({ calibrationFactor: 1.125 })))).toContain('1.125（已校准）');
    expect(text(informationUsageLines(usage({ calibrationFactor: undefined })))).not.toContain('估算校准');
  });
  it('keeps successful, failed and aborted subtask costs separate from the main estimate', () => {
    const rendered = text(informationUsageLines(usage({ subUsages: [
      { index: 1, description: '搜集资料', status: 'succeeded', tokens: 1200, toolUses: 2, durationMs: 800, subId: 'first' },
      { index: 2, description: '读取失败', status: 'failed', tokens: 2300, toolUses: 3, durationMs: 1500 },
      { index: 3, description: '用户中止', status: 'aborted', tokens: 0, toolUses: 0, durationMs: 60_000 },
    ] })));
    for (const expected of ['#1 ✓ 成功', '#2 ⚠ 失败', '#3 ⏵ 中止', 'sub first', '子任务总计：3.5k tokens', '工具调用合计：5 次', '耗时合计：1m 2s', '不是全会话总成本']) expect(rendered).toContain(expected);
    expect(rendered).toContain('50% (40.0k / 80.0k)');
  });
  it('never treats missing or invalid statistics as zero, including aggregate duration', () => {
    const rendered = text(informationUsageLines(usage({ budget: {}, turnCount: undefined, calibrationFactor: undefined, subUsages: [
      { index: 1, description: '缺统计', status: 'succeeded' },
      { index: 2, tokens: 0, toolUses: 0, durationMs: 0 },
    ] })));
    for (const expected of ['容量占比：未知', '有效容量：未知', '会话轮次：未知', '子任务总计：未知', '工具调用合计：未知', '耗时合计：未知', '0 tokens', '耗时：0ms']) expect(rendered).toContain(expected);
    const malformed = text(informationUsageLines(usage({ budget: { ...budget, currentTokens: NaN, usageRatio: -1 }, subUsages: [{ tokens: Infinity, toolUses: -1, durationMs: NaN }] })));
    expect(malformed).not.toMatch(/NaN|Infinity|-1%/u); expect(malformed).toContain('未知');
  });
  it('preserves the context ruler and limits the visible bar without changing an over-capacity percentage', () => {
    const normal = text(informationContextLines(budget));
    expect(normal).toContain('██████████░░░░░░░░░░'); expect(normal).toContain('50%'); expect(normal).not.toContain('/compact');
    for (const [threshold, count] of [['75%', '60.0k'], ['85%', '68.0k'], ['95%', '76.0k']]) expect(normal).toContain(`(${threshold})：${count}`);
    const overloaded = text(informationContextLines({ ...budget, usageRatio: 1.25, status: 'critical' }));
    expect(overloaded).toContain(`[${'█'.repeat(20)}] 125%`); expect(overloaded).toContain('/compact');
    expect(text(informationContextLines({}))).toContain('容量占比：未知');
    expect(text(informationContextLines({ ...budget, usageRatio: 0 }))).toContain(`[${'░'.repeat(20)}] 0%`);
  });
  it('renders each compression result and puts mechanical truncation cost before success', () => {
    expect(informationCompactLines({ modified: false })).toEqual(['已无可压缩内容。']);
    expect(text(informationCompactLines({ modified: true, tokensBefore: 82_000, tokensAfter: 12_000 }))).toContain('82k → 12k');
    expect(text(informationCompactLines({ modified: true, tokensAfter: 0 }))).toContain('窗口已折叠');
    const emergency = informationCompactLines({ modified: true, tokensBefore: 20_000, tokensAfter: 0, emergencyFloor: { droppedTurns: 7, error: 'summary unavailable' } });
    expect(emergency[0]).toContain('摘要服务不可用'); expect(emergency[1]).toContain('7 轮已截断');
    expect(emergency[1]).toContain('完整原文仍在对话历史中'); expect(emergency[2]).toContain('20k → 0k');
  });
  it('removes terminal and directional controls while retaining Chinese, emoji and line structure', () => {
    const rendered = informationText('\x1b[31m中文👩‍💻\x1b[0m\r\n下一行\x1b]0;title\x07\u202e\x00');
    expect(rendered).toContain('中文👩‍💻\n下一行'); expect(rendered).not.toMatch(/[\x1b\x00\u202e]/u); expect(rendered).not.toContain('title');
    expect(text(informationUsageLines(usage({ subUsages: [{ description: 'A\nB\x1b[2J', tokens: 0 }] })))).toContain('A B');
  });
  it('bounds both raw projections and the final retained text, never silently dropping whole rows', () => {
    expect(() => informationModelLines({ model: 'm'.repeat(2 * 1024 * 1024), providerId: 'p' })).toThrow('容量');
    expect(() => informationLines(['x'.repeat(256 * 1024)])).toThrow('容量');
    expect(() => informationUsageLines(usage({ subUsages: Array.from({ length: 2500 }, (_, index) => ({ index, description: '子任务'.repeat(30), tokens: 1, toolUses: 0, status: 'succeeded' })) }))).toThrow('容量');
  });
});
