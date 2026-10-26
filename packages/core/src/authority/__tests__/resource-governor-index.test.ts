/**
 * 调控器按键投影与整份内存投影的差分：同一串调控记录（含重放、非法记录与跨保留期），
 * 按键投影的接受/拒绝与逻辑状态都与整份投影（按同一前沿压缩）一致；物理清理前后逻辑状态不变，
 * 同名根换代后旧用量不会复活。
 */
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import type { GovernorRecord, ReservableResourceLease, ResourceLease, Signature } from "../../contracts/index.js";
import { canonicalize, protocolDigest } from "../../protocol/canonical.js";
import {
  applyGovernorRecordAt,
  cloneGovernorProjection,
  compactGovernorProjection,
  emptyGovernorProjection,
  type GovernorProjection,
} from "../../protocol/resource-governor.js";
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from "../index.js";
import { ResourceGovernorIndexStore, consumedUsageBlock, governorRetentionCutoff } from "../resource-governor-index.js";

const MAX_TTL = 24 * 60 * 60_000;
const signer = {
  sign(schemaId: string, version: number, payload: unknown): Signature {
    return { alg: "test-sha256", keyId: "executor-1", sig: protocolDigest(schemaId, version, payload) };
  },
};
const verifier = {
  verify(schemaId: string, version: number, payload: unknown, signature: Signature) {
    if (canonicalize(signature) !== canonicalize(signer.sign(schemaId, version, payload))) throw new TypeError("Signature mismatch");
  },
};

function signLease(payload: Omit<ResourceLease, "digest" | "signature"> & Record<string, unknown>): ReservableResourceLease {
  const withDigest = { ...payload, digest: protocolDigest("ResourceLease", 1, payload) };
  return { ...withDigest, signature: signer.sign("ResourceLease", 1, withDigest) } as ReservableResourceLease;
}

function rootLease(id: string, now: string, calls = 8, attempt = 1): ReservableResourceLease {
  return signLease({
    v: 1, reservationId: id, admissionClass: "interactive",
    workload: { kind: "control", id, attempt }, scopeBinding: { kind: "control", subject: id },
    audience: { executorId: "executor-1" }, budget: { maxCalls: calls },
    delegation: { executorId: "executor-1", maxDepth: 2, maxBudget: { maxCalls: calls } },
    domain: { kind: "anchor", anchorEpoch: 1 },
    issuedAt: now, expiry: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
  });
}

function childLease(parent: ResourceLease, id: string, calls: number): ReservableResourceLease {
  return signLease({
    v: 1, reservationId: id, parentId: parent.reservationId, parentDigest: parent.digest,
    admissionClass: parent.admissionClass, workload: { kind: "orchestration-node", id, attempt: 1 },
    scopeBinding: parent.scopeBinding, audience: { executorId: "executor-1" }, budget: { maxCalls: calls },
    domain: parent.domain, issuedAt: parent.issuedAt, expiry: parent.expiry,
  });
}

/** 确定的伪随机数，保证用例可复现。 */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

async function harness(root: string, clock: () => string) {
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts,
    { clock, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) });
  const store = new ResourceGovernorIndexStore(log, verifier, MAX_TTL, clock);
  return { log, store, artifacts };
}

/** 整份投影上的对照：按与按键投影相同的前沿压缩。 */
function compacted(state: GovernorProjection, cutoff: string): GovernorProjection {
  return compactGovernorProjection(cloneGovernorProjection(state), cutoff);
}

function normalize(state: GovernorProjection) {
  const sorted = <V>(map: ReadonlyMap<string, V>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  return canonicalize({
    reservations: sorted(state.reservations), leaseAcceptances: sorted(state.leaseAcceptances), usages: sorted(state.usages),
    nextUsageSeqByRoot: sorted(state.nextUsageSeqByRoot), usageReservations: sorted(state.usageReservations),
    queued: sorted(state.queued), queuedWorkloads: sorted(state.queuedWorkloads), queuedByWorkload: sorted(state.queuedByWorkload),
    dequeued: sorted(state.dequeued), dequeuedAt: sorted(state.dequeuedAt),
    admissionQueues: state.admissionQueues, admissionDeficits: state.admissionDeficits, admissionCursor: state.admissionCursor,
  } as never);
}

describe("resource governor keyed index", () => {
  it.each([1, 2, 3])("accepts, rejects and projects the same as the whole projection (seed %i)", async (seed) => {
    const root = await createTempDir("governor-index-diff-" + seed);
    let now = "2026-07-20T00:00:00.000Z";
    const { log, store } = await harness(root, () => now);
    const next = random(seed);
    let reference = emptyGovernorProjection();
    let frontier: string | undefined;
    const roots: ReservableResourceLease[] = [];
    const children: ReservableResourceLease[] = [];
    const usages: { usageId: string; root: string; reservation: string; calls: number }[] = [];
    let counter = 0, accepted = 0, rejected = 0;

    const attempt = async (body: GovernorRecord) => {
      const cutoff = governorRetentionCutoff(now, frontier);
      let expected: GovernorProjection | undefined;
      try {
        expected = applyGovernorRecordAt(compacted(reference, cutoff), structuredClone(body), now, MAX_TTL, verifier);
      } catch { expected = undefined; }
      let appended = true;
      try { await log.append([{ stream: "governor", body }]); } catch { appended = false; }
      expect(appended, `${body.t} ${canonicalize(body as never).slice(0, 120)}`).toBe(expected !== undefined);
      if (expected) { reference = expected; frontier = cutoff; accepted++; } else rejected++;
    };

    for (let step = 0; step < 160; step++) {
      // 偶尔跨过保留期，让早先结束的根过期
      if (step === 90) now = new Date(Date.parse(now) + 28 * 24 * 60 * 60_000).toISOString();
      now = new Date(Date.parse(now) + 60_000).toISOString();
      const choice = next();
      if (choice < 0.18 || roots.length === 0) {
        const lease = rootLease(`root-${counter++}`, now);
        await attempt({ t: "queued", reservationId: lease.reservationId, admissionClass: "interactive", workload: lease.workload });
        await attempt({ t: "reserve", lease });
        roots.push(lease);
      } else if (choice < 0.3) {
        const parent = next() < 0.7 ? roots[Math.floor(next() * roots.length)]! : children[Math.floor(next() * Math.max(1, children.length))] ?? roots[0]!;
        const child = childLease(parent, `child-${counter++}`, 1 + Math.floor(next() * 3));
        await attempt({ t: "reserve", lease: child });
        children.push(child);
      } else if (choice < 0.5) {
        const pool = [...roots, ...children];
        const lease = pool[Math.floor(next() * pool.length)]!;
        const rootId = lease.parentId === undefined ? lease.reservationId : reference.reservations.get(lease.reservationId)?.rootReservationId ?? lease.reservationId;
        const usage = { usageId: `usage-${counter++}`, root: rootId, reservation: lease.reservationId, calls: 1 };
        await attempt({ t: "usage-reserved", rootReservationId: usage.root, reservationId: usage.reservation, usageId: usage.usageId, calls: 1 });
        usages.push(usage);
      } else if (choice < 0.68 && usages.length) {
        const usage = usages[Math.floor(next() * usages.length)]!;
        const usageSeq = (reference.nextUsageSeqByRoot.get(usage.root) ?? 1) - (next() < 0.15 ? 1 : 0);
        await attempt({ t: "consume", usageSeq: Math.max(1, usageSeq), rootReservationId: usage.root, reservationId: usage.reservation, usageId: usage.usageId, calls: usage.calls });
      } else if (choice < 0.9) {
        const pool = [...children, ...roots];
        const lease = pool[Math.floor(next() * pool.length)]!;
        const kind = (["settle", "release", "reclaim"] as const)[Math.floor(next() * 3)]!;
        await attempt({ t: kind, reservationId: lease.reservationId });
      } else if (choice < 0.94) {
        // 仍有活动根的工作负载不能出队；已终结的可以
        const lease = roots[Math.floor(next() * roots.length)]!;
        await attempt({ t: "dequeue", workload: lease.workload, reason: "failed" });
      } else {
        const lease = rootLease(`queued-${counter++}`, now);
        await attempt({ t: "queued", reservationId: lease.reservationId, admissionClass: "interactive", workload: lease.workload });
        const reason = (["cancelled", "failed", "expired"] as const)[Math.floor(next() * 3)]!;
        await attempt({ t: "dequeue", workload: lease.workload, reason });
        await attempt({ t: "dequeue", workload: lease.workload, reason });
        await attempt({ t: "reserve", lease });
      }
      if (step % 40 === 39) {
        const actual = JSON.parse(normalize(await store.snapshot())), wanted = JSON.parse(normalize(compacted(reference, governorRetentionCutoff(now, frontier))));
        for (const section of Object.keys(wanted)) {
          if (canonicalize(actual[section]) !== canonicalize(wanted[section])) {
            const a = new Map((Array.isArray(actual[section]) ? actual[section] : []).map((e: [string, unknown]) => [e[0], canonicalize(e[1] as never)]));
            const w = new Map((Array.isArray(wanted[section]) ? wanted[section] : []).map((e: [string, unknown]) => [e[0], canonicalize(e[1] as never)]));
            const diff = [...new Set([...a.keys(), ...w.keys()])].filter(k => a.get(k) !== w.get(k)).slice(0, 3).map(k => ({ k, actual: a.get(k), wanted: w.get(k) }));
            console.log("DIFF", step, section, JSON.stringify(Array.isArray(wanted[section]) ? diff : { actual: actual[section], wanted: wanted[section] }).slice(0, 1500));
          }
        }
        expect(normalize(await store.snapshot())).toBe(normalize(compacted(reference, governorRetentionCutoff(now, frontier))));
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(10);
    const logical = normalize(await store.snapshot());
    // 物理清理分多步完成，前后逻辑状态不变
    for (let steps = 0; steps < 200 && await store.maintainRetention(8); steps++);
    expect(normalize(await store.snapshot())).toBe(logical);
    await log.stopStorageMaintenance();
  }, 240_000);

  it("reuses a session only while no other governor envelope has arrived", async () => {
    const root = await createTempDir("governor-index-session");
    const now = "2026-07-20T00:00:00.000Z";
    const { log, store } = await harness(root, () => now);
    const lease = rootLease("session-root", now, 8);
    await log.append([{ stream: "governor", body: { t: "queued", reservationId: "session-root", admissionClass: "interactive", workload: lease.workload } }]);
    await log.append([{ stream: "governor", body: { t: "reserve", lease } }]);
    const first = await store.refresh(undefined);
    await first.resolve((state) => state.reservations.get("session-root"));
    // 没有新的调控信封：沿用已装入的键
    expect(await store.refresh(first)).toBe(first);
    // 本会话自己的提交之后仍可沿用，并看到提交后的状态
    await store.transact(first, () => ({ kind: "append", entries: [{ stream: "governor",
      body: { t: "usage-reserved", rootReservationId: "session-root", reservationId: "session-root", usageId: "own", calls: 1 } }], value: undefined }));
    expect(await store.refresh(first)).toBe(first);
    expect(first.state.usageReservations.get("own")).toMatchObject({ state: "reserved" });
    // 别的写者追加了调控记录：换新会话，读到的是最新状态
    await log.append([{ stream: "governor", body: { t: "consume", usageSeq: 1, rootReservationId: "session-root", reservationId: "session-root", usageId: "own", calls: 1 } }]);
    const second = await store.refresh(first);
    expect(second).not.toBe(first);
    expect(await second.resolve((state) => state.usageReservations.get("own")?.state)).toBe("consumed");
    // 工作集达到上限后不再复用：进程内常驻的已装入键有界
    expect(await store.refresh(second)).toBe(second);
    for (let index = second.state.loadedKeys; index < 4096; index++) second.state.loadStored(`q:absent-${index}`, undefined);
    expect(await store.refresh(second)).not.toBe(second);
    await log.stopStorageMaintenance();
  }, 120_000);

  it("never resurrects an expired root's usage when its reservation id is reused", async () => {
    const root = await createTempDir("governor-index-reuse");
    let now = "2026-07-20T00:00:00.000Z";
    const { log, store } = await harness(root, () => now);
    const first = rootLease("reused", now, 4);
    const append = (body: GovernorRecord) => log.append([{ stream: "governor", body }]);
    await append({ t: "queued", reservationId: "reused", admissionClass: "interactive", workload: first.workload });
    await append({ t: "reserve", lease: first });
    await append({ t: "usage-reserved", rootReservationId: "reused", reservationId: "reused", usageId: "old-usage", calls: 2 });
    await append({ t: "consume", usageSeq: 1, rootReservationId: "reused", reservationId: "reused", usageId: "old-usage", calls: 2 });
    await append({ t: "release", reservationId: "reused" });
    now = new Date(Date.parse(now) + 28 * 24 * 60 * 60_000).toISOString();
    const second = rootLease("reused", now, 4, 1);
    await append({ t: "queued", reservationId: "reused", admissionClass: "interactive", workload: second.workload });
    await append({ t: "reserve", lease: second });
    const state = await store.snapshot();
    expect(state.reservations.get("reused")).toMatchObject({ state: "active", used: { calls: 0 } });
    expect(state.usages.has("old-usage")).toBe(false);
    expect(state.nextUsageSeqByRoot.has("reused")).toBe(false);
    // 新一代从序号 1 起，旧用量编号可以重新预留
    await append({ t: "usage-reserved", rootReservationId: "reused", reservationId: "reused", usageId: "old-usage", calls: 1 });
    await append({ t: "consume", usageSeq: 1, rootReservationId: "reused", reservationId: "reused", usageId: "old-usage", calls: 1 });
    expect((await store.snapshot()).reservations.get("reused")).toMatchObject({ used: { calls: 1 } });
    // 清理旧一代只删旧一代的行：新一代的根、用量、序号与用量块定位都保留
    const block = async () => (await store.session()).resolve((working) => consumedUsageBlock(working, "reused", 1, 1));
    expect((await block()).map(([id]) => id)).toEqual(["old-usage"]);
    for (let steps = 0; steps < 50 && await store.maintainRetention(1); steps++);
    const cleaned = await store.snapshot();
    expect(cleaned.reservations.get("reused")).toMatchObject({ state: "active", used: { calls: 1 } });
    expect(cleaned.usages.get("old-usage")).toMatchObject({ usageSeq: 1, usage: { calls: 1 } });
    expect(cleaned.nextUsageSeqByRoot.get("reused")).toBe(2);
    expect((await block()).map(([id, usage]) => [id, usage.usage.calls])).toEqual([["old-usage", 1]]);
    await log.stopStorageMaintenance();
  }, 120_000);

  it("keeps a reused root's new generation while cleanup runs in single-row steps across a cold reopen", async () => {
    const root = await createTempDir("governor-index-generation-steps");
    let now = "2026-07-20T00:00:00.000Z";
    const { log, store } = await harness(root, () => now);
    const record = (body: GovernorRecord) => ({ stream: "governor", body });
    const first = rootLease("reused", now, 4);
    // 旧一代的全部生命周期在一封信封里，同一工作集里装入、记账并释放
    const session = await store.refresh(undefined);
    await store.transact(session, () => ({ kind: "append", value: undefined, entries: [
      record({ t: "queued", reservationId: "reused", admissionClass: "interactive", workload: first.workload }), record({ t: "reserve", lease: first }),
      record({ t: "usage-reserved", rootReservationId: "reused", reservationId: "reused", usageId: "old", calls: 1 }),
      record({ t: "consume", usageSeq: 1, rootReservationId: "reused", reservationId: "reused", usageId: "old", calls: 1 }),
      record({ t: "release", reservationId: "reused" })] }));
    // 跨过保留期后，同名根以新租约换代并记账（前沿变了，会话随之换新）
    now = new Date(Date.parse(now) + 28 * 24 * 60 * 60_000).toISOString();
    const second = rootLease("reused", now, 4);
    const later = await store.refresh(session);
    await store.transact(later, () => ({ kind: "append", value: undefined, entries: [
      record({ t: "queued", reservationId: "reused", admissionClass: "interactive", workload: second.workload }), record({ t: "reserve", lease: second }),
      record({ t: "usage-reserved", rootReservationId: "reused", reservationId: "reused", usageId: "new", calls: 1 }),
      record({ t: "consume", usageSeq: 1, rootReservationId: "reused", reservationId: "reused", usageId: "new", calls: 1 })] }));
    // 清理每步只删一行，做一步后冷重开再续做
    expect(await store.maintainRetention(1)).toBe(true);
    await log.stopStorageMaintenance();
    const reopened = await harness(root, () => now);
    for (let steps = 0; steps < 50 && await reopened.store.maintainRetention(1); steps++);
    const state = await reopened.store.snapshot();
    expect(state.reservations.get("reused")).toMatchObject({ state: "active", used: { calls: 1 } });
    expect(state.reservations.get("reused")?.lease.digest).toBe(second.digest);
    expect(state.usages.get("new")).toMatchObject({ usageSeq: 1 });
    expect(state.usages.has("old")).toBe(false);
    expect((await (await reopened.store.session()).resolve((working) => consumedUsageBlock(working, "reused", 1, 1))).map(([id]) => id))
      .toEqual(["new"]);
    await reopened.log.stopStorageMaintenance();
  }, 120_000);
});
