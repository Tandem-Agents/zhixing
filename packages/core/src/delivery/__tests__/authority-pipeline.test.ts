import { createEventBus } from "../../events/event-bus.js";
import type { DeliveryResult } from "../../channels/types.js";
import { byteDigest, protocolDigest } from "../../protocol/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  AuthorityDeliveryPipeline,
  type AuthorityDeliveryPipelineDeps,
} from "../authority-pipeline.js";
import { DeliveryTransportRegistry } from "../transport-registry.js";
import type {
  AuthorityDeliveryEventMap,
  DeliveryEndpointTransport,
  DeliveryTransport,
} from "../types.js";
import {
  createDeliveryLifecycleTestBinding,
  createDeliveryTestHarness,
  deliveryTestInput,
} from "./delivery-test-harness.js";

vi.setConfig({ testTimeout: 15_000 });

async function createPipeline(
  transport: DeliveryTransport,
  options: {
    readonly baseRetryDelayMs?: number;
    readonly flushIntervalMs?: number;
    readonly now?: () => Date;
    readonly materializeContent?: NonNullable<AuthorityDeliveryPipelineDeps["materializeContent"]>;
    readonly logger?: AuthorityDeliveryPipelineDeps["logger"];
  } = {},
) {
  const fixture = await createDeliveryTestHarness();
  const lifecycle = createDeliveryLifecycleTestBinding(fixture.authority, {
    baseRetryDelayMs: options.baseRetryDelayMs ?? 1_000,
  });
  const eventBus = createEventBus<AuthorityDeliveryEventMap>();
  const pipeline = new AuthorityDeliveryPipeline({
    application: lifecycle.application,
    projection: lifecycle.projection,
    artifacts: fixture.artifacts,
    transport,
    eventBus,
    config: {
      flushIntervalMs: options.flushIntervalMs ?? 0,
    },
    now: options.now ?? fixture.now,
    ...(options.materializeContent
      ? { materializeContent: options.materializeContent }
      : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  await pipeline.start();
  return { ...fixture, pipeline, eventBus };
}

function transport(
  send: DeliveryEndpointTransport["send"],
  policy: ReturnType<DeliveryEndpointTransport["outcomePolicy"]> = {
    kind: "manual-resolution",
  },
): DeliveryTransport {
  const adapter = {
    endpointKind: "channel" as const,
    send,
    isReady: () => true,
    outcomePolicy: () => policy,
  };
  return {
    resolve: () => adapter,
  };
}

describe("AuthorityDeliveryPipeline", () => {
  it.each(["drain", "cancel"] as const)(
    "drives already-enqueued delivery to its existing terminal for lifecycle %s",
    async (strategy) => {
      const send = vi.fn(async () => ({ success: true, retryable: false } as const));
      const fixture = await createPipeline(transport(send));
      const created = await fixture.enqueue();
      if (!created.accepted) throw new Error("fixture enqueue failed");
      fixture.pipeline.closeAdmissionForLifecycle();

      await fixture.authority.installLifecycleAdmission({
        operationId: "lifecycle-1",
        sources: [],
        deliveries: fixture.pipeline.acceptedWorkItems(),
      });
      await fixture.pipeline.settleAcceptedWorkForLifecycle("lifecycle-1", strategy, 1_000);

      expect(send).toHaveBeenCalledOnce();
      expect(fixture.pipeline.acceptedWorkItems()).toEqual([]);
      await fixture.pipeline.stop();
    },
  );

  it("keeps immediate delivery durable without fabricating a terminal", async () => {
    const send = vi.fn(async () => ({ success: true, retryable: false } as const));
    const fixture = await createPipeline(transport(send));
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    fixture.pipeline.closeAdmissionForLifecycle();

    await fixture.authority.installLifecycleAdmission({
      operationId: "lifecycle-immediate",
      sources: [],
      deliveries: fixture.pipeline.acceptedWorkItems(),
    });
    await fixture.pipeline.settleAcceptedWorkForLifecycle(
      "lifecycle-immediate",
      "immediate",
      1_000,
    );

    expect(send).not.toHaveBeenCalled();
    expect(fixture.pipeline.acceptedWorkItems()).toEqual([
      expect.objectContaining({ id: created.items[0]!.itemId }),
    ]);
    await fixture.pipeline.stop();
  });
  it("prepares durable work without invoking transport before activation", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const send = vi.fn(async () => ({ success: true, retryable: false } as const));
    const lifecycle = createDeliveryLifecycleTestBinding(fixture.authority, {
      baseRetryDelayMs: 1_000,
    });
    const pipeline = new AuthorityDeliveryPipeline({
      application: lifecycle.application,
      projection: lifecycle.projection,
      artifacts: fixture.artifacts,
      transport: transport(send),
      eventBus: createEventBus<AuthorityDeliveryEventMap>(),
      config: { flushIntervalMs: 0 },
      now: fixture.now,
    });

    await pipeline.prepare();
    expect(send).not.toHaveBeenCalled();

    pipeline.activate();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await pipeline.stop();
  });

  it("has no public production entry", async () => {
    const fixture = await createPipeline(transport(async () => ({ success: true, retryable: false })));
    expect("enqueue" in fixture.pipeline).toBe(false);
    await fixture.pipeline.stop();
  });

  it("durably starts the attempt before invoking the transport", async () => {
    let fixture: Awaited<ReturnType<typeof createPipeline>>;
    const send = vi.fn(async (_endpoint, _content, meta) => {
      expect(await fixture.authority.get(meta.itemId)).toMatchObject({
        state: "attempting",
        currentAttempt: 1,
      });
      return { success: true, retryable: false } as const;
    });
    fixture = await createPipeline(transport(send));
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
      statusRevision: 3,
    });
    await fixture.pipeline.stop();
  });

  it("quiesces new external sends, waits the active flush, and resumes only on abort", async () => {
    let release!: () => void;
    let markSending!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sending = new Promise<void>((resolve) => { markSending = resolve; });
    const send = vi.fn<DeliveryEndpointTransport["send"]>(async () => {
      if (send.mock.calls.length === 1) {
        markSending();
        await gate;
      }
      return { success: true, retryable: false };
    });
    const fixture = await createPipeline(transport(send));
    const first = await fixture.enqueue();
    if (!first.accepted) throw new Error("fixture enqueue failed");

    const flush = fixture.pipeline.flush();
    await sending;
    expect(fixture.pipeline.acceptedWorkItems()).toEqual([
      expect.objectContaining({ id: first.items[0]!.itemId }),
    ]);
    const quiesced = fixture.pipeline.quiesceForAuthorityTransfer();
    await expect(fixture.pipeline.flush()).rejects.toThrow(/state="quiesced"/);
    release();
    await Promise.all([flush, quiesced]);

    const second = await fixture.enqueue(deliveryTestInput({}, {
      kind: "conversation-final-delivery",
      conversationId: "conversation-2",
      runId: "run-2",
      commitRevision: 1,
    }));
    if (!second.accepted) throw new Error("fixture second enqueue failed");
    expect(fixture.pipeline.acceptedWorkItems()).toEqual([
      expect.objectContaining({ id: second.items[0]!.itemId }),
    ]);
    await expect(fixture.pipeline.flush()).rejects.toThrow(/state="quiesced"/);
    expect(send).toHaveBeenCalledTimes(1);

    await fixture.pipeline.resumeAfterAuthorityTransfer();
    expect(send).toHaveBeenCalledTimes(2);
    await fixture.pipeline.stop();
  });

  it("schedules a new attempt only after an explicit retryable failure", async () => {
    const send = vi
      .fn<DeliveryEndpointTransport["send"]>()
      .mockResolvedValueOnce({ success: false, error: "busy", retryable: true })
      .mockResolvedValueOnce({ success: true, retryable: false });
    const fixture = await createPipeline(transport(send));
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "retry-wait",
      currentAttempt: 1,
    });

    fixture.setNow("2026-07-17T02:00:01.000Z");
    await fixture.pipeline.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
      currentAttempt: 2,
    });
    await fixture.pipeline.stop();
  });

  it("derives retryAt from the authority commit time rather than the drain clock", async () => {
    let blockNextTransaction = false;
    const fixture = await createPipeline(
      transport(async () => {
        blockNextTransaction = true;
        return { success: false, retryable: true };
      }),
      { baseRetryDelayMs: 0 },
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");
    let release!: () => void;
    let markBlocked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
    const log = fixture.log as unknown as {
      transactProjection: (...args: unknown[]) => Promise<unknown>;
    };
    const transactProjection = fixture.log.transactProjection.bind(
      fixture.log,
    ) as (...args: unknown[]) => Promise<unknown>;
    log.transactProjection = async (...args) => {
      if (blockNextTransaction) {
        blockNextTransaction = false;
        markBlocked();
        await gate;
      }
      return transactProjection(...args);
    };

    const flush = fixture.pipeline.flush();
    await blocked;
    fixture.setNow("2026-07-17T02:00:10.000Z");
    release();
    await flush;

    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "retry-wait",
      nextAttemptAt: "2026-07-17T02:00:10.000Z",
      statusRevision: 3,
    });
    await fixture.pipeline.stop();
  });

  it("keeps extreme retry delays inside the canonical timestamp domain", async () => {
    const fixture = await createPipeline(
      transport(async () => ({ success: false, retryable: true })),
      { baseRetryDelayMs: Number.MAX_SAFE_INTEGER },
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "retry-wait",
      currentAttempt: 1,
      nextAttemptAt: "+275760-09-13T00:00:00.000Z",
    });
    await fixture.pipeline.stop();
  });

  it("turns an unknown manual transport outcome into uncertain without blind resend", async () => {
    const send = vi.fn(async () => {
      throw new Error("connection reset after write");
    });
    const fixture = await createPipeline(transport(send));
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "attempting",
      currentAttempt: 1,
    });
    await fixture.pipeline.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "uncertain",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it.each([
    {
      result: { success: true, retryable: false } satisfies DeliveryResult,
      closedBy: "late-sent",
    },
    {
      result: { success: false, retryable: true } satisfies DeliveryResult,
      closedBy: "late-retry-scheduled",
    },
    {
      result: { success: false, retryable: false } satisfies DeliveryResult,
      closedBy: "late-failed",
    },
  ] as const)(
    "publishes the authority's exact uncertain closure notice: $closedBy",
    async ({ result, closedBy }) => {
      let release!: (result: DeliveryResult) => void;
      let markSending!: () => void;
      const response = new Promise<DeliveryResult>((resolve) => { release = resolve; });
      const sending = new Promise<void>((resolve) => { markSending = resolve; });
      const fixture = await createPipeline(transport(async () => {
        markSending();
        return response;
      }));
      const notices: Array<AuthorityDeliveryEventMap["delivery:notice"]["notice"]> = [];
      fixture.eventBus.on("delivery:notice", ({ notice }) => { notices.push(notice); });
      const created = await fixture.enqueue();
      if (!created.accepted) throw new Error("fixture enqueue failed");

      const flush = fixture.pipeline.flush();
      await sending;
      const uncertain = await fixture.lifecycle.claim({ itemId: created.items[0]!.itemId });
      if (uncertain.kind !== "uncertain") throw new Error("fixture did not open uncertainty");
      release(result);
      await flush;

      expect(notices).toEqual([
        expect.objectContaining({
          state: "delivery-uncertain-closed",
          closedBy,
          statusRevision: 4,
          openFactDigest: uncertain.item.openFact!.openFactDigest,
        }),
      ]);
      await fixture.pipeline.stop();
    },
  );

  it("redrives an unknown idempotent outcome with the same attempt and key", async () => {
    const calls: Array<{ attempt: number; key: string }> = [];
    const send = vi.fn<DeliveryEndpointTransport["send"]>(async (_endpoint, _content, meta) => {
      calls.push({ attempt: meta.attempt, key: meta.idempotencyKey });
      if (calls.length === 1) throw new Error("response lost");
      return { success: true, retryable: false };
    });
    const fixture = await createPipeline(
      transport(send, { kind: "idempotent-redrive", windowMs: 60_000 }),
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    await fixture.pipeline.flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it("recovers an open attempt without rereading the current outcome policy", async () => {
    let policyCalls = 0;
    let sendCalls = 0;
    const adapter: DeliveryEndpointTransport = {
      endpointKind: "channel",
      isReady: () => true,
      outcomePolicy: () => {
        policyCalls += 1;
        if (policyCalls > 1) throw new Error("current policy is unavailable");
        return { kind: "idempotent-redrive", windowMs: 60_000 };
      },
      send: async () => {
        sendCalls += 1;
        if (sendCalls === 1) throw new Error("response lost");
        return { success: true, retryable: false };
      },
    };
    const fixture = await createPipeline({ resolve: () => adapter });
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    await fixture.pipeline.flush();

    expect(policyCalls).toBe(1);
    expect(sendCalls).toBe(2);
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it("keeps extreme redrive windows inside the canonical timestamp domain", async () => {
    const send = vi.fn(async () => {
      throw new Error("response lost");
    });
    const fixture = await createPipeline(
      transport(send, {
        kind: "idempotent-redrive",
        windowMs: Number.MAX_SAFE_INTEGER,
      }),
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    await fixture.pipeline.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "attempting",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it("does not overwrite an unknown prior outcome when redrive content is unavailable", async () => {
    const send = vi.fn(async () => {
      throw new Error("response lost");
    });
    let materializations = 0;
    const fixture = await createPipeline(
      transport(send, { kind: "idempotent-redrive", windowMs: 1_000 }),
      {
        materializeContent: async () => {
          materializations += 1;
          if (materializations > 1) throw new SyntaxError("content became unreadable");
          return { text: "done" };
        },
      },
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    fixture.setNow("2026-07-17T02:00:00.500Z");
    await fixture.pipeline.flush();
    expect(send).toHaveBeenCalledOnce();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "attempting",
      currentAttempt: 1,
    });

    fixture.setNow("2026-07-17T02:00:01.001Z");
    await fixture.pipeline.flush();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "uncertain",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it("fails locally when referenced content cannot be materialized", async () => {
    const send = vi.fn<DeliveryEndpointTransport["send"]>();
    const fixture = await createPipeline(transport(send), {
      materializeContent: async () => {
        throw new SyntaxError("artifact content is malformed");
      },
    });
    const created = await fixture.enqueue(deliveryTestInput());
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(send).not.toHaveBeenCalled();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "failed",
      currentAttempt: 1,
      statusRevision: 3,
      lastError: {
        code: "content-invalid",
        message: "Delivery content could not be materialized",
        retryable: false,
      },
    });
    const failureEnvelope = (await fixture.log.readAll()).at(-1)!;
    expect(
      failureEnvelope.entries
        .filter((entry) => entry.stream === "delivery")
        .map((entry) => (entry.body as { t: string }).t),
    ).toEqual(["attempt-started", "failed"]);
    await fixture.pipeline.stop();
  });

  it("keeps a fresh item queued when local content IO fails transiently", async () => {
    const send = vi.fn(async () => ({ success: true, retryable: false } as const));
    let available = false;
    const fixture = await createPipeline(transport(send), {
      materializeContent: async () => {
        if (!available) throw new Error("token=secret transient storage failure");
        return { text: "done" };
      },
    });
    const created = await fixture.enqueue(deliveryTestInput());
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    expect(send).not.toHaveBeenCalled();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "queued",
      attempts: 0,
      statusRevision: 1,
    });

    available = true;
    await fixture.pipeline.flush();
    expect(send).toHaveBeenCalledOnce();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it("advances an offline open attempt to uncertainty without another send", async () => {
    let ready = true;
    const send = vi.fn(async () => {
      throw new Error("token=secret response lost");
    });
    const adapter = {
      endpointKind: "channel" as const,
      send,
      isReady: () => ready,
      outcomePolicy: () => ({ kind: "manual-resolution" }),
    };
    const fixture = await createPipeline({
      resolve: (endpoint) => adapter.isReady(endpoint) ? adapter : undefined,
    });
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    ready = false;
    await fixture.pipeline.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "uncertain",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it("digests the adapter's immutable receipt bytes", async () => {
    const receiptBytes = new TextEncoder().encode("platform-receipt-1");
    const fixture = await createPipeline(
      transport(async () => ({
        success: true,
        retryable: false,
        messageId: "message-1",
        receiptBytes,
      })),
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
      receiptDigest: byteDigest(receiptBytes),
    });
    await fixture.pipeline.stop();
  });

  it("persists only safe transport failures", async () => {
    const fixture = await createPipeline(
      transport(async () => ({
        success: false,
        error: "Authorization: Bearer secret-token https://private.invalid/body",
        retryable: false,
      })),
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    const item = await fixture.authority.get(created.items[0]!.itemId);
    expect(item?.lastError).toEqual({
      code: "transport-rejected",
      message: "Delivery transport rejected the request",
      retryable: false,
    });
    expect(JSON.stringify(item)).not.toContain("secret-token");
    await fixture.pipeline.stop();
  });

  it("leaves an endpoint queued until its transport capability is registered", async () => {
    const registry = new DeliveryTransportRegistry();
    const fixture = await createPipeline(registry);
    const created = await fixture.enqueue(deliveryTestInput(
      {
        endpoint: {
          kind: "webhook",
          endpoint: { kind: "webhook", bindingId: "hook-1" },
        },
        source: { kind: "scheduler", taskId: "task-1", taskName: "Task" },
      },
      {
        kind: "job-result-delivery",
        taskId: "task-1",
        jobRunId: "job-1",
        planDigest: protocolDigest("DeliveryPlan", 1, { taskId: "task-1" }),
      },
    ));
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "queued",
      attempts: 0,
    });

    const send = vi.fn(async () => ({ success: true, retryable: false } as const));
    registry.register({
      endpointKind: "webhook",
      isReady: () => true,
      outcomePolicy: () => ({ kind: "idempotent-redrive", windowMs: 60_000 }),
      send,
    });
    await fixture.pipeline.flush();
    expect(send).toHaveBeenCalledOnce();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it("uses one captured adapter when registry membership changes during attempt setup", async () => {
    const registry = new DeliveryTransportRegistry();
    const send = vi.fn(async () => ({ success: true, retryable: false } as const));
    let unregister = () => {};
    unregister = registry.register({
      endpointKind: "channel",
      isReady: () => true,
      outcomePolicy: () => {
        unregister();
        return { kind: "manual-resolution" };
      },
      send,
    });
    const fixture = await createPipeline(registry);
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
      currentAttempt: 1,
    });
    await fixture.pipeline.stop();
  });

  it("keeps adapter preflight failures before the attempt boundary and out of logs", async () => {
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const fixture = await createPipeline(
      {
        resolve: () => {
          throw new Error("Authorization: Bearer secret-token");
        },
      },
      {
        logger: {
          info: () => {},
          warn: (message, data) => warnings.push({ message, ...(data ? { data } : {}) }),
          error: () => {},
          debug: () => {},
        },
      },
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "queued",
      attempts: 0,
      statusRevision: 1,
    });
    expect(JSON.stringify(warnings)).not.toContain("secret-token");
    await fixture.pipeline.stop();
  });

  it("fails closed when transport readiness is not a boolean", async () => {
    const registry = new DeliveryTransportRegistry();
    registry.register({
      endpointKind: "channel",
      isReady: (() => "yes") as unknown as DeliveryEndpointTransport["isReady"],
      outcomePolicy: () => ({ kind: "manual-resolution" }),
      send: async () => ({ success: true, retryable: false }),
    });
    const fixture = await createPipeline(registry);
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "queued",
      attempts: 0,
    });
    await fixture.pipeline.stop();
  });

  it("fails closed before starting an attempt when the outcome policy is malformed", async () => {
    const adapter = {
      endpointKind: "channel" as const,
      isReady: () => true,
      outcomePolicy: () => ({ kind: "unknown" }),
      send: vi.fn(async () => ({ success: true, retryable: false } as const)),
    };
    const fixture = await createPipeline({
      resolve: () => adapter as unknown as DeliveryEndpointTransport,
    });
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(adapter.send).not.toHaveBeenCalled();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "queued",
      attempts: 0,
    });
    await fixture.pipeline.stop();
  });

  it.each([
    { success: "yes", retryable: false },
    { success: true, retryable: false, messageId: 7 },
    { success: true, retryable: false, messageId: "m".repeat(481) },
    { success: true, retryable: false, receiptBytes: "not-bytes" },
    { success: false, retryable: false, error: "rejected", extra: true },
  ])("never appends a malformed transport result: %o", async (malformed) => {
    const fixture = await createPipeline(
      transport(async () => malformed as unknown as Awaited<ReturnType<DeliveryEndpointTransport["send"]>>),
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "attempting",
      statusRevision: 2,
    });
    await fixture.pipeline.stop();
  });

  it("accepts a platform message id at the shared wire boundary", async () => {
    const messageId = "m".repeat(480);
    const fixture = await createPipeline(
      transport(async () => ({
        success: true,
        retryable: false,
        messageId,
        receiptBytes: Buffer.from(messageId, "utf8"),
      })),
    );
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();

    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "sent",
    });
    const sent = (await fixture.log.readStream<{
      readonly t: string;
      readonly receipt?: {
        readonly platformMessage?: { readonly messageId: string };
      };
    }>("delivery")).find((entry) => entry.body.t === "sent");
    expect(sent?.body.receipt?.platformMessage?.messageId).toBe(messageId);
    await fixture.pipeline.stop();
  });

  it("accepts the runtime timer maximum and rejects larger flush intervals", async () => {
    const maximum = await createPipeline(
      transport(async () => ({ success: true, retryable: false })),
      { flushIntervalMs: 2_147_483_647 },
    );
    await maximum.pipeline.stop();

    await expect(createPipeline(
      transport(async () => ({ success: true, retryable: false })),
      { flushIntervalMs: 2_147_483_648 },
    )).rejects.toThrow("Delivery flush interval must not exceed 2147483647ms");
  });
});
