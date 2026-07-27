import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "../../authority/index.js";
import type {
  DeliveryEnqueueKeyBody,
  DeliveryIntentDto,
  DeliveryStreamRecord,
  CommitEnvelope,
  LogicalRecord,
  PublishRecord,
} from "../../contracts/index.js";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  DeliveryAuthority,
  assertDeliveryEnvelopeCompanions,
  decideDeliveryResolution,
  deliveryRecord,
  deliveryItemId,
  deliveryOpenFactDigest,
  emptyDeliveryProjection,
  MAX_DELIVERY_IDENTIFIER_LENGTH,
  prepareDeliveryEnqueues,
  reduceDeliveryAuthorityRecord,
  validateDeliveryStreamRecord,
  type DeliveryClaimResult,
  type DeliveryEnqueueInput,
  type DeliveryEnqueueResult,
  type DeliveryProjection,
  type DeliveryResolutionDecision,
} from "../index.js";
import {
  createDeliverySourceFixture,
  deliverySourceRecords,
} from "./delivery-test-harness.js";
import { MAX_INLINE_DELIVERY_CONTENT_BYTES } from "../content-schema.js";

vi.setConfig({ testTimeout: 15_000 });

const FIRST = "2026-07-17T02:00:00.000Z";

async function harness(maxAttempts = 3) {
  let now = FIRST;
  const root = await createTempDir("delivery-authority");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => now,
  });
  const authority = new DeliveryAuthority({ log, anchorEpoch: 7 });
  const input = deliveryInput(maxAttempts);
  const created = await enqueue(log, artifacts, authority, input);
  if (!created.accepted) throw new Error("fixture enqueue was rejected");
  const itemId = created.items[0]!.itemId;
  return {
    root,
    artifacts,
    log,
    authority,
    input,
    itemId,
    setNow(value: string) {
      now = value;
    },
  };
}

function deliveryInput(
  maxAttempts = 3,
  overrides: Partial<DeliveryIntentDto> = {},
): DeliveryEnqueueInput {
  const keyBody: DeliveryEnqueueKeyBody = {
    kind: "conversation-final-delivery",
    conversationId: "conversation-1",
    runId: "run-1",
    commitRevision: 1,
  };
  return {
    keyBody,
    intent: {
      endpoint: {
        kind: "channel",
        target: { channelId: "feishu", to: "user-1" },
      },
      content: { text: "done", markdown: "done" },
      priority: "normal",
      source: { kind: "agent", conversationId: "conversation-1" },
      createdAt: FIRST,
      maxAttempts,
      ...overrides,
    },
  };
}

async function enqueue(
  log: FileAuthorityCommitLog,
  artifacts: FileArtifactStore,
  authority: DeliveryAuthority,
  input: DeliveryEnqueueInput,
): Promise<DeliveryEnqueueResult> {
  const source = await createDeliverySourceFixture(artifacts, input.keyBody);
  return authority.coordinate(async () => (
    await log.transactProjection<Record<string, never>, unknown, DeliveryEnqueueResult>(
      {},
      (state) => state,
      (_state) => {
        const decision = authority.prepareEnqueues([input], input.intent.createdAt);
        if (!decision.accepted || decision.records.length === 0) {
          return { kind: "return", value: decision };
        }
        return {
          kind: "append",
          entries: [
            ...source.records(decision.items[0]!.statusRevision),
            ...decision.records.map(deliveryRecord),
          ],
          value: decision,
        };
      },
      { candidateReferences: source.references },
    )
  ).value);
}

function requireSend(claim: DeliveryClaimResult) {
  if (claim.kind !== "send") throw new Error(`expected send claim, got ${claim.kind}`);
  return claim;
}

async function openUncertain(
  fixture: Awaited<ReturnType<typeof harness>>,
  policy: { kind: "manual-resolution" } | { kind: "idempotent-redrive"; windowMs: number } = {
    kind: "manual-resolution",
  },
) {
  const claim = requireSend(
    await fixture.authority.claim({ itemId: fixture.itemId, outcomePolicy: policy }),
  );
  const uncertain = await fixture.authority.claim({
    itemId: fixture.itemId,
    outcomePolicy: policy,
  });
  if (uncertain.kind !== "uncertain") throw new Error("fixture did not become uncertain");
  return { claim, uncertain };
}

async function resolve(
  fixture: Awaited<ReturnType<typeof harness>>,
  decision: "user-verified-sent" | "abandon" | "retry-risk-ack",
): Promise<DeliveryResolutionDecision> {
  const item = await fixture.authority.get(fixture.itemId);
  if (!item?.openFact) throw new Error("fixture has no open delivery fact");
  return (
    await fixture.log.transactProjection(
      emptyDeliveryProjection(),
      (state, record, envelope) => reduceDeliveryAuthorityRecord(state, record, envelope),
      (state, context) => {
        const result = decideDeliveryResolution(
          state,
          {
            itemId: fixture.itemId,
            attempt: item.currentAttempt,
            anchorEpoch: 7,
            openFactDigest: item.openFact!.openFactDigest,
            decision,
            by: "surface:user-1",
          },
          context,
          7,
        );
        return result.accepted
          ? {
              kind: "append" as const,
              entries: [
                deliveryRecord(result.record),
                {
                  stream: "control",
                  body: {
                    t: "applied",
                    requestId: `resolve-${result.record.fact.factDigest}`,
                    result: {
                      v: 1,
                      status: "ok",
                      body: { t: "delivery-resolve", applied: true },
                    },
                    authorityRevision: context.nextLsn,
                  },
                },
              ],
              value: result,
            }
          : { kind: "return" as const, value: result };
      },
      { stream: "delivery" },
    )
  ).value as DeliveryResolutionDecision;
}

describe("delivery authority lifecycle", () => {
  it("row 1 atomically creates one queued item from its frozen intent", async () => {
    const fixture = await harness();
    const item = await fixture.authority.get(fixture.itemId);
    expect(item).toMatchObject({
      state: "queued",
      statusRevision: 1,
      attempts: 0,
      createdAt: FIRST,
    });
    const commit = (await fixture.log.readAll()).at(-1)!;
    expect(commit.entries.map((entry) => entry.stream)).toEqual([
      "run:conversation-1",
      "delivery",
    ]);
  });

  it("row 2 durably starts the next attempt before it is sendable", async () => {
    const fixture = await harness();
    const claim = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    );
    expect(claim).toMatchObject({ attempt: 1, redrive: false });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({
      state: "attempting",
      statusRevision: 2,
      currentAttempt: 1,
    });
  });

  it("row 3 accepts success only for the current open attempt", async () => {
    const fixture = await harness();
    const claim = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    );
    await expect(
      fixture.authority.recordOutcome({
        itemId: fixture.itemId,
        attempt: claim.attempt,
        responseBindingDigest: claim.responseBindingDigest,
        outcome: { kind: "sent" },
      }),
    ).resolves.toMatchObject({ accepted: true, state: "sent", statusRevision: 3 });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({
      state: "sent",
      statusRevision: 3,
    });
  });

  it("row 4 schedules a bounded retry after a retryable failure", async () => {
    const fixture = await harness();
    const claim = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    );
    await fixture.authority.recordOutcome({
      itemId: fixture.itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: {
        kind: "failed",
        error: { code: "unavailable", message: "temporarily unavailable", retryable: true },
      },
      retryDelayMs: 5_000,
    });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({
      state: "retry-wait",
      nextAttemptAt: "2026-07-17T02:00:05.000Z",
      statusRevision: 3,
    });
  });

  it("row 5 closes a non-retryable failure as terminal", async () => {
    const fixture = await harness();
    const claim = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    );
    await fixture.authority.recordOutcome({
      itemId: fixture.itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: {
        kind: "failed",
        error: { code: "denied", message: "permanently denied", retryable: false },
      },
    });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({
      state: "failed",
      statusRevision: 3,
    });
    await expect(fixture.authority.statusHistory(fixture.itemId, 0)).resolves.toEqual([
      expect.objectContaining({ state: "delivery-failed", statusRevision: 3 }),
    ]);
  });

  it("row 6 reuses one idempotent attempt inside its redrive window", async () => {
    const fixture = await harness();
    const first = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "idempotent-redrive", windowMs: 10_000 },
      }),
    );
    fixture.setNow("2026-07-17T02:00:05.000Z");
    const redrive = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "idempotent-redrive", windowMs: 10_000 },
      }),
    );
    expect(redrive).toMatchObject({ attempt: first.attempt, redrive: true });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({
      state: "attempting",
      statusRevision: 2,
    });
  });

  it("row 7 opens uncertainty instead of blindly resending an unknown outcome", async () => {
    const fixture = await harness();
    const { uncertain } = await openUncertain(fixture);
    expect(uncertain.item).toMatchObject({
      state: "uncertain",
      statusRevision: 3,
      openFact: { openedAnchorEpoch: 7 },
    });
    expect(uncertain.notice).toMatchObject({
      state: "delivery-uncertain",
      openFactDigest: uncertain.item.openFact!.openFactDigest,
      statusRevision: 3,
    });
    await expect(fixture.authority.statusHistory(fixture.itemId, 2)).resolves.toEqual([
      expect.objectContaining({
        state: "delivery-uncertain",
        openFactDigest: uncertain.item.openFact!.openFactDigest,
        statusRevision: 3,
      }),
    ]);
  });

  it("row 8 starts the next retry only after retryAt", async () => {
    const fixture = await harness();
    const first = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    );
    await fixture.authority.recordOutcome({
      itemId: fixture.itemId,
      attempt: first.attempt,
      responseBindingDigest: first.responseBindingDigest,
      outcome: {
        kind: "failed",
        error: { code: "busy", message: "busy", retryable: true },
      },
      retryDelayMs: 5_000,
    });
    expect(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    ).toEqual({ kind: "skip" });
    fixture.setNow("2026-07-17T02:00:05.000Z");
    expect(
      requireSend(
        await fixture.authority.claim({
          itemId: fixture.itemId,
          outcomePolicy: { kind: "manual-resolution" },
        }),
      ).attempt,
    ).toBe(2);
  });

  it("row 9 accepts a bound late success while uncertainty remains open", async () => {
    const fixture = await harness();
    const { claim, uncertain } = await openUncertain(fixture);
    await expect(
      fixture.authority.recordOutcome({
        itemId: fixture.itemId,
        attempt: claim.attempt,
        responseBindingDigest: claim.responseBindingDigest,
        outcome: { kind: "sent" },
      }),
    ).resolves.toMatchObject({ accepted: true, state: "sent" });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({ state: "sent" });
    await expect(fixture.authority.statusHistory(fixture.itemId, 3)).resolves.toEqual([
      expect.objectContaining({
        state: "delivery-uncertain-closed",
        closedBy: "late-sent",
        openFactDigest: uncertain.item.openFact!.openFactDigest,
        statusRevision: 4,
      }),
    ]);
    await expect(fixture.authority.statusHistory(fixture.itemId, 4)).resolves.toEqual([]);
  });

  it("row 10 accepts a bound late retryable failure while uncertainty remains open", async () => {
    const fixture = await harness();
    const { claim, uncertain } = await openUncertain(fixture);
    await fixture.authority.recordOutcome({
      itemId: fixture.itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: {
        kind: "failed",
        error: { code: "busy", message: "busy", retryable: true },
      },
      retryDelayMs: 5_000,
    });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({ state: "retry-wait" });
    await expect(fixture.authority.statusHistory(fixture.itemId, 3)).resolves.toEqual([
      expect.objectContaining({
        state: "delivery-uncertain-closed",
        closedBy: "late-retry-scheduled",
        openFactDigest: uncertain.item.openFact!.openFactDigest,
        statusRevision: 4,
      }),
    ]);
  });

  it("row 11 accepts a bound late permanent failure while uncertainty remains open", async () => {
    const fixture = await harness();
    const { claim, uncertain } = await openUncertain(fixture);
    await fixture.authority.recordOutcome({
      itemId: fixture.itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: {
        kind: "failed",
        error: { code: "denied", message: "denied", retryable: false },
      },
    });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({ state: "failed" });
    await expect(fixture.authority.statusHistory(fixture.itemId, 3)).resolves.toEqual([
      expect.objectContaining({
        state: "delivery-uncertain-closed",
        closedBy: "late-failed",
        error: { code: "denied", message: "denied", retryable: false },
        openFactDigest: uncertain.item.openFact!.openFactDigest,
        statusRevision: 4,
      }),
    ]);
  });

  it("row 12 records user verification without forging an external sent fact", async () => {
    const fixture = await harness();
    const { uncertain } = await openUncertain(fixture);
    expect(await resolve(fixture, "user-verified-sent")).toMatchObject({
      accepted: true,
      state: "verified-sent",
    });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({
      state: "verified-sent",
    });
    await expect(fixture.authority.statusHistory(fixture.itemId, 3)).resolves.toEqual([
      expect.objectContaining({
        state: "delivery-resolved",
        decision: "user-verified-sent",
        openFactDigest: uncertain.item.openFact!.openFactDigest,
        statusRevision: 4,
      }),
    ]);
  });

  it("row 13 records abandonment as a distinct terminal state", async () => {
    const fixture = await harness();
    const { uncertain } = await openUncertain(fixture);
    expect(await resolve(fixture, "abandon")).toMatchObject({
      accepted: true,
      state: "abandoned",
    });
    await expect(fixture.authority.statusHistory(fixture.itemId, 3)).resolves.toEqual([
      expect.objectContaining({
        state: "delivery-resolved",
        decision: "abandon",
        openFactDigest: uncertain.item.openFact!.openFactDigest,
        statusRevision: 4,
      }),
    ]);
  });

  it("row 14 grants exactly one additional risk-acknowledged attempt", async () => {
    const fixture = await harness(1);
    const { uncertain } = await openUncertain(fixture);
    await resolve(fixture, "retry-risk-ack");
    await expect(fixture.authority.statusHistory(fixture.itemId, 3)).resolves.toEqual([
      expect.objectContaining({
        state: "delivery-resolved",
        decision: "retry-risk-ack",
        openFactDigest: uncertain.item.openFact!.openFactDigest,
        statusRevision: 4,
      }),
    ]);
    const extra = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    );
    expect(extra.attempt).toBe(2);
    expect((await fixture.authority.get(fixture.itemId))?.pendingManualRetryFactDigest).toBe(
      undefined,
    );
  });

  it.each([1, 2, 3])(
    "keeps automatic budget independent when risk acknowledgement opens at attempt %i",
    async (uncertainAt) => {
      const fixture = await harness(3);
      let claim = requireSend(
        await fixture.authority.claim({
          itemId: fixture.itemId,
          outcomePolicy: { kind: "manual-resolution" },
        }),
      );
      for (let ordinal = 1; ordinal < uncertainAt; ordinal += 1) {
        await fixture.authority.recordOutcome({
          itemId: fixture.itemId,
          attempt: claim.attempt,
          responseBindingDigest: claim.responseBindingDigest,
          outcome: {
            kind: "failed",
            error: { code: "busy", message: "busy", retryable: true },
          },
          retryDelayMs: 0,
        });
        claim = requireSend(
          await fixture.authority.claim({
            itemId: fixture.itemId,
            outcomePolicy: { kind: "manual-resolution" },
          }),
        );
      }

      const opened = await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      });
      expect(opened.kind).toBe("uncertain");
      await resolve(fixture, "retry-risk-ack");
      let manual = requireSend(
        await fixture.authority.claim({
          itemId: fixture.itemId,
          outcomePolicy: { kind: "manual-resolution" },
        }),
      );
      const manualRecord = (await fixture.log.readAll())
        .flatMap((commit) => commit.entries)
        .map((entry) => entry.body as DeliveryStreamRecord)
        .filter((record) => record.t === "attempt-started")
        .at(-1);
      expect(manualRecord).toMatchObject({
        t: "attempt-started",
        authorization: { kind: "manual" },
      });

      for (;;) {
        const decision = await fixture.authority.recordOutcome({
          itemId: fixture.itemId,
          attempt: manual.attempt,
          responseBindingDigest: manual.responseBindingDigest,
          outcome: {
            kind: "failed",
            error: { code: "busy", message: "busy", retryable: true },
          },
          retryDelayMs: 0,
        });
        if (!decision.accepted || decision.state === "failed") break;
        manual = requireSend(
          await fixture.authority.claim({
            itemId: fixture.itemId,
            outcomePolicy: { kind: "manual-resolution" },
          }),
        );
      }

      expect(await fixture.authority.get(fixture.itemId)).toMatchObject({
        state: "failed",
        currentAttempt: 4,
        automaticAttemptsUsed: 3,
      });
      const restarted = new DeliveryAuthority({ log: fixture.log, anchorEpoch: 7 });
      expect(await restarted.get(fixture.itemId)).toMatchObject({
        state: "failed",
        currentAttempt: 4,
        automaticAttemptsUsed: 3,
      });
    },
    30_000,
  );

  it("rejects the previous attempt response binding after a risk-acknowledged retry starts", async () => {
    const fixture = await harness(1);
    const { claim: first } = await openUncertain(fixture);
    await resolve(fixture, "retry-risk-ack");
    const second = requireSend(await fixture.authority.claim({
      itemId: fixture.itemId,
      outcomePolicy: { kind: "manual-resolution" },
    }));

    await expect(fixture.authority.recordOutcome({
      itemId: fixture.itemId,
      attempt: first.attempt,
      responseBindingDigest: first.responseBindingDigest,
      outcome: { kind: "sent" },
    })).resolves.toEqual({ accepted: false });
    expect(await fixture.authority.get(fixture.itemId)).toMatchObject({
      state: "attempting",
      currentAttempt: second.attempt,
    });
  });

  it("row 15 keeps terminal items unchanged under late outcomes and resolutions", async () => {
    const fixture = await harness();
    const claim = requireSend(
      await fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    );
    await fixture.authority.recordOutcome({
      itemId: fixture.itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: { kind: "sent" },
    });
    const before = await fixture.authority.get(fixture.itemId);
    await expect(
      fixture.authority.recordOutcome({
        itemId: fixture.itemId,
        attempt: claim.attempt,
        responseBindingDigest: claim.responseBindingDigest,
        outcome: {
          kind: "failed",
          error: { code: "late", message: "late", retryable: false },
        },
      }),
    ).resolves.toEqual({ accepted: false });
    expect(await fixture.authority.get(fixture.itemId)).toEqual(before);
  });
});

describe("delivery unique index and replay", () => {
  it("generates the frozen prefixed ULID identity vector and rejects malformed item ids", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(deliveryItemId(digest, FIRST)).toBe("dlv-01KXPWTM80BYB4SH423EJT1CVN");
    const prepared = prepareDeliveryEnqueues(
      emptyDeliveryProjection(),
      [deliveryInput()],
      FIRST,
    );
    if (!prepared.accepted) throw new Error("fixture prepare failed");
    const record = prepared.records[0]!;
    expect(record.itemId).toMatch(/^dlv-[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    for (const itemId of [
      record.itemId.replace("dlv-", "item-"),
      `${record.itemId.slice(0, -1)}I`,
      record.itemId.slice(0, -1),
    ]) {
      expect(() => validateDeliveryStreamRecord({ ...record, itemId })).toThrow(
        "dlv-<Ulid>",
      );
    }
  });

  it("coalesces concurrent identical keys into one durable item", async () => {
    const root = await createTempDir("delivery-concurrent-key");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => FIRST,
    });
    const left = new DeliveryAuthority({ log, anchorEpoch: 7 });
    const right = new DeliveryAuthority({ log, anchorEpoch: 7 });
    const input = deliveryInput();
    const [a, b] = await Promise.all([
      enqueue(log, artifacts, left, input),
      enqueue(log, artifacts, right, input),
    ]);
    expect(a.accepted && b.accepted).toBe(true);
    if (!a.accepted || !b.accepted) return;
    expect(a.items[0]!.itemId).toBe(b.items[0]!.itemId);
    const deliveryRecords = (await log.readAll<DeliveryStreamRecord>())
      .flatMap((envelope) => envelope.entries)
      .filter((record) => record.stream === "delivery");
    expect(deliveryRecords).toHaveLength(1);
  });

  it("rejects the same key with a different frozen intent without appending", async () => {
    const fixture = await harness();
    const before = (await fixture.log.readAll()).length;
    const conflict = await enqueue(
      fixture.log,
      fixture.artifacts,
      fixture.authority,
      deliveryInput(3, { content: { text: "different" } }),
    );
    expect(conflict).toMatchObject({
      accepted: false,
      error: { code: "idempotency-conflict" },
    });
    expect(await fixture.log.readAll()).toHaveLength(before);
  });

  it("rebuilds the same projection from an empty process-local cache", async () => {
    const fixture = await harness();
    const restarted = new DeliveryAuthority({ log: fixture.log, anchorEpoch: 7 });
    expect(await restarted.get(fixture.itemId)).toEqual(
      await fixture.authority.get(fixture.itemId),
    );
  });

  it("keeps an in-flight response binding valid when the anchor migrates before uncertainty", async () => {
    const fixture = await harness();
    const started = requireSend(await fixture.authority.claim({
      itemId: fixture.itemId,
      outcomePolicy: { kind: "manual-resolution" },
    }));
    const migrated = new DeliveryAuthority({ log: fixture.log, anchorEpoch: 8 });

    await expect(migrated.recordOutcome({
      itemId: fixture.itemId,
      attempt: started.attempt,
      responseBindingDigest: started.responseBindingDigest,
      outcome: { kind: "sent" },
    })).resolves.toMatchObject({ accepted: true, state: "sent" });
  });

  it("preserves an open uncertainty fact across an anchor epoch change", async () => {
    const fixture = await harness();
    const started = await fixture.authority.claim({
      itemId: fixture.itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    if (started.kind !== "send") throw new Error("fixture attempt did not start");
    fixture.setNow("2026-07-17T02:00:01.000Z");
    const uncertain = await fixture.authority.claim({
      itemId: fixture.itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    if (uncertain.kind !== "uncertain" || !uncertain.item.openFact) {
      throw new Error("fixture uncertainty did not open");
    }

    const migrated = new DeliveryAuthority({ log: fixture.log, anchorEpoch: 8 });
    await expect(migrated.statusHistory(fixture.itemId, 0)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "delivery-uncertain",
          anchorEpoch: 8,
        }),
      ]),
    );
    await expect(
      migrated.recordOutcome({
        itemId: fixture.itemId,
        attempt: started.attempt,
        responseBindingDigest: started.responseBindingDigest,
        outcome: { kind: "sent" },
      }),
    ).resolves.toMatchObject({ accepted: true, state: "sent" });
    await expect(migrated.get(fixture.itemId)).resolves.toMatchObject({
      state: "sent",
      statusRevision: 4,
    });
  });

  it("rejects lifecycle records whose frozen time differs from their envelope", () => {
    const input = deliveryInput();
    const state = emptyDeliveryProjection();
    const prepared = prepareDeliveryEnqueues(state, [input], input.intent.createdAt);
    if (!prepared.accepted) throw new Error("valid fixture was rejected");
    const record = prepared.records[0]!;
    const logical = { stream: "delivery", body: record } as LogicalRecord<unknown>;
    expect(() =>
      reduceDeliveryAuthorityRecord(
        state,
        logical,
        {
          at: "2026-07-17T02:00:01.000Z",
          entries: [
            ...deliverySourceRecords(
              input.keyBody,
              { digest: `sha256:${"a".repeat(64)}`, bytes: 1 },
              1,
            ),
            logical,
          ],
        } as CommitEnvelope<unknown>,
      ),
    ).toThrow();
  });

  it("rejects an enqueue whose frozen creation time differs before append", () => {
    expect(() =>
      prepareDeliveryEnqueues(
        emptyDeliveryProjection(),
        [deliveryInput()],
        "2026-07-17T02:00:01.000Z",
      ),
    ).toThrow("Delivery creation time must equal its authority commit time");
  });

  it("rejects inline content above the shared authority byte budget", () => {
    const text = "x".repeat(MAX_INLINE_DELIVERY_CONTENT_BYTES + 1);

    expect(() =>
      prepareDeliveryEnqueues(
        emptyDeliveryProjection(),
        [deliveryInput(3, { content: { text, markdown: text } })],
        FIRST,
      ),
    ).toThrow("Inline delivery content must be externalized");
  });

  it("shares the protocol identifier boundary at the durable delivery consumer", () => {
    const boundary = "c".repeat(MAX_DELIVERY_IDENTIFIER_LENGTH);
    const endpoint = (channelId: string): DeliveryIntentDto["endpoint"] => ({
      kind: "channel",
      target: { channelId, to: "user-1" },
    });

    expect(
      prepareDeliveryEnqueues(
        emptyDeliveryProjection(),
        [deliveryInput(3, { endpoint: endpoint(boundary) })],
        FIRST,
      ).accepted,
    ).toBe(true);
    expect(() =>
      prepareDeliveryEnqueues(
        emptyDeliveryProjection(),
        [deliveryInput(3, { endpoint: endpoint(`${boundary}c`) })],
        FIRST,
      ),
    ).toThrow("Delivery channel id must be a non-empty bounded string");
  });

  it("rejects an orphan enqueue during replay", async () => {
    const root = await createTempDir("delivery-orphan");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => FIRST,
    });
    const prepared = prepareDeliveryEnqueues(
      emptyDeliveryProjection(),
      [deliveryInput()],
      FIRST,
    );
    if (!prepared.accepted) throw new Error("fixture prepare failed");
    await log.append(prepared.records.map(deliveryRecord));

    const restarted = new DeliveryAuthority({ log, anchorEpoch: 7 });
    await expect(restarted.list()).rejects.toThrow(
      "Delivery enqueue must have exactly one matching authority source fact",
    );
  });

  it("binds a staged enqueue to its exact durable publish outcome", async () => {
    const root = await createTempDir("delivery-staged-companion");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => FIRST,
    });
    const authority = new DeliveryAuthority({ log, anchorEpoch: 7 });
    const input: DeliveryEnqueueInput = {
      ...deliveryInput(),
      keyBody: {
        kind: "staged-delivery",
        assignmentId: "assignment-1",
        mutationSeq: 2,
      },
    };
    const prepared = authority.prepareEnqueues([input], FIRST);
    if (!prepared.accepted) throw new Error("fixture prepare failed");
    const source = await createDeliverySourceFixture(artifacts, input.keyBody);
    const mismatchedSource = source.records(1).map((record) => {
      if (record.stream !== "publish") return record;
      const body = record.body as Extract<PublishRecord, { t: "publish-decision" }>;
      return {
        ...record,
        body: {
          ...body,
          outcomes: body.outcomes.map((entry) =>
            entry.seq === input.keyBody.mutationSeq
              ? {
                  ...entry,
                  outcome: { t: "granted" as const, targetRevision: 2 },
                }
              : entry,
          ),
        },
      };
    });
    await log.append([
      ...mismatchedSource,
      ...prepared.records.map(deliveryRecord),
    ]);

    await expect(authority.list()).rejects.toThrow(
      "Staged delivery enqueue must bind one committed assignment and publish outcome",
    );
  });

  it("shares the complete publish decision structure without narrowing AuthorityError", () => {
    const ref = { digest: `sha256:${"b".repeat(64)}`, bytes: 1 };
    const input: DeliveryEnqueueInput = {
      ...deliveryInput(),
      keyBody: {
        kind: "staged-delivery",
        assignmentId: "assignment-1",
        mutationSeq: 2,
      },
    };
    const prepared = prepareDeliveryEnqueues(
      emptyDeliveryProjection(),
      [input],
      FIRST,
    );
    if (!prepared.accepted) throw new Error("fixture prepare failed");
    const enqueueRecord = deliveryRecord(prepared.records[0]!);
    const committed = {
      stream: "run:conversation-1",
      body: {
        t: "committed",
        runId: "run-1",
        assignmentId: "assignment-1",
        bundle: { ref },
        commitRevision: 1,
      },
    };
    const decision = {
      stream: "publish",
      body: {
        t: "publish-decision",
        assignmentId: "assignment-1",
        batch: { ref },
        sessionCount: 1,
        globalCount: 1,
        outcomes: [
          {
            seq: 1,
            outcome: {
              t: "conflicted",
              error: {
                code: "invalid",
                message: "x".repeat(600),
                retryable: false,
              },
            },
          },
          { seq: 2, outcome: { t: "granted", targetRevision: 1 } },
        ],
      },
    };
    const envelope = (publish: unknown) =>
      ({ entries: [committed, publish, enqueueRecord] }) as CommitEnvelope<unknown>;
    expect(() => assertDeliveryEnvelopeCompanions(envelope(decision))).not.toThrow();

    const malformed = [
      {
        ...decision,
        body: {
          ...decision.body,
          outcomes: decision.body.outcomes.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  outcome: {
                    ...item.outcome,
                    error: { code: "not-a-code", message: "bad", retryable: false },
                  },
                }
              : item,
          ),
        },
      },
      { ...decision, body: { ...decision.body, globalCount: 2 } },
      {
        ...decision,
        body: {
          ...decision.body,
          outcomes: decision.body.outcomes.map((item) => ({ ...item, seq: 1 })),
        },
      },
    ];
    for (const publish of malformed) {
      expect(() => assertDeliveryEnvelopeCompanions(envelope(publish))).toThrow(
        "Staged delivery enqueue",
      );
    }
  });

  it("rejects orphan or mismatched resolution companions", async () => {
    const fixture = await harness();
    await openUncertain(fixture);
    const item = await fixture.authority.get(fixture.itemId);
    if (!item?.openFact) throw new Error("fixture has no open fact");
    const projected = await fixture.log.transactProjection(
      emptyDeliveryProjection(),
      reduceDeliveryAuthorityRecord,
      (state, context) => ({ kind: "return" as const, value: { state, context } }),
      { stream: "delivery" },
    );
    const decision = decideDeliveryResolution(
      projected.value.state,
      {
        itemId: fixture.itemId,
        attempt: item.currentAttempt,
        anchorEpoch: 7,
        openFactDigest: item.openFact.openFactDigest,
        decision: "abandon",
        by: "surface:user-1",
      },
      projected.value.context,
      7,
    );
    if (!decision.accepted) throw new Error("fixture resolution was rejected");
    const resolved = deliveryRecord(decision.record);
    const applied = {
      stream: "control",
      body: {
        t: "applied",
        requestId: "request-1",
        result: {
          v: 1,
          status: "ok",
          body: { t: "delivery-resolve", applied: true },
        },
        authorityRevision: projected.value.context.nextLsn,
      },
    };
    const base = {
      lsn: projected.value.context.nextLsn,
      at: projected.value.context.at,
    };
    expect(() =>
      assertDeliveryEnvelopeCompanions({
        ...base,
        entries: [resolved, applied],
      } as CommitEnvelope<unknown>),
    ).not.toThrow();
    for (const entries of [
      [resolved],
      [applied],
      [resolved, { ...applied, body: { ...applied.body, authorityRevision: base.lsn + 1 } }],
      [
        resolved,
        {
          ...applied,
          body: {
            ...applied.body,
            result: {
              v: 1,
              status: "ok",
              body: { t: "delivery-resolve", applied: false },
            },
          },
        },
      ],
      [resolved, applied, applied],
    ]) {
      expect(() =>
        assertDeliveryEnvelopeCompanions({
          ...base,
          entries,
        } as CommitEnvelope<unknown>),
      ).toThrow("must be unique companions");
    }
    await fixture.log.append([resolved]);
    await expect(
      new DeliveryAuthority({ log: fixture.log, anchorEpoch: 7 }).list(),
    ).rejects.toThrow("must be unique companions");
  });

  it("keeps a good projection snapshot after a failed transaction", async () => {
    const fixture = await harness();
    await expect(
      fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "idempotent-redrive", windowMs: 0 },
      }),
    ).rejects.toThrow("positive safe integer");
    await expect(fixture.authority.list()).resolves.toEqual([
      expect.objectContaining({ id: fixture.itemId, state: "queued" }),
    ]);
    await expect(
      fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    ).resolves.toMatchObject({ kind: "send", attempt: 1 });
  });

  it("does not publish a projection mutated by a failed replay", async () => {
    const fixture = await harness();
    const mutableLog = fixture.log as unknown as {
      transactProjection: (...args: unknown[]) => Promise<unknown>;
    };
    const original = mutableLog.transactProjection.bind(fixture.log);
    mutableLog.transactProjection = async (...args: unknown[]) => {
      (args[0] as DeliveryProjection).items.clear();
      throw new Error("injected projection failure");
    };
    await expect(fixture.authority.list()).rejects.toThrow("injected projection failure");
    mutableLog.transactProjection = original;
    await expect(fixture.authority.list()).resolves.toEqual([
      expect.objectContaining({ id: fixture.itemId, state: "queued" }),
    ]);
  });

  it("recovers a committed transition when the transaction response is lost", async () => {
    const fixture = await harness();
    const mutableLog = fixture.log as unknown as {
      transactProjection: (...args: unknown[]) => Promise<unknown>;
    };
    const original = mutableLog.transactProjection.bind(fixture.log);
    let failAfterCommit = true;
    mutableLog.transactProjection = async (...args: unknown[]) => {
      const transaction = await original(...args) as { readonly commit?: unknown };
      if (failAfterCommit && transaction.commit) {
        failAfterCommit = false;
        throw new Error("simulated lost transaction response");
      }
      return transaction;
    };
    await expect(
      fixture.authority.claim({
        itemId: fixture.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    ).rejects.toThrow("simulated lost transaction response");
    mutableLog.transactProjection = original;

    await expect(fixture.authority.get(fixture.itemId)).resolves.toMatchObject({
      state: "attempting",
      currentAttempt: 1,
      automaticAttemptsUsed: 1,
    });
  });

  it("keeps the last good snapshot when a peer tail mutates then fails", async () => {
    const fixture = await harness();
    await fixture.log.append([
      deliveryRecord({
        t: "attempt-started",
        itemId: fixture.itemId,
        attempt: 1,
        authorization: { kind: "automatic" },
        startedAt: FIRST,
        unknownOutcome: { kind: "manual-resolution" },
        statusRevision: 2,
      }),
      { stream: "delivery", body: { t: "malformed-peer-tail" } },
    ]);

    await expect(fixture.authority.list()).rejects.toThrow(
      "Delivery stream record type is invalid",
    );
    expect(fixture.authority.snapshot()).toEqual([
      expect.objectContaining({ id: fixture.itemId, state: "queued" }),
    ]);
    await expect(fixture.authority.list()).rejects.toThrow(
      "Delivery stream record type is invalid",
    );
    expect(fixture.authority.snapshot()).toEqual([
      expect.objectContaining({ id: fixture.itemId, state: "queued" }),
    ]);
  });

  it("rejects sibling lifecycle transitions during cold replay", async () => {
    const earlyFailed = await harness(3);
    const claim = requireSend(
      await earlyFailed.authority.claim({
        itemId: earlyFailed.itemId,
        outcomePolicy: { kind: "manual-resolution" },
      }),
    );
    await earlyFailed.log.append([
      deliveryRecord({
        t: "failed",
        itemId: earlyFailed.itemId,
        attempt: claim.attempt,
        error: { code: "busy", message: "busy", retryable: true },
        statusRevision: 3,
      }),
    ]);
    await expect(
      new DeliveryAuthority({ log: earlyFailed.log, anchorEpoch: 7 }).list(),
    ).rejects.toThrow("remaining automatic budget");

    const premature = await harness(3);
    const idempotent = requireSend(
      await premature.authority.claim({
        itemId: premature.itemId,
        outcomePolicy: { kind: "idempotent-redrive", windowMs: 10_000 },
      }),
    );
    premature.setNow("2026-07-17T02:00:05.000Z");
    const openedAt = "2026-07-17T02:00:05.000Z";
    const unknownOutcome = {
      kind: "idempotent-redrive" as const,
      redriveUntil: "2026-07-17T02:00:10.000Z",
    };
    await premature.log.append([
      deliveryRecord({
        t: "delivery-uncertain",
        itemId: premature.itemId,
        attempt: idempotent.attempt,
        openedAnchorEpoch: 7,
        openedAt,
        openFactDigest: deliveryOpenFactDigest({
          itemId: premature.itemId,
          attempt: idempotent.attempt,
          openedAnchorEpoch: 7,
          startedAt: FIRST,
          unknownOutcome,
          idempotencyKey: idempotent.item.idempotencyKey,
        }),
        statusRevision: 3,
      }),
    ]);
    await expect(
      new DeliveryAuthority({ log: premature.log, anchorEpoch: 7 }).list(),
    ).rejects.toThrow("does not bind the open attempt");
  });

  it("rejects malformed or non-deliverable companion source projections", () => {
    const ref = { digest: `sha256:${"a".repeat(64)}`, bytes: 1 };
    const final = prepareDeliveryEnqueues(
      emptyDeliveryProjection(),
      [deliveryInput()],
      FIRST,
    );
    if (!final.accepted) throw new Error("fixture prepare failed");
    const finalEnqueue = deliveryRecord(final.records[0]!);
    const finalSource = {
      stream: "run:conversation-1",
      body: {
        t: "committed",
        runId: "run-1",
        assignmentId: "assignment-1",
        bundle: { ref },
        commitRevision: 1,
      },
    };
    const malformedFinals = [
      { ...finalSource, body: { ...finalSource.body, assignmentId: undefined } },
      { ...finalSource, body: { ...finalSource.body, extra: true } },
      { ...finalSource, body: { ...finalSource.body, bundle: undefined } },
    ];
    for (const source of malformedFinals) {
      expect(() =>
        assertDeliveryEnvelopeCompanions({
          entries: [source, finalEnqueue],
        } as unknown as CommitEnvelope<unknown>),
      ).toThrow("exactly one matching authority source fact");
    }

    const statusInput: DeliveryEnqueueInput = {
      ...deliveryInput(),
      keyBody: {
        kind: "conversation-status-delivery",
        conversationId: "conversation-1",
        runId: "run-1",
        statusRevision: 2,
      },
    };
    const status = prepareDeliveryEnqueues(
      emptyDeliveryProjection(),
      [statusInput],
      FIRST,
    );
    if (!status.accepted) throw new Error("fixture status prepare failed");
    expect(() =>
      assertDeliveryEnvelopeCompanions({
        entries: [
          {
            stream: "run:conversation-1",
            body: {
              t: "state",
              runId: "run-1",
              assignmentId: "assignment-1",
              state: "failed",
              reason: "provider unavailable",
              statusRevision: 2,
            },
          },
          deliveryRecord(status.records[0]!),
        ],
      } as unknown as CommitEnvelope<unknown>),
    ).not.toThrow();
    expect(() =>
      assertDeliveryEnvelopeCompanions({
        entries: [
          {
            stream: "run:conversation-1",
            body: {
              t: "state",
              runId: "run-1",
              assignmentId: "assignment-1",
              state: "failed",
              reason: "x".repeat(513),
              statusRevision: 2,
            },
          },
          deliveryRecord(status.records[0]!),
        ],
      } as unknown as CommitEnvelope<unknown>),
    ).toThrow("exactly one matching authority source fact");
    expect(() =>
      assertDeliveryEnvelopeCompanions({
        entries: [
          {
            stream: "run:conversation-1",
            body: {
              t: "state",
              runId: "run-1",
              state: "running",
              statusRevision: 2,
            },
          },
          deliveryRecord(status.records[0]!),
        ],
      } as unknown as CommitEnvelope<unknown>),
    ).toThrow("exactly one matching authority source fact");
  });

  it("only a successful empty cancel-batch applied fact may source a control response", () => {
    const responseInput: DeliveryEnqueueInput = {
      ...deliveryInput(),
      keyBody: {
        kind: "conversation-control-response-delivery",
        conversationId: "conversation-1",
        requestId: "cancel:batch-1",
      },
    };
    const prepared = prepareDeliveryEnqueues(
      emptyDeliveryProjection(),
      [responseInput],
      FIRST,
    );
    if (!prepared.accepted) throw new Error("fixture prepare failed");
    const enqueue = deliveryRecord(prepared.records[0]!);
    const applied = (result: unknown, requestId = "cancel:batch-1") => ({
      stream: "control",
      body: { t: "applied", requestId, result, authorityRevision: 5 },
    });
    const emptyBatch = {
      v: 1,
      status: "ok",
      body: { t: "cancel-batch", conversationId: "conversation-1", runs: [] },
    };

    // 合法:成功的空 cancel-batch applied
    expect(() =>
      assertDeliveryEnvelopeCompanions({
        entries: [applied(emptyBatch), enqueue],
      } as unknown as CommitEnvelope<unknown>),
    ).not.toThrow();

    // 其他控制类型、非空批次、外置 result、requestId 失配一律不得冒充回执来源
    const impostors = [
      applied({ v: 1, status: "ok", body: { t: "session-write", revision: 3 } }),
      applied({
        v: 1,
        status: "ok",
        body: {
          t: "cancel-batch",
          conversationId: "conversation-1",
          runs: [
            {
              runId: "run-1",
              runState: "cancelled",
              source: "interactive",
              ingressId: "ingress-1",
            },
          ],
        },
      }),
      applied({ v: 1, status: "rejected", error: { code: "busy", message: "x", retryable: false } }),
      applied({ ref: { digest: `sha256:${"b".repeat(64)}`, bytes: 64 } }),
      applied(emptyBatch, "cancel:another-request"),
      applied({
        v: 1,
        status: "ok",
        body: { t: "cancel-batch", conversationId: "conversation-2", runs: [] },
      }),
    ];
    for (const impostor of impostors) {
      expect(() =>
        assertDeliveryEnvelopeCompanions({
          entries: [impostor, enqueue],
        } as unknown as CommitEnvelope<unknown>),
      ).toThrow("exactly one matching authority source fact");
    }
  });

  it("validates a transport outcome before appending it", async () => {
    const fixture = await harness();
    const claim = requireSend(await fixture.authority.claim({
      itemId: fixture.itemId,
      outcomePolicy: { kind: "manual-resolution" },
    }));
    const before = (await fixture.log.readAll()).length;

    await expect(fixture.authority.recordOutcome({
      itemId: fixture.itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: {
        kind: "sent",
        receipt: { digest: "not-a-digest" },
      },
    })).rejects.toThrow("Delivery receipt digest");

    expect(await fixture.log.readAll()).toHaveLength(before);
    const restarted = new DeliveryAuthority({ log: fixture.log, anchorEpoch: 7 });
    expect((await restarted.get(fixture.itemId))?.state).toBe("attempting");
  });
});
