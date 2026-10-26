/**
 * 资源调控器的规模对照：保留一个活动根（两条已结用量），只增加已结束的根（各带一条用量）。
 * 正常停止后冷开，分阶段计量全部文件读写：就绪准备、一次用量预留与结算加查询与回收巡检、停止。
 * 原先每次冷开整份回放调控流，作为对照。
 */
import path from "node:path";
import {
  AuthorityCacheIntegrity,
  FileArtifactStore,
  FileAuthorityCommitLog,
  RESOURCE_CAPABILITY_ACTIVATION_PROJECTION_ID,
  RESOURCE_GOVERNOR_INDEX_PROJECTION_ID,
} from "@zhixing/core/authority";
import type { AuthorityCallContext, GovernorRecord, ResourceLease, Signature } from "@zhixing/core/contracts";
import { protocolDigest, type ProtocolSigner } from "@zhixing/core/protocol";
import { captureFileIo, createTempDir, type FileIoSnapshot } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { ExecutorResourceGovernor } from "../resource-governor.js";

const NOW = "2026-07-20T00:00:00.000Z";
const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return { alg: "test-sha256", keyId: "device-1", sig: protocolDigest(schemaId, version, payload) };
  },
};
const verifier = {
  verify(schemaId: string, version: number, payload: unknown, signature: Signature) {
    if (signature.sig !== signer.sign(schemaId, version, payload).sig) throw new TypeError("Signature mismatch");
  },
};
const host: AuthorityCallContext = {
  principal: { kind: "host", component: "governor-scale" },
  requestId: "governor-scale", deadlineAt: "2026-07-20T00:00:30.000Z",
};

function historicalRoot(index: number): LogicalRecordBatch {
  const id = `history-${index}`;
  const payload = {
    v: 1, reservationId: id, admissionClass: "interactive", workload: { kind: "control", id, attempt: 1 },
    scopeBinding: { kind: "control", subject: id }, audience: { executorId: "executor-1" }, budget: { maxCalls: 4 },
    domain: { kind: "local", localDomainId: "local-1", localGovernorEpoch: 1 },
    issuedAt: NOW, expiry: "2026-07-20T01:00:00.000Z",
  };
  const withDigest = { ...payload, digest: protocolDigest("ResourceLease", 1, payload) };
  const lease = { ...withDigest, signature: signer.sign("ResourceLease", 1, withDigest) } as unknown as ResourceLease;
  const usageId = `usage-${index}`;
  const records: GovernorRecord[] = [
    { t: "queued", reservationId: id, admissionClass: "interactive", workload: lease.workload as never },
    { t: "reserve", lease: lease as never },
    { t: "usage-reserved", rootReservationId: id, reservationId: id, usageId, calls: 1 },
    { t: "consume", usageSeq: 1, rootReservationId: id, reservationId: id, usageId, calls: 1 },
    { t: "release", reservationId: id },
  ];
  return records.map((body) => ({ stream: "governor", body }));
}
type LogicalRecordBatch = { stream: string; body: GovernorRecord }[];

const summary = (io: FileIoSnapshot) => ({
  readBytes: io.readBytes, reads: io.reads, writeBytes: io.writeBytes, segmentEntryProbes: io.segmentEntryProbes,
  log: io.byCategory.log?.readBytes ?? 0, checkpoint: io.byCategory.checkpoint?.readBytes ?? 0,
  projection: io.byCategory.projection?.readBytes ?? 0, projectionWrites: io.byCategory.projection?.writeBytes ?? 0,
});
type Phase = ReturnType<typeof summary>;

describe("resource governor with one active root and growing ended history", () => {
  it("keeps cold preparation, governed operations and stop within fixed bounds at 64 / 256 / 1024 / 2048 ended roots while full replay grows", async () => {
    const rows: { ended: number; open: Phase; operate: Phase; sustained: Phase; stop: Phase; fullReplay: Phase }[] = [];
    for (const ended of [64, 256, 1024, 2048]) {
      const root = await createTempDir("governor-scale-" + ended);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
      const logRoot = path.join(root, "authority");
      const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 5)) };
      const governorFor = (log: FileAuthorityCommitLog) => new ExecutorResourceGovernor({
        log, signer, verifier, guard: { assert() {} }, executorId: "executor-1", localDomainId: "local-1",
        localGovernorEpoch: 1, leaseTtlMs: 60_000, clock: () => NOW,
      });
      const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const governor = governorFor(log);
      for (let index = 0; index < ended; index++) await log.append(historicalRoot(index));
      // 当前状态固定：一个活动根，两条已结用量
      const workload = { kind: "control", id: "active-root", attempt: 1 } as const;
      const lease = await governor.acquireRoot(workload, { maxCalls: 8 },
        { admissionClass: "interactive", entry: "conversation-input" }, host);
      for (const usageId of ["active-1", "active-2"]) {
        await governor.reserveUsage(lease, { usageId, calls: 1 }, host);
        await governor.consume(lease, { usageId, calls: 1 }, host);
      }
      await log.stopStorageMaintenance();

      const io = await captureFileIo(root);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const restarted = governorFor(cold);
      await cold.prepareProjections([RESOURCE_GOVERNOR_INDEX_PROJECTION_ID, RESOURCE_CAPABILITY_ACTIVATION_PROJECTION_ID]);
      const open = summary(io.snapshot());
      io.reset();
      await restarted.reserveUsage(lease, { usageId: "active-3", calls: 1 }, host);
      await restarted.consume(lease, { usageId: "active-3", calls: 1 }, host);
      await expect(restarted.inspectImmediateRoot(workload)).resolves.toMatchObject({ kind: "reservation", state: "active" });
      await expect(restarted.reclaimExpired()).resolves.toBe(0);
      const operate = summary(io.snapshot());
      // 同一进程内持续操作：会话在没有别的调控写者时复用，每次只读固定的键
      io.reset();
      for (let index = 4; index <= 8; index++) {
        await restarted.reserveUsage(lease, { usageId: `active-${index}`, calls: 1 }, host);
        await restarted.consume(lease, { usageId: `active-${index}`, calls: 1 }, host);
      }
      const sustained = summary(io.snapshot());
      expect((await restarted.snapshot()).reservations.get(lease.reservationId)).toMatchObject({ used: { calls: 8 } });
      io.reset();
      await cold.stopStorageMaintenance();
      const stop = summary(io.snapshot());

      // 对照：原先冷开时整份回放调控流
      io.reset();
      const reference = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      expect((await reference.readAll()).length).toBeGreaterThan(ended);
      const fullReplay = summary(io.snapshot());
      await reference.stopStorageMaintenance();
      rows.push({ ended, open, operate, sustained, stop, fullReplay });
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      for (const phase of [row.open, row.operate, row.sustained, row.stop]) expect(phase.checkpoint).toBe(0);
      // 冷开与调控操作都不补做整理或回放写入；停止只保存有界覆盖层
      expect(row.open.projectionWrites).toBe(0);
      expect(row.operate.projectionWrites).toBe(0);
      expect(row.sustained.projectionWrites).toBe(0);
      // 固定上界：只读当前根与它的行、固定的公平与索引页，与已结束的根数量无关
      expect(row.open.readBytes).toBeLessThanOrEqual(64 * 1024);
      expect(row.operate.readBytes).toBeLessThanOrEqual(128 * 1024);
      expect(row.sustained.readBytes).toBeLessThanOrEqual(128 * 1024);
      expect(row.stop.readBytes).toBeLessThanOrEqual(64 * 1024);
      expect(row.stop.writeBytes).toBeLessThanOrEqual(64 * 1024);
    }
    const at = (ended: number) => rows.find((row) => row.ended === ended)!;
    for (const phase of ["open", "operate", "sustained"] as const) {
      expect(at(2048)[phase].readBytes).toBeLessThanOrEqual(at(1024)[phase].readBytes * 1.5);
      expect(at(2048)[phase].reads).toBeLessThanOrEqual(at(1024)[phase].reads * 1.5);
    }
    expect(at(2048).fullReplay.log).toBeGreaterThan(at(1024).fullReplay.log * 1.8);
    expect(at(2048).fullReplay.readBytes).toBeGreaterThan(20 * at(2048).operate.readBytes);
  }, 900_000);
});
