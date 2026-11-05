import type { TerminalSummary, TerminalSummaryText } from './protocol.js';

/**
 * 信息分节的结构计划：只决定结构（侧注是否与标题同行、标签与值是否成两列、值列宽、阅读宽度），
 * 不自己折行。每段语义文字（页首行、条目串、标签、值、说明、侧注）由组件交给原生文字按词折行：
 * 断行规则与正文一致（英文整词、中文句末标点随前字），复制取源文，不混入软换行与缩进。
 * 宽度按渲染器自己的字素宽度计算。
 */
export const SUMMARY_INDENT = 2;
/** 窄于这个宽度时，标签与值改为上下两行 */
export const SUMMARY_TWO_COLUMN_WIDTH = 60;
/** 阅读宽度上限：很宽的窗口里侧注与条目不被推到屏幕另一端，视线不必横跨整屏 */
export const SUMMARY_READING_WIDTH = 100;

export type SummaryBlock =
  | { readonly kind: 'lead'; readonly spans: readonly TerminalSummaryText[] }
  /** gap：与上方内容之间空一行；asideInline：侧注放得下就与标题同行右对齐，否则在标题下一行 */
  | { readonly kind: 'header'; readonly title: string; readonly aside?: string; readonly asideInline: boolean; readonly gap: boolean }
  /** 并列条目：每项整体排布、按项换行，名称不在中间断开（单项超出整行时才在项内折行） */
  | { readonly kind: 'items'; readonly items: readonly string[] }
  /** stacked：窄屏或标签超过列宽上限时，标签一行、值与说明缩进在下 */
  | { readonly kind: 'row'; readonly label: string; readonly value: string; readonly tone: 'normal' | 'warn'; readonly note?: string; readonly stacked: boolean }
  | { readonly kind: 'note'; readonly text: string };
export interface SummaryPlan {
  /** 内容区宽度（已按阅读宽度上限收窄） */
  readonly width: number;
  /** 两列行里标签列的宽度：整页统一，值从同一列开始 */
  readonly labelColumn: number;
  readonly blocks: readonly SummaryBlock[];
}

type Width = (grapheme: string) => number;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const summaryTextWidth = (text: string, width: Width) => Array.from(segmenter.segment(text), part => part.segment).reduce((sum, grapheme) => sum + width(grapheme), 0);

export function summaryPlan(summary: TerminalSummary, columns: number, width: Width, marker: string): SummaryPlan {
  const content = Math.min(Math.max(1, columns), SUMMARY_READING_WIDTH);
  const markerWidth = summaryTextWidth(marker, width);
  // 标签列宽整页统一；超过上限的长标签单独成行，也不参与列宽，免得一条长命令把其余短标签的值推到很远
  const labelLimit = Math.floor((content - SUMMARY_INDENT) * 0.45);
  const fitting = summary.sections.flatMap(section => section.rows ?? []).map(row => summaryTextWidth(row.label, width)).filter(size => size <= labelLimit);
  const labelColumn = fitting.length ? Math.max(...fitting) : labelLimit;
  const twoColumns = content >= SUMMARY_TWO_COLUMN_WIDTH;
  const blocks: SummaryBlock[] = summary.lead.map(spans => ({ kind: 'lead', spans }));
  for (const section of summary.sections) {
    const asideInline = !!section.aside && markerWidth + summaryTextWidth(section.title, width) + 2 + summaryTextWidth(section.aside, width) <= content;
    blocks.push({ kind: 'header', title: section.title, ...(section.aside ? { aside: section.aside } : {}), asideInline, gap: blocks.length > 0 });
    const items = section.items ?? [], rows = section.rows ?? [];
    if (items.length) blocks.push({ kind: 'items', items });
    for (const row of rows) {
      blocks.push({ kind: 'row', label: row.label, value: row.value, tone: row.tone === 'warn' ? 'warn' : 'normal',
        ...(row.note ? { note: row.note } : {}), stacked: !twoColumns || summaryTextWidth(row.label, width) > labelColumn });
    }
    if (!items.length && !rows.length && section.empty) blocks.push({ kind: 'note', text: section.empty });
    for (const note of section.notes ?? []) blocks.push({ kind: 'note', text: note });
  }
  return { width: content, labelColumn, blocks };
}
