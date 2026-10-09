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
export function processLine(text: string, columns: number): string {
  const width = Math.max(1, columns); let output = '', used = 0;
  for (const { segment } of graphemes().segment(cleanProcessText(text.slice(0, 8192)).replace(/\n/gu, ' '))) {
    const size = processCellWidth(segment); if (used + size > width) break;
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

export interface ProcessViewRow { readonly text: string; readonly failed?: boolean }
export function processViewRows(view: TerminalProcessView, columns: number, height: number): readonly ProcessViewRow[] {
  if (view.durationMs !== undefined && !view.notice && view.activity !== 'reconciling') {
    const tokens = view.usage.contextTokens;
    const context = tokens === undefined ? '' : `  │  ~ ${tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : tokens}`;
    return [{ text: processLine(`◆ 用时 ${Math.max(1, Math.round(view.durationMs / 1000))}s${context}`, columns) }];
  }
  const rows: ProcessViewRow[] = [{ text: processLine(`◆ ${view.notice ?? view.phase}`, columns) }];
  let left = Math.max(0, Math.min(24, Math.floor(height)) - 1);
  const usage = view.usage, parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`输入 ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`输出 ${usage.outputTokens}`);
  if (usage.cacheReadTokens !== undefined) parts.push(`缓存命中 ${usage.cacheReadTokens}`);
  if (usage.cacheWriteTokens !== undefined) parts.push(`缓存写入 ${usage.cacheWriteTokens}`);
  if (usage.contextTokens !== undefined) parts.push(`上下文估算 ${usage.contextTokens}`);
  const reserveUsage = height >= 4 && parts.length ? 1 : 0;
  if (view.thinking?.active) {
    const tail = thinkingTail(view.thinking.text, Math.max(1, columns - 2));
    const count = Math.min(tail.length, Math.max(0, left - reserveUsage));
    if (count) for (const line of tail.slice(-count)) { rows.push({ text: processLine('  ' + line, columns) }); left--; }
  }
  if (view.children.length && left > reserveUsage) {
    const count = (status: ProcessChildView['status']) => view.children.filter(c => c.status === status).length;
    const failed = count('failed'), aborted = count('aborted'), running = count('running'), done = count('succeeded');
    const focus = view.children.find(c => c.status === 'failed') ?? view.children.find(c => c.status === 'running') ?? view.children.at(-1)!;
    // Outcome/counts precede optional description so narrow terminals cannot hide failure.
    const required = `子任务 ${view.children.length} · ${failed ? failed + '失败 ' : ''}${aborted ? aborted + '中止 ' : ''}${running}运行 ${done}完成`;
    rows.push({ text: processLine(required + ` · ${focus.label || focus.id}${focus.latestTool ? ' · ' + focus.latestTool : ''}`, columns),
      ...(failed ? { failed: true } : {}) }); left--;
  }
  const toolCount = Math.min(view.tools.length, Math.max(0, left - reserveUsage));
  if (toolCount) for (const line of view.tools.slice(-toolCount)) { rows.push({ text: processLine('  ' + line, columns) }); left--; }
  if (reserveUsage && left) rows.push({ text: processLine(parts.join(' · '), columns) });
  return rows;
}

/** BodyView applies this at its actual text width (currently width - 4).
 * Runs retain original cache source coordinates, including synthetic wraps.
 * No source mutation or another history cache is involved. */
export function processThinkingBodyBlock(block: BodyRenderBlock, columns: number): BodyRenderBlock {
  if (block.role !== 'thinking') return block;
  const width = Math.max(1, Math.floor(columns));
  const rows: { from: number; to: number; text: string }[] = [];
  let from = Math.max(0, block.text.length - 8192), to = from, text = '', cells = 0;
  const push = () => { rows.push({ from, to, text }); if (rows.length > 2) rows.shift(); from = to; text = ''; cells = 0; };
  const tail = block.text.slice(from);
  for (const part of graphemes().segment(tail)) {
    const segment = part.segment, start = block.text.length - tail.length + part.index, end = start + segment.length;
    if (segment === '\n' || segment === '\r\n') { to = start; push(); from = to = end; continue; }
    const size = processCellWidth(segment);
    if (cells && cells + size > width) { to = start; push(); }
    text += size > width ? '…' : segment; cells += Math.min(size, width); to = end;
  }
  if (text || !rows.length) push();
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
    runs.push({ from: start, to: end, text: row.text, style: 32 });
  }
  return { ...block, text: rows.map(row => row.text).join('\n'), runs,
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
