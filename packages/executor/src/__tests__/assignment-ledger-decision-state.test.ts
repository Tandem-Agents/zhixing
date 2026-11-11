import { captureFileIo, defaultFileIoCategory } from "@zhixing-ai/test-utils";
import { validateLedgerEvidencePage } from "@zhixing-ai/core/protocol";
import type { LedgerEvidencePage } from "@zhixing-ai/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { ASSIGNMENT_ID, CONVERSATION_ID, NOW, allowOnceDecisionDigest, createFormalReceiptHarness, mirrorReceipt, ownerContext } from "./assignment-ledger-fixture.js";

// 分派的严格决定状态：冷恢复从经认证的决定状态起只追平之后的尾部，工作量不随续租历史、也不随已了结的
// 交互与副作用增长；已完成历史按键取，结果与完整重放一致；仍依赖的制品照常核对；需要更早历史的证据页与
// 交互流事件另行完整重放
type Harness = Awaited<ReturnType<typeof createFormalReceiptHarness>>;
type CompletedHarness = Awaited<ReturnType<typeof withCompletedHistory>>;

async function withHistory(renewals: number) {
  let clockMs = Date.parse(NOW), mono = 0;
  const h = await createFormalReceiptHarness({ clock: () => new Date(clockMs).toISOString(), monotonicClock: () => mono, startupProofs: true });
  await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
  await h.ledger.start(ASSIGNMENT_ID);
  let ctx = ownerContext(ASSIGNMENT_ID, "executor.queryLedger");
  for (let n = 2; n <= renewals; n++) {
    clockMs += 20_000; mono += 20_000;
    ctx = ownerContext(ASSIGNMENT_ID, "executor.queryLedger", CONVERSATION_ID,
      { renewalSeq: n, issuedAt: new Date(clockMs).toISOString(), expiry: new Date(clockMs + 60_000).toISOString() });
    await h.ledger.queryLedger(ASSIGNMENT_ID, ctx);
  }
  await h.ledger.flushDecisionStates();
  return { h, ctx };
}

const request = (requestId: string) => ({
  requestId, toolName: "write-file", display: { title: "Write", lines: [`workspace/${requestId}.md`] },
  issuedAt: NOW, ttlMs: 60_000, expiresAt: "2026-07-13T09:01:00.000Z",
});
const answer = (requestId: string) => ({
  t: "answered" as const, authority: { via: "surface-ticket" as const, ticketId: `ticket-${requestId}` },
  decision: { allowed: true, reason: "" }, decisionDigest: allowOnceDecisionDigest(requestId), by: "surface:user-1",
});
const effect = { kind: "external-call", toolName: "calendar.create", summary: "create calendar event", target: "external-service" } as const;

/** 已完成 completed 个交互（逐个镜像）与同数副作用，另有 1 个未结请求作为固定的当前义务。 */
async function withCompletedHistory(completed: number) {
  const h = await createFormalReceiptHarness({ startupProofs: true, monotonicClock: () => 0 });
  await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
  await h.ledger.start(ASSIGNMENT_ID);
  const receipts: ReturnType<typeof mirrorReceipt>[] = [];
  for (let index = 0; index < completed; index++) {
    await h.ledger.requestInteraction(ASSIGNMENT_ID, request(`done-${index}`));
    await h.ledger.finishInteraction(ASSIGNMENT_ID, `done-${index}`, answer(`done-${index}`));
    const batch = (await h.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID))!;
    receipts.push(mirrorReceipt(batch));
    await h.ledger.markInteractionsMirrored(ASSIGNMENT_ID, receipts.at(-1)!);
    const { effectSeq } = await h.ledger.startSideEffect(ASSIGNMENT_ID, effect);
    await h.ledger.completeSideEffect(ASSIGNMENT_ID, effectSeq, { status: "ok" });
  }
  await h.ledger.requestInteraction(ASSIGNMENT_ID, request("pending-1"));
  await h.ledger.flushDecisionStates();
  const io = await captureFileIo(h.root, relative => {
    const category = defaultFileIoCategory(relative);
    if (category !== "projection") return category;
    const parts = relative.split("/");
    const file = parts.at(-1) ?? "";
    return `projection/${parts[parts.indexOf("projections") + 1] ?? "unknown"}/${file.endsWith(".offsets") ? "offsets" : file.endsWith(".data") ? "data" : file}`;
  });
  return { ...h, receipts, io };
}

async function deleteDecisionStates(h: Harness) {
  for (const key of await h.log.listProjectionCheckpointKeys("executor-assignment-decision")) await h.log.deleteProjectionCheckpoint(key);
}

/** 冷实例上一次恢复的读取与验签：检查点字节、日志、帧索引与总读量。 */
async function coldCost(h: CompletedHarness, probe: (ledger: Harness["ledger"]) => Promise<unknown>) {
  const { io } = h;
  const verify = vi.spyOn(h.identity, "verify");
  try {
    const cold = h.reopen().ledger;
    io.reset();
    const value = await probe(cold);
    const snapshot = io.snapshot();
    // 本实例待落盘的决定状态立即写完：之后删除检查点的对照不受合并定时器影响
    await cold.flushDecisionStates();
    return { value, verifies: verify.mock.calls.length, probes: snapshot.segmentEntryProbes,
      checkpoint: snapshot.byCategory.checkpoint?.readBytes ?? 0,
      checkpointReads: snapshot.byCategory.checkpoint?.reads ?? 0, log: snapshot.byCategory.log?.readBytes ?? 0,
      frameIndex: snapshot.byCategory["frame-index"]?.readBytes ?? 0, readBytes: snapshot.readBytes };
  } finally { verify.mockRestore(); }
}

/** 把日志里该分派某条已提交的交互请求原样再追加一次（下一个记录序号），构造重复使用。 */
async function appendDuplicateRequest(h: Harness, requestId: string) {
  const records = await h.log.readStream<{ recordSeq: number; body: { t: string; requestId?: string } }>(`assignment:${ASSIGNMENT_ID}`);
  const original = records.find(record => record.body.body.t === "interaction-requested" && record.body.body.requestId === requestId)!;
  const last = records.at(-1)!.body.recordSeq;
  await h.log.append([{ stream: `assignment:${ASSIGNMENT_ID}`, body: { ...original.body, recordSeq: last + 1 } }]);
}

describe("assignment ledger decision state", () => {
  it("recovers a cold assignment with work that does not grow with its renewal history", async () => {
    const counts: number[] = [];
    for (const renewals of [2, 8, 20]) {
      const { h, ctx } = await withHistory(renewals);
      const spy = vi.spyOn(h.identity, "verify");
      try {
        const cold = h.reopen().ledger;
        expect((await cold.queryLedger(ASSIGNMENT_ID, ctx) as { phase: string }).phase).toBe("started");
        counts.push(spy.mock.calls.length);
      } finally { spy.mockRestore(); }
    }
    expect(new Set(counts).size).toBe(1);
  }, 120_000);

  it("keeps checkpoint bytes, reads and verification constant while completed interactions and side effects grow", async () => {
    const rows: { completed: number; first: Awaited<ReturnType<typeof coldCost>>; restored: Awaited<ReturnType<typeof coldCost>> }[] = [];
    // 2 档时领域索引还在内存；128 与 512 档都已填满增量段（基段 + 至多 4 个增量段），二者之比只剩基段深度
    for (const completed of [2, 128, 512]) {
      const h = await withCompletedHistory(completed);
      const pending = (ledger: Harness["ledger"]) => ledger.pendingInteractionRequests(ASSIGNMENT_ID);
      const restored = await coldCost(h, pending);
      // 首次无检查点（旧资料第一次启动的情形）：完整重放，读量随历史增长，作为对照
      await deleteDecisionStates(h);
      const first = await coldCost(h, pending);
      expect(restored.value).toEqual(first.value);
      expect((restored.value as readonly { request: { requestId: string } }[]).map(item => item.request.requestId)).toEqual(["pending-1"]);
      rows.push({ completed, first, restored });
    }
    console.log(JSON.stringify(rows.map(({ completed, first, restored }) => ({ completed,
      first: { verifies: first.verifies, checkpoint: first.checkpoint, readBytes: first.readBytes },
      restored: { verifies: restored.verifies, checkpoint: restored.checkpoint, checkpointReads: restored.checkpointReads, log: restored.log,
        readBytes: restored.readBytes, probes: restored.probes } }))));
    for (const row of rows) {
      expect(row.restored.checkpointReads).toBe(1);
      expect(row.restored.frameIndex).toBe(0);
      expect(row.first.checkpoint).toBe(0);
    }
    const [small, mid, large] = rows;
    // 决定状态只差计数与序号的位数；验签与日志读取不变
    expect(large!.restored.checkpoint).toBeLessThanOrEqual(small!.restored.checkpoint + 64);
    expect(large!.restored.verifies).toBe(small!.restored.verifies);
    expect(large!.restored.log).toBe(small!.restored.log);
    // 其余读取只随领域索引的段深度（落段后每次按键查找的二分探测），不随已完成历史线性增长
    expect(large!.restored.readBytes).toBeLessThanOrEqual(mid!.restored.readBytes * 1.5);
    expect(large!.restored.probes).toBeLessThanOrEqual(mid!.restored.probes * 1.5);
    // 对照：完整重放随历史增长
    expect(large!.first.readBytes).toBeGreaterThan(mid!.first.readBytes * 3);
  }, 600_000);

  it("answers completed history by key exactly as a full replay does", async () => {
    const h = await withCompletedHistory(3);
    const probe = async (ledger: Harness["ledger"]) => ({
      repeated: await ledger.requestInteraction(ASSIGNMENT_ID, request("done-1")),
      outcome: await ledger.conversationInteractionOutcome(ASSIGNMENT_ID, "done-1"),
      finished: await ledger.finishInteraction(ASSIGNMENT_ID, "done-1", answer("done-1")),
      conflicting: await ledger.finishInteraction(ASSIGNMENT_ID, "done-1", answer("done-2")).then(() => "accepted", (error: Error) => error.message),
      effect: await ledger.completeSideEffect(ASSIGNMENT_ID, 2, { status: "ok" }).then(() => "accepted", (error: Error) => error.message),
      // 早于已省去前缀的镜像回执照原样被接受为已镜像
      staleMirror: await ledger.markInteractionsMirrored(ASSIGNMENT_ID, h.receipts[0]!).then(() => "accepted", (error: Error) => error.message),
      events: await ledger.interactionStreamEvents(ASSIGNMENT_ID),
      laterEvents: await ledger.interactionStreamEvents(ASSIGNMENT_ID, Number.MAX_SAFE_INTEGER),
    });
    const keyedLedger = h.reopen().ledger;
    const keyed = await probe(keyedLedger);
    await keyedLedger.flushDecisionStates();
    await deleteDecisionStates(h);
    const full = await probe(h.reopen().ledger);
    expect(keyed).toEqual(full);
    expect(keyed.conflicting).toBe("Interaction requestId already has a different terminal result");
    expect(keyed.effect).toBe("accepted");
    expect(keyed.staleMirror).toBe("accepted");
    expect(keyed.events.length).toBe(7);
    // 下一副作用序号接在全部副作用之后
    expect(await h.reopen().ledger.startSideEffect(ASSIGNMENT_ID, effect)).toEqual({ effectSeq: 4 });
  }, 120_000);

  it("rejects a request id reused after the decision state exactly where and why a full replay does", async () => {
    const h = await withCompletedHistory(2);
    await appendDuplicateRequest(h, "done-0");
    const keyed = await h.reopen().ledger.pendingInteractionRequests(ASSIGNMENT_ID).then(() => "accepted", (error: Error) => error.message);
    await deleteDecisionStates(h);
    const full = await h.reopen().ledger.pendingInteractionRequests(ASSIGNMENT_ID).then(() => "accepted", (error: Error) => error.message);
    expect(keyed).toBe(full);
    expect(keyed).toContain("interaction requestId is duplicated");
  }, 120_000);

  it("accepts a first use in the tail and rejects a repeat within the tail", async () => {
    const h = await withCompletedHistory(2);
    const cold = h.reopen().ledger;
    // 尾部首次：决定状态之后才第一次使用的 ID 被接受（追加失败不占用 ID：失败后同一 ID 仍可首次使用）
    const write = vi.spyOn(h.log, "transactProjection").mockRejectedValueOnce(new Error("append failed"));
    await expect(cold.requestInteraction(ASSIGNMENT_ID, request("tail-1"))).rejects.toThrow("append failed");
    write.mockRestore();
    await expect(cold.requestInteraction(ASSIGNMENT_ID, request("tail-1"))).resolves.toMatchObject({ accepted: true });
    // 另一实例写入的尾部首次使用：新冷实例从写入之前的决定状态起，经预取接受。之后该实例的决定状态写完再继续
    const other = h.reopen().ledger;
    await expect(other.pendingInteractionRequests(ASSIGNMENT_ID)).resolves.toHaveLength(2);
    await cold.flushDecisionStates();
    await other.flushDecisionStates();
    // 尾部内重复：拒绝原因与完整重放一致
    await appendDuplicateRequest(h, "tail-1");
    const keyedLedger = h.reopen().ledger;
    const keyed = await keyedLedger.pendingInteractionRequests(ASSIGNMENT_ID).then(() => "accepted", (error: Error) => error.message);
    await keyedLedger.flushDecisionStates();
    await deleteDecisionStates(h);
    const full = await h.reopen().ledger.pendingInteractionRequests(ASSIGNMENT_ID).then(() => "accepted", (error: Error) => error.message);
    expect(keyed).toBe(full);
    expect(keyed).toContain("interaction requestId is duplicated");
  }, 120_000);

  it("still reports a referenced artifact that is no longer present", async () => {
    const { h, ctx } = await withHistory(4);
    const cold = h.reopen().ledger;
    const get = vi.spyOn(h.artifacts, "get").mockRejectedValue(new Error("artifact missing"));
    try { await expect(cold.queryLedger(ASSIGNMENT_ID, ctx)).rejects.toThrow("artifact missing"); }
    finally { get.mockRestore(); }
  }, 60_000);

  it("serves evidence pages before the decision state from the full history", async () => {
    const { h, ctx } = await withHistory(6);
    const fromFull = await h.ledger.queryLedger(ASSIGNMENT_ID, ctx, { fromSeq: 1, limit: 4 });
    const cold = h.reopen().ledger;
    const fromRestored = await cold.queryLedger(ASSIGNMENT_ID, ctx, { fromSeq: 1, limit: 4 });
    // 测试签名器带递增序号，签名本身每次不同；页内记录、范围与链摘要必须逐项一致
    const { signature: _a, ...restored } = fromRestored as { signature: unknown };
    const { signature: _b, ...full } = fromFull as { signature: unknown };
    expect(restored).toEqual(full);
  }, 60_000);

  it("signs evidence pages that start in the tail after the decision state exactly as the full view does", async () => {
    const { h, ctx } = await withHistory(3);
    const covered = (await h.log.readStream<{ recordSeq: number }>(`assignment:${ASSIGNMENT_ID}`)).at(-1)!.body.recordSeq;
    // 决定状态覆盖到 covered；之后再追加副作用的开始与完成，冷实例从决定状态起只归约这段尾部
    const { effectSeq } = await h.ledger.startSideEffect(ASSIGNMENT_ID, effect);
    await h.ledger.completeSideEffect(ASSIGNMENT_ID, effectSeq, { status: "ok" });
    const cold = h.reopen().ledger;
    for (const range of [{ fromSeq: covered + 1, limit: 1 }, { fromSeq: covered + 2, limit: 1 }, { fromSeq: covered + 1, limit: 2 }, { fromSeq: covered - 1, limit: 3 }]) {
      const full = await h.ledger.queryLedger(ASSIGNMENT_ID, ctx, range) as LedgerEvidencePage;
      const restored = await cold.queryLedger(ASSIGNMENT_ID, ctx, range) as LedgerEvidencePage;
      expect(validateLedgerEvidencePage(restored, h.identity).chainDigest).toBe(full.chainDigest);
      const { signature: _a, ...restoredBody } = restored;
      const { signature: _b, ...fullBody } = full;
      expect(restoredBody).toEqual(fullBody);
    }
    // 尾部最后一条就是当前链头
    expect(((await cold.queryLedger(ASSIGNMENT_ID, ctx)) as { lastSeq: number }).lastSeq).toBe(covered + 2);
  }, 60_000);

  it("falls back to a full replay when no decision state is available", async () => {
    const { h, ctx } = await withHistory(8);
    await deleteDecisionStates(h);
    const spy = vi.spyOn(h.identity, "verify");
    try {
      const cold = h.reopen().ledger;
      expect((await cold.queryLedger(ASSIGNMENT_ID, ctx) as { phase: string }).phase).toBe("started");
      expect(spy.mock.calls.filter(call => call[0] === "ControlLease").length).toBeGreaterThanOrEqual(8);
    } finally { spy.mockRestore(); }
  }, 60_000);
});
