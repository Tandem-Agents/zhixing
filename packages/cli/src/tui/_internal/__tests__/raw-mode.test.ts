/**
 * raw-mode.ts 单元测试
 *
 * 覆盖点：
 *   1. 非 TTY 流不增计数
 *   2. 首个 acquire 调 setRawMode(true)
 *   3. 嵌套 acquire 不重复调 setRawMode
 *   4. 末次 release 调 setRawMode(originalIsRaw)
 *   5. restore 值用 0→1 转场时 snapshot 的原始状态，不受后续干扰
 *   6. release 幂等
 *   7. LIFO 顺序下正确计数
 *   8. 非 LIFO 顺序下也正确恢复（见设计文档：restore 在 0→1 snapshot）
 *   9. resetForTests 清空状态
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rawModeController } from "../raw-mode.js";

/** 构造一个伪 TTY stdin：PassThrough + isTTY=true + mock setRawMode */
function makeFakeTty(initialIsRaw = false) {
  const stream = new PassThrough();
  const state = { isRaw: initialIsRaw };
  const setRawMode = vi.fn((enabled: boolean) => {
    state.isRaw = enabled;
  });
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  // 用可配置、可写 getter —— 测试里某些场景需要直接改 state.isRaw 再重新 acquire
  Object.defineProperty(stream, "isRaw", {
    get: () => state.isRaw,
    set: (v: boolean) => {
      state.isRaw = v;
    },
    configurable: true,
  });
  (stream as unknown as { setRawMode: typeof setRawMode }).setRawMode =
    setRawMode;
  return {
    stream: stream as unknown as NodeJS.ReadStream,
    setRawMode,
    getIsRaw: () => state.isRaw,
    /** 直接改底层 state（模拟外部把 stdin 改成 raw） */
    setIsRawDirect: (v: boolean) => {
      state.isRaw = v;
    },
  };
}

beforeEach(() => {
  rawModeController.resetForTests();
});

afterEach(() => {
  rawModeController.resetForTests();
});

describe("rawModeController — 基础语义", () => {
  it("非 TTY 流：acquire 返回 no-op lease，不增计数", () => {
    const stream = new PassThrough();
    // 不设 isTTY → 默认 undefined falsy
    const lease = rawModeController.acquire(
      stream as unknown as NodeJS.ReadStream,
    );
    expect(rawModeController.activeLeases()).toBe(0);
    lease.release(); // 不应 throw
    expect(rawModeController.activeLeases()).toBe(0);
  });

  it("TTY 流：首次 acquire 调用 setRawMode(true) 并增计数到 1", () => {
    const { stream, setRawMode } = makeFakeTty(false);
    const lease = rawModeController.acquire(stream);
    expect(setRawMode).toHaveBeenCalledExactlyOnceWith(true);
    expect(rawModeController.activeLeases()).toBe(1);
    lease.release();
  });

  it("嵌套 acquire：第二次不重复调 setRawMode，只增计数", () => {
    const { stream, setRawMode } = makeFakeTty(false);
    const a = rawModeController.acquire(stream);
    const b = rawModeController.acquire(stream);
    expect(setRawMode).toHaveBeenCalledTimes(1);
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(rawModeController.activeLeases()).toBe(2);
    b.release();
    a.release();
  });

  it("末次 release 调 setRawMode(originalIsRaw=false) 恢复", () => {
    const { stream, setRawMode } = makeFakeTty(false);
    const lease = rawModeController.acquire(stream);
    lease.release();
    expect(setRawMode).toHaveBeenCalledTimes(2);
    expect(setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(rawModeController.activeLeases()).toBe(0);
  });

  it("originalIsRaw=true 时，末次 release 恢复到 true（不无脑关）", () => {
    // 典型场景：调用方已经处于 raw mode（比如 readline.question() 期间）
    const { stream, setRawMode } = makeFakeTty(true);
    const lease = rawModeController.acquire(stream);
    lease.release();
    // 首次 acquire 也会调 setRawMode(true)（即使已经是 true，为了对齐语义）
    expect(setRawMode).toHaveBeenNthCalledWith(1, true);
    // 关键：末次 release 恢复到 originalIsRaw=true，不是 false
    expect(setRawMode).toHaveBeenNthCalledWith(2, true);
  });
});

describe("rawModeController — 幂等与边界", () => {
  it("lease.release() 幂等：重复调用不重复递减计数", () => {
    const { stream, setRawMode } = makeFakeTty(false);
    const lease = rawModeController.acquire(stream);
    lease.release();
    lease.release(); // 第二次应无副作用
    lease.release();
    expect(rawModeController.activeLeases()).toBe(0);
    // setRawMode 被调 2 次：acquire 时一次，release 时一次
    expect(setRawMode).toHaveBeenCalledTimes(2);
  });

  it("LIFO 顺序 release 正确：a→b→b.release→a.release", () => {
    const { stream, setRawMode } = makeFakeTty(false);
    const a = rawModeController.acquire(stream);
    const b = rawModeController.acquire(stream);
    expect(rawModeController.activeLeases()).toBe(2);
    b.release();
    expect(rawModeController.activeLeases()).toBe(1);
    expect(setRawMode).toHaveBeenCalledTimes(1); // 还没 restore
    a.release();
    expect(rawModeController.activeLeases()).toBe(0);
    expect(setRawMode).toHaveBeenCalledTimes(2);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("非 LIFO 顺序 release 也正确恢复：a→b→a.release→b.release", () => {
    // 关键改进 vs 原版：restore 值在 0→1 snapshot，不依赖 release 顺序
    const { stream, setRawMode } = makeFakeTty(false);
    const a = rawModeController.acquire(stream);
    const b = rawModeController.acquire(stream);
    a.release(); // 计数 2→1
    expect(setRawMode).toHaveBeenCalledTimes(1); // 还没 restore
    b.release(); // 计数 1→0
    expect(setRawMode).toHaveBeenLastCalledWith(false); // 恢复到 originalIsRaw
    expect(rawModeController.activeLeases()).toBe(0);
  });

  it("resetForTests 清空状态且不触碰真实 TTY", () => {
    const { stream, setRawMode } = makeFakeTty(false);
    rawModeController.acquire(stream);
    rawModeController.acquire(stream);
    expect(rawModeController.activeLeases()).toBe(2);
    rawModeController.resetForTests();
    expect(rawModeController.activeLeases()).toBe(0);
    // resetForTests 不应额外调 setRawMode
    expect(setRawMode).toHaveBeenCalledTimes(1); // 只有 acquire 时那一次
  });

  it("reset 之后重新 acquire 会再次 snapshot 当前状态", () => {
    const { stream, setRawMode, setIsRawDirect } = makeFakeTty(false);
    const lease1 = rawModeController.acquire(stream);
    lease1.release();
    rawModeController.resetForTests();

    // 模拟终端被外部改成 raw（绕过 setRawMode mock，直接改底层状态）
    setIsRawDirect(true);

    const lease2 = rawModeController.acquire(stream);
    lease2.release();
    // 末次 release 应恢复到新的 originalIsRaw=true
    const callOrder = setRawMode.mock.calls.map((args) => args[0]);
    // 第 1 次 true（首 acquire），第 2 次 false（首 release）
    // 第 3 次 true（reset 后首 acquire），第 4 次 true（reset 后末 release，恢复到 isRaw=true）
    expect(callOrder).toEqual([true, false, true, true]);
  });
});
