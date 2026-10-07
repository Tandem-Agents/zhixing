/** Content and lifetime only. Geometry belongs to the common information row. */
export interface InformationContent { readonly left: readonly string[]; readonly right: readonly string[] }
export interface InformationSource {
  set(side: 'left' | 'right', id: string, text: string | null): void;
  dispose(): void;
}
export class InformationBoard {
  private readonly entries = new Set<{ scope?: string; left: Map<string, string>; right: Map<string, string> }>();
  private closed = false;
  constructor(private readonly changed: () => void) {}
  source(scope?: string): InformationSource {
    const entry = { scope, left: new Map<string, string>(), right: new Map<string, string>() };
    if (this.closed) return { set() {}, dispose() {} };
    if (this.entries.size >= 32) throw Error('terminal-information-source-limit');
    this.entries.add(entry);
    return {
      set: (side, id, text) => {
        if (!this.entries.has(entry)) return;
        const value = text ? informationText(text).slice(0, 2048) : null;
        if ((entry[side].get(id) ?? null) === value) return;
        if (value === null) entry[side].delete(id);
        else {
          if (!entry[side].has(id) && entry[side].size >= 16) throw Error('terminal-information-block-limit');
          entry[side].set(id, value);
        }
        this.changed();
      },
      dispose: () => { if (this.entries.delete(entry)) this.changed(); },
    };
  }
  snapshot(scope: string): InformationContent {
    const left: string[] = [], right: string[] = [];
    for (const entry of this.entries) if (!entry.scope || entry.scope === scope) {
      left.push(...entry.left.values()); right.push(...entry.right.values());
    }
    return { left, right };
  }
  release(scope: string): void {
    let removed = false;
    for (const entry of this.entries) if (entry.scope === scope) { this.entries.delete(entry); removed = true; }
    if (removed) this.changed();
  }
  dispose(): void { this.closed = true; this.entries.clear(); }
}

export const informationText = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function fitInformation(text: string, width: number, measure: (text: string) => number): string {
  if (width < 1) return '';
  text = informationText(text);
  if (measure(text) <= width) return text;
  if (measure('…') > width) return '';
  let prefix = '';
  for (const { segment } of graphemes.segment(text)) {
    if (measure(prefix + segment + '…') > width) break;
    prefix += segment;
  }
  return prefix + '…';
}

/** Full terminal width in, one bounded row out. Right actions have priority. */
export function informationLayout(content: InformationContent, width: number, measure: (text: string) => number) {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const inset = Math.min(2, Math.max(0, Math.floor((width - 1) / 2)));
  const available = width - 2 * inset;
  const right = fitInformation(content.right.filter(Boolean).join('  '), available, measure);
  const rightWidth = measure(right);
  const left = fitInformation(content.left.filter(Boolean).join('  '), Math.max(0, available - rightWidth - (right ? 2 : 0)), measure);
  return { inset, left, right, rightWidth, gap: Math.max(0, available - measure(left) - rightWidth) };
}
