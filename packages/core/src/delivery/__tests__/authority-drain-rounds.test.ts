import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../events/event-bus.js";
import { AuthorityDeliveryPipeline } from "../authority-pipeline.js";
import type {
  AuthorityDeliveryEventMap,
  DeliveryEndpointTransport,
  DeliveryTransport,
} from "../types.js";
import {
  createDeliveryLifecycleTestBinding,
  createDeliveryTestHarness,
  DELIVERY_TEST_TIME,
  deliveryTestInput,
} from "./delivery-test-harness.js";

vi.setConfig({ testTimeout: 60_000 });

const keyBody = (runId: string) => ({
  kind: "conversation-final-delivery" as const,
  conversationId: "conversation-drain-rounds",
  runId,
  commitRevision: 1,
});

/**
 * 受控发送端：记录每次发送；第 holdAt 次发送挂起，直到 release()。只证管线边界，不代表第三方发送。
 */
function controlledTransport(options: {
  readonly holdAt?: number;
  readonly afterSend?: (itemId: string, count: number) => Promise<void>;
} = {}) {
  const sent: string[] = [];
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const adapter = {
    endpointKind: "channel" as const,
    send: (async (_endpoint, _content, context) => {
      sent.push(context.itemId);
      if (sent.length === options.holdAt) {
        held.resolve();
        await release.promise;
      }
      await options.afterSend?.(context.itemId, sent.length);
      return { success: true, retryable: false } as const;
    }) satisfies DeliveryEndpointTransport["send"],
    isReady: () => true,
    responseLossEvidence: () => ({ kind: "unverified" as const }),
  };
  const transport: DeliveryTransport = { resolve: () => adapter };
  return { sent, transport, held: held.promise, release: () => release.resolve() };
}

async function fixtureWithQueued(count: number, prefix: string) {
  const fixture = await createDeliveryTestHarness();
  for (let index = 0; index < count; index += 1) {
    const created = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody(`${prefix}-${index}`)));
    if (!created.accepted) throw new Error("fixture enqueue failed");
  }
  return fixture;
}

function pipelineFor(fixture: Awaited<ReturnType<typeof createDeliveryTestHarness>>, transport: DeliveryTransport) {
  return new AuthorityDeliveryPipeline({
    application: fixture.lifecycle,
    projection: fixture.lifecycleProjection,
    artifacts: fixture.artifacts,
    transport,
    eventBus: createEventBus<AuthorityDeliveryEventMap>(),
    config: { flushIntervalMs: 0 },
    now: fixture.now,
  });
}

describe("delivery drain rounds", () => {
  it.each(["close admission", "stop"] as const)(
    "stops an ordinary drain at the next item boundary after %s and leaves later work pending",
    async (closing) => {
      const fixture = await fixtureWithQueued(33, `close-${closing}`);
      const control = controlledTransport({ holdAt: 1 });
      const pipeline = pipelineFor(fixture, control.transport);
      await pipeline.prepare();
      pipeline.activate();
      await control.held;

      // 首条发送在途：关闭后再入队第 34 条（在当前页之外），然后放行首条
      const settled = closing === "stop"
        ? pipeline.stop()
        : (pipeline.closeAdmission(), pipeline.waitForQuiescedEffects());
      const late = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody(`close-${closing}-late`)));
      if (!late.accepted) throw new Error("late enqueue failed");
      control.release();
      await settled;

      // 在途那一条走完结果记账；其余未领取的留在耐久 pending，不冒称完成
      expect(control.sent).toHaveLength(1);
      await expect(fixture.authority.get(control.sent[0]!)).resolves.toMatchObject({ state: "sent" });
      await expect(fixture.authority.get(late.items[0]!.itemId)).resolves.toMatchObject({ state: "queued" });
      await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 33, delivered: 1 });
      if (closing === "stop") expect(() => pipeline.closeAdmission()).toThrow(/illegal transition/u);
      else await pipeline.stop();
    },
  );

  it("bounds each round to the work present when it began while new work keeps arriving", async () => {
    // 开始时 33 条（跨两页）；前 6 次发送各入队一条新的，一半同优先级（落在本轮第二页的范围里），
    // 一半低优先级（本轮稍后才读低优先级的目录）：两种后续页都不能把它们并进本轮
    const fixture = await fixtureWithQueued(33, "arrival");
    const control = controlledTransport({
      afterSend: async (_itemId, count) => {
        if (count > 6) return;
        const created = await fixture.enqueue(deliveryTestInput(
          { createdAt: DELIVERY_TEST_TIME, priority: count % 2 === 0 ? "low" : "normal" },
          keyBody(`arrival-next-${count}`),
        ));
        if (!created.accepted) throw new Error("arrival enqueue failed");
      },
    });
    const pipeline = pipelineFor(fixture, control.transport);
    await pipeline.prepare();
    pipeline.activate();
    await pipeline.flush();
    expect(control.sent).toHaveLength(33);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 6, delivered: 33 });

    await pipeline.flush();
    expect(control.sent).toHaveLength(39);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 0, delivered: 39 });
    await pipeline.stop();
  });

  it("leaves an item that re-enters the retry directory during a round to the next round", async () => {
    const fixture = await fixtureWithQueued(1, "retry-round");
    // 重试延迟为 0：本轮内失败后立刻到期，重试目录的到期条件挡不住它，只能靠本轮上界
    const lifecycle = createDeliveryLifecycleTestBinding(fixture.authority, { baseRetryDelayMs: 0 });
    let attempts = 0;
    const adapter = {
      endpointKind: "channel" as const,
      send: (async () => {
        attempts += 1;
        return attempts === 1
          ? { success: false, retryable: true, error: "busy" }
          : { success: true, retryable: false };
      }) as DeliveryEndpointTransport["send"],
      isReady: () => true,
      responseLossEvidence: () => ({ kind: "unverified" as const }),
    };
    const pipeline = new AuthorityDeliveryPipeline({
      application: lifecycle.application,
      projection: lifecycle.projection,
      artifacts: fixture.artifacts,
      transport: { resolve: () => adapter },
      eventBus: createEventBus<AuthorityDeliveryEventMap>(),
      config: { flushIntervalMs: 0 },
      now: fixture.now,
    });
    await pipeline.prepare();
    pipeline.activate();
    await pipeline.flush();
    expect(attempts).toBe(1);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ retrying: 1, delivered: 0 });
    await pipeline.flush();
    expect(attempts).toBe(2);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 0, delivered: 1 });
    await pipeline.stop();
  });

  it("still completes an explicit drain of frozen work across pages after admission closes", async () => {
    const fixture = await fixtureWithQueued(40, "explicit");
    const control = controlledTransport({ holdAt: 1 });
    const pipeline = pipelineFor(fixture, control.transport);
    await pipeline.prepare();
    pipeline.activate();
    await control.held;

    const captured = await fixture.lifecycle.captureAcceptedWork();
    expect(captured).toHaveLength(40);
    await fixture.lifecycle.installAdmission({ operationId: "explicit-drain", sources: [], deliveries: captured });
    // 收束先关准入、等普通排空停在边界，再逐轮显式排空冻结集合直到全部终态
    const settled = fixture.lifecycle.settleAcceptedWork({
      operationId: "explicit-drain",
      strategy: "drain",
      timeoutMs: 30_000,
      effects: pipeline,
    });
    control.release();
    await settled;

    expect(new Set(control.sent).size).toBe(40);
    expect(control.sent).toHaveLength(40);
    await expect(fixture.lifecycle.acceptedWorkItems("explicit-drain")).resolves.toEqual([]);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 0, delivered: 40 });
    await pipeline.stop();
  });

  it("stops an explicit drain at the next boundary on stop and stays stopped", async () => {
    const fixture = await fixtureWithQueued(5, "explicit-stop");
    const control = controlledTransport({ holdAt: 2 });
    const pipeline = pipelineFor(fixture, control.transport);
    await pipeline.prepare();
    pipeline.closeAdmission();

    const explicit = pipeline.flushQuiescedOnce();
    await control.held;
    const stopped = pipeline.stop();
    control.release();
    await Promise.all([explicit, stopped]);

    expect(control.sent).toHaveLength(2);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 3, delivered: 2 });
    // 停止后不被恢复成暂停状态
    expect(() => pipeline.closeAdmission()).toThrow(/illegal transition/u);
    await expect(pipeline.flushQuiescedOnce()).rejects.toThrow(/illegal transition/u);
  });
});
