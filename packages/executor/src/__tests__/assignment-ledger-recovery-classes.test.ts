import { describe, expect, it, vi } from "vitest";
import { dispatchEnvelopeArtifact } from "@zhixing-ai/core/protocol";
import { ASSIGNMENT_ID, CONVERSATION_ID, NOW, createAlternativeDispatch, createFormalReceiptHarness, createHarness, ownerContext } from "./assignment-ledger-fixture.js";

// 恢复候选行带同一提交写下的分类：列表先排除分类上确定不属于本类的候选，不为它们冷重放、不验签；
// 属于本类的候选仍按原条件完整核对，制品缺失等错误照原合同报告
async function receivedCandidate(renewals: number) {
  let clockMs = Date.parse(NOW), mono = 0;
  const h = await createFormalReceiptHarness({ clock: () => new Date(clockMs).toISOString(), monotonicClock: () => mono, startupProofs: true });
  await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
  for (let n = 2; n <= renewals; n++) {
    clockMs += 20_000; mono += 20_000;
    await h.ledger.queryLedger(ASSIGNMENT_ID, ownerContext(ASSIGNMENT_ID, "executor.queryLedger", CONVERSATION_ID,
      { renewalSeq: n, issuedAt: new Date(clockMs).toISOString(), expiry: new Date(clockMs + 60_000).toISOString() }));
  }
  return h;
}

async function coldVerifications(h: Awaited<ReturnType<typeof receivedCandidate>>, list: "assignments" | "cancellations") {
  const spy = vi.spyOn(h.identity, "verify");
  try {
    const cold = h.reopen().ledger;
    // 只量列表本身：当前资源回执的核对是另一条路径，单独计量
    vi.spyOn(cold, "reconcileSupersededReceipts").mockResolvedValue(0);
    const result = list === "assignments"
      ? await cold.recoverableConversationAssignments()
      : await cold.recoverableConversationCancellations();
    const verifications = spy.mock.calls.length;
    // 本实例的决定状态立即写完：后续计量面对确定的检查点状态，不依赖合并定时器
    await cold.flushDecisionStates();
    return { result, verifications };
  } finally { spy.mockRestore(); }
}

const listError = (h: Awaited<ReturnType<typeof receivedCandidate>>) =>
  h.reopen().ledger.recoverableConversationAssignments().then(() => "listed", (error: Error) => error.message);

describe("assignment ledger recovery classes", () => {
  it.each([2, 8, 20])("skips a candidate of another class without replaying its history (%i renewals)", async (renewals) => {
    const h = await receivedCandidate(renewals);
    const listed = await coldVerifications(h, "cancellations");
    expect(listed.result).toEqual([]);
    expect(listed.verifications).toBe(0);
  }, 30_000);

  it("lists a candidate of the requested class with work that does not grow with its history", async () => {
    const counts: number[] = [];
    for (const renewals of [2, 8, 20]) {
      const h = await receivedCandidate(renewals);
      // 先让一次严格冷恢复写下决定状态，再在新实例上计量列表
      await coldVerifications(h, "assignments");
      const listed = await coldVerifications(h, "assignments");
      expect(listed.result).toHaveLength(1);
      expect(listed.result[0]).toEqual(h.envelope);
      // 命中项只校验信封本身（签名、执行端、制品在场），不重放续租历史
      expect(listed.verifications).toBeGreaterThan(0);
      counts.push(listed.verifications);
    }
    expect(new Set(counts).size).toBe(1);
  }, 120_000);

  it("checks current resource receipts without replaying started assignments", async () => {
    const counts: number[] = [];
    for (const renewals of [2, 8, 20]) {
      const h = await receivedCandidate(renewals);
      await h.ledger.start(ASSIGNMENT_ID);
      const spy = vi.spyOn(h.identity, "verify");
      try {
        const cold = h.reopen().ledger;
        expect(await cold.reconcileSupersededReceipts()).toBe(0);
        counts.push(spy.mock.calls.length);
      } finally { spy.mockRestore(); }
    }
    expect(counts).toEqual([0, 0, 0]);
  }, 120_000);

  it("reports a missing artifact for a candidate of the requested class but not for another class", async () => {
    const h = await receivedCandidate(2);
    const cold = h.reopen().ledger;
    const get = vi.spyOn(h.artifacts, "get").mockRejectedValue(new Error("artifact missing"));
    try {
      await expect(cold.recoverableConversationCancellations()).resolves.toEqual([]);
      await expect(cold.recoverableConversationAssignments()).rejects.toThrow("artifact missing");
    } finally { get.mockRestore(); }
  }, 30_000);

  it("re-validates a tail appended after the decision state instead of listing the stale state", async () => {
    const h = await receivedCandidate(3);
    await coldVerifications(h, "assignments");
    // 合法前缀之后追加一条协议形态成立、能进分类的续租，但缺少它的精确时钟伴随：严格校验拒绝
    const ctx = ownerContext(ASSIGNMENT_ID, "executor.queryLedger", CONVERSATION_ID,
      { renewalSeq: 9, issuedAt: new Date(Date.parse(NOW) + 200_000).toISOString(), expiry: new Date(Date.parse(NOW) + 260_000).toISOString() });
    if (ctx.principal.kind !== "owner-control") throw new Error("fixture principal");
    const records = await h.log.readStream<{ recordSeq: number }>(`assignment:${ASSIGNMENT_ID}`);
    await h.log.append<unknown>([{ stream: `assignment:${ASSIGNMENT_ID}`, body: { recordSeq: records.at(-1)!.body.recordSeq + 1,
      body: { v: 3, t: "control-lease-renewed", effectiveAcceptedAt: new Date(Date.parse(NOW) + 200_000).toISOString(), lease: ctx.principal.grant.controlLease } } }]);
    const fromDecision = await listError(h);
    for (const key of await h.log.listProjectionCheckpointKeys("executor-assignment-decision")) await h.log.deleteProjectionCheckpoint(key);
    const fromFullReplay = await listError(h);
    expect(fromDecision).toBe(fromFullReplay);
    expect(fromDecision).toContain("Lease acceptance is missing its exact durable time companion");
  }, 60_000);

  it.each([
    ["missing its resource receipt companion", "formal", "Executor resource receipt records are incomplete or conflicting"],
    ["whose activation does not bind its envelope", "plain", "does not bind the dispatch"],
  ] as const)("rejects a hit without strict proof %s at the original strict check", async (_name, kind, expected) => {
    const formal = kind === "formal" ? await createFormalReceiptHarness({ startupProofs: true, monotonicClock: () => 0 }) : undefined;
    const h = formal ?? await createHarness();
    const envelope = formal ? formal.envelope : h.dispatch.envelope;
    const alternative = createAlternativeDispatch(h);
    // 没有严格证明的命中：协议形态成立、能进分类；正式派发缺资源回执伴随，普通派发的激活来自另一份派发
    const artifact = dispatchEnvelopeArtifact(envelope);
    await h.artifacts.put(artifact.bytes);
    await h.artifacts.put(dispatchEnvelopeArtifact(alternative.envelope).bytes);
    await h.log.append<unknown>([
      { stream: `assignment:${ASSIGNMENT_ID}`, body: { recordSeq: 1, body: { v: 1, t: "control-lease-renewed", lease: envelope.controlLease } } },
      { stream: `assignment:${ASSIGNMENT_ID}`, body: { recordSeq: 2, body: { v: 1, t: "received",
        envelope: { ref: artifact.ref }, activation: formal ? formal.activation : alternative.activation } } },
    ]);
    const ledger = formal ? formal.reopen().ledger : h.ledger;
    const listed = await ledger.recoverableConversationAssignments().then(() => "listed", (error: Error) => error.message);
    expect(listed).toContain(expected);
  }, 60_000);
});
