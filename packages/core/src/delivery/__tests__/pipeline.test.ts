import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function createTestPipeline(options?: {
  sender?: DeliverySender;
  queueFilePath?: string;
  config?: Partial<DeliveryPipelineConfig>;
  now?: () => Date;
}) {
  const eventBus = createEventBus<DeliveryEventMap>();
  const sender = options?.sender ?? createMockSender();
  const config: DeliveryPipelineConfig = {
    maxAttempts: 3,
    baseRetryDelayMs: 1000,
    flushIntervalMs: 0,
    itemTtlMs: 60 * 60 * 1000,
    queueFilePath: options?.queueFilePath ?? join(tmpdir(), `zhixing-dlv-${Date.now()}.json`),
    ...options?.config,
  };

  const pipeline = new DeliveryPipeline({
    sender,
    eventBus,
    config,
    now: options?.now,
  });

  return { pipeline, eventBus, sender, config };
}

describe("DeliveryPipeline", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhixing-dlv-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
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

    it("deduplicates identical content", async () => {
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

      // Enqueue same content again
      await pipeline.enqueue({ target, content });
      await pipeline.flush();
      // Dedup should filter it out
      expect(sender.send).toHaveBeenCalledOnce();
      expect(pipeline.stats().delivered).toBe(1);
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

  describe("crash recovery", () => {
    it("persists queue across restarts", async () => {
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

      // Pipeline 2: load from persisted queue
      const p2 = createTestPipeline({
        sender,
        queueFilePath: queuePath,
      });
      await p2.pipeline.start();
      expect(p2.pipeline.stats().queued).toBe(1);

      await p2.pipeline.flush();
      expect(sender.send).toHaveBeenCalledOnce();
      expect(p2.pipeline.stats().delivered).toBe(1);
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
