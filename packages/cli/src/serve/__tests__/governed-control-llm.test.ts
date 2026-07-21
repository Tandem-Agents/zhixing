import { describe, expect, it } from "vitest";
import type {
  AuthorityCallContext,
  ImmediateRootResourceLease,
  ImmediateRootWorkload,
  ReservationOrigin,
  ResourceLease,
} from "@zhixing/core/contracts";
import {
  governControlProvider,
  governControlTextCall,
  type ControlLlmGovernor,
} from "../governed-control-llm.js";
import type { LLMProvider, StreamEvent } from "@zhixing/core";

interface GovernorEvent {
  readonly op: string;
  readonly detail?: unknown;
}

function createGovernorProbe(input?: {
  readonly failAcquire?: boolean;
}): { governor: ControlLlmGovernor; events: GovernorEvent[] } {
  const events: GovernorEvent[] = [];
  const governor: ControlLlmGovernor = {
    async acquireRoot(
      workload: ImmediateRootWorkload,
      budget: ResourceLease["budget"],
      origin: ReservationOrigin,
      ctx: AuthorityCallContext,
    ) {
      events.push({ op: "acquireRoot", detail: { workload, budget, origin, principal: ctx.principal } });
      if (input?.failAcquire) throw new Error("admission rejected");
      return {
        reservationId: `rsv-${workload.id}`,
        admissionClass: origin.admissionClass,
        workload,
        budget,
      } as unknown as ImmediateRootResourceLease;
    },
    async reserveUsage(_lease, usage) {
      events.push({ op: "reserveUsage", detail: usage });
    },
    async consume(_lease, usage) {
      events.push({ op: "consume", detail: usage });
    },
    async settle() {
      events.push({ op: "settle" });
    },
    async release() {
      events.push({ op: "release" });
    },
  };
  return { governor, events };
}

const origin = {
  admissionClass: "interactive",
  entry: "conversation-input",
} as const;

describe("governControlTextCall", () => {
  it("admits, meters and settles one governed control call in order", async () => {
    const probe = createGovernorProbe();
    const governed = governControlTextCall(
      { governor: probe.governor, origin, workPrefix: "llm-complete" },
      async (prompt, _role, opts) => {
        const metering = opts?.modelCallMetering;
        expect(metering).toBeDefined();
        const reservation = await metering!.meter.reserve({
          callIndex: metering!.nextCallIndex(),
          tokenUpperBound: 1_000,
        });
        await metering!.meter.consume({ usageId: reservation.usageId, tokens: 42 });
        return `governed:${prompt}`;
      },
    );
    await expect(governed("hello", "light")).resolves.toBe("governed:hello");
    expect(probe.events.map((event) => event.op)).toEqual([
      "acquireRoot",
      "reserveUsage",
      "consume",
      "settle",
      "release",
    ]);
    const reserve = probe.events[1]!.detail as { usageId: string; tokens: number; calls: number };
    const consume = probe.events[2]!.detail as { usageId: string; tokens: number; calls: number };
    expect(reserve.usageId).toBe(consume.usageId);
    expect(reserve.tokens).toBe(1_000);
    expect(consume.tokens).toBe(42);
  });

  it("conservatively consumes unresolved reservations when the call fails", async () => {
    const probe = createGovernorProbe();
    const governed = governControlTextCall(
      { governor: probe.governor, origin, workPrefix: "turn-maintenance" },
      async (_prompt, _role, opts) => {
        const metering = opts!.modelCallMetering!;
        await metering.meter.reserve({
          callIndex: metering.nextCallIndex(),
          tokenUpperBound: 777,
        });
        throw new Error("provider interrupted");
      },
    );
    await expect(governed("condense")).rejects.toThrow("provider interrupted");
    const ops = probe.events.map((event) => event.op);
    expect(ops).toEqual(["acquireRoot", "reserveUsage", "consume", "settle", "release"]);
    const conservative = probe.events[2]!.detail as { tokens: number };
    expect(conservative.tokens).toBe(777);
  });

  it("governs every provider chat call as one control work with streaming metering", async () => {
    const probe = createGovernorProbe();
    const rawProvider: LLMProvider = {
      id: "test-provider",
      models: [],
      async *chat(): AsyncGenerator<StreamEvent, void, undefined> {
        yield { type: "text", text: "partial" } as unknown as StreamEvent;
        yield {
          type: "message_end",
          usage: { inputTokens: 10, outputTokens: 5 },
        } as unknown as StreamEvent;
      },
    };
    const governed = governControlProvider(
      {
        governor: probe.governor,
        origin: { admissionClass: "advancement", entry: "advancement-control" },
        workPrefix: "advancement",
        defaultMaxOutputTokens: 1_000,
      },
      rawProvider,
    );
    const events: string[] = [];
    for await (const event of governed.chat({
      model: "m",
      messages: [],
      maxTokens: 100,
    } as never)) {
      events.push((event as { type: string }).type);
    }
    expect(events).toEqual(["text", "message_end"]);
    expect(probe.events.map((event) => event.op)).toEqual([
      "acquireRoot",
      "reserveUsage",
      "consume",
      "settle",
      "release",
    ]);
    const consume = probe.events[2]!.detail as { tokens: number };
    expect(consume.tokens).toBe(15);
  });

  it("finalizes the provider control work when the stream is abandoned early", async () => {
    const probe = createGovernorProbe();
    const rawProvider: LLMProvider = {
      id: "test-provider",
      models: [],
      async *chat(): AsyncGenerator<StreamEvent, void, undefined> {
        yield { type: "text", text: "first" } as unknown as StreamEvent;
        yield { type: "text", text: "second" } as unknown as StreamEvent;
      },
    };
    const governed = governControlProvider(
      {
        governor: probe.governor,
        origin: { admissionClass: "advancement", entry: "advancement-control" },
        workPrefix: "advancement",
        defaultMaxOutputTokens: 500,
      },
      rawProvider,
    );
    const stream = governed.chat({ model: "m", messages: [] } as never);
    await stream.next();
    await stream.return?.(undefined as never);
    const ops = probe.events.map((event) => event.op);
    expect(ops).toEqual(["acquireRoot", "reserveUsage", "consume", "settle", "release"]);
    const conservative = probe.events[2]!.detail as { tokens: number };
    expect(conservative.tokens).toBeGreaterThan(0);
  });

  it("performs no metering side-effects when admission itself is rejected", async () => {
    const probe = createGovernorProbe({ failAcquire: true });
    const governed = governControlTextCall(
      { governor: probe.governor, origin, workPrefix: "llm-complete" },
      async () => "unreachable",
    );
    await expect(governed("hello")).rejects.toThrow("admission rejected");
    expect(probe.events.map((event) => event.op)).toEqual(["acquireRoot"]);
  });
});
