import { describe, expect, it, vi } from "vitest";
import { EventBus, createEventBus } from "./event-bus.js";
import type { IEventBus } from "./types.js";

// 测试用事件映射表
type TestEvents = {
  "user:login": { userId: string; timestamp: number };
  "user:logout": { userId: string };
  "system:error": { code: number; message: string };
  "data:update": { key: string; value: unknown };
  simple: string;
};

describe("EventBus", () => {
  // ─── 基础 on/emit ───

  describe("on + emit", () => {
    it("应注册监听器并在 emit 时触发", async () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      bus.on("user:login", handler);
      await bus.emit("user:login", { userId: "u1", timestamp: 1000 });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ userId: "u1", timestamp: 1000 });
    });

    it("应按注册顺序执行多个监听器", async () => {
      const bus = createEventBus<TestEvents>();
      const order: number[] = [];

      bus.on("simple", () => { order.push(1); });
      bus.on("simple", () => { order.push(2); });
      bus.on("simple", () => { order.push(3); });

      await bus.emit("simple", "test");

      expect(order).toEqual([1, 2, 3]);
    });

    it("不同事件的监听器互不影响", async () => {
      const bus = createEventBus<TestEvents>();
      const loginHandler = vi.fn();
      const logoutHandler = vi.fn();

      bus.on("user:login", loginHandler);
      bus.on("user:logout", logoutHandler);

      await bus.emit("user:login", { userId: "u1", timestamp: 1000 });

      expect(loginHandler).toHaveBeenCalledOnce();
      expect(logoutHandler).not.toHaveBeenCalled();
    });

    it("没有监听器时 emit 不报错", async () => {
      const bus = createEventBus<TestEvents>();
      await expect(bus.emit("simple", "no listeners")).resolves.toBeUndefined();
    });
  });

  // ─── off ───

  describe("off", () => {
    it("应移除指定监听器", async () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      bus.on("simple", handler);
      bus.off("simple", handler);
      await bus.emit("simple", "test");

      expect(handler).not.toHaveBeenCalled();
    });

    it("on 返回的 unsubscribe 应正确移除监听器", async () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      const unsub = bus.on("simple", handler);
      unsub();
      await bus.emit("simple", "test");

      expect(handler).not.toHaveBeenCalled();
    });

    it("移除不存在的监听器不报错", () => {
      const bus = createEventBus<TestEvents>();
      expect(() => bus.off("simple", vi.fn())).not.toThrow();
    });

    it("移除不存在的事件不报错", () => {
      const bus = createEventBus<TestEvents>();
      expect(() => bus.off("simple", vi.fn())).not.toThrow();
    });
  });

  // ─── once ───

  describe("once", () => {
    it("应只触发一次后自动移除", async () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      bus.once("simple", handler);

      await bus.emit("simple", "first");
      await bus.emit("simple", "second");

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith("first");
    });

    it("once 返回的 unsubscribe 应在触发前可取消", async () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      const unsub = bus.once("simple", handler);
      unsub();
      await bus.emit("simple", "test");

      expect(handler).not.toHaveBeenCalled();
    });

    it("可以通过原始 listener 引用调用 off 移除 once 监听器", async () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      bus.once("simple", handler);
      bus.off("simple", handler);
      await bus.emit("simple", "test");

      expect(handler).not.toHaveBeenCalled();
    });

    it("多个 once 监听器在同一次 emit 中全部执行", async () => {
      const bus = createEventBus<TestEvents>();
      const h1 = vi.fn();
      const h2 = vi.fn();

      bus.once("simple", h1);
      bus.once("simple", h2);
      await bus.emit("simple", "test");

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
      expect(bus.listenerCount("simple")).toBe(0);
    });
  });

  // ─── onAny (通配符) ───

  describe("onAny", () => {
    it("应监听所有事件", async () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      bus.onAny(handler);

      await bus.emit("user:login", { userId: "u1", timestamp: 1 });
      await bus.emit("simple", "hello");

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, "user:login", {
        userId: "u1",
        timestamp: 1,
      });
      expect(handler).toHaveBeenNthCalledWith(2, "simple", "hello");
    });

    it("onAny 返回的 unsubscribe 应正确取消", async () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      const unsub = bus.onAny(handler);
      unsub();
      await bus.emit("simple", "test");

      expect(handler).not.toHaveBeenCalled();
    });

    it("通配符监听器在具体事件监听器之后执行", async () => {
      const bus = createEventBus<TestEvents>();
      const order: string[] = [];

      bus.on("simple", () => { order.push("specific"); });
      bus.onAny(() => { order.push("wildcard"); });

      await bus.emit("simple", "test");

      expect(order).toEqual(["specific", "wildcard"]);
    });
  });

  // ─── 异步支持 ───

  describe("async listeners", () => {
    it("emit 应等待异步监听器完成", async () => {
      const bus = createEventBus<TestEvents>();
      let completed = false;

      bus.on("simple", async () => {
        await delay(50);
        completed = true;
      });

      await bus.emit("simple", "test");
      expect(completed).toBe(true);
    });

    it("异步监听器应按顺序执行（非并行）", async () => {
      const bus = createEventBus<TestEvents>();
      const order: number[] = [];

      bus.on("simple", async () => {
        await delay(30);
        order.push(1);
      });
      bus.on("simple", async () => {
        await delay(10);
        order.push(2);
      });

      await bus.emit("simple", "test");
      expect(order).toEqual([1, 2]);
    });

    it("emitSync 不等待异步监听器", () => {
      const bus = createEventBus<TestEvents>();
      let completed = false;

      bus.on("simple", async () => {
        await delay(50);
        completed = true;
      });

      bus.emitSync("simple", "test");
      expect(completed).toBe(false);
    });
  });

  // ─── 错误隔离 ───

  describe("error isolation", () => {
    it("一个监听器的同步错误不阻止其他监听器执行", async () => {
      const errorHandler = vi.fn();
      const bus = createEventBus<TestEvents>({ onError: errorHandler });
      const h1 = vi.fn();
      const h2 = vi.fn(() => {
        throw new Error("boom");
      });
      const h3 = vi.fn();

      bus.on("simple", h1);
      bus.on("simple", h2);
      bus.on("simple", h3);

      await bus.emit("simple", "test");

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
      expect(h3).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error), "simple");
    });

    it("一个监听器的异步错误不阻止其他监听器执行", async () => {
      const errorHandler = vi.fn();
      const bus = createEventBus<TestEvents>({ onError: errorHandler });
      const h1 = vi.fn();
      const h3 = vi.fn();

      bus.on("simple", h1);
      bus.on("simple", async () => {
        throw new Error("async boom");
      });
      bus.on("simple", h3);

      await bus.emit("simple", "test");

      expect(h1).toHaveBeenCalledOnce();
      expect(h3).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error), "simple");
    });

    it("emitSync 中异步监听器的错误也被捕获", async () => {
      const errorHandler = vi.fn();
      const bus = createEventBus<TestEvents>({ onError: errorHandler });

      bus.on("simple", async () => {
        throw new Error("async error in sync emit");
      });

      bus.emitSync("simple", "test");

      // 等待微任务队列完成
      await delay(10);
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error), "simple");
    });

    it("通配符监听器的错误也被隔离", async () => {
      const errorHandler = vi.fn();
      const bus = createEventBus<TestEvents>({ onError: errorHandler });
      const specificHandler = vi.fn();

      bus.on("simple", specificHandler);
      bus.onAny(() => {
        throw new Error("wildcard error");
      });

      await bus.emit("simple", "test");

      expect(specificHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error), "simple");
    });

    it("未提供 onError 时使用 console.error", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const bus = createEventBus<TestEvents>();

      bus.on("simple", () => {
        throw new Error("uncaught");
      });

      await bus.emit("simple", "test");

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ─── removeAllListeners ───

  describe("removeAllListeners", () => {
    it("移除指定事件的所有监听器", async () => {
      const bus = createEventBus<TestEvents>();
      const h1 = vi.fn();
      const h2 = vi.fn();

      bus.on("simple", h1);
      bus.on("simple", h2);
      bus.removeAllListeners("simple");

      await bus.emit("simple", "test");

      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
    });

    it("不传参时移除所有事件的所有监听器（含通配符）", async () => {
      const bus = createEventBus<TestEvents>();
      const h1 = vi.fn();
      const h2 = vi.fn();
      const wildcard = vi.fn();

      bus.on("simple", h1);
      bus.on("user:login", h2);
      bus.onAny(wildcard);
      bus.removeAllListeners();

      await bus.emit("simple", "test");
      await bus.emit("user:login", { userId: "u1", timestamp: 1 });

      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
      expect(wildcard).not.toHaveBeenCalled();
    });
  });

  // ─── listenerCount / eventNames ───

  describe("introspection", () => {
    it("listenerCount 返回正确数量", () => {
      const bus = createEventBus<TestEvents>();

      expect(bus.listenerCount("simple")).toBe(0);

      bus.on("simple", vi.fn());
      bus.on("simple", vi.fn());
      expect(bus.listenerCount("simple")).toBe(2);
    });

    it("eventNames 返回所有已注册事件名", () => {
      const bus = createEventBus<TestEvents>();

      bus.on("simple", vi.fn());
      bus.on("user:login", vi.fn());

      const names = bus.eventNames();
      expect(names).toContain("simple");
      expect(names).toContain("user:login");
      expect(names).toHaveLength(2);
    });

    it("移除所有监听器后 eventNames 不再包含该事件", () => {
      const bus = createEventBus<TestEvents>();
      const handler = vi.fn();

      bus.on("simple", handler);
      bus.off("simple", handler);

      expect(bus.eventNames()).not.toContain("simple");
    });
  });

  // ─── maxListeners 警告 ───

  describe("maxListeners warning", () => {
    it("超过 maxListeners 时触发警告", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const bus = createEventBus<TestEvents>({ maxListeners: 2 });

      bus.on("simple", vi.fn());
      bus.on("simple", vi.fn());
      expect(warnSpy).not.toHaveBeenCalled();

      bus.on("simple", vi.fn());
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("3 listeners"),
      );

      warnSpy.mockRestore();
    });
  });

  // ─── emit 期间的安全性 ───

  describe("emit safety", () => {
    it("emit 期间注册的新监听器不在本次 emit 中触发", async () => {
      const bus = createEventBus<TestEvents>();
      const lateHandler = vi.fn();

      bus.on("simple", () => {
        bus.on("simple", lateHandler);
      });

      await bus.emit("simple", "test");
      expect(lateHandler).not.toHaveBeenCalled();

      // 下次 emit 才触发
      await bus.emit("simple", "test2");
      expect(lateHandler).toHaveBeenCalledOnce();
    });
  });

  // ─── 类型安全验证（编译期，此处仅验证实例化正确性） ───

  describe("type safety", () => {
    it("createEventBus 工厂函数返回 IEventBus 类型", () => {
      const bus: IEventBus<TestEvents> = createEventBus<TestEvents>();
      expect(bus).toBeInstanceOf(EventBus);
    });

    it("EventBus 构造函数直接使用", () => {
      const bus = new EventBus<TestEvents>();
      expect(bus.eventNames()).toEqual([]);
    });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
