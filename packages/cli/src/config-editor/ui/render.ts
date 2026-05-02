/**
 * 渲染层：清屏 + ANSI 控制 + 通用渲染 helpers。
 *
 * 策略：每次状态变化全屏清空 + 重绘——简单可靠，业界 CLI 工具（pnpm setup 等）通用做法。
 * 现代终端速度快，无视觉闪烁。不引入 diff-based 增量渲染（不值得复杂度）。
 */

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
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  CYAN: "\x1b[36m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  RED: "\x1b[31m",
} as const;

export class Renderer {
  constructor(private readonly stdout: NodeJS.WritableStream) {}

  /** 清屏 + 光标到 (1,1)——每次重绘前调用 */
  clear(): void {
    this.stdout.write(ANSI.CURSOR_HOME_ERASE);
  }

  /** 进入 alternate screen buffer——TUI 行业标准，避免污染用户原终端 scrollback */
  enterAlternateScreen(): void {
    this.stdout.write(ANSI.ENTER_ALT_SCREEN);
  }

  /** 退出 alternate screen buffer——用户原终端状态完整恢复 */
  exitAlternateScreen(): void {
    this.stdout.write(ANSI.EXIT_ALT_SCREEN);
  }

  /** 隐藏光标——进入面板时调用，避免列表导航时光标随机跳 */
  hideCursor(): void {
    this.stdout.write(ANSI.CURSOR_HIDE);
  }

  /** 显示光标——退出编辑器或进入输入面板时调用 */
  showCursor(): void {
    this.stdout.write(ANSI.CURSOR_SHOW);
  }

  writeLine(text: string): void {
    this.stdout.write(text + "\n");
  }

  writeLines(lines: readonly string[]): void {
    for (const line of lines) {
      this.stdout.write(line + "\n");
    }
  }

  /** 写入分隔线 */
  separator(): void {
    this.writeLine("─".repeat(60));
  }

  // ─── 文本格式化 helpers ───

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

  /** 列表项行：> 高亮 / 空格占位 + 标签 + 右侧状态 */
  listItem(selected: boolean, label: string, status?: string): string {
    const cursor = selected ? this.cyan("▸") : " ";
    const labelText = selected ? this.bold(label) : label;
    if (status) {
      return `  ${cursor} ${labelText}${" ".repeat(Math.max(2, 40 - label.length))}${this.dim(status)}`;
    }
    return `  ${cursor} ${labelText}`;
  }
}
