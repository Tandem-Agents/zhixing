/** Pure text presentation primitives shared by Node adapters and text commands. */
export { tone, icon, glyph, layout, getTerminalWidth, getTerminalHeight } from "./style.js";
export { ANSI, stripAnsi, osc8Hyperlink } from "./ansi.js";
export { charWidth, clampLine, padEndDisplay, stringWidth, wrapToWidth } from "./line-width.js";
export type { KeyEvent } from "./key-event.js";
export type { SelectCancelCause, SelectOption, SelectResult } from "./select-types.js";
export * from "./selection/index.js";
