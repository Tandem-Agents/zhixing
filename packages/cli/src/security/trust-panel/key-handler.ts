/**
 * /trust 面板键盘事件 → action 映射 —— 纯函数，不接触 state / stdin。
 *
 * 按键规约（参考设计文档的"↑↓ / d / ESC"，按 zhixing 既有交互纪律对齐）：
 *   - ↑ / ↓        切换选中
 *   - d            撤销当前选中（双击协议：第一次标 pending、第二次确认；状态机
 *                  由 reducer 维护，本层只把按键翻译成同一个 request-delete action）
 *   - ESC          退出面板
 *   - Ctrl+C       退出面板（与 ESC 同语义，覆盖用户习惯）
 *
 * 未识别按键返回 null —— controller 据此 swallow 不重绘。
 */

import type { Key } from "node:readline";
import type { TrustPanelAction } from "./state.js";

export function mapKey(key: Key | undefined): TrustPanelAction | null {
  if (!key) return null;

  if (key.ctrl && key.name === "c") return { kind: "exit" };
  if (key.ctrl) return null;

  switch (key.name) {
    case "up":
      return { kind: "move", delta: -1 };
    case "down":
      return { kind: "move", delta: 1 };
    case "d":
      return { kind: "request-delete" };
    case "escape":
      return { kind: "exit" };
    default:
      return null;
  }
}
