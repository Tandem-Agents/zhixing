import { describe, it, expect, vi } from "vitest";
import { CleanupRegistry } from "../cleanup-registry.js";

describe("CleanupRegistry", () => {
  it("runs entries in LIFO order", async () => {
    const r = new CleanupRegistry({ logger: quietLogger() });
    const order: string[] = [];
    r.register("first", () => {
      order.push("first");
    });
    r.register("second", () => {
      order.push("second");
    });
    r.register("third", () => {
      order.push("third");
    });

    await r.runAll("test");
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("isolates failures — one failing entry does not block others", async () => {
    const r = new CleanupRegistry({ logger: quietLogger() });
    const ran: string[] = [];
    r.register("a", () => {
      ran.push("a");
    });
    r.register("b", () => {
      throw new Error("boom");
    });
    r.register("c", () => {
      ran.push("c");
    });

    await r.runAll("test");
    expect(ran).toEqual(["c", "a"]); // b 抛错但不影响 a / c 执行
  });

  it("logs error when entry fails", async () => {
    const logger = quietLogger();
    const r = new CleanupRegistry({ logger });
    r.register("failing", () => {
      throw new Error("boom");
    });

    await r.runAll("test");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/failing/),
      expect.any(Error),
    );
  });

  it("is idempotent — second runAll is a no-op", async () => {
    const r = new CleanupRegistry({ logger: quietLogger() });
    const fn = vi.fn();
    r.register("x", fn);

    await r.runAll("first");
    await r.runAll("second");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.finished).toBe(true);
  });

  it("rejects register after runAll", async () => {
    const logger = quietLogger();
    const r = new CleanupRegistry({ logger });
    r.register("x", () => {});
    await r.runAll("test");

    r.register("late", () => {});
    expect(r.size).toBe(1); // 未被追加
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/after runAll/));
  });

  it("awaits async entries sequentially", async () => {
    const r = new CleanupRegistry({ logger: quietLogger() });
    const order: string[] = [];
    r.register("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("slow-done");
    });
    r.register("fast", async () => {
      order.push("fast-done");
    });

    await r.runAll("test");
    // LIFO：fast 先跑（immediate），然后 slow（await 完成）
    expect(order).toEqual(["fast-done", "slow-done"]);
  });

  it("passes reason to cleanup fn", async () => {
    const r = new CleanupRegistry({ logger: quietLogger() });
    const seen: string[] = [];
    r.register("observe", (reason) => {
      seen.push(reason);
    });

    await r.runAll("SIGTERM");
    expect(seen).toEqual(["SIGTERM"]);
  });
});

function quietLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}
