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
  /** 当前挂载窗口（无窗口时为 undefined）。 */
  get page(): BodyPage | undefined { return this.#page; }
  /**
   * 把紧邻窗口起点之前的已备页并入窗口：只在用户向上阅读时调用。超出窗口上限时从末尾（较新的一侧）裁掉，
   * 选区所在部分受保护；窗口末尾的实时尾巴与中断尾巴原样保留。
   */
  reveal(older: BodyPage, protectedAnchor?: BodyAnchor, protectedEnd?: BodyAnchor): BodyPage | undefined {
    const current = this.#page;
    if (!current || !older.segments.length || older.start + older.segments.length !== current.start) return current;
    return this.accept({ ...current, first: Math.min(current.first, older.first), last: Math.max(current.last, older.last), start: older.start, follow: false,
      segments: [...older.segments, ...current.segments], interrupted: [...(older.interrupted ?? []), ...(current.interrupted ?? [])] }, protectedAnchor, protectedEnd);
  }
  /**
   * keepStart：N 的补丁不让挂载窗口向前（更早）扩展。跟随页在 N 已存不足一页时会因前插的更早片段而起点前移，
   * 把它们并进来会挪动正在阅读的正文；更早的内容只经 reveal 由用户动作揭示。
   */
  accept(next: BodyPage, protectedAnchor?: BodyAnchor, protectedEnd?: BodyAnchor, keepStart = false): BodyPage {
    this.notice = undefined;
    const old = this.#page;
    if (keepStart && old && next.start < old.start && next.start + next.segments.length >= old.start) {
      const drop = old.start - next.start;
      const interrupted = next.interrupted?.filter(item => item.before >= old.start);
      next = { ...next, start: old.start, segments: next.segments.slice(drop), interrupted: interrupted?.length ? interrupted : undefined };
    }
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
