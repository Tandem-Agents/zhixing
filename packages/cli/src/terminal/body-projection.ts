import { marked, type Links, type Token, type Tokens } from 'marked';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import {
  BODY_FRAGMENT_BYTES, BODY_FRAGMENT_ENCODED_BYTES, BODY_PARSE_BYTES, BODY_PARSE_NODES, BODY_STYLE,
  sliceBodyNodes, validateBodyMetadata, type BodyKind, type BodyNode, type BodyRun, type BodyFragmentMetadata,
} from '@zhixing/terminal-ui/body-model';

export interface BodyAppend {
  readonly kind: 'append'; readonly contentOffset: number; readonly text: string; readonly body: BodyFragmentMetadata;
  /** Parser-proven committed prefix; not part of the surface protocol. */
  readonly stable?: boolean;
}
export interface BodyAmend {
  readonly kind: 'amend'; readonly from: number; readonly to: number; readonly revision: number;
  /** Apply under the existing store's complete operation queue. The caller
   * reads each intersecting original fragment, and CASes its identity/revision
   * when publishing the returned metadata. It never replaces source text. */
  readonly project: (contentOffset: number, sourceLength: number, previous?: BodyFragmentMetadata) => BodyFragmentMetadata;
}
export type BodyProjectionChange = BodyAppend | BodyAmend;
/** Pending inline text can become visible after this source range is stored.
 * Admit its second, rendered copy now, within the same 48 KiB carrier limit. */
function bodyAdmissionBytes(item: BodyAppend): number {
  const quotedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;
  const rendered = item.body.context.nodes.reduce((total, node) => total + node.runs.reduce((bytes, run) => bytes + quotedBytes(run.text), 0), 0);
  return Buffer.byteLength(JSON.stringify(item)) + Math.max(0, quotedBytes(item.text) - rendered);
}
/** Coalesce a confirmed current tail and its next append after all preceding
 * amendments have settled. The store still owns CAS/publication and accounts
 * for both physical versions; metadata-only amend never extends source. */
export function mergeBodyAppends(left: BodyAppend, right: BodyAppend): BodyAppend | undefined {
  if (left.contentOffset + left.text.length !== right.contentOffset || left.body.end || left.body.kind !== right.body.kind ||
      left.body.revision > right.body.revision || Buffer.byteLength(left.text) + Buffer.byteLength(right.text) > BODY_FRAGMENT_BYTES) return undefined;
  const nodes: BodyNode[] = [];
  for (const node of [...left.body.context.nodes, ...right.body.context.nodes]) {
    const previous = nodes.at(-1);
    if (previous && previous.to === node.from && (previous.origin ?? previous.from) === (node.origin ?? node.from) &&
        previous.kind === node.kind && previous.depth === node.depth && previous.language === node.language &&
        previous.table === node.table && previous.columns === node.columns && previous.header === node.header) {
      const runs: BodyRun[] = [];
      for (const part of [...previous.runs, ...node.runs]) {
        const last = runs.at(-1);
        if (last && last.to === part.from && last.style === part.style && last.cell === part.cell && last.href === part.href && last.semantic === part.semantic &&
            last.to - last.from === last.text.length && part.to - part.from === part.text.length) {
          runs[runs.length - 1] = { ...last, to: part.to, text: last.text + part.text };
        } else runs.push(part);
      }
      nodes[nodes.length - 1] = { ...previous, to: node.to, runs, anchor: previous.anchor || node.anchor };
    } else nodes.push(node);
  }
  const item: BodyAppend = { kind: 'append', contentOffset: left.contentOffset, text: left.text + right.text,
    body: { ...right.body, context: { nodes } } };
  if (!validateBodyMetadata(item.body, item.contentOffset, item.text.length) || bodyAdmissionBytes(item) > BODY_FRAGMENT_ENCODED_BYTES) return undefined;
  return item;
}
export class BodyProjectionCapacityError extends Error {
  constructor() { super('terminal-body-projection-capacity'); }
}

interface MappedText { readonly text: string; readonly at: (index: number) => number; readonly linearStart?: number }
interface BodyCheckpoint {
  readonly source: string; readonly start: number; readonly offset: number; readonly revision: number; readonly anchor: boolean;
  readonly fence?: { marker: string; count: number; language: string; origin: number; indent: number; atLineStart: boolean };
  readonly table?: { prefix: string; origin: number };
  readonly links: Links;
}
const identity = (text: string, start: number): MappedText => ({ text, linearStart: start, at: index => start + index });
function sub(input: MappedText, start: number, end: number): MappedText {
  if (input.linearStart !== undefined) return identity(input.text.slice(start, end), input.linearStart + start);
  return { text: input.text.slice(start, end), at: index => input.at(start + index) };
}
/** Marked normalizes CRLF and lone CR before tokenizing. Normalize its working
 * view explicitly, retaining the original coordinate at every removed LF. */
function normalized(input: MappedText): MappedText {
  if (!input.text.includes('\r')) return input;
  const removed: number[] = [];
  let count = 0;
  const text = input.text.replace(/\r\n?/gu, (newline: string, index: number) => {
    if (newline.length === 2) { removed.push(index - count + 1); count++; }
    return '\n';
  });
  return { text, at: index => {
    let lo = 0, hi = removed.length;
    while (lo < hi) { const middle = (lo + hi) >>> 1; if (removed[middle]! <= index) lo = middle + 1; else hi = middle; }
    return input.at(index + lo);
  } };
}
function mappedTokens(tokens: readonly Token[], input: MappedText): MappedText[] {
  const result: MappedText[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const match = mappedToken(input, token, cursor); cursor = match.cursor; result.push(match.value);
  }
  return result;
}
function mappedToken(input: MappedText, token: Token, cursor: number): { value: MappedText; cursor: number } {
  // Marked 18 trims the final list item's whitespace, then its lexer appends
  // '\n' to the preceding token for a one-unit space token, even when that
  // unit was a trailing space/tab. Only this exact raw-token transformation
  // maps to the original horizontal whitespace; inline text is unchanged.
  if (token.type === 'list' && token.raw.endsWith('\n') && /[ \t]$/u.test(input.text)) {
    const from = input.text.length - token.raw.length;
    if (from >= cursor && input.text.slice(from, -1) === token.raw.slice(0, -1)) {
      return { value: { text: token.raw, at: index => input.at(from + index) }, cursor: input.text.length };
    }
  }
  return mappedChild(input, token.raw, cursor);
}
function unresolvedReference(token: Token): boolean {
  if (token.type === 'code' || token.type === 'codespan' || token.type === 'def' || token.type === 'escape') return false;
  if (token.type === 'text' && !(token as Tokens.Text).tokens?.length && token.raw.includes('[')) return true;
  if (token.type === 'list') return (token as Tokens.List).items.some(item => item.tokens.some(unresolvedReference));
  if (token.type === 'table') {
    const table = token as Tokens.Table;
    return [...table.header, ...table.rows.flat()].some(cell => cell.tokens.some(unresolvedReference));
  }
  return ((token as Tokens.Paragraph).tokens ?? []).some(unresolvedReference);
}
function lastLineEnd(text: string): number {
  let end = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/gu)) {
    // A trailing CR can still become the first half of CRLF on the next feed.
    if (match[0] !== '\r' || match.index + 1 < text.length) end = match.index + match[0].length;
  }
  return end;
}
/** Marked removes quote/list indentation before parsing children. Match each
 * logical line in order, keeping a source coordinate for every retained unit. */
function mappedChild(input: MappedText, child: string, cursor = 0): { value: MappedText; cursor: number } {
  const exact = input.text.indexOf(child, cursor);
  if (exact >= 0) return { value: sub(input, exact, exact + child.length), cursor: exact + child.length };
  const ranges: { from: number; to: number; parent: number; explicit?: readonly number[] }[] = [];
  let search = cursor, length = 0;
  for (const line of child.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const needle = line.endsWith('\n') ? line.slice(0, -1) : line;
    let found = input.text.indexOf(needle, search);
    if (found >= 0) {
      ranges.push({ from: length, to: length + needle.length, parent: found }); length += needle.length;
      search = found + needle.length;
    } else {
      // GFM table cells remove escaped pipes before producing inline tokens.
      // Only that known source transformation is skipped, never arbitrary text.
      let match: number[] | undefined, after = search;
      for (let candidate = input.text.indexOf(needle[0] ?? '', search); candidate >= 0 && !match;
        candidate = input.text.indexOf(needle[0] ?? '', candidate + 1)) {
        const positions: number[] = []; let at = candidate;
        for (let i = 0; i < needle.length; i++) {
          if (input.text[at] === '\\' && input.text[at + 1] === '|' && needle[i] === '|') at++;
          if (input.text[at] !== needle[i]) break;
          positions.push(input.at(at)); at++;
        }
        if (positions.length === needle.length) { match = positions; after = at; }
      }
      if (!match) throw Error('terminal-body-source-map');
      ranges.push({ from: length, to: length + needle.length, parent: 0, explicit: match }); length += needle.length; search = after;
    }
    if (line.endsWith('\n')) {
      found = input.text.indexOf('\n', search);
      if (found < 0) throw Error('terminal-body-source-map');
      ranges.push({ from: length, to: ++length, parent: found }); search = found + 1;
    }
  }
  if (ranges.length > BODY_PARSE_NODES) throw new BodyProjectionCapacityError();
  const at = (index: number): number => {
    if (index === child.length) return input.at(search);
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const middle = (lo + hi) >>> 1, range = ranges[middle]!;
      if (index < range.from) hi = middle - 1;
      else if (index >= range.to) lo = middle + 1;
      else return range.explicit?.[index - range.from] ?? input.at(range.parent + index - range.from);
    }
    throw Error('terminal-body-source-map');
  };
  return { value: { text: child, at }, cursor: search };
}
function run(input: MappedText, text: string, style = 0): BodyRun {
  return { from: input.at(0), to: input.at(input.text.length), text, style };
}
function mappedRuns(input: MappedText, text: string, style = 0): BodyRun[] {
  if (text.length !== input.text.length) return [run(input, text, style)];
  // Ordinary source and all exact slices retain affine coordinates. Avoid a
  // chain of mapping calls for every character; transformed source still uses
  // the precise CRLF/indent/tab/escape mapping below.
  if (input.linearStart !== undefined) return [{ from: input.linearStart, to: input.linearStart + text.length, text, style }];
  const result: BodyRun[] = [];
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    if (end < text.length && input.at(end) === input.at(start)) {
      // A lexer-expanded tab is one source unit and one replacement run.
      // Giving each rendered space that same range would overlap selection.
      while (end < text.length && input.at(end) === input.at(start)) end++;
    } else {
      while (end < text.length && input.at(end) === input.at(end - 1) + 1 &&
          (end + 1 === text.length || input.at(end + 1) !== input.at(end))) end++;
    }
    result.push({ from: input.at(start), to: input.at(end - 1) + 1, text: text.slice(start, end), style });
    start = end;
  }
  return result;
}
/** Match the fixed Marked list tokenizer's tab rules before matching its
 * dedented item.text: tab stops on the first line, four spaces on subsequent
 * dedented lines, and unchanged tabs on lazy continuation lines. */
function listContents(input: MappedText, child: string): MappedText {
  const bullet = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))/u.exec(input.text)?.[0];
  if (!bullet) throw Error('terminal-body-source-map');
  const expansions: { from: number; to: number; source: number; extra: number }[] = [];
  let text = '', source = 0, extra = 0, indent = bullet.length + 1, first = true;
  for (const line of input.text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const leading = /^[ \t]*/u.exec(line)![0];
    const leadingWidth = leading.replace(/\t/gu, '    ').length;
    const expand = first || leadingWidth >= indent || !line.trim();
    let column = 0;
    for (const character of line) {
      if (character === '\t' && expand) {
        const width = first ? 4 - (column % 4) : 4;
        if (expansions.length >= BODY_PARSE_NODES) throw new BodyProjectionCapacityError();
        const from = text.length; text += ' '.repeat(width); extra += width - 1;
        expansions.push({ from, to: text.length, source, extra }); column += width;
      } else { text += character; column++; }
      source += character.length;
    }
    if (first) {
      const content = text.slice(bullet.length), offset = content.search(/\S/u);
      indent = bullet.length + (offset < 0 || offset > 4 ? 1 : offset);
      first = false;
    }
  }
  if (Buffer.byteLength(text) > BODY_PARSE_BYTES) throw new BodyProjectionCapacityError();
  const expanded: MappedText = { text, at: index => {
    let lo = 0, hi = expansions.length;
    while (lo < hi) { const middle = (lo + hi) >>> 1; if (expansions[middle]!.from <= index) lo = middle + 1; else hi = middle; }
    const expansion = expansions[lo - 1];
    return input.at(expansion && index < expansion.to ? expansion.source : index - (expansion?.extra ?? 0));
  } };
  return mappedChild(expanded, child, Math.min(indent, text.length)).value;
}
function codeIndent(input: MappedText, indent: number, atLineStart = true): MappedText {
  if (!indent) return input;
  const text = input.text.replace(new RegExp(`^ {1,${indent}}`, 'gmu'), (spaces, index: number) => index === 0 && !atLineStart ? spaces : '');
  return mappedChild(input, text).value;
}
function inlines(tokens: readonly Token[], input: MappedText, style = 0, depth = 0): BodyRun[] {
  if (depth > 64) throw new BodyProjectionCapacityError();
  const result: BodyRun[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const match = mappedChild(input, token.raw, cursor); cursor = match.cursor;
    const source = match.value;
    if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
      const flag = token.type === 'strong' ? BODY_STYLE.bold : token.type === 'em' ? BODY_STYLE.italic : BODY_STYLE.strike;
      const typed = token as Tokens.Strong;
      const inner = mappedChild(source, typed.text, token.type === 'em' ? 1 : 2).value;
      result.push(...inlines(typed.tokens, inner, style | flag, depth + 1));
    } else if (token.type === 'link') {
      const link = token as Tokens.Link;
      const href = /[\u0000-\u001f\u007f-\u009f]/u.test(link.href) ? undefined : link.href;
      result.push(...inlines(link.tokens, mappedChild(source, link.text).value, style | BODY_STYLE.link, depth + 1).map(part => ({ ...part, href })));
    } else if (token.type === 'codespan') {
      const code = token as Tokens.Codespan;
      const ticks = /^`+/u.exec(source.text)?.[0].length ?? 1;
      let inner = sub(source, ticks, Math.max(ticks, source.text.length - ticks));
      if (inner.text.length === code.text.length + 2 && inner.text.startsWith(' ') && inner.text.endsWith(' ')) inner = sub(inner, 1, inner.text.length - 1);
      result.push(...mappedRuns(inner, code.text, style | BODY_STYLE.code));
    } else if (token.type === 'br') result.push(run(source, '\n', style));
    else if (token.type === 'text' || token.type === 'escape') {
      const text = token as Tokens.Text;
      if (text.tokens?.length) result.push(...inlines(text.tokens, source, style, depth + 1));
      else result.push(...mappedRuns(source, text.text, style));
    } else result.push(run(source, token.raw, style));
    if (result.length > BODY_PARSE_NODES) throw new BodyProjectionCapacityError();
  }
  return result;
}

function blocks(tokens: readonly Token[], input: MappedText, depth = 0, quote = false, open = false): BodyNode[] {
  if (depth > 64) throw new BodyProjectionCapacityError();
  const result: BodyNode[] = [];
  let cursor = 0, count = 0;
  for (const token of tokens) {
    const before = result.length;
    const match = mappedToken(input, token, cursor); cursor = match.cursor;
    const source = match.value, from = source.at(0), to = source.at(source.text.length);
    if (token.type === 'blockquote') {
      const value = token as Tokens.Blockquote;
      result.push(...blocks(value.tokens, mappedChild(source, value.text).value, depth + 1, true, open && token === tokens.at(-1)));
    } else if (token.type === 'list') {
      let itemCursor = 0;
      for (const item of (token as Tokens.List).items) {
        const found = mappedChild(source, item.raw, itemCursor); itemCursor = found.cursor;
        const content = listContents(found.value, item.text);
        let lo = 0, hi = found.value.text.length;
        while (lo < hi) { const middle = (lo + hi) >>> 1; if (found.value.at(middle) < content.at(0)) lo = middle + 1; else hi = middle; }
        const marker = sub(found.value, 0, lo);
        const nested = blocks(item.tokens, content, depth + 1, quote);
        if (nested.length) {
          const first = nested[0]!;
          nested[0] = { ...first, kind: 'list', from: found.value.at(0), depth,
            runs: [...(marker.text ? [run(marker, marker.text.trimStart(), 0)] : []), ...first.runs] };
        }
        result.push(...nested);
      }
    } else if (token.type === 'code') {
      const code = token as Tokens.Code;
      const opening = /^( {0,3})(`{3,}|~{3,})[^\n]*\n/u.exec(source.text);
      let content: MappedText;
      if (opening) {
        const body = sub(source, opening[0].length, source.text.length);
        const closing = new RegExp(`^ {0,3}${opening[2]![0]}{${opening[2]!.length},}[ \\t]*(?:\\n|$)`, 'mu').exec(body.text);
        content = codeIndent(sub(body, 0, closing?.index ?? body.text.length), opening[1]!.length);
      } else content = mappedChild(source, code.text).value;
      result.push({ from, to, kind: 'code', depth, language: (code.lang ?? '').split(/\s/u)[0]!.slice(0, 128), runs: mappedRuns(content, content.text) });
    } else if (token.type === 'table') {
      const table = token as Tokens.Table;
      if (table.header.length > 128) throw new BodyProjectionCapacityError();
      const rows = [table.header, ...table.rows];
      const lines = source.text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      let lineOffset = 0;
      for (let row = 0; row < rows.length; row++) {
        if (row === 1) lineOffset += lines[1]?.length ?? 0;
        const line = lines[row === 0 ? 0 : row + 1] ?? '';
        const mapped = sub(source, lineOffset, lineOffset + line.length);
        let cellCursor = 0;
        const runs: BodyRun[] = [];
        for (let cell = 0; cell < rows[row]!.length; cell++) {
          const value = rows[row]![cell]!;
          const match = mappedChild(mapped, value.text, cellCursor); cellCursor = match.cursor;
          runs.push(...inlines(value.tokens, match.value, row === 0 ? BODY_STYLE.bold : 0).map(part => ({ ...part, cell })));
        }
        result.push({ from: mapped.at(0), to: mapped.at(mapped.text.length), kind: 'table', table: from,
          columns: table.header.length, header: row === 0,
          labels: table.header.map(cell => cell.text.slice(0, 512)), runs });
        lineOffset += line.length;
      }
    } else if (token.type === 'paragraph' || token.type === 'text' || token.type === 'heading') {
      const text = token as Tokens.Paragraph;
      const inner = mappedChild(source, text.text).value;
      let inlineTokens = text.tokens ?? marked.Lexer.lexInline(text.text);
      if (open && token === tokens.at(-1) && token.type === 'paragraph') {
        const last = inlineTokens.at(-1);
        if (last?.type === 'text') {
          const pending = /(?<![\w\\])(?:\*{1,2}|_{1,2}|~~|`+)(?=\S)|(?<!\\)\[[^\]]*$/u.exec(last.raw);
          if (pending) inlineTokens = [...inlineTokens.slice(0, -1), { type: 'text', raw: last.raw.slice(0, pending.index), text: last.raw.slice(0, pending.index) }];
        }
      }
      result.push({ from, to, kind: token.type === 'heading' ? 'heading' : quote ? 'quote' : 'paragraph',
        depth: token.type === 'heading' ? (token as Tokens.Heading).depth : depth,
        runs: inlines(inlineTokens, inner, token.type === 'heading' ? BODY_STYLE.bold : 0) });
    } else if (token.type === 'def') { /* Reference definitions are source, not visible prose. */ }
    else if (token.type === 'hr') result.push({ from, to, kind: 'rule', runs: [] });
    else if (token.type === 'space') result.push({ from, to, kind: 'space', runs: [] });
    else result.push({ from, to, kind: quote ? 'quote' : 'paragraph', depth, runs: [run(source, source.text)] });
    for (let index = before; index < result.length; index++) count += 1 + result[index]!.runs.length;
    if (count > BODY_PARSE_NODES) throw new BodyProjectionCapacityError();
  }
  return result;
}

/** Existing marked grammar, finite unstable suffix. Committed preceding blocks
 * are dropped, not accumulated in the UI or a second transcript repository. */
export class TerminalBodyProjection {
  readonly kind: BodyKind;
  #source = ''; #start = 0; #offset = 0; #revision = 0; #ended = false; #active = false; #anchor = false;
  #fence?: { marker: string; count: number; language: string; origin: number; indent: number; atLineStart: boolean };
  #table?: { prefix: string; origin: number };
  #links: Links = Object.create(null) as Links;
  constructor(kind: BodyKind) { this.kind = kind; }
  get retainedBytes(): number { return Buffer.byteLength(this.#source) * 2 + Buffer.byteLength(this.#table?.prefix ?? '') * 2 + (Buffer.byteLength(JSON.stringify(this.#links)) - 2) * 2; }
  get contentOffset(): number { return this.#offset; }
  get stableOffset(): number { return this.#start; }
  checkpoint(): BodyCheckpoint {
    if (this.#active || this.#ended) throw Error('terminal-body-projection-state');
    return { source: Buffer.from(this.#source, 'utf16le').toString('utf16le'), start: this.#start, offset: this.#offset, revision: this.#revision,
      anchor: this.#anchor, fence: this.#fence ? { ...this.#fence } : undefined, table: this.#table ? { ...this.#table } : undefined,
      links: Object.assign(Object.create(null) as Links, this.#links) };
  }
  static resume(kind: BodyKind, checkpoint: BodyCheckpoint): TerminalBodyProjection {
    const value = new TerminalBodyProjection(kind);
    value.#source = checkpoint.source; value.#start = checkpoint.start; value.#offset = checkpoint.offset;
    value.#revision = checkpoint.revision; value.#anchor = checkpoint.anchor; value.#fence = checkpoint.fence ? { ...checkpoint.fence } : undefined;
    value.#table = checkpoint.table ? { ...checkpoint.table } : undefined;
    value.#links = Object.assign(Object.create(null) as Links, checkpoint.links);
    return value;
  }
  dispose(): void { this.#ended = true; this.#source = ''; this.#fence = undefined; this.#table = undefined; this.#links = Object.create(null) as Links; }
  *feed(text: string): Generator<BodyProjectionChange> {
    if (this.#ended || this.#active) throw Error('terminal-body-projection-state');
    this.#active = true;
    let completed = false;
    try {
      for (let position = 0; position < text.length;) {
        // Parse one admitted chunk once. Carrier splitting happens below and
        // must not cause repeated parsing/amendment of the same old suffix.
        let end = Math.min(text.length, position + BODY_FRAGMENT_BYTES);
        const room = BODY_PARSE_BYTES - Buffer.byteLength(this.#source);
        while (end > position && Buffer.byteLength(text.slice(position, end)) > room) end = position + Math.floor((end - position) / 2);
        if (end === position) throw new BodyProjectionCapacityError();
        if (end < text.length && /[\ud800-\udbff]/u.test(text[end - 1]!)) end--;
        if (end === position) throw new BodyProjectionCapacityError();
        const previous = this.#offset;
        const prefix = this.#source, revision = this.#revision;
        const fence = this.#fence ? { ...this.#fence } : undefined, table = this.#table, links = this.#links;
        let part: string, parsed: { nodes: BodyNode[]; stable: number };
        for (;;) {
          part = Buffer.from(text.slice(position, end), 'utf16le').toString('utf16le');
          this.#source = prefix + part; this.#offset = previous + part.length; this.#revision = revision + 1;
          this.#fence = fence ? { ...fence } : undefined; this.#table = table; this.#links = links;
          try { parsed = this.#parse(false); break; }
          catch (error) {
            // Many short paragraphs can exceed the node quantum in a large
            // input chunk. Retry a smaller *unpublished* step, restoring all
            // grammar state. A genuinely overfull retained suffix still fails.
            this.#source = prefix; this.#offset = previous; this.#revision = revision;
            this.#fence = fence ? { ...fence } : undefined; this.#table = table; this.#links = links;
            if (!(error instanceof BodyProjectionCapacityError) || end - position <= 512) throw error;
            end = position + Math.floor((end - position) / 2);
            if (/[\ud800-\udbff]/u.test(text[end - 1]!)) end--;
          }
        }
        const { nodes, stable } = parsed;
        const make = this.#projector(nodes, false);
        if (previous > this.#start) yield { kind: 'amend', from: this.#start, to: previous, revision: this.#revision, project: make };
        for (const fragment of this.#fragments(part, previous, make)) {
          const until = fragment.contentOffset + fragment.text.length;
          // Keep the current final carrier mutable for real logical EOF. A
          // grammar-stable earlier carrier can never be amended again.
          yield { ...fragment, stable: until <= this.#start + stable && until < this.#offset };
        }
        if (stable > 0) {
          this.#anchor ||= nodes.some(node => node.anchor && node.to <= this.#start + stable);
          this.#source = this.#source.slice(stable); this.#start += stable;
        }
        position = end;
      }
      completed = true;
    } finally {
      this.#active = false;
      // A failed or abandoned consumer may have published only a prefix of
      // this revision. Never continue it as though every amendment settled.
      if (!completed) this.dispose();
    }
  }
  #lex(text: string) {
    const lexer = new marked.Lexer();
    lexer.tokens.links = Object.assign(Object.create(null) as Links, this.#links);
    return lexer.lex(text);
  }
  *end(): Generator<BodyProjectionChange> {
    if (this.#ended) return;
    if (this.#active) throw Error('terminal-body-projection-state');
    this.#ended = true; this.#revision++;
    try {
      if (this.#offset) {
        const { nodes } = this.#parse(true);
        yield { kind: 'amend', from: Math.min(this.#start, this.#offset - 1), to: this.#offset, revision: this.#revision, project: this.#projector(nodes, true) };
      }
    } finally { this.dispose(); }
  }
  #parse(end: boolean): { nodes: BodyNode[]; stable: number } {
    if (this.kind === 'plain') return { nodes: [{ from: this.#start, to: this.#offset, origin: 0, kind: 'paragraph',
      runs: [{ from: this.#start, to: this.#offset, text: this.#source, style: 0 }] }], stable: Math.max(0, this.#source.length - 8192) };
    const parsed = this.#fence ? this.#parseFence(end) : this.#table ? this.#parseTable(end) : this.#parseNormal(this.#source, this.#start, end);
    if (parsed.nodes.length + parsed.nodes.reduce((sum, node) => sum + node.runs.length, 0) > BODY_PARSE_NODES) throw new BodyProjectionCapacityError();
    if (!this.#anchor) {
      const paragraph = parsed.nodes.findIndex(node => node.kind === 'paragraph' && node.runs.some(run => run.text.trim()));
      if (paragraph >= 0) parsed.nodes[paragraph] = { ...parsed.nodes[paragraph]!, anchor: true };
    }
    return parsed;
  }
  #parseNormal(text: string, start: number, end: boolean): { nodes: BodyNode[]; stable: number } {
    const source = normalized(identity(text, start));
    const tokens = this.#lex(source.text), tokenSources = mappedTokens(tokens, source);
    const nodes = blocks(tokens, source, 0, false, !end);
    // The last token can change type when a delimiter, table row or EOF arrives.
    // Its predecessor remains available for setext/table lookbehind as well.
    const preceding = tokenSources.at(-3);
    let stable = !end && preceding ? preceding.at(preceding.text.length) - start : 0;
    const last = tokens.at(-1);
    const lastSource = tokenSources.at(-1);
    const reference = tokens.findIndex(unresolvedReference);
    const referenceBoundary = reference >= 0 ? tokenSources[reference]!.at(0) - start : Infinity;
    if (!end && last?.type === 'list' && lastSource) {
      const list = last as Tokens.List;
      if (list.items.length > 1) {
        const final = list.items.at(-1)!;
        const local = last.raw.lastIndexOf(final.raw);
        if (local > 0) stable = Math.max(stable, lastSource.at(local) - start);
      }
    }
    if (!end && referenceBoundary === Infinity && last?.type === 'table' && lastSource) {
      const lines = last.raw.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      const prefix = (lines[0] ?? '') + (lines[1] ?? '');
      if (lines.length >= 2 && Buffer.byteLength(prefix) <= 16 * 1024 &&
          lastSource.at(prefix.length) - start <= lastLineEnd(text)) {
        const origin = lastSource.at(0), until = lastSource.at(prefix.length);
        this.#table = { prefix: text.slice(origin - start, until - start), origin };
        stable = lastLineEnd(text);
      }
    }
    const opening = last?.type === 'code' ? /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/u.exec(last.raw) : null;
    if (!end && referenceBoundary === Infinity && opening && last && lastSource &&
        lastSource.at(opening[0].length) - start <= lastLineEnd(text)) {
      const marker = opening[1]![0]!, count = opening[1]!.length;
      const bodySource = sub(lastSource, opening[0].length, lastSource.text.length), body = bodySource.text;
      const closing = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${count},}[ \\t]*(?:\\r?\\n|$)`, 'mu');
      if (!closing.test(body)) {
        const origin = lastSource.at(0);
        const indent = /^ */u.exec(opening[0])![0].length, content = codeIndent(bodySource, indent);
        const codeIndex = nodes.findIndex(node => node.kind === 'code' && node.from === origin);
        if (codeIndex >= 0) nodes[codeIndex] = { ...nodes[codeIndex]!, origin,
          runs: mappedRuns(content, content.text) };
        stable = lastLineEnd(text);
        this.#fence = { marker, count, language: (last as Tokens.Code).lang?.split(/\s/u)[0]?.slice(0, 128) ?? '', origin, indent, atLineStart: true };
      }
    }
    stable = Math.min(stable, referenceBoundary);
    if (stable > 0) {
      // Only ordinary Markdown contributes definitions. A carried code/table
      // prefix is never reinterpreted as definitions when its following tail
      // becomes stable in this same work step.
      const definitions = new marked.Lexer();
      definitions.tokens.links = Object.assign(Object.create(null) as Links, this.#links);
      // Definitions are block grammar. Running inline tokenization again here
      // would parse all committed visible text a second time on every chunk.
      definitions.blockTokens(normalized(identity(text.slice(0, stable), start)).text);
      const links = definitions.tokens.links;
      if (Object.keys(links).length > BODY_PARSE_NODES || Buffer.byteLength(JSON.stringify(links)) > BODY_PARSE_BYTES) throw new BodyProjectionCapacityError();
      this.#links = links;
    }
    return { nodes, stable };
  }
  #parseTable(end: boolean): { nodes: BodyNode[]; stable: number } {
    const table = this.#table!, prefix = table.prefix, start = this.#start;
    const text = prefix + this.#source;
    const mapped = normalized({ text, at: index => index < prefix.length ? table.origin + index : start + index - prefix.length });
    const tokens = this.#lex(mapped.text), firstSource = mappedTokens(tokens, mapped)[0];
    const tableNodes = blocks(tokens.slice(0, 1), mapped, 0, false, !end).filter(node => node.from >= start);
    const consumed = Math.max(0, firstSource ? firstSource.at(firstSource.text.length) - start : 0);
    // A later reference definition can still restyle an earlier retained row.
    // Keep its original table prefix until that dependency resolves or EOF.
    if (tokens[0] && unresolvedReference(tokens[0])) return { nodes: blocks(tokens, mapped, 0, false, !end).filter(node => node.from >= start), stable: 0 };
    if (tokens.length > 1 || consumed < this.#source.length) {
      this.#table = undefined;
      const tail = this.#parseNormal(this.#source.slice(consumed), start + consumed, end);
      return { nodes: [...tableNodes, ...tail.nodes], stable: consumed + tail.stable };
    }
    return { nodes: tableNodes, stable: end ? 0 : lastLineEnd(this.#source) };
  }
  #parseFence(end: boolean): { nodes: BodyNode[]; stable: number } {
    const fence = this.#fence!;
    // In multiline mode `$` also matches before the next CR. Only a CR at
    // actual input EOF is ambiguous; a following blank line closes the fence.
    const expression = new RegExp(`^ {0,3}${fence.marker === '`' ? '`' : '~'}{${fence.count},}[ \\t]*(?:\\r\\n|\\r${end ? '' : '(?=[\\s\\S])'}|\\n${end ? '|$' : ''})`, 'gmu');
    let closing = expression.exec(this.#source);
    if (closing?.index === 0 && !fence.atLineStart) closing = expression.exec(this.#source);
    const validClose = closing ?? undefined;
    const until = validClose?.index ?? this.#source.length;
    const content = codeIndent(normalized(identity(this.#source.slice(0, until), this.#start)), fence.indent, fence.atLineStart);
    const node: BodyNode = { from: this.#start, to: this.#start + until, origin: fence.origin, kind: 'code', language: fence.language,
      runs: until ? mappedRuns(content, content.text) : [] };
    if (validClose) {
      const after = validClose.index + validClose[0].length;
      this.#fence = undefined;
      const tail = this.#parseNormal(this.#source.slice(after), this.#start + after, end);
      return { nodes: [...(until ? [node] : []), ...tail.nodes], stable: after + tail.stable };
    }
    let stable = lastLineEnd(this.#source);
    if (!stable && !fence.atLineStart) stable = this.#source.length;
    else if (!stable && !/^ {0,3}(?:`*|~*)[ \t]*\r?$/u.test(this.#source)) stable = this.#source.length;
    if (!end && stable === this.#source.length && this.#source.endsWith('\r')) stable--;
    fence.atLineStart = stable > 0 ? /[\r\n]/u.test(this.#source[stable - 1]!) : fence.atLineStart;
    return { nodes: until ? [node] : [], stable: end ? 0 : stable };
  }
  #projector(nodes: readonly BodyNode[], end: boolean): BodyAmend['project'] {
    const revision = this.#revision, kind = this.kind, eof = this.#offset, from = this.#start;
    return (contentOffset, sourceLength, previous) => {
      if ((contentOffset < from && !previous) || (previous && (previous.kind !== kind || previous.revision >= revision))) {
        throw Error('terminal-body-amend-predecessor');
      }
      return { version: 1, revision, kind,
        context: { nodes: [...sliceBodyNodes(previous?.context.nodes ?? [], contentOffset, Math.min(from, contentOffset + sourceLength)),
          ...sliceBodyNodes(nodes, Math.max(contentOffset, from), contentOffset + sourceLength)] },
        end: end && contentOffset + sourceLength === eof };
    };
  }
  *#fragments(text: string, offset: number, project: BodyAmend['project']): Generator<BodyAppend> {
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + BODY_FRAGMENT_BYTES), item: BodyAppend;
      for (;;) {
        if (end < text.length && /[\ud800-\udbff]/u.test(text[end - 1]!)) end--;
        const part = text.slice(start, end);
        item = { kind: 'append', contentOffset: offset + start, text: part, body: project(offset + start, part.length) };
        if (Buffer.byteLength(part) <= BODY_FRAGMENT_BYTES && bodyAdmissionBytes(item) <= BODY_FRAGMENT_ENCODED_BYTES) break;
        if (end - start <= 2) throw new BodyProjectionCapacityError();
        end = start + Math.floor((end - start) / 2);
      }
      yield item; start = end;
    }
  }
}

const pieceEnd = (source: string, start: number) => {
  let end = Math.min(source.length, start + 8192);
  if (end < source.length && /[\ud800-\udbff]/u.test(source[end - 1]!)) end--;
  return end;
};
interface PendingBody { readonly items: BodyAppend[]; bytes: number }
const pendingCost = (item: BodyAppend) => Buffer.byteLength(JSON.stringify(item)) * 2 + 256;
function updatePending(pending: PendingBody, change: BodyProjectionChange, from: number, to: number): void {
  if (change.kind === 'append') {
    if (change.contentOffset >= from && change.contentOffset < to) {
      const cost = pendingCost(change);
      if (pending.items.length >= BODY_PARSE_NODES || pending.bytes + cost > 4 * 1024 * 1024) throw new BodyProjectionCapacityError();
      pending.items.push(change); pending.bytes += cost;
    }
  } else {
    for (let index = 0; index < pending.items.length; index++) {
      const item = pending.items[index]!;
      if (item.contentOffset < change.to && item.contentOffset + item.text.length > change.from) {
        const body = change.project(item.contentOffset, item.text.length, item.body);
        const amended = { ...item, body };
        if (Buffer.byteLength(JSON.stringify(amended)) > BODY_FRAGMENT_ENCODED_BYTES) throw new BodyProjectionCapacityError();
        const cost = pendingCost(amended);
        // Include the old carrier until its replacement is installed.
        if (pending.bytes + cost > 4 * 1024 * 1024) throw new BodyProjectionCapacityError();
        pending.items[index] = amended; pending.bytes += cost - pendingCost(item);
      }
    }
  }
}

/** Sparse restart checkpoints reuse the live parser. Work is bounded per call,
 * so a legacy giant block can report progress without blocking the editor.
 * Checkpoints contain parser state, not an additional copy of body history. */
export class HistoryBodyRangeCache {
  readonly #entries = new Map<string, { points: BodyCheckpoint[]; stride: number }>();
  #checkpointBytes = 0;
  readonly #costs = new WeakMap<BodyCheckpoint, number>();
  #cost(point: BodyCheckpoint): number { let size = this.#costs.get(point); if (size === undefined) { size = Buffer.byteLength(JSON.stringify(point)) * 2 + 256; this.#costs.set(point, size); } return size; }
  #drop(key: string): void { const entry = this.#entries.get(key); if (entry) for (const point of entry.points) this.#checkpointBytes -= this.#cost(point); this.#entries.delete(key); }
  get checkpointBytes(): number { return this.#checkpointBytes; }
  #work?: { key: string; before: number; parser: TerminalBodyProjection; pending: PendingBody; position: number };
  close(): void { this.#work?.parser.dispose(); this.#work = undefined; this.#entries.clear(); this.#checkpointBytes = 0; }
  async read(key: string, length: number, read: (offset: number) => Promise<string>, before = length): Promise<
    { ready: true; items: readonly BodyAppend[] } | { ready: false; offset: number }> {
    if (!Number.isSafeInteger(before) || before <= 0 || before > length) throw Error('terminal-history-range');
    let entry = this.#entries.get(key);
    if (!entry) {
      const parser = new TerminalBodyProjection('markdown'); entry = { points: [parser.checkpoint()], stride: 64 * 1024 }; parser.dispose();
      if (this.#entries.size >= 8) this.#drop(this.#entries.keys().next().value!);
      this.#entries.set(key, entry); this.#checkpointBytes += this.#cost(entry.points[0]!);
    }
    this.#entries.delete(key); this.#entries.set(key, entry);
    if (!this.#work || this.#work.key !== key || this.#work.before !== before) {
      this.#work?.parser.dispose();
      // Leave at least one transfer page before the requested boundary. A
      // checkpoint may contain a partial logical block beginning even earlier.
      const point = [...entry.points].reverse().find(p => p.offset <= Math.max(0, before - 64 * 1024)) ?? entry.points[0]!;
      this.#work = { key, before, parser: TerminalBodyProjection.resume('markdown', point), pending: { items: [], bytes: 0 }, position: point.offset };
    }
    const work = this.#work; let spent = 0;
    const apply = (change: BodyProjectionChange) => {
      updatePending(work.pending, change, 0, before);
      while (work.pending.items.length > 4 && work.pending.items[0]!.contentOffset + work.pending.items[0]!.text.length <= work.parser.stableOffset) {
        work.pending.bytes -= pendingCost(work.pending.items.shift()!);
      }
    };
    while (work.position < length && (work.position < before || work.parser.stableOffset < before)) {
      const text = await read(work.position);
      if (!text || work.position + text.length > length || Buffer.byteLength(text) > 32 * 1024) throw Error('terminal-history-source-range');
      for (let local = 0; local < text.length;) {
        const end = pieceEnd(text, local), piece = text.slice(local, end);
        for (const change of work.parser.feed(piece)) apply(change);
        work.position += piece.length; local = end; spent += Buffer.byteLength(piece);
        const last = entry.points.at(-1)!;
        if (work.position - last.offset >= entry.stride && work.parser.retainedBytes <= 16 * 1024) {
          const checkpoint = work.parser.checkpoint();
          entry.points.push(checkpoint); this.#checkpointBytes += this.#cost(checkpoint);
          // Spatial compaction bounds memory while preserving the initial and
          // latest checkpoints. No source content is evicted or truncated.
          if (entry.points.length > 32) { entry.points = entry.points.filter((point, i, all) => { if (i % 2 === 0 || i === all.length - 1) return true; this.#checkpointBytes -= this.#cost(point); return false; }); entry.stride *= 2; }
          while (this.#checkpointBytes > 4 * 1024 * 1024 && this.#entries.size > 1) this.#drop(this.#entries.keys().next().value!);
          while (this.#checkpointBytes > 4 * 1024 * 1024 && entry.points.length > 2) this.#checkpointBytes -= this.#cost(entry.points.splice(1, 1)[0]!);
          if (this.#checkpointBytes > 4 * 1024 * 1024) throw new BodyProjectionCapacityError();
        }
        await yieldImmediate();
      }
      if (spent >= 256 * 1024 && work.position < before) return { ready: false, offset: work.position };
    }
    if (work.position === length) for (const change of work.parser.end()) apply(change);
    const items = work.pending.items.slice(-4).map(item => {
      const to = Math.min(before, item.contentOffset + item.text.length);
      return to === item.contentOffset + item.text.length ? item : { ...item, text: item.text.slice(0, to - item.contentOffset),
        body: { ...item.body, end: false, context: { nodes: sliceBodyNodes(item.body.context.nodes, item.contentOffset, to) } } };
    }).reverse();
    work.parser.dispose(); this.#work = undefined;
    return { ready: true, items };
  }
}
/** Cold history uses the same forward parser and real EOF as live output.
 * Reverse traversal retains only a bounded restart index and one bucket. It
 * does not reverse-guess Markdown state or keep a whole block's fragments. */
export async function* projectBodyHistory(source: string, kind: BodyKind, direction: 'forward' | 'reverse' = 'forward',
  cooperate: () => Promise<unknown> = yieldImmediate): AsyncGenerator<BodyAppend> {
  if (direction === 'forward') {
    const projection = new TerminalBodyProjection(kind), pending: PendingBody = { items: [], bytes: 0 };
    try {
      for (let position = 0; position < source.length;) {
        const end = pieceEnd(source, position);
        for (const change of projection.feed(source.slice(position, end))) updatePending(pending, change, 0, source.length);
        while (pending.items.length > 1 && pending.items[0]!.contentOffset + pending.items[0]!.text.length <= projection.stableOffset) {
          const item = pending.items.shift()!; pending.bytes -= pendingCost(item); yield item;
        }
        position = end; await cooperate();
      }
      for (const change of projection.end()) updatePending(pending, change, 0, source.length);
      yield* pending.items;
    } finally { projection.dispose(); }
    return;
  }
  const scan = new TerminalBodyProjection(kind), checkpoints: BodyCheckpoint[] = [scan.checkpoint()];
  let indexBytes = 0, next = 64 * 1024;
  try {
    for (let position = 0; position < source.length;) {
      const end = pieceEnd(source, position);
      for (const _change of scan.feed(source.slice(position, end))) { /* no fragment cache */ }
      position = end;
      if (position >= next && scan.retainedBytes <= 16 * 1024) {
        const checkpoint = scan.checkpoint();
        indexBytes += Buffer.byteLength(checkpoint.source) * 2 + Buffer.byteLength(checkpoint.table?.prefix ?? '') * 2 + Buffer.byteLength(JSON.stringify(checkpoint.links)) * 2 + 512;
        if (indexBytes > 4 * 1024 * 1024 || checkpoints.length >= 4096) throw new BodyProjectionCapacityError();
        checkpoints.push(checkpoint); next = position + 64 * 1024;
      }
      await cooperate();
    }
    for (const _change of scan.end()) { /* validate EOF before exposing reverse history */ }
  } finally { scan.dispose(); }
  for (let index = checkpoints.length - 1; index >= 0; index--) {
    const checkpoint = checkpoints[index]!, endOffset = checkpoints[index + 1]?.offset ?? source.length;
    if (checkpoint.offset === endOffset) continue;
    const projection = TerminalBodyProjection.resume(kind, checkpoint), pending: PendingBody = { items: [], bytes: 0 };
    try {
      let position = checkpoint.offset;
      while (position < source.length && (position < endOffset || projection.stableOffset < endOffset)) {
        const end = pieceEnd(source, position);
        for (const change of projection.feed(source.slice(position, end))) updatePending(pending, change, checkpoint.offset, endOffset);
        position = end; await cooperate();
      }
      if (position === source.length) for (const change of projection.end()) updatePending(pending, change, checkpoint.offset, endOffset);
      for (let item = pending.items.length - 1; item >= 0; item--) yield pending.items[item]!;
    } finally { projection.dispose(); }
  }
}
