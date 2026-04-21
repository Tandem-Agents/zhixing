/**
 * Outbox 集成测试 —— 验证 ADR-007 核心不变量在真实组合下成立
 *
 * 场景：
 * 1. Pipeline → Outbox → adapter 整链路
 * 2. 多生产者（"LLM 回复"直接 post + Scheduler 经 Pipeline）并发到同一 target 时保序（INV-1）
 * 3. DeliverySource 正确映射到 EmissionSource
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryPipeline, DEFAULT_DELIVERY_CONFIG } from "../pipeline.js";
import { OutboxRegistry } from "../outbox-registry.js";
import { createOutboxSender } from "../outbox-sender.js";
import { createEventBus } from "../../events/event-bus.js";
import type {
  DeliveryEventMap,
  DeliverySource,
} from "../types.js";
import type {
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "../../channels/types.js";
import type {
  EmissionSource,
  OutboxEntry,
  OutboxEvent,
} from "../outbox-types.js";

// ─── 测试工具 ───

const TARGET: DeliveryTarget = { channelId: "feishu", to: "ou_user_1" };

interface SendCall {
  readonly target: DeliveryTarget;
  readonly content: OutboundContent;
  readonly receivedAt: number;
}

function makePipelineFixture(opts: {
  adapterSend: (target: DeliveryTarget, content: OutboundContent) => Promise<DeliveryResult>;
  outboxEvents?: OutboxEvent[];
}) {
  const registry = new OutboxRegistry(opts.adapterSend, {
    onEvent: opts.outboxEvents ? (e) => opts.outboxEvents!.push(e) : undefined,
    sendTimeoutMs: 0,  // 测试里用 0 关闭超时包装
  });
  const sender = createOutboxSender(registry, {
    isReady: () => true,
  });
  return { registry, sender };
}

async function makePipeline(opts: {
  registry: OutboxRegistry;
  sender: ReturnType<typeof createOutboxSender>;
  tempDir: string;
}) {
  const eventBus = createEventBus<DeliveryEventMap>();
  const pipeline = new DeliveryPipeline({
    sender: opts.sender,
    eventBus,
    config: {
      ...DEFAULT_DELIVERY_CONFIG,
      flushIntervalMs: 0,
      queueFilePath: join(opts.tempDir, "queue.json"),
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });
  await pipeline.start();
  return { pipeline, eventBus };
}

// ─── Pipeline → Outbox 链路 ───

describe("Pipeline → Outbox 整链", () => {
  it("Pipeline.enqueue 经 Outbox 到达 adapter（而非绕过）", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbox-int-"));
    try {
      const sendCalls: SendCall[] = [];
      const outboxEvents: OutboxEvent[] = [];

      const { registry, sender } = makePipelineFixture({
        adapterSend: async (target, content) => {
          sendCalls.push({ target, content, receivedAt: Date.now() });
          return { success: true, retryable: false };
        },
        outboxEvents,
      });
      const { pipeline } = await makePipeline({ registry, sender, tempDir });

      await pipeline.enqueue({
        target: TARGET,
        content: { text: "scheduled result" },
        source: { kind: "scheduler", taskId: "t_1", taskName: "reminder" },
      });
      await pipeline.flush();

      // 1. adapter 被调用
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]!.content.text).toBe("scheduled result");

      // 2. Outbox 事件链完整（证明走了 Outbox 而非绕过）
      const types = outboxEvents.map((e) => e.type);
      expect(types).toContain("entry:enqueued");
      expect(types).toContain("entry:sent");

      // 3. DeliverySource → EmissionSource 映射正确
      const enqueued = outboxEvents.find((e) => e.type === "entry:enqueued") as
        | Extract<OutboxEvent, { type: "entry:enqueued" }>
        | undefined;
      expect(enqueued?.entry.source).toEqual({
        kind: "scheduled-task",
        taskId: "t_1",
      } satisfies EmissionSource);

      await pipeline.stop();
      await registry.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("P3b: scheduler source 带 createdInTurn → entry.afterSlot + EmissionSource.createdInTurn 均透传", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbox-int-"));
    try {
      const outboxEvents: OutboxEvent[] = [];
      const { registry, sender } = makePipelineFixture({
        adapterSend: async () => ({ success: true, retryable: false }),
        outboxEvents,
      });
      const { pipeline } = await makePipeline({ registry, sender, tempDir });

      // 先开 slot（否则 drain 看到 afterSlot 指向未开的 slot 会 orphan 放行）
      const outbox = registry.of(TARGET);
      outbox.openSlot({ slotId: "turn_xyz" });
      await outbox.fillSlot("turn_xyz");  // 立即 fill，保证 drain 能完成

      await pipeline.enqueue({
        target: TARGET,
        content: { text: "scheduled-in-turn" },
        source: {
          kind: "scheduler",
          taskId: "t_turn",
          taskName: "after-llm",
          createdInTurn: "turn_xyz",
        },
      });
      await pipeline.flush();
      await outbox.waitIdle();

      const enqueued = outboxEvents.find((e) => e.type === "entry:enqueued") as
        | Extract<OutboxEvent, { type: "entry:enqueued" }>
        | undefined;
      expect(enqueued).toBeDefined();
      // afterSlot 透传到 OutboxEntry（drain 因果层用）
      expect(enqueued?.entry.afterSlot).toBe("turn_xyz");
      // EmissionSource 也带上 createdInTurn（审计/日志用）
      expect(enqueued?.entry.source).toEqual({
        kind: "scheduled-task",
        taskId: "t_turn",
        createdInTurn: "turn_xyz",
      } satisfies EmissionSource);

      await pipeline.stop();
      await registry.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("P3b: scheduler source 无 createdInTurn → 无 afterSlot，EmissionSource 不带该字段", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbox-int-"));
    try {
      const outboxEvents: OutboxEvent[] = [];
      const { registry, sender } = makePipelineFixture({
        adapterSend: async () => ({ success: true, retryable: false }),
        outboxEvents,
      });
      const { pipeline } = await makePipeline({ registry, sender, tempDir });

      await pipeline.enqueue({
        target: TARGET,
        content: { text: "scheduled-no-turn" },
        source: { kind: "scheduler", taskId: "t_free", taskName: "no-turn" },
      });
      await pipeline.flush();

      const enqueued = outboxEvents.find((e) => e.type === "entry:enqueued") as
        | Extract<OutboxEvent, { type: "entry:enqueued" }>
        | undefined;
      expect(enqueued?.entry.afterSlot).toBeUndefined();
      expect(enqueued?.entry.source).toEqual({
        kind: "scheduled-task",
        taskId: "t_free",
      } satisfies EmissionSource);

      await pipeline.stop();
      await registry.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("agent 类型 DeliverySource 映射为 llm-reply EmissionSource", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbox-int-"));
    try {
      const outboxEvents: OutboxEvent[] = [];
      const { registry, sender } = makePipelineFixture({
        adapterSend: async () => ({ success: true, retryable: false }),
        outboxEvents,
      });
      const { pipeline } = await makePipeline({ registry, sender, tempDir });

      await pipeline.enqueue({
        target: TARGET,
        content: { text: "agent reply" },
        source: { kind: "agent", conversationId: "conv_1" } satisfies DeliverySource,
      });
      await pipeline.flush();

      const enqueued = outboxEvents.find((e) => e.type === "entry:enqueued") as
        | Extract<OutboxEvent, { type: "entry:enqueued" }>
        | undefined;
      expect(enqueued?.entry.source).toEqual({
        kind: "llm-reply",
        conversationId: "conv_1",
      } satisfies EmissionSource);

      await pipeline.stop();
      await registry.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── 多生产者同 target FIFO（INV-1 核心场景） ───

describe("多生产者同 target 保序（INV-1）", () => {
  it("直接 post（模拟 LLM 回复）与 Pipeline.enqueue（模拟 Scheduler）交错——各自 post 到 Outbox 的顺序即为 adapter 到达顺序", async () => {
    // 说明：INV-1 保证的是 "outbox.post 调用顺序 = adapter 到达顺序"，
    // 不是 "pipeline.enqueue 调用顺序"——Pipeline 有持久化/过滤/去重，
    // 从 enqueue 到实际调 sender.send 有可观察的异步延迟，不受 INV-1 管辖。
    //
    // 此测试验证：一旦条目都到 Outbox（无论通过直接 post 还是 Pipeline drain），
    // 按 post 顺序交付。生产者先后由 Phase 2 commitment / Phase 3 Turn Slot 保证。
    const tempDir = await mkdtemp(join(tmpdir(), "outbox-int-"));
    try {
      const arrivalOrder: string[] = [];

      const { registry, sender } = makePipelineFixture({
        adapterSend: async (_t, c) => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          arrivalOrder.push(c.text);
          return { success: true, retryable: false };
        },
      });
      const { pipeline } = await makePipeline({ registry, sender, tempDir });

      // 先把 Pipeline 条目 enqueue + flush 完成，确保"Sched-1"已 post 到 Outbox 并等待
      // 其位置进入队列头（成为 inflight 或已发出）
      await pipeline.enqueue({
        target: TARGET,
        content: { text: "Sched-1" },
        source: { kind: "scheduler", taskId: "t_1", taskName: "r1" },
      });
      await pipeline.flush();
      const outbox = registry.of(TARGET);

      // 现在模拟 Phase 2 的双生产者：两个路径都调 outbox.post，按调用顺序
      const llmSrc: EmissionSource = { kind: "llm-reply", conversationId: "c" };

      const p1 = outbox.post({
        target: TARGET,
        content: { text: "LLM-A" },
        source: llmSrc,
      });
      const p2 = outbox.post({
        target: TARGET,
        content: { text: "LLM-B" },
        source: llmSrc,
      });

      await Promise.all([p1, p2]);
      await outbox.waitIdle();

      // INV-1：按 post 顺序到达 adapter（即使 adapter 延迟抖动）
      expect(arrivalOrder).toEqual(["Sched-1", "LLM-A", "LLM-B"]);

      await pipeline.stop();
      await registry.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("同 target 100 条并发 post，严格 FIFO 且 adapter 串行（INV-1 + 单消费者）", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbox-int-"));
    try {
      const order: number[] = [];
      let concurrent = 0;
      let maxConcurrent = 0;

      const { registry } = makePipelineFixture({
        adapterSend: async (_t, c) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 1));
          order.push(Number(c.text));
          concurrent--;
          return { success: true, retryable: false };
        },
      });

      const outbox = registry.of(TARGET);
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          outbox.post({
            target: TARGET,
            content: { text: String(i) },
            source: { kind: "llm-reply", conversationId: "c" },
          }),
        ),
      );
      await outbox.waitIdle();

      expect(order).toHaveLength(100);
      expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i));
      expect(maxConcurrent).toBe(1);

      await registry.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("不同 target 之间独立并发（INV-2）", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbox-int-"));
    try {
      const sendLog: string[] = [];
      const slowSend = async (target: DeliveryTarget, content: OutboundContent) => {
        if (target.to === "ou_slow") {
          await new Promise((r) => setTimeout(r, 50));
        }
        sendLog.push(`${target.to}:${content.text}`);
        return { success: true, retryable: false };
      };

      const { registry } = makePipelineFixture({ adapterSend: slowSend });

      const slowTarget: DeliveryTarget = { channelId: "feishu", to: "ou_slow" };
      const fastTarget: DeliveryTarget = { channelId: "feishu", to: "ou_fast" };

      const src: EmissionSource = { kind: "llm-reply", conversationId: "c" };

      // slow 的 post 在前，fast 的 post 在后
      const pSlow = registry.of(slowTarget).post({
        target: slowTarget,
        content: { text: "slow-msg" },
        source: src,
      });
      const pFast = registry.of(fastTarget).post({
        target: fastTarget,
        content: { text: "fast-msg" },
        source: src,
      });

      await Promise.all([pSlow, pFast]);

      // fast 完成时间早于 slow（INV-2: 不同 target 独立并发）
      expect(sendLog[0]).toBe("ou_fast:fast-msg");
      expect(sendLog[1]).toBe("ou_slow:slow-msg");

      await registry.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Pipeline 重试回到 Outbox（验证 ADR-007 决策 6：Outbox 不重试） ───

describe("Pipeline 重试与 Outbox 协同", () => {
  it("Outbox 失败回传 → Pipeline 触发重试 → 新 Outbox entry 入队", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbox-int-"));
    try {
      let attempt = 0;
      const { registry, sender } = makePipelineFixture({
        adapterSend: async () => {
          attempt++;
          if (attempt === 1) {
            return { success: false, retryable: true, error: "transient" };
          }
          return { success: true, retryable: false };
        },
      });

      // 用极小 baseRetryDelayMs 避免测试等待
      const eventBus = createEventBus<DeliveryEventMap>();
      const pipeline = new DeliveryPipeline({
        sender,
        eventBus,
        config: {
          ...DEFAULT_DELIVERY_CONFIG,
          flushIntervalMs: 0,
          baseRetryDelayMs: 10,
          queueFilePath: join(tempDir, "queue.json"),
        },
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      });
      await pipeline.start();

      await pipeline.enqueue({
        target: TARGET,
        content: { text: "retry-me" },
        source: { kind: "scheduler", taskId: "t", taskName: "r" },
      });

      // 第一次 flush：adapter 返回 retryable=true → Pipeline 调度重试
      await pipeline.flush();
      expect(attempt).toBe(1);

      // 等退避 + 重试
      await new Promise((r) => setTimeout(r, 20));
      await pipeline.flush();
      expect(attempt).toBe(2);

      await pipeline.stop();
      await registry.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
