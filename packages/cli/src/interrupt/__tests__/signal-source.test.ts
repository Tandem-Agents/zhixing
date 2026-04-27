/**
 * SignalSource 单元测试
 *
 * 用 EventEmitter mock signals 避免真给进程发 SIGINT 导致测试 runner 进程被 kill。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createInterruptController, getAbortReason } from "@zhixing/core";
import { attachSignalSource, createSignalEmitterForTest } from "../signal-source.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("attachSignalSource", () => {
  it("emit SIGINT → controller abort with kind=user-cancel + source=sigint + pressedAt", () => {
    const signals = createSignalEmitterForTest();
    const ctrl = createInterruptController();
    const handle = attachSignalSource({
      controller: ctrl,
      signals,
      now: () => 5000,
    });
    cleanups.push(() => handle.detach());

    signals.emit("SIGINT");

    expect(ctrl.signal.aborted).toBe(true);
    const reason = getAbortReason(ctrl.signal);
    expect(reason).toEqual({
      kind: "user-cancel",
      source: "sigint",
      pressedAt: 5000,
    });
  });

  it("emit SIGTERM → controller abort with kind=user-cancel + source=sigint", () => {
    const signals = createSignalEmitterForTest();
    const ctrl = createInterruptController();
    const handle = attachSignalSource({
      controller: ctrl,
      signals,
      now: () => 6000,
    });
    cleanups.push(() => handle.detach());

    signals.emit("SIGTERM");

    expect(ctrl.signal.aborted).toBe(true);
    const reason = getAbortReason(ctrl.signal);
    if (reason?.kind === "user-cancel") {
      expect(reason.source).toBe("sigint");
      expect(reason.pressedAt).toBe(6000);
    } else {
      throw new Error(`expected user-cancel, got ${reason?.kind}`);
    }
  });

  it("第二次信号不覆盖原 abort reason (controller 协议层幂等)", () => {
    const signals = createSignalEmitterForTest();
    const ctrl = createInterruptController();
    let timeNow = 1000;
    const handle = attachSignalSource({
      controller: ctrl,
      signals,
      now: () => timeNow,
    });
    cleanups.push(() => handle.detach());

    signals.emit("SIGINT"); // 第一次,记 pressedAt=1000
    timeNow = 2000;
    signals.emit("SIGTERM"); // 第二次,abortWithReason 是 no-op (已 aborted)

    const reason = getAbortReason(ctrl.signal);
    if (reason?.kind === "user-cancel") {
      expect(reason.pressedAt).toBe(1000); // 保留第一次的时刻
    } else {
      throw new Error(`expected user-cancel, got ${reason?.kind}`);
    }
  });

  it("detach 移除 SIGINT/SIGTERM listener 后再 emit 不触发 abort", () => {
    const signals = createSignalEmitterForTest();
    const ctrl = createInterruptController();
    const handle = attachSignalSource({
      controller: ctrl,
      signals,
    });

    handle.detach();

    signals.emit("SIGINT");
    signals.emit("SIGTERM");

    expect(ctrl.signal.aborted).toBe(false);
  });

  it("detach 幂等: 多次调用不抛错", () => {
    const signals = createSignalEmitterForTest();
    const ctrl = createInterruptController();
    const handle = attachSignalSource({ controller: ctrl, signals });

    handle.detach();
    handle.detach();
    handle.detach();

    expect(ctrl.signal.aborted).toBe(false);
  });
});
