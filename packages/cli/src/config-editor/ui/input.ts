/**
 * 输入层：raw mode + chunk → KeyEvent 流。
 *
 * 隔离 stdin 物理细节（setRawMode / encoding / data 事件）与编辑器逻辑——
 * runner 只调用 inputStream.next() 拿下一个 KeyEvent，不感知字节级处理。
 */

import {
  createKeyDecoderState,
  decodeChunk,
  type KeyDecoderState,
} from "./key-decoder.js";
import type { KeyEvent } from "../types.js";

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

  function onData(chunk: string): void {
    const result = decodeChunk(chunk, decoderState);
    decoderState = result.newState;
    for (const event of result.events) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(event);
      } else {
        queue.push(event);
      }
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
