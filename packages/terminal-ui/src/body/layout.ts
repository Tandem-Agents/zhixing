import { bodyWindows, visibleBodyText, type BodyAnchor, type BodyNode, type BodyPage, type BodyRun } from '../body-model.js';

export interface BodyRenderBlock {
  readonly key: string; readonly blockId: string; readonly role: string;
  readonly node: BodyNode; readonly text: string; readonly runs: readonly BodyRun[];
}
/** Only current-page nodes are joined. Stable source origin, not screen rows,
 * identifies continuation across producer fragments and width changes. */
export function bodyRenderBlocks(page: BodyPage): readonly BodyRenderBlock[] {
  const result: BodyRenderBlock[] = [];
  for (const window of bodyWindows(page)) for (const node of window.context.nodes) {
    const key = `${window.blockId}:${node.origin ?? node.from}:${node.kind}`;
    const previous = result.at(-1);
    const runs = node.runs.map(run => ({ ...run, text: visibleBodyText(run.text) }));
    if (previous?.key === key && previous.node.to === node.from) {
      const joined = [...previous.runs, ...runs];
      result[result.length - 1] = { ...previous, node: { ...previous.node, to: node.to, runs: joined }, runs: joined,
        text: joined.map(run => run.text).join('') };
    } else result.push({ key, blockId: window.blockId, role: window.role, node, runs, text: runs.map(run => run.text).join('') });
  }
  return result;
}
export function renderedToSource(block: BodyRenderBlock, offset: number): BodyAnchor {
  let position = 0;
  for (const run of block.runs) {
    if (offset < position + run.text.length) return { blockId: block.blockId,
      contentOffset: run.text.length === run.to - run.from ? run.from + Math.max(0, offset - position) : run.from };
    position += run.text.length;
  }
  return { blockId: block.blockId, contentOffset: block.runs.at(-1)?.to ?? block.node.from };
}
export function sourceToRendered(block: BodyRenderBlock, anchor: BodyAnchor): number | undefined {
  if (block.blockId !== anchor.blockId || anchor.contentOffset < block.node.from || anchor.contentOffset > block.node.to) return undefined;
  let position = 0;
  for (const run of block.runs) {
    if (anchor.contentOffset <= run.from) return position;
    if (anchor.contentOffset < run.to) return position + (run.text.length === run.to - run.from ? anchor.contentOffset - run.from : 0);
    position += run.text.length;
  }
  return position;
}
export function bodyCell(block: BodyRenderBlock, cell: number): BodyRenderBlock {
  const runs = block.runs.filter(run => run.cell === cell);
  return { ...block, key: `${block.key}:cell:${cell}`, node: { ...block.node,
    from: runs[0]?.from ?? block.node.from, to: runs.at(-1)?.to ?? block.node.from, runs },
    runs, text: runs.map(run => run.text).join('') };
}
