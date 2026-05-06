/**
 * InputBuffer — REPL 一行输入的可变缓冲区
 *
 * 作用域：替代 `readline.question` 的"等用户敲完一整行"语义。InputBuffer 持有
 * draft + cursor 的可变状态，每次按键都通过它做编辑，编辑后通过 `getTriggerContext`
 * 派生一份 typeahead `TriggerContext` 喂给 broker。
 *
 * 不在这里：
 *   - 终端 I/O（属于 TypeaheadInputReader）
 *   - 命令分派（属于 CommandDispatcher）
 *   - 历史记录持久化（属于 TranscriptStore，本类只持有 in-memory ring buffer）
 *
 * 设计要点：
 *   1. **按字符（code point）操作**，不按 UTF-16 code unit —— CJK / emoji 安全
 *   2. **Cursor 是字符 offset**，不是 byte offset，与 typeahead trigger-matcher 一致
 *   3. **history 是 in-memory ring buffer**，最多保留 100 条；上下方向键浏览
 *   4. **insertText/replaceRange 是唯一写路径**，所有快捷键最终走这两个方法
 */

import type { RuntimeContext, TriggerContext } from "@zhixing/core";

const HISTORY_LIMIT = 100;

export interface InputBufferOptions {
  /** 历史最大条目数；默认 100 */
  readonly historyLimit?: number;
}

export interface InputBufferSnapshot {
  readonly draft: string;
  readonly cursor: number;
}

/**
 * 一行输入缓冲区。**单线程使用** —— TUI 主循环里同步调用，无并发保护。
 *
 * 所有索引都是**字符 offset**（`Array.from(draft).length`），不是 UTF-16 code
 * unit。这与 typeahead trigger-matcher 的契约一致 —— 整个 typeahead 链路统一
 * 用字符 offset，CJK 和 emoji 都不会出错。
 */
export class InputBuffer {
  private chars: string[] = [];
  private cursorPos = 0; // 字符偏移
  private readonly history: string[] = [];
  private historyIndex = -1; // -1 = 不在历史浏览态
  private savedDraft = ""; // 浏览历史前的 draft，用于 ↓ 回到当前
  private readonly historyLimit: number;

  constructor(options: InputBufferOptions = {}) {
    this.historyLimit = options.historyLimit ?? HISTORY_LIMIT;
  }

  // ─── 读取 ───

  get draft(): string {
    return this.chars.join("");
  }

  get cursor(): number {
    return this.cursorPos;
  }

  get isEmpty(): boolean {
    return this.chars.length === 0;
  }

  snapshot(): InputBufferSnapshot {
    return { draft: this.draft, cursor: this.cursorPos };
  }

  // ─── 写入 ───

  /**
   * 整体替换 draft + 把 cursor 置于末尾。
   * 用途：history 浏览 / 程序化更新（如 typeahead accept 后的 newDraft）
   */
  setDraft(value: string, cursor?: number): void {
    this.chars = Array.from(value);
    if (cursor !== undefined) {
      this.cursorPos = clampCursor(cursor, this.chars.length);
    } else {
      this.cursorPos = this.chars.length;
    }
    this.exitHistoryBrowse();
  }

  /** 在 cursor 位置插入文本，cursor 前进到插入末尾 */
  insertText(text: string): void {
    if (!text) return;
    const insertChars = Array.from(text);
    this.chars.splice(this.cursorPos, 0, ...insertChars);
    this.cursorPos += insertChars.length;
    this.exitHistoryBrowse();
  }

  /** Backspace —— 删 cursor 左边一个字符 */
  deleteBackward(): void {
    if (this.cursorPos === 0) return;
    this.chars.splice(this.cursorPos - 1, 1);
    this.cursorPos--;
    this.exitHistoryBrowse();
  }

  /** Delete —— 删 cursor 右边一个字符 */
  deleteForward(): void {
    if (this.cursorPos >= this.chars.length) return;
    this.chars.splice(this.cursorPos, 1);
    this.exitHistoryBrowse();
  }

  /** 清空整行 */
  clear(): void {
    this.chars = [];
    this.cursorPos = 0;
    this.exitHistoryBrowse();
  }

  /** 替换字符区间 [start, end)（cursor 落到替换段末尾） */
  replaceRange(start: number, end: number, replacement: string): void {
    const total = this.chars.length;
    const s = clampCursor(start, total);
    const e = clampCursor(end, total);
    if (e < s) return;
    const replacementChars = Array.from(replacement);
    this.chars.splice(s, e - s, ...replacementChars);
    this.cursorPos = s + replacementChars.length;
    this.exitHistoryBrowse();
  }

  // ─── Cursor 移动 ───

  moveCursorLeft(): void {
    if (this.cursorPos > 0) this.cursorPos--;
  }
  moveCursorRight(): void {
    if (this.cursorPos < this.chars.length) this.cursorPos++;
  }
  moveCursorHome(): void {
    this.cursorPos = 0;
  }
  moveCursorEnd(): void {
    this.cursorPos = this.chars.length;
  }
  /** 直接设置 cursor 到指定字符位置（clamped）。供原子操作跨整段移动使用。 */
  setCursor(position: number): void {
    this.cursorPos = clampCursor(position, this.chars.length);
  }

  // ─── 历史 ───

  /**
   * 提交一行 —— 把 draft 推入历史并清空缓冲。
   * 重复行不去重 —— 用户可能故意连续运行同一命令。
   */
  commit(): string {
    const submitted = this.draft;
    if (submitted) {
      this.history.push(submitted);
      while (this.history.length > this.historyLimit) {
        this.history.shift();
      }
    }
    this.clear();
    return submitted;
  }

  /**
   * 历史浏览：上一条。
   * 第一次调用时 snapshot 当前 draft 到 `savedDraft`，方便 ↓ 回到原状态。
   */
  historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      // 进入浏览态：snapshot 当前 draft
      this.savedDraft = this.draft;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return; // 已经在最早一条
    }
    const entry = this.history[this.historyIndex]!;
    this.chars = Array.from(entry);
    this.cursorPos = this.chars.length;
  }

  historyNext(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      const entry = this.history[this.historyIndex]!;
      this.chars = Array.from(entry);
      this.cursorPos = this.chars.length;
    } else {
      // 走到末尾：恢复 savedDraft
      this.chars = Array.from(this.savedDraft);
      this.cursorPos = this.chars.length;
      this.historyIndex = -1;
      this.savedDraft = "";
    }
  }

  /** 测试用：获取历史副本 */
  getHistory(): readonly string[] {
    return this.history.slice();
  }

  private exitHistoryBrowse(): void {
    this.historyIndex = -1;
    this.savedDraft = "";
  }

  // ─── 派生 typeahead 上下文 ───

  /**
   * 构造一个 TriggerContext 喂给 typeahead broker。
   * runtime 由调用方注入 —— InputBuffer 不应该自己造时钟和 cwd。
   */
  toTriggerContext(runtime: RuntimeContext): TriggerContext {
    return {
      draft: this.draft,
      cursor: this.cursorPos,
      mode: "prompt",
      runtime,
    };
  }
}

function clampCursor(cursor: number, max: number): number {
  if (cursor < 0) return 0;
  if (cursor > max) return max;
  return cursor;
}
