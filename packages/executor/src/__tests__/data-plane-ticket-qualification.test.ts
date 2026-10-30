/**
 * 资格欠账：已接纳的非中止票据在 spool 资格耐久并确认之前是一笔恢复欠账。正常接纳确认之后重启不恢复任何票据；
 * 大量已确认历史加固定欠账时，重启只恢复欠账；接纳耐久后、登记前崩溃与登记后、确认前崩溃都由欠账兜住；
 * 确认只核销同一次接纳、仍有欠账的票据，退休随即核销欠账。
 */
import path from "node:path";
import { FileArtifactStore, FileAuthorityCommitLog, FileDurableProjectionIndex } from "@zhixing/core/authority";
import type { DataPlaneTicket, ExecutionRef } from "@zhixing/core/contracts";
import { createSignedDataPlaneTicket, protocolDigest, type ProtocolSignatureVerifier, type ProtocolSigner } from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { AssignmentStreamSpool } from "../assignment-stream-spool.js";
import { DataPlaneTicketRegistry } from "../data-plane-ticket-registry.js";

const ref: ExecutionRef = { execution: "conversation", runId: "run-fixed", conversationId: "conversation-fixed", ownerEpoch: 3 };
const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return { alg: "test", keyId: "owner-fixed", sig: protocolDigest("TestSignature", 1, { schemaId, version, payload }) };
  },
  verify(schemaId, version, payload, signature) {
    const expected = this.sign(schemaId, version, payload);
    if (signature.alg !== expected.alg || signature.keyId !== expected.keyId || signature.sig !== expected.sig) throw new Error("Test signature is invalid");
  },
};
const clock = () => "2026-07-23T00:01:00.000Z";
const binding = { ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" };

function ticket(ticketId: string, kind: DataPlaneTicket["kind"] = "run-observe", assignmentId = "assignment-fixed"): DataPlaneTicket {
  return createSignedDataPlaneTicket({
    v: 1, ticketId, ref, assignmentId, surfacePrincipal: "surface:origin", executorId: "executor-fixed",
    issuedAt: "2026-07-23T00:00:00.000Z", expiry: "2026-07-23T00:05:00.000Z", kind, renewable: kind !== "abort",
  } as Parameters<typeof createSignedDataPlaneTicket>[0], identity);
}

async function setup(name: string) {
  const root = await createTempDir(name);
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { clock });
  const spool = {
    deferRecoveredConsumers: vi.fn(async (_input: { consumers: readonly unknown[] }) => {}),
    qualifyConsumer: vi.fn(async () => {}),
    revokeConsumer: vi.fn(async () => undefined),
  };
  const assignments = {
    dataPlaneBinding: vi.fn(async () => binding),
    dataPlaneBindings: vi.fn(async (requests: readonly unknown[]) => requests.map(() => binding)),
  };
  // 确认延时足够长：测试里显式冲刷，不依赖定时器
  const open = (current: FileAuthorityCommitLog = log, extra: { confirmQualifications?: boolean } = {}) => new DataPlaneTicketRegistry({ log: current, spool: spool as unknown as AssignmentStreamSpool, clock,
    executorId: "executor-fixed", verifier: identity, assignments, qualificationConfirmDelayMs: 60_000, ...extra });
  const recovered = () => spool.deferRecoveredConsumers.mock.calls.reduce((sum, [input]) => sum + input.consumers.length, 0);
  return { root, artifacts, log, spool, assignments, open, recovered };
}

const acceptedAt = async (log: FileAuthorityCommitLog, ticketId: string) => {
  for (const envelope of await log.readAll()) for (const entry of envelope.entries) {
    const body = entry.body as { t?: string; ticket?: { ticketId: string }; acceptedAt?: string };
    if (body.t === "data-plane-ticket-accepted" && body.ticket?.ticketId === ticketId) return body.acceptedAt!;
  }
  throw new Error("acceptance not found");
};
const qualificationRecords = async (log: FileAuthorityCommitLog) => (await log.readAll()).flatMap(envelope => envelope.entries)
  .map(entry => entry.body as { t?: string; tickets?: { ticketId: string }[] }).filter(body => body.t === "data-plane-ticket-qualified");

describe("data-plane ticket qualification obligations", { timeout: 30_000 }, () => {
  it("leaves no recovery obligation after a normal accept is confirmed", async () => {
    const { spool, assignments, open, recovered } = await setup("ticket-qualified-normal");
    const registry = open();
    for (const id of ["a", "b", "c"]) await registry.accept(ticket(`normal-${id}`));
    await registry.flushQualifications();
    const restarted = open();
    spool.deferRecoveredConsumers.mockClear(); assignments.dataPlaneBindings.mockClear();
    await restarted.recover();
    expect(recovered()).toBe(0); expect(assignments.dataPlaneBindings).not.toHaveBeenCalled();
    // 确认不改变授权：已确认票据照常按耐久接纳与当前绑定授权
    await expect(restarted.authorizeSurface("normal-a", "observe", "assignment-fixed", "surface:origin")).resolves.toMatchObject({ ticket: { ticketId: "normal-a" } });
  });

  it("bounds restart recovery by real obligations rather than by the confirmed history", async () => {
    const { spool, assignments, open, recovered } = await setup("ticket-qualified-history");
    const registry = open();
    for (let index = 0; index < 64; index++) await registry.accept(ticket(`history-${index}`));
    await registry.flushQualifications();
    // 三张接纳已耐久、登记资格失败：欠账留在投影里
    spool.qualifyConsumer.mockRejectedValue(new Error("spool unavailable"));
    for (const id of ["x", "y", "z"]) await expect(registry.accept(ticket(`owed-${id}`))).rejects.toThrow("spool unavailable");
    spool.qualifyConsumer.mockReset(); spool.qualifyConsumer.mockResolvedValue(undefined);
    const restarted = open();
    spool.deferRecoveredConsumers.mockClear(); assignments.dataPlaneBindings.mockClear();
    await restarted.recover();
    expect(recovered()).toBe(3);
    expect(assignments.dataPlaneBindings.mock.calls.map(([requests]) => requests.length)).toEqual([3]);
  });

  it("redrives an acceptance that became durable before its qualification", async () => {
    const { log, spool, open, recovered } = await setup("ticket-qualified-crash-before");
    spool.qualifyConsumer.mockRejectedValueOnce(new Error("crashed before qualification"));
    await expect(open().accept(ticket("crash-before"))).rejects.toThrow("crashed before qualification");
    const restarted = open();
    await restarted.recover();
    expect(recovered()).toBe(1);
    spool.qualifyConsumer.mockClear();
    await expect(restarted.maintainQualifications()).resolves.toBe(1);
    expect(spool.qualifyConsumer).toHaveBeenCalledOnce();
    expect((await qualificationRecords(log)).map(record => record.tickets!.map(entry => entry.ticketId))).toEqual([["crash-before"]]);
    spool.deferRecoveredConsumers.mockClear();
    await open().recover();
    expect(recovered()).toBe(0);
  });

  it("recovers a qualified acceptance whose confirmation was lost", async () => {
    const { spool, open, recovered } = await setup("ticket-qualified-crash-after");
    const registry = open();
    await registry.accept(ticket("lost-a")); await registry.accept(ticket("lost-b"));
    // 进程在确认写入前退出：不冲刷，直接以同一日志重开
    const restarted = open();
    await restarted.recover();
    expect(recovered()).toBe(2);
    await restarted.maintainQualifications();
    spool.deferRecoveredConsumers.mockClear();
    await open().recover();
    expect(recovered()).toBe(0);
  });

  it("confirms only the acceptance it qualified and skips a ticket retired before the batch", async () => {
    const { log, spool, open, recovered } = await setup("ticket-qualified-partial");
    const registry = open();
    await registry.accept(ticket("partial-a")); await registry.accept(ticket("partial-b"));
    await registry.revoke({ assignmentId: "assignment-fixed", ticketId: "partial-a" });
    await expect(registry.flushQualifications()).resolves.toBeUndefined();
    expect((await qualificationRecords(log)).map(record => record.tickets!.map(entry => entry.ticketId))).toEqual([["partial-b"]]);
    spool.deferRecoveredConsumers.mockClear();
    await open().recover();
    expect(recovered()).toBe(0);
  });

  it("drops the obligation when a pending acceptance retires", async () => {
    const { spool, open, recovered } = await setup("ticket-qualified-retired");
    spool.qualifyConsumer.mockRejectedValueOnce(new Error("spool unavailable"));
    const registry = open();
    await expect(registry.accept(ticket("retired-pending"))).rejects.toThrow("spool unavailable");
    await registry.revoke({ assignmentId: "assignment-fixed", ticketId: "retired-pending" });
    await open().recover();
    expect(recovered()).toBe(0);
  });

  it("creates no obligation for an abort ticket", async () => {
    const { assignments, open, recovered } = await setup("ticket-qualified-abort");
    await open().accept(ticket("abort-only", "abort"));
    assignments.dataPlaneBindings.mockClear();
    await open().recover();
    expect(recovered()).toBe(0); expect(assignments.dataPlaneBindings).not.toHaveBeenCalled();
  });

  it("rejects a qualification that does not match a pending acceptance", async () => {
    const { log, spool, open, recovered } = await setup("ticket-qualified-reject");
    const registry = open();
    await registry.accept(ticket("confirmed")); await registry.flushQualifications();
    spool.qualifyConsumer.mockRejectedValueOnce(new Error("spool unavailable"));
    await expect(registry.accept(ticket("owed"))).rejects.toThrow("spool unavailable");
    const owedAt = await acceptedAt(log, "owed");
    const record = (assignmentId: string, tickets: { ticketId: string; acceptedAt: string }[]) =>
      ({ stream: `assignment:${assignmentId}:data-plane-tickets`, body: { t: "data-plane-ticket-qualified", assignmentId, tickets } });
    // 已核销的、不存在的、换了接纳时刻的、挂到别的分派的，一律在写入时被归约拒绝，欠账原样保留
    await expect(log.append([record("assignment-fixed", [{ ticketId: "confirmed", acceptedAt: await acceptedAt(log, "confirmed") }])])).rejects.toThrow("pending acceptance");
    await expect(log.append([record("assignment-fixed", [{ ticketId: "unknown", acceptedAt: owedAt }])])).rejects.toThrow("pending acceptance");
    await expect(log.append([record("assignment-fixed", [{ ticketId: "owed", acceptedAt: "2026-07-23T00:00:30.000Z" }])])).rejects.toThrow("pending acceptance");
    await expect(log.append([record("assignment-other", [{ ticketId: "owed", acceptedAt: owedAt }])])).rejects.toThrow("pending acceptance");
    await expect(log.append([record("assignment-fixed", [{ ticketId: "owed", acceptedAt: owedAt }, { ticketId: "owed", acceptedAt: owedAt }])])).rejects.toThrow("repeats a ticket");
    await open().recover();
    expect(recovered()).toBe(1);
    // 同一次接纳的确认才核销它
    await log.append([record("assignment-fixed", [{ ticketId: "owed", acceptedAt: owedAt }])]);
    spool.deferRecoveredConsumers.mockClear();
    await open().recover();
    expect(recovered()).toBe(0);
  });

  it("keeps the unconfirmed debt within one batch when the timed confirmation never runs", async () => {
    const { spool, open, recovered } = await setup("ticket-qualified-frozen");
    // 定时确认冻结：只有新接纳耐久前的上界冲刷在起作用
    const registry = open(undefined, { confirmQualifications: false });
    for (let index = 0; index < 40; index++) await registry.accept(ticket(`frozen-${String(index).padStart(2, "0")}`));
    spool.deferRecoveredConsumers.mockClear();
    await open().recover();
    // 第 33 张耐久前已把前 32 张合批确认：剩下 8 张欠账，任何时刻都不超过一批
    expect(recovered()).toBe(8);
  });

  it("fails a new acceptance before it becomes durable while confirmations keep failing", async () => {
    const { log, open } = await setup("ticket-qualified-confirm-failing");
    let failing = true;
    const proxy = new Proxy(log, { get(target, property) {
      if (property === "transactDurableProjection") {
        return async (id: string, decide: (view: unknown, context: unknown) => Promise<{ kind: string; entries?: readonly { body?: { t?: string } }[] }>) =>
          target.transactDurableProjection(id, (async (view: unknown, context: unknown) => {
            const decision = await decide(view, context);
            if (failing && decision.kind === "append" && decision.entries?.some(entry => entry.body?.t === "data-plane-ticket-qualified")) {
              throw new Error("confirmation unavailable");
            }
            return decision;
          }) as never);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const registry = open(proxy as unknown as FileAuthorityCommitLog, { confirmQualifications: false });
    for (let index = 0; index < 32; index++) await registry.accept(ticket(`confirm-${String(index).padStart(2, "0")}`));
    // 欠下的确认已满一批且确认持续失败：新接纳在耐久之前失败，已成功的接纳不受影响
    await expect(registry.accept(ticket("confirm-over"))).rejects.toThrow("confirmation unavailable");
    await expect(acceptedAt(log, "confirm-over")).rejects.toThrow("acceptance not found");
    await expect(registry.authorizeSurface("confirm-00", "observe", "assignment-fixed", "surface:origin")).resolves.toMatchObject({ ticket: { ticketId: "confirm-00" } });
    failing = false;
    await expect(registry.accept(ticket("confirm-over"))).resolves.toMatchObject({ ticketId: "confirm-over" });
  });

  it("fails a new acceptance before it becomes durable while qualifications keep failing", async () => {
    const { log, spool, open } = await setup("ticket-qualified-owed");
    spool.qualifyConsumer.mockRejectedValue(new Error("spool unavailable"));
    const registry = open(undefined, { confirmQualifications: false });
    for (let index = 0; index < 32; index++) await expect(registry.accept(ticket(`owed-${String(index).padStart(2, "0")}`))).rejects.toThrow("spool unavailable");
    // 登记失败的欠账已满一批：先重试它们，仍失败则新接纳在耐久之前失败
    await expect(registry.accept(ticket("owed-over"))).rejects.toThrow("spool unavailable");
    await expect(acceptedAt(log, "owed-over")).rejects.toThrow("acceptance not found");
    spool.qualifyConsumer.mockReset(); spool.qualifyConsumer.mockResolvedValue(undefined);
    await expect(registry.accept(ticket("owed-over"))).resolves.toMatchObject({ ticketId: "owed-over" });
    // 重试登记成功的 32 张已在这次接纳耐久前合批确认
    expect((await qualificationRecords(log)).flatMap(record => record.tickets!).length).toBe(32);
  });

  it("pages maintenance qualifications from a resumable position so failing early obligations do not starve later ones", async () => {
    const { log, spool, open, recovered } = await setup("ticket-qualified-paging");
    const writer = open(undefined, { confirmQualifications: false });
    for (let index = 0; index < 20; index++) await writer.accept(ticket(`page-${String(index).padStart(2, "0")}`));
    // 进程在确认写入前退出：20 张都是欠账（同一到期时刻，按票据 id 排序）
    const failing = new Set(Array.from({ length: 8 }, (_, index) => `page-${String(index).padStart(2, "0")}`));
    spool.qualifyConsumer.mockImplementation((async (input: { consumer: { ticketId: string } }) => {
      if (failing.has(input.consumer.ticketId)) throw new Error("stream unavailable");
    }) as never);
    const maintainer = open();
    // 一页 8 张全部失败：本轮汇总报告，欠账保留，续做位置前移
    await expect(maintainer.maintainQualifications()).rejects.toThrow("left obligations");
    await expect(maintainer.maintainQualifications()).resolves.toBe(8);
    await expect(maintainer.maintainQualifications()).resolves.toBe(4);
    const confirmed = () => qualificationRecords(log).then(records => records.flatMap(record => record.tickets!.map(entry => entry.ticketId)).sort());
    expect(await confirmed()).toEqual(Array.from({ length: 12 }, (_, index) => `page-${String(index + 8).padStart(2, "0")}`));
    // 到尾回到开头：最早 8 张仍失败，欠账保留；恢复后照常核销
    await expect(maintainer.maintainQualifications()).rejects.toThrow("left obligations");
    failing.clear();
    await expect(maintainer.maintainQualifications()).resolves.toBe(8);
    spool.deferRecoveredConsumers.mockClear();
    await open().recover();
    expect(recovered()).toBe(0);
  });

  it("reads one page of tickets per maintenance round however large the debt is", async () => {
    const { spool, open } = await setup("ticket-qualified-page-reads");
    // 100 张真实欠账：登记失败、分四个进程各欠 25 张（单个进程的上界冲刷不触发）
    spool.qualifyConsumer.mockRejectedValue(new Error("spool unavailable"));
    for (let process = 0; process < 4; process++) {
      const writer = open(undefined, { confirmQualifications: false });
      for (let index = 0; index < 25; index++) await expect(writer.accept(ticket(`bulk-${String(process * 25 + index).padStart(3, "0")}`))).rejects.toThrow("spool unavailable");
    }
    spool.qualifyConsumer.mockReset(); spool.qualifyConsumer.mockResolvedValue(undefined);
    let requested = 0;
    const original = FileDurableProjectionIndex.prototype.getMany;
    const spy = vi.spyOn(FileDurableProjectionIndex.prototype, "getMany").mockImplementation(async function (this: FileDurableProjectionIndex, keys: readonly string[]) {
      requested += keys.filter(key => key.startsWith("t:bulk-")).length;
      return original.call(this, keys);
    });
    try {
      await expect(open().maintainQualifications()).resolves.toBe(8);
    } finally { spy.mockRestore(); }
    // 只物化一页（8 张）的票据，加上确认交易逐张核对的同一页
    expect(requested).toBeLessThanOrEqual(16);
  });
});

describe("data-plane ticket qualification confirmation waits for foreground quiet", { timeout: 30_000 }, () => {
  const confirmedIds = async (log: FileAuthorityCommitLog) => (await qualificationRecords(log)).flatMap(record => record.tickets!.map(item => item.ticketId)).sort();
  /** 可控的前台安静判定：open() 之前一直不安静；取消时立即返回。 */
  function quietGate() {
    let open!: () => void;
    const quiet = new Promise<void>(resolve => { open = resolve; });
    const calls: AbortSignal[] = [];
    const whenQuiet = (signal: AbortSignal) => {
      calls.push(signal);
      return new Promise<void>(resolve => { void quiet.then(resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
    };
    return { whenQuiet, open: () => open(), calls };
  }

  it("confirms only after the foreground is quiet and never holds the registry queue while waiting", async () => {
    const { log, spool, assignments } = await setup("ticket-quiet-confirm");
    const gate = quietGate();
    const registry = new DataPlaneTicketRegistry({ log, spool: spool as unknown as AssignmentStreamSpool, clock, executorId: "executor-fixed",
      verifier: identity, assignments, qualificationConfirmDelayMs: 1, whenQuiet: gate.whenQuiet });
    await registry.accept(ticket("quiet-a"));
    await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
    // 等安静期间：队列不被占用，另一张接纳照常完成；不写确认，也不叠加第二个等待
    await registry.accept(ticket("quiet-b"));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await confirmedIds(log)).toEqual([]); expect(gate.calls).toHaveLength(1);
    gate.open();
    await vi.waitFor(async () => expect(await confirmedIds(log)).toEqual(["quiet-a", "quiet-b"]));
  });

  it("still forces the hard bound before a new acceptance and flushes on stop without waiting for quiet", async () => {
    const { log, spool, assignments } = await setup("ticket-quiet-bound");
    const gate = quietGate();
    const registry = new DataPlaneTicketRegistry({ log, spool: spool as unknown as AssignmentStreamSpool, clock, executorId: "executor-fixed",
      verifier: identity, assignments, qualificationConfirmDelayMs: 1, whenQuiet: gate.whenQuiet });
    // 前台始终不安静：第 33 张接纳耐久之前，上界冲刷照样确认前 32 张
    for (let index = 0; index < 33; index++) await registry.accept(ticket(`bound-${String(index).padStart(2, "0")}`));
    expect(await confirmedIds(log)).toHaveLength(32);
    // 停止冲刷不等安静，并让仍在等待的定时确认随之返回
    await registry.flushQualifications();
    expect(await confirmedIds(log)).toHaveLength(33);
    expect(gate.calls.every(signal => signal.aborted)).toBe(true);
  });
});
