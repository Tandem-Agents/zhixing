import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { DeliveryPipeline } from "../pipeline.js";
import type { DeliveryPipelineConfig, DeliveryPipelineDeps } from "../pipeline.js";
import { createEventBus } from "../../events/event-bus.js";
import type { DeliveryEventMap, DeliverySender } from "../types.js";

function createMockSender(overrides?: Partial<DeliverySender>): DeliverySender {
  return {
    send: vi.fn().mockResolvedValue({ success: true, retryable: false }),
    isReady: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function createTestPipeline(options: {
  queueFilePath: string;
  sender?: DeliverySender;
  config?: Partial<DeliveryPipelineConfig>;
  now?: () => Date;
}) {
  const eventBus = createEventBus<DeliveryEventMap>();
  const sender = options.sender ?? createMockSender();
  const config: DeliveryPipelineConfig = {
    maxAttempts: 3,
    baseRetryDelayMs: 1000,
    flushIntervalMs: 0,
    itemTtlMs: 60 * 60 * 1000,
    queueFilePath: options.queueFilePath,
    ...options.config,
  };

  const pipeline = new DeliveryPipeline({
    sender,
    eventBus,
    config,
    now: options.now,
  });

  return { pipeline, eventBus, sender, config };
}

describe("DeliveryPipeline", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("dlv");
  });

  describe("enqueue", () => {
    it("returns a delivery id", async () => {
      const { pipeline } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      const id = await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      expect(id).toMatch(/^dlv_/);
      expect(pipeline.stats().queued).toBe(1);
      await pipeline.stop();
    });

    it("emits delivery:enqueued event", async () => {
      const { pipeline, eventBus } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      const events: unknown[] = [];
      eventBus.on("delivery:enqueued", (e) => events.push(e));

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      expect(events).toHaveLength(1);
      await pipeline.stop();
    });
  });

  describe("flush", () => {
    it("delivers queued items via sender", async () => {
      const sender = createMockSender();
      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      await pipeline.flush();

      expect(sender.send).toHaveBeenCalledOnce();
      expect(pipeline.stats().queued).toBe(0);
      expect(pipeline.stats().delivered).toBe(1);
      await pipeline.stop();
    });

    it("emits delivery:success on successful delivery", async () => {
      const { pipeline, eventBus } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      const events: unknown[] = [];
      eventBus.on("delivery:success", (e) => events.push(e));

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });
      await pipeline.flush();

      expect(events).toHaveLength(1);
      await pipeline.stop();
    });

    it("retries on retryable failure", async () => {
      let callCount = 0;
      const sender = createMockSender({
        send: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: false, error: "timeout", retryable: true };
          }
          return { success: true, retryable: false };
        }),
      });

      let time = 1000000;
      const { pipeline, eventBus } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
        now: () => new Date(time),
        config: { baseRetryDelayMs: 100 },
      });
      await pipeline.start();

      const retryEvents: unknown[] = [];
      eventBus.on("delivery:retry", (e) => retryEvents.push(e));

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      // First flush — fails, schedules retry
      await pipeline.flush();
      expect(retryEvents).toHaveLength(1);
      expect(pipeline.stats().queued).toBe(1);

      // Advance time past retry delay
      time += 200;
      await pipeline.flush();
      expect(sender.send).toHaveBeenCalledTimes(2);
      expect(pipeline.stats().delivered).toBe(1);
      expect(pipeline.stats().queued).toBe(0);
      await pipeline.stop();
    });

    it("fails permanently after max attempts", async () => {
      const sender = createMockSender({
        send: vi.fn().mockResolvedValue({
          success: false,
          error: "server error",
          retryable: true,
        }),
      });

      let time = 1000000;
      const { pipeline, eventBus } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
        now: () => new Date(time),
        config: { maxAttempts: 2, baseRetryDelayMs: 100 },
      });
      await pipeline.start();

      const failEvents: Array<{ error: string; attempts: number }> = [];
      eventBus.on("delivery:failed", (e) => failEvents.push(e));

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      // Attempt 1
      await pipeline.flush();
      time += 200;
      // Attempt 2 — final
      await pipeline.flush();

      expect(failEvents).toHaveLength(1);
      expect(failEvents[0]!.attempts).toBe(2);
      expect(pipeline.stats().failed).toBe(1);
      expect(pipeline.stats().queued).toBe(0);
      await pipeline.stop();
    });

    it("skips items when channel is not ready, retries later", async () => {
      let ready = false;
      const sender = createMockSender({
        isReady: vi.fn().mockImplementation(() => ready),
      });

      let time = 1000000;
      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
        now: () => new Date(time),
        config: { baseRetryDelayMs: 100 },
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      // Channel not ready — should defer without consuming attempts
      await pipeline.flush();
      expect(sender.send).not.toHaveBeenCalled();
      expect(pipeline.stats().queued).toBe(1);

      // Channel becomes ready
      ready = true;
      time += 200;
      await pipeline.flush();
      expect(sender.send).toHaveBeenCalledOnce();
      expect(pipeline.stats().delivered).toBe(1);
      await pipeline.stop();
    });

    it("does not consume attempts when channel is not ready", async () => {
      let ready = false;
      let time = 1000000;
      const sender = createMockSender({
        isReady: vi.fn().mockImplementation(() => ready),
      });

      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
        now: () => new Date(time),
        config: { maxAttempts: 2, baseRetryDelayMs: 100 },
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      // 5 flushes with channel not ready — should NOT exhaust attempts
      for (let i = 0; i < 5; i++) {
        await pipeline.flush();
        time += 200;
      }

      expect(pipeline.stats().queued).toBe(1);
      expect(pipeline.stats().failed).toBe(0);

      // Channel becomes ready — succeeds on first actual attempt
      ready = true;
      await pipeline.flush();
      expect(sender.send).toHaveBeenCalledOnce();
      expect(pipeline.stats().delivered).toBe(1);
      await pipeline.stop();
    });

    it("faithful delivery: 相同 target + 相同 content 连续 enqueue 两次都送达（不 dedup）", async () => {
      // 架构契约：Pipeline 忠实送达每一条 enqueued item，不主动做内容去重。
      // 真实业务场景：两个独立 scheduler task 可能巧合生成相同文本——都应到达 user。
      // 防回归测试（替代历史上的 "deduplicates identical content"）。
      const sender = createMockSender();
      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      const target = { channelId: "feishu", to: "user1" };
      const content = { text: "same message" };

      await pipeline.enqueue({ target, content });
      await pipeline.flush();
      expect(sender.send).toHaveBeenCalledOnce();

      await pipeline.enqueue({ target, content });
      await pipeline.flush();

      // 两条都要送达，不被 drop
      expect(sender.send).toHaveBeenCalledTimes(2);
      expect(pipeline.stats().delivered).toBe(2);
      await pipeline.stop();
    });

    it("processes higher priority items first", async () => {
      const sendOrder: string[] = [];
      const sender = createMockSender({
        send: vi.fn().mockImplementation(async (_target, content) => {
          sendOrder.push(content.text);
          return { success: true, retryable: false };
        }),
      });

      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "low" },
        priority: "low",
      });
      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "high" },
        priority: "high",
      });
      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "normal" },
        priority: "normal",
      });

      await pipeline.flush();
      expect(sendOrder).toEqual(["high", "normal", "low"]);
      await pipeline.stop();
    });
  });

  describe("flush 并发语义（singleflight）", () => {
    it("并发多次 flush 共享同一 drain——所有 caller 等同一次完成", async () => {
      // 构造慢 send（20ms 延迟），让 drain 有明显时间窗
      let sendCount = 0;
      const sender = createMockSender({
        send: vi.fn(async () => {
          sendCount++;
          await new Promise((r) => setTimeout(r, 20));
          return { success: true, retryable: false };
        }),
      });

      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "u1" },
        content: { text: "only one" },
      });

      // 3 个并发 caller 同时 flush
      const [r1, r2, r3] = await Promise.all([
        pipeline.flush(),
        pipeline.flush(),
        pipeline.flush(),
      ]);

      // 所有 caller 都返回 void（没抛/没假值）
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
      expect(r3).toBeUndefined();

      // item 只被 send 一次（不会因三次 flush 被重复 send）
      expect(sendCount).toBe(1);
      expect(pipeline.stats().delivered).toBe(1);
      await pipeline.stop();
    });

    it("R2: stop() 等 in-flight drain 完成（优雅关停，不留后台 send 泄漏）", async () => {
      // 构造一个"慢 send"：开始 send 后延迟 40ms 才 resolve，
      // 给 stop 介入的时间窗。
      let sendResolveAt = 0;
      let stopResolveAt = 0;
      const sender = createMockSender({
        send: vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 40));
          sendResolveAt = Date.now();
          return { success: true, retryable: false };
        }),
      });

      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();
      await pipeline.enqueue({
        target: { channelId: "feishu", to: "u1" },
        content: { text: "inflight" },
      });

      // 启动 flush 但**不 await**——让它在后台跑
      const flushPromise = pipeline.flush();

      // 短暂等待让 drain 真正进入 send
      await new Promise((r) => setTimeout(r, 5));

      // 此时 send 正在执行。stop 应等它完成
      await pipeline.stop();
      stopResolveAt = Date.now();

      // 断言 stop 返回时 send 已完成（stop 至少等到 send resolve 后）
      expect(sendResolveAt).toBeGreaterThan(0);
      expect(stopResolveAt).toBeGreaterThanOrEqual(sendResolveAt);

      // 之前 fire 的 flush promise 也应该正常 resolve
      await expect(flushPromise).resolves.toBeUndefined();
      expect(pipeline.stats().delivered).toBe(1);
    });

    it("先 flush 返回后再 flush → 启新一轮 drain", async () => {
      const sender = createMockSender();
      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "u1" },
        content: { text: "a" },
      });
      await pipeline.flush();
      expect(sender.send).toHaveBeenCalledTimes(1);

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "u1" },
        content: { text: "b" },
      });
      await pipeline.flush();
      expect(sender.send).toHaveBeenCalledTimes(2);
      await pipeline.stop();
    });
  });

  describe("生命周期（lifecycle）", () => {
    it("未 start 就 enqueue → 抛错（防止覆盖磁盘已有数据）", async () => {
      const { pipeline } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      // 故意不 start
      await expect(
        pipeline.enqueue({
          target: { channelId: "feishu", to: "u1" },
          content: { text: "x" },
        }),
      ).rejects.toThrow(/not running.*state="unstarted"/);
    });

    it("未 start 就 flush → 抛错", async () => {
      const { pipeline } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      await expect(pipeline.flush()).rejects.toThrow(/not running.*state="unstarted"/);
    });

    it("stopped 后 enqueue/flush → 抛错", async () => {
      const { pipeline } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();
      await pipeline.stop();

      await expect(
        pipeline.enqueue({
          target: { channelId: "feishu", to: "u1" },
          content: { text: "x" },
        }),
      ).rejects.toThrow(/not running.*state="stopped"/);
      await expect(pipeline.flush()).rejects.toThrow(/not running.*state="stopped"/);
    });

    it("重复 start → 抛错（pipeline 单次使用）", async () => {
      const { pipeline } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();
      await expect(pipeline.start()).rejects.toThrow(/illegal transition.*state="running"/);
      await pipeline.stop();
    });

    it("stopped 后再 stop → 幂等（无副作用）", async () => {
      const { pipeline } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();
      await pipeline.stop();
      await expect(pipeline.stop()).resolves.toBeUndefined();
    });

    it("unstarted 就 stop → 抛错（通常是调用方 bug）", async () => {
      const { pipeline } = createTestPipeline({
        queueFilePath: join(tempDir, "q.json"),
      });
      await expect(pipeline.stop()).rejects.toThrow(/illegal transition.*state="unstarted"/);
    });
  });

  describe("crash recovery", () => {
    it("persists queue across restarts → 新 pipeline start() 即自动恢复（awaited flush）", async () => {
      const queuePath = join(tempDir, "q.json");
      const sender = createMockSender();

      // Pipeline 1: enqueue but don't flush
      const p1 = createTestPipeline({
        sender,
        queueFilePath: queuePath,
      });
      await p1.pipeline.start();
      await p1.pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "survived crash" },
      });
      await p1.pipeline.stop();

      // Pipeline 2: start() 同步 load + 恢复 flush
      const p2 = createTestPipeline({
        sender,
        queueFilePath: queuePath,
      });
      await p2.pipeline.start();

      // start() 返回时已完成恢复（awaited recovery flush）——无 race，无延迟
      expect(sender.send).toHaveBeenCalledOnce();
      expect(p2.pipeline.stats().delivered).toBe(1);
      expect(p2.pipeline.stats().queued).toBe(0);
      await p2.pipeline.stop();
    });

    it("R1: recovery flush 抛错时 start 不失败（软降级 + warn）", async () => {
      const queuePath = join(tempDir, "q.json");

      // p1 正常 enqueue + stop，磁盘留 1 条 pending
      const p1 = createTestPipeline({
        sender: createMockSender(),
        queueFilePath: queuePath,
      });
      await p1.pipeline.start();
      await p1.pipeline.enqueue({
        target: { channelId: "feishu", to: "u1" },
        content: { text: "x" },
      });
      await p1.pipeline.stop();

      // p2: 构造一个让 flush 抛错的 sender（send 抛）
      const warns: string[] = [];
      const p2Sender = createMockSender({
        send: vi.fn().mockRejectedValue(new Error("io boom")),
      });
      const p2 = createTestPipeline({
        sender: p2Sender,
        queueFilePath: queuePath,
      });
      // 用 spy 捕获 warn 日志
      p2.pipeline["logger"] = {
        info: () => {},
        warn: (msg: string) => warns.push(msg),
        error: () => {},
        debug: () => {},
      };

      // start 不抛——即使 recovery flush 路径里 send 抛错
      await expect(p2.pipeline.start()).resolves.toBeUndefined();

      // send 被尝试调用（recovery flush 跑了），但错误被 retry 路径吸收
      expect(p2Sender.send).toHaveBeenCalled();
      await p2.pipeline.stop();
    });

    it("crash 恢复时 sender 未 ready → defer 而不阻塞 start", async () => {
      const queuePath = join(tempDir, "q.json");

      // p1 enqueue 后 stop
      const p1Sender = createMockSender();
      const p1 = createTestPipeline({ sender: p1Sender, queueFilePath: queuePath });
      await p1.pipeline.start();
      await p1.pipeline.enqueue({
        target: { channelId: "feishu", to: "u1" },
        content: { text: "deferred" },
      });
      await p1.pipeline.stop();

      // p2 的 sender 未 ready——recovery flush 不会 send，只 defer
      const p2Sender = createMockSender({ isReady: vi.fn().mockReturnValue(false) });
      const p2 = createTestPipeline({ sender: p2Sender, queueFilePath: queuePath });
      await p2.pipeline.start();

      // send 没调，item 仍在 queue，nextAttemptAt 被设
      expect(p2Sender.send).not.toHaveBeenCalled();
      expect(p2.pipeline.stats().queued).toBe(1);
      await p2.pipeline.stop();
    });
  });

  describe("exponential backoff", () => {
    it("doubles delay on each retry", async () => {
      const sender = createMockSender({
        send: vi.fn().mockResolvedValue({
          success: false,
          error: "fail",
          retryable: true,
        }),
      });

      let time = 0;
      const retryDelays: string[] = [];
      const { pipeline, eventBus } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
        now: () => new Date(time),
        config: { maxAttempts: 4, baseRetryDelayMs: 1000 },
      });
      await pipeline.start();

      eventBus.on("delivery:retry", (e) => retryDelays.push(e.nextAttemptAt));

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      // Attempt 1 → retry at t+1000
      await pipeline.flush();
      time += 1100;

      // Attempt 2 → retry at t+2000
      await pipeline.flush();
      time += 2100;

      // Attempt 3 → retry at t+4000
      await pipeline.flush();

      expect(retryDelays).toHaveLength(3);

      const delays = retryDelays.map((d) => new Date(d).getTime());
      // base * 2^0 = 1000, base * 2^1 = 2000, base * 2^2 = 4000
      expect(delays[1]! - delays[0]!).toBeGreaterThanOrEqual(1000);
      expect(delays[2]! - delays[1]!).toBeGreaterThanOrEqual(2000);
      await pipeline.stop();
    });
  });

  describe("stats", () => {
    it("tracks delivered, failed, retrying counts", async () => {
      const sender = createMockSender({
        send: vi.fn()
          .mockResolvedValueOnce({ success: true, retryable: false })
          .mockResolvedValueOnce({
            success: false,
            error: "fatal",
            retryable: false,
          }),
      });

      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "success" },
      });
      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "failure" },
      });

      await pipeline.flush();

      const stats = pipeline.stats();
      expect(stats.delivered).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.queued).toBe(0);
      await pipeline.stop();
    });
  });

  describe("item expiry", () => {
    it("expires items that exceed TTL", async () => {
      let time = 1000000;
      const sender = createMockSender();
      const { pipeline, eventBus } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
        now: () => new Date(time),
        config: { itemTtlMs: 5000 },
      });
      await pipeline.start();

      const failEvents: Array<{ error: string }> = [];
      eventBus.on("delivery:failed", (e) => failEvents.push(e));

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      // Advance time past TTL
      time += 6000;
      await pipeline.flush();

      expect(sender.send).not.toHaveBeenCalled();
      expect(failEvents).toHaveLength(1);
      expect(failEvents[0]!.error).toContain("Expired");
      expect(pipeline.stats().failed).toBe(1);
      expect(pipeline.stats().queued).toBe(0);
      await pipeline.stop();
    });

    it("delivers items within TTL", async () => {
      let time = 1000000;
      const sender = createMockSender();
      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
        now: () => new Date(time),
        config: { itemTtlMs: 5000 },
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "hello" },
      });

      time += 3000;
      await pipeline.flush();

      expect(sender.send).toHaveBeenCalledOnce();
      expect(pipeline.stats().delivered).toBe(1);
      await pipeline.stop();
    });
  });

  describe("error isolation", () => {
    it("continues processing when sender throws", async () => {
      let callCount = 0;
      const sender = createMockSender({
        send: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) throw new Error("boom");
          return { success: true, retryable: false };
        }),
      });

      const { pipeline } = createTestPipeline({
        sender,
        queueFilePath: join(tempDir, "q.json"),
        config: { maxAttempts: 1 },
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user1" },
        content: { text: "throws" },
      });
      await pipeline.enqueue({
        target: { channelId: "feishu", to: "user2" },
        content: { text: "succeeds" },
      });

      await pipeline.flush();
      expect(pipeline.stats().failed).toBe(1);
      expect(pipeline.stats().delivered).toBe(1);
      await pipeline.stop();
    });
  });
});
