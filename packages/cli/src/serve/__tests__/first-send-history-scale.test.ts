// 增长探针：首发链的真实工作量不随目标会话已结束历史增长。两档只改变已结束运行数：同一配置、没有在飞或未完成的运行、
// 造数后经空闲维护与正常停止、再冷开（权威日志、投影与制品都从磁盘重新打开），经真实 manager 接纳与协议运行时走一次首发。
// 计量只取受测首发自己的日志阶段（含子阶段）里开始的授权操作，冷开阶段的操作即使晚到也不混入；关闭运行时确定性收齐汇总。
// 只支持受测路径（低层首次使用：本机执行端、夹具运行体，不走宿主的 runtime-prepare/host-ready/terminal-usable 边界），
// 不推出整个产品有界。
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { Message } from "@zhixing/core";
import { durableProjectionVersionDirectoryName } from "@zhixing/core/authority";
import { observeLogPhase, type LogRecordPort } from "@zhixing/core/logging";
import { ConversationRunJournal } from "@zhixing/owner-kernel/conversation-assignment";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import type { SessionRuntime } from "@zhixing/owner-kernel/types";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { executorIdForDevice } from "../executor-identity.js";
import { loadOrCreateDeviceKey } from "../mesh-device-key.js";
import {
  TEST_LOCAL_EXECUTOR, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, getOrCreateActiveConversation, expectSettled,
  MemorySecretStore,
} from "./conversation-protocol-runtime-fixture.js";

const CONVERSATION = "history-scale";
const MEASURED = "measured-first-send";
const METERS = ["operations", "scans", "readBytes", "segmentOpens", "segmentEntryReads", "directoryPageReads", "manifestReads", "preparedFrames", "recoveries", "lockAcquisitions"] as const;
type Row = { event?: string; refs?: { kind: string; id: string }[]; data?: Record<string, unknown> };

function completingRuntime(): SessionRuntime {
  return { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: CONVERSATION,
    async *run(messages) {
      const assistant: Message = { role: "assistant", content: [{ type: "text", text: "done" }] };
      const usage = { inputTokens: 0, outputTokens: 0 };
      return { agentResult: { reason: "completed" as const, message: assistant, usage },
        runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage },
        newMessages: [assistant], durationMs: 1 };
    }, abort: () => false, async dispose() {},
  };
}

async function open(home: string, secretStore: MemorySecretStore, records?: LogRecordPort) {
  // 与宿主相同的执行端身份：设备密钥在打开权威源之前已建立（宿主的 mesh 引导），执行端 id 由它派生（command.ts 同式）。
  // 不用夹具默认的 executor:local，否则权威源按设备派生 id 登记的执行端投影与执行端组件用的 id 不一致。
  const deviceKey = await loadOrCreateDeviceKey(secretStore);
  const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore, deviceKey, executorId: executorIdForDevice(deviceKey.deviceId),
    ...(records ? { records } : {}) });
  const runtime = completingRuntime();
  let manager!: ConversationManager;
  const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
    localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => runtime } } });
  // 恢复会推进提交投影：给 manager 提交投影的落点（同协议运行时通信用例），转录文件的追加成本不在本探针内
  manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {},
    appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "owner-log", appended: true }) });
  // 停止时日志刷出工作汇总（commit-log 停止路径），汇总因此确定性收齐
  const close = async () => { await protocol.stopRecoveryLoop(); await manager.disposeAll(); await authority.startupCleanup.run(); };
  return { authority, protocol, manager, close };
}

function recorder() {
  const rows: Row[] = [];
  const records: LogRecordPort = { record: (value) => { rows.push((typeof value === "function" ? value() : value) as Row); } };
  return { rows, records };
}

/** 受测阶段及其全部子阶段的引用 id：汇总按操作开始时捕获的阶段引用分桶。 */
function phaseScope(rows: readonly Row[], phase: string): Set<string> {
  const phaseId = (row: Row, kind: string) => row.refs?.find((ref) => ref.kind === kind)?.id;
  const root = rows.find((row) => row.event === "phaseStarted" && row.data?.phase === phase);
  const ids = new Set(root && phaseId(root, "phase") ? [phaseId(root, "phase")!] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      const id = row.event === "phaseStarted" ? phaseId(row, "phase") : undefined, parent = phaseId(row, "parentPhase");
      if (id && parent && ids.has(parent) && !ids.has(id)) { ids.add(id); grew = true; }
    }
  }
  return ids;
}
const inScope = (row: Row, ids: ReadonlySet<string>) => (row.refs ?? []).some((ref) => ref.kind === "phase" && ids.has(ref.id));

async function bytesUnder(root: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    total += entry.isDirectory() ? await bytesUnder(full) : (await fs.stat(full)).size;
  }
  return total;
}

const runtimeRoot = (home: string) => path.join(home, "distributed-runtime");
async function stored(home: string) {
  return {
    mainLog: (await fs.stat(path.join(runtimeRoot(home), "authority", "authority.log"))).size,
    executorLog: (await fs.stat(path.join(runtimeRoot(home), "executor-authority", "authority.log"))).size,
    artifacts: await bytesUnder(path.join(runtimeRoot(home), "artifacts")),
  };
}

/** 一本日志的身份取自它任一投影清单里的 logId（汇总按日志身份映射，不按报送先后对齐）。 */
async function logIdOf(projections: string): Promise<string | undefined> {
  for (const name of await fs.readdir(projections).catch(() => [] as string[])) {
    const text = await fs.readFile(path.join(projections, name, "manifest.json"), "utf8").catch(() => undefined);
    const id = text && /"logId":"([^"]+)"/u.exec(text)?.[1];
    if (id) return id;
  }
  return undefined;
}

/** 各投影当前视图的布局：增量段数与基础目录树高度（取自已发布清单），只读。 */
async function manifestLayout(root: string): Promise<Record<string, { deltas: number; baseHeight: number; retirement: boolean }>> {
  const layout: Record<string, { deltas: number; baseHeight: number; retirement: boolean }> = {};
  for (const name of (await fs.readdir(root).catch(() => [] as string[])).sort()) {
    const text = await fs.readFile(path.join(root, name, "manifest.json"), "utf8").catch(() => undefined);
    if (!text) continue;
    const manifest = JSON.parse(text) as { deltaSegments?: unknown[]; baseRoot?: { height?: number } | null; retirementRoot?: unknown; retirementCleanup?: unknown };
    // 待回收：整理后被替代的旧段已登记待删（清单 retirementRoot/retirementCleanup），首次读会触发至多两步回收
    layout[name.slice(0, 8) + name.slice(name.lastIndexOf("."))] = { deltas: manifest.deltaSegments?.length ?? 0, baseHeight: manifest.baseRoot?.height ?? 0,
      retirement: manifest.retirementRoot !== undefined || manifest.retirementCleanup !== undefined };
  }
  return layout;
}

async function manifestLsn(projections: string, projectionId: string, version: number): Promise<number | null> {
  const text = await fs.readFile(path.join(projections, durableProjectionVersionDirectoryName(projectionId, version), "manifest.json"), "utf8").catch(() => undefined);
  return text ? Number(/"lsn":(\d+)/u.exec(text)?.[1] ?? NaN) : null;
}

/** 空闲维护：两本日志各做几轮空闲投影维护（落盘、并段），到生产里安静期之后可达的状态。 */
async function maintain(authority: Awaited<ReturnType<typeof setupAuthorityRuntime>>) {
  const signal = new AbortController().signal;
  for (const log of [authority.authorityLog, authority.executorLog]) {
    for (let round = 0; round < 3; round++) await log.maintainIdleProjections(async () => undefined, signal);
  }
}

/** 冷开后在独立日志阶段里经真实接纳走一次首发；返回阶段内的汇总、推迟与落盘增量。 */
async function measuredFirstSend(home: string, secretStore: MemorySecretStore) {
  const { rows, records } = recorder();
  const cold = await open(home, secretStore, records);
  const executorId = cold.authority.executorId;
  const managed = await cold.manager.getOrCreate(CONVERSATION);
  const before = await stored(home);
  const options = { source: "interactive" as const, surfacePrincipal: "rpc:owner", turnContext: { turnId: "measured" } };
  await observeLogPhase(records, MEASURED, async () => {
    const admitted = await cold.manager.admitTurn({
      conversationId: CONVERSATION, source: "interactive",
      beforeEnqueue: (session) => cold.manager.admitDurableTurn({ conversationId: session.conversationId, input: "measured",
        invocation: { kind: "agent", source: "interactive" }, surfacePrincipal: "rpc:owner", options }),
      makeTask: () => ({ source: "interactive", cancel: () => {},
        execute: async () => {
          try {
            expectSettled(await projectSessionTurn({ manager: cold.manager, managed, text: "measured", turnId: "measured",
              runOptions: options, notify: () => {} }));
          } finally { cold.manager.setBusy(CONVERSATION, false); }
        } }),
    });
    if (admitted.status !== "immediate") throw new Error(`unexpected admission ${admitted.status}`);
    await admitted.task.execute();
  });
  const after = await stored(home);
  await cold.close();

  const scope = phaseScope(rows, MEASURED);
  const logs = new Map([[await logIdOf(path.join(runtimeRoot(home), "authority", "projections")), "main"],
    [await logIdOf(path.join(runtimeRoot(home), "executor-authority", "projections")), "executor"]]);
  const work: Record<string, Record<string, number>> = {};
  let outside = 0;
  for (const row of rows) {
    // 草稿不带来源（来源在日志库登记时补上），这里只有授权观测写入工作汇总
    if (row.event !== "work") continue;
    if (!inScope(row, scope)) { outside++; continue; }
    const log = logs.get((row.refs ?? []).find((ref) => ref.kind === "authority")?.id) ?? "other";
    const entry = work[`${log}:${String(row.data?.operation)}`] ??= Object.fromEntries(METERS.map((meter) => [meter, 0]));
    for (const meter of METERS) entry[meter]! += Number(row.data?.[meter] ?? 0);
  }
  const deferred = rows.filter((row) => row.event === "deferred" && inScope(row, scope)).map((row) => ({
    log: logs.get((row.refs ?? []).find((ref) => ref.kind === "authority")?.id) ?? "other",
    operation: row.data?.operation, blockedBy: row.data?.blockedBy, reason: row.data?.reason,
    requiredLsn: row.data?.requiredLsn, projections: row.data?.projections }));
  // 按来源归组：每行汇总取其所带阶段引用的阶段名（治理候选等待、协调、协调重做或其他），分开读盘、身份核对与等待
  const phaseNames = new Map(rows.filter((row) => row.event === "phaseStarted").map((row) => [row.refs?.find((ref) => ref.kind === "phase")?.id, String(row.data?.phase)]));
  const bySource: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    if (row.event !== "work" || !inScope(row, scope)) continue;
    const phase = phaseNames.get((row.refs ?? []).find((ref) => ref.kind === "phase")?.id) ?? "?";
    const source = phase.startsWith("resource-governor.") ? phase.slice("resource-governor.".length) : "other";
    const log = logs.get((row.refs ?? []).find((ref) => ref.kind === "authority")?.id) ?? "other";
    const entry = bySource[`${log}:${String(row.data?.operation)}:${source}`] ??= {};
    for (const meter of ["operations", "segmentOpens", "segmentVerifies", "queueMs", "lockWaitMs", "executionMs"]) entry[meter] = (entry[meter] ?? 0) + Number(row.data?.[meter] ?? 0);
  }
  const finished = rows.find((row) => row.event === "phaseFinished" && row.data?.phase === MEASURED);
  // 受测阶段期间（按记录先后）不带任何阶段引用的授权工作：后台续跑等前台之外的实际成本，单列报告、不参与比较
  const opened = rows.findIndex((row) => row.event === "phaseStarted" && row.data?.phase === MEASURED);
  const closed = finished ? rows.indexOf(finished) : rows.length;
  const background: Record<string, Record<string, number>> = {};
  for (const row of rows.slice(Math.max(0, opened), closed + 1)) {
    if (row.event !== "work" || (row.refs ?? []).some((ref) => ref.kind === "phase")) continue;
    const log = logs.get((row.refs ?? []).find((ref) => ref.kind === "authority")?.id) ?? "other";
    const entry = background[`${log}:${String(row.data?.operation)}`] ??= {};
    for (const meter of ["operations", "segmentEntryReads", "executionMs"]) entry[meter] = (entry[meter] ?? 0) + Number(row.data?.[meter] ?? 0);
  }
  // 受测阶段内的其他授权事件（回收、维护、首次打开等）按事件名计数：用来按来源解释随时序浮动的操作次数
  const events: Record<string, number> = {};
  for (const row of rows) {
    if (!row.event || ["work", "deferred", "phaseStarted", "phaseFinished", "phaseProgress"].includes(row.event) || !inScope(row, scope)) continue;
    events[row.event] = (events[row.event] ?? 0) + 1;
  }
  return {
    executorId, phases: scope.size, outsideWorkRows: outside, deferred, bySource, events, background,
    // 受测首发阶段的墙钟与授权实际读字节合计：与重做、批读次数一起看，确认减量是真的、多读的兄弟键没有吃掉收益
    durationMs: Number(finished?.data?.durationMs ?? NaN),
    readBytes: Object.values(work).reduce((total, value) => total + (value.readBytes ?? 0), 0),
    work: Object.fromEntries(Object.entries(work).sort(([a], [b]) => a.localeCompare(b))),
    stored: { mainLog: after.mainLog - before.mainLog, executorLog: after.executorLog - before.executorLog, artifacts: after.artifacts - before.artifacts },
  };
}

async function seedHistory(home: string, secretStore: MemorySecretStore, history: number, options: { maintain: boolean; recover: boolean }) {
  const seed = await open(home, secretStore);
  const managed = await getOrCreateActiveConversation(seed.authority, seed.manager, CONVERSATION);
  // 借首发链上每次都会调用的 runState 取到本会话的运行日志实例（照常执行，只记 this），用来核补恢复前后的未完成义务
  const runState = vi.spyOn(ConversationRunJournal.prototype, "runState");
  for (let n = 0; n < history; n++) {
    expectSettled(await projectSessionTurn({ manager: seed.manager, managed, text: `history ${n}`, turnId: `history-${n}`,
      runOptions: { source: "interactive", turnContext: { turnId: `history-${n}` } }, notify: () => {} }));
  }
  const journal = runState.mock.contexts.at(-1) as ConversationRunJournal;
  runState.mockRestore();
  if (options.recover) {
    // 生产的恢复循环会记下执行端的捆绑确认（bundle-ack-observed），已提交运行随之离开恢复候选。造数时没有这个循环，
    // 每个已结束运行都还等着回执；补一次真实恢复，并核回执确实闭合（候选由确认带走，不是被删）。两档受测时未完成状态都为零，只差已结束历史
    expect((await journal.assignmentsAwaitingRecovery()).map((candidate) => candidate.state)).toEqual(Array(history).fill("committed"));
    await seed.protocol.recoverConversation(CONVERSATION);
    expect(await journal.assignmentsAwaitingRecovery()).toEqual([]);
  }
  const executorId = seed.authority.executorId;
  if (options.maintain) await maintain(seed.authority);
  const executorHead = (await seed.authority.executorLog.checkpoint()).lsn;
  await seed.close();
  return { executorId, executorHead };
}

async function measure(history: number) {
  const home = await createTempDir(`first-send-history-${history}`);
  const secretStore = new MemorySecretStore();
  await seedHistory(home, secretStore, history, { maintain: true, recover: true });
  const layout = {
    main: await manifestLayout(path.join(runtimeRoot(home), "authority", "projections")),
    executor: await manifestLayout(path.join(runtimeRoot(home), "executor-authority", "projections")),
  };
  return { layout, ...await measuredFirstSend(home, secretStore) };
}

const sum = (work: Record<string, Record<string, number>>, meter: string, log?: string) =>
  Object.entries(work).filter(([key]) => !log || key.startsWith(`${log}:`)).reduce((total, [, value]) => total + (value[meter] ?? 0), 0);

it("keeps the first send's authority work bounded at 8 and 48 finished runs", async () => {
  const small = await measure(8);
  const large = await measure(48);
  console.log(`first-send history scale report\n${JSON.stringify({ small, large })}`);
  // 计量必须真的采到，且两本日志都在受测阶段里出现
  expect(sum(small.work, "operations", "main")).toBeGreaterThan(0);
  expect(sum(small.work, "operations", "executor")).toBeGreaterThan(0);
  // 每本日志每种操作的次数、扫描次数、准备帧与恢复不随已结束历史变化（准备帧相等即没有从日志开头重放派生状态）。
  // 帧索引写入在追加后定时 1 s 刷出（commit-log FRAME_INDEX_FLUSH_DELAY_MS），受测阶段长于 1 s 时落入阶段，与历史无关，不参与比较
  // 回收：整理过的投影在清单里登记了待回收的旧段（债务可随被替代的基础树变大），经源锁记作 projection.checkpoint。
  // 前台只付一段债务的首个触发（durable-projection-index.ts MAX_RETIREMENT_TRANSITIONS_PER_TRIGGER=2，每步至多 64 个文件、64 KiB）；
  // 之后后台续跑已接管，前台读不再各付一份，续跑在调用者的日志阶段之外推进，不计入受测阶段。
  // 所以受测阶段内两档之差按各档带待回收项的投影数 ×2 为界，单列核对，不参与逐项相等（窗口内新的整理发布会开新一段债务、各再付一次首个触发，这个界不覆盖那种情形）
  const timed = new Set(["main:maintainFrameIndex", "executor:maintainFrameIndex", "main:projection.checkpoint", "executor:projection.checkpoint"]);
  const counted = (work: Record<string, Record<string, number>>, meter: string) =>
    Object.fromEntries(Object.entries(work).filter(([key]) => !timed.has(key)).map(([key, value]) => [key, value[meter]]));
  for (const meter of ["operations", "scans", "preparedFrames", "recoveries"]) {
    expect(counted(large.work, meter), meter).toEqual(counted(small.work, meter));
  }
  const retirementSteps = (tier: typeof small, log: "main" | "executor") =>
    2 * Object.values(tier.layout[log]).filter((value) => value.retirement).length;
  for (const log of ["main", "executor"] as const) {
    const key = `${log}:projection.checkpoint`;
    const extra = (large.work[key]?.operations ?? 0) - (small.work[key]?.operations ?? 0);
    expect(extra, key).toBeLessThanOrEqual(retirementSteps(large, log));
    expect(extra, key).toBeGreaterThanOrEqual(-retirementSteps(small, log));
  }
  // 段访问：当前视图的增量段受上限约束（durable-projection-index.ts MAX_DELTA_SEGMENTS=4）；基础段是按目录树按键定位的，
  // 树高只记录、不当上限（合法的基础树会随数据变大）。本夹具大档各投影停在增量上限，属夹具布局，不是产品不变量
  for (const tier of [small, large]) {
    for (const layout of [tier.layout.main, tier.layout.executor]) {
      for (const [projection, value] of Object.entries(layout)) expect(value.deltas, projection).toBeLessThanOrEqual(4);
    }
  }
  // 实际读字节与落盘增量只允许 LSN 等编码位数造成的几十字节差，不允许随历史成比例增长
  for (const log of ["main", "executor"]) expect(Math.abs(sum(large.work, "readBytes", log) - sum(small.work, "readBytes", log)), log).toBeLessThanOrEqual(128);
  for (const field of ["mainLog", "executorLog", "artifacts"] as const) expect(Math.abs(large.stored[field] - small.stored[field]), field).toBeLessThanOrEqual(128);
}, 300_000);

it("adopts the executor's own projections published by the home's first process instead of replaying them from the start", async () => {
  const home = await createTempDir("first-send-first-process");
  const secretStore = new MemorySecretStore();
  // 全新 home 的第一个进程（设备密钥由引导先建立，同宿主）：不做任何主动维护，直接正常停止——发布只能来自停止路径本身
  const seed = await seedHistory(home, secretStore, 12, { maintain: false, recover: false });
  const projections = path.join(runtimeRoot(home), "executor-authority", "projections");
  const published = {
    leaseClock: await manifestLsn(projections, `executor-lease-clock-v1:${seed.executorId}`, 1),
    ticketRegistry: await manifestLsn(projections, `data-plane-ticket-registry-v1:${seed.executorId}`, 3),
  };
  const cold = await measuredFirstSend(home, secretStore);
  console.log(`first-process registration report\n${JSON.stringify({ seed, published, cold: { executorId: cold.executorId, deferred: cold.deferred, prepare: cold.work["executor:projection.prepare"] } })}`);
  expect(cold.executorId).toBe(seed.executorId);
  // 停止后两个执行端投影都已发布，离日志头只差有界尾部（日志硬尾上限 256 帧）
  for (const position of [published.leaseClock, published.ticketRegistry]) {
    expect(position).not.toBeNull();
    expect(seed.executorHead - position!).toBeLessThanOrEqual(256);
  }
  // 冷开首发只续这段有界尾部，不把它们从日志开头重放
  expect(cold.deferred.filter((item) => JSON.stringify(item.projections ?? []).includes("@0"))).toEqual([]);
  expect(cold.work["executor:projection.prepare"]?.preparedFrames ?? 0).toBeLessThanOrEqual(256);
}, 300_000);
