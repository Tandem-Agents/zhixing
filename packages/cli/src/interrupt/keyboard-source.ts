/**
 * KeyboardSource —— REPL agent run 期间 raw-mode keypress 拦截 (Esc / Ctrl+C / 双击 Ctrl+C)
 *
 * 设计要点：
 *
 * - **raw mode 下 Ctrl+C 字节 (0x03) 不会自动转 SIGINT**——tty driver 只在 cooked mode 转。
 *   这是 raw mode 下 Ctrl+C 的唯一处理路径；SignalSource 在 cooked mode (pause / CI /
 *   stdin redirect) 下兜底。两者并存形成双轨制，无论 tty 状态如何用户都能中断。
 *
 * - **复用 acquireStdinOwnership** snapshot/restore keypress listeners，避免 readline 等
 *   预挂的 listener 在 raw mode 期间继续 echo 字符 / 抢 keypress。
 *
 * - **三态机** attach → pause → resume → detach：
 *     - attach: acquireStdinOwnership (snapshot+摘除现有 keypress) + setRawMode(true) + 挂自己 listener
 *     - pause: 卸自己 listener + setRawMode(**false**)，强制切到 cooked，不回 wasRaw
 *       (typeahead 路径 wasRaw 可能就是 true，回去仍 raw → readline.question 完全失灵)
 *       + **release ownership 让 readline 内部 _ttyWrite listener 恢复挂回 stdin**：否则
 *       readline 收不到 keypress → rl.question 永远等不到 line 事件 → securityPrompt 卡死。
 *     - resume: re-acquire ownership (重新摘除 readline pause 期间的 _ttyWrite，防 raw 模式下
 *       两个 listener 同时 echo 字符) + setRawMode(true) + 挂自己 listener
 *     - detach: 卸自己 listener + 恢复 wasRaw + 释放 ownership (pause 状态时已是 null,?. 防御)
 *   pause/resume 是临时让出/收回 stdin，detach 是终态归还，语义不同。
 *
 * - **依赖注入 stdin / now** 让单测能用 PassThrough mock + fake clock，避免真听 process.stdin
 *   导致测试 hang。生产路径默认值不变。
 *
 * - **non-TTY 返 no-op handle** (CI / 管道场景)，让调用方 (REPL securityPrompt 等) 统一走
 *   pause/resume 协议，不必额外判 isTTY。
 */

import { abortWithReason } from "@zhixing/core";
import { acquireStdinOwnership, type StdinOwnershipHandle } from "../tui/_internal/stdin-ownership.js";

export interface KeyboardSourceHandle {
  /**
   * 临时暂停 keypress 拦截 + 退出 raw mode，让 stdin 给 readline.question 等 cooked-mode
   * 调用方使用。pause 期间 KeyboardSource 不响应 Esc / Ctrl+C；SignalSource 仍工作 (兜底)。
   * 幂等。
   */
  pause(): void;
  /** 恢复 raw mode + 重新挂回 keypress 拦截。pause/resume 必须配对使用。幂等。 */
  resume(): void;
  /** 完全释放 keypress ownership 与 raw mode (恢复到 attach 前的初始状态)。幂等。 */
  detach(): void;
}

export interface AttachKeyboardSourceOptions {
  /** abort 触发目标 controller (loop 共享同一 controller，KeyboardSource 只触发不监听) */
  controller: AbortController;
  /**
   * 双击检测回调 —— REPL 自决双击是 exit 还是别的语义。
   * 返回 Promise 表示需要异步执行 (如 exit 清理：等 turn 退出 + scheduler.stop)；
   * KeyboardSource 不 await (fire-and-forget)，REPL 自管 Promise 生命周期。
   */
  onDoublePress: (key: "ctrl-c") => void | Promise<void>;
  /** 双击间隔阈值 (ms)，默认 800 */
  doublePressMs?: number;
  /** stdin 注入，默认 process.stdin (测试可传 PassThrough mock 避免 hang) */
  stdin?: NodeJS.ReadStream;
  /** 时间源注入，默认 Date.now (测试可传 fake clock 精确控制双击窗口) */
  now?: () => number;
}

export function attachKeyboardSource(opts: AttachKeyboardSourceOptions): KeyboardSourceHandle {
  const stdin = opts.stdin ?? process.stdin;
  const now = opts.now ?? Date.now;
  const doublePressMs = opts.doublePressMs ?? 800;

  if (!stdin.isTTY) {
    // non-TTY 环境 (CI、管道) KeyboardSource 不工作，由 SignalSource 兜底。
    // 仍返完整 handle —— pause/resume/detach 是 no-op，让调用方 (securityPrompt 等)
    // 统一 pause/resume 协议在 non-TTY 也能跑通，不必额外判 isTTY。
    return { pause: () => {}, resume: () => {}, detach: () => {} };
  }

  // snapshot + 摘除现有 keypress listener (典型：readline 内部 _ttyWrite，
  // 即便 rl.pause() 也不会被 detach，会在 raw mode 期间继续 echo 字符)。
  // currentOwnership 用 let + nullable: pause 时 release 让 readline 恢复 →
  // null；resume 时 re-acquire 重新独占；detach 时 ?. 防御 pause 状态已为 null。
  let currentOwnership: StdinOwnershipHandle | null = acquireStdinOwnership(stdin);
  const wasRaw = stdin.isRaw;

  // attach 进 raw mode 让 keypress listener 在 agent run 期间拦截 Esc/Ctrl+C
  stdin.setRawMode(true);

  // 双击 Ctrl+C 检测：第一次走 abort，doublePressMs 内第二次走 onDoublePress
  // (第二次不再 abort，因为 abort 协议层幂等，第一次已生效)
  let lastCtrlCAt = 0;

  const onKeypress = (_str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
    if (key.name === "escape") {
      abortWithReason(opts.controller, {
        kind: "user-cancel",
        source: "esc",
        pressedAt: now(),
      });
      return;
    }
    if (key.ctrl && key.name === "c") {
      const t = now();
      if (t - lastCtrlCAt < doublePressMs) {
        // void Promise: callback 可能 async，KeyboardSource 不阻塞 keypress 队列
        // (REPL 在 callback 内 await 完成 exit 清理，自管 Promise 生命周期)
        void opts.onDoublePress("ctrl-c");
        return;
      }
      lastCtrlCAt = t;
      abortWithReason(opts.controller, {
        kind: "user-cancel",
        source: "ctrl-c",
        pressedAt: t,
      });
    }
  };

  stdin.on("keypress", onKeypress);

  let paused = false;
  let detached = false;

  return {
    pause: () => {
      if (paused || detached) return;
      paused = true;
      stdin.off("keypress", onKeypress);
      // 强制切到 cooked mode (false) —— typeahead 路径 wasRaw 可能本身就是 true
      // (readline terminal 模式维持 raw)，回到 wasRaw 仍是 raw，readline.question
      // 在 raw mode 下没有字符 echo / 行编辑，securityPrompt 完全失灵。
      // pause 的语义是"让 cooked-mode 调用方能正常工作"，必须强制 cooked。
      stdin.setRawMode(false);
      // 释放 ownership 让 readline 内部 _ttyWrite listener 恢复挂回 stdin。
      // 否则 readline 收不到 keypress → rl.question 永远等不到 line 事件 →
      // securityPrompt 卡死 (acquireStdinOwnership 在 attach 时已经摘掉了它)。
      currentOwnership?.release();
      currentOwnership = null;
    },
    resume: () => {
      if (!paused || detached) return;
      paused = false;
      // 重新独占 stdin: snapshot+摘除 readline 在 pause 期间用过的 _ttyWrite,
      // 防止 raw mode 下两个 listener 同时收 keypress 导致字符叠加 echo。
      currentOwnership = acquireStdinOwnership(stdin);
      stdin.setRawMode(true); // 恢复 KeyboardSource 工作所需的 raw mode
      stdin.on("keypress", onKeypress);
    },
    detach: () => {
      if (detached) return;
      detached = true;
      // 严格 off → setRawMode → release 顺序：先卸 listener 防 release 后被恢复的
      // readline listener 在我们 setRawMode 翻转前收到杂事件
      if (!paused) stdin.off("keypress", onKeypress);
      // detach 恢复 attach 前的初始状态 (wasRaw)，与 pause(强制 cooked)语义不同
      stdin.setRawMode(wasRaw);
      // ?. 防御 pause 状态: pause 时已 release ownership 设 null,detach 不重复 release
      currentOwnership?.release();
      currentOwnership = null;
    },
  };
}
