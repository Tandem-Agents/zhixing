import type { BodyRenderBlock } from './layout.js';
import { spacing } from '../theme.js';

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
