import { stripVTControlCharacters } from 'node:util';
import type { SessionCompactResult, SessionUsageResult } from '@zhixing/rpc/session-wire';
import type { RuntimePrimaryModelDisplayProjection } from '../runtime/runtime-configuration-provider.js';
import { boundedControlProjection } from '../runtime/control-projection.js';
import { DEFAULT_THRESHOLDS } from '@zhixing/core/context';
import type { TerminalSummary, TerminalSummarySection, TerminalSummaryText } from '@zhixing/terminal-ui/protocol';
import { fitSummary, paginateSummary, summaryText } from '../summary-projection.js';

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
  return finish([`模型：${model.model || '(未配置)'}`, `服务商：${model.providerId || '(未配置)'}`]);
}

/** 用量页：容量估算与子任务拆分分区；口径句紧跟数值，原文保留；未知值仍写“未知” */
export function informationUsageSummary(view: TerminalUsageProjection): TerminalSummary[] {
  boundedControlProjection(view, PROJECTION_BYTES);
  const budget = view.budget;
  const sections: TerminalSummarySection[] = [{ title: '容量', rows: [
    { label: '容量占比', value: `${percent(budget.usageRatio)} (${tokens(budget.currentTokens)} / ${tokens(budget.effectiveWindow)})` },
    { label: '有效容量', value: `${tokens(budget.effectiveWindow)} tokens` },
    { label: '标称上下文窗口', value: `${tokens(budget.contextWindow)} tokens` },
    { label: '会话轮次', value: `${number(view.turnCount)} 轮` },
    ...(known(view.calibrationFactor) ? [{ label: '估算校准', value: `${view.calibrationFactor.toFixed(3)}（${view.calibrationFactor === 1 ? '未校准' : '已校准'}）` }] : []),
  ], notes: ['以上是请求容量估算，不是累计消耗或费用。'] }];
  if (view.subUsages?.length) {
    sections.push({ title: `子任务（${view.subUsages.length} 个）`, rows: view.subUsages.map(entry => {
      const status = entry.status === 'succeeded' ? '✓ 成功' : entry.status === 'failed' ? '⚠ 失败' : entry.status === 'aborted' ? '⏵ 中止' : '状态未知';
      const description = label(entry.description ?? '', 100) || '未命名';
      // 警示色作用在值上：状态写在值的开头，失败时文字与颜色一起出现
      return { label: `#${number(entry.index)}`,
        value: `${status} · ${tokens(entry.tokens)} tokens · 工具调用 ${number(entry.toolUses)} 次 · 耗时 ${duration(entry.durationMs)}`,
        note: summaryText(entry.subId ? `${description} · sub ${label(entry.subId, 64)}` : description),
        ...(entry.status === 'failed' ? { tone: 'warn' as const } : {}) };
    }) }, { title: '子任务合计', rows: [
      { label: '子任务总计', value: `${tokens(total(view.subUsages, entry => entry.tokens))} tokens` },
      { label: '工具调用合计', value: `${number(total(view.subUsages, entry => entry.toolUses))} 次` },
      { label: '耗时合计', value: duration(total(view.subUsages, entry => entry.durationMs)) },
    ], notes: ['子任务合计仅覆盖这些任务，不是全会话总成本。'] });
  }
  // 子任务明细随会话增长：按页拆分，整体容量内全部可达，真实超出时写明未能显示的条数
  return paginateSummary([[{ text: '主对话 · 上下文容量估算', tone: 'accent' }]], sections);
}

const BUDGET_LEVEL = { normal: 0, warning: 1, compact: 2, critical: 3 } as const;

/** 上下文页：当前值、比例与阈值分区。阈值比例是宿主计算预算状态所用的同一组常量；
 *  哪一档已达到只看宿主给出的 budget.status，不在这里拿占比重新比较 */
export function informationContextSummary(budget: Budget): TerminalSummary {
  boundedControlProjection(budget, PROJECTION_BYTES);
  const ratio = budget.usageRatio;
  const bar = known(ratio) ? `[${'█'.repeat(Math.min(20, Math.round(ratio * 20)))}${'░'.repeat(20 - Math.min(20, Math.round(ratio * 20)))}] ${percent(ratio)}` : '未知';
  const level = budget.status !== undefined && Object.hasOwn(BUDGET_LEVEL, budget.status) ? BUDGET_LEVEL[budget.status as keyof typeof BUDGET_LEVEL] : 0;
  const tiers = [['预警', DEFAULT_THRESHOLDS.warning, 1], ['压缩', DEFAULT_THRESHOLDS.compact, 2], ['上限', DEFAULT_THRESHOLDS.critical, 3]] as const;
  const lead: TerminalSummaryText[] = known(ratio)
    ? [{ text: percent(ratio), tone: 'accent' }, { text: ` · ${tokens(budget.currentTokens)} / ${tokens(budget.effectiveWindow)} tokens` }]
    : [{ text: '容量占比：未知' }];
  return fitSummary({ lead: [lead], sections: [
    { title: '容量', rows: [
      { label: '有效上下文容量', value: `${tokens(budget.effectiveWindow)} tokens` },
      { label: '当前估算', value: `${tokens(budget.currentTokens)} tokens` },
      { label: '容量占比', value: bar },
    ] },
    { title: '阈值', rows: tiers.map(([name, threshold, rank]) => ({
      label: `${name} (${Math.round(threshold * 100)}%)`,
      value: `${tokens(known(budget.effectiveWindow) ? Math.round(budget.effectiveWindow * threshold) : undefined)} tokens${level >= rank ? ' · 已达到' : ''}`,
      ...(level >= rank ? { tone: 'warn' as const } : {}),
    })), ...(level >= 1 ? { notes: ['提示：使用 /compact 手动触发压缩。'] } : {}) },
  ] }, '信息超过当前展示容量，请缩小请求后重试。');
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
    ? `${tokens(result.tokensBefore)} → ${tokens(result.tokensAfter)} tokens` : '窗口已折叠';
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
