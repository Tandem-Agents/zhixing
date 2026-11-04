import type { BodyRenderBlock } from './layout.js';
import { spacing } from '../theme.js';

/** 普通正文（用户、助手、思考等的段落、标题、引用、列表）按词断行：中文句末标点不落到行首、英文整词换行，
 * 超出一行的连续串由原生折行自动逐字断开；代码、表格与工具/材料/过程输出逐字断行，保留原有列对齐。
 * 显示与测量共用此结果，复制仍取源文本。 */
export function bodyWrapMode(block: BodyRenderBlock): 'word' | 'char' {
  if (!['paragraph', 'heading', 'quote', 'list'].includes(block.node.kind)) return 'char';
  return /^(tool|material|process)/u.test(block.role) ? 'char' : 'word';
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
  const columns = block.node.columns ?? 1, stacked = bodyWidth < columns * 6;
  const cellWidth = Math.max(1, stacked ? bodyWidth : Math.floor(bodyWidth / columns));
  return { indent, leading, trailing, decoration, bodyWidth, textWidth: Math.max(1, bodyWidth - decoration), stacked, cellWidth };
}
