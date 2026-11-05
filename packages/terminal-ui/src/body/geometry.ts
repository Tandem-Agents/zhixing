import type { BodyRenderBlock } from './layout.js';
import { spacing } from '../theme.js';

/** 普通正文（用户、助手、思考等的段落、标题、引用、列表）按词断行：中文句末标点不落到行首、英文整词换行，
 * 超出一行的连续串由原生折行自动逐字断开；代码、表格与工具/材料/过程输出逐字断行，保留原有列对齐。
 * 显示与测量共用此结果，复制仍取源文本。 */
export function bodyWrapMode(block: BodyRenderBlock): 'word' | 'char' {
  if (!['paragraph', 'heading', 'quote', 'list'].includes(block.node.kind)) return 'char';
  return /^(tool|material|process)/u.test(block.role) ? 'char' : 'word';
}

/**
 * 表格分栏：只由可见表头标签与可用宽度决定，不读数据行，所以首次只有表头时就能画出，跨页、分片、
 * 历史重开都得到同一组列宽。每列 = 空格 + 内容 + 空格 + 竖线，整表最左再加一条竖线。
 * 每列至少容得下自己的表头（超长表头按平均宽封顶、在列内折行），剩余宽度平均分配、余数按列序补足；
 * 任一列分到的宽度不足 BODY_TABLE_READABLE 格（约 5 个汉字）时改用带列名的窄布局：
 * 窄列里一格长文字会折成十几行、相邻列大片空白，不如纵排易读。labelWidth 用正文的原生测量（与折行、绘制、选区同源）。
 */
export const BODY_TABLE_READABLE = 10;
export function bodyTableGeometry(labels: readonly string[], columns: number, bodyWidth: number, labelWidth: (text: string) => number):
  { readonly stacked: boolean; readonly widths: readonly number[]; readonly width: number } {
  const frame = 1 + 3 * columns, room = bodyWidth - frame, stacked = { stacked: true, widths: [], width: bodyWidth };
  if (columns < 1 || room < columns * BODY_TABLE_READABLE) return stacked;
  const cap = Math.floor(room / columns);
  const minimum = Array.from({ length: columns }, (_, i) => Math.min(cap, Math.max(3, labelWidth(labels[i] ?? ''))));
  const spare = room - minimum.reduce((sum, value) => sum + value, 0);
  const share = Math.floor(spare / columns), rest = spare % columns;
  const widths = minimum.map((value, i) => value + share + (i < rest ? 1 : 0));
  if (Math.min(...widths) < BODY_TABLE_READABLE) return stacked;
  return { stacked: false, widths, width: frame + widths.reduce((sum, value) => sum + value, 0) };
}

/** 表格横线：left、join、right 为端点与交点，fill 为线身；widths 为各列内容宽（两侧各加 1 格内边距） */
export function bodyTableRule(widths: readonly number[], left: string, join: string, right: string, fill: string): string {
  return left + widths.map(width => fill.repeat(width + 2)).join(join) + right;
}

/** Content columns, excluding the shared viewport inset/track. The same result
 * drives native measurement and drawing; copy retains original source offsets. */
export function bodyBlockGeometry(block: BodyRenderBlock, width: number) {
  const indent = ['list', 'quote'].includes(block.node.kind) ? Math.min(12, block.node.depth ?? 0) * spacing.nested : 0;
  const marked = block.node.anchor || ['assistant', 'thinking', 'tool', 'tool-action', 'tool-error', 'tool-diff', 'material', 'process'].includes(block.role);
  const leading = Math.min(Math.max(0, width - indent - 1), block.role === 'user' ? spacing.userInner : marked ? spacing.marker : 0);
  const trailing = block.role === 'user' ? Math.min(spacing.userInner, Math.max(0, width - indent - leading - 1)) : 0;
  const decoration = block.node.decoration?.length ?? 0;
  const bodyWidth = Math.max(1, width - indent - leading - trailing);
  return { indent, leading, trailing, decoration, bodyWidth, textWidth: Math.max(1, bodyWidth - decoration) };
}
