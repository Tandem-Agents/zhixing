import { describe, expect, it } from "vitest";
import { DEFAULT_WATCHDOG_POLICY, createWatchdogPolicy } from "../types.js";

describe("createWatchdogPolicy", () => {
  it("无 opts → 返回 DEFAULT_WATCHDOG_POLICY 等价值", () => {
    const p = createWatchdogPolicy();
    expect(p).toEqual(DEFAULT_WATCHDOG_POLICY);
    expect(p.idleTimeoutMs).toBe(60_000);
    expect(p.warnThresholdRatio).toBe(0.5);
  });

  it("合法 ratio:0.1 / 0.5 / 0.9 全通过", () => {
    expect(() => createWatchdogPolicy({ warnThresholdRatio: 0.1 })).not.toThrow();
    expect(() => createWatchdogPolicy({ warnThresholdRatio: 0.5 })).not.toThrow();
    expect(() => createWatchdogPolicy({ warnThresholdRatio: 0.9 })).not.toThrow();
  });

  it("ratio = 0(闭区间端点)→ throw TypeError", () => {
    expect(() => createWatchdogPolicy({ warnThresholdRatio: 0 })).toThrow(TypeError);
  });

  it("ratio = 1(闭区间端点)→ throw TypeError", () => {
    expect(() => createWatchdogPolicy({ warnThresholdRatio: 1 })).toThrow(TypeError);
  });

  it("ratio > 1 / < 0 → throw TypeError", () => {
    expect(() => createWatchdogPolicy({ warnThresholdRatio: 1.5 })).toThrow(TypeError);
    expect(() => createWatchdogPolicy({ warnThresholdRatio: -0.1 })).toThrow(TypeError);
  });

  it("ratio NaN / Infinity → throw TypeError", () => {
    expect(() => createWatchdogPolicy({ warnThresholdRatio: Number.NaN })).toThrow(TypeError);
    expect(() => createWatchdogPolicy({ warnThresholdRatio: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("idleTimeoutMs = 0(documented:禁用 idle-timer)合法,ratio 仍按默认 0.5 过验证", () => {
    const p = createWatchdogPolicy({ idleTimeoutMs: 0 });
    expect(p.idleTimeoutMs).toBe(0);
    expect(p.warnThresholdRatio).toBe(0.5);
  });

  it("idleTimeoutMs = 30_000 / 1 / 60_000 等正常值通过", () => {
    expect(() => createWatchdogPolicy({ idleTimeoutMs: 1 })).not.toThrow();
    expect(() => createWatchdogPolicy({ idleTimeoutMs: 30_000 })).not.toThrow();
    expect(() => createWatchdogPolicy({ idleTimeoutMs: 60_000 })).not.toThrow();
  });

  it("idleTimeoutMs 负数 → throw TypeError(语义不明)", () => {
    expect(() => createWatchdogPolicy({ idleTimeoutMs: -1 })).toThrow(TypeError);
    expect(() => createWatchdogPolicy({ idleTimeoutMs: -100 })).toThrow(TypeError);
  });

  it("idleTimeoutMs NaN → throw TypeError(下游 setTimeout 会当 0 立即触发)", () => {
    expect(() => createWatchdogPolicy({ idleTimeoutMs: Number.NaN })).toThrow(TypeError);
  });

  it("idleTimeoutMs Infinity → throw TypeError(setTimeout 会隐式 clamp 误导调用方)", () => {
    expect(() => createWatchdogPolicy({ idleTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => createWatchdogPolicy({ idleTimeoutMs: Number.NEGATIVE_INFINITY })).toThrow(TypeError);
  });

  it("idleTimeoutMs 错误信息提示用 0 禁用 idle-timer(documented feature)", () => {
    expect(() => createWatchdogPolicy({ idleTimeoutMs: -1 })).toThrow(/use 0 to disable/);
  });

  it("opts 部分覆盖,其他字段保留默认", () => {
    const p = createWatchdogPolicy({ idleTimeoutMs: 30_000 });
    expect(p.idleTimeoutMs).toBe(30_000);
    expect(p.warnThresholdRatio).toBe(0.5);
  });
});
