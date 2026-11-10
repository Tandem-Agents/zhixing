/**
 * 输入草稿的原文与原生编辑器显示文本之间的换算，以及与原生撤销历史一一对应的原文日志。
 *
 * 原文（可含 CR、CRLF）是输入会话与存储里的事实；原生编辑器把 CR、LF、CRLF 都当换行，读回时只有 LF。
 * 编辑器只显示原文的 LF 投影：没有编辑时不把投影写回；真实编辑只替换改动对应的原文片段，未动的 CR、CRLF 原样保留。
 * 只处理有界的热窗口；原文不含 CR 时一律恒等，不建任何映射。
 */

/** 原文的显示投影：CRLF 与单独 CR 各成一个 LF。 */
export function displayText(raw: string): string {
  return raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw;
}

/** 原文偏移换成显示偏移。落在 CRLF 的 CR 与 LF 之间时，按整个换行之后计。 */
export function rawToDisplay(raw: string, offset: number): number {
  const end = Math.max(0, Math.min(offset, raw.length));
  if (!raw.includes('\r')) return end;
  let display = 0;
  for (let index = 0; index < end; index++) {
    if (raw[index] === '\r' && raw[index + 1] === '\n') index++;
    display++;
  }
  return display;
}

/** 显示偏移换成原文偏移：第 offset 个显示字符在原文里的起点；等于显示长度时为原文末尾。 */
export function displayToRaw(raw: string, offset: number): number {
  if (!raw.includes('\r')) return Math.max(0, Math.min(offset, raw.length));
  let index = 0;
  for (let display = 0; index < raw.length && display < offset; display++) index += raw[index] === '\r' && raw[index + 1] === '\n' ? 2 : 1;
  return index;
}

/** 显示坐标中的一次改动：before 的 [start, end) 换成 inserted。 */
export interface DisplayEdit { readonly start: number; readonly end: number; readonly inserted: string }

/**
 * 由一次原生编辑前后的显示文本与编辑后光标确定改动位置。
 * 只看前后文本无法区分重复字符处的位置（如在原换行前或后插入换行，结果相同），
 * 原生编辑在发出事件前已把光标放到改动处：插入结束于光标，删除发生在光标处；替换的区间本身唯一。
 */
export function locateDisplayEdit(before: string, after: string, cursorAfter: number): DisplayEdit | undefined {
  if (before === after) return undefined;
  const limit = Math.min(before.length, after.length);
  let prefix = 0, suffix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix++;
  while (suffix < limit && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const grow = after.length - before.length;
  if (prefix + suffix >= limit && grow !== 0) {
    const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
    if (grow > 0) {
      const start = clamp(cursorAfter - grow, Math.max(0, before.length - suffix), Math.min(prefix, before.length));
      return { start, end: start, inserted: after.slice(start, start + grow) };
    }
    const start = clamp(cursorAfter, Math.max(0, after.length - suffix), Math.min(prefix, after.length));
    return { start, end: start - grow, inserted: '' };
  }
  const common = Math.min(suffix, limit - prefix);
  return { start: prefix, end: before.length - common, inserted: after.slice(prefix, after.length - common) };
}

/** 原文中的一次改动：在 at 处删去 removed、写入 inserted。removed 原样保存被删的 CR、CRLF。 */
export interface RawEdit { readonly at: number; readonly removed: string; readonly inserted: string }

export function applyDisplayEdit(raw: string, edit: DisplayEdit): { raw: string; change: RawEdit } {
  const at = displayToRaw(raw, edit.start), to = displayToRaw(raw, edit.end);
  // 改动点不会落在 CRLF 中间，所以未动前缀以 CR 结尾时那是一个单独 CR。它后面若紧接 LF（写入内容开头，或写入为空时的后缀开头），
  // 二者会被读成一个 CRLF，两个逻辑换行变成一个。只在改动区开头补一个编码 LF：原 CR 与它组成 CRLF，仍是它自己那一个换行，
  // 后面的 LF 照旧是下一个换行。前后缀字节不动；补上的 LF 记在本次写入里，撤销时一并去掉。
  const next = edit.inserted || raw.slice(to, to + 1);
  const inserted = raw[at - 1] === '\r' && next.startsWith('\n') ? `\n${edit.inserted}` : edit.inserted;
  return { raw: raw.slice(0, at) + inserted + raw.slice(to), change: { at, removed: raw.slice(at, to), inserted } };
}

/** 撤销一次原文改动；当前原文在该处不是它写入的内容时返回 undefined。 */
export function undoRawEdit(raw: string, change: RawEdit): string | undefined {
  if (raw.slice(change.at, change.at + change.inserted.length) !== change.inserted) return undefined;
  return raw.slice(0, change.at) + change.removed + raw.slice(change.at + change.inserted.length);
}

/** 重做一次原文改动；当前原文在该处不是它删去的内容时返回 undefined。 */
export function redoRawEdit(raw: string, change: RawEdit): string | undefined {
  if (raw.slice(change.at, change.at + change.removed.length) !== change.removed) return undefined;
  return raw.slice(0, change.at) + change.inserted + raw.slice(change.at + change.removed.length);
}

/** 原生修改入口上同步取到的一步（见 editor-coordinates.ts 的 TerminalTextarea）。 */
export interface TerminalEditStep { readonly kind: 'edit' | 'undo' | 'redo'; readonly before: string; readonly after: string; readonly cursorAfter: number }

const changeBytes = (change: RawEdit) => Buffer.byteLength(change.removed) + Buffer.byteLength(change.inserted) + 64;

/**
 * 当前编辑器的已确认原文，以及与原生历史逐步对应的原文日志。
 * 原生编辑每改一次文本记一步（快操作在事件合并之前就逐步取到）；撤销、重做按栈顶日志反向或正向应用并核对投影。
 * 对不上时不猜测：保持最后确认的原文并标记失配，由调用方恢复显示、说明未应用并清空两侧历史。
 */
export class DraftDisplayAdapter {
  #raw = '';
  #undo: RawEdit[] = [];
  #redo: RawEdit[] = [];
  #bytes = 0;
  #mismatch = false;

  get raw(): string { return this.#raw; }
  /** 日志占用的字节，计入编辑器既有的历史预算。 */
  get historyBytes(): number { return this.#bytes; }
  get mismatch(): boolean { return this.#mismatch; }
  /** 撤销与重做日志的条数（可核对的已确认状态之一）。 */
  get historyLength(): { undo: number; redo: number } { return { undo: this.#undo.length, redo: this.#redo.length }; }
  /** 需要在原生修改入口取步：原文含 CR，或日志里还有可撤销、可重做的原文片段。否则原生历史还原的 LF 文本就是原文。 */
  get tracking(): boolean { return this.#mismatch || this.#undo.length > 0 || this.#redo.length > 0 || this.#raw.includes('\r'); }

  /** 换成新的已确认原文并清空日志；调用方须同时清空原生历史。 */
  reset(raw: string): void {
    this.#raw = raw; this.#undo = []; this.#redo = []; this.#bytes = 0; this.#mismatch = false;
  }

  /** 不取步时编辑器文本即原文。 */
  follow(text: string): void {
    if (!this.tracking) this.#raw = text;
  }

  /** 先算出候选原文并核对其投影等于编辑器的新文本，通过后才一起提交原文与日志；对不上时已确认状态保持不变。 */
  step(step: TerminalEditStep): void {
    if (this.#mismatch) return;
    if (displayText(this.#raw) !== step.before) { this.#mismatch = true; return; }
    if (step.kind === 'edit') {
      const edit = locateDisplayEdit(step.before, step.after, step.cursorAfter);
      if (!edit) return;
      const { raw, change } = applyDisplayEdit(this.#raw, edit);
      if (displayText(raw) !== step.after) { this.#mismatch = true; return; }
      for (const dropped of this.#redo) this.#bytes -= changeBytes(dropped);
      this.#raw = raw; this.#redo = []; this.#undo.push(change); this.#bytes += changeBytes(change);
      return;
    }
    const source = step.kind === 'undo' ? this.#undo : this.#redo, target = step.kind === 'undo' ? this.#redo : this.#undo;
    const change = source.at(-1);
    const next = change && (step.kind === 'undo' ? undoRawEdit(this.#raw, change) : redoRawEdit(this.#raw, change));
    if (!change || next === undefined || displayText(next) !== step.after) { this.#mismatch = true; return; }
    source.pop(); target.push(change); this.#raw = next;
  }
}
