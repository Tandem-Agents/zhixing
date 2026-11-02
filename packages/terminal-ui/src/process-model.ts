import type { BodyRun } from './body-model.js';
import type { BodyRenderBlock } from './body/layout.js';
/** Pure display values. No run owner, RPC client, native library or task state machine. */
export interface ProcessChildView {
  readonly id: string; readonly parentToolCallId: string; readonly label: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'aborted';
  readonly latestTool?: string; readonly durationMs?: number;
  readonly inputTokens?: number; readonly outputTokens?: number;
}
export interface TerminalProcessView {
  readonly revision: number;
  readonly phase: string;
  readonly activity?: 'running' | 'reconciling' | 'complete';
  readonly durationMs?: number;
  readonly thinking?: { readonly text: string; readonly active: boolean };
  readonly tools: readonly string[];
  readonly children: readonly ProcessChildView[];
  readonly usage: {
    readonly inputTokens?: number; readonly outputTokens?: number;
    readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number;
    readonly contextTokens?: number;
  };
  readonly notice?: string;
}
// Protocol-only consumers validate projections without initializing rendering.
let segmenter: Intl.Segmenter | undefined;
const graphemes = () => segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function processCellWidth(text: string): number {
  if (/^[\p{Mark}\p{Cf}]*$/u.test(text)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F/u.test(text)) return 2;
  const cp = text.codePointAt(0) ?? 0;
  return cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf ||
    cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff ||
    cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 ||
    cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
}
export function cleanProcessText(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\t/gu, ' ');
}
/** Bounded tail, grapheme-safe and display-cell aware. Only two rows retained. */
export function thinkingTail(text: string, columns: number): readonly string[] {
  const width = Math.max(1, Math.min(1000, Math.floor(columns) || 1));
  const rows: string[] = []; let row = '', cells = 0;
  const push = () => { rows.push(row); if (rows.length > 2) rows.shift(); row = ''; cells = 0; };
  for (const { segment } of graphemes().segment(cleanProcessText(text.slice(-8192)))) {
    if (segment === '\n' || segment === '\r\n') { push(); continue; }
    const size = processCellWidth(segment);
    if (cells && cells + size > width) push();
    if (size > width) { if (row) push(); row = '…'; cells = 1; continue; }
    row += segment; cells += size;
  }
  if (row || !rows.length) push();
  return rows;
}
const CLOSING = /^[，。、；：！？）」』】》〉”’,.;:!?)\]}]$/u;
/**
 * 按显示列宽与字素折行，不限行数；首行与续行各带前缀，原文换行另起一行。
 * cell 是单个字素的显示宽度：界面传渲染器自己的测量（含歧义宽度字符），使折行与渲染时的截断同一口径。
 */
export function processWrap(text: string, columns: number, first = '', next = first, cell: (grapheme: string) => number = processCellWidth): readonly string[] {
  const width = Math.max(1, Math.floor(columns) || 1), rows: string[] = [];
  const cellsOf = (value: string) => [...graphemes().segment(value)].reduce((sum, { segment }) => sum + cell(segment), 0);
  let lead = first, room = Math.max(1, width - cellsOf(lead)), row: { text: string; size: number }[] = [], cells = 0;
  const push = (carry: { text: string; size: number }[] = []) => {
    rows.push(lead + row.map(item => item.text).join('')); lead = next; room = Math.max(1, width - cellsOf(lead));
    row = carry; cells = carry.reduce((sum, item) => sum + item.size, 0);
  };
  for (const { segment } of graphemes().segment(cleanProcessText(text.slice(0, 8192).replace(/\r\n?/gu, '\n')))) {
    if (segment === '\n') { push(); continue; }
    const size = cell(segment);
    if (cells && cells + size > room) {
      // 句读等收尾标点不放在行首：把上一行最后一个字素一起带到下一行
      push(CLOSING.test(segment) && row.length > 1 ? row.splice(-1) : []);
    }
    row.push({ text: segment, size }); cells += size;
  }
  if (row.length || !rows.length) push();
  return rows;
}
export function processLine(text: string, columns: number, cell: (grapheme: string) => number = processCellWidth): string {
  const width = Math.max(1, columns); let output = '', used = 0;
  for (const { segment } of graphemes().segment(cleanProcessText(text.slice(0, 8192)).replace(/\n/gu, ' '))) {
    const size = cell(segment); if (used + size > width) break;
    output += segment; used += size;
  }
  return output;
}
export function validateProcessView(value: unknown): value is TerminalProcessView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<TerminalProcessView>;
  const short = (s: unknown, max: number) => typeof s === 'string' && s.length <= max;
  return Number.isSafeInteger(v.revision) && v.revision! >= 0 && short(v.phase, 256) &&
    (v.activity === undefined || ['running', 'reconciling', 'complete'].includes(v.activity)) &&
    (v.durationMs === undefined || Number.isFinite(v.durationMs) && v.durationMs >= 0) &&
    (!v.thinking || short(v.thinking.text, 8192) && typeof v.thinking.active === 'boolean') &&
    Array.isArray(v.tools) && v.tools.length <= 3 && v.tools.every(s => short(s, 1024)) &&
    Array.isArray(v.children) && v.children.length <= 16 && v.children.every(c => c && short(c.id, 1024) &&
      short(c.parentToolCallId, 1024) && short(c.label, 1024) && ['running', 'succeeded', 'failed', 'aborted'].includes(c.status) &&
      (c.latestTool === undefined || short(c.latestTool, 256)) &&
      [c.durationMs, c.inputTokens, c.outputTokens].every(n => n === undefined || typeof n === 'number' && Number.isFinite(n) && n >= 0)) &&
    !!v.usage && typeof v.usage === 'object' && !Array.isArray(v.usage) && Object.values(v.usage).every(n => n === undefined || typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
    (v.notice === undefined || short(v.notice, 1024));
}

/** operation：这一行属于当前操作的说明，且整段说明都已显示 */
export interface ProcessViewRow { readonly text: string; readonly failed?: boolean; readonly status?: boolean; readonly operation?: boolean }
/**
 * operation 是当前操作的说明（结果或未接纳原因、输入是否保留、可采取的下一步），须完整可见：按宽度折行，
 * 优先于子任务、工具、用量、用时等附属信息；整段放不下时不标记已显示，由调用方在别处保留可见说明。
 */
export interface ProcessFeedback { readonly failures?: readonly string[]; readonly details?: readonly string[]; readonly notice?: string; readonly operation?: string; readonly candidateCompressed?: boolean }
export function processViewRows(view: TerminalProcessView, columns: number, height: number, feedback: ProcessFeedback = {},
  cell: (grapheme: string) => number = processCellWidth): readonly ProcessViewRow[] {
  const budget = Math.max(1, Math.min(6, Math.floor(height)));
  const failures = [...new Set([...(feedback.failures ?? []), ...(view.notice ? [view.notice] : [])].filter(Boolean))];
  const complete = view.durationMs !== undefined && view.activity !== 'running' && view.activity !== 'reconciling';
  const tokens = view.usage.contextTokens;
  const context = tokens === undefined ? '' : '  │  ~ ' + (tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : tokens);
  const normal = complete ? '用时 ' + Math.max(1, Math.round(view.durationMs! / 1000)) + 's' + context : view.phase || feedback.notice || '';
  const operation = feedback.operation && !failures.includes(feedback.operation) ? feedback.operation : '';
  // 没有必须的失败、也不在运行时，当前说明就是状态行；否则它紧挨在状态行之上
  const leads = !!operation && !failures.length && view.activity !== 'running' && view.activity !== 'reconciling';
  const rows: ProcessViewRow[] = failures.slice(1).map(text => ({ text, failed: true }));
  if (!complete) for (const text of feedback.details ?? []) rows.push({ text });
  if (view.children.length && (!complete || view.children.some(child => child.status === 'failed' || child.status === 'aborted'))) {
    const count = (status: ProcessChildView['status']) => view.children.filter(c => c.status === status).length;
    const failed = count('failed'), aborted = count('aborted');
    const focus = view.children.find(c => c.status === 'failed') ?? view.children.find(c => c.status === 'running') ?? view.children.at(-1)!;
    rows.push({ text: '子任务 ' + view.children.length + ' · ' + (failed ? failed + '失败 ' : '') + (aborted ? aborted + '中止 ' : '') + count('running') + '运行 ' + count('succeeded') + '完成 · ' + (focus.label || focus.id), failed: !!(failed || aborted) });
  }
  if (!complete) for (const line of view.tools) rows.push({ text: '  ' + line });
  const usage = view.usage, parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push('输入 ' + usage.inputTokens);
  if (usage.outputTokens !== undefined) parts.push('输出 ' + usage.outputTokens);
  if (usage.cacheReadTokens !== undefined) parts.push('缓存命中 ' + usage.cacheReadTokens);
  if (usage.cacheWriteTokens !== undefined) parts.push('缓存写入 ' + usage.cacheWriteTokens);
  if (usage.contextTokens !== undefined) parts.push('上下文估算 ' + usage.contextTokens);
  if (!complete && parts.length) rows.push({ text: parts.join(' · ') });
  // 当前说明占了状态行时，用时退为附属信息，行数够才显示
  if (leads && complete) rows.push({ text: normal });
  // Required failures consume the detail budget before optional tool/usage
  // text; they remain visible when ordinary body space can yield to feedback.
  rows.sort((a, b) => Number(!!b.failed) - Number(!!a.failed));
  const above = operation && !leads ? processWrap(operation, columns, '  ', '  ', cell) : [];
  let hidden = 0, status: readonly string[] = [], shown = false;
  // 隐藏的失败数会改变状态行长度，再算一次即稳定
  for (let pass = 0; pass < 2; pass++) {
    const text = (hidden ? '另' + hidden + '项提示，' + (feedback.candidateCompressed ? 'Esc 收起候选查看' : '放大窗口查看') + ' · ' : '') + (failures[0] ?? (leads ? operation : normal));
    status = leads ? processWrap(text, columns, '◆ ', '  ', cell) : [text ? '◆ ' + text : ''];
    shown = !!operation && status.length + above.length <= budget;
    if (leads && !shown) status = ['◆ ' + text];
    // 放不下的当前说明也计入提示数，状态行告诉用户还有说明以及怎样看到（如收起候选）
    const next = rows.slice(Math.max(0, budget - status.length - (shown ? above.length : 0))).filter(row => row.failed).length + (operation && !leads && !shown ? 1 : 0);
    if (next === hidden) break;
    hidden = next;
  }
  const room = Math.max(0, budget - status.length - (shown ? above.length : 0)), failed = !!failures.length || !!hidden;
  return [
    ...rows.slice(0, room),
    ...(shown ? above.map(text => ({ text, operation: true })) : []),
    ...status.map((text, index) => ({ text, ...(index ? {} : { status: true }), failed, ...(shown && leads ? { operation: true } : {}) })),
  ].map(row => ({ ...row, text: processLine(row.text, columns, cell) }));
}

/** BodyView applies this at its actual text width (currently width - 4).
 * Runs retain original cache source coordinates, including synthetic wraps.
 * No source mutation or another history cache is involved. */
export function processThinkingBodyBlock(block: BodyRenderBlock, columns: number): BodyRenderBlock {
  if (block.role !== 'thinking') return block;
  const width = Math.max(1, Math.floor(columns));
  const rows: { from: number; to: number; text: string }[] = [];
  let from = Math.max(0, block.text.length - 8192), to = from, text = '', cells = 0;
  let omitted = from > 0;
  const push = () => { if (text.trim()) { rows.push({ from, to, text }); if (rows.length > 2) { rows.shift(); omitted = true; } } from = to; text = ''; cells = 0; };
  const tail = block.text.slice(from);
  for (const part of graphemes().segment(tail)) {
    const segment = part.segment, start = block.text.length - tail.length + part.index, end = start + segment.length;
    if (segment === '\n' || segment === '\r\n') { to = start; push(); from = to = end; continue; }
    const size = processCellWidth(segment);
    if (cells && cells + size > width) { to = start; push(); }
    text += size > width ? '…' : segment; cells += Math.min(size, width); to = end;
  }
  if (text || !rows.length) push();
  // The ellipsis occupies a real cell. Drop complete source graphemes from
  // the first visible row instead of adding a third wrapped display row.
  if (omitted && rows.length) {
    const row = rows[0]!;
    let used = [...graphemes().segment(row.text)].reduce((sum, part) => sum + processCellWidth(part.segment), 0);
    while (row.text && used + 1 > width) {
      const first = graphemes().segment(row.text).containing(0)!;
      row.from += first.segment.length; row.text = row.text.slice(first.segment.length); used -= processCellWidth(first.segment);
    }
  }
  const coordinate = (offset: number): number => {
    let position = 0;
    for (const run of block.runs) {
      if (offset <= position + run.text.length) return run.from + Math.min(run.to - run.from, Math.max(0, offset - position));
      position += run.text.length;
    }
    return block.runs.at(-1)?.to ?? block.node.to;
  };
  const runs: BodyRun[] = [];
  for (const [index, row] of rows.entries()) {
    const start = coordinate(row.from), end = coordinate(row.to);
    if (index) runs.push({ from: start, to: start, text: '\n', style: 32 });
    if (!index && omitted) runs.push({ from: start, to: start, text: '…', style: 32 });
    runs.push({ from: start, to: end, text: row.text, style: 32 });
  }
  return { ...block, text: (omitted && rows.length ? '…' : '') + rows.map(row => row.text).join('\n'), runs,
    node: { ...block.node, from: runs[0]?.from ?? block.node.from, to: runs.at(-1)?.to ?? block.node.to, runs } };
}

/** Normalizes only accepted process blocks for the actual BodyView width.
 * Diff lines retain all source characters; U's shared soft wrap owns geometry. */
export function processBodyBlock(block: BodyRenderBlock, columns: number): BodyRenderBlock {
  if (block.role === 'thinking') return processThinkingBodyBlock(block, columns);
  return block;
}

/** U-local colors; never stored in the cache or passed as terminal escapes. */
export function processBodyColor(role: string, _text: string): 'error' | 'brand' | 'dim' | 'success' | undefined {
  if (role === 'tool-error') return 'error';
  if (role === 'tool-action') return 'brand';
  if (role === 'tool') return 'dim';
  if (role === 'tool-diff') return 'dim';
  return undefined;
}
