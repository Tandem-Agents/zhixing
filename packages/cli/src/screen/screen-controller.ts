/**
 * 屏幕协调器——cli 交互模式下所有写到屏幕的逻辑必须经此协调。
 *
 * 三区屏幕模型：
 *   ┌────────────────────────────────┐
 *   │  Scrollback（已固化）          │   历史 scroll，不可重画
 *   ├────────────────────────────────┤   ← frame 起点（cursor up 上限）
 *   │  Tail Buffer                   │   未固化的 scroll 行——每次 paint 重画
 *   ├────────────────────────────────┤
 *   │  Status Bar (0..N 行)          │   动态状态条
 *   ├────────────────────────────────┤
 *   │  Input Region                  │   持久输入区
 *   └────────────────────────────────┘
 *
 * **Frame Buffer 渲染契约（核心）**：
 *   每次更新 = 全帧差分覆盖：cursor up 到 frame 起点 + \r + 逐行 \x1b[2K + 新内容。
 *   tailBuffer + chrome 作为单一"frame"重画——chunk 接续靠 tailBuffer 末尾行内追加，
 *   chrome 永驻显示在 frame 末尾，整个序列单次 stdout.write 给 TTY。
 *
 *   这取代了"exclusive 擦 chrome 让 chunk 直写"的旧设计——旧设计让 chrome 在流式期间
 *   消失（用户期望 chrome 永驻）。新设计让 chunk 在 tailBuffer 末尾行内累积，chrome
 *   每次 paint 重画在 tailBuffer 之后——视觉上 chrome 始终跟随 scroll 末尾，永驻。
 *
 * **行固化（freeze）**：
 *   tailBuffer 累积超过 MAX_TAIL_LINES 时，前 N 行固化（移到 scrollback 历史不再重画）。
 *   固化逻辑：tailBuffer.splice(0, N) + cursorRow / renderedRows 各减 N + frame 起点
 *   在物理屏幕上向下移 N 行（已写入的固化行保持不变）。
 *
 * **使用约定**：
 *   - cli REPL 模式启动一个 ScreenController，持续到 REPL 结束
 *   - 写到 stdout 的所有 caller 必须经 withScrollWrite / notifyDeferred，禁止直接
 *     process.stdout.write
 *   - 输入区状态变化通过 requestInputRepaint 触发重画
 *   - 状态条更新通过 setStatusBar
 *   - 流式 LLM chunk caller 直接调 withScrollWrite——chunk 在 tailBuffer 末尾行内
 *     接续，无需 begin/end 协议（旧 exclusive 模式已移除）
 */

import {
  ANSI_CARRIAGE_RETURN,
  ANSI_ERASE_LINE,
  ansiCursorUp,
  eraseRegion,
  moveCursorWithinRegion,
} from "./region-painter.js";

export interface InputRegion {
  /**
   * 渲染当前输入区为字符串数组（逐行，不含末尾 \n）。
   * 包含完整 chrome（边框 + 内 padding）、buffer 文本、可选 panel 行。
   */
  renderLines(): readonly string[];

  /**
   * 光标在 renderLines() 数组中的位置——row 0-based 行偏移，col 0-based 显示列。
   * caller 不需要写 ANSI 移动光标，由 ScreenController 内部移动。
   */
  cursorPosition(): { row: number; col: number };
}

export interface ScreenController {
  /** 注册唯一活跃输入区。重复 attach 会替换旧的并立刻重画。 */
  attachInput(region: InputRegion): void;
  /** 卸载输入区——擦除状态条 + 输入区屏幕痕迹，状态条状态也清空。 */
  detachInput(): void;
  /** 设置状态条内容；null / 空数组 = 隐藏状态条。 */
  setStatusBar(lines: readonly string[] | null): void;
  /**
   * 写到滚动区——caller 通过 fn 接收的 write 函数追加内容。
   *
   * 内容累积到 tailBuffer 末尾（chunk 接续在末尾行内追加），整个 frame（tailBuffer +
   * chrome）做行级差分 paint——chrome 永驻显示，chunk 接续无擦不闪烁。
   *
   * 多次 withScrollWrite 调用：内容按顺序累积到 tailBuffer，chunk 末尾不带 \n 时下次
   * 写入接续到末尾行；带 \n 时末尾换行后下次写入新起一行。
   */
  withScrollWrite(fn: (write: (chunk: string) => void) => void): void;
  /** 触发输入区重画——用于按键后 buffer / panel 变化通知屏幕刷新。 */
  requestInputRepaint(): void;
  /**
   * 异步通知——语义同 withScrollWrite，保留独立方法名让 caller 表达"任意时刻可能
   * 触发的事件"（scheduler 任务完成、watchdog 警告等）。frame buffer 模式下不再有
   * "独占期排队"概念，与 withScrollWrite 行为一致。
   */
  notifyDeferred(text: string): void;
  /** 释放：擦除状态条 + 输入区，detach 输入区，停止接受新写入。 */
  dispose(): void;
}

interface ScreenControllerOptions {
  readonly stdout?: NodeJS.WriteStream;
}

interface QueueTask {
  readonly run: () => void;
}

/**
 * tailBuffer 累积超过此行数时触发固化——前一半行移到 scrollback 历史不再重画，
 * 控制每次 paint 的工作量。值过小会频繁固化（影响光标行号管理），过大会让每次
 * paint 重画大量行。50 是平衡值——LLM 长段输出 ~10 屏内容时固化数次。
 */
const MAX_TAIL_LINES = 50;
/** 固化时保留的尾部行数——前 (MAX - KEEP) 行移到历史 */
const KEEP_TAIL_LINES = 25;

class ScreenControllerImpl implements ScreenController {
  private readonly stdout: NodeJS.WriteStream;
  private input: InputRegion | null = null;
  private statusLines: readonly string[] = [];
  /** 上次"frame 起点"之下到 chrome[0] 之间的 scroll 行——每次 paint 重画 */
  private tailBuffer: string[] = [];
  /** 当前 frame 在屏幕上占用的总行数（max 历史保留——避免 chrome 行数收缩闪烁） */
  private renderedRows = 0;
  /** 当前光标在 frame 内的相对行号（0-based，相对 frame 起点） */
  private cursorRow = 0;
  private readonly queue: QueueTask[] = [];
  private flushing = false;
  private disposed = false;

  constructor(options: ScreenControllerOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
  }

  attachInput(region: InputRegion): void {
    this.enqueue(() => {
      this.input = region;
      this.paintFrame();
    });
  }

  detachInput(): void {
    this.enqueue(() => {
      // detach 是 chrome 完全消失语义——彻底擦掉 frame，重置所有状态
      if (this.renderedRows > 0) {
        this.stdout.write(eraseRegion(this.cursorRow));
      }
      this.input = null;
      this.statusLines = [];
      this.tailBuffer = [];
      this.renderedRows = 0;
      this.cursorRow = 0;
    });
  }

  setStatusBar(lines: readonly string[] | null): void {
    this.enqueue(() => {
      this.statusLines = lines ?? [];
      this.paintFrame();
    });
  }

  withScrollWrite(fn: (write: (chunk: string) => void) => void): void {
    this.enqueue(() => {
      let collected = "";
      fn((chunk) => {
        collected += chunk;
      });
      if (collected.length === 0) return;
      this.appendToTail(collected);
      this.paintFrame();
      this.freezeIfTooLong();
    });
  }

  requestInputRepaint(): void {
    this.enqueue(() => {
      this.paintFrame();
    });
  }

  notifyDeferred(text: string): void {
    this.enqueue(() => {
      if (text.length === 0) return;
      this.appendToTail(text);
      this.paintFrame();
      this.freezeIfTooLong();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.queue.push({
      run: () => {
        if (this.renderedRows > 0) {
          this.stdout.write(eraseRegion(this.cursorRow));
        }
        this.input = null;
        this.statusLines = [];
        this.tailBuffer = [];
        this.renderedRows = 0;
        this.cursorRow = 0;
      },
    });
    this.disposed = true;
    this.flush();
  }

  private enqueue(task: () => void): void {
    if (this.disposed) return;
    this.queue.push({ run: task });
    this.flush();
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) break;
        try {
          task.run();
        } catch {
          // 任务异常不传播——保持后续任务可执行
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 把 content 切分成行追加到 tailBuffer——chunk 接续语义在此实现：
   *
   *   - content = "abc"  → tailBuffer 末尾行追加 "abc"（同行接续）
   *   - content = "\n"   → tailBuffer 追加空行（下次 chunk 在新行起手）
   *   - content = "a\nb" → tailBuffer 末尾行追加 "a"，新增一行 "b"
   *
   * 第一次调用时 tailBuffer 为空——以"空末尾行"起手，让首段直接接续到该行。
   */
  private appendToTail(content: string): void {
    const parts = content.split("\n");
    if (this.tailBuffer.length === 0) {
      this.tailBuffer.push("");
    }
    // 第一段追加到当前末尾行
    this.tailBuffer[this.tailBuffer.length - 1] += parts[0]!;
    // 后续段作为新行
    for (let i = 1; i < parts.length; i++) {
      this.tailBuffer.push(parts[i]!);
    }
  }

  /**
   * tailBuffer 累积过长时固化前 N 行——它们已经被 paintFrame 写到物理屏幕，固化后
   * 不再被后续 paint 覆盖（移到 scrollback 历史）。
   *
   * 固化操作：tailBuffer.splice(0, N) + cursorRow / renderedRows 各减 N。物理屏幕
   * 上"固化的 N 行"位置不变，但 frame 起点（cursor up 上限）下移 N 行。下次 paintFrame
   * cursor up cursorRow（已减少 N）正好上移到新 frame 起点，从那里开始覆盖。
   */
  private freezeIfTooLong(): void {
    if (this.tailBuffer.length <= MAX_TAIL_LINES) return;
    const freezeCount = this.tailBuffer.length - KEEP_TAIL_LINES;
    this.tailBuffer.splice(0, freezeCount);
    this.cursorRow = Math.max(0, this.cursorRow - freezeCount);
    this.renderedRows = Math.max(0, this.renderedRows - freezeCount);
  }

  /**
   * 全帧差分 paint——单次 stdout.write 覆盖整个 frame（tailBuffer + chrome）。
   *
   * 流程：
   *   1. cursor up cursorRow → frame 起点
   *   2. \r → 行首
   *   3. 逐行 \x1b[2K（清整行）+ 内容；行间 \n。保留 max(oldRows, newRows) 占用避免
   *      行数收缩闪烁，多余旧行用 \x1b[2K 清空
   *   4. 移光标到 input cursor 位置
   *
   * 单次 stdout.write 让 TTY 在一帧内处理完整 ANSI 序列——不会被分帧 render 出"擦后写"
   * 的过渡空白。
   */
  private paintFrame(): void {
    const allLines: string[] = [];
    for (const line of this.tailBuffer) allLines.push(line);
    for (const line of this.statusLines) allLines.push(line);
    const inputStartRow = allLines.length;
    if (this.input) {
      for (const line of this.input.renderLines()) allLines.push(line);
    }

    const oldRows = this.renderedRows;
    const newRows = allLines.length;

    if (oldRows === 0 && newRows === 0) {
      this.cursorRow = 0;
      return;
    }

    let buf = "";
    let writtenRows: number;

    if (oldRows === 0) {
      // 第一次 paint——光标当前在 caller 决定的位置（通常是终端 prompt 之后的新行行首）
      // 直接逐行写新内容，不写 \x1b[2K（避免误擦 caller 已写到光标位置的内容）
      for (let i = 0; i < newRows; i++) {
        buf += allLines[i]!;
        if (i < newRows - 1) buf += "\n";
      }
      writtenRows = newRows;
    } else {
      // 已有 frame：cursor up 到 frame 起点 + 逐行 \x1b[2K + 写新内容
      buf += ansiCursorUp(this.cursorRow);
      buf += ANSI_CARRIAGE_RETURN;

      const totalRows = Math.max(oldRows, newRows);
      for (let i = 0; i < totalRows; i++) {
        buf += ANSI_ERASE_LINE;
        if (i < newRows) buf += allLines[i]!;
        if (i < totalRows - 1) buf += "\n";
      }
      writtenRows = totalRows;
    }

    // 移光标到 input cursor 位置（在 chromeStartRow + statusLines.length + pos.row 行）
    if (this.input && newRows > 0) {
      const pos = this.input.cursorPosition();
      const targetRow = inputStartRow + pos.row;
      buf += moveCursorWithinRegion(writtenRows, targetRow, pos.col);
      this.cursorRow = targetRow;
    } else {
      this.cursorRow = Math.max(0, writtenRows - 1);
    }

    this.renderedRows = writtenRows;
    this.stdout.write(buf);
  }
}

export function createScreenController(
  options: ScreenControllerOptions = {},
): ScreenController {
  return new ScreenControllerImpl(options);
}
