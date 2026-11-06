// 丢失执行的资源退休：宿主中断或执行以待确认结束后，已开始、没有终局、本进程没有执行作用域、
// 执行端资源租约已明确到期的分配根，在一笔账本协调事务里退休；退休之后执行端不再给它写终局。
// 经真实账本、真实执行端治理与真实日志；时钟由注入控制，只证明时序合同，不代表真实等过默认租约。
import type { AssignmentEntry } from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { AssignmentExecutionResourceRetiredError } from "../assignment-ledger.js";
import {
  ASSIGNMENT_ID,
  DURABLE_IO_TEST_TIMEOUT_MS,
  NOW,
  createFormalReceiptHarness,
  ownerContext,
} from "./assignment-ledger-fixture.js";

/** 资源租约 30 秒到期；控制租约 60 秒、权限租约 1 小时，到期判断因此只落在资源租约上。 */
const RESOURCE_EXPIRY = "2026-07-13T09:00:30.000Z";
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const effect = { kind: "external-call", toolName: "calendar.create", summary: "create calendar event", target: "external-service" } as const;

async function hostHarness(lostExecutionRetirement = true) {
  const time = { wall: NOW, mono: 0 };
  const h = await createFormalReceiptHarness({
    clock: () => time.wall,
    monotonicClock: () => time.mono,
    lostExecutionRetirement,
    resourceExpiry: RESOURCE_EXPIRY,
  });
  const advance = (ms: number) => { time.wall = at(ms); time.mono = ms; };
  return { ...h, time, advance };
}

type Harness = Awaited<ReturnType<typeof hostHarness>>;

/** 一个执行帧：开始执行前打开作用域，然后开始分配。 */
async function startInFrame(h: Harness) {
  await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
  const scope = h.ledger.openExecutionScope(ASSIGNMENT_ID);
  await h.ledger.start(ASSIGNMENT_ID);
  return scope;
}

async function rootState(governor: Harness["governor"], reservationId: string) {
  return (await governor.snapshot()).reservations.get(reservationId)?.state;
}

function assignmentRecords(commits: Awaited<ReturnType<Harness["log"]["readAll"]>>, t: string) {
  return commits.flatMap((commit) => commit.entries)
    .filter((entry) => (entry.body as AssignmentEntry).body?.t === t);
}

describe("丢失执行的资源退休", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("宿主模式下没有执行作用域不能开始；作用域可重复关闭；非宿主模式行为不变", async () => {
    const h = await hostHarness();
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await expect(h.ledger.start(ASSIGNMENT_ID)).rejects.toThrow("execution scope");
    const scope = h.ledger.openExecutionScope(ASSIGNMENT_ID);
    await expect(h.ledger.start(ASSIGNMENT_ID)).resolves.toEqual({ started: true });
    scope.close();
    scope.close();

    const plain = await hostHarness(false);
    await plain.ledger.dispatch(plain.envelope, plain.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await expect(plain.ledger.start(ASSIGNMENT_ID)).resolves.toEqual({ started: true });
  });

  it("重启后：已开始、没有终局的旧执行在资源租约明确到期后退休，同帧只写治理记录，重开重放与再次对账不变", async () => {
    // 前一进程是没有执行作用域的旧构建（与 main 遗留现场同形）；进程死亡后，下一进程以宿主模式重开
    const h = await hostHarness(false);
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.start(ASSIGNMENT_ID);
    h.advance(40_000);
    const next = h.reopen({ lostExecutionRetirement: true });
    expect(await next.ledger.reconcileSupersededReceipts()).toBe(1);
    expect(await next.governor.activeAssignmentReceipts()).toHaveLength(0);
    expect(await rootState(next.governor, h.lease.reservationId)).toBe("reclaimed");
    const commits = await h.log.readAll();
    const retirement = commits.at(-1)!;
    expect(retirement.entries.every((entry) => entry.stream === "governor")).toBe(true);
    expect(retirement.entries.map((entry) => entry.body)).toContainEqual(
      expect.objectContaining({ t: "reclaim", reservationId: h.lease.reservationId }),
    );
    // 业务事实不变：执行端仍只有 received/started，没有伪造终局
    for (const terminal of ["halted", "execution-failed", "bundle_sealed"]) {
      expect(assignmentRecords(commits, terminal)).toHaveLength(0);
    }
    const third = h.reopen({ lostExecutionRetirement: true });
    expect(await third.ledger.reconcileSupersededReceipts()).toBe(0);
    expect(await third.ledger.hasOpenSideEffects(ASSIGNMENT_ID)).toBe(false);
    expect(await h.log.readAll()).toHaveLength(commits.length);
  });

  it("租约未到期不退休；首次判断之后单调时钟越过截止即退休，不按墙钟重算", async () => {
    const h = await hostHarness();
    await startInFrame(h);
    h.advance(10_000);
    const next = h.reopen();
    expect(await next.ledger.reconcileSupersededReceipts()).toBe(0);
    expect(await next.governor.activeAssignmentReceipts()).toHaveLength(1);
    h.time.mono = 31_000;
    expect(await next.ledger.reconcileSupersededReceipts()).toBe(1);
    expect(await rootState(next.governor, h.lease.reservationId)).toBe("reclaimed");
  });

  it("本机时钟早于接受时间时不退休", async () => {
    const h = await hostHarness();
    await startInFrame(h);
    h.time.wall = at(-60_000);
    h.time.mono = 100_000;
    const next = h.reopen();
    expect(await next.ledger.reconcileSupersededReceipts()).toBe(0);
    expect(await next.governor.activeAssignmentReceipts()).toHaveLength(1);
  });

  it("本进程作用域打开中的执行即使到期也不退休，其自有收尾照常提交", async () => {
    const h = await hostHarness();
    const scope = await startInFrame(h);
    h.advance(40_000);
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(0);
    expect(await rootState(h.governor, h.lease.reservationId)).toBe("active");
    const usageFinal = await h.governor.finalizeLocalAssignment(ASSIGNMENT_ID);
    await expect(h.ledger.failExecution(ASSIGNMENT_ID, { reason: "provider failed", usageFinal }))
      .resolves.toMatchObject({ t: "execution-failed" });
    expect(await rootState(h.governor, h.lease.reservationId)).toBe("released");
    scope.close();
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(0);
  });

  it("同一进程不重启：执行带未完成副作用离开执行帧后，租约到期的第一轮即退休，副作用证据保留", async () => {
    const h = await hostHarness();
    const scope = await startInFrame(h);
    await h.ledger.startSideEffect(ASSIGNMENT_ID, effect);
    scope.close();
    h.advance(10_000);
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(0);
    h.advance(40_000);
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(1);
    expect(await rootState(h.governor, h.lease.reservationId)).toBe("reclaimed");
    expect(await h.ledger.hasOpenSideEffects(ASSIGNMENT_ID)).toBe(true);
  });

  it("退休后：执行失败被拒，工具授权与数据面 active 用途被拒、observe 可用，取消返回空且不写停止证明", async () => {
    const h = await hostHarness();
    const scope = await startInFrame(h);
    h.advance(10_000);
    const before = await h.ledger.dataPlaneBindings([
      { assignmentId: ASSIGNMENT_ID },
      { assignmentId: ASSIGNMENT_ID, use: "observe" },
    ]);
    expect(before[0]).toBeDefined();
    expect(before[1]).toBeDefined();
    scope.close();
    h.advance(40_000);
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(1);

    const usageFinal = await h.governor.finalizeLocalAssignment(ASSIGNMENT_ID);
    await expect(h.ledger.failExecution(ASSIGNMENT_ID, { reason: "late failure", usageFinal }))
      .rejects.toBeInstanceOf(AssignmentExecutionResourceRetiredError);
    await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease))
      .rejects.toThrow("inactive");
    const after = await h.ledger.dataPlaneBindings([
      { assignmentId: ASSIGNMENT_ID },
      { assignmentId: ASSIGNMENT_ID, use: "observe" },
    ]);
    expect(after[0]).toBeUndefined();
    expect(after[1]).toEqual(before[1]);
    expect(await h.ledger.dataPlaneBinding(ASSIGNMENT_ID)).toBeUndefined();

    await expect(h.ledger.cancel(
      ASSIGNMENT_ID,
      { fenceSeq: 7, requestId: "cancel-after-retirement" },
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    )).resolves.toBeUndefined();
    expect(await h.ledger.cancelProof(ASSIGNMENT_ID)).toBeUndefined();
    const commits = await h.log.readAll();
    expect(assignmentRecords(commits, "halted")).toHaveLength(0);
    expect(assignmentRecords(commits, "execution-failed")).toHaveLength(0);
    expect(await h.ledger.executionResourceRetired(ASSIGNMENT_ID)).toBe(true);
    expect(await h.reopen().ledger.hasOpenSideEffects(ASSIGNMENT_ID)).toBe(false);
  });

  it("两个实例共用同一份日志：退休先提交，另一实例到期后的执行失败整笔被拒", async () => {
    const h = await hostHarness();
    const scope = await startInFrame(h);
    scope.close();
    h.advance(40_000);
    const other = h.reopen({ lostExecutionRetirement: false });
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(1);
    const usageFinal = await other.governor.finalizeLocalAssignment(ASSIGNMENT_ID);
    const before = (await h.log.readAll()).length;
    await expect(other.ledger.failExecution(ASSIGNMENT_ID, { reason: "late failure", usageFinal }))
      .rejects.toBeInstanceOf(AssignmentExecutionResourceRetiredError);
    expect(await h.log.readAll()).toHaveLength(before);
  });

  it("两个实例共用同一份日志：另一实例的执行失败先提交，退休跳过", async () => {
    const h = await hostHarness();
    const scope = await startInFrame(h);
    scope.close();
    h.advance(40_000);
    const other = h.reopen({ lostExecutionRetirement: false });
    const usageFinal = await other.governor.finalizeLocalAssignment(ASSIGNMENT_ID);
    await expect(other.ledger.failExecution(ASSIGNMENT_ID, { reason: "provider failed", usageFinal }))
      .resolves.toMatchObject({ t: "execution-failed" });
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(0);
    expect(await rootState(h.governor, h.lease.reservationId)).toBe("released");
  });

  it("退休后历史查询照常可读、不再续执行控制租约；其余控制的续期被拒", async () => {
    const h = await hostHarness();
    const scope = await startInFrame(h);
    scope.close();
    h.advance(40_000);
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(1);
    const renewals = async () => (await h.log.readAll()).flatMap((commit) => commit.entries)
      .map((entry) => (entry.body as AssignmentEntry).body)
      .filter((body): body is Extract<AssignmentEntry["body"], { t: "control-lease-renewed" }> => body?.t === "control-lease-renewed")
      .map((body) => body.lease.renewalSeq);
    const before = await renewals();
    const renewed = (seq: number, method: "executor.queryLedger" | "executor.cancel") => ownerContext(
      ASSIGNMENT_ID, method, method === "executor.cancel" ? { requestId: `cancel-${seq}`, body: { fenceSeq: 9 } } : undefined,
      { renewalSeq: seq, issuedAt: at(40_000), expiry: at(90_000) });
    await expect(h.ledger.queryLedger(ASSIGNMENT_ID, renewed(2, "executor.queryLedger")))
      .resolves.toMatchObject({ phase: "started" });
    expect(await renewals()).toEqual(before);
    // 原控制租约（60 秒）到期之后，历史读取仍可进行
    h.advance(120_000);
    await expect(h.ledger.queryLedger(ASSIGNMENT_ID, ownerContext(ASSIGNMENT_ID, "executor.queryLedger")))
      .resolves.toMatchObject({ phase: "started" });
    await expect(h.ledger.cancel(ASSIGNMENT_ID, { fenceSeq: 9, requestId: "cancel-3" }, renewed(3, "executor.cancel")))
      .rejects.toThrow("cannot be renewed");
    expect(await renewals()).toEqual(before);
  });

  it("退休预检判为可退休之后作用域重新打开：事务暂缓，暂缓结果不被缓存为已完成", async () => {
    const h = await hostHarness();
    const scope = await startInFrame(h);
    scope.close();
    h.advance(40_000);
    const preflight = h.governor.lostExecutionRetirementDue.bind(h.governor);
    let concurrent: { close(): void } | undefined;
    const gate = vi.spyOn(h.governor, "lostExecutionRetirementDue").mockImplementationOnce(async (leases) => {
      const result = await preflight(leases);
      expect(result.due).toHaveLength(1);
      concurrent = h.ledger.openExecutionScope(ASSIGNMENT_ID);
      return result;
    });
    try {
      expect(await h.ledger.reconcileSupersededReceipts()).toBe(0);
    } finally {
      gate.mockRestore();
      concurrent?.close();
    }
    // 作用域关闭不写日志：日志头不变时下一轮仍须重新判断
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(1);
    expect(await rootState(h.governor, h.lease.reservationId)).toBe("reclaimed");
  });

  it("退休写入失败：零写入，下一轮照常退休一次", async () => {
    const h = await hostHarness();
    await startInFrame(h);
    h.advance(40_000);
    const next = h.reopen();
    const before = (await h.log.readAll()).length;
    const write = vi.spyOn(h.log, "transactProjection").mockRejectedValueOnce(new Error("retirement fsync failed"));
    try {
      await expect(next.ledger.reconcileSupersededReceipts()).rejects.toThrow("retirement fsync failed");
    } finally {
      write.mockRestore();
    }
    expect(await h.log.readAll()).toHaveLength(before);
    expect(await next.governor.activeAssignmentReceipts()).toHaveLength(1);
    expect(await next.ledger.reconcileSupersededReceipts()).toBe(1);
    expect(await next.ledger.reconcileSupersededReceipts()).toBe(0);
  });
});
