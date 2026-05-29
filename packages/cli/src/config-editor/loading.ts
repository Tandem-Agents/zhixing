/**
 * loading 态执行器 —— 把同步面板循环接入异步任务（discovery 验证 / LLM 推断）。
 *
 * runner 收到 `loading` action 时调 runLoadingAction：渲染 loading 态、跑 `run(signal)`，
 * 同时监听取消键。任务先完成则用其结果继续；Esc 取消、Ctrl+C 退出，都会 abort 任务。
 *
 * 单消费者队列陷阱：把"等按键"与任务 race，任务先赢时那次 `stream.next` 的 waiter 会悬挂、
 * 吞掉 loading 结束后的第一个按键。故对按键等待用独立 keyController，finally 里 abort 之
 * 摘除悬挂 waiter（依赖 KeyEventStream.next(signal) 的可取消语义）。
 */

import type { PanelAction } from "./types.js";
import {
  Renderer,
  renderChrome,
  renderFooter,
  type KeyEvent,
  type KeyEventStream,
} from "../tui/index.js";

const LOADING_FOOTER_HINTS = ["Esc 取消", "Ctrl+C 退出"] as const;

/** loading 态屏：标题 + 提示 + 取消脚注（无光标）。 */
export function renderLoadingFrame(renderer: Renderer, message: string): void {
  renderer.clear();
  renderer.hideCursor();
  const width = renderer.terminalWidth();
  renderer.writeLines(renderChrome({ title: "请稍候", body: [message], width }));
  renderer.writeLine("");
  renderer.writeLines(renderFooter({ width, hints: LOADING_FOOTER_HINTS }));
}

type LoadingAction = Extract<PanelAction, { type: "loading" }>;

/** 取下一个按键；signal abort 时解析为 null（不抛），便于 race 后清理。 */
function nextKeyOrNull(
  stream: KeyEventStream,
  signal: AbortSignal,
): Promise<KeyEvent | null> {
  return stream.next(signal).then(
    (key) => key,
    () => null,
  );
}

/**
 * 执行 loading action，返回其异步任务产出的下一步 PanelAction。
 *
 * - task 先完成 → 返回它（可能又是 loading，由 runner 续跑）
 * - Esc → abort 任务，pop 回上一面板
 * - Ctrl+C → abort 任务，退出编辑器
 * - 其它键 → 忽略、重渲染 loading 继续等
 */
export async function runLoadingAction(
  action: LoadingAction,
  stream: KeyEventStream,
  renderLoading: (message: string) => void,
): Promise<PanelAction> {
  const taskController = new AbortController();
  const keyController = new AbortController();
  // 当前显示的步骤——task 可经 report 更新（多阶段进度）；忽略键重渲染也用它，不回退初始。
  let currentMessage = action.message;
  const report = (message: string): void => {
    currentMessage = message;
    renderLoading(message);
  };
  renderLoading(currentMessage);

  const taskWon = action
    .run(taskController.signal, report)
    .then((next) => ({ tag: "task" as const, next }));

  try {
    while (true) {
      const winner = await Promise.race([
        taskWon,
        nextKeyOrNull(stream, keyController.signal).then((key) => ({
          tag: "key" as const,
          key,
        })),
      ]);

      if (winner.tag === "task") return winner.next;

      const key = winner.key;
      if (key === null) continue; // signal 已 abort（仅 finally 触发，循环内不可达）
      if (key.type === "ctrl-c") {
        taskController.abort();
        return { type: "exit", result: { kind: "cancelled" } };
      }
      if (key.type === "escape") {
        taskController.abort();
        return { type: "pop", state: action.state };
      }
      // 其它键在 loading 期间无意义 —— 忽略、重渲染后继续等（保留当前步骤，不回退初始）
      renderLoading(currentMessage);
    }
  } finally {
    // 摘除可能悬挂的 stream.next waiter，避免吞掉 loading 结束后的第一个按键
    keyController.abort();
  }
}
