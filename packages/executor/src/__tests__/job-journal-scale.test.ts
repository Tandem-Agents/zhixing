/**
 * 作业日志的规模对照：一个用户任务，当前状态固定（一个排队中的 run），只增加已结束（取消）的历史 run。
 * 正常停止后用新的日志实例冷开，分阶段计量全部文件读写：就绪准备与调度视图、第一次活动、持续操作、停止。
 * 第一次活动的完整成本是投递权威第一次协调（从起点同步投递流，属 C19）加上作业域的读写；
 * 前者单列为 delivery 阶段并照实输出，它随投递历史增长，本用例不证明它有界，只证明作业域各阶段有界。
 * 投影读量按投影与文件种类（清单、目录页、段数据、段偏移）分项输出，探测次数取自段偏移读取。
 * 原先第一次活动从起点重放整条作业流，作为对照。
 * 另一项只增加已全部汇总的错过 occurrence（经真实触发与汇总入口），证明冷读调度视图有界：连续失败只走非错过的 occurrence。
 * 再一项让全部 occurrence 共用同一计划时间（已取消，或已汇总的错过）：次序键含 id，倒扫逐条读，
 * 调度视图与历史分页读到的投影行数不随同时间组变大。
 * 连续失败两项（跨自动停用与重新启用的长串；同时间更早的一条插进已结束失败之前再失败）按投影行级读写计量：
 * 读写只落在连续失败摘要的定位路径上，树高相同的档位读写行数相同，树高随历史对数增长。
 */
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  AuthorityCacheIntegrity,
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileDurableProjectionIndex,
} from "@zhixing/core/authority";
import type { AuthorityCallContext, Signature, TaskDefinition } from "@zhixing/core/contracts";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import { canonicalize, protocolBytes, type ProtocolSignatureVerifier, type ProtocolSigner } from "@zhixing/core/protocol";
import { createOwnerDeliveryParticipant } from "@zhixing/owner-kernel/delivery";
import { listCurrentScheduleTaskIds } from "@zhixing/owner-kernel/global-mutation-commit-coordinator";
import { JobJournal, registerJobJournalProjection } from "@zhixing/owner-kernel/job-assignment";
import { JOB_RUN_STATE_PROJECTION_ID, openJobTaskIds } from "@zhixing/owner-kernel/job-run-state-index";
import { SCHEDULER_NOTICE_INDEX_PROJECTION_ID, SchedulerUserNoticeJournal } from "@zhixing/owner-kernel/scheduler-user-notices";
import { captureFileIo, createTempDir, defaultFileIoCategory, type FileIoSnapshot } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";

const TASK_ID = "task-scale";
/** 同树高的两档之间，一次插入可能多出的分裂行：每层至多一次，两层的树加新根至多 3 行。 */
const SPLIT_SLACK = 3;
const BASE = Date.parse("2026-07-15T00:00:00.000Z");
const at = (minute: number) => new Date(BASE + minute * 60_000).toISOString();
const NOW = at(0);

class TestIdentity implements ProtocolSigner, ProtocolSignatureVerifier {
  readonly #key = Buffer.from("job-journal-scale", "utf8");
  #nonce = 0;
  sign(schemaId: string, version: number, payload: unknown): Signature {
    const nonce = String(++this.#nonce);
    const mac = createHmac("sha256", this.#key).update(protocolBytes(schemaId, version, payload)).update("\0").update(nonce).digest("base64url");
    return { alg: "test-hmac-sha256", keyId: "test-owner", sig: `${nonce}.${mac}` };
  }
  verify(schemaId: string, version: number, payload: unknown, signature: Signature): void {
    const [nonce, encoded] = signature.sig.split(".");
    if (!nonce || !encoded) throw new Error("test signature invalid");
    const expected = createHmac("sha256", this.#key).update(protocolBytes(schemaId, version, payload)).update("\0").update(nonce).digest();
    const actual = Buffer.from(encoded, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("test signature invalid");
  }
}

const surface = (requestId: string): AuthorityCallContext => ({
  principal: { kind: "surface", surfacePrincipal: "surface:user-1", connectionId: "connection-1" },
  requestId, deadlineAt: "2030-01-01T00:00:00.000Z",
});

const definitionOf = (taskId: string, taskRevision = 1, state: TaskDefinition["state"] = "enabled"): TaskDefinition => ({
  taskId,
  taskRevision,
  state,
  definition: {
    kind: "user",
    spec: {
      name: "scaled work",
      enabled: state === "enabled",
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "do scaled work" },
      delivery: { kind: "none" },
    },
  },
});
const definition = definitionOf(TASK_ID);

/** 投影文件按“投影目录/文件种类”归类，其余沿用默认归类。 */
const categorize = (relative: string): string => {
  const category = defaultFileIoCategory(relative);
  if (category !== "projection") return category;
  const parts = relative.split("/");
  const directory = parts[parts.indexOf("projections") + 1] ?? "unknown";
  const file = parts.at(-1) ?? "";
  const kind = file === "manifest.json" ? "manifest"
    : file.startsWith("directory-") ? "directory"
    : file.endsWith(".offsets") ? "offsets"
    : file.endsWith(".data") ? "data"
    : file.startsWith("retirement-") ? "retirement"
    : "other";
  return `projection/${directory}/${kind}`;
};

const summary = (io: FileIoSnapshot) => {
  const projections = Object.entries(io.byCategory).filter(([category]) => category.startsWith("projection/"));
  return {
    readBytes: io.readBytes, reads: io.reads, writeBytes: io.writeBytes,
    log: io.byCategory.log?.readBytes ?? 0, checkpoint: io.byCategory.checkpoint?.readBytes ?? 0,
    projection: projections.reduce((sum, [, totals]) => sum + totals.readBytes, 0),
    projectionWrites: projections.reduce((sum, [, totals]) => sum + totals.writeBytes, 0),
    probes: io.segmentEntryProbes,
    byFile: Object.fromEntries(projections.filter(([, totals]) => totals.readBytes > 0)
      .map(([category, totals]) => [category.slice("projection/".length), [totals.readBytes, totals.reads]])),
  };
};
type Phase = ReturnType<typeof summary>;

/**
 * 持久投影的行级读写：按键读取的键数、扫描返回的行数、写入的行数（其中连续失败摘要的节点行）；
 * 同一段操作的真实文件读写字节由 io 分类给出（日志、各投影的清单/目录/段数据/段偏移）。
 */
function captureProjectionRows(io: Awaited<ReturnType<typeof captureFileIo>>) {
  const counts = { keys: 0, scanned: 0, written: 0, summaryWritten: 0, uncounted: 0 };
  const prototype = FileDurableProjectionIndex.prototype;
  const { scan, get, getMany, prepare } = prototype;
  const spies = [
    vi.spyOn(prototype, "scan").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      const page = await scan.apply(this, args);
      counts.scanned += page.entries.length;
      return page;
    }),
    vi.spyOn(prototype, "get").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      counts.keys += 1;
      return get.apply(this, args);
    }),
    vi.spyOn(prototype, "getMany").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      counts.keys += args[0].length;
      return getMany.apply(this, args);
    }),
    vi.spyOn(prototype, "prepare").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      const input = args[0];
      if (Array.isArray(input)) {
        counts.written += input.length;
        counts.summaryWritten += input.filter((mutation) => mutation.key.includes("/failureSummaryNodes/")).length;
      } else {
        // 已规范化的批次不透明：照实记下，不当作零
        counts.uncounted += 1;
      }
      return prepare.apply(this, args);
    }),
  ];
  return {
    take() {
      const value = { ...counts, io: summary(io.snapshot()) };
      counts.keys = counts.scanned = counts.written = counts.summaryWritten = counts.uncounted = 0;
      io.reset();
      return value;
    },
    restore() { for (const spy of spies) spy.mockRestore(); },
  };
}
type ProjectionRows = ReturnType<ReturnType<typeof captureProjectionRows>["take"]>;

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 手动触发的 run id：与生产同一算法（时间前缀 + 请求摘要），同一时间的次序由摘要决定。 */
function manualJobRunId(input: { readonly taskId: string; readonly requestId: string; readonly scheduledFor: string }): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Date.parse(input.scheduledFor), 0, 6);
  createHash("sha256").update(canonicalize(input)).digest().subarray(0, 10).copy(bytes, 6);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `jobrun-${encoded}`;
}

describe("job journal with a fixed current run and growing ended history", () => {
  it("keeps the job domain's cold preparation, first activity, sustained operations and stop within fixed bounds at 64 / 256 / 1024 / 2048 ended runs while full replay grows, reporting the delivery first sync separately", async () => {
    const rows: { ended: number; open: Phase; delivery: Phase; first: Phase; sustained: Phase; stop: Phase; fullReplay: Phase }[] = [];
    for (const ended of [64, 256, 1024, 2048]) {
      const root = await createTempDir("job-journal-scale-" + ended);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
      const logRoot = path.join(root, "authority");
      const identity = new TestIdentity();
      const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) };
      const participantFor = (log: FileAuthorityCommitLog) =>
        createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) });
      const journalFor = (log: FileAuthorityCommitLog, delivery = participantFor(log)) => new JobJournal({
        taskId: TASK_ID, anchorEpoch: 3, log, artifacts, signer: identity, verifier: identity,
        delivery,
        submission: { authenticate() {}, authorize() {} },
        ingress: { authorize() {} },
        snapshotFor: () => undefined,
        clock: () => NOW,
      });
      const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const journal = journalFor(log);
      await journal.define(definition, surface("define"));
      let minute = 0;
      const runOnce = async (target: JobJournal, cancel: boolean) => {
        minute += 1;
        const jobRunId = `job-run-${minute}`;
        await target.trigger({ jobRunId, scheduledFor: at(minute), context: surface(`trigger-${minute}`), source: "user" });
        if (cancel) await target.cancel({ jobRunId, requestId: `cancel-${minute}`, context: surface(`cancel-${minute}`) });
        return jobRunId;
      };
      for (let index = 0; index < ended; index++) await runOnce(journal, true);
      // 当前状态固定：一个排队中的 run
      const current = await runOnce(journal, false);
      await log.stopStorageMaintenance();

      const io = await captureFileIo(root, categorize);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const participant = participantFor(cold);
      const restarted = journalFor(cold, participant);
      await cold.prepareProjections([JOB_RUN_STATE_PROJECTION_ID]);
      const view = await restarted.schedulerReadView();
      const open = summary(io.snapshot());
      expect(view).toMatchObject({ runCount: ended + 1, consecutiveFailures: 0, last: { jobRunId: current, state: "queued" } });
      expect(view.open.map((occurrence) => occurrence.jobRunId)).toEqual([current]);
      // 投递权威第一次协调：从起点同步投递流（C19），单列
      io.reset();
      await participant.coordinate(async () => undefined);
      const delivery = summary(io.snapshot());
      // 第一次活动：取消当前 run，再排一个并取消
      io.reset();
      await restarted.cancel({ jobRunId: current, requestId: "cancel-current", context: surface("cancel-current") });
      await runOnce(restarted, true);
      const first = summary(io.snapshot());
      io.reset();
      for (let index = 0; index < 5; index++) await runOnce(restarted, true);
      const sustained = summary(io.snapshot());
      expect((await restarted.schedulerReadView()).runCount).toBe(ended + 7);
      io.reset();
      await cold.stopStorageMaintenance();
      const stop = summary(io.snapshot());

      // 对照：原先第一次活动从起点重放整条作业流
      io.reset();
      const reference = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      expect((await reference.readStream(`job:${TASK_ID}`)).length).toBeGreaterThan(ended * 2);
      const fullReplay = summary(io.snapshot());
      await reference.stopStorageMaintenance();
      rows.push({ ended, open, delivery, first, sustained, stop, fullReplay });
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      for (const phase of [row.open, row.first, row.sustained, row.stop]) expect(phase.checkpoint).toBe(0);
      // 冷开与作业操作都不补做整理或回放写入
      expect(row.open.projectionWrites).toBe(0);
      // 固定上界：只读根行、当前 run 与它的行、各目录的首页与最近一段倒序索引，键数与已结束的 run 数量无关。
      // 每个键在每段内二分查找，每次探测读 8 字节偏移、52 字节条目头与条目本身；基段至多 512 条即至多 9 次探测，
      // 一次查找至多经过 1 个基段和 4 个增量段。随历史变化的只有段填满前的探测次数与基段目录深度（对数），
      // 增量段个数随整理周期在 0～4 之间变化；清单是与历史无关的固定成本（分项见输出的 byFile）。
      expect(row.open.readBytes).toBeLessThanOrEqual(256 * 1024);
      expect(row.first.readBytes).toBeLessThanOrEqual(256 * 1024);
      expect(row.sustained.readBytes).toBeLessThanOrEqual(320 * 1024);
      expect(row.stop.readBytes).toBeLessThanOrEqual(64 * 1024);
      expect(row.stop.writeBytes).toBeLessThanOrEqual(128 * 1024);
    }
    const scale = (ended: number) => rows.find((row) => row.ended === ended)!;
    // 增长口径：已结束历史增 8 倍（256→2048），各阶段成本不超过 3 倍；线性增长会接近 8 倍。
    // 相邻档（1024→2048）的比值受段布局左右（增量段个数处在整理周期的哪一步、基段目录是否刚加深一层），区分不了有界与线性。
    for (const phase of ["open", "first", "sustained"] as const) {
      expect(scale(2048)[phase].readBytes).toBeLessThanOrEqual(scale(256)[phase].readBytes * 3);
      expect(scale(2048)[phase].reads).toBeLessThanOrEqual(scale(256)[phase].reads * 3);
      expect(scale(2048)[phase].probes).toBeLessThanOrEqual(scale(256)[phase].probes * 3);
    }
    expect(scale(2048).fullReplay.log).toBeGreaterThan(scale(1024).fullReplay.log * 1.8);
    expect(scale(2048).fullReplay.readBytes).toBeGreaterThan(10 * scale(2048).first.readBytes);
    // 投递权威第一次协调从起点同步投递流，读量随投递历史增长（C19）：delivery 阶段只照实输出，不在本用例的有界断言内
  }, 1_800_000);

  it("lists startup tasks from the current definition and open-work directories at 64 / 256 / 1024 deleted tasks", async () => {
    const rows: { deleted: number; list: Phase }[] = [];
    for (const deleted of [64, 256, 1024]) {
      const root = await createTempDir("job-startup-scale-" + deleted);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
      const logRoot = path.join(root, "authority");
      const identity = new TestIdentity();
      const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 9)) };
      const services = (log: FileAuthorityCommitLog) => ({
        anchorEpoch: 3, artifacts, verifier: identity,
        delivery: createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) }),
      });
      const journalFor = (log: FileAuthorityCommitLog, taskId: string) => new JobJournal({
        taskId, log, signer: identity, ...services(log),
        submission: { authenticate() {}, authorize() {} },
        ingress: { authorize() {} },
        snapshotFor: () => undefined,
        clock: () => NOW,
      });
      const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      // 定义目录与作业投影在写入前登记，写入时随提交维护
      await listCurrentScheduleTaskIds(log, artifacts);
      registerJobJournalProjection(log, services(log));
      for (let index = 0; index < deleted; index++) {
        const taskId = `task-deleted-${index}`;
        const journal = journalFor(log, taskId);
        await journal.define(definitionOf(taskId), surface(`define-${taskId}`));
        await journal.trigger({ jobRunId: `run-${taskId}`, scheduledFor: at(1), context: surface(`trigger-${taskId}`), source: "user" });
        await journal.cancel({ jobRunId: `run-${taskId}`, requestId: `cancel-${taskId}`, context: surface(`cancel-${taskId}`) });
        await journal.define(definitionOf(taskId, 2, "deleted"), surface(`delete-${taskId}`));
      }
      // 当前状态固定：一个空闲的当前任务，一个有排队 run 的当前任务
      await journalFor(log, "task-current-idle").define(definitionOf("task-current-idle"), surface("define-idle"));
      const busy = journalFor(log, "task-current-busy");
      await busy.define(definitionOf("task-current-busy"), surface("define-busy"));
      await busy.trigger({ jobRunId: "run-busy", scheduledFor: at(1), context: surface("trigger-busy"), source: "user" });
      await log.stopStorageMaintenance();

      const io = await captureFileIo(root, categorize);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      registerJobJournalProjection(cold, services(cold));
      const [current, open] = await Promise.all([listCurrentScheduleTaskIds(cold, artifacts), openJobTaskIds(cold)]);
      const list = summary(io.snapshot());
      expect([...current].sort()).toEqual(["task-current-busy", "task-current-idle"]);
      expect(open).toEqual(["task-current-busy"]);
      await cold.stopStorageMaintenance();
      rows.push({ deleted, list });
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      expect(row.list.checkpoint).toBe(0);
      expect(row.list.projectionWrites).toBe(0);
      // 只扫两个目录各自的几行；随总行数增长的只有段内二分的深度
      expect(row.list.readBytes).toBeLessThanOrEqual(160 * 1024);
    }
    const scale = (deleted: number) => rows.find((row) => row.deleted === deleted)!;
    expect(scale(1024).list.readBytes).toBeLessThanOrEqual(scale(256).list.readBytes * 1.5);
  }, 1_800_000);

  it("keeps the cold scheduler view bounded at 8 / 32 / 128 / 512 missed occurrences that were all summarized", async () => {
    const rows: { missed: number; view: Phase; consecutiveFailures: number; open: number; runCount: number }[] = [];
    for (const missed of [8, 32, 128, 512]) {
      const root = await createTempDir("job-missed-scale-" + missed);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
      const logRoot = path.join(root, "authority");
      const identity = new TestIdentity();
      const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) };
      const journalFor = (log: FileAuthorityCommitLog) => new JobJournal({
        taskId: TASK_ID, anchorEpoch: 3, log, artifacts, signer: identity, verifier: identity,
        delivery: createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) }),
        submission: { authenticate() {}, authorize() {} }, ingress: { authorize() {} }, snapshotFor: () => undefined, clock: () => NOW,
      });
      const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const journal = journalFor(log);
      await journal.define(definition, surface("define"));
      // 只有错过：每次经真实触发入口记为离线错过，随后全部完成汇总通知；当前义务为零
      for (let index = 0; index < missed; index++) {
        await journal.trigger({ jobRunId: `missed-${index}`, scheduledFor: at(index + 1), context: surface(`trigger-${index}`),
          source: "user", disposition: "missed-offline", missedNextFire: { readyBoundary: at(index + 1), nextFire: at(index + 2) } });
      }
      const notices = new SchedulerUserNoticeJournal({ log, delivery: createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) }) });
      await log.prepareProjections([SCHEDULER_NOTICE_INDEX_PROJECTION_ID]);
      await notices.prepareMissedSummaries([{ groupKey: "first-party", members: Array.from({ length: missed }, (_, index) => ({
        taskId: TASK_ID, jobRunId: `missed-${index}`, taskName: "scaled work", scheduledFor: at(index + 1) })) }], NOW);
      expect(await openJobTaskIds(log)).toEqual([]);
      await log.stopStorageMaintenance();

      const io = await captureFileIo(root, categorize);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const restarted = journalFor(cold);
      await cold.prepareProjections([JOB_RUN_STATE_PROJECTION_ID]);
      io.reset();
      const view = await restarted.schedulerReadView();
      rows.push({ missed, view: summary(io.snapshot()), consecutiveFailures: view.consecutiveFailures, open: view.open.length, runCount: view.runCount });
      // 历史分页仍能按原次序翻到全部错过
      expect((await restarted.occurrencesPage({ limit: 4 })).map((occurrence) => occurrence.jobRunId))
        .toEqual([missed - 1, missed - 2, missed - 3, missed - 4].map((index) => `missed-${index}`));
      await cold.stopStorageMaintenance();
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) expect(row).toMatchObject({ consecutiveFailures: 0, open: 0, runCount: 0 });
    // 连续失败只走非错过的 occurrence：读到的行数与错过历史无关，随历史变化的只有段与目录深度
    const scale = (missed: number) => rows.find((row) => row.missed === missed)!;
    expect(scale(512).view.readBytes).toBeLessThanOrEqual(scale(128).view.readBytes * 1.5);
    expect(scale(512).view.reads).toBeLessThanOrEqual(scale(128).view.reads * 1.5);
    expect(scale(512).view.probes).toBeLessThanOrEqual(scale(128).view.probes * 1.5);
  }, 600_000);

  it("reads a bounded number of projection rows for the cold scheduler view and history pages when 8 / 32 / 128 occurrences share one scheduled time, cancelled or missed and summarized", async () => {
    const rows: { kind: string; count: number; viewRows: number; pageRows: number; view: Phase }[] = [];
    for (const kind of ["cancelled", "missed"] as const) {
      for (const count of [8, 32, 128]) {
        const root = await createTempDir(`job-same-time-${kind}-${count}`);
        const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
        const logRoot = path.join(root, "authority");
        const identity = new TestIdentity();
        const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) };
        const journalFor = (log: FileAuthorityCommitLog) => new JobJournal({
          taskId: TASK_ID, anchorEpoch: 3, log, artifacts, signer: identity, verifier: identity,
          delivery: createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) }),
          submission: { authenticate() {}, authorize() {} }, ingress: { authorize() {} }, snapshotFor: () => undefined, clock: () => NOW,
        });
        const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
        const journal = journalFor(log);
        await journal.define(definition, surface("define"));
        const ids = Array.from({ length: count }, (_, index) => `same-${index}`);
        for (const [index, jobRunId] of ids.entries()) {
          if (kind === "cancelled") {
            await journal.trigger({ jobRunId, scheduledFor: at(1), context: surface(`trigger-${index}`), source: "user" });
            await journal.cancel({ jobRunId, requestId: `cancel-${index}`, context: surface(`cancel-${index}`) });
          } else {
            await journal.trigger({ jobRunId, scheduledFor: at(1), context: surface(`trigger-${index}`), source: "user",
              disposition: "missed-offline", missedNextFire: { readyBoundary: at(1), nextFire: at(2) } });
          }
        }
        if (kind === "missed") {
          const notices = new SchedulerUserNoticeJournal({ log, delivery: createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) }) });
          await log.prepareProjections([SCHEDULER_NOTICE_INDEX_PROJECTION_ID]);
          await notices.prepareMissedSummaries([{ groupKey: "first-party", members: ids.map((jobRunId) => ({
            taskId: TASK_ID, jobRunId, taskName: "scaled work", scheduledFor: at(1) })) }], NOW);
        }
        expect(await openJobTaskIds(log)).toEqual([]);
        await log.stopStorageMaintenance();

        const io = await captureFileIo(root, categorize);
        const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
        const restarted = journalFor(cold);
        await cold.prepareProjections([JOB_RUN_STATE_PROJECTION_ID]);
        // 计投影扫描实际返回的行数（含缺键重做），与审查方的口径相同
        let scanned = 0;
        const original = FileDurableProjectionIndex.prototype.scan;
        const spy = vi.spyOn(FileDurableProjectionIndex.prototype, "scan").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
          const page = await original.apply(this, args);
          scanned += page.entries.length;
          return page;
        });
        try {
          io.reset();
          const view = await restarted.schedulerReadView();
          const viewIo = summary(io.snapshot());
          const viewRows = scanned;
          // 完整次序：同一时间按 id 码元升序；倒序分页从 id 最大的起，游标落在组中间也接得上
          const newestFirst = [...ids].sort().reverse();
          expect(view).toMatchObject({ consecutiveFailures: 0, open: [] });
          if (kind === "cancelled") expect(view.last).toMatchObject({ jobRunId: newestFirst[0], state: "cancelled" });
          scanned = 0;
          const first = await restarted.occurrencesPage({ limit: 4 });
          const second = await restarted.occurrencesPage({ before: first.at(-1)!.jobRunId, limit: 4 });
          expect([...first, ...second].map((occurrence) => occurrence.jobRunId)).toEqual(newestFirst.slice(0, 8));
          rows.push({ kind, count, viewRows, pageRows: scanned, view: viewIo });
        } finally {
          spy.mockRestore();
        }
        await cold.stopStorageMaintenance();
      }
    }
    console.log(JSON.stringify(rows.map(({ kind, count, viewRows, pageRows, view }) => ({ kind, count, viewRows, pageRows, readBytes: view.readBytes, probes: view.probes, byFile: view.byFile }))));
    for (const kind of ["cancelled", "missed"]) {
      const scale = (count: number) => rows.find((row) => row.kind === kind && row.count === count)!;
      // 读到的行数由页大小决定，不随同时间组变大（改前整组装入：128 条读 243～486 行）
      for (const count of [8, 32, 128]) {
        expect(scale(count).viewRows).toBeLessThanOrEqual(64);
        expect(scale(count).pageRows).toBeLessThanOrEqual(64);
      }
      expect(scale(128).viewRows).toBeLessThanOrEqual(scale(32).viewRows);
      expect(scale(128).pageRows).toBeLessThanOrEqual(scale(32).pageRows);
    }
  }, 600_000);

  it("reads and writes a bounded number of projection rows for the cold scheduler view and the next failure after 8 / 40 / 128 failures that span automatic disable and re-enable", async () => {
    const rows: { failures: number; delivery: ProjectionRows; view: ProjectionRows; next: ProjectionRows; streak: number; nextCount: number | undefined }[] = [];
    for (const failures of [8, 40, 128]) {
      const root = await createTempDir("job-reenabled-failures-" + failures);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
      const logRoot = path.join(root, "authority");
      const identity = new TestIdentity();
      const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) };
      const participantFor = (log: FileAuthorityCommitLog) =>
        createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) });
      const journalFor = (log: FileAuthorityCommitLog, delivery = participantFor(log)) => new JobJournal({
        taskId: TASK_ID, anchorEpoch: 3, log, artifacts, signer: identity, verifier: identity, delivery,
        submission: { authenticate() {}, authorize() {} }, ingress: { authorize() {} }, snapshotFor: () => undefined, clock: () => NOW,
      });
      const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const journal = journalFor(log);
      let revision = 1;
      await journal.define(definition, surface("define"));
      // 连续失败到阈值时按正式流程自动停用、结清，用户随即重新启用；连续失败不被重新启用打断，一直累积
      const failOnce = async (target: JobJournal, index: number) => {
        const jobRunId = `failed-${index}`;
        await target.trigger({ jobRunId, scheduledFor: at(index + 1), context: surface(`trigger-${index}`), source: "user" });
        await target.failQueued(jobRunId);
        if ((await target.schedulerPolicy([jobRunId])).pendingAutoDisable.length) {
          await target.define(definitionOf(TASK_ID, ++revision, "disabled"), surface(`disable-${index}`));
          await target.settleSchedulerAutoDisable({ jobRunId, disabledTaskRevision: revision,
            context: { principal: { kind: "host" }, requestId: `settle-${index}` } as AuthorityCallContext });
          await target.define(definitionOf(TASK_ID, ++revision, "enabled"), surface(`enable-${index}`));
        }
        return jobRunId;
      };
      for (let index = 0; index < failures; index++) await failOnce(journal, index);
      expect(await openJobTaskIds(log)).toEqual([]);
      await log.stopStorageMaintenance();

      const io = await captureFileIo(root, categorize);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const participant = participantFor(cold);
      const restarted = journalFor(cold, participant);
      await cold.prepareProjections([JOB_RUN_STATE_PROJECTION_ID]);
      const counter = captureProjectionRows(io);
      // 投递权威第一次协调：从起点同步投递流（C19），单列，不计入下面的作业域操作
      await participant.coordinate(async () => undefined);
      const delivery = counter.take();
      try {
        const view = await restarted.schedulerReadView();
        const viewRows = counter.take();
        // 下一次失败（触发、失败、策略决定）：连续失败数由摘要的定位路径合成，不倒扫失败历史
        const next = await failOnce(restarted, failures);
        const nextRows = counter.take();
        const nextCount = (await restarted.schedulerPolicy([next])).failurePolicyByRun.get(next)?.failureCount;
        rows.push({ failures, delivery, view: viewRows, next: nextRows, streak: view.consecutiveFailures, nextCount });
      } finally {
        counter.restore();
      }
      await cold.stopStorageMaintenance();
    }
    console.log("REENABLED_FAILURE_ROWS", JSON.stringify(rows));
    for (const row of rows) expect(row).toMatchObject({ streak: row.failures, nextCount: row.failures + 1 });
    for (const row of rows) expect(row.view.uncounted + row.next.uncounted).toBe(0);
    const scale = (failures: number) => rows.find((row) => row.failures === failures)!;
    // 视图读根节点一行；40 与 128 档的摘要同为两层：读写行数相同，与连续失败历史无关
    expect(scale(128).view.keys + scale(128).view.scanned).toBeLessThanOrEqual(scale(8).view.keys + scale(8).view.scanned);
    expect(scale(128).next.keys + scale(128).next.scanned).toBeLessThanOrEqual(scale(40).next.keys + scale(40).next.scanned);
    expect(scale(128).next.written).toBeLessThanOrEqual(scale(40).next.written + SPLIT_SLACK);
  }, 600_000);

  it("reads and writes only the located summary path when a same-time earlier run lands among 4 / 12 / 40 / 128 ended failures and then fails", async () => {
    const rows: { ended: number; delivery: ProjectionRows; insert: ProjectionRows; fail: ProjectionRows; streak: number; ownCount: number | undefined; ms: number }[] = [];
    const generated = Array.from({ length: 129 }, (_, index) =>
      manualJobRunId({ taskId: TASK_ID, requestId: `fixture-${index}`, scheduledFor: NOW })).sort();
    // 完整次序里最早的一条：插入点在全部已结束失败之前
    const late = generated[0]!;
    for (const ended of [4, 12, 40, 128]) {
      const root = await createTempDir("job-late-same-time-" + ended);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
      const logRoot = path.join(root, "authority");
      const identity = new TestIdentity();
      const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) };
      const participantFor = (log: FileAuthorityCommitLog) =>
        createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) });
      const journalFor = (log: FileAuthorityCommitLog, delivery = participantFor(log)) => new JobJournal({
        taskId: TASK_ID, anchorEpoch: 3, log, artifacts, signer: identity, verifier: identity, delivery,
        submission: { authenticate() {}, authorize() {} }, ingress: { authorize() {} }, snapshotFor: () => undefined, clock: () => NOW,
      });
      const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const journal = journalFor(log);
      let revision = 1;
      await journal.define(definition, surface("define"));
      for (let index = 0; index < ended; index++) {
        const jobRunId = generated[index + 1]!;
        await journal.trigger({ jobRunId, scheduledFor: NOW, context: surface(`trigger-${index}`), source: "user" });
        await journal.failQueued(jobRunId);
        if ((await journal.schedulerPolicy([jobRunId])).pendingAutoDisable.length) {
          await journal.define(definitionOf(TASK_ID, ++revision, "disabled"), surface(`disable-${index}`));
          await journal.settleSchedulerAutoDisable({ jobRunId, disabledTaskRevision: revision,
            context: { principal: { kind: "host" }, requestId: `settle-${index}` } as AuthorityCallContext });
          await journal.define(definitionOf(TASK_ID, ++revision, "enabled"), surface(`enable-${index}`));
        }
      }
      expect(await openJobTaskIds(log)).toEqual([]);
      await log.stopStorageMaintenance();

      const io = await captureFileIo(root, categorize);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const participant = participantFor(cold);
      const restarted = journalFor(cold, participant);
      await cold.prepareProjections([JOB_RUN_STATE_PROJECTION_ID]);
      const counter = captureProjectionRows(io);
      // 投递权威第一次协调：从起点同步投递流（C19），单列，不计入下面的作业域操作
      await participant.coordinate(async () => undefined);
      const delivery = counter.take();
      try {
        const started = performance.now();
        await restarted.trigger({ jobRunId: late, scheduledFor: NOW, context: surface("late"), source: "user" });
        const insert = counter.take();
        await restarted.failQueued(late);
        const fail = counter.take();
        const ms = Math.round(performance.now() - started);
        counter.restore();
        const view = await restarted.schedulerReadView();
        const ownCount = (await restarted.schedulerPolicy([late])).failurePolicyByRun.get(late)?.failureCount;
        rows.push({ ended, delivery, insert, fail, streak: view.consecutiveFailures, ownCount, ms });
      } finally {
        counter.restore();
        await cold.stopStorageMaintenance();
      }
    }
    console.log("LATE_SAME_TIME_ROWS", JSON.stringify(rows));
    // 插在最早一端：之后的连续失败接上它，计数精确；它自己之前没有失败，策略计数为 1
    for (const row of rows) expect(row).toMatchObject({ streak: row.ended + 1, ownCount: 1 });
    for (const row of rows) expect(row.insert.uncounted + row.fail.uncounted).toBe(0);
    const scale = (ended: number) => rows.find((row) => row.ended === ended)!;
    // 4 与 12 档摘要一层、40 与 128 档两层：同层档位读写行数相同；插入只写定位路径，不改写已结束失败
    for (const [small, large] of [[4, 12], [40, 128]] as const) {
      for (const step of ["insert", "fail"] as const) {
        expect(scale(large)[step].keys + scale(large)[step].scanned).toBeLessThanOrEqual(scale(small)[step].keys + scale(small)[step].scanned);
        expect(scale(large)[step].written).toBeLessThanOrEqual(scale(small)[step].written + SPLIT_SLACK);
      }
    }
    for (const row of rows) expect(row.insert.summaryWritten + row.fail.summaryWritten).toBeLessThanOrEqual(2 * (2 + SPLIT_SLACK));
    // 失败一步在已装入路径的会话上：文件读写字节与已结束历史无关（插入一步是冷实例的第一次作业活动，
    // 按键点查的探测次数随段布局变化，与作业日志的冷开同一口径，见上面第一项用例）
    for (const row of rows) {
      expect(row.fail.io.readBytes).toBeLessThanOrEqual(scale(4).fail.io.readBytes * 1.5);
      expect(row.fail.io.writeBytes).toBeLessThanOrEqual(scale(4).fail.io.writeBytes * 1.5);
    }
  }, 600_000);
});
