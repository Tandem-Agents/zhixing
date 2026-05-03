/**
 * 渲染层：清屏 + ANSI 控制 + 通用渲染 helpers。
 *
 * 策略：双缓冲 —— 所有 write 操作累积到内部 string buffer，由 caller（runner.ts）
 * 在每帧渲染完成后调一次 flush() 一次性 write 到 stdout。
 *
 * 为什么需要双缓冲：TTY stream 在 process.stdout 是 sync write，每次 stdout.write
 * 直接 syscall 到终端。多次串联 write 会让终端边接收边 render，视觉上分段刷新——
 * 大面板（20+ 行内容）按键移动时整屏闪烁。一次性 write 整帧 + 同步输出 ANSI 序列
 * 让支持的终端缓存 BSU..ESU 之间的输出一次性 render，零闪烁。
 */

import type { Status, StatusLevel } from "../types.js";

const ANSI = {
  /** 光标到 (1,1) 后清光标至屏幕末尾——不滚动到 scrollback（vs `\x1b[2J` 在 Windows Terminal 会滚动） */
  CURSOR_HOME_ERASE: "\x1b[H\x1b[J",
  CURSOR_HOME: "\x1b[H",
  CURSOR_HIDE: "\x1b[?25l",
  CURSOR_SHOW: "\x1b[?25h",
  /** 切换到 alternate screen buffer——main buffer（含 scrollback）冻结，TUI 渲染独立画布 */
  ENTER_ALT_SCREEN: "\x1b[?1049h",
  /** 切回 main screen buffer——alternate buffer 内容消失，用户原终端状态完整恢复 */
  EXIT_ALT_SCREEN: "\x1b[?1049l",
  /**
   * Synchronized Output Begin / End——告诉终端在 BSU..ESU 之间的输出累积后一次性
   * render，避免分段闪烁。不支持的终端忽略此序列，等同无优化。
   * 行业标准：iTerm2 / kitty / Windows Terminal / mintty 等均支持。
   */
  SYNC_BEGIN: "\x1b[?2026h",
  SYNC_END: "\x1b[?2026l",
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  CYAN: "\x1b[36m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  RED: "\x1b[31m",
} as const;

export class Renderer {
  /** 累积的 frame 内容——flush() 一次性写入 stdout */
  private buffer: string[] = [];

  constructor(private readonly stdout: NodeJS.WritableStream) {}

  /** 清屏 + 光标到 (1,1)——每次重绘前调用 */
  clear(): void {
    this.buffer.push(ANSI.CURSOR_HOME_ERASE);
  }

  /** 进入 alternate screen buffer——TUI 行业标准，避免污染用户原终端 scrollback */
  enterAlternateScreen(): void {
    this.buffer.push(ANSI.ENTER_ALT_SCREEN);
  }

  /** 退出 alternate screen buffer——用户原终端状态完整恢复 */
  exitAlternateScreen(): void {
    this.buffer.push(ANSI.EXIT_ALT_SCREEN);
  }

  /** 隐藏光标——进入面板时调用，避免列表导航时光标随机跳 */
  hideCursor(): void {
    this.buffer.push(ANSI.CURSOR_HIDE);
  }

  /** 显示光标——退出编辑器或进入输入面板时调用 */
  showCursor(): void {
    this.buffer.push(ANSI.CURSOR_SHOW);
  }

  writeLine(text: string): void {
    this.buffer.push(text + "\n");
  }

  writeLines(lines: readonly string[]): void {
    for (const line of lines) {
      this.buffer.push(line + "\n");
    }
  }

  /** 写入文本但不换行——用于让光标停在文本末尾（如输入面板的 `> _`） */
  writeRaw(text: string): void {
    this.buffer.push(text);
  }

  /** 写入分隔线 */
  separator(): void {
    this.buffer.push("─".repeat(60) + "\n");
  }

  /**
   * 把累积的 buffer 一次性写入 stdout，包裹同步输出 ANSI 序列减少终端分段刷新。
   * caller（runner.ts）每帧渲染完成 / setup / teardown 各调一次。
   */
  flush(): void {
    if (this.buffer.length === 0) return;
    const frame = this.buffer.join("");
    this.buffer = [];
    this.stdout.write(ANSI.SYNC_BEGIN + frame + ANSI.SYNC_END);
  }

  // ─── 文本格式化 helpers（返回字符串，不写入 buffer） ───

  bold(text: string): string {
    return `${ANSI.BOLD}${text}${ANSI.RESET}`;
  }

  dim(text: string): string {
    return `${ANSI.DIM}${text}${ANSI.RESET}`;
  }

  cyan(text: string): string {
    return `${ANSI.CYAN}${text}${ANSI.RESET}`;
  }

  green(text: string): string {
    return `${ANSI.GREEN}${text}${ANSI.RESET}`;
  }

  yellow(text: string): string {
    return `${ANSI.YELLOW}${text}${ANSI.RESET}`;
  }

  red(text: string): string {
    return `${ANSI.RED}${text}${ANSI.RESET}`;
  }

  /**
   * 把文本包装成可点击超链接（OSC 8 协议）。支持的终端（iTerm2 / Windows Terminal /
   * kitty / mintty 等）会渲染成可点击；不支持的终端忽略转义、只看到原文，行为安全。
   */
  hyperlink(url: string, text?: string): string {
    return `\x1b]8;;${url}\x1b\\${text ?? url}\x1b]8;;\x1b\\`;
  }

  /**
   * 列表项行：▸ 高亮 / 空格占位 + 标签 + 右侧副文本。
   *
   * `secondary` 副文本两种用法（无 info-level 概念，靠类型区分）：
   *   - Status 对象：业务状态——按 level 染色（ready=绿/pending=黄/disabled=灰）
   *   - 纯字符串：辅助描述（如选项的 description）——dim 灰显，无业务状态
   *
   * 不传 = 纯标签项（如按钮）。
   */
  listItem(
    selected: boolean,
    label: string,
    secondary?: Status | string,
  ): string {
    const cursor = selected ? this.cyan("▸") : " ";
    const labelText = selected ? this.bold(label) : label;
    if (secondary !== undefined) {
      const text = typeof secondary === "string" ? secondary : secondary.text;
      const colored =
        typeof secondary === "string"
          ? this.dim(text)
          : this.colorByLevel(text, secondary.level);
      return `  ${cursor} ${labelText}${" ".repeat(Math.max(2, 40 - label.length))}${colored}`;
    }
    return `  ${cursor} ${labelText}`;
  }

  private colorByLevel(text: string, level: StatusLevel): string {
    switch (level) {
      case "ready":
        return this.green(text);
      case "pending":
        return this.yellow(text);
      case "disabled":
        return this.dim(text);
    }
  }
}
