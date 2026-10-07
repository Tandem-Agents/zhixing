import { stripVTControlCharacters } from 'node:util';
import type { SessionCompactResult, SessionUsageResult } from '@zhixing/rpc/session-wire';
import type { RuntimePrimaryModelDisplayProjection } from '../runtime/runtime-configuration-provider.js';
import { boundedControlProjection } from '../runtime/control-projection.js';

type Budget = Readonly<Partial<SessionUsageResult['budget']>>;
type SubUsage = Readonly<Partial<SessionUsageResult['subUsages'][number]>>;
export interface TerminalUsageProjection {
  readonly budget: Budget;
  readonly turnCount?: number;
  readonly calibrationFactor?: number;
  readonly subUsages?: readonly SubUsage[];
}
export const INFORMATION_TEXT_BYTES = 256 * 1024;
const PROJECTION_BYTES = 1024 * 1024;
const UNKNOWN = '未知';

/** Plain display only: no terminal, subscriptions, model configuration or meters. */
export function informationText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/gu, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ');
}

export function informationModelLines(model: RuntimePrimaryModelDisplayProjection): readonly string[] {
  boundedControlProjection(model, PROJECTION_BYTES);
  return finish([`Model: ${model.model || '(未配置)'}`, `Provider: ${model.providerId || '(未配置)'}`]);
}

export function informationUsageLines(view: TerminalUsageProjection): readonly string[] {
  boundedControlProjection(view, PROJECTION_BYTES);
  const budget = view.budget;
  const lines = ['主对话 · 上下文容量估算',
    `容量占比：${percent(budget.usageRatio)} (${tokens(budget.currentTokens)} / ${tokens(budget.effectiveWindow)})`,
    `有效容量：${tokens(budget.effectiveWindow)} tokens`,
    `标称上下文窗口：${tokens(budget.contextWindow)} tokens`,
    `会话轮次：${number(view.turnCount)} 轮`];
  if (known(view.calibrationFactor)) lines.push(`估算校准：${view.calibrationFactor.toFixed(3)}（${view.calibrationFactor === 1 ? '未校准' : '已校准'}）`);
  lines.push('以上是请求容量估算，不是累计消耗或费用。');
  if (view.subUsages?.length) {
    lines.push('', `子任务拆分（${view.subUsages.length} 个）`);
    for (const entry of view.subUsages) {
      const status = entry.status === 'succeeded' ? '✓ 成功' : entry.status === 'failed' ? '⚠ 失败' : entry.status === 'aborted' ? '⏵ 中止' : '状态未知';
      lines.push(`#${number(entry.index)} ${status} · ${tokens(entry.tokens)} tokens`,
        `  ${label(entry.description ?? '', 100) || '未命名'}`,
        `  工具调用：${number(entry.toolUses)} 次 · 耗时：${duration(entry.durationMs)}`);
      if (entry.subId) lines.push(`  sub ${label(entry.subId, 64)}`);
    }
    lines.push('', `子任务总计：${tokens(total(view.subUsages, entry => entry.tokens))} tokens`,
      `工具调用合计：${number(total(view.subUsages, entry => entry.toolUses))} 次`,
      `耗时合计：${duration(total(view.subUsages, entry => entry.durationMs))}`,
      '子任务合计仅覆盖这些任务，不是全会话总成本。');
  }
  return finish(lines);
}

export function informationContextLines(budget: Budget): readonly string[] {
  boundedControlProjection(budget, PROJECTION_BYTES);
  const ratio = budget.usageRatio;
  const bar = known(ratio) ? `[${'█'.repeat(Math.min(20, Math.round(ratio * 20)))}${'░'.repeat(20 - Math.min(20, Math.round(ratio * 20)))}] ${percent(ratio)}` : '容量占比：未知';
  const lines = [`有效上下文容量：${tokens(budget.effectiveWindow)} tokens`,
    `当前估算：${tokens(budget.currentTokens)} tokens`, bar, '', '阈值标尺：',
    ...([['预警', 0.75], ['压缩', 0.85], ['上限', 0.95]] as const).map(([name, threshold]) =>
      `${name} (${threshold * 100}%)：${tokens(known(budget.effectiveWindow) ? Math.round(budget.effectiveWindow * threshold) : undefined)} tokens`)];
  if (budget.status === 'warning' || budget.status === 'compact' || budget.status === 'critical') lines.push('', '提示：使用 /compact 手动触发压缩。');
  return finish(lines);
}

export function informationCompactLines(result: SessionCompactResult): readonly string[] {
  boundedControlProjection(result, PROJECTION_BYTES);
  if (typeof result.modified !== 'boolean') throw Error('压缩回执格式不可用。');
  if (!result.modified) return ['已无可压缩内容。'];
  const lines: string[] = [];
  if (result.emergencyFloor) lines.push(
    `⚠ 摘要服务不可用（${label(result.emergencyFloor.error, 512)}）。`,
    `已应急保留最近对话，较早的 ${number(result.emergencyFloor.droppedTurns)} 轮已截断；完整原文仍在对话历史中。`);
  const detail = known(result.tokensBefore) && known(result.tokensAfter)
    ? `${Math.round(result.tokensBefore / 1000)}k → ${Math.round(result.tokensAfter / 1000)}k tokens` : '窗口已折叠';
  lines.push(`✓ 压缩完成，${detail}。`);
  return finish(lines);
}

/** A bounded writer target for the existing configureLogs handler. */
export function informationLines(lines: readonly string[]): readonly string[] { return finish(lines); }

function finish(lines: readonly string[]): readonly string[] {
  let bytes = 0;
  return lines.map(line => {
    bytes += Buffer.byteLength(line) + 64;
    if (bytes > INFORMATION_TEXT_BYTES) throw Error('信息超过当前展示容量，请缩小请求后重试。');
    return informationText(line);
  });
}
function known(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function number(value: number | undefined): string { return known(value) ? String(value) : UNKNOWN; }
function tokens(value: number | undefined): string {
  if (!known(value)) return UNKNOWN;
  if (value < 1000) return String(value);
  return value < 1_000_000 ? `${(value / 1000).toFixed(1)}k` : `${(value / 1_000_000).toFixed(1)}M`;
}
function percent(value: number | undefined): string { return known(value) ? `${Math.round(value * 100)}%` : UNKNOWN; }
function duration(value: number | undefined): string {
  if (!known(value)) return UNKNOWN;
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const seconds = Math.round(value / 1000); return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function total(entries: readonly SubUsage[], pick: (entry: SubUsage) => number | undefined): number | undefined {
  let sum = 0;
  for (const entry of entries) { const value = pick(entry); if (!known(value)) return; sum += value; }
  return known(sum) ? sum : undefined;
}
function label(text: string, limit: number): string {
  const value = informationText(text).replace(/\s+/gu, ' ').trim();
  // A code-point slice keeps surrogate pairs and all original UTF-16 offsets out of the UI protocol.
  const characters = Array.from(value); return characters.slice(0, limit).join('') + (characters.length > limit ? '…' : '');
}
