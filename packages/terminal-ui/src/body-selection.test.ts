import { describe, expect, it, vi } from 'vitest';
import type { BoxRenderable, CliRenderer, Renderable } from '@opentui/core';
import { bodySelection } from './body-selection.js';

describe('body copy selection boundary', () => {
  it('accepts mounted body leaves without reading or retaining their text before copying', () => {
    const body = { isDestroyed: false, parent: null } as unknown as BoxRenderable;
    const first = { isDestroyed: false, parent: body } as unknown as Renderable;
    const second = { isDestroyed: false, parent: { parent: body } } as unknown as Renderable;
    const selection = { isDragging: false, selectedRenderables: [first, second], getSelectedText: vi.fn(() => '中文\ncode') };
    const renderer = { getSelection: () => selection } as unknown as Pick<CliRenderer, 'getSelection'>;
    expect(bodySelection(renderer, body)).toBe(selection);
    expect(selection.getSelectedText).not.toHaveBeenCalled();
  });

  it('rejects mixed field/body selections and selections left behind by disposal', () => {
    const body = { isDestroyed: false, parent: null } as unknown as BoxRenderable;
    const leaf = { isDestroyed: false, parent: body };
    const selected = { isDragging: false, selectedRenderables: [leaf, { isDestroyed: false, parent: null }], getSelectedText: vi.fn() };
    const renderer = { getSelection: () => selected } as unknown as Pick<CliRenderer, 'getSelection'>;
    expect(bodySelection(renderer, body)).toBeUndefined();
    selected.selectedRenderables.pop(); leaf.isDestroyed = true;
    expect(bodySelection(renderer, body)).toBeUndefined();
    expect(selected.getSelectedText).not.toHaveBeenCalled();
  });
});
