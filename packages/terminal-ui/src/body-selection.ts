import type { BoxRenderable, CliRenderer, Renderable } from '@opentui/core';

/** A component selection is copyable only while every selected leaf belongs
 * to this mounted body. Drafts, fields, status text and stale pages are excluded. */
export function bodySelection(renderer: Pick<CliRenderer, 'getSelection'>, body: BoxRenderable | undefined) {
  const selection = renderer.getSelection();
  if (!body || body.isDestroyed || !selection || selection.isDragging || !selection.selectedRenderables.length) return;
  for (const leaf of selection.selectedRenderables) {
    if (leaf.isDestroyed) return;
    let parent: Renderable | null = leaf;
    while (parent && parent !== body) parent = parent.parent;
    if (!parent) return;
  }
  return selection;
}
