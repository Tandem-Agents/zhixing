import { describe, expect, it } from 'vitest';
import { thinkingTail, processCellWidth, processThinkingBodyBlock, processBodyBlock, processBodyColor, processViewRows, validateProcessView } from './process-model.js';
import { renderedToSource } from './body/layout.js';
describe('pure process presentation', () => {
  it('normalizes thinking boundaries without trimming user source and keeps required feedback above status', () => {
    const block = (text: string) => ({ key: 't', blockId: 't', role: 'thinking', text,
      runs: [{ from: 0, to: text.length, text, style: 0 }], node: { kind: 'paragraph' as const, from: 0, to: text.length, runs: [] } });
    for (const text of ['reason', '\nreason', '\n\nreason\n\n']) expect(processThinkingBodyBlock(block(text), 40).text).toBe('reason');
    expect(processThinkingBodyBlock(block('\n \n'), 40).text).toBe('');
    const view = { revision: 1, phase: '正在回复', activity: 'running' as const, tools: ['tool'], children: [], usage: { inputTokens: 4 }, thinking: { text: 'not in footer', active: true } };
    const rows = processViewRows(view, 80, 6, { failures: ['恢复阻碍', '任务失败'], details: ['当前任务摘要'], notice: '普通通知' });
    expect(rows.at(-1)).toMatchObject({ text: '◆ 恢复阻碍', status: true, failed: true });
    expect(rows[0]!.text).toBe('任务失败');
    expect(rows[1]!.text).toBe('当前任务摘要');
    expect(rows.map(row => row.text).join(' ')).not.toContain('not in footer');
    expect(processViewRows(view, 80, 1, { failures: ['恢复阻碍', '任务失败'], candidateCompressed: true })[0]!.text).toContain('Esc 收起候选查看');
    expect(processViewRows(view, 80, 1, { failures: ['恢复阻碍', '任务失败'] })[0]!.text).toContain('放大窗口查看');
  });
  it('wraps a long failure explanation on the status line instead of cutting it off, and falls back to one row when it cannot fit', () => {
    // Z103：断连时的说明（含“输入与已有内容保留，可重试”）在 100 列下曾被截断
    const text = '启动未完成：配置修改已接纳，保存收尾尚未完成；重新打开配置入口或重启将继续恢复。输入与已有内容保留，可重试。';
    const view = { revision: 1, phase: '', activity: 'complete' as const, tools: [], children: [], usage: {} };
    for (const columns of [96, 40]) {
      const rows = processViewRows(view, columns, 6, { failures: [text], operation: text });
      expect(rows.length).toBeGreaterThan(1);
      expect(rows[0]).toMatchObject({ status: true, failed: true });
      expect(rows.map(row => row.text.replace(/^◆ |^ {2}/u, '')).join('')).toBe(text);
    }
    const tight = processViewRows(view, 40, 1, { failures: [text], operation: text });
    expect(tight).toHaveLength(1);
    expect(tight[0]).toMatchObject({ status: true, failed: true });
  });
  it('keeps failed children ahead of optional details, including after completion', () => {
    const view = { revision: 1, phase: 'complete', activity: 'complete' as const, durationMs: 1000, tools: [],
      children: [{ id: 'child', parentToolCallId: 'parent', label: 'failed task', status: 'failed' as const }], usage: {} };
    const rows = processViewRows(view, 120, 6, { failures: ['display', 'notice gap', 'task'], details: ['optional'] });
    expect(rows.some(row => row.failed && row.text.includes('1失败'))).toBe(true);
    expect(rows.map(row => row.text).join(' ')).not.toContain('另');
    const running = processViewRows({ ...view, activity: 'running' }, 120, 3, { failures: ['display'], details: ['optional1', 'optional2'] });
    expect(running[0]?.text).toContain('1失败');
  });
  it('renders the completed turn as one compact metadata row without concealing a gap', () => {
    const view = { revision: 1, phase: '本轮已结束', durationMs: 8200, tools: [], children: [], usage: { inputTokens: 20, outputTokens: 100, contextTokens: 7300 } };
    expect(processViewRows(view, 80, 6)).toEqual([{ text: '◆ 用时 8s  │  ~ 7.3k', status: true, failed: false }]);
    expect(processViewRows({ ...view, notice: '本轮已结束；正文存在缺口' }, 80, 6)[0]!.text).toContain('正文存在缺口');
    expect(validateProcessView({ ...view, durationMs: Infinity })).toBe(false);
  });
  it('只给有文字的条目分配行：空闲无信息为零行，空摘要、空工具行不占行', () => {
    const idle = { revision: 0, phase: '', activity: 'complete' as const, tools: [], children: [], usage: {} };
    expect(processViewRows(idle, 80, 6)).toEqual([]);
    // 就绪但为空的任务摘要与只有空白的细节都不占行
    expect(processViewRows(idle, 80, 6, { details: ['', '  '] })).toEqual([]);
    // 恢复回执占状态行时，空摘要不在它上方留空行
    expect(processViewRows(idle, 80, 6, { details: [''], operation: '已恢复最近对话。' }).map(row => row.text)).toEqual(['◆ 已恢复最近对话。']);
    const running = processViewRows({ ...idle, phase: '正在处理…', activity: 'running', tools: ['', '读取 a.ts'] }, 80, 6, { details: ['', '整理桌面 (1/3)'] });
    expect(running.map(row => row.text)).toEqual(['整理桌面 (1/3)', '  读取 a.ts', '◆ 正在处理…']);
    // 等待中的持续说明不让位：一次性说明写在它上方，状态行仍是等待说明
    const waiting = processViewRows({ ...idle, phase: '消息已排队，需先处理上次运行结果 · /resolve', activity: 'waiting' }, 80, 6, { operation: '本次运行已中止。' });
    expect(waiting.map(row => row.text)).toEqual(['  本次运行已中止。', '◆ 消息已排队，需先处理上次运行结果 · /resolve']);
  });
  describe('当前操作的说明完整可见', () => {
    const kept = '本次输入未接纳，已保留在输入框；原推进目标保持不变，确认验收标准前不执行原任务；可以补充说明，也可以说“直接执行”或“取消”。';
    const done = { revision: 1, phase: '本轮已结束', durationMs: 2000, tools: [], children: [], usage: { contextTokens: 162 } };
    const idle = { revision: 0, phase: '', activity: 'complete' as const, tools: [], children: [], usage: {} };
    const cells = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].reduce((sum, { segment }) => sum + processCellWidth(segment), 0);
    const joined = (rows: readonly { text: string; operation?: boolean }[]) => rows.filter(row => row.operation).map(row => row.text.replace(/^(◆ |  )/u, '')).join('');
    // 100 列终端：过程区文字宽 96；既有窄窗口 40 列：文字宽 36
    it.each([96, 36])('kept 说明在宽 %i 下按列宽折行、整段可见，并优先于用时', columns => {
      const rows = processViewRows(done, columns, 6, { operation: kept });
      expect(joined(rows)).toBe(kept);
      expect(rows.every(row => cells(row.text) <= columns)).toBe(true);
      const status = rows.findIndex(row => row.status);
      expect(rows[status]!.text.startsWith('◆ 本次输入未接纳')).toBe(true);
      expect(rows.slice(status).every(row => row.operation)).toBe(true);
      // 用时退为附属信息：行数够时在说明之上，不够时让位
      if (rows.length < 6) expect(rows[0]!.text).toContain('用时 2s');
    });
    it('按调用方给的字素宽度折行（真实终端把 ◆ 与弯引号算作两格时不再被渲染截断）', () => {
      const wide = (grapheme: string) => /[◆“”]/u.test(grapheme) ? 2 : processCellWidth(grapheme);
      const width = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].reduce((sum, { segment }) => sum + wide(segment), 0);
      for (const columns of [96, 36]) {
        const rows = processViewRows(done, columns, 6, { operation: kept }, wide);
        expect(joined(rows)).toBe(kept);
        expect(rows.every(row => width(row.text) <= columns)).toBe(true);
      }
      // 句读等收尾标点不在行首
      for (const columns of [96, 36, 20]) {
        expect(processViewRows(done, columns, 6, { operation: kept }, wide).slice(1).every(row => !/^ {2}[，。、；：！？”]/u.test(row.text))).toBe(true);
      }
      // 内置宽度表下 96 列首行恰好放满，按真实终端宽度量会超出一格（渲染器随即从中间省略）；用调用方的测量就不超
      expect(width(processViewRows(done, 96, 6, { operation: kept }).find(row => row.status)!.text)).toBeGreaterThan(96);
      expect(width(processViewRows(done, 96, 6, { operation: kept }, wide).find(row => row.status)!.text)).toBeLessThanOrEqual(96);
    });
    it('候选压缩到一行时不标记已显示（调用方在输入框下保留说明），状态行不藏进“另 N 项提示”', () => {
      const rows = processViewRows(done, 36, 1, { operation: kept, candidateCompressed: true });
      expect(rows).toHaveLength(1);
      expect(rows.some(row => row.operation)).toBe(false);
      expect(rows[0]!.text.startsWith('◆ 本次输入未接纳')).toBe(true);
    });
    it('有必须的失败或正在运行时，说明紧挨状态行之上完整显示，附属信息让位', () => {
      const failed = processViewRows(done, 36, 6, { operation: kept, failures: ['任务状态读取失败'] });
      expect(failed.at(-1)).toMatchObject({ text: '◆ 任务状态读取失败', status: true, failed: true });
      expect(joined(failed)).toBe(kept);
      const running = processViewRows({ ...idle, phase: '正在处理…', activity: 'running', tools: ['读取 a.ts', '读取 b.ts', '读取 c.ts'], usage: { inputTokens: 3 } }, 36, 6, { operation: kept });
      expect(running.at(-1)).toMatchObject({ text: '◆ 正在处理…', status: true });
      expect(joined(running)).toBe(kept);
      expect(running).toHaveLength(6);
    });
    it('长中文与英文、表情混排按字素与显示宽度折行，不拆字素、不超宽', () => {
      const mixed = '推进准则生成失败：模型回复里没有可识别的结构化内容（structured JSON missing）👍🏽；输入已保留，可修改后重试。';
      for (const columns of [20, 36, 96]) {
        const rows = processViewRows(idle, columns, 6, { operation: mixed });
        expect(joined(rows)).toBe(mixed);
        expect(rows.every(row => cells(row.text) <= columns)).toBe(true);
      }
    });
    it('既有窄窗口（40×16，预算 6 行）里与多项失败并存：说明仍完整，放不下的失败汇总成“另 N 项提示”', () => {
      const children = [1, 2, 3].map(index => ({ id: `c${index}`, parentToolCallId: 'p', label: `子任务${index}`, status: 'failed' as const }));
      const rows = processViewRows({ ...done, children }, 36, 6, { operation: kept, failures: ['A 失败', 'B 失败', 'C 失败'] });
      expect(rows).toHaveLength(6);
      expect(joined(rows)).toBe(kept);
      expect(rows.at(-1)!.text).toMatch(/^◆ 另\d+项提示，放大窗口查看 · A 失败/u);
    });
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
    expect(renderedToSource(narrow, 0)).toEqual({ blockId: 'b', contentOffset: 1181 });
    expect(narrow.text.startsWith('…')).toBe(true);
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
    expect(rows.some(row => row.text.includes('输入 0'))).toBe(true);
    expect(rows.at(-1)?.text.startsWith('◆')).toBe(true);
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
