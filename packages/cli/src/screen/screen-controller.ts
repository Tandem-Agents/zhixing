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
 * **行固化（freeze）—— viewport 硬约束**：
 *   frame buffer 总行数永远 ≤ 终端 viewport 行数 - 安全 margin。append / status / input
 *   变化后立即检查，超出立即固化最早的 tailBuffer 行（cursor up + write + \n 主动推入
 *   永久 scrollback），保证 paintFrame 的 cursor up 永远在 viewport 内，不触发滚动。
 *
 *   反例（fix 前）：MAX_TAIL_LINES = 50 是绝对值，超大多数终端可视行数（24-40），frame
 *   超 viewport 时 cursor up 被截断 + paint 末尾 \n 触发滚动 → 上一帧内容部分推入
 *   scrollback → 下一帧重复 → scrollback 累积重复副本。
 *
 * **使用约定**：
 *   - cli REPL 模式启动一个 ScreenController，持续到 REPL 结束
 *   - 写到 stdout 的所有 caller 必须经此协调，禁止直接 process.stdout.write
 *   - 输入区状态变化通过 requestInputRepaint 触发重画
 *   - 状态条更新通过 setStatusBar
 *   - 接口语义：
 *     - withScrollWrite —— 流式接续（如 LLM chunk），直接追加到 tailBuffer 末尾行
 *     - writeScrollLine —— 独立段（如完成态卡片 / 异步通知），保证起新行避免与流式段粘连
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
  /**
   * 写入一段独立内容——保证起新行起手。
   *
   * 与 withScrollWrite 区别：后者是流式接续语义（chunk 直接追加到 tailBuffer 末尾行），
   * 本方法是独立段语义——若 tailBuffer 当前在行接续中（最后一行未以 \n 结尾），
   * 先补 \n 切到新行再写 text，确保异步段（slash 命令输出 / 完成态卡片 / scheduler
   * 通知 / retry 警告等）不会与正在进行的流式 chunk 粘连成同一行。
   *
   * text 自动确保末尾 \n 落地；空字符串等价"写一空行"。
   */
  writeScrollLine(text: string): void;
  /** 触发输入区重画——用于按键后 buffer / panel 变化通知屏幕刷新。 */
  requestInputRepaint(): void;
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
 * 终端 viewport 兜底——读取 stdout.rows 失败时（CI / pipe / 异常 TTY）的最小可用行数。
 * 24 是经典 VT100 行高，几乎所有现代终端都不低于此值。
 */
const FALLBACK_VIEWPORT_ROWS = 24;
/**
 * frame 高度上限相对 viewport 的安全余量——避免 paint 末尾 \n 在屏幕最后一行触发滚动。
 * viewport 必须 ≥ FRAME_MIN_ROWS 才能正常工作（status + input 自身可能占多行）。
 */
const FRAME_SAFETY_MARGIN = 1;
/** frame 高度下限——viewport 极小时也保留这么多行可用（极端窄终端 fallback） */
const FRAME_MIN_ROWS = 8;

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
  /** 解绑 stdout resize listener 的 closure，dispose 时调用清理 */
  private detachResize: (() => void) | null = null;

  constructor(options: ScreenControllerOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.attachResizeListener();
  }

  /**
   * 监听终端 resize——viewport 变化后旧 cursorRow / renderedRows 不再可靠
   * （cursor up 在新 viewport 下可能被截断），重置 frame 状态让下次 paint 走"首次
   * paint"分支重新画完整 frame。残留旧内容由新 paint 覆盖或滚出，避免重复推送 bug。
   */
  private attachResizeListener(): void {
    const stream = this.stdout as unknown as {
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    };
    if (typeof stream.on !== "function") return;
    const listener = (): void => {
      if (this.disposed) return;
      this.enqueue(() => {
        this.cursorRow = 0;
        this.renderedRows = 0;
        this.paintFrame();
      });
    };
    stream.on("resize", listener);
    this.detachResize = () => {
      stream.off?.("resize", listener);
    };
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
    });
  }

  writeScrollLine(text: string): void {
    this.enqueue(() => {
      if (text.length === 0) {
        // 空字符串语义：写一空行
        this.appendToTail("\n");
      } else {
        // 独立段保证：若 tailBuffer 末尾在行接续中（非空字符串），先补 \n 切到新行——
        // 避免与流式 chunk 粘连（典型场景：LLM appendInline 期间 retry warn / scheduler
        // 通知插入 writeScrollLine，没有此保证会让通知拼到 chunk 末尾形成 "chunk text⚠ warn" 同行）
        const lastIndex = this.tailBuffer.length - 1;
        const inMidLine =
          lastIndex >= 0 && this.tailBuffer[lastIndex]!.length > 0;
        if (inMidLine) this.appendToTail("\n");
        const finalText = text.endsWith("\n") ? text : text + "\n";
        this.appendToTail(finalText);
      }
      this.paintFrame();
    });
  }

  requestInputRepaint(): void {
    this.enqueue(() => {
      this.paintFrame();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.detachResize?.();
    this.detachResize = null;
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
   * 当前终端 viewport 内允许的 frame 最大高度——硬约束。
   *
   * 读 stdout.rows，留 safety margin 避免末尾 \n 触发滚动；不可读时 fallback 到
   * VT100 经典 24 行；极小终端走 FRAME_MIN_ROWS 兜底。
   */
  private getMaxFrameRows(): number {
    const rows = (this.stdout as NodeJS.WriteStream).rows;
    const usable =
      typeof rows === "number" && rows > 0 ? rows : FALLBACK_VIEWPORT_ROWS;
    return Math.max(FRAME_MIN_ROWS, usable - FRAME_SAFETY_MARGIN);
  }

  /**
   * 检查 tailBuffer + statusLines + input 总行数是否超出 viewport 上限——超出则
   * 把最早的若干 tailBuffer 行主动推入永久 scrollback（cursor up + write + \n），
   * 让 frame 永远在 viewport 内可被 paintFrame 安全 cursor up 覆盖。
   *
   * 返回 ANSI prefix string 由 caller 合并到下一次 paintFrame 的 buf，单次 stdout.write
   * 完成 freeze + paint，不在 TTY 间隙暴露中间状态。
   *
   * 物理屏幕语义：
   *   - 旧 frame_start 物理位置：cursor 当前位置 - cursorRow
   *   - cursor up cursorRow → cursor 在旧 frame_start
   *   - write freezeCount 行 + \n —— 这些行原本在同位置（上次 paint 已写过），现在
   *     被同内容覆盖（视觉无变化），但语义上"frame 起点"下移 freezeCount 行
   *   - cursor 现在在第 freezeCount 行 = 新 frame_start
   *   - cursorRow = 0（cursor 已在新 frame 起点）
   *   - renderedRows -= freezeCount（frame 高度缩短）
   *
   * 数据结构：tailBuffer.splice(0, freezeCount) 把固化行移出，下次 paint 不再重画。
   */
  private freezeOverflowToScrollback(): string {
    const inputLines = this.input ? this.input.renderLines().length : 0;
    const totalRows =
      this.tailBuffer.length + this.statusLines.length + inputLines;
    const maxRows = this.getMaxFrameRows();
    if (totalRows <= maxRows) return "";

    const overflow = totalRows - maxRows;
    // 只能固化 tailBuffer 行——status / input 是 frame 永驻区，不固化
    const freezeCount = Math.min(overflow, this.tailBuffer.length);
    if (freezeCount === 0) return "";

    let buf = "";
    if (this.cursorRow > 0) {
      buf += ansiCursorUp(this.cursorRow);
      buf += ANSI_CARRIAGE_RETURN;
    }
    for (let i = 0; i < freezeCount; i++) {
      buf += ANSI_ERASE_LINE + this.tailBuffer[i]! + "\n";
    }

    this.tailBuffer.splice(0, freezeCount);
    this.cursorRow = 0;
    this.renderedRows = Math.max(0, this.renderedRows - freezeCount);
    return buf;
  }

  /**
   * 全帧差分 paint——单次 stdout.write 覆盖整个 frame（tailBuffer + chrome）。
   *
   * 流程：
   *   1. 先 freezeOverflowToScrollback：保证 frame ≤ viewport，超出部分主动推入 scrollback
   *   2. cursor up cursorRow → frame 起点（保证在 viewport 内不被截断）
   *   3. \r → 行首
   *   4. 逐行 \x1b[2K（清整行）+ 内容；行间 \n。保留 max(oldRows, newRows) 占用避免
   *      行数收缩闪烁，多余旧行用 \x1b[2K 清空
   *   5. 移光标到 input cursor 位置
   *
   * 单次 stdout.write 让 TTY 在一帧内处理完整 ANSI 序列——不会被分帧 render 出"擦后写"
   * 的过渡空白。
   */
  private paintFrame(): void {
    const freezePrefix = this.freezeOverflowToScrollback();

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
      if (freezePrefix.length > 0) this.stdout.write(freezePrefix);
      return;
    }

    let buf = freezePrefix;
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
