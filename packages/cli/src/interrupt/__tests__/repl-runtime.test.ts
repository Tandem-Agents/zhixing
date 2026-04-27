/**
 * ReplInterruptRuntime 集成测试 —— 验证 controller + KeyboardSource + SignalSource 协调正确。
 *
 * 全部用 mock 注入避免真听 process.stdin / 给进程发信号。
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplInterruptRuntime } from "../repl-runtime.js";
import { createSignalEmitterForTest } from "../signal-source.js";

interface FakeStdin extends PassThrough {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
}

function makeFakeStdin(opts: { isTTY?: boolean; isRaw?: boolean } = {}): FakeStdin {
  const stdin = new PassThrough() as unknown as FakeStdin;
  stdin.isTTY = opts.isTTY ?? true;
  stdin.isRaw = opts.isRaw ?? false;
  stdin.setRawMode = vi.fn((value: boolean) => {
    stdin.isRaw = value;
    return stdin;
  });
  return stdin;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("createReplInterruptRuntime — 装载与基础属性", () => {
  it("创建后 controller 存在且未 aborted", () => {
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: makeFakeStdin() as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
    });
    cleanups.push(() => runtime.detach());

    expect(runtime.controller).toBeInstanceOf(AbortController);
    expect(runtime.controller.signal.aborted).toBe(false);
  });

  it("非 TTY stdin 仍能正常构造 (KeyboardSource 退化为 no-op,SignalSource 仍工作)", () => {
    const stdin = makeFakeStdin({ isTTY: false });
    const signals = createSignalEmitterForTest();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals,
    });
    cleanups.push(() => runtime.detach());

    // SignalSource 仍可触发 abort
    signals.emit("SIGINT");
    expect(runtime.controller.signal.aborted).toBe(true);
  });
});

describe("createReplInterruptRuntime — 两源 abort 触发", () => {
  it("keypress Esc → controller abort (KeyboardSource 路径)", () => {
    const stdin = makeFakeStdin();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
    });
    cleanups.push(() => runtime.detach());

    stdin.emit("keypress", "", { name: "escape" });
    expect(runtime.controller.signal.aborted).toBe(true);
  });

  it("keypress Ctrl+C → controller abort", () => {
    const stdin = makeFakeStdin();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
    });
    cleanups.push(() => runtime.detach());

    stdin.emit("keypress", "", { ctrl: true, name: "c" });
    expect(runtime.controller.signal.aborted).toBe(true);
  });

  it("emit SIGINT → controller abort (SignalSource 路径)", () => {
    const signals = createSignalEmitterForTest();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: makeFakeStdin() as unknown as NodeJS.ReadStream,
      signals,
    });
    cleanups.push(() => runtime.detach());

    signals.emit("SIGINT");
    expect(runtime.controller.signal.aborted).toBe(true);
  });

  it("双击 Ctrl+C → onDoublePress 触发 (透传到 KeyboardSource)", () => {
    const stdin = makeFakeStdin();
    const onDoublePress = vi.fn();
    let timeNow = 1000;
    const runtime = createReplInterruptRuntime({
      onDoublePress,
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
      now: () => timeNow,
    });
    cleanups.push(() => runtime.detach());

    stdin.emit("keypress", "", { ctrl: true, name: "c" });
    timeNow = 1500;
    stdin.emit("keypress", "", { ctrl: true, name: "c" });

    expect(onDoublePress).toHaveBeenCalledTimes(1);
    expect(onDoublePress).toHaveBeenCalledWith("ctrl-c");
  });
});

describe("createReplInterruptRuntime — pause / resume 协调", () => {
  it("pause: KeyboardSource keypress 不再 abort, SignalSource 仍工作 (兜底通道)", () => {
    const stdin = makeFakeStdin();
    const signals = createSignalEmitterForTest();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals,
    });
    cleanups.push(() => runtime.detach());

    runtime.pause();

    // KeyboardSource 已 pause —— keypress 不触发 abort
    stdin.emit("keypress", "", { name: "escape" });
    expect(runtime.controller.signal.aborted).toBe(false);

    // SignalSource 仍工作 —— 用户按 Ctrl+C 走 OS SIGINT 仍可中断 (兜底)
    signals.emit("SIGINT");
    expect(runtime.controller.signal.aborted).toBe(true);
  });

  it("pause 切 stdin 到 cooked mode (setRawMode(false))", () => {
    const stdin = makeFakeStdin();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
    });
    cleanups.push(() => runtime.detach());

    runtime.pause();

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.isRaw).toBe(false);
  });

  it("resume: keypress 重新 abort + setRawMode(true)", () => {
    const stdin = makeFakeStdin();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
    });
    cleanups.push(() => runtime.detach());

    runtime.pause();
    runtime.resume();

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
    expect(stdin.isRaw).toBe(true);
    stdin.emit("keypress", "", { name: "escape" });
    expect(runtime.controller.signal.aborted).toBe(true);
  });

  it("pause/resume 多次调用幂等", () => {
    const stdin = makeFakeStdin();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
    });
    cleanups.push(() => runtime.detach());

    stdin.setRawMode.mockClear();

    runtime.pause();
    runtime.pause();
    runtime.pause();
    expect(stdin.setRawMode).toHaveBeenCalledTimes(1);

    runtime.resume();
    runtime.resume();
    expect(stdin.setRawMode).toHaveBeenCalledTimes(2);
  });
});

describe("createReplInterruptRuntime — detach 释放", () => {
  it("detach 后 keypress 和 signal 都不再触发 abort", () => {
    const stdin = makeFakeStdin();
    const signals = createSignalEmitterForTest();
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals,
    });

    runtime.detach();

    stdin.emit("keypress", "", { name: "escape" });
    signals.emit("SIGINT");

    expect(runtime.controller.signal.aborted).toBe(false);
  });

  it("detach 恢复 stdin 到初始 raw mode (wasRaw)", () => {
    const stdin = makeFakeStdin({ isRaw: false });
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
    });

    runtime.detach();

    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("detach 幂等: 多次调用不抛错", () => {
    const runtime = createReplInterruptRuntime({
      onDoublePress: () => {},
      stdin: makeFakeStdin() as unknown as NodeJS.ReadStream,
      signals: createSignalEmitterForTest(),
    });

    runtime.detach();
    runtime.detach();
    runtime.detach();
  });
});
