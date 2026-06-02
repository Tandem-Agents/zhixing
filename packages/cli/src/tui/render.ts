/**
 * 渲染层：双缓冲帧累积 + 屏幕/光标控制 + 同步输出。
 *
 * 视觉构造（chrome / button / pill 等）由 `tui/*` primitive 完成——
 * 此 Renderer 只负责"把字符串攒起来一次性写出去"，无任何渲染语义。
 *
 * 双缓冲必要性：TTY 上 process.stdout.write 是 sync syscall，多次串联 write
 * 会让终端边接收边渲染——大面板按键移动时整屏闪烁。一次性 write 整帧 + 同步
 * 输出 ANSI 序列让支持的终端缓存 BSU..ESU 之间的输出一次性 render，零闪烁。
 */

import { getTerminalHeight, getTerminalWidth } from "./style.js";

const ANSI = {
  /** 光标到 (1,1) 后清光标至屏幕末尾——不滚动到 scrollback（vs `\x1b[2J` 在 Windows Terminal 会滚动） */
  CURSOR_HOME_ERASE: "\x1b[H\x1b[J",
  CURSOR_HIDE: "\x1b[?25l",
  CURSOR_SHOW: "\x1b[?25h",
  /** 切换到 alternate screen buffer——main buffer（含 scrollback）冻结，TUI 渲染独立画布 */
  ENTER_ALT_SCREEN: "\x1b[?1049h",
  /** 切回 main screen buffer——alternate buffer 内容消失，用户原终端状态完整恢复 */
  EXIT_ALT_SCREEN: "\x1b[?1049l",
  /**
   * 撤销 DECSTBM 滚动区（恢复全屏滚动）：CSI r。进 alt buffer 后立即发——见
   * enterAlternateScreen docstring（撤掉从 main buffer 继承的滚动区，否则写满屏触发硬件滚动）。
   */
  DECSTBM_RESET: "\x1b[r",
  /**
   * Synchronized Output Begin / End——告诉终端在 BSU..ESU 之间的输出累积后一次性
   * render，避免分段闪烁。不支持的终端忽略此序列，等同无优化。
   * 行业标准：iTerm2 / kitty / Windows Terminal / mintty 等均支持。
   */
  SYNC_BEGIN: "\x1b[?2026h",
  SYNC_END: "\x1b[?2026l",
} as const;

export class Renderer {
  /** 累积的 frame 内容——flush() 一次性写入 stdout */
  private buffer: string[] = [];

  constructor(private readonly stdout: NodeJS.WritableStream) {}

  /** 清屏 + 光标到 (1,1)——每次重绘前调用 */
  clear(): void {
    this.buffer.push(ANSI.CURSOR_HOME_ERASE);
  }

  /**
   * 进入 alternate screen buffer——TUI 行业标准，避免污染用户原终端 scrollback。
   *
   * 进 alt buffer 后**立即撤销 DECSTBM 滚动区**(`\x1b[r`)。背景:主 REPL 跑在 main buffer +
   * DECSTBM 模式,把滚动区限制在 [1, scrollBottom](底部留给输入 chrome)。DECSTBM 是否随
   * alt-screen 切换重置是 implementation-defined —— Windows ConPTY 会让它**跨 buffer 继承**
   * (实测:不撤则 alt buffer 顶上 L1 被滚掉,撤后 L1 归位)。于是 alt buffer 里写满整屏会在
   * 继承的 region 底触发硬件滚动、把顶部内容滚出(skill editor "内容向上跑 / 顶部消失"的根因)。
   * alt buffer 独占整屏、本就不该有滚动区,显式重置为全屏。
   *
   * 退出对称性:**不**在 exitAlternateScreen 反向重设 —— ConPTY alt buffer 是 per-buffer 语义
   * (alt 内的滚动 / DECSTBM 改动不波及 main),退出回 main buffer 后主 REPL 的 DECSTBM 由终端
   * 原样恢复;此处若反向 emit 反而会撤掉 main 的滚动区、破坏主 REPL chrome 永驻。
   */
  enterAlternateScreen(): void {
    this.buffer.push(ANSI.ENTER_ALT_SCREEN, ANSI.DECSTBM_RESET);
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

  /**
   * 写入一整帧(满屏分区布局)—— 行间用 \n 连接、**末尾不带换行**。写满终端高度时末尾的 \n
   * 会把光标推到下一行、触发滚动;不带末尾 \n 让光标停在最后一行末,配合下一帧 clear() 回
   * (1,1) 清屏,实现"固定底部 / 满屏"而不抖。
   *
   * 前提:alt buffer 已撤销 DECSTBM 滚动区(见 enterAlternateScreen)。否则写满整屏会在继承自
   * main buffer 的滚动区底触发硬件滚动,顶部内容被滚出 —— 这才是 skill editor 滚动的真根因
   * (一度误判为满宽行 DECAWM auto-wrap,实测证伪:撤 DECSTBM 后满高满宽帧 L1~L38 严丝合缝不滚)。
   */
  writeFrame(lines: readonly string[]): void {
    this.buffer.push(lines.join("\n"));
  }

  /** 写入文本但不换行——用于让光标停在文本末尾（如输入面板的 `> _`） */
  writeRaw(text: string): void {
    this.buffer.push(text);
  }

  /** 终端列数——所有 chrome / 列表 / 按钮 / footer 都按整宽渲染 */
  terminalWidth(): number {
    return getTerminalWidth(this.stdout);
  }

  /** 终端行数——分区布局(固定顶/底 + 滚动中间)按整高渲染。 */
  terminalHeight(): number {
    return getTerminalHeight(this.stdout);
  }

  /**
   * 光标上移 n 行——`writeRaw` 已写完所有内容后回跳 cursor 到指定行（如 input panel
   * 把 buffer 写在 footer 上面、最后回跳 cursor 到 buffer 末尾让用户看到光标）。
   */
  moveCursorUp(rows: number): void {
    if (rows > 0) this.buffer.push(`\x1b[${rows}A`);
  }

  /** 光标移到当前行的指定列（1-based）——配合 moveCursorUp 做绝对定位 */
  setCursorColumn(col: number): void {
    if (col >= 1) this.buffer.push(`\x1b[${col}G`);
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
}
