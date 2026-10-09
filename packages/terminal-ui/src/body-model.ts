/** Shared source coordinates are UTF-16. No renderer, native library or parser worker is loaded by Node. */
export const BODY_FRAGMENT_BYTES = 32 * 1024;
export const BODY_FRAGMENT_ENCODED_BYTES = 48 * 1024;
export const BODY_PAGE_BYTES = 224 * 1024;
export const BODY_PAGE_FRAGMENTS = 4;
export const BODY_PARSE_BYTES = 256 * 1024;
export const BODY_PARSE_NODES = 4096;
/** Reservation covers marked tokens/maps, one amend carrier and old/new
 * projections. Cold reverse checkpoints share this same working reservation. */
export const BODY_PROJECTION_WORK_BYTES = 16 * 1024 * 1024;
export const BODY_STYLE = { bold: 1, italic: 2, strike: 4, code: 8, link: 16, dim: 32 } as const;
export type BodyKind = 'markdown' | 'plain';
export type BodyNodeKind = 'paragraph' | 'heading' | 'quote' | 'list' | 'code' | 'table' | 'rule' | 'space';
export interface BodyRun {
  readonly from: number; readonly to: number;
  /** Bounded rendered characters, never ANSI. Original source stays unchanged. */
  readonly text: string; readonly style: number; readonly cell?: number; readonly href?: string;
  readonly semantic?: 'added' | 'removed' | 'meta';
}
export interface BodyNode {
  readonly from: number; readonly to: number; readonly kind: BodyNodeKind;
  readonly origin?: number;
  readonly runs: readonly BodyRun[];
  readonly depth?: number; readonly language?: string;
  readonly table?: number; readonly columns?: number; readonly header?: boolean;
  readonly labels?: readonly string[];
  /** Nonselectable decoration, not source. */
  readonly anchor?: boolean;
  readonly decoration?: string;
}
export interface BodyContext { readonly nodes: readonly BodyNode[] }
export interface BodyFragmentMetadata {
  readonly version: 1; readonly revision: number; readonly kind: BodyKind;
  readonly context: BodyContext;
  /** Real logical EOF, never a transport fragment's final. */
  readonly end: boolean;
}
export interface BodyAnchor { readonly blockId: string; readonly contentOffset: number }
export interface BodySegment {
  readonly blockId: string; readonly contentOffset: number; readonly role: string;
  readonly groupId?: string;
  readonly text: string; readonly final: boolean; readonly body?: BodyFragmentMetadata;
}
export interface BodyPage {
  readonly first: number; readonly last: number; readonly start: number;
  readonly follow: boolean; readonly segments: readonly BodySegment[];
}
/** Same-release wire projection: reuse indexes refer only to the immediately
 * preceding acknowledged-order page, never to a growing remote cache. */
export interface BodyPagePatch extends Omit<BodyPage, 'segments'> {
  readonly revision: number; readonly base?: number; readonly segments: readonly (BodySegment | number)[];
}
export interface BodyPageRevision { readonly revision: number; readonly page: BodyPage }
/** Range counters may advance while an off-bottom reading page stays intact. */
export function sameBodyPageContent(left: BodyPage | undefined, right: BodyPage): boolean {
  return !!left && left.start === right.start && left.follow === right.follow &&
    left.segments.length === right.segments.length && left.segments.every((segment, index) => segment === right.segments[index]);
}
export function encodeBodyPage(page: BodyPage, revision: number, previous?: BodyPageRevision): BodyPagePatch {
  return { ...page, revision, base: previous?.revision, segments: page.segments.map(segment => {
    const index = previous?.page.segments.indexOf(segment) ?? -1;
    return index < 0 ? segment : index;
  }) };
}
export function decodeBodyPage(patch: BodyPagePatch, previous?: BodyPageRevision): BodyPageRevision {
  if (!integer(patch.revision) || (previous && patch.revision <= previous.revision) ||
      (patch.base !== undefined && patch.base !== previous?.revision) || !Array.isArray(patch.segments) || patch.segments.length > BODY_PAGE_FRAGMENTS)
    throw Error('terminal-body-page-revision');
  if (![patch.first, patch.last, patch.start].every(Number.isSafeInteger) || patch.first > patch.start || patch.start > patch.last ||
      patch.segments.length > patch.last - patch.start || typeof patch.follow !== 'boolean') throw Error('terminal-body-page-range');
  const segments = patch.segments.map(segment => {
    if (typeof segment !== 'number') return segment;
    if (patch.base === undefined || !integer(segment) || !previous?.page.segments[segment]) throw Error('terminal-body-page-reference');
    return previous.page.segments[segment]!;
  });
  const page = { first: patch.first, last: patch.last, start: patch.start, follow: patch.follow, segments };
  if (Buffer.byteLength(JSON.stringify(page)) > BODY_PAGE_BYTES) throw Error('terminal-body-page-capacity');
  bodyWindows(page);
  return { revision: patch.revision, page };
}
export interface BodyWindow {
  readonly blockId: string; readonly role: string; readonly kind: BodyKind;
  readonly contentOffset: number; readonly text: string; readonly context: BodyContext;
  readonly revision: number; readonly end: boolean;
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const kinds = ['paragraph', 'heading', 'quote', 'list', 'code', 'table', 'rule', 'space'];
// Accepted projection DTOs are immutable snapshots. Weak caches disappear
// with their pages and cannot turn into a second retained history.
const validatedMetadata = new WeakMap<object, { offset: number; length: number }>();
const projectedPages = new WeakMap<BodyPage, readonly BodyWindow[]>();
export function validateBodyMetadata(value: unknown, contentOffset: number, sourceLength = BODY_FRAGMENT_BYTES): value is BodyFragmentMetadata {
  const known = value && typeof value === 'object' ? validatedMetadata.get(value) : undefined;
  if (known?.offset === contentOffset && known.length === sourceLength) return true;
  if (!integer(contentOffset) || !integer(sourceLength) || !Number.isSafeInteger(contentOffset + sourceLength) || !record(value) ||
      !keys(value, ['version', 'revision', 'kind', 'context', 'end']) || value.version !== 1 || !integer(value.revision) ||
      typeof value.kind !== 'string' || !['markdown', 'plain'].includes(value.kind) || typeof value.end !== 'boolean' || !record(value.context) ||
      !keys(value.context, ['nodes']) || !Array.isArray(value.context.nodes) || value.context.nodes.length > BODY_PARSE_NODES) return false;
  let count = 0, previous = contentOffset;
  for (const node of value.context.nodes) {
    if (++count > BODY_PARSE_NODES || !record(node) || !keys(node, ['from', 'to', 'kind', 'origin', 'runs', 'depth', 'language', 'table', 'columns', 'header', 'labels', 'anchor', 'decoration']) ||
        !integer(node.from) || !integer(node.to) || node.from < contentOffset || node.to < node.from ||
        node.to > contentOffset + sourceLength || node.from < previous || typeof node.kind !== 'string' || !kinds.includes(node.kind) || !Array.isArray(node.runs)) return false;
    previous = node.to;
    if ((node.origin !== undefined && (!integer(node.origin) || node.origin > node.from)) ||
        (node.depth !== undefined && (!integer(node.depth) || node.depth > 64)) ||
        (node.language !== undefined && (typeof node.language !== 'string' || node.language.length > 128 || /[\r\n\0]/u.test(node.language))) ||
        (node.table !== undefined && !integer(node.table)) ||
        (node.columns !== undefined && (!integer(node.columns) || node.columns < 1 || node.columns > 128)) ||
        (node.labels !== undefined && (!Array.isArray(node.labels) || node.labels.length !== node.columns || node.labels.some(label => typeof label !== 'string' || label.length > 512))) ||
        (node.header !== undefined && typeof node.header !== 'boolean') || (node.anchor !== undefined && typeof node.anchor !== 'boolean') ||
        (node.decoration !== undefined && (typeof node.decoration !== 'string' || !/^[ +\-\d]{1,24}$/u.test(node.decoration)))) return false;
    let runEnd = node.from;
    for (const run of node.runs) {
      if (++count > BODY_PARSE_NODES || !record(run) || !keys(run, ['from', 'to', 'text', 'style', 'cell', 'href', 'semantic']) ||
          !integer(run.from) || !integer(run.to) || run.from < runEnd || run.to < run.from || run.to > node.to ||
          typeof run.text !== 'string' || !integer(run.style) || run.style > 63 ||
          (run.semantic !== undefined && !['added', 'removed', 'meta'].includes(String(run.semantic))) ||
          (run.href !== undefined && (typeof run.href !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(run.href))) ||
          (run.cell !== undefined && (!integer(run.cell) || typeof node.columns !== 'number' || run.cell >= node.columns))) return false;
      runEnd = run.to;
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > BODY_FRAGMENT_ENCODED_BYTES) return false;
  for (const node of value.context.nodes) {
    for (const run of node.runs) Object.freeze(run);
    Object.freeze(node.runs); if (node.labels) Object.freeze(node.labels); Object.freeze(node);
  }
  Object.freeze(value.context.nodes); Object.freeze(value.context); Object.freeze(value);
  validatedMetadata.set(value, { offset: contentOffset, length: sourceLength });
  return true;
}
/** Never inject synthetic fence/list/header/inline text into selection. */
export function sliceBodyNodes(nodes: readonly BodyNode[], from: number, to: number): BodyNode[] {
  const result: BodyNode[] = [];
  for (const node of nodes) {
    // A decorated zero-width EOF row belongs to the nonempty carrier ending
    // at that boundary. Retain it once when encoded-size splitting recurs.
    if (node.from === node.to && node.decoration !== undefined) {
      if (node.from > from && node.from <= to) result.push(node);
      continue;
    }
    if (node.to <= from || node.from >= to) continue;
    const runs: BodyRun[] = [];
    for (const run of node.runs) {
      if (run.to <= from || run.from >= to) continue;
      const start = Math.max(from, run.from), end = Math.min(to, run.to);
      if (run.text.length === run.to - run.from) runs.push({ ...run, from: start, to: end, text: Buffer.from(run.text.slice(start - run.from, end - run.from), 'utf16le').toString('utf16le') });
      // Entities and escapes belong only to the fragment containing their first source character.
      else if (run.from >= from) runs.push({ ...run, to: end, text: Buffer.from(run.text, 'utf16le').toString('utf16le') });
    }
    result.push({ ...node, origin: node.origin ?? node.from, from: Math.max(node.from, from), to: Math.min(node.to, to), runs, anchor: node.anchor && node.from >= from });
  }
  return result;
}
export function bodyWindows(page: BodyPage): readonly BodyWindow[] {
  const known = projectedPages.get(page);
  if (known) return known;
  if (![page.first, page.last, page.start].every(Number.isSafeInteger) || page.first > page.start || page.start > page.last ||
      page.segments.length > page.last - page.start || typeof page.follow !== 'boolean') throw Error('terminal-body-page-range');
  if (page.segments.length > 256 || Buffer.byteLength(JSON.stringify(page)) > 1024 * 1024 ||
      page.segments.reduce((sum, segment) => sum + (segment.body?.context.nodes.length ?? 1), 0) > 8192) throw Error('terminal-body-page-capacity');
  const windows = page.segments.map(segment => {
    if (!segment.blockId || segment.blockId.length > 512 || (segment.groupId !== undefined && (!segment.groupId || segment.groupId.length > 512)) || !integer(segment.contentOffset) || Buffer.byteLength(segment.text) > BODY_FRAGMENT_BYTES ||
        (segment.body && !validateBodyMetadata(segment.body, segment.contentOffset, segment.text.length))) throw Error('terminal-body-source-invalid');
    const body = segment.body;
    const context = body?.context ?? { nodes: [{ from: segment.contentOffset, to: segment.contentOffset + segment.text.length,
      origin: 0, kind: 'paragraph' as const, runs: [{ from: segment.contentOffset, to: segment.contentOffset + segment.text.length, text: segment.text, style: 0 }] }] };
    if (!body) {
      for (const node of context.nodes) { for (const run of node.runs) Object.freeze(run); Object.freeze(node.runs); Object.freeze(node); }
      Object.freeze(context.nodes); Object.freeze(context);
    }
    Object.freeze(segment);
    return Object.freeze({ blockId: segment.blockId, role: segment.role, kind: body?.kind ?? 'plain', contentOffset: segment.contentOffset,
      text: segment.text, context, revision: body?.revision ?? 0, end: body?.end ?? segment.final });
  });
  Object.freeze(page.segments); Object.freeze(page); Object.freeze(windows);
  projectedPages.set(page, windows);
  return windows;
}
export function sourceLineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}
export function visibleBodyText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
    char => String.fromCharCode(char.charCodeAt(0) === 127 ? 0x2421 : 0x2400 + char.charCodeAt(0)));
}
