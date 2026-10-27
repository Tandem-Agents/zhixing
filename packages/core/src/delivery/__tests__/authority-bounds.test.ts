import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileAuthorityCommitLog } from "../../authority/index.js";
import { createEventBus } from "../../events/event-bus.js";
import { AuthorityDeliveryPipeline } from "../authority-pipeline.js";
import {
  DELIVERY_AUTHORITY_PROJECTION_ID,
  DeliveryAuthority,
  deliveryRecord,
  prepareDeliveryEnqueues,
} from "../index.js";
import type {
  AuthorityDeliveryEventMap,
  DeliveryEndpointTransport,
  DeliveryEnqueueResult,
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
  conversationId: "conversation-bounds",
  runId,
  commitRevision: 1,
});

function recordingTransport(sent: string[]): DeliveryTransport {
  const adapter = {
    endpointKind: "channel" as const,
    send: (async (_endpoint, _content, context) => {
      sent.push(context.itemId);
      return { success: true, retryable: false } as const;
    }) satisfies DeliveryEndpointTransport["send"],
    isReady: () => true,
    responseLossEvidence: () => ({ kind: "unverified" as const }),
  };
  return { resolve: () => adapter };
}

describe("delivery authority bounds and recovery", () => {
  it("counts earlier enqueues of the same envelope: the same intent dedupes and a different one is rejected", async () => {
    const fixture = await createDeliveryTestHarness();
    const first = deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody("run-1"));
    const conflicting = deliveryTestInput(
      { createdAt: DELIVERY_TEST_TIME, content: { text: "other", markdown: "other" } },
      keyBody("run-1"),
    );
    const decided = (await fixture.log.transactProjection<Record<string, never>, unknown, {
      readonly planned: DeliveryEnqueueResult;
      readonly same: DeliveryEnqueueResult;
      readonly different: DeliveryEnqueueResult;
      readonly blind: DeliveryEnqueueResult;
    }>(
      {},
      (state) => state,
      async (_state, context) => {
        const planned = await fixture.authority.prepareEnqueues([first], DELIVERY_TEST_TIME, prepareDeliveryEnqueues, context);
        if (!planned.accepted) throw new Error("fixture enqueue rejected");
        const candidates = planned.records.map(deliveryRecord);
        return {
          kind: "return",
          value: {
            planned,
            same: await fixture.authority.prepareEnqueues([first], DELIVERY_TEST_TIME, prepareDeliveryEnqueues, context, candidates),
            different: await fixture.authority.prepareEnqueues([conflicting], DELIVERY_TEST_TIME, prepareDeliveryEnqueues, context, candidates),
            // 不带候选：看不到本事务已计划的入队，会再计划一条同键入队
            blind: await fixture.authority.prepareEnqueues([first], DELIVERY_TEST_TIME, prepareDeliveryEnqueues, context),
          },
        };
      },
      { readProjectionIds: [DELIVERY_AUTHORITY_PROJECTION_ID] },
    )).value;
    if (!decided.planned.accepted) throw new Error("fixture enqueue rejected");
    const itemId = decided.planned.items[0]!.itemId;
    expect(decided.same).toEqual({
      accepted: true,
      records: [],
      items: [{ itemId, state: "queued", statusRevision: 1 }],
    });
    expect(decided.different).toMatchObject({ accepted: false, error: { code: "idempotency-conflict" } });
    if (!decided.blind.accepted) throw new Error("blind fixture rejected");
    expect(decided.blind.records).toHaveLength(1);
    // 同键的两条入队进同一 envelope：持久投影的归约在追加时拒绝，什么都不写
    await expect(fixture.log.append([
      ...decided.planned.records.map(deliveryRecord),
      ...decided.blind.records.map(deliveryRecord),
    ])).rejects.toThrow();
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 0 });
  });

  it("recovers an attempting delivery on a cold instance without resending an uncertain outcome", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody("run-attempting")));
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    const claim = await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
    expect(claim.kind).toBe("send");
    await fixture.log.stopStorageMaintenance();

    // 进程在外部效果之后、记结果之前崩溃：冷实例从待领取目录里重新拿到这条 attempting
    const coldLog = new FileAuthorityCommitLog(path.join(fixture.root, "authority"), fixture.artifacts, {
      clock: () => DELIVERY_TEST_TIME,
    });
    const cold = new DeliveryAuthority({ log: coldLog, anchorEpoch: 7 });
    const coldLifecycle = createDeliveryLifecycleTestBinding(cold).application;
    try {
      const page = await cold.claimablePage({ priority: "normal", kind: "ready", now: DELIVERY_TEST_TIME, limit: 8 });
      expect(page.items.map(({ item }) => [item.id, item.state])).toEqual([[itemId, "attempting"]]);
      // 人工核实策略：领取时开出 uncertain，不重发
      await expect(coldLifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } }))
        .resolves.toMatchObject({ kind: "uncertain" });
      await expect(cold.claimablePage({ priority: "normal", kind: "ready", now: DELIVERY_TEST_TIME, limit: 8 }))
        .resolves.toMatchObject({ items: [] });
      const uncertain = await cold.uncertainPage(undefined, 8);
      expect(uncertain.items.map(({ item }) => [item.id, item.state])).toEqual([[itemId, "uncertain"]]);
    } finally {
      await coldLog.stopStorageMaintenance();
    }
  });

  it("freezes a complete pending set larger than one directory page", async () => {
    const fixture = await createDeliveryTestHarness();
    const pending = 130;
    for (let index = 0; index < pending; index += 1) {
      const created = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody(`run-${index}`)));
      if (!created.accepted) throw new Error("fixture enqueue failed");
    }
    const captured = await fixture.lifecycle.captureAcceptedWork();
    expect(captured).toHaveLength(pending);
    await fixture.lifecycle.installAdmission({ operationId: "stop-bounds", sources: [], deliveries: captured });
    const accepted = await fixture.lifecycle.acceptedWorkItems("stop-bounds");
    expect(accepted.map(({ id }) => id)).toEqual(captured.map(({ id }) => id));
  });

  it("claims a later high-priority delivery before an earlier normal backlog larger than one page", async () => {
    const fixture = await createDeliveryTestHarness();
    for (let index = 0; index < 40; index += 1) {
      const created = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody(`normal-${index}`)));
      if (!created.accepted) throw new Error("fixture enqueue failed");
    }
    const high = await fixture.enqueue(deliveryTestInput(
      { createdAt: DELIVERY_TEST_TIME, priority: "high" },
      keyBody("high"),
    ));
    if (!high.accepted) throw new Error("fixture enqueue failed");
    const sent: string[] = [];
    const lifecycle = createDeliveryLifecycleTestBinding(fixture.authority);
    const pipeline = new AuthorityDeliveryPipeline({
      application: lifecycle.application,
      projection: lifecycle.projection,
      artifacts: fixture.artifacts,
      transport: recordingTransport(sent),
      eventBus: createEventBus<AuthorityDeliveryEventMap>(),
      config: { flushIntervalMs: 0 },
      now: fixture.now,
    });
    await pipeline.start();
    await pipeline.stop();
    expect(sent[0]).toBe(high.items[0]!.itemId);
    expect(sent).toHaveLength(41);
    await expect(fixture.authority.stats()).resolves.toMatchObject({ pending: 0, delivered: 41 });
  });

  it("reads only the requested revision range of one item's long notice history", async () => {
    const fixture = await createDeliveryTestHarness();
    const created = await fixture.enqueue(deliveryTestInput(
      { createdAt: DELIVERY_TEST_TIME, maxAttempts: 64 },
      keyBody("long-history"),
    ));
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    // 每轮：领取 → 再领取开出 uncertain（一条通知）→ 迟到的可重试失败关闭它并排期重试（一条通知）
    for (let round = 0; round < 12; round += 1) {
      const claim = await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
      if (claim.kind !== "send") throw new Error(`round ${round} claim was ${claim.kind}`);
      await expect(fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } }))
        .resolves.toMatchObject({ kind: "uncertain" });
      const outcome = await fixture.lifecycle.recordOutcome({
        itemId,
        attempt: claim.attempt,
        responseBindingDigest: claim.responseBindingDigest,
        outcome: { kind: "failed", error: { code: "unavailable", message: "busy", retryable: true } },
      });
      if (!outcome.accepted || !outcome.retryAt) throw new Error(`round ${round} retry was not scheduled`);
      fixture.setNow(outcome.retryAt);
    }
    const history = await fixture.authority.statusHistory(itemId, 0);
    expect(history).toHaveLength(24);
    const revisions = history.map(({ statusRevision }) => statusRevision);
    const tail = await fixture.authority.subjectHistory(
      [{ itemId, afterStatusRevision: revisions.at(-3)! }],
      8,
    );
    expect(tail.notices.map(({ statusRevision }) => statusRevision)).toEqual(revisions.slice(-2));
    expect(tail.next).toEqual([{ itemId, afterStatusRevision: revisions.at(-1)! }]);
    // 每个主体每页有上限，下一页从这一页的最后一条之后接着读
    const firstPage = await fixture.authority.subjectHistory([{ itemId, afterStatusRevision: 0 }], 8);
    expect(firstPage.notices.map(({ statusRevision }) => statusRevision)).toEqual(revisions.slice(0, 8));
    const secondPage = await fixture.authority.subjectHistory(firstPage.next, 8);
    expect(secondPage.notices.map(({ statusRevision }) => statusRevision)).toEqual(revisions.slice(8, 16));
  });

  it("pages global notices in commit order across concurrent commits and resets for another authority generation", async () => {
    const fixture = await createDeliveryTestHarness();
    const openUncertain = async (runId: string) => {
      const created = await fixture.enqueue(deliveryTestInput({ createdAt: fixture.now().toISOString() }, keyBody(runId)));
      if (!created.accepted) throw new Error("fixture enqueue failed");
      const itemId = created.items[0]!.itemId;
      await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
      await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
      return itemId;
    };
    // 前三条同一时刻提交：顺序取提交位置，不取时间
    const first = [await openUncertain("page-1"), await openUncertain("page-2"), await openUncertain("page-3")];
    const page1 = await fixture.authority.statusPage(undefined, 2);
    expect(page1).toMatchObject({ more: true, reset: false });
    // 两页之间又提交了一条，且时钟回拨：仍接在游标之后读到，不漏也不重
    fixture.setNow("2026-07-17T01:00:00.000Z");
    const late = await openUncertain("page-4");
    const page2 = await fixture.authority.statusPage(page1.next, 2);
    const page3 = await fixture.authority.statusPage(page2.next, 2);
    expect(page3).toMatchObject({ notices: [], more: false, reset: false, next: page2.next });
    expect([...page1.notices, ...page2.notices].map(({ ref }) => ref.itemId)).toEqual([...first, late]);

    // 另一锚定代次拿着旧游标：明确标出 reset 并从头读，不静默跳过
    const successor = new DeliveryAuthority({ log: fixture.log, anchorEpoch: 8 });
    const restarted = await successor.statusPage(page2.next, 2);
    expect(restarted.reset).toBe(true);
    expect(restarted.notices.map(({ ref }) => ref.itemId)).toEqual(first.slice(0, 2));
    await expect(fixture.authority.statusPage("dn1.not-a-cursor", 2)).rejects.toThrow("Delivery notice cursor is invalid");
  });

  it("lists current uncertain deliveries with their latest notice until they close", async () => {
    const fixture = await createDeliveryTestHarness();
    // 先有一段已结束的旧历史：新出现的 uncertain 不排在它们后面
    for (let index = 0; index < 3; index += 1) {
      const old = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody(`old-${index}`)));
      if (!old.accepted) throw new Error("fixture enqueue failed");
      const oldClaim = await fixture.lifecycle.claim({ itemId: old.items[0]!.itemId, outcomePolicy: { kind: "manual-resolution" } });
      if (oldClaim.kind !== "send") throw new Error("fixture claim failed");
      // 开出 uncertain 再由迟到的 sent 关闭：每个旧条目留下两条通知
      await fixture.lifecycle.claim({ itemId: old.items[0]!.itemId, outcomePolicy: { kind: "manual-resolution" } });
      await fixture.lifecycle.recordOutcome({
        itemId: old.items[0]!.itemId,
        attempt: oldClaim.attempt,
        responseBindingDigest: oldClaim.responseBindingDigest,
        outcome: { kind: "sent" },
      });
    }
    const created = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody("uncertain-list")));
    if (!created.accepted) throw new Error("fixture enqueue failed");
    const itemId = created.items[0]!.itemId;
    const claim = await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
    if (claim.kind !== "send") throw new Error("fixture claim failed");
    await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
    await expect(fixture.authority.uncertainNotices(undefined, 8)).resolves.toMatchObject({
      notices: [expect.objectContaining({ ref: { execution: "delivery", itemId }, state: "delivery-uncertain" })],
      more: false,
    });
    const firstPage = await fixture.authority.statusPage(undefined, 2);
    expect(firstPage.more).toBe(true);
    expect(firstPage.notices.some((notice) => notice.ref.itemId === itemId)).toBe(false);
    await fixture.lifecycle.recordOutcome({
      itemId,
      attempt: claim.attempt,
      responseBindingDigest: claim.responseBindingDigest,
      outcome: { kind: "sent" },
    });
    await expect(fixture.authority.uncertainNotices(undefined, 8)).resolves.toMatchObject({ notices: [], more: false });
  });

  it("pages every current uncertain delivery with a cursor that survives closures and new arrivals between pages", async () => {
    const fixture = await createDeliveryTestHarness();
    const openUncertain = async (runId: string) => {
      const created = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody(runId)));
      if (!created.accepted) throw new Error("fixture enqueue failed");
      const itemId = created.items[0]!.itemId;
      const claim = await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
      if (claim.kind !== "send") throw new Error("fixture claim failed");
      await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
      return { itemId, claim };
    };
    const opened = [];
    for (let index = 0; index < 5; index += 1) opened.push(await openUncertain(`uncertain-page-${index}`));
    const ids = (page: { readonly notices: readonly { readonly ref: { readonly execution: string } }[] }) =>
      page.notices.map(({ ref }) => (ref as { readonly itemId: string }).itemId);

    const page1 = await fixture.authority.uncertainNotices(undefined, 2);
    expect(page1).toMatchObject({ more: true, reset: false });
    expect(ids(page1)).toEqual([opened[0]!.itemId, opened[1]!.itemId]);
    // 两页之间：一条已读过的关闭、一条未读的关闭、一条新进入 uncertain
    for (const closed of [opened[0]!, opened[2]!]) {
      await fixture.lifecycle.recordOutcome({
        itemId: closed.itemId,
        attempt: closed.claim.attempt,
        responseBindingDigest: closed.claim.responseBindingDigest,
        outcome: { kind: "sent" },
      });
    }
    const late = await openUncertain("uncertain-page-late");
    const page2 = await fixture.authority.uncertainNotices(page1.next, 2);
    const page3 = await fixture.authority.uncertainNotices(page2.next, 2);
    expect([...ids(page2), ...ids(page3)]).toEqual([opened[3]!.itemId, opened[4]!.itemId, late.itemId]);
    expect(page3.more).toBe(false);
    // 读到末尾的游标之后再进入的也接得上
    const later = await openUncertain("uncertain-page-later");
    await expect(fixture.authority.uncertainNotices(page3.next, 2).then(ids)).resolves.toEqual([later.itemId]);

    // 另一锚定代次拿着旧游标：标出 reset 从头读；畸形游标拒绝
    const successor = new DeliveryAuthority({ log: fixture.log, anchorEpoch: 8 });
    const restarted = await successor.uncertainNotices(page2.next, 2);
    expect(restarted.reset).toBe(true);
    expect(ids(restarted)).toEqual([opened[1]!.itemId, opened[3]!.itemId]);
    await expect(fixture.authority.uncertainNotices("du1.not-a-cursor", 2)).rejects.toThrow("Delivery uncertain cursor is invalid");
    await expect(fixture.authority.uncertainNotices(page1.next.replace("du1.", "dn1."), 2)).rejects.toThrow("Delivery uncertain cursor is invalid");
  });

  it("keeps state counts equal to a recount of the items across every transition kind", async () => {
    const fixture = await createDeliveryTestHarness();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const created = await fixture.enqueue(deliveryTestInput({ createdAt: DELIVERY_TEST_TIME }, keyBody(`count-${index}`)));
      if (!created.accepted) throw new Error("fixture enqueue failed");
      ids.push(created.items[0]!.itemId);
    }
    const send = async (itemId: string) => {
      const claim = await fixture.lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
      if (claim.kind !== "send") throw new Error("fixture claim failed");
      return claim;
    };
    const sentClaim = await send(ids[0]!);
    await fixture.lifecycle.recordOutcome({
      itemId: ids[0]!, attempt: sentClaim.attempt, responseBindingDigest: sentClaim.responseBindingDigest,
      outcome: { kind: "sent" },
    });
    const retryClaim = await send(ids[1]!);
    await fixture.lifecycle.recordOutcome({
      itemId: ids[1]!, attempt: retryClaim.attempt, responseBindingDigest: retryClaim.responseBindingDigest,
      outcome: { kind: "failed", error: { code: "unavailable", message: "busy", retryable: true } },
    });
    const failedClaim = await send(ids[2]!);
    await fixture.lifecycle.recordOutcome({
      itemId: ids[2]!, attempt: failedClaim.attempt, responseBindingDigest: failedClaim.responseBindingDigest,
      outcome: { kind: "failed", error: { code: "invalid", message: "rejected", retryable: false } },
    });
    await send(ids[3]!);
    await fixture.lifecycle.claim({ itemId: ids[3]!, outcomePolicy: { kind: "manual-resolution" } });
    await send(ids[4]!);

    const states = await Promise.all(ids.map(async (id) => (await fixture.authority.get(id))!.state));
    expect(states).toEqual(["sent", "retry-wait", "failed", "uncertain", "attempting"]);
    const recount = (wanted: readonly string[]) => states.filter((state) => wanted.includes(state)).length;
    await expect(fixture.authority.stats()).resolves.toEqual({
      pending: recount(["queued", "retry-wait", "attempting", "uncertain"]),
      queued: recount(["queued"]),
      attempting: recount(["attempting"]),
      delivered: recount(["sent", "verified-sent"]),
      failed: recount(["failed", "abandoned"]),
      retrying: recount(["retry-wait"]),
      uncertain: recount(["uncertain"]),
    });
  });
});
