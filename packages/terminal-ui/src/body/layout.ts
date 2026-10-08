import { bodyWindows, visibleBodyText, type BodyAnchor, type BodyNode, type BodyPage, type BodyRun, type BodySegment } from '../body-model.js';

export interface BodyRenderBlock {
  readonly key: string; readonly blockId: string; readonly role: string;
  readonly node: BodyNode; readonly text: string; readonly runs: readonly BodyRun[];
}
/** A wire page replaces its objects, not every native leaf. Reuse only exact
 * current-page projections; the cache cannot retain discarded history. */
export function retainBodyBlocks(next: readonly BodyRenderBlock[], previous: readonly BodyRenderBlock[] = []): readonly BodyRenderBlock[] {
  const old = new Map(previous.map(block => [block.key, block]));
  const result = next.map(block => {
    const prior = old.get(block.key);
    if (prior === block) return block;
    if (!prior || prior.role !== block.role || prior.text !== block.text) return block;
    const { runs: _a, ...a } = block.node, { runs: _b, ...b } = prior.node;
    if (JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(block.runs) !== JSON.stringify(prior.runs)) return block;
    return prior;
  });
  return result.length === previous.length && result.every((block, index) => block === previous[index]) ? previous : result;
}
/** Only current-page nodes are joined. Stable source origin, not screen rows,
 * identifies continuation across producer fragments and width changes. */
export function bodyRenderBlocks(page: BodyPage, cache?: Map<BodySegment, readonly BodyRenderBlock[]>): readonly BodyRenderBlock[] {
  const result: BodyRenderBlock[] = [];
  const windows = bodyWindows(page);
  for (const key of cache?.keys() ?? []) if (!page.segments.includes(key)) cache!.delete(key);
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index]!, segment = page.segments[index]!;
    let projected = cache?.get(segment);
    if (!projected) {
      projected = window.context.nodes.map(node => {
        const runs = node.runs.map(run => ({ ...run, text: visibleBodyText(run.text) }));
        return { key: `${window.blockId}:${node.origin ?? node.from}:${node.kind}`, blockId: window.blockId, role: window.role,
          node, runs, text: runs.map(run => run.text).join('') };
      });
      cache?.set(segment, projected);
    }
    for (const block of projected) {
    const { key, node, runs } = block;
    const previous = result.at(-1);
    if (previous?.key === key && previous.node.to === node.from) {
      const joined = [...previous.runs, ...runs];
      result[result.length - 1] = { ...previous, node: { ...previous.node, to: node.to, runs: joined }, runs: joined,
        text: joined.map(run => run.text).join('') };
    } else result.push(block);
    }
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
