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
/** leftFirst：左侧是当前操作的结果或失败说明时先保证它完整，键位提示用剩下的宽度；否则键位优先，左侧占位说明用剩下的 */
export function informationLayout(content: InformationContent, width: number, measure: (text: string) => number, leftFirst = false) {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const inset = Math.min(2, Math.max(0, Math.floor((width - 1) / 2)));
  const available = width - 2 * inset;
  const leftText = content.left.filter(Boolean).join('  '), rightText = content.right.filter(Boolean).join('  ');
  if (leftFirst && leftText) {
    const left = fitInformation(leftText, available, measure), leftWidth = measure(left);
    const right = fitInformation(rightText, Math.max(0, available - leftWidth - 2), measure), rightWidth = measure(right);
    return { inset, left, right, rightWidth, gap: Math.max(0, available - leftWidth - rightWidth) };
  }
  const right = fitInformation(rightText, available, measure);
  const rightWidth = measure(right);
  const left = fitInformation(leftText, Math.max(0, available - rightWidth - (right ? 2 : 0)), measure);
  return { inset, left, right, rightWidth, gap: Math.max(0, available - measure(left) - rightWidth) };
}

/** 键位项之间的分隔 */
export const KEY_SEPARATOR = ' · ';

/** 键位按整项排布：信息行放得下的最长前缀留在信息行（至少留第一项），其余整项交给候选面板底行；不截半、不丢项 */
export function splitKeys(items: readonly string[], fits: (text: string) => boolean): { info: string; rest: readonly string[] } {
  let count = items.length;
  while (count > 1 && !fits(items.slice(0, count).join(KEY_SEPARATOR))) count--;
  return { info: items.slice(0, count).join(KEY_SEPARATOR), rest: items.slice(count) };
}

/**
 * 候选面板底行：“↓ 更多候选”与放不下信息行的键位共用这一行（面板高度不变）。
 * 放不下时先省“PgUp/PgDn 翻阅”，再把“↓ 更多候选”缩成“↓”；仍放不下（窄于面板管理可用的宽度）时按整项截取，
 * 末尾以“…”表示还有未列出的键位，不把键名截半。
 */
export function candidateFooter(more: boolean, keys: readonly string[], width: number, measure: (text: string) => number): string {
  if (!more && !keys.length) return '';
  const variants = more ? [['↓ 更多候选', 'PgUp/PgDn 翻阅', ...keys], ['↓ 更多候选', ...keys], ['↓', ...keys]] : [[...keys]];
  for (const items of variants) {
    const text = items.join(KEY_SEPARATOR);
    if (measure(text) <= width) return text;
  }
  const items = variants.at(-1)!;
  for (let count = items.length - 1; count >= 1; count--) {
    const text = [...items.slice(0, count), '…'].join(KEY_SEPARATOR);
    if (measure(text) <= width) return text;
  }
  return fitInformation(items[0]!, width, measure);
}
