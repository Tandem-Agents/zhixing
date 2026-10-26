/**
 * 票据登记表的规模对照：当前在用票据与近期撤销固定，只增加已结束的票据历史（撤销后越过
 * 保留期、被退休前沿剪除）。计量正常停止后冷启动恢复、随后再次停止的全部文件读写：日志只读
 * 尾部、不读检查点、停止不写；投影读取只随段层数与二分深度增长，段层填满之后（64 张起）
 * 总读量不再随历史增长。从日志起点重放（旧做法）的读量随日志线性增长，作为对照。
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog, FileDurableProjectionIndex } from "@zhixing/core/authority";
import type { DataPlaneTicket, ExecutionRef } from "@zhixing/core/contracts";
import { createSignedDataPlaneTicket, protocolDigest, type ProtocolSignatureVerifier, type ProtocolSigner } from "@zhixing/core/protocol";
import { captureFileIo, createTempDir, defaultFileIoCategory, type FileIoSnapshot } from "@zhixing/test-utils";
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

function ticket(ticketId: string, assignmentId: string, issuedAt: string, expiry: string): DataPlaneTicket {
  return createSignedDataPlaneTicket({
    v: 1, ticketId, ref, assignmentId, surfacePrincipal: "surface:origin", executorId: "executor-fixed",
    issuedAt, expiry, kind: "run-observe", renewable: true,
  } as Parameters<typeof createSignedDataPlaneTicket>[0], identity);
}

// 投影文件按清单、目录页、段数据与段偏移分开计量
const category = (relative: string) => {
  const base = defaultFileIoCategory(relative);
  if (base !== "projection") return base;
  const name = relative.split("/").at(-1)!;
  return name.endsWith(".data") ? "projection:data" : name.endsWith(".offsets") ? "projection:offsets"
    : name.startsWith("manifest") ? "projection:manifest" : name.startsWith("directory") ? "projection:directory" : "projection:other";
};
const summary = (io: FileIoSnapshot) => ({
  readBytes: io.readBytes, reads: io.reads, writeBytes: io.writeBytes, writes: io.writes, segmentEntryProbes: io.segmentEntryProbes,
  log: io.byCategory.log?.readBytes ?? 0, checkpoint: io.byCategory.checkpoint?.readBytes ?? 0,
  projection: Object.fromEntries(Object.entries(io.byCategory).filter(([name]) => name.startsWith("projection")).map(([name, value]) => [name.slice("projection:".length), `${value.readBytes}/${value.reads}`])),
});

describe("data-plane ticket registry with fixed current tickets and growing ended history", () => {
  it("bounds cold recovery and stop I/O by index depth at 16 / 64 / 256 / 1024 ended tickets while a full replay grows", async () => {
    const rows: Record<string, unknown>[] = [];
    for (const ended of [16, 64, 256, 1024]) {
      const root = await createTempDir("ticket-scale-" + ended);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      let now = "2026-07-23T00:00:00.000Z", monotonic = 1_000;
      const clock = () => now;
      const binding = { ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" };
      const assignments = { dataPlaneBinding: async () => binding, dataPlaneBindings: vi.fn(async (requests: readonly unknown[]) => requests.map(() => binding)) };
      const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => undefined) } as unknown as AssignmentStreamSpool;
      const options = (log: FileAuthorityCommitLog) => ({ log, spool, clock, monotonicClock: () => monotonic, executorId: "executor-fixed", verifier: identity, assignments });
      const logRoot = path.join(root, "authority");
      // 与生产一致：带缓存完整性密钥，投影状态可以落盘并在冷启动时认证复用
      const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 7));
      const log = new FileAuthorityCommitLog(logRoot, artifacts, { clock, integrity });
      const registry = new DataPlaneTicketRegistry(options(log));
      // 已结束历史：每张票据接纳后撤销；越过保留期后周期维护推进前沿、剪除
      for (let index = 0; index < ended; index++) {
        const old = ticket("ended-" + index, "ended-assignment-" + index, "2026-07-23T00:00:00.000Z", "2026-07-23T00:05:00.000Z");
        await registry.accept(old);
        await registry.revoke({ assignmentId: old.assignmentId, ticketId: old.ticketId });
      }
      now = "2026-07-25T00:00:00.000Z"; monotonic += 48 * 60 * 60 * 1_000;
      await registry.maintain();
      // 当前状态固定：四张在用票据，一张近期撤销
      for (let index = 0; index < 4; index++) {
        await registry.accept(ticket("current-" + index, "current-assignment-" + index, "2026-07-25T00:00:00.000Z", "2026-07-25T01:00:00.000Z"));
      }
      const recent = ticket("recent-revoked", "current-assignment-0", "2026-07-25T00:00:00.000Z", "2026-07-25T01:00:00.000Z");
      await registry.accept(recent);
      await registry.revoke({ assignmentId: recent.assignmentId, ticketId: recent.ticketId });
      await log.stopStorageMaintenance();
      const logBytes = (await stat(path.join(logRoot, "authority.log"))).size;

      // 冷启动：同一目录新开日志与登记表
      const io = await captureFileIo(root, category);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, { clock, integrity });
      const recovered = new DataPlaneTicketRegistry(options(cold));
      assignments.dataPlaneBindings.mockClear();
      await recovered.recover();
      const recovery = summary(io.snapshot());
      const restored = assignments.dataPlaneBindings.mock.calls.map(args => args[0].length);
      await expect(recovered.authorizeSurface("current-0", "observe", "current-assignment-0", "surface:origin")).resolves.toMatchObject({ ticket: { ticketId: "current-0" } });
      await expect(recovered.authorizeSurface("ended-0", "observe", "ended-assignment-0", "surface:origin")).rejects.toThrow(/unknown/);
      io.reset();
      await cold.stopStorageMaintenance();
      const stop = summary(io.snapshot());

      // 对照：旧做法从日志起点重放全部记录
      io.reset();
      const replay = new FileAuthorityCommitLog(logRoot, artifacts, { clock, integrity });
      await replay.readProjection<number, unknown>(0, count => count + 1);
      const fullReplay = summary(io.snapshot());
      await replay.stopStorageMaintenance();
      rows.push({ ended, logBytes, restored, recovery, stop, fullReplay });
    }
    console.log(JSON.stringify(rows));
    const [small, middle, , large] = rows as { restored: number[]; recovery: ReturnType<typeof summary>; stop: ReturnType<typeof summary>; fullReplay: ReturnType<typeof summary> }[];
    for (const row of rows as typeof small[]) {
      // 只为当前有效票据恢复绑定；冷开只读日志尾部，不读检查点；停止不再写入
      expect(row.restored).toEqual([4]);
      expect(row.recovery.log).toBeLessThanOrEqual(small!.recovery.log + 16);
      expect(row.recovery.checkpoint).toBe(0);
      expect(row.stop).toEqual(small!.stop);
    }
    // 段层填满之后（64→1024，历史放大 16 倍）：总读字节、读取次数与条目探测都不超过 1.5 倍
    expect(large!.recovery.readBytes).toBeLessThanOrEqual(middle!.recovery.readBytes * 1.5);
    expect(large!.recovery.reads).toBeLessThanOrEqual(middle!.recovery.reads * 1.5);
    expect(large!.recovery.segmentEntryProbes).toBeLessThanOrEqual(middle!.recovery.segmentEntryProbes * 1.5);
    // 对照：从日志起点重放随历史线性增长
    expect(large!.fullReplay.log).toBeGreaterThan(small!.fullReplay.log * 32);
  }, 900_000);

  it("keeps cold recovery bounded at 8 / 32 / 128 / 512 / 2048 tickets that passed retention offline, then prunes them in bounded maintenance steps", async () => {
    const rows: Record<string, unknown>[] = [];
    for (const ended of [8, 32, 128, 512, 2048]) {
      const root = await createTempDir("ticket-offline-" + ended);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      let now = "2026-07-23T00:00:00.000Z", monotonic = 1_000;
      const clock = () => now;
      const binding = { ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" };
      const assignments = { dataPlaneBinding: async () => binding, dataPlaneBindings: vi.fn(async (requests: readonly unknown[]) => requests.map(() => binding)) };
      const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => undefined) } as unknown as AssignmentStreamSpool;
      const options = (log: FileAuthorityCommitLog) => ({ log, spool, clock, monotonicClock: () => monotonic, executorId: "executor-fixed", verifier: identity, assignments });
      const logRoot = path.join(root, "authority");
      const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 7));
      const log = new FileAuthorityCommitLog(logRoot, artifacts, { clock, integrity });
      const registry = new DataPlaneTicketRegistry(options(log));
      // 已结束历史：同一时刻接纳并撤销，保留期全部相同；正常停止后离线两天，期间不做任何维护
      for (let index = 0; index < ended; index++) {
        const old = ticket("ended-" + index, "ended-assignment-" + index, now, "2026-07-23T00:05:00.000Z");
        await registry.accept(old);
        await registry.revoke({ assignmentId: old.assignmentId, ticketId: old.ticketId });
      }
      await log.stopStorageMaintenance();
      now = "2026-07-25T00:00:00.000Z"; monotonic += 48 * 60 * 60 * 1_000;

      const io = await captureFileIo(root, category);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, { clock, integrity });
      const recovered = new DataPlaneTicketRegistry(options(cold));
      await recovered.recover();
      const recovery = summary(io.snapshot());
      // 有效性照旧：已退休的票据拒绝访问
      await expect(recovered.authorizeSurface("ended-0", "observe", "ended-assignment-0", "surface:origin")).rejects.toThrow(/retired/);
      // 已退休历史由周期维护分步剪除：每步一笔事务、至多一批，按耐久前沿续做。逐步计量
      const steps: ReturnType<typeof summary>[] = [];
      const frontierStream = "executor:executor-fixed:data-plane-ticket-retirement-frontier";
      for (let step = 0; step < 128; step++) {
        const before = (await cold.readStream(frontierStream)).length;
        io.reset();
        await recovered.maintain(undefined, 8, 1);
        steps.push(summary(io.snapshot()));
        if ((await cold.readStream(frontierStream)).length === before) break;
      }
      const frontiers = await cold.readStream<{ readonly throughTicketId?: string }>(frontierStream);
      // 一张不剩：访问报未知；再签发同一张已剪除的票据也不会让它复活
      await expect(recovered.authorizeSurface("ended-0", "observe", "ended-assignment-0", "surface:origin")).rejects.toThrow(/unknown/);
      await recovered.accept(ticket("ended-0", "ended-assignment-0", "2026-07-23T00:00:00.000Z", "2026-07-23T00:05:00.000Z"));
      await expect(recovered.authorizeSurface("ended-0", "observe", "ended-assignment-0", "surface:origin")).rejects.toThrow(/unknown/);
      await cold.stopStorageMaintenance();
      // 冷开后的第一笔写入会把覆盖层收拢进增量窗口（一次性，读写受增量窗口约束），单列；
      // 剪除积累的墓碑偶尔触发投影的段整理（与索引当前大小成正比，属存储层），最大单步照实输出
      const [first, ...rest] = steps;
      const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : 0;
      rows.push({ ended, recovery, steps: steps.length, frontiers: frontiers.length, firstStep: first,
        medianStep: median(rest.map(step => step.readBytes)), medianStepWrites: median(rest.map(step => step.writeBytes)),
        maxStep: Math.max(0, ...rest.map(step => step.readBytes)), maxStepWrites: Math.max(0, ...rest.map(step => step.writeBytes)),
        totalMaintenance: steps.reduce((sum, step) => sum + step.readBytes, 0) });
      expect(frontiers.every(frontier => frontier.body.throughTicketId !== undefined)).toBe(true);
      expect(frontiers.length).toBe(Math.ceil(ended / 32));
    }
    console.log(JSON.stringify(rows));
    type Row = { recovery: ReturnType<typeof summary>; firstStep: ReturnType<typeof summary>; medianStep: number; medianStepWrites: number };
    const scale = (ended: number) => rows.find(row => row.ended === ended)! as Row;
    // 冷恢复不随已过保留期的票据数增长，也不写墓碑
    for (const row of rows as Row[]) expect(row.recovery.writeBytes).toBeLessThanOrEqual(scale(8).recovery.writeBytes + 1_024);
    expect(scale(2048).recovery.readBytes).toBeLessThanOrEqual(scale(512).recovery.readBytes * 1.5);
    expect(scale(2048).recovery.reads).toBeLessThanOrEqual(scale(512).recovery.reads * 1.5);
    // 每步只读前沿之后的一页（至多 32 行，落到基段时按 64KB 段读批次读盘）、剪除 32 张票据的三类键，
    // 外加至多 8 次物理撤销：单步的中位读写与积压总数无关
    expect(scale(2048).medianStep).toBeLessThanOrEqual(scale(512).medianStep * 1.5);
    expect(scale(2048).medianStepWrites).toBeLessThanOrEqual(scale(512).medianStepWrites * 1.5 + 1_024);
    expect(scale(2048).firstStep.readBytes).toBeLessThanOrEqual(Math.max(scale(512).firstStep.readBytes, scale(128).firstStep.readBytes) * 1.5);
  }, 900_000);

  it("leaves 8 / 32 / 128 tickets that expired naturally while offline to bounded maintenance rounds that continue across a cold reopen, while a still-valid ticket stays usable", async () => {
    const rows: Record<string, unknown>[] = [];
    for (const expired of [8, 32, 128]) {
      const root = await createTempDir("ticket-natural-expiry-" + expired);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      let now = "2026-07-23T00:00:00.000Z", monotonic = 1_000;
      const clock = () => now;
      const binding = { ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" };
      const assignments = { dataPlaneBinding: async () => binding, dataPlaneBindings: vi.fn(async (requests: readonly unknown[]) => requests.map(() => binding)) };
      const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => undefined) } as unknown as AssignmentStreamSpool;
      const options = (log: FileAuthorityCommitLog) => ({ log, spool, clock, monotonicClock: () => monotonic, executorId: "executor-fixed", verifier: identity, assignments });
      const logRoot = path.join(root, "authority");
      const logFile = path.join(logRoot, "authority.log");
      const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 7));
      const log = new FileAuthorityCommitLog(logRoot, artifacts, { clock, integrity });
      const registry = new DataPlaneTicketRegistry(options(log));
      // 正常接纳后不撤销：五分钟后自然过期；另有一张十二小时有效的票据。正常停止，离线两小时，期间不做维护
      for (let index = 0; index < expired; index++) {
        await registry.accept(ticket("expired-" + index, "expired-assignment-" + index, now, "2026-07-23T00:05:00.000Z"));
      }
      await registry.accept(ticket("valid-0", "valid-assignment-0", now, "2026-07-23T12:00:00.000Z"));
      await log.stopStorageMaintenance();
      now = "2026-07-23T02:00:00.000Z"; monotonic += 2 * 60 * 60 * 1_000;

      const open = async () => {
        const cold = new FileAuthorityCommitLog(logRoot, artifacts, { clock, integrity });
        const recovered = new DataPlaneTicketRegistry(options(cold));
        assignments.dataPlaneBindings.mockClear();
        const before = (await stat(logFile)).size;
        await recovered.recover();
        return { cold, recovered, appended: (await stat(logFile)).size - before, restored: assignments.dataPlaneBindings.mock.calls.map(args => args[0].length) };
      };
      const io = await captureFileIo(root, category);
      const first = await open();
      const recovery = summary(io.snapshot());
      // 冷恢复只为有效票据恢复绑定，不追加退休记录；只记下排除过期票据所依据的时间下界（固定一条）
      expect(first.restored).toEqual([1]);
      expect(first.appended).toBeGreaterThan(0);
      // 准入照原 TTL 即时判定：有效的可用，过期的拒绝
      await expect(first.recovered.authorizeSurface("valid-0", "observe", "valid-assignment-0", "surface:origin")).resolves.toMatchObject({ ticket: { ticketId: "valid-0" } });
      await expect(first.recovered.authorizeSurface("expired-1", "observe", "expired-assignment-1", "surface:origin")).rejects.toThrow(/retired/);
      // 周期维护按批预算退休积压：每轮一批（至多 32 张），两轮后冷重开，从耐久状态续做
      const rounds: number[] = [];
      rounds.push(await first.recovered.maintain(undefined, 8, 8, 1), await first.recovered.maintain(undefined, 8, 8, 1));
      await first.cold.stopStorageMaintenance();
      const second = await open();
      expect(second.restored).toEqual([1]);
      // 时间没有推进到已记下的下界之后：不再追加
      expect(second.appended).toBe(0);
      for (let round = 0; round < 16; round++) {
        const retired = await second.recovered.maintain(undefined, 8, 8, 1);
        if (retired === 0) break;
        rounds.push(retired);
      }
      // 积压全部退休（过期的那一张已在授权时单张退休）；有效票据仍可用，过期票据仍拒绝
      expect(rounds.every(retired => retired <= 32)).toBe(true);
      expect(rounds.reduce((sum, retired) => sum + retired, 0)).toBe(expired - 1);
      await expect(second.recovered.authorizeSurface("valid-0", "observe", "valid-assignment-0", "surface:origin")).resolves.toMatchObject({ ticket: { ticketId: "valid-0" } });
      await expect(second.recovered.authorizeSurface(`expired-${expired - 1}`, "observe", `expired-assignment-${expired - 1}`, "surface:origin")).rejects.toThrow(/retired/);
      await second.cold.stopStorageMaintenance();
      rows.push({ expired, recovery, rounds, appended: first.appended });
    }
    console.log(JSON.stringify(rows));
    // 冷恢复的写入不随积压增长：冷开的固定写入加一条时间下界（各档只差日志序号的位数）
    const writes = (rows as { recovery: ReturnType<typeof summary>; appended: number }[]).map(row => row.recovery.writeBytes);
    expect(Math.max(...writes) - Math.min(...writes)).toBeLessThanOrEqual(8);
    const appended = (rows as { appended: number }[]).map(row => row.appended);
    expect(Math.max(...appended) - Math.min(...appended)).toBeLessThanOrEqual(8);
  }, 900_000);

  it("does not reread revocations whose receipts are durable when admitting an unrelated ticket at 8 / 32 / 128 completed revocations in a live process", async () => {
    const rows: { completed: number; requested: number; endedRequested: number }[] = [];
    for (const completed of [8, 32, 128]) {
      const root = await createTempDir("ticket-warm-completed-" + completed);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const clock = () => "2026-07-23T00:00:00.000Z";
      const binding = { ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" };
      const assignments = { dataPlaneBinding: async () => binding, dataPlaneBindings: async (requests: readonly unknown[]) => requests.map(() => binding) };
      const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => undefined) } as unknown as AssignmentStreamSpool;
      const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { clock, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) });
      const registry = new DataPlaneTicketRegistry({ log, spool, clock, monotonicClock: () => 1_000, executorId: "executor-fixed", verifier: identity, assignments });
      for (let index = 0; index < completed; index++) {
        const ended = ticket("ended-" + index, "ended-assignment-" + index, "2026-07-23T00:00:00.000Z", "2026-07-23T00:05:00.000Z");
        await registry.accept(ended);
        await registry.revoke({ assignmentId: ended.assignmentId, ticketId: ended.ticketId });
      }
      // 撤销回执都已落盘：之后接纳一张无关票据，按键取值里不应再出现任何已完成撤销的票据
      let requested = 0, endedRequested = 0;
      const original = FileDurableProjectionIndex.prototype.getMany;
      const spy = vi.spyOn(FileDurableProjectionIndex.prototype, "getMany").mockImplementation(async function (this: FileDurableProjectionIndex, keys: readonly string[]) {
        requested += keys.length;
        endedRequested += keys.filter((key) => key.startsWith("t:ended-")).length;
        return original.call(this, keys);
      });
      try {
        await registry.accept(ticket("fresh", "fresh-assignment", "2026-07-23T00:00:00.000Z", "2026-07-23T00:05:00.000Z"));
      } finally {
        spy.mockRestore();
      }
      rows.push({ completed, requested, endedRequested });
      await log.stopStorageMaintenance();
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) expect(row.endedRequested).toBe(0);
    expect(rows[2]!.requested).toBeLessThanOrEqual(rows[0]!.requested);
  }, 300_000);

  describe("one non-regressing effective clock for every ticket time decision (distributed spec 1.1)", () => {
    // 有效时钟 = max(本地墙钟, 锚定 + 单调流逝, 日志时间前沿)；跨端照签发者 issuedAt/TTL 与 2 分钟偏差窗换算
    const at = (minutes: number) => new Date(Date.parse("2026-07-23T00:00:00.000Z") + minutes * 60_000).toISOString();
    const setup = async (name: string) => {
      const root = await createTempDir("ticket-clock-" + name);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const state = { now: at(0), monotonic: 1_000 };
      const clock = () => state.now;
      const binding = { ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" };
      const assignments = { dataPlaneBinding: async () => binding, dataPlaneBindings: vi.fn(async (requests: readonly unknown[]) => requests.map(() => binding)) };
      const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => undefined) } as unknown as AssignmentStreamSpool;
      const logRoot = path.join(root, "authority");
      const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 7));
      const logs: FileAuthorityCommitLog[] = [];
      const open = () => {
        const log = new FileAuthorityCommitLog(logRoot, artifacts, { clock, integrity });
        logs.push(log);
        return { log, registry: new DataPlaneTicketRegistry({ log, spool, clock, monotonicClock: () => state.monotonic, executorId: "executor-fixed", verifier: identity, assignments }) };
      };
      // 时间推进：墙钟改到给定分钟，单调钟只前进
      const wall = (minutes: number, elapsedMs = 1_000) => { state.now = at(minutes); state.monotonic += elapsedMs; };
      const authorize = (registry: DataPlaneTicketRegistry, id: string) =>
        registry.authorizeSurface(id, "observe", id + "-assignment", "surface:origin").then(() => "authorized", (error: Error) => error.message);
      const issue = (id: string, issuedMinute: number, expiryMinute: number) => ticket(id, id + "-assignment", at(issuedMinute), at(expiryMinute));
      const stopAll = async () => { for (const log of logs) await log.stopStorageMaintenance(); };
      return { open, wall, authorize, issue, stopAll };
    };

    // 公共前置：00:00 已接纳一张 00:05 到期的票据；新登记表 00:00 构造，墙钟前跳 00:10 才恢复（这张已过期、被排除）
    const forwardJumpRecovery = async (name: string) => {
      const fixture = await setup(name);
      const first = fixture.open();
      await first.registry.accept(fixture.issue("short", 0, 5));
      await first.log.stopStorageMaintenance();
      const cold = fixture.open();
      fixture.wall(10);
      await cold.registry.recover();
      return { fixture, cold };
    };

    it("(a) keeps a ticket that recovery skipped as expired rejected after the wall clock moves back, in the same process and after a cold reopen", async () => {
      for (const reopen of [false, true]) {
        const { fixture, cold } = await forwardJumpRecovery("a-" + reopen);
        let current = cold;
        if (reopen) await cold.log.stopStorageMaintenance();
        fixture.wall(1);
        if (reopen) { current = fixture.open(); await current.registry.recover(); }
        expect(await fixture.authorize(current.registry, "short")).toMatch(/retired/);
        await fixture.stopAll();
      }
    });

    it("(b) rejects a late old ticket on its first admission after the wall clock moves back", async () => {
      const { fixture, cold } = await forwardJumpRecovery("b");
      fixture.wall(1);
      // 同样 00:00 签发、00:05 到期、此前没送达：有效时间 00:10 下已过期，第一次接纳不给新窗口
      await cold.registry.accept(fixture.issue("late", 0, 5));
      expect(await fixture.authorize(cold.registry, "late")).toMatch(/retired/);
      await fixture.stopAll();
    });

    it("(c) admits a ticket issued at the effective time while the wall clock is behind, and keeps it usable after an immediate cold reopen", async () => {
      const { fixture, cold } = await forwardJumpRecovery("c");
      fixture.wall(1);
      await cold.registry.accept(fixture.issue("fresh", 10, 15));
      expect(await fixture.authorize(cold.registry, "fresh")).toBe("authorized");
      await cold.log.stopStorageMaintenance();
      const reopened = fixture.open();
      await reopened.registry.recover();
      expect(await fixture.authorize(reopened.registry, "fresh")).toBe("authorized");
      // 按有效时间起算的有效期：到 00:15 之后过期
      fixture.wall(1, 6 * 60_000);
      expect(await fixture.authorize(reopened.registry, "fresh")).toMatch(/retired/);
      await fixture.stopAll();
    });

    it("(d) treats a ticket issued on the moved-back wall clock the same hot and after a cold reopen", async () => {
      const { fixture, cold } = await forwardJumpRecovery("d");
      fixture.wall(1);
      // 00:01 签发、00:06 到期：有效时间 00:10 下超出偏差窗，接纳即判过期；冷重开后同样拒绝
      await cold.registry.accept(fixture.issue("skewed", 1, 6));
      expect(await fixture.authorize(cold.registry, "skewed")).toMatch(/retired/);
      await cold.log.stopStorageMaintenance();
      const reopened = fixture.open();
      await reopened.registry.recover();
      expect(await fixture.authorize(reopened.registry, "skewed")).toMatch(/retired|unknown/);
      await fixture.stopAll();
    });

    it("(e) keeps a ticket admitted at a later wall time usable after a stop and a cold reopen behind that time: the admission itself is the durable time evidence", async () => {
      const fixture = await setup("e");
      const first = fixture.open();
      // 没有恢复排除：墙钟前跳到 00:10 时接纳一张合法票据，这次接纳是唯一的时间证据
      fixture.wall(10);
      await first.registry.accept(fixture.issue("later", 10, 15));
      await first.log.stopStorageMaintenance();
      fixture.wall(1);
      const reopened = fixture.open();
      await reopened.registry.recover();
      expect(await fixture.authorize(reopened.registry, "later")).toBe("authorized");
      await fixture.stopAll();
    });

    it("(f) reads the log time frontier at each decision, not once per process", async () => {
      const fixture = await setup("f");
      const first = fixture.open();
      await first.registry.accept(fixture.issue("short", 0, 5));
      await first.log.stopStorageMaintenance();
      // 两个登记表实例共用一个日志：A 在 00:00 已读过时间前沿；B 在 00:10 接纳一张票据，时间前沿推进
      const shared = fixture.open();
      const other = new DataPlaneTicketRegistry({ log: shared.log, spool: { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => undefined) } as unknown as AssignmentStreamSpool,
        clock: () => at(10), monotonicClock: () => 5_000, executorId: "executor-fixed", verifier: identity,
        assignments: { dataPlaneBinding: async () => ({ ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" }), dataPlaneBindings: async (requests: readonly unknown[]) => requests.map(() => ({ ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" })) } });
      await shared.registry.recover();
      await other.accept(fixture.issue("later", 10, 15));
      // A 的墙钟仍在 00:01：下一次判定在锁内读到时间前沿 00:10，那张 00:05 到期的票据过期
      fixture.wall(1);
      expect(await fixture.authorize(shared.registry, "short")).toMatch(/retired/);
      await fixture.stopAll();
    });

    it("(g) advances the retirement frontier only on durable time evidence after an unrecorded forward jump", async () => {
      const fixture = await setup("g");
      const { registry, log } = fixture.open();
      const revoked = fixture.issue("revoked", 0, 5);
      await registry.accept(revoked);
      await registry.revoke({ assignmentId: revoked.assignmentId, ticketId: revoked.ticketId });
      // 进程内墙钟前跳三天（没有落盘的时间证据）后回拨：进程内棘轮超前于落盘证据，前沿步不能据它剪除
      fixture.wall(3 * 24 * 60);
      expect(await fixture.authorize(registry, "revoked")).toMatch(/retired/);
      fixture.wall(1);
      await expect(registry.maintain(undefined, 8, 8)).resolves.toBeGreaterThanOrEqual(0);
      expect(await fixture.authorize(registry, "revoked")).toMatch(/retired/);
      await log.stopStorageMaintenance();
    });
  });

  it("prunes one retention boundary in several steps and keeps not-yet-pruned tickets retired", async () => {
    const root = await createTempDir("ticket-frontier-steps");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let now = "2026-07-23T00:00:00.000Z", monotonic = 1_000;
    const clock = () => now;
    const binding = { ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" };
    const assignments = { dataPlaneBinding: async () => binding, dataPlaneBindings: vi.fn(async (requests: readonly unknown[]) => requests.map(() => binding)) };
    const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => undefined) } as unknown as AssignmentStreamSpool;
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { clock, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) });
    const registry = new DataPlaneTicketRegistry({ log, spool, clock, monotonicClock: () => monotonic, executorId: "executor-fixed", verifier: identity, assignments });
    const ids = Array.from({ length: 40 }, (_, index) => `same-${index}`);
    for (const id of ids) {
      const value = ticket(id, `assignment-${id}`, now, "2026-07-23T00:05:00.000Z");
      await registry.accept(value);
      await registry.revoke({ assignmentId: value.assignmentId, ticketId: value.ticketId });
    }
    now = "2026-07-25T00:00:00.000Z"; monotonic += 48 * 60 * 60 * 1_000;
    // 同一保留期的 40 张：一步只剪按次序的前 32 张，前沿停在第 32 张
    await registry.maintain(undefined, 0, 1);
    const ordered = [...ids].sort();
    const frontiers = await log.readStream<{ readonly throughTicketId?: string }>("executor:executor-fixed:data-plane-ticket-retirement-frontier");
    expect(frontiers.map(frontier => frontier.body.throughTicketId)).toEqual([ordered[31]]);
    await expect(registry.authorizeSurface(ordered[0]!, "observe", `assignment-${ordered[0]}`, "surface:origin")).rejects.toThrow(/unknown/);
    await expect(registry.authorizeSurface(ordered[32]!, "observe", `assignment-${ordered[32]}`, "surface:origin")).rejects.toThrow(/retired/);
    // 冷重开后按耐久前沿续做，剪完剩下的 8 张
    await log.stopStorageMaintenance();
    const cold = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { clock, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) });
    const reopened = new DataPlaneTicketRegistry({ log: cold, spool, clock, monotonicClock: () => monotonic, executorId: "executor-fixed", verifier: identity, assignments });
    await reopened.maintain(undefined, 0, 4);
    const after = await cold.readStream<{ readonly throughTicketId?: string }>("executor:executor-fixed:data-plane-ticket-retirement-frontier");
    expect(after.map(frontier => frontier.body.throughTicketId)).toEqual([ordered[31], ordered[39]]);
    await expect(reopened.authorizeSurface(ordered[39]!, "observe", `assignment-${ordered[39]}`, "surface:origin")).rejects.toThrow(/unknown/);
    await cold.stopStorageMaintenance();
  }, 120_000);
});
