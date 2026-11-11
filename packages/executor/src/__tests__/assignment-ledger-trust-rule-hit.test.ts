// 规则命中随交互镜像链回到 owner 并在规则权威侧累计：真实执行端台账＋真实 owner 对话日志＋真实规则库。
import { createTempDir } from "@zhixing-ai/test-utils";
import { DurablePermissionRuleStore, GLOBAL_PERMISSION_BUCKET } from "@zhixing-ai/core/security";
import type { TrustSedimentFact } from "@zhixing-ai/core/contracts";
import { interactionMirrorBatchDigest } from "@zhixing-ai/core/protocol";
import { describe, expect, it } from "vitest";
import type { TrustRuleHitBatchInput, TrustRuleHitPort } from "@zhixing-ai/owner-kernel/conversation-assignment";
import { InProcessAssignmentSubmission } from "../assignment-ledger.js";
import {
  ASSIGNMENT_ID,
  DURABLE_IO_TEST_TIMEOUT_MS,
  NOW,
  createHarness,
  ownerContext,
  signedMirrorBatch,
  submissionContext,
} from "./assignment-ledger-fixture.js";

const RULE_ID = "rule-fetch";

/**
 * 测试端口：把命中写进真实规则库的全局桶，接纳与清理按“id＋内容＋本批”认领，与宿主实现同一
 * 语义（宿主另按指派范围选桶，这里只测 owner 的时序）。`store` 可以是取值函数，以模拟规则库重开。
 */
function storePort(storeOrGet: DurablePermissionRuleStore | (() => DurablePermissionRuleStore), options: {
  /** 第二次准备等到第一次接纳完成后才进行（复现“过时检查后重新准备”的交错）。 */
  raceSecondPrepare?: boolean;
  failPrepare?: number;
  /** 前 N 次接纳被跳过（模拟 owner 已提交、接纳前进程退出）。 */
  skipAccept?: number;
} = {}) {
  const storeOf = () => (typeof storeOrGet === "function" ? storeOrGet() : storeOrGet);
  let skips = options.skipAccept ?? 0;
  const calls: string[] = [];
  let prepares = 0;
  let failures = options.failPrepare ?? 0;
  let firstAccepted!: () => void;
  const accepted = new Promise<void>((resolve) => { firstAccepted = resolve; });
  const pending = (input: TrustRuleHitBatchInput) => input.entries.map((entry) => ({
    id: `${input.assignmentId}/${entry.requestId}`,
    ruleId: entry.hit.ruleId,
    at: Date.parse(entry.at),
    digest: `${entry.hit.ruleId}:${entry.seq}`,
    assignmentId: input.assignmentId,
    batchDigest: input.batchDigest,
  }));
  const port: TrustRuleHitPort = {
    async prepare(input) {
      prepares += 1;
      calls.push(`prepare:${input.entries.map((entry) => entry.requestId).join(",")}`);
      if (failures > 0) {
        failures -= 1;
        throw new Error("permission store unavailable");
      }
      if (options.raceSecondPrepare) {
        // 第一次准备稍作停留，让另一投递有机会完成“是否已提交”的检查；第二次等第一次接纳完
        if (prepares === 1) await new Promise((resolve) => setTimeout(resolve, 50));
        else await accepted;
      }
      await storeOf().prepareHits(GLOBAL_PERMISSION_BUCKET, pending(input));
    },
    async accept(input) {
      calls.push(`accept:${input.entries.map((entry) => entry.requestId).join(",")}`);
      if (skips > 0) {
        skips -= 1;
        return;
      }
      await storeOf().acceptHits(GLOBAL_PERMISSION_BUCKET, pending(input));
      firstAccepted();
    },
    async discard(input) {
      calls.push(`discard:${input.entries.map((entry) => entry.requestId).join(",")}`);
      await storeOf().discardHits(GLOBAL_PERMISSION_BUCKET, pending(input));
    },
  };
  return { port, calls };
}

async function ruleStore(): Promise<DurablePermissionRuleStore> {
  const store = new DurablePermissionRuleStore(await createTempDir("trust-rule-hit-owner"));
  await store.addGlobalRule({
    id: RULE_ID,
    pattern: { tool: "web_fetch", argument: "*" },
    decision: "allow",
    scope: "global",
    createdAt: 1,
    lastMatchedAt: 0,
    matchCount: 0,
  });
  return store;
}

const count = (store: DurablePermissionRuleStore) => store.global().find((rule) => rule.id === RULE_ID)?.matchCount;

async function startedHarness(port: TrustRuleHitPort) {
  const harness = await createHarness({ trustRuleHits: port });
  await harness.ledger.dispatch(
    harness.dispatch.envelope,
    harness.dispatch.activation,
    ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
  );
  await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
  const adapter = new InProcessAssignmentSubmission({ ledger: harness.ledger, owner: harness.journal });
  await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
  return { harness, adapter };
}

describe("trust rule hit mirror lane", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("rides the mirror chain: prepared before the owner commit, counted after; replay does not count again", async () => {
    const store = await ruleStore();
    const { port, calls } = storePort(store);
    const { harness, adapter } = await startedHarness(port);

    await expect(harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: RULE_ID }))
      .resolves.toMatchObject({ requestId: "trust-rule-hit:1" });
    // 只记台账，不单独冲刷：计数要等既有镜像冲刷
    expect(count(store)).toBe(0);
    const batch = await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID);
    expect(batch?.entries).toMatchObject([{ kind: "trust-rule-hit", requestId: "trust-rule-hit:1", hit: { ruleId: RULE_ID } }]);

    await adapter.flushInteractionMirrors(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    expect(calls).toEqual(["prepare:trust-rule-hit:1", "accept:trust-rule-hit:1"]);
    expect(count(store)).toBe(1);
    await expect(harness.journal.trustRuleHitBatchState(ASSIGNMENT_ID, batchDigestOf(batch!)))
      .resolves.toBe("committed");
    // 规则命中不是交互
    await expect(harness.journal.interactionOutcome("trust-rule-hit:1")).resolves.toBeUndefined();

    // 回执丢失后的同批重放：不重新准备，接纳时已无记录可计
    await harness.journal.mirrorInteractions(ASSIGNMENT_ID, batch!, submissionContext(harness.unsigned));
    expect(calls).toEqual(["prepare:trust-rule-hit:1", "accept:trust-rule-hit:1", "accept:trust-rule-hit:1"]);
    expect(count(store)).toBe(1);
  });

  it("concurrent delivery of the same batch counts once (stale check cannot re-prepare after acceptance)", async () => {
    const store = await ruleStore();
    const { port, calls } = storePort(store, { raceSecondPrepare: true });
    const { harness } = await startedHarness(port);
    await harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: RULE_ID });
    const batch = (await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID))!;

    const context = submissionContext(harness.unsigned);
    await Promise.all([
      harness.journal.mirrorInteractions(ASSIGNMENT_ID, batch, context),
      harness.journal.mirrorInteractions(ASSIGNMENT_ID, batch, context),
    ]);
    expect(count(store)).toBe(1);
    expect(calls.filter((call) => call.startsWith("prepare:"))).toHaveLength(1);
  });

  it("does not commit the batch when preparing fails; the next flush counts it once", async () => {
    const store = await ruleStore();
    const { port, calls } = storePort(store, { failPrepare: 1 });
    const { harness, adapter } = await startedHarness(port);
    await harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: RULE_ID });
    const batch = (await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID))!;

    await expect(adapter.flushInteractionMirrors(ASSIGNMENT_ID, submissionContext(harness.unsigned)))
      .rejects.toThrow("permission store unavailable");
    await expect(harness.journal.trustRuleHitBatchState(ASSIGNMENT_ID, batchDigestOf(batch)))
      .resolves.toBe("unknown");
    expect(count(store)).toBe(0);

    await adapter.flushInteractionMirrors(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    expect(calls).toEqual(["prepare:trust-rule-hit:1", "prepare:trust-rule-hit:1", "accept:trust-rule-hit:1"]);
    expect(count(store)).toBe(1);
  });

  it("interleaves with sediments on one chain: identities and ordinals stay contiguous", async () => {
    const store = await ruleStore();
    const { port } = storePort(store);
    const { harness, adapter } = await startedHarness(port);
    const sediment: TrustSedimentFact = {
      pattern: { tool: "bash", argument: "npm install *" },
      riskLevel: "medium",
      operation: { tool: "bash", arguments: { command: "npm install left-pad" } },
      contributors: [{ origin: "steward", timestamp: 1 }, { origin: "steward", timestamp: 2 }, { origin: "steward", timestamp: 3 }],
    };
    await harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: RULE_ID });
    await harness.ledger.recordTrustSediment(ASSIGNMENT_ID, sediment);
    await harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: RULE_ID });
    const batch = (await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID))!;
    expect(batch.entries.map((entry) => [entry.kind, entry.requestId, entry.ordinal])).toEqual([
      ["trust-rule-hit", "trust-rule-hit:1", 1],
      ["trust-sediment", "trust-sediment:1", 2],
      ["trust-rule-hit", "trust-rule-hit:2", 3],
    ]);
    await adapter.flushInteractionMirrors(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    expect(count(store)).toBe(2);
  });

  it("a rejected batch reusing a committed hit cannot rebind or delete its recovery record (review R3 counterexample)", async () => {
    let store = await ruleStore();
    const rootDir = store.rootDir!;
    const { port, calls } = storePort(() => store, { skipAccept: 1 });
    const { harness } = await startedHarness(port);
    await harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: RULE_ID });
    const batchA = (await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID))!;
    const context = submissionContext(harness.unsigned);
    // A 由真实台账生成并被真实日志提交；接纳前进程退出（跳过一次接纳），规则库随后重开
    await harness.journal.mirrorInteractions(ASSIGNMENT_ID, batchA, context);
    await expect(harness.journal.trustRuleHitBatchState(ASSIGNMENT_ID, batchDigestOf(batchA))).resolves.toBe("committed");
    store = new DurablePermissionRuleStore(rootDir);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toHaveLength(1);
    // 错误的有效执行方：正确签名，声称接续 A，却复用 A 的命中身份与序号（正常台账不会产生）
    const batchB = signedMirrorBatch(harness.identity, [{ ...batchA.entries[0]!, ordinal: 2 }], {
      previousDigest: batchA.mirrorDigest,
    });
    await expect(harness.journal.mirrorInteractions(ASSIGNMENT_ID, batchB, context)).rejects.toThrow(/durable audit prefix/);
    // 被拒绝的 B 没有准备、也没有清理：A 的恢复记录原样保留
    expect(calls.filter((call) => call.startsWith("prepare:") || call.startsWith("discard:"))).toEqual(["prepare:trust-rule-hit:1"]);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET).map((entry) => entry.batchDigest)).toEqual([batchDigestOf(batchA)]);
    // A 的重放补做接纳：计 1
    await harness.journal.mirrorInteractions(ASSIGNMENT_ID, batchA, context);
    expect(count(store)).toBe(1);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toEqual([]);
  });

  it("rejects hits from an assignment that has not started", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await expect(harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: RULE_ID }))
      .rejects.toThrow(/started assignment/u);
  });

  it("validates hit facts on the wire", async () => {
    const store = await ruleStore();
    const { port } = storePort(store);
    const { harness } = await startedHarness(port);
    await expect(harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: "" }))
      .rejects.toThrow();
    await expect(harness.ledger.recordTrustRuleHit(ASSIGNMENT_ID, { ruleId: RULE_ID, extra: true } as never))
      .rejects.toThrow();
    expect(NOW).toBeTruthy();
  });
});

function batchDigestOf(batch: Parameters<typeof interactionMirrorBatchDigest>[0]): string {
  return interactionMirrorBatchDigest(batch);
}
