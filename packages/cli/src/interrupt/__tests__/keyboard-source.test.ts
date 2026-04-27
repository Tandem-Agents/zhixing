/**
 * KeyboardSource 单元测试
 *
 * 用 PassThrough mock stdin 避免真听 process.stdin 导致测试 hang；
 * setRawMode mock 让 isRaw 状态可断言；
 * 时间用 fake clock 注入精确控制双击窗口。
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInterruptController, getAbortReason } from "@zhixing/core";
import { attachKeyboardSource } from "../keyboard-source.js";

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

describe("attachKeyboardSource — non-TTY", () => {
  it("non-TTY → 返 no-op handle，不改 raw mode、不挂 listener", () => {
    const stdin = makeFakeStdin({ isTTY: false });
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(stdin.listenerCount("keypress")).toBe(0);

    // pause/resume/detach 都是 no-op (不抛错)
    handle.pause();
    handle.resume();
    handle.detach();

    expect(ctrl.signal.aborted).toBe(false);
  });
});

describe("attachKeyboardSource — attach 行为", () => {
  it("attach 进 raw mode + 挂 keypress listener", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    cleanups.push(() => handle.detach());

    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.isRaw).toBe(true);
    expect(stdin.listenerCount("keypress")).toBe(1);
  });

  it("acquireStdinOwnership 集成: detach 后预挂 listener 恢复", () => {
    const stdin = makeFakeStdin();
    const preExisting = vi.fn();
    stdin.on("keypress", preExisting);
    expect(stdin.listenerCount("keypress")).toBe(1);

    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    // attach 期间预挂 listener 被摘除，只剩 KeyboardSource 自己的
    expect(stdin.listenerCount("keypress")).toBe(1);
    stdin.emit("keypress", "", { name: "escape" });
    expect(preExisting).not.toHaveBeenCalled();

    handle.detach();

    // detach 后预挂 listener 恢复
    expect(stdin.listeners("keypress")).toEqual([preExisting]);
  });
});

describe("attachKeyboardSource — keypress 触发 abort", () => {
  it("按 escape → controller abort with kind=user-cancel + source=esc + pressedAt", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      now: () => 1000,
    });
    cleanups.push(() => handle.detach());

    stdin.emit("keypress", "", { name: "escape" });

    expect(ctrl.signal.aborted).toBe(true);
    const reason = getAbortReason(ctrl.signal);
    expect(reason).toEqual({
      kind: "user-cancel",
      source: "esc",
      pressedAt: 1000,
    });
  });

  it("单按 Ctrl+C → controller abort with source=ctrl-c", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
      now: () => 2000,
    });
    cleanups.push(() => handle.detach());

    stdin.emit("keypress", "", { ctrl: true, name: "c" });

    expect(ctrl.signal.aborted).toBe(true);
    const reason = getAbortReason(ctrl.signal);
    if (reason?.kind === "user-cancel") {
      expect(reason.source).toBe("ctrl-c");
      expect(reason.pressedAt).toBe(2000);
    } else {
      throw new Error(`expected user-cancel, got ${reason?.kind}`);
    }
  });

  it("非 Esc 非 Ctrl+C 的 keypress (如普通字母) → 不触发 abort", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    cleanups.push(() => handle.detach());

    stdin.emit("keypress", "a", { name: "a" });
    stdin.emit("keypress", "b", { name: "b", ctrl: false });

    expect(ctrl.signal.aborted).toBe(false);
  });
});

describe("attachKeyboardSource — 双击 Ctrl+C", () => {
  it("800ms 内连按 Ctrl+C → onDoublePress 触发 (第一次仍 abort)", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    let timeNow = 1000;
    const onDoublePress = vi.fn();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress,
      stdin: stdin as unknown as NodeJS.ReadStream,
      now: () => timeNow,
    });
    cleanups.push(() => handle.detach());

    // 第一次 Ctrl+C → abort
    stdin.emit("keypress", "", { ctrl: true, name: "c" });
    expect(ctrl.signal.aborted).toBe(true);
    expect(onDoublePress).not.toHaveBeenCalled();

    // 500ms 后 第二次 Ctrl+C → onDoublePress
    timeNow = 1500;
    stdin.emit("keypress", "", { ctrl: true, name: "c" });

    expect(onDoublePress).toHaveBeenCalledTimes(1);
    expect(onDoublePress).toHaveBeenCalledWith("ctrl-c");
  });

  it("> 800ms 间隔的两次 Ctrl+C → 各自单击,不触发 onDoublePress", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    let timeNow = 1000;
    const onDoublePress = vi.fn();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress,
      stdin: stdin as unknown as NodeJS.ReadStream,
      now: () => timeNow,
    });
    cleanups.push(() => handle.detach());

    stdin.emit("keypress", "", { ctrl: true, name: "c" });
    timeNow = 1900; // 900ms 后 (> 800)
    stdin.emit("keypress", "", { ctrl: true, name: "c" });

    expect(onDoublePress).not.toHaveBeenCalled();
  });

  it("自定义 doublePressMs 阈值生效", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    let timeNow = 1000;
    const onDoublePress = vi.fn();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress,
      stdin: stdin as unknown as NodeJS.ReadStream,
      now: () => timeNow,
      doublePressMs: 200,
    });
    cleanups.push(() => handle.detach());

    stdin.emit("keypress", "", { ctrl: true, name: "c" });
    timeNow = 1300; // 300ms 后 > 200ms 阈值
    stdin.emit("keypress", "", { ctrl: true, name: "c" });
    expect(onDoublePress).not.toHaveBeenCalled();

    timeNow = 1450; // 150ms 后 < 200ms
    stdin.emit("keypress", "", { ctrl: true, name: "c" });
    expect(onDoublePress).toHaveBeenCalled();
  });

  it("onDoublePress 返 Promise → KeyboardSource 不 await (fire-and-forget)", async () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    let resolved = false;
    const onDoublePress = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 30));
      resolved = true;
    });
    let timeNow = 1000;
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress,
      stdin: stdin as unknown as NodeJS.ReadStream,
      now: () => timeNow,
    });
    cleanups.push(() => handle.detach());

    stdin.emit("keypress", "", { ctrl: true, name: "c" });
    timeNow = 1100;
    stdin.emit("keypress", "", { ctrl: true, name: "c" });

    // 触发后立即继续执行,不等 Promise resolve (fire-and-forget)
    expect(onDoublePress).toHaveBeenCalled();
    expect(resolved).toBe(false);

    // 等异步 callback 完成,避免 unhandled promise warning
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(resolved).toBe(true);
  });
});

describe("attachKeyboardSource — pause / resume / detach 三态机", () => {
  it("pause → keypress 不再 abort + setRawMode(false) 强制 cooked", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    cleanups.push(() => handle.detach());

    handle.pause();

    // raw mode 切到 false (强制 cooked,不回 wasRaw)
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.isRaw).toBe(false);
    // listener 卸载,emit 不触发 abort
    expect(stdin.listenerCount("keypress")).toBe(0);
    stdin.emit("keypress", "", { name: "escape" });
    expect(ctrl.signal.aborted).toBe(false);
  });

  it("resume → keypress 重新 abort + setRawMode(true)", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    cleanups.push(() => handle.detach());

    handle.pause();
    handle.resume();

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
    expect(stdin.isRaw).toBe(true);
    expect(stdin.listenerCount("keypress")).toBe(1);
    stdin.emit("keypress", "", { name: "escape" });
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("pause/resume 幂等: 多次调用不抖动 raw mode", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    cleanups.push(() => handle.detach());

    stdin.setRawMode.mockClear(); // 清掉 attach 时的调用

    handle.pause();
    handle.pause(); // no-op
    handle.pause(); // no-op
    expect(stdin.setRawMode).toHaveBeenCalledTimes(1);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);

    handle.resume();
    handle.resume(); // no-op
    expect(stdin.setRawMode).toHaveBeenCalledTimes(2);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
  });

  it("detach 恢复 attach 前的初始 raw mode (wasRaw=false)", () => {
    const stdin = makeFakeStdin({ isRaw: false }); // wasRaw = false
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    handle.detach();

    // detach 恢复到 wasRaw=false (与 pause 强制 cooked 不同)
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("attach 时 wasRaw=true → detach 恢复 raw=true", () => {
    const stdin = makeFakeStdin({ isRaw: true }); // wasRaw = true
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    handle.detach();

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
    expect(stdin.isRaw).toBe(true);
  });

  it("detach 幂等: 重复调用不抛错也不影响状态", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    handle.detach();
    const callCountAfterFirst = stdin.setRawMode.mock.calls.length;
    handle.detach();
    handle.detach();

    expect(stdin.setRawMode.mock.calls.length).toBe(callCountAfterFirst);
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("pause 后 detach: 不重复 off (paused 已经 off)", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    handle.pause();
    expect(stdin.listenerCount("keypress")).toBe(0); // pause 已卸

    handle.detach();
    expect(stdin.listenerCount("keypress")).toBe(0); // 不抛错,也不变
  });

  it("detach 后 pause/resume 是 no-op (已终态)", () => {
    const stdin = makeFakeStdin();
    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    handle.detach();
    const callsBeforeNoOp = stdin.setRawMode.mock.calls.length;

    handle.pause();
    handle.resume();

    expect(stdin.setRawMode.mock.calls.length).toBe(callsBeforeNoOp);
  });
});

describe("attachKeyboardSource — pause/resume ownership 切换 (修复 securityPrompt 卡死)", () => {
  it("pause 期间预挂 listener 已恢复 (rl.question 能收 keypress 不卡死)", () => {
    // 修复回归: 之前 pause 不 release ownership, readline 的 _ttyWrite listener
    // 在 attach 时被 acquireStdinOwnership 摘除后永不恢复 → rl.question 收不到
    // line 事件 → securityPrompt 永远卡死。修复后 pause 必须让预挂 listener 恢复。
    const stdin = makeFakeStdin();
    const preExisting = vi.fn();
    stdin.on("keypress", preExisting);
    expect(stdin.listenerCount("keypress")).toBe(1);

    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    cleanups.push(() => handle.detach());

    // attach: 预挂 listener 被摘除, 只剩我们的
    expect(stdin.listenerCount("keypress")).toBe(1);
    expect(stdin.listeners("keypress")).not.toContain(preExisting);

    // pause: ownership release 让预挂 listener 恢复
    handle.pause();
    expect(stdin.listeners("keypress")).toEqual([preExisting]);

    // pause 期间预挂 listener 收到 keypress (即 rl.question 能正常工作)
    stdin.emit("keypress", "y", { name: "y" });
    expect(preExisting).toHaveBeenCalledWith("y", { name: "y" });
  });

  it("resume 后重新独占 stdin (预挂 listener 再次被摘除, 我们的 listener 恢复)", () => {
    const stdin = makeFakeStdin();
    const preExisting = vi.fn();
    stdin.on("keypress", preExisting);

    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    cleanups.push(() => handle.detach());

    handle.pause();
    expect(stdin.listeners("keypress")).toEqual([preExisting]);

    handle.resume();
    expect(stdin.listenerCount("keypress")).toBe(1);
    expect(stdin.listeners("keypress")).not.toContain(preExisting);

    // resume 后我们的 listener 恢复工作
    stdin.emit("keypress", "", { name: "escape" });
    expect(ctrl.signal.aborted).toBe(true);
    // 预挂 listener 不收到 keypress (我们独占)
    expect(preExisting).not.toHaveBeenCalled();
  });

  it("pause → resume → pause → detach 循环 listener 计数始终正确", () => {
    const stdin = makeFakeStdin();
    const preExisting = vi.fn();
    stdin.on("keypress", preExisting);

    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    // attach: 1 (我们的)
    expect(stdin.listenerCount("keypress")).toBe(1);

    // pause: 我们的卸 + ownership.release → preExisting 恢复 → 1
    handle.pause();
    expect(stdin.listeners("keypress")).toEqual([preExisting]);

    // resume: re-acquire (preExisting 摘除) + 我们的挂 → 1
    handle.resume();
    expect(stdin.listenerCount("keypress")).toBe(1);
    expect(stdin.listeners("keypress")).not.toContain(preExisting);

    // pause again: 我们的卸 + ownership.release → preExisting 恢复 → 1
    handle.pause();
    expect(stdin.listeners("keypress")).toEqual([preExisting]);

    // detach 在 pause 状态: currentOwnership 已 null,不重复 release;
    // listener 仍是 pause 时恢复的 preExisting
    handle.detach();
    expect(stdin.listeners("keypress")).toEqual([preExisting]);
  });

  it("pause 后 detach: currentOwnership 已 null 不重复 release", () => {
    const stdin = makeFakeStdin();
    const preExisting = vi.fn();
    stdin.on("keypress", preExisting);

    const ctrl = createInterruptController();
    const handle = attachKeyboardSource({
      controller: ctrl,
      onDoublePress: () => {},
      stdin: stdin as unknown as NodeJS.ReadStream,
    });

    handle.pause();
    // pause 已 release: preExisting 在 stdin 上 (一次)
    expect(stdin.listeners("keypress")).toEqual([preExisting]);

    handle.detach();
    // detach 不重复 release (?. 防御 + StdinOwnershipHandle.release 自身幂等 双重保护)
    expect(stdin.listeners("keypress")).toEqual([preExisting]);
  });
});
