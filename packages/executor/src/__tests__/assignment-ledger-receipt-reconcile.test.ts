// 回执对账收敛为执行端的一份在途工作：并发调用合一；期间的新提交不被那一轮的结论覆盖；
// 日志头未前进时不重扫；前台加入在途的一轮后按前台紧急度准入。经真实账本、真实执行端治理器与真实日志。
import { StorageMaintenanceCancelledError, currentMaintenanceUrgency, runWithMaintenanceUrgency } from "@zhixing-ai/core/resources";
import { describe, expect, it, vi } from "vitest";
import { ASSIGNMENT_ID, DURABLE_IO_TEST_TIMEOUT_MS, createFormalReceiptHarness, ownerContext } from "./assignment-ledger-fixture.js";

/** 让 activeAssignmentReceipts 第一次调用读完后停在闸口，记录每次调用时所处的准入紧急度。 */
function gateReceiptScans(governor: { activeAssignmentReceipts(): Promise<readonly unknown[]> }) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const urgencies: string[] = [];
  const original = governor.activeAssignmentReceipts.bind(governor);
  const scans = vi.spyOn(governor, "activeAssignmentReceipts").mockImplementation(async () => {
    const value = await original();
    if (scans.mock.calls.length === 1) await gate;
    urgencies.push(currentMaintenanceUrgency());
    return value as never;
  });
  return { scans, urgencies, open };
}

const background = <T>(work: () => Promise<T>) => runWithMaintenanceUrgency(() => "background", new AbortController().signal, work);
const foreground = <T>(work: () => Promise<T>) => runWithMaintenanceUrgency(() => "foreground", new AbortController().signal, work);

describe("回执对账：执行端一份在途工作", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("在途时的并发调用合一：期间加入者等补跑一轮，日志头未前进则补跑不重扫", async () => {
    const h = await createFormalReceiptHarness();
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    const { scans, open } = gateReceiptScans(h.governor);
    const calls = [h.ledger.reconcileSupersededReceipts(), h.ledger.reconcileSupersededReceipts(),
      h.ledger.reconcileSupersededReceipts(), h.ledger.reconcileSupersededReceipts()];
    await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(1));
    open();
    expect(await Promise.all(calls)).toEqual([0, 0, 0, 0]);
    expect(scans).toHaveBeenCalledTimes(1);
    // 之后没有任何提交：结论不变，不再扫描
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(0);
    expect(scans).toHaveBeenCalledTimes(1);
  });

  it("对账进行中有新提交：那一轮的结论不覆盖其后的事实，此后的新围栏照常被重扫并释放", async () => {
    const h = await createFormalReceiptHarness();
    const { scans, open } = gateReceiptScans(h.governor);
    // 第一轮在还没有任何回执时读完、停在闸口
    const first = h.ledger.reconcileSupersededReceipts();
    await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(1));
    // 期间派发产生新回执（派发自己的对账作为加入者等第一轮结束后补跑）
    const dispatched = h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    open();
    expect(await first).toBe(0);
    expect(await dispatched).toMatchObject({ accepted: true });
    // 之后写入一份不随原子释放的旧格式围栏（与升级前的历史记录同形）：日志头前进，下次必须重扫并释放
    const prepare = vi.spyOn(h.governor, "prepareTerminal").mockReturnValueOnce([]);
    try { await h.ledger.supersede(ASSIGNMENT_ID, { fenceSeq: 1, requestId: "fence-after-pass" }, ownerContext(ASSIGNMENT_ID, "executor.supersede")); }
    finally { prepare.mockRestore(); }
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(1);
    expect(await h.governor.activeAssignmentReceipts()).toHaveLength(0);
  });

  it("一轮交付到下一轮接手之间到达的请求不另起并发的一轮，其间写入的新围栏恰好被释放一次", async () => {
    const h = await createFormalReceiptHarness();
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    let inFlight = 0, peak = 0, open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const original = h.governor.activeAssignmentReceipts.bind(h.governor);
    const scans = vi.spyOn(h.governor, "activeAssignmentReceipts").mockImplementation(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      try {
        const value = await original();
        if (scans.mock.calls.length === 1) await gate;
        return value as never;
      } finally { inFlight--; }
    });
    let handoff: Promise<number> | undefined;
    // 第一轮交付的回调里不经等待立刻再请求：落在“本轮结束→下一轮接手”的交接处
    const first = h.ledger.reconcileSupersededReceipts().then((value) => {
      handoff = h.ledger.reconcileSupersededReceipts();
      return value;
    });
    await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(1));
    const joined = h.ledger.reconcileSupersededReceipts();
    // 第一轮停在闸口时写入一份不随原子释放的旧格式围栏：日志头前进，交接后的轮次都必须真去扫
    vi.spyOn(h.governor, "prepareTerminal").mockReturnValueOnce([]);
    await h.ledger.supersede(ASSIGNMENT_ID, { fenceSeq: 1, requestId: "fence-during-pass" }, ownerContext(ASSIGNMENT_ID, "executor.supersede"));
    open();
    const released = await first + await joined + await handoff!;
    // 同一时刻至多一轮在扫；新围栏恰好被释放一次
    expect(peak).toBe(1);
    expect(released).toBe(1);
    expect(await h.governor.activeAssignmentReceipts()).toHaveLength(0);
  });

  it("排队中被取消的请求单独退出等待，同批其他请求照常交付，驱动者继续推进", async () => {
    const h = await createFormalReceiptHarness();
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    const { scans, open } = gateReceiptScans(h.governor);
    const first = h.ledger.reconcileSupersededReceipts();
    await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(1));
    const cancel = new AbortController();
    const cancelled = runWithMaintenanceUrgency(() => "background", cancel.signal, () => h.ledger.reconcileSupersededReceipts());
    const kept = h.ledger.reconcileSupersededReceipts();
    cancel.abort();
    await expect(cancelled).rejects.toBeInstanceOf(StorageMaintenanceCancelledError);
    open();
    await expect(first).resolves.toBe(0);
    await expect(kept).resolves.toBe(0);
  });

  it("前台加入后台发起的在途一轮：这一轮的后续准入按前台紧急度", async () => {
    const h = await createFormalReceiptHarness();
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    const { scans, urgencies, open } = gateReceiptScans(h.governor);
    const started = background(() => h.ledger.reconcileSupersededReceipts());
    await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(1));
    const joined = foreground(() => h.ledger.reconcileSupersededReceipts());
    open();
    await Promise.all([started, joined]);
    expect(urgencies[0]).toBe("foreground");
  });
});
