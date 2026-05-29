/**
 * 标准化键盘事件 —— chunk → KeyEvent 由 `key-decoder` 完成。
 *
 * 高层语义(enter / arrow / char 等),不含原始字符或 ANSI 序列。属通用 TUI 原语:
 * config-editor、技能管理器、AI 编辑屏等 alt-screen 交互面共用,均不感知字节级细节。
 */
export type KeyEvent =
  | { type: "char"; ch: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "escape" }
  | { type: "ctrl-c" }
  | { type: "ctrl-s" }
  | { type: "ctrl-e" }
  | { type: "arrow-up" }
  | { type: "arrow-down" }
  | { type: "arrow-left" }
  | { type: "arrow-right" };
