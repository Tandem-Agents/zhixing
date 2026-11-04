/**
 * 旧格式分派转入按键路径：领域索引由本格式之前的归约器写下（没有按键历史行与标记），当前账本冷开时完整严格
 * 重放一次并写出旧前缀历史，之后的冷开只读按键化的小决定状态，历史随用随取，结果与完整重放一致：
 * - 迁移前开始、迁移后才结束或才镜像的业务，开始取自旧前缀历史、结束取自领域索引，组合后照常回答；
 * - 旧前缀历史只在证实写成（同一游标、同一代次）后才被公布；缺失或旧代都不把缺键当作首次使用。
 */
import path from "node:path";
import { AuthorityCacheIntegrity, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { captureFileIo, defaultFileIoCategory } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ConversationAssignmentLedger } from "../assignment-ledger.js";
import { ExecutorResourceGovernor } from "../resource-governor.js";
import {
  ASSIGNMENT_ID, EXECUTOR_ID, NOW, allowOnceDecisionDigest, createFormalReceiptHarness, matchingPermissionSnapshotFor,
  matchingSnapshotFor, mirrorReceipt, ownerContext, ownerControl,
} from "./assignment-ledger-fixture.js";

// 领域索引的注册按开关切换：生成资料时用旧归约器，冷开验证时用当前归约器（同一投影身份与版本，资料原样沿用）
const mode = vi.hoisted(() => ({ legacy: false }));
vi.mock("../assignment-ledger-index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../assignment-ledger-index.js")>();
  const legacy = await import("./assignment-ledger-index-legacy-fixture.js");
  return { ...actual, registerAssignmentLedgerIndex: (...args: Parameters<typeof actual.registerAssignmentLedgerIndex>) =>
    mode.legacy ? legacy.registerAssignmentLedgerIndex(...args) : actual.registerAssignmentLedgerIndex(...args) };
});

const DECISION = "executor-assignment-decision";
const LEGACY = "executor-assignment-legacy-history";

const request = (requestId: string) => ({
  requestId, toolName: "write-file", display: { title: "Write", lines: [`workspace/${requestId}.md`] },
  issuedAt: NOW, ttlMs: 60_000, expiresAt: "2026-07-13T09:01:00.000Z",
});
const answer = (requestId: string, ticket = requestId) => ({
  t: "answered" as const, authority: { via: "surface-ticket" as const, ticketId: `ticket-${ticket}` },
  decision: { allowed: true, reason: "" }, decisionDigest: allowOnceDecisionDigest(requestId), by: "surface:user-1",
});
const effect = { kind: "external-call", toolName: "calendar.create", summary: "create calendar event", target: "external-service" } as const;
const outcome = <T>(work: Promise<T>) => work.then(value => value ?? "accepted", (error: Error) => error.message);

type Harness = Awaited<ReturnType<typeof createFormalReceiptHarness>>;

/** 用旧归约器写下资料（write 决定内容），不留任何本格式的检查点；返回在同一日志上新开冷实例的方法。 */
async function legacyData<T>(write: (h: Harness) => Promise<T>) {
  mode.legacy = true;
  const h = await createFormalReceiptHarness({ startupProofs: true, monotonicClock: () => 0 });
  await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
  await h.ledger.start(ASSIGNMENT_ID);
  const written = await write(h);
  await h.ledger.flushDecisionStates();
  // 旧构建留下的决定状态在本格式下不可用：资料里只剩旧归约器写下的日志与索引
  await dropCheckpoints(h.log, [DECISION, LEGACY]);
  await h.log.stopStorageMaintenance();
  mode.legacy = false;
  const io = await captureFileIo(h.root, relative => defaultFileIoCategory(relative));
  const open = () => {
    const log = new FileAuthorityCommitLog(path.join(h.root, "formal-executor"), h.artifacts, { clock: () => NOW,
      integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 5)) });
    onTestFinished(() => log.stopStorageMaintenance());
    const governor = new ExecutorResourceGovernor({ log, signer: h.identity, verifier: h.identity, guard: { assert() {} },
      executorId: EXECUTOR_ID, localDomainId: "local:device-1", localGovernorEpoch: 1, maxActiveRoots: 1, clock: () => NOW, monotonicClock: () => 0 });
    const ledger = new ConversationAssignmentLedger({ log, artifacts: h.artifacts, executorId: EXECUTOR_ID,
      signer: h.identity, verifier: h.identity, ownerControl, snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: digest => matchingPermissionSnapshotFor(h.identity, digest), resources: governor, clock: () => NOW, monotonicClock: () => 0 });
    return { log, ledger };
  };
  /** 新实例冷开一次：检查点读字节、验签次数与结果；之后写完本实例待落盘的状态并停下它的维护。 */
  const cold = async <V>(probe: (ledger: ConversationAssignmentLedger, log: FileAuthorityCommitLog) => Promise<V>) => {
    const { log, ledger } = open();
    const verify = vi.spyOn(h.identity, "verify");
    try {
      io.reset();
      const value = await probe(ledger, log);
      const snapshot = io.snapshot();
      return { value, verifies: verify.mock.calls.length, checkpoint: snapshot.byCategory.checkpoint?.readBytes ?? 0, log };
    } finally {
      verify.mockRestore();
      await ledger.flushDecisionStates();
      await log.stopStorageMaintenance();
    }
  };
  const drop = async (which: readonly string[]) => { await cold(async (_ledger, log) => dropCheckpoints(log, which)); };
  return { h, written, cold, drop, open };
}

async function dropCheckpoints(log: FileAuthorityCommitLog, which: readonly string[]) {
  for (const prefix of which) for (const key of await log.listProjectionCheckpointKeys(prefix)) await log.deleteProjectionCheckpoint(key);
}

async function savedDecision(log: FileAuthorityCommitLog) {
  const [key] = await log.listProjectionCheckpointKeys(DECISION);
  const saved = await log.loadProjectionCheckpoint<{ state: { sideEffects: Map<number, unknown>; requested: Map<string, unknown>;
    legacyHistoryUpTo?: number; legacyHistoryGeneration?: string } }>(key!);
  return saved!.state.state;
}

/** completed 个已完成交互（逐个镜像）与同数已完成副作用，另有 1 个未结请求。 */
const completedHistory = (completed: number) => async (h: Harness) => {
  const receipts: ReturnType<typeof mirrorReceipt>[] = [];
  const requested: number[] = [];
  for (let index = 0; index < completed; index++) {
    requested.push((await h.ledger.requestInteraction(ASSIGNMENT_ID, request(`done-${index}`))).recordSeq);
    await h.ledger.finishInteraction(ASSIGNMENT_ID, `done-${index}`, answer(`done-${index}`));
    const batch = (await h.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID))!;
    receipts.push(mirrorReceipt(batch));
    await h.ledger.markInteractionsMirrored(ASSIGNMENT_ID, receipts.at(-1)!);
    const { effectSeq } = await h.ledger.startSideEffect(ASSIGNMENT_ID, effect);
    await h.ledger.completeSideEffect(ASSIGNMENT_ID, effectSeq, { status: "ok" });
  }
  await h.ledger.requestInteraction(ASSIGNMENT_ID, request("pending-1"));
  return { receipts, requested };
};

/** 迁移后另一实例留下一条尚未进决定状态的新请求，再冷开只取当前状态：检查点读字节、读到的旧前缀页数与尾部长度。 */
async function tailCost(data: Awaited<ReturnType<typeof legacyData>>) {
  await data.cold(ledger => ledger.pendingInteractionRequests(ASSIGNMENT_ID));
  const migrated = (await data.cold(async (_ledger, log) => (await savedDecision(log)) as unknown as { lastSeq: number })).value.lastSeq;
  // 写下新请求的实例在计量前不落盘：冷开从迁移时的决定状态起，尾部只有这一条
  const writer = data.open();
  await writer.ledger.requestInteraction(ASSIGNMENT_ID, request("new-tail"));
  const measured = await data.cold(async (ledger, log) => {
    const loads: string[] = [];
    const load = log.loadProjectionCheckpoint.bind(log);
    const spy = vi.spyOn(log, "loadProjectionCheckpoint").mockImplementation(async key => { loads.push(String(key)); return load(key); });
    try {
      const state = await ledger.queryLedger(ASSIGNMENT_ID, ownerContext(ASSIGNMENT_ID, "executor.queryLedger")) as { phase: string; lastSeq: number };
      expect(state.phase).toBe("started");
      return { tail: state.lastSeq - migrated, legacyPages: loads.filter(key => key.startsWith(LEGACY)).length };
    } finally { spy.mockRestore(); }
  });
  await writer.ledger.flushDecisionStates();
  await writer.log.stopStorageMaintenance();
  return { checkpoint: measured.checkpoint, ...measured.value };
}

describe("assignment ledger legacy history", () => {
  it("moves a legacy assignment to keyed decision states after one strict replay, with later cold opens independent of its completed history", async () => {
    const rows: { completed: number; first: { verifies: number; checkpoint: number }; later: { verifies: number; checkpoint: number } }[] = [];
    for (const completed of [2, 20]) {
      const data = await legacyData(completedHistory(completed));
      const pending = (ledger: ConversationAssignmentLedger) => ledger.pendingInteractionRequests(ASSIGNMENT_ID);
      const first = await data.cold(pending);
      const later = await data.cold(pending);
      expect(later.value).toEqual(first.value);
      const decision = await savedDecision(later.log);
      // 决定状态只留未结义务：已完成的副作用与请求都在旧前缀历史里
      expect(decision.sideEffects.size).toBe(0);
      expect([...decision.requested.keys()]).toEqual(["pending-1"]);
      expect(decision.legacyHistoryUpTo).toBeGreaterThan(0);
      rows.push({ completed, first: { verifies: first.verifies, checkpoint: first.checkpoint }, later: { verifies: later.verifies, checkpoint: later.checkpoint } });
    }
    console.log(JSON.stringify(rows));
    const [small, large] = rows;
    // 首次：没有可用检查点，完整重放；随后：只读按键化的小决定状态，与已完成历史无关
    expect(small!.first.checkpoint).toBe(0);
    expect(large!.first.verifies).toBeGreaterThanOrEqual(small!.first.verifies);
    expect(large!.later.checkpoint).toBeLessThanOrEqual(small!.later.checkpoint + 64);
    expect(large!.later.verifies).toBe(small!.later.verifies);
  }, 300_000);

  it("answers the legacy prefix exactly as a full replay does and never treats a missing prefix as a first use", async () => {
    const data = await legacyData(completedHistory(3));
    await data.cold(ledger => ledger.pendingInteractionRequests(ASSIGNMENT_ID));
    const probe = async (ledger: ConversationAssignmentLedger) => ({
      repeated: await ledger.requestInteraction(ASSIGNMENT_ID, request("done-1")),
      outcome: await ledger.conversationInteractionOutcome(ASSIGNMENT_ID, "done-1"),
      finished: await ledger.finishInteraction(ASSIGNMENT_ID, "done-1", answer("done-1")),
      effect: await outcome(ledger.completeSideEffect(ASSIGNMENT_ID, 2, { status: "ok" })),
      staleMirror: await outcome(ledger.markInteractionsMirrored(ASSIGNMENT_ID, data.written.receipts[0]!)),
    });
    const keyed = (await data.cold(probe)).value;
    expect(keyed.repeated.recordSeq).toBe(data.written.requested[1]);
    expect(keyed.effect).toBe("accepted");
    expect(keyed.staleMirror).toBe("accepted");
    // 旧前缀历史被删：照完整重放答，不把已用过的 ID 当作首次使用（重复请求仍指向原记录，不追加）
    await data.drop([LEGACY]);
    const missing = (await data.cold(probe)).value;
    await data.drop([DECISION, LEGACY]);
    const full = (await data.cold(probe)).value;
    expect(keyed).toEqual(full);
    expect(missing).toEqual(full);
    expect((await data.cold(ledger => ledger.startSideEffect(ASSIGNMENT_ID, effect))).value).toEqual({ effectSeq: 4 });
  }, 120_000);

  it("joins starts recorded before the migration with ends recorded after it, as a full replay does", async () => {
    // 迁移前：已完成副作用 1、进行中副作用 2、已答未镜像的交互 b、待答交互 a
    const data = await legacyData(async h => {
      const done = await h.ledger.startSideEffect(ASSIGNMENT_ID, effect);
      await h.ledger.completeSideEffect(ASSIGNMENT_ID, done.effectSeq, { status: "ok" });
      await h.ledger.requestInteraction(ASSIGNMENT_ID, request("b"));
      await h.ledger.finishInteraction(ASSIGNMENT_ID, "b", answer("b"));
      const a = (await h.ledger.requestInteraction(ASSIGNMENT_ID, request("a"))).recordSeq;
      const open = await h.ledger.startSideEffect(ASSIGNMENT_ID, effect);
      return { a, done: done.effectSeq, open: open.effectSeq };
    });
    // 第一次冷开完成迁移；之后在新格式下回答 a、完成副作用 2、镜像确认 b 与 a
    await data.cold(ledger => ledger.pendingInteractionRequests(ASSIGNMENT_ID));
    const receipt = (await data.cold(async ledger => {
      await ledger.finishInteraction(ASSIGNMENT_ID, "a", answer("a"));
      await ledger.completeSideEffect(ASSIGNMENT_ID, data.written.open, { status: "ok" });
      const batch = (await ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID))!;
      await ledger.markInteractionsMirrored(ASSIGNMENT_ID, mirrorReceipt(batch));
      return mirrorReceipt(batch);
    })).value;
    const probe = async (ledger: ConversationAssignmentLedger) => ({
      outcomeA: (await ledger.conversationInteractionOutcome(ASSIGNMENT_ID, "a"))?.t ?? "missing",
      outcomeB: (await ledger.conversationInteractionOutcome(ASSIGNMENT_ID, "b"))?.t ?? "missing",
      repeatedRequest: (await ledger.requestInteraction(ASSIGNMENT_ID, request("a"))).recordSeq,
      repeatedAnswer: await outcome(ledger.finishInteraction(ASSIGNMENT_ID, "a", answer("a"))),
      conflictingAnswer: await outcome(ledger.finishInteraction(ASSIGNMENT_ID, "a", answer("a", "other"))),
      repeatedEffect: await outcome(ledger.completeSideEffect(ASSIGNMENT_ID, data.written.open, { status: "ok" })),
      conflictingEffect: await outcome(ledger.completeSideEffect(ASSIGNMENT_ID, data.written.open, { status: "failed" })),
      earlierEffect: await outcome(ledger.completeSideEffect(ASSIGNMENT_ID, data.written.done, { status: "ok" })),
      repeatedMirror: await outcome(ledger.markInteractionsMirrored(ASSIGNMENT_ID, receipt)),
    });
    const keyed = await data.cold(async (ledger, log) => {
      // 迁移已公布：这次冷开从按键化的决定状态起
      expect((await savedDecision(log)).legacyHistoryUpTo).toBeGreaterThan(0);
      return probe(ledger);
    });
    await data.drop([DECISION, LEGACY]);
    const full = (await data.cold(probe)).value;
    expect(keyed.value).toEqual(full);
    expect(full).toMatchObject({ outcomeA: "answered", outcomeB: "answered", repeatedRequest: data.written.a,
      conflictingAnswer: "Interaction requestId already has a different terminal result",
      repeatedEffect: "accepted", conflictingEffect: "Side effect already has a different terminal result", earlierEffect: "accepted",
      repeatedMirror: "accepted" });
    expect((await data.cold(ledger => ledger.startSideEffect(ASSIGNMENT_ID, effect))).value).toEqual({ effectSeq: 3 });
  }, 120_000);

  it.each(["absent", "older generation"] as const)(
    "publishes the reduced state only after the legacy prefix is proven durable (%s file, write silently skipped)",
    async kind => {
      const data = await legacyData(completedHistory(2));
      if (kind === "older generation") {
        // 先有一份已证实写成的旧代；再丢掉决定状态，让下一次迁移重新写出新一代
        await data.cold(ledger => ledger.pendingInteractionRequests(ASSIGNMENT_ID));
        await data.drop([DECISION]);
      }
      // 检查点保存是尽力而为：旧前缀写入正常返回但不落盘，决定状态照常落盘
      const first = await data.cold(async (ledger, log) => {
        const save = log.saveProjectionCheckpoint.bind(log);
        const spy = vi.spyOn(log, "saveProjectionCheckpoint").mockImplementation((key, cursor, state) =>
          key.startsWith(LEGACY) ? Promise.resolve() : save(key, cursor, state));
        try {
          const value = await ledger.pendingInteractionRequests(ASSIGNMENT_ID);
          await ledger.flushDecisionStates();
          return value;
        } finally { spy.mockRestore(); }
      });
      const decision = await savedDecision(first.log);
      const legacyFiles = (await first.log.listProjectionCheckpointKeys(LEGACY)).length;
      // 缺失：一页都没有；旧代：只有上一代的页，读回时代次不符
      if (kind === "absent") expect(legacyFiles).toBe(0); else expect(legacyFiles).toBeGreaterThan(0);
      // 未证实写成：不公布按键化的状态，保存完整回退
      expect(decision.legacyHistoryUpTo ?? 0).toBe(0);
      expect(decision.sideEffects.size).toBe(2);
      // 后续冷开照常回答已完成历史，并在这次真正写成后转入按键路径
      const probe = async (ledger: ConversationAssignmentLedger) => ({
        repeated: (await ledger.requestInteraction(ASSIGNMENT_ID, request("done-0"))).recordSeq,
        effect: await outcome(ledger.completeSideEffect(ASSIGNMENT_ID, 1, { status: "ok" })),
      });
      const after = await data.cold(probe);
      expect(after.value).toEqual({ repeated: data.written.requested[0], effect: "accepted" });
      expect((await savedDecision(after.log)).legacyHistoryUpTo).toBeGreaterThan(0);
    }, 120_000);

  it("reads only the page of the tail key after migration, independent of unrelated and same-kind completed history", async () => {
    const effectsOnly = (count: number) => async (h: Harness) => {
      for (let index = 0; index < count; index++) {
        const { effectSeq } = await h.ledger.startSideEffect(ASSIGNMENT_ID, effect);
        await h.ledger.completeSideEffect(ASSIGNMENT_ID, effectSeq, { status: "ok" });
      }
    };
    const interactionsOnly = (count: number) => async (h: Harness) => {
      for (let index = 0; index < count; index++) {
        await h.ledger.requestInteraction(ASSIGNMENT_ID, request(`done-${index}`));
        await h.ledger.finishInteraction(ASSIGNMENT_ID, `done-${index}`, answer(`done-${index}`));
        const batch = (await h.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID))!;
        await h.ledger.markInteractionsMirrored(ASSIGNMENT_ID, mirrorReceipt(batch));
      }
    };
    const rows: { kind: string; completed: number; checkpoint: number; legacyPages: number; tail: number }[] = [];
    for (const [kind, write, counts] of [["effects", effectsOnly, [2, 40]], ["interactions", interactionsOnly, [2, 40, 160]]] as const) {
      for (const completed of counts) {
        rows.push({ kind, completed, ...await tailCost(await legacyData(write(completed))) });
      }
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      // 只有这一条尾部请求，查重只读它所在的那一页旧前缀历史
      expect(row.tail).toBe(1);
      expect(row.legacyPages).toBe(1);
    }
    const of = (kind: string, completed: number) => rows.find(row => row.kind === kind && row.completed === completed)!;
    // 无关的已完成副作用增长：读量不变（只差位数）
    expect(of("effects", 40).checkpoint).toBeLessThanOrEqual(of("effects", 2).checkpoint + 256);
    // 同类已完成交互增长：页大小有界，40 档起不再随历史增长
    expect(of("interactions", 160).checkpoint).toBeLessThanOrEqual(of("interactions", 40).checkpoint * 1.5);
  }, 300_000);
});
