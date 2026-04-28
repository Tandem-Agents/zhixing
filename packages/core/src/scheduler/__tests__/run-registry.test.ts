import { describe, it, expect } from "vitest";
import { getAbortReason } from "../../interrupt/index.js";
import { RunRegistry } from "../run-registry.js";

describe("RunRegistry", () => {
  describe("基本生命周期", () => {
    it("registerRun 返回新 controller 的 signal,初始未 aborted", () => {
      const reg = new RunRegistry();
      const signal = reg.registerRun("r1");
      expect(signal.aborted).toBe(false);
      expect(reg.size()).toBe(1);
    });

    it("unregisterRun 移除条目,size 归零", () => {
      const reg = new RunRegistry();
      reg.registerRun("r1");
      reg.unregisterRun("r1");
      expect(reg.size()).toBe(0);
    });

    it("unregisterRun 不存在的 runId → no-op", () => {
      const reg = new RunRegistry();
      reg.unregisterRun("ghost");
      expect(reg.size()).toBe(0);
    });
  });

  describe("abortRun(runId, reason) 幂等 + typed reason 透传", () => {
    it("不存在的 runId → false", () => {
      const reg = new RunRegistry();
      expect(reg.abortRun("ghost", { kind: "external", origin: "x" })).toBe(false);
    });

    it("正常 fire → true,signal aborted,getAbortReason 拿到原 reason", () => {
      const reg = new RunRegistry();
      const signal = reg.registerRun("r1");
      const fired = reg.abortRun("r1", { kind: "external", origin: "cron-timeout" });
      expect(fired).toBe(true);
      expect(signal.aborted).toBe(true);
      expect(getAbortReason(signal)).toEqual({
        kind: "external",
        origin: "cron-timeout",
      });
    });

    it("已 aborted 时再 abort → false,first-wins 不覆盖 reason", () => {
      const reg = new RunRegistry();
      const signal = reg.registerRun("r1");
      reg.abortRun("r1", { kind: "user-cancel", source: "rpc", pressedAt: 1 });
      const second = reg.abortRun("r1", {
        kind: "external",
        origin: "scheduler-shutdown",
      });
      expect(second).toBe(false);
      expect(getAbortReason(signal)).toEqual({
        kind: "user-cancel",
        source: "rpc",
        pressedAt: 1,
      });
    });
  });

  describe("abortAll(reason)", () => {
    it("空注册表 → 0", () => {
      const reg = new RunRegistry();
      expect(reg.abortAll({ kind: "external", origin: "shutdown" })).toBe(0);
    });

    it("3 个 in-flight → 全 fire,返 3", () => {
      const reg = new RunRegistry();
      const s1 = reg.registerRun("r1");
      const s2 = reg.registerRun("r2");
      const s3 = reg.registerRun("r3");
      const aborted = reg.abortAll({
        kind: "external",
        origin: "scheduler-shutdown",
      });
      expect(aborted).toBe(3);
      expect(s1.aborted).toBe(true);
      expect(s2.aborted).toBe(true);
      expect(s3.aborted).toBe(true);
    });

    it("混合状态:已 aborted 不重复计数", () => {
      const reg = new RunRegistry();
      reg.registerRun("r1");
      reg.registerRun("r2");
      reg.abortRun("r1", { kind: "external" });
      const aborted = reg.abortAll({ kind: "external", origin: "shutdown" });
      expect(aborted).toBe(1);
    });
  });

  describe("abortAllAndWait — event-driven drain", () => {
    it("空注册表 → 立即返回 0", async () => {
      const reg = new RunRegistry();
      const aborted = await reg.abortAllAndWait({ kind: "external" });
      expect(aborted).toBe(0);
    });

    it("有 in-flight → unregisterRun(全清)触发 drain resolve(无轮询)", async () => {
      const reg = new RunRegistry();
      reg.registerRun("r1");
      reg.registerRun("r2");

      const drainPromise = reg.abortAllAndWait(
        { kind: "external", origin: "scheduler-shutdown" },
        5_000,
      );

      // 短暂等待确认 drain 还没 resolve
      await new Promise((r) => setTimeout(r, 30));
      let drained = false;
      drainPromise.then(() => {
        drained = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(drained).toBe(false);

      // 触发 unregister,清空 → drainResolver 应被调
      reg.unregisterRun("r1");
      reg.unregisterRun("r2");

      const aborted = await drainPromise;
      expect(aborted).toBe(2);
      expect(reg.size()).toBe(0);
    });

    it("超时路径:超时返回 aborted 数,不抛,后续 unregisterRun 不误调 resolver", async () => {
      const reg = new RunRegistry();
      reg.registerRun("r1");

      const aborted = await reg.abortAllAndWait(
        { kind: "external", origin: "shutdown" },
        50, // 50ms 超时
      );
      expect(aborted).toBe(1);
      // signal 被 fire 但 run 没 unregister(模拟"进程超时仍 hang"场景)
      // 此时再 unregister 不应抛错(drainResolver 已被超时路径清空)
      expect(() => reg.unregisterRun("r1")).not.toThrow();
    });

    it("超时之前 unregister 完成 → 走 fast path,不等到超时", async () => {
      const reg = new RunRegistry();
      reg.registerRun("r1");

      // 200ms 后 unregister
      const t = setTimeout(() => reg.unregisterRun("r1"), 50);

      const start = Date.now();
      const aborted = await reg.abortAllAndWait({ kind: "external" }, 5_000);
      const elapsed = Date.now() - start;
      clearTimeout(t);

      expect(aborted).toBe(1);
      // 应该远早于 5_000(给 200ms 余量)
      expect(elapsed).toBeLessThan(500);
    });
  });
});
