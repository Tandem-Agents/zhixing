/**
 * 屏幕协调器——cli 交互模式下所有写到屏幕的逻辑必须经此协调。
 *
 * 三区屏幕模型：
 *   ┌────────────────────────────────┐
 *   │  Scroll Region                 │   AI 输出 / 工具行 / 历史 turn
 *   │  ...                           │   累积向上，保留 scrollback
 *   ├────────────────────────────────┤
 *   │  Status Bar (0..N 行)          │   动态状态条（仅活跃 turn 显示）
 *   ├────────────────────────────────┤
 *   │  Input Region                  │   持久输入区（chrome + buffer + panel）
 *   └────────────────────────────────┘
 *
 * 不变量：
 *   - 屏幕末尾永远是 "状态条 (可选) + 输入区"，输入区永远在屏幕底部
 *   - 任何写入都先擦除状态条 + 输入区，写完后重画两者
 *   - 写入串行化（FIFO）——多源异步触发不会让 ANSI 序列穿插
 *
 * 使用约定：
 *   - cli REPL 模式启动一个 ScreenController，持续到 REPL 结束
 *   - 写到 stdout 的所有 caller（output-renderer / scheduler 通知 / retry / compact / interrupt 等）
 *     必须经 withScrollWrite，禁止直接 process.stdout.write
 *   - 输入区状态变化（按键改 buffer 等）通过 requestInputRepaint 触发重画
 *   - 状态条更新通过 setStatusBar
 */

import {
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
   * ScreenController 自动擦除下方 + 写入 + 重画状态条 / 输入区。
   * 写入末尾若无 \n 自动补一个，让状态条 / 输入区从新行开始。
   */
  withScrollWrite(fn: (write: (chunk: string) => void) => void): void;
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

class ScreenControllerImpl implements ScreenController {
  private readonly stdout: NodeJS.WriteStream;
  private input: InputRegion | null = null;
  private statusLines: readonly string[] = [];
  /** 当前 status + input 区域写到屏幕的总行数（最近一次 repaint 后） */
  private renderedRows = 0;
  /** 当前光标在 status + input 区域内的相对行号（0-based） */
  private cursorRow = 0;
  private readonly queue: QueueTask[] = [];
  private flushing = false;
  private disposed = false;

  constructor(options: ScreenControllerOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
  }

  attachInput(region: InputRegion): void {
    this.enqueue(() => {
      this.eraseBelow();
      this.input = region;
      this.repaintBelow();
    });
  }

  detachInput(): void {
    this.enqueue(() => {
      this.eraseBelow();
      this.input = null;
      this.statusLines = [];
      this.renderedRows = 0;
      this.cursorRow = 0;
    });
  }

  setStatusBar(lines: readonly string[] | null): void {
    this.enqueue(() => {
      this.statusLines = lines ?? [];
      this.eraseBelow();
      this.repaintBelow();
    });
  }

  withScrollWrite(fn: (write: (chunk: string) => void) => void): void {
    this.enqueue(() => {
      this.eraseBelow();
      let collected = "";
      fn((chunk) => {
        collected += chunk;
      });
      if (collected.length > 0) {
        this.stdout.write(collected);
        if (!collected.endsWith("\n")) {
          this.stdout.write("\n");
        }
      }
      this.repaintBelow();
    });
  }

  requestInputRepaint(): void {
    this.enqueue(() => {
      this.eraseBelow();
      this.repaintBelow();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    // 先把清理任务直接入队（绕过 disposed 守卫），再 mark disposed 阻断后续新任务
    this.queue.push({
      run: () => {
        this.eraseBelow();
        this.input = null;
        this.statusLines = [];
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
   * 把光标从当前位置移回 status + input 区域起始行行首，并清除该行至屏幕末。
   * 调用后光标在 (相对行 0, 列 0)，renderedRows 暂时仍记原值；caller 通常紧跟 repaint。
   */
  private eraseBelow(): void {
    if (this.renderedRows === 0) return;
    this.stdout.write(eraseRegion(this.cursorRow));
    this.renderedRows = 0;
    this.cursorRow = 0;
  }

  /**
   * 写状态条 + 输入区。光标最终落在输入区的 buffer 编辑位置。
   */
  private repaintBelow(): void {
    const lines: string[] = [];
    for (const line of this.statusLines) lines.push(line);
    let inputStartRow = lines.length;
    if (this.input) {
      for (const line of this.input.renderLines()) lines.push(line);
    }

    if (lines.length === 0) {
      this.renderedRows = 0;
      this.cursorRow = 0;
      return;
    }

    for (let i = 0; i < lines.length; i++) {
      this.stdout.write(lines[i]!);
      if (i < lines.length - 1) {
        this.stdout.write("\n");
      }
    }
    this.renderedRows = lines.length;

    if (this.input) {
      const pos = this.input.cursorPosition();
      const targetRow = inputStartRow + pos.row;
      const targetCol = pos.col;
      this.stdout.write(
        moveCursorWithinRegion(this.renderedRows, targetRow, targetCol),
      );
      this.cursorRow = targetRow;
    } else {
      this.cursorRow = this.renderedRows - 1;
    }
  }
}

export function createScreenController(
  options: ScreenControllerOptions = {},
): ScreenController {
  return new ScreenControllerImpl(options);
}
