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
  next(): Promise<KeyEvent>;
}

export function createKeyEventStream(stdin: NodeJS.ReadStream): KeyEventStream {
  let decoderState: KeyDecoderState = createKeyDecoderState();
  const queue: KeyEvent[] = [];
  const waiters: Array<(event: KeyEvent) => void> = [];
  let started = false;
  let originalRawMode: boolean | null = null;
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
      if (typeof stdin.setRawMode === "function") {
        originalRawMode = stdin.isRaw ?? false;
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.setEncoding("utf-8");
      stdin.on("data", onData);
    },
    stop(): void {
      if (!started) return;
      started = false;
      clearEscapeTimer();
      stdin.off("data", onData);
      if (originalRawMode !== null && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(originalRawMode);
        originalRawMode = null;
      }
      stdin.pause();
      // 唤醒所有等待者并发出"流已停止"信号——避免悬挂 Promise
      while (waiters.length > 0) {
        waiters.shift()!({ type: "ctrl-c" });
      }
    },
    next(): Promise<KeyEvent> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<KeyEvent>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}
