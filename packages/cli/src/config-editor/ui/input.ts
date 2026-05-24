/**
 * 输入层：raw mode + chunk → KeyEvent 流。
 *
 * 隔离 stdin 物理细节（setRawMode / encoding / data 事件）与编辑器逻辑——
 * runner 只调用 inputStream.next() 拿下一个 KeyEvent，不感知字节级处理。
 *
 * Escape 处理：单按 Esc 触发 decoder 进入"esc 等待"状态——可能是孤立 Esc，
 * 也可能是 CSI 序列（如方向键 ESC[A）的开头。本层用短 timer 区分：
 *   - 50ms 内有字符到达 → 让 decoder 继续处理（CSI 序列）
 *   - 超时未到字符 → 视为孤立 Esc，产出 escape event + 重置 decoder 状态
 *
 * 50ms 是行业惯例（vim / readline / inquirer 类似量级）：方向键序列在 raw mode
 * 下同 chunk 到达，人手按下下一键的间隔远大于此。
 */

import {
  createKeyDecoderState,
  decodeChunk,
  type KeyDecoderState,
} from "./key-decoder.js";
import {
  rawModeController,
  type RawModeLease,
} from "../../tui/_internal/raw-mode.js";
import {
  acquireStdinOwnership,
  type StdinOwnershipHandle,
} from "../../tui/_internal/stdin-ownership.js";
import type { KeyEvent } from "../types.js";

const ESCAPE_TIMEOUT_MS = 50;

/**
 * 异步 KeyEvent 流——基于事件订阅 + 待消费队列。
 *
 * 用法：
 *   const stream = createKeyEventStream(stdin);
 *   try {
 *     stream.start();
 *     while (true) {
 *       const event = await stream.next();
 *       // ... 处理
 *     }
 *   } finally {
 *     stream.stop();
 *   }
 *
 * stop() 必须调用——恢复 stdin 原状态（退出 raw mode、暂停流）。
 */
export interface KeyEventStream {
  start(): void;
  stop(): void;
  /**
   * 取下一个 KeyEvent。传 signal 可取消本次等待——abort 时摘除内部 waiter 并 reject，
   * 避免悬挂的 waiter 吞掉后续按键（单消费者队列）。用于 loading 态把"等按键"与异步任务
   * race、任务先完成时清理这次等待。主循环不传 signal。
   */
  next(signal?: AbortSignal): Promise<KeyEvent>;
}

export function createKeyEventStream(stdin: NodeJS.ReadStream): KeyEventStream {
  let decoderState: KeyDecoderState = createKeyDecoderState();
  const queue: KeyEvent[] = [];
  const waiters: Array<(event: KeyEvent) => void> = [];
  let started = false;
  let rawModeLease: RawModeLease | null = null;
  let stdinOwnership: StdinOwnershipHandle | null = null;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(event: KeyEvent): void {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      queue.push(event);
    }
  }

  function clearEscapeTimer(): void {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
  }

  function onEscapeTimeout(): void {
    escapeTimer = null;
    if (decoderState.ansi === "esc") {
      // 孤立 Esc：超时未收到后续字符 → 产出 escape + 重置 decoder
      decoderState = createKeyDecoderState();
      emit({ type: "escape" });
    }
  }

  function onData(chunk: string): void {
    // 新字符到达 → 取消 escape timer（让 decoder 自己判定是 CSI 序列还是孤立 Esc + char）
    clearEscapeTimer();

    const result = decodeChunk(chunk, decoderState);
    decoderState = result.newState;
    for (const event of result.events) {
      emit(event);
    }

    // decoder 卡在 esc 等待 → 启动 timer，超时未来字符则视为孤立 Esc
    if (decoderState.ansi === "esc") {
      escapeTimer = setTimeout(onEscapeTimeout, ESCAPE_TIMEOUT_MS);
    }
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      // 与 keyboard-source / typeahead-input / terminal-renderer 同协议：
      // 1) acquireStdinOwnership 摘除 readline 等预挂的 'keypress' listener——
      //    防 raw mode 下 readline 检测 Ctrl+C 转 SIGINT 退出整个进程
      // 2) rawModeController.acquire 走引用计数 lease，多个 modal 并存安全；
      //    末次 release 才恢复 stdin.isRaw 到首次 acquire 前的真实状态
      stdinOwnership = acquireStdinOwnership(stdin);
      rawModeLease = rawModeController.acquire(stdin);
      stdin.resume();
      stdin.setEncoding("utf-8");
      stdin.on("data", onData);
    },
    stop(): void {
      if (!started) return;
      started = false;
      clearEscapeTimer();
      stdin.off("data", onData);
      // release 顺序：先 lease 退 raw mode，再 ownership 复原 keypress listener——
      // 让 readline 在 cooked mode 下重新接管 keypress（与 attach 顺序对偶）
      rawModeLease?.release();
      rawModeLease = null;
      stdinOwnership?.release();
      stdinOwnership = null;
      // 唤醒所有等待者并发出"流已停止"信号——避免悬挂 Promise
      while (waiters.length > 0) {
        waiters.shift()!({ type: "ctrl-c" });
      }
    },
    next(signal?: AbortSignal): Promise<KeyEvent> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise<KeyEvent>((resolve, reject) => {
        const waiter = (event: KeyEvent): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve(event);
        };
        function onAbort(): void {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(signal?.reason);
        }
        waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
