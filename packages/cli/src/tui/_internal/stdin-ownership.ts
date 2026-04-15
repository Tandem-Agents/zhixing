/**
 * Stdin 独占 —— 组件临时摘除所有现有 'keypress' 监听器，结束后按原序恢复
 *
 * 问题背景（spec §6.4 陷阱 3 真实复现的 bug）：调用方（典型：REPL 的
 * `readline.Interface({ terminal: true })`）会在 stdin 上挂一个内部
 * 'keypress' 监听器用于行编辑 + echo 可打印字符。即便调用方 `rl.pause()`，
 * 这个监听器也**不会被 detach** —— Node.js 没有公开这种 API，`pause()`
 * 只翻 readline 的 `paused` 标志位让它停止处理 line 事件，但 `_ttyWrite`
 * 对这个标志位不闻不问，照常 echo 字符。
 *
 * 一旦我们（TUI 组件）`stdin.resume()` 让数据流恢复 flowing，readline
 * 预挂的监听器就会和我们自己的监听器一起收到 keypress，用户在 input 模式
 * 里每打一个字符都会被 readline 在面板外的 cursor 位置 echo 一次 —— 视觉上
 * 呈现为"字符叠在面板下方"的混乱。
 *
 * 解法：组件自己保证独占 stdin。进入时 snapshot 'keypress' 的现有监听器
 * 并全部摘掉，退出时按原序恢复。**保守地只动 'keypress' 事件** —— 'data'
 * 是 `readline.emitKeypressEvents` 的解码器挂的（'data' → 'keypress'），
 * 动它会让我们自己也收不到 keypress。
 *
 * 使用者注意：如果组件在 acquire 之后又自己挂了一个 'keypress' 监听器，
 * 组件必须在 `release()` 之前先把自己的监听器 `off` 掉 —— 否则恢复的
 * saved listeners 会和组件自己的 listener 并存。
 */

import * as readline from "node:readline";

export interface StdinOwnershipHandle {
  /** 释放独占，恢复 snapshot 的 listeners。幂等。 */
  release(): void;
}

// 本类型和 Node 内部 keypress 监听器签名一致 —— `(str, key)`。
// 因为我们只做原样 snapshot+restore，不调用它们，签名宽松化为 unknown[]。
type KeypressListener = (...args: unknown[]) => void;

/**
 * 获取 stdin 的 'keypress' 独占权。
 *
 * 步骤：
 *   1. 调用 `readline.emitKeypressEvents(stdin)` 确保 'data' → 'keypress'
 *      的解码器已安装（幂等）。
 *   2. Snapshot 当前 'keypress' 监听器（**拷贝**，不是引用）。
 *   3. 用 `removeAllListeners('keypress')` 全部摘除。
 *   4. 返回的 handle.release() 按原序把 saved listeners 重新 `on` 回去。
 */
export function acquireStdinOwnership(
  stdin: NodeJS.ReadStream,
): StdinOwnershipHandle {
  // 1. 确保 decoder 就位（幂等）
  readline.emitKeypressEvents(stdin);

  // 2. Snapshot（slice 产生独立数组，即使后续 stdin listeners 变动也不影响）
  let savedListeners: KeypressListener[] = [];
  if (typeof stdin.listeners === "function") {
    savedListeners = stdin.listeners("keypress").slice() as KeypressListener[];
  }

  // 3. 全部摘除
  if (typeof stdin.removeAllListeners === "function") {
    stdin.removeAllListeners("keypress");
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      if (typeof stdin.on === "function") {
        for (const listener of savedListeners) {
          stdin.on("keypress", listener);
        }
      }
    },
  };
}
