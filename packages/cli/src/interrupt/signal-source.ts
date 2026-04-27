/**
 * SignalSource —— 通过 OS 信号 (SIGINT / SIGTERM) 触发 abort，KeyboardSource 在 cooked mode
 * 失效时的兜底通道。
 *
 * 何时生效：
 * - non-TTY 环境 (CI、stdin redirect、管道)：KeyboardSource 返 no-op，SignalSource 是唯一通道
 * - KeyboardSource pause 期间 (securityPrompt 等 cooked-mode 子 UI)：raw mode 已退出，
 *   tty driver 把 Ctrl+C 字节转 SIGINT，SignalSource 接管
 * - 外部进程 kill -INT / kill -TERM：raw/cooked 都生效
 *
 * 与 KeyboardSource 协同：两者共享同一 controller，多次 abort 由 controller 协议层幂等
 * (abortWithReason 在已 aborted signal 上是 no-op，不覆盖原 reason)。
 *
 * 依赖注入 process 让单测能用 EventEmitter mock，避免真给自己进程发信号 (危险且不可重入)。
 */

import { EventEmitter } from "node:events";
import { abortWithReason } from "@zhixing/core";

export interface SignalSourceHandle {
  /** 移除 SIGINT/SIGTERM listener。幂等。 */
  detach(): void;
}

/**
 * 接收信号的对象 —— 抽出最小接口让单测能用 EventEmitter / 自定义 mock 注入，
 * 不需要真 process 实例。生产路径默认 globalThis.process。
 */
export interface SignalEmitter {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface AttachSignalSourceOptions {
  /** abort 触发目标 controller (loop 共享同一 controller，多源 abort 协议层幂等) */
  controller: AbortController;
  /** 信号源注入，默认 process (测试可传 EventEmitter mock 避免真给进程发信号) */
  signals?: SignalEmitter;
  /** 时间源注入，默认 Date.now (测试可传 fake clock) */
  now?: () => number;
}

export function attachSignalSource(opts: AttachSignalSourceOptions): SignalSourceHandle {
  const signals: SignalEmitter = opts.signals ?? (process as unknown as SignalEmitter);
  const now = opts.now ?? Date.now;

  const onSignal = () =>
    abortWithReason(opts.controller, {
      kind: "user-cancel",
      source: "sigint",
      pressedAt: now(),
    });

  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);

  let detached = false;

  return {
    detach: () => {
      if (detached) return;
      detached = true;
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
    },
  };
}

/**
 * 测试辅助：构造一个最小 SignalEmitter (基于 EventEmitter)。
 *
 * 不导出给生产路径，但仍 export 让单测和 repl-runtime 集成测试复用。
 */
export function createSignalEmitterForTest(): SignalEmitter & {
  emit(event: "SIGINT" | "SIGTERM"): boolean;
} {
  return new EventEmitter() as unknown as SignalEmitter & {
    emit(event: "SIGINT" | "SIGTERM"): boolean;
  };
}
