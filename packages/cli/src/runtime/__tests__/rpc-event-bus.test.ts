/**
 * RpcEventBus —— wire 信封 → per-run 投影 bus 的还原行为。
 *
 * 锁住的语义:
 *   - run_start 建立投影并调用装饰钩子(conversationId / turnContext 还原)
 *   - 事件重放透传信封 lineage(渲染层区分子 agent 帧的依据)
 *   - run_end 派发后拆除(装饰 dispose 被调);孤立 run_end 丢弃
 *   - 中途加入(错过 run_start)从当前帧隐式建立投影
 *   - 同会话新 runId 拆旧建新(run_end 丢失的兜底回收)
 *   - seq 单调守卫、filter 过滤、多对话隔离、dispose 全清
 */

import { describe, it, expect, vi } from "vitest";
import type { EventMeta } from "@zhixing/core";
import type { RunBusContext } from "@zhixing/orchestrator";
import type { SessionEventEnvelope } from "@zhixing/server";
import { RpcEventBus } from "../rpc-event-bus.js";
import { makeFakeHostLink } from "./fake-host-link.js";

function envelope(
  overrides: Partial<SessionEventEnvelope> & { seq: number; event: string },
): SessionEventEnvelope {
  return {
    conversationId: "conv-1",
    runId: "run-1",
    payload: {},
    meta: {},
    ...overrides,
  };
}

/** 装饰 spy:记录每次建立的 ctx,并在投影 bus 上挂一个收集 listener */
function makeDecorateSpy() {
  const contexts: RunBusContext[] = [];
  const received: Array<{ event: string; payload: unknown; meta?: EventMeta }> = [];
  const disposes: Array<ReturnType<typeof vi.fn>> = [];
  const decorate = (ctx: RunBusContext) => {
    contexts.push(ctx);
    ctx.bus.onAny((event, payload, meta) => {
      received.push({ event, payload, meta });
    });
    const dispose = vi.fn();
    disposes.push(dispose);
    return dispose;
  };
  return { decorate, contexts, received, disposes };
}

function makeBus(opts?: { filter?: (e: SessionEventEnvelope) => boolean }) {
  const fake = makeFakeHostLink();
  const spy = makeDecorateSpy();
  const errors: Array<{ error: unknown; event: string }> = [];
  const bus = new RpcEventBus({
    link: fake.link,
    decorate: spy.decorate,
    filter: opts?.filter,
    onListenerError: (error, event) => errors.push({ error, event }),
  });
  const feed = (e: SessionEventEnvelope) => fake.notify("session.event", e);
  return { bus, fake, spy, errors, feed };
}

describe("RpcEventBus · per-run 投影生命周期", () => {
  it("run_start 建立投影:装饰钩子收到还原的 conversationId / turnContext,run_start 帧送达订阅者", () => {
    const { spy, feed } = makeBus();

    feed(
      envelope({
        seq: 0,
        event: "agent:run_start",
        payload: { prompt: "你好" },
        meta: { turnOrigin: { channel: "rpc", triggeredBy: "7" } },
      }),
    );

    expect(spy.contexts).toHaveLength(1);
    expect(spy.contexts[0]?.conversationId).toBe("conv-1");
    expect(spy.contexts[0]?.turnContext?.turnId).toBe("run-1");
    expect(spy.contexts[0]?.turnContext?.turnOrigin).toEqual({
      channel: "rpc",
      triggeredBy: "7",
    });
    expect(spy.received).toEqual([
      {
        event: "agent:run_start",
        payload: { prompt: "你好" },
        meta: { lineage: undefined },
      },
    ]);
  });

  it("事件重放透传信封 lineage——子 agent 帧的渲染区分依据", () => {
    const { spy, feed } = makeBus();

    feed(envelope({ seq: 0, event: "agent:run_start" }));
    feed(
      envelope({
        seq: 1,
        event: "retry:attempt",
        payload: { attempt: 2 },
        meta: { lineage: "main/sub-a3f" },
      }),
    );

    expect(spy.received[1]).toEqual({
      event: "retry:attempt",
      payload: { attempt: 2 },
      meta: { lineage: "main/sub-a3f" },
    });
  });

  it("run_end 派发后拆除投影;下一 run 重新建立", () => {
    const { spy, feed } = makeBus();

    feed(envelope({ seq: 0, event: "agent:run_start" }));
    feed(envelope({ seq: 1, event: "agent:run_end", payload: { reason: "completed" } }));

    expect(spy.disposes[0]).toHaveBeenCalledTimes(1);
    // run_end 自身先送达订阅者,再拆除
    expect(spy.received.map((r) => r.event)).toEqual([
      "agent:run_start",
      "agent:run_end",
    ]);

    feed(envelope({ seq: 0, event: "agent:run_start", runId: "run-2" }));
    expect(spy.contexts).toHaveLength(2);
    expect(spy.contexts[1]?.turnContext?.turnId).toBe("run-2");
  });

  it("中途加入:错过 run_start 的首帧隐式建立投影并送达", () => {
    const { spy, feed } = makeBus();

    feed(
      envelope({
        seq: 5,
        event: "context:tokens_snapshot",
        payload: { tokens: 1200 },
      }),
    );

    expect(spy.contexts).toHaveLength(1);
    expect(spy.received).toEqual([
      {
        event: "context:tokens_snapshot",
        payload: { tokens: 1200 },
        meta: { lineage: undefined },
      },
    ]);
  });

  it("孤立 run_end(无投影在场)丢弃——不建立、不派发", () => {
    const { spy, feed } = makeBus();

    feed(envelope({ seq: 9, event: "agent:run_end" }));

    expect(spy.contexts).toHaveLength(0);
    expect(spy.received).toEqual([]);
  });

  it("同会话新 runId 帧到达:拆旧建新(run_end 丢失的兜底回收)", () => {
    const { spy, feed } = makeBus();

    feed(envelope({ seq: 0, event: "agent:run_start", runId: "run-1" }));
    feed(envelope({ seq: 0, event: "agent:run_start", runId: "run-2" }));

    expect(spy.disposes[0]).toHaveBeenCalledTimes(1);
    expect(spy.contexts).toHaveLength(2);
  });

  it("seq 单调守卫:重复 / 回退帧丢弃", () => {
    const { spy, feed } = makeBus();

    feed(envelope({ seq: 0, event: "agent:run_start" }));
    feed(envelope({ seq: 1, event: "retry:attempt", payload: { attempt: 1 } }));
    feed(envelope({ seq: 1, event: "retry:attempt", payload: { attempt: 1 } }));
    feed(envelope({ seq: 0, event: "agent:run_start" }));

    expect(spy.received).toHaveLength(2);
  });

  it("filter 拒绝的信封不进投影——'当前对话'过滤归调用方", () => {
    const { spy, feed } = makeBus({
      filter: (e) => e.conversationId === "conv-1",
    });

    feed(envelope({ seq: 0, event: "agent:run_start", conversationId: "conv-2" }));
    expect(spy.contexts).toHaveLength(0);

    feed(envelope({ seq: 0, event: "agent:run_start" }));
    expect(spy.contexts).toHaveLength(1);
  });

  it("多对话隔离:各自建投影、互不影响", () => {
    const { spy, feed } = makeBus();

    feed(envelope({ seq: 0, event: "agent:run_start", conversationId: "conv-a", runId: "ra" }));
    feed(envelope({ seq: 0, event: "agent:run_start", conversationId: "conv-b", runId: "rb" }));
    feed(envelope({ seq: 1, event: "agent:run_end", conversationId: "conv-a", runId: "ra" }));

    expect(spy.contexts.map((c) => c.conversationId)).toEqual(["conv-a", "conv-b"]);
    expect(spy.disposes[0]).toHaveBeenCalledTimes(1);
    expect(spy.disposes[1]).not.toHaveBeenCalled();
  });

  it("dispose:退订连接通知 + 拆除全部活跃投影", () => {
    const { bus, fake, spy, feed } = makeBus();

    feed(envelope({ seq: 0, event: "agent:run_start" }));
    expect(fake.handlerCount("session.event")).toBe(1);

    bus.dispose();
    expect(fake.handlerCount("session.event")).toBe(0);
    expect(spy.disposes[0]).toHaveBeenCalledTimes(1);

    // dispose 后到达的信封不再处理(防御:退订后理论上不会有)
    feed(envelope({ seq: 1, event: "retry:attempt" }));
    expect(spy.received.map((r) => r.event)).toEqual(["agent:run_start"]);
  });

  it("run_end 帧对同帧的 on 与 onAny 订阅者全部可达——分发完成先于投影拆除(回归锚)", () => {
    const fake = makeFakeHostLink();
    const onHits: string[] = [];
    const anyHits: string[] = [];
    new RpcEventBus({
      link: fake.link,
      decorate: (ctx) => {
        // on + onAny 双订阅:原 async 逐个 await 的分发会在 on listener 后
        // yield,teardown 清表导致 onAny 丢 run_end——此形态必须锁住
        ctx.bus.on("agent:run_end", () => {
          onHits.push("run_end");
        });
        ctx.bus.onAny((event) => {
          anyHits.push(event);
        });
        return () => {};
      },
      onListenerError: () => {},
    });

    fake.notify("session.event", envelope({ seq: 0, event: "agent:run_start" }));
    fake.notify("session.event", envelope({ seq: 1, event: "agent:run_end" }));

    expect(onHits).toEqual(["run_end"]);
    expect(anyHits).toEqual(["agent:run_start", "agent:run_end"]);
  });

  it("订阅者抛错被隔离并上报,不打断后续分发", () => {
    const fake = makeFakeHostLink();
    const errors: Array<{ error: unknown; event: string }> = [];
    const received: string[] = [];
    const bus = new RpcEventBus({
      link: fake.link,
      decorate: (ctx) => {
        ctx.bus.on("retry:attempt", () => {
          throw new Error("订阅者崩了");
        });
        ctx.bus.onAny((event) => {
          received.push(event);
        });
        return () => {};
      },
      onListenerError: (error, event) => errors.push({ error, event }),
    });

    fake.notify("session.event", envelope({ seq: 0, event: "agent:run_start" }));
    fake.notify(
      "session.event",
      envelope({ seq: 1, event: "retry:attempt", payload: { attempt: 1 } }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toBe("retry:attempt");
    expect(received).toContain("retry:attempt");
    bus.dispose();
  });
});
