import { type BodyPage, type BodyAnchor, type BodySegment } from './body-model.js';

export const BODY_WINDOW_BYTES = 1024 * 1024;
export const BODY_WINDOW_FRAGMENTS = 256;
export const BODY_WINDOW_NODES = 8192;
/** IPC pages are bounded transfer units. This is the separately bounded,
 * continuous reading window; only native viewport leaves are mounted. */
export class BodyReadingWindow {
  #page?: BodyPage;
  notice?: string;
  reset(): void { this.#page = undefined; this.notice = undefined; }
  accept(next: BodyPage, protectedAnchor?: BodyAnchor, protectedEnd?: BodyAnchor): BodyPage {
    this.notice = undefined;
    const old = this.#page;
    if (!old || !next.segments.length || next.start > old.start + old.segments.length ||
        next.start + next.segments.length < old.start) { this.#page = next; return next; }
    const start = Math.max(next.first, Math.min(old.start, next.start));
    const end = Math.min(next.last, Math.max(old.start + old.segments.length, next.start + next.segments.length));
    const segments: BodySegment[] = [];
    for (let ordinal = start; ordinal < end; ordinal++) segments.push(
      ordinal >= next.start && ordinal < next.start + next.segments.length ? next.segments[ordinal - next.start]! : old.segments[ordinal - old.start]!);
    let interrupted = [...(old.interrupted ?? []).filter(item => item.before < next.start || item.before > next.start + next.segments.length), ...(next.interrupted ?? [])]
      .filter(item => item.before >= start && item.before <= end).sort((a, b) => a.before - b.before);
    let from = start, bytes = (next.transient ? Buffer.byteLength(JSON.stringify(next.transient)) : 0) + interrupted.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0), nodes = (next.transient ? 1 : 0) + interrupted.length;
    const locate = (anchor: BodyAnchor) => segments.findIndex(s => s.blockId === anchor.blockId && anchor.contentOffset >= s.contentOffset && anchor.contentOffset <= s.contentOffset + s.text.length);
    const a = protectedAnchor ? locate(protectedAnchor) : -1, b = protectedEnd ? locate(protectedEnd) : a;
    const protectedFirst = a < 0 || b < 0 ? start : start + Math.min(a, b), protectedLast = a < 0 || b < 0 ? end : start + Math.max(a, b);
    const sizes = segments.map(segment => { const b = Buffer.byteLength(JSON.stringify(segment)), n = segment.body?.context.nodes.length ?? 1; bytes += b; nodes += n; return { b, n }; });
    const trimStart = next.follow || next.start > old.start;
    while (segments.length + (next.transient ? 1 : 0) + interrupted.length > BODY_WINDOW_FRAGMENTS || bytes > BODY_WINDOW_BYTES - 256 || nodes > BODY_WINDOW_NODES) {
      const index = trimStart ? 0 : segments.length - 1;
      if (protectedAnchor && from + index >= protectedFirst && from + index <= protectedLast) {
        this.notice = '阅读窗口已满，请先复制或取消选区后继续翻阅。';
        // This is an ordinary reading constraint, not corrupt IPC. Preserve
        // the complete old selection and keep accepting later wire revisions.
        return this.#page = { ...old, first: next.first, last: next.last, follow: false,
          transient: old.start + old.segments.length === next.last ? next.transient : undefined };
      }
      const size = sizes.splice(index, 1)[0]!; segments.splice(index, 1); bytes -= size.b; nodes -= size.n;
      if (trimStart) from++;
      interrupted = interrupted.filter(item => {
        if (item.before >= from && item.before <= from + segments.length) return true;
        bytes -= Buffer.byteLength(JSON.stringify(item)); nodes--; return false;
      });
    }
    const result = { ...next, start: from, segments, interrupted: interrupted.length ? interrupted : undefined }; this.#page = result; return result;
  }
}
