import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  ForegroundActivity,
  holdForegroundObligation,
  type DeviceCapacityArbiterPort,
} from "@zhixing/core/resources";
import { projectionReadCapacity } from "./artifact-read-capacity.js";
import { AuthorityIdleMaintenance } from "./authority-idle-maintenance.js";

const GIB = 1024 ** 3;

interface Admission {
  readonly lane: string;
  readonly leaf: string;
  readonly serviceClass: string;
  readonly maxWaitMs: number;
}

/**
 * 与宿主同样装配的授权日志：真实仲裁器、存储维护治理与投影读准入。仲裁器逐条记下实际收到的准入请求，
 * 按发起方所在的调用链（前台追加 / 空闲维护）归类。
 */
async function hostLog(onAdmission?: (admission: Admission) => void) {
  const capacity = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * GIB, processRssBytes: 64 * 1024 ** 2, temporaryBytesAvailable: 8 * GIB }),
  });
  const lane = new AsyncLocalStorage<string>();
  const admissions: Admission[] = [];
  const arbiter: DeviceCapacityArbiterPort = {
    snapshot: () => capacity.snapshot(),
    acquire: (request, abort) => {
      const admission = {
        lane: lane.getStore() ?? "unattributed", leaf: request.admissionId.split(":")[0]!,
        serviceClass: request.serviceClass, maxWaitMs: request.maxWaitMs,
      };
      admissions.push(admission);
      onAdmission?.(admission);
      return capacity.acquire(request, abort);
    },
  };
  const root = await createTempDir("authority-idle-maintenance-capacity");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
    integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 41)),
    owner: true,
    storageMaintenance: new DefaultStorageMaintenanceGovernor({ capacity: arbiter }),
    runProjectionReadStep: projectionReadCapacity(arbiter),
  });
  onTestFinished(() => log.stopStorageMaintenance());
  log.durableProjection({
    projectionId: "idle-capacity", reducerVersion: 1, authenticated: true, inputs: { streams: ["control"] },
    reduce: (envelope: { lsn: number }) => [{ kind: "put" as const, key: `entry-${envelope.lsn}`, value: envelope.lsn }],
  });
  const append = (body: unknown) => lane.run("foreground", () => log.append([{ stream: "control", body }]));
  /** 真实空闲维护 owner 跑一轮；外包一层只为得知这一轮何时结束，等级语境与调用链不变。给出 afterRound 时等它也结束。 */
  const idleRound = (whenQuiet: (signal: AbortSignal) => Promise<void>, afterRound?: (signal: AbortSignal) => Promise<unknown>) => lane.run("idle", async () => {
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const errors: Error[] = [];
    const owner = new AuthorityIdleMaintenance({
      logs: [{
        maintainIdleProjections: async (betweenSteps, signal) => {
          try { await log.maintainIdleProjections(betweenSteps, signal); } finally { if (!afterRound) finished(); }
        },
      }],
      ...(afterRound ? { afterRound: async (signal: AbortSignal) => { try { await afterRound(signal); } finally { finished(); } } } : {}),
      whenQuiet, onError: (error) => errors.push(error), firstDelayMs: 0, intervalMs: 3_600_000,
    });
    owner.start();
    await done;
    await owner.stop();
    expect(errors).toEqual([]);
  });
  /** 给追平调用单独标注调用链，便于只看它发起的准入 */
  const catchUp = <T>(work: () => Promise<T>) => lane.run("catch-up", work);
  return { admissions, append, idleRound, catchUp, log };
}

const classes = (admissions: readonly Admission[]) => [...new Set(admissions.map((admission) => admission.serviceClass))];

it("空闲维护持锁的段落盘与段整理以后台等级准入，不冒充前台", async () => {
  const { admissions, append, idleRound } = await hostLog();
  const idle = () => admissions.filter((admission) => admission.lane === "idle");
  // 每轮先追加再空闲维护：每次落盘新增一个增量段，超过上限后同一轮里推进段整理
  for (let round = 0; round < 8 && !idle().some((admission) => admission.leaf === "storage-projection-compaction"); round++) {
    for (let n = 0; n < 3; n++) await append({ round, n });
    await idleRound(async () => undefined);
  }
  expect(idle().map((admission) => admission.leaf)).toEqual(expect.arrayContaining(["storage-projection-flush", "storage-projection-compaction"]));
  expect(classes(idle())).toEqual(["storage-background"]);
  expect(admissions.filter((admission) => admission.lane === "unattributed")).toEqual([]);
});

it("前台活动期间空闲维护不发起任何准入；前台追加照常完成，安静后空闲维护续做且仍为后台", async () => {
  const { admissions, append, idleRound } = await hostLog();
  for (let n = 0; n < 3; n++) await append({ n });
  const foreground = new ForegroundActivity();
  const leave = foreground.enter();
  const round = idleRound((signal) => foreground.whenQuiet(20, signal));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(admissions.filter((admission) => admission.lane === "idle")).toEqual([]);
  const mark = admissions.length;
  await append({ foreground: true });
  // 前台追加的持锁准入照旧：前台等级、零等待
  const arrived = admissions.slice(mark);
  expect(arrived.length).toBeGreaterThan(0);
  expect(arrived.map((admission) => [admission.lane, admission.serviceClass, admission.maxWaitMs]))
    .toEqual(arrived.map(() => ["foreground", "storage-foreground", 0]));
  leave();
  await round;
  const idle = admissions.filter((admission) => admission.lane === "idle");
  expect(idle.map((admission) => admission.leaf)).toContain("storage-projection-flush");
  expect(classes(idle)).toEqual(["storage-background"]);
});

it("空闲维护进行中前台到来：做完当时持锁的那一步即停在步边界，前台安静之后才续做（落盘与段整理）", async () => {
  const foreground = new ForegroundActivity();
  const timeline: { readonly event: string; readonly at: number }[] = [];
  let armed = false, arrival: Promise<void> | undefined, leftAt = Number.POSITIVE_INFINITY;
  let host!: Awaited<ReturnType<typeof hostLog>>;
  host = await hostLog((admission) => {
    if (!armed || admission.lane !== "idle" || !admission.leaf.startsWith("storage-")) return;
    timeline.push({ event: admission.leaf, at: performance.now() });
    if (arrival) return;
    // 空闲维护第一个持锁步骤准入时前台请求到达：登记前台活动、发起追加（排在这一步之后等锁），完成后仍活跃一段再离开
    const leave = foreground.enter();
    arrival = host.append({ arrived: true }).then(async () => {
      timeline.push({ event: "foreground-done", at: performance.now() });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }).finally(() => { leftAt = performance.now(); leave(); });
  });
  // 前四轮各新增一个增量段；第五轮落盘之后挂上段整理，这一轮在到达之后还有落盘与段整理步骤
  for (let round = 0; round < 4; round++) {
    for (let n = 0; n < 3; n++) await host.append({ round, n });
    await host.idleRound(async () => undefined);
  }
  for (let n = 0; n < 3; n++) await host.append({ round: 4, n });
  armed = true;
  await host.idleRound((signal) => foreground.whenQuiet(20, signal));
  await arrival;
  expect(timeline[1]?.event).toBe("foreground-done");
  const resumed = timeline.slice(2);
  expect(resumed.map((entry) => entry.event)).toEqual(expect.arrayContaining(["storage-projection-flush", "storage-projection-compaction"]));
  expect(resumed.filter((entry) => entry.at < leftAt)).toEqual([]);
  expect(classes(host.admissions.filter((admission) => admission.lane === "idle"))).toEqual(["storage-background"]);
});

it("运行的前台义务在模型调用期间让出：超过安静窗维护做完一小步；调用返回后不再开下一步，进行中的那一步照常完成、前台写入不等维护，义务结束后续做", async () => {
  const foreground = new ForegroundActivity();
  const obligation = holdForegroundObligation(foreground);
  const timeline: { readonly event: string; readonly at: number }[] = [];
  let armed = false, settled: Promise<void> | undefined, closedAt = Number.POSITIVE_INFINITY;
  const close = () => {
    if (closedAt !== Number.POSITIVE_INFINITY) return;
    closedAt = performance.now();
    obligation.close();
  };
  let host!: Awaited<ReturnType<typeof hostLog>>;
  host = await hostLog((admission) => {
    if (!armed || admission.lane !== "idle" || !admission.leaf.startsWith("storage-")) return;
    timeline.push({ event: admission.leaf, at: performance.now() });
    if (settled) return;
    // 维护第一个持锁步骤准入时模型调用返回：义务恢复，随即写入本轮结果（排在这一步之后等锁），写完仍持有一段再结束
    obligation.resume();
    settled = host.append({ settled: true }).then(async () => {
      timeline.push({ event: "foreground-done", at: performance.now() });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }).finally(close);
  });
  // 与前一用例同样备料：第五轮在第一步之后还有落盘与段整理步骤
  for (let round = 0; round < 4; round++) {
    for (let n = 0; n < 3; n++) await host.append({ round, n });
    await host.idleRound(async () => undefined);
  }
  for (let n = 0; n < 3; n++) await host.append({ round: 4, n });
  const idleCount = () => host.admissions.filter((admission) => admission.lane === "idle").length;
  const prepared = idleCount();
  armed = true;
  const round = host.idleRound((signal) => foreground.whenQuiet(20, signal));
  // 准备期义务持有：超过安静窗也不发起任何维护准入
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(idleCount()).toBe(prepared);
  // 模型调用开始：让出。让出失效时由兜底结束义务，交给下面的断言判失败，而不是互等到超时
  const pausedAt = performance.now();
  obligation.pause();
  const fallback = setTimeout(close, 2_000);
  await round;
  clearTimeout(fallback);
  await settled;
  expect(timeline[0]!.at).toBeGreaterThanOrEqual(pausedAt);
  expect(timeline[0]!.at).toBeLessThan(closedAt);
  // 进行中的那一步做完放锁，前台写入在义务结束前就完成
  expect(timeline[1]?.event).toBe("foreground-done");
  expect(timeline[1]!.at).toBeLessThan(closedAt);
  const resumed = timeline.slice(2);
  expect(resumed.map((entry) => entry.event)).toEqual(expect.arrayContaining(["storage-projection-flush", "storage-projection-compaction"]));
  expect(resumed.filter((entry) => entry.at < closedAt)).toEqual([]);
  expect(classes(host.admissions.filter((admission) => admission.lane === "idle"))).toEqual(["storage-background"]);
});

it("轮末追平经日志的空闲追平入口：持锁的投影准备以后台等级准入；直接调用准备仍按前台源操作准入", async () => {
  const idleEntry = await hostLog(), direct = await hostLog();
  for (const host of [idleEntry, direct]) for (let n = 0; n < 6; n++) await host.append({ n });
  await idleEntry.idleRound(async () => undefined,
    (signal) => idleEntry.catchUp(() => idleEntry.log.catchUpIdleProjections(["idle-capacity"], signal)));
  await direct.idleRound(async () => undefined,
    () => direct.catchUp(() => direct.log.prepareProjections(["idle-capacity"])));
  const caughtUp = (host: typeof idleEntry) => host.admissions.filter((admission) => admission.lane === "catch-up");
  expect(caughtUp(idleEntry).length).toBeGreaterThan(0);
  expect(classes(caughtUp(idleEntry))).toEqual(["storage-background"]);
  // 反例：同一后台轮里直接调用准备，持锁步骤按前台源操作准入——空闲入口才是后台边界
  expect(classes(caughtUp(direct))).toContain("storage-foreground");
});

it("中止之后空闲追平不再发起任何准入", async () => {
  const host = await hostLog();
  for (let n = 0; n < 6; n++) await host.append({ n });
  const abort = new AbortController(); abort.abort();
  const before = host.admissions.length;
  await host.catchUp(() => host.log.catchUpIdleProjections(["idle-capacity"], abort.signal));
  expect(host.admissions.slice(before)).toEqual([]);
});
