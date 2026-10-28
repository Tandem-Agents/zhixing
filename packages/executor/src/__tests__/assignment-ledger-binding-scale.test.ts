/**
 * 派发账本冷读的规模对照：当前固定为一个已接收的对话派发，只增加已结束的派发（经公开派发入口
 * 被拒，写下控制与拒绝记录）。冷实例上分别计量为它恢复数据面绑定、启动恢复发现待执行派发的全部
 * 文件读取：只读领域索引里这个派发自己的行与对话恢复候选目录，读量随索引深度而不随已结束派发增长。
 * 按流从起点重放、整读日志（旧做法）随历史线性增长，作为对照。
 */
import path from "node:path";
import { AuthorityCacheIntegrity, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { createSignedConversationEnvelope } from "@zhixing/core/protocol";
import { captureFileIo, defaultFileIoCategory, type FileIoSnapshot } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AuthenticatedFrameIndex } from "../../../core/src/authority/frame-index.js";
import { ConversationAssignmentLedger } from "../assignment-ledger.js";
import { ExecutorResourceGovernor } from "../resource-governor.js";
import {
  ASSIGNMENT_ID,
  EXECUTOR_ID,
  NOW,
  createFormalReceiptHarness,
  createUnsignedEnvelope,
  matchingPermissionSnapshotFor,
  matchingSnapshotFor,
  ownerContext,
  ownerControl,
} from "./assignment-ledger-fixture.js";

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
    : "other";
  return `projection/${directory}/${kind}`;
};

const summary = (io: FileIoSnapshot) => {
  const projections = Object.entries(io.byCategory).filter(([category]) => category.startsWith("projection/"));
  return {
    readBytes: io.readBytes, reads: io.reads, writeBytes: io.writeBytes,
    log: io.byCategory.log?.readBytes ?? 0, frameIndex: io.byCategory["frame-index"]?.readBytes ?? 0,
    checkpoint: io.byCategory.checkpoint?.readBytes ?? 0,
    projection: projections.reduce((sum, [, totals]) => sum + totals.readBytes, 0),
    probes: io.segmentEntryProbes,
    byFile: Object.fromEntries(projections.filter(([, totals]) => totals.readBytes > 0)
      .map(([category, totals]) => [category.slice("projection/".length), [totals.readBytes, totals.reads]])),
  };
};
type Phase = ReturnType<typeof summary>;

describe("assignment ledger cold reads with fixed current work and growing ended assignments", () => {
  it("bounds binding recovery and recovery discovery by index depth at 64 / 256 / 1024 ended assignments while full reads grow", async () => {
    const rows: { ended: number; binding: Phase; discovery: Phase; streamReplay: Phase; wholeLog: Phase }[] = [];
    for (const ended of [64, 256, 1024]) {
      const h = await createFormalReceiptHarness({ startupProofs: true, monotonicClock: () => 0 });
      const logRoot = path.join(h.root, "formal-executor");
      const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 5));
      // 已结束历史：每个派发经公开入口接受控制后因激活证明不匹配被拒
      for (let index = 0; index < ended; index++) {
        const assignmentId = `ended-${index}`;
        const envelope = createSignedConversationEnvelope(
          createUnsignedEnvelope(h.identity, { assignmentId, runId: `run-ended-${index}` }), h.identity, h.identity);
        expect(await h.ledger.dispatch(envelope, h.activation, ownerContext(assignmentId, "executor.dispatch")))
          .toMatchObject({ accepted: false });
      }
      // 当前固定：一个已接收、尚未执行的对话派发
      expect(await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"))).toMatchObject({ accepted: true });
      await h.log.stopStorageMaintenance();

      const io = await captureFileIo(h.root, categorize);
      const coldLedger = () => {
        const cold = new FileAuthorityCommitLog(logRoot, h.artifacts, { clock: () => NOW, integrity });
        onTestFinished(() => cold.stopStorageMaintenance());
        const governor = new ExecutorResourceGovernor({ log: cold, signer: h.identity, verifier: h.identity, guard: { assert() {} },
          executorId: EXECUTOR_ID, localDomainId: "local:device-1", localGovernorEpoch: 1, maxActiveRoots: 1, clock: () => NOW });
        const ledger = new ConversationAssignmentLedger({ log: cold, artifacts: h.artifacts, executorId: EXECUTOR_ID,
          signer: h.identity, verifier: h.identity, ownerControl, snapshotFor: matchingSnapshotFor,
          permissionSnapshotFor: digest => matchingPermissionSnapshotFor(h.identity, digest), resources: governor, clock: () => NOW });
        return { cold, ledger };
      };
      // 冷开时把已登记的投影追平到头部，与宿主就绪前的准备相同；之后只计量账本读取本身
      const first = coldLedger();
      await first.cold.prepareProjections();
      io.reset();
      const [bound] = await first.ledger.dataPlaneBindings([{ assignmentId: ASSIGNMENT_ID, use: "observe" }]);
      expect(bound).toMatchObject({ ref: h.activation.ref, executorId: EXECUTOR_ID });
      const binding = summary(io.snapshot());
      await first.cold.stopStorageMaintenance();

      const second = coldLedger();
      await second.cold.prepareProjections();
      io.reset();
      expect(await second.ledger.recoverableConversationAssignments()).toEqual([h.envelope]);
      const discovery = summary(io.snapshot());

      // 对照：按流从起点重放这个派发、整读日志枚举派发（旧做法）
      io.reset();
      await second.cold.readProjection<number, unknown>(0, count => count + 1, { streams: [`assignment:${ASSIGNMENT_ID}`] });
      const streamReplay = summary(io.snapshot());
      io.reset();
      expect((await second.cold.readAll()).length).toBeGreaterThan(ended);
      const wholeLog = summary(io.snapshot());
      rows.push({ ended, binding, discovery, streamReplay, wholeLog });
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      for (const phase of [row.binding, row.discovery]) {
        // 不读检查点、不扫帧索引；日志只读核对头部的固定尾段（冷开后没有新写入，索引之后没有记录）
        expect(phase.checkpoint).toBe(0);
        expect(phase.frameIndex).toBe(0);
        expect(phase.log).toBeLessThanOrEqual(1_024);
      }
      // 固定上界：段内每次探测连同条目本身一起读（信封行较大），段未填满时增量段多、探测多，所以 256 档可高于 1024 档
      expect(row.binding.readBytes).toBeLessThanOrEqual(64 * 1024);
      expect(row.discovery.readBytes).toBeLessThanOrEqual(128 * 1024);
    }
    // 只读这个派发的信封与校验状态、候选目录的首页：键数与已结束派发数无关，随历史变化的只有段填满前的
    // 探测次数与基段目录深度（每段二分至多 9 次探测，一次查找至多经过 1 个基段与 4 个增量段）
    const scale = (ended: number) => rows.find(row => row.ended === ended)!;
    for (const phase of ["binding", "discovery"] as const) {
      expect(scale(1024)[phase].log).toBe(scale(64)[phase].log);
      expect(scale(1024)[phase].readBytes).toBeLessThanOrEqual(scale(256)[phase].readBytes * 1.5);
      expect(scale(1024)[phase].reads).toBeLessThanOrEqual(scale(256)[phase].reads * 1.5);
      expect(scale(1024)[phase].probes).toBeLessThanOrEqual(scale(256)[phase].probes * 1.5);
    }
    // 对照：按流过滤仍从起点扫描帧索引，整读日志随历史线性增长
    expect(scale(1024).streamReplay.frameIndex).toBeGreaterThan(scale(64).streamReplay.frameIndex * 8);
    expect(scale(1024).wholeLog.log).toBeGreaterThan(scale(64).wholeLog.log * 8);
  }, 900_000);

  // 沿用已保存的绑定检查点时，只按派发领域索引里目标派发自己的行判断其后有无新记录；
  // 曾从检查点的全局游标按流过滤扫描，4 / 64 个无关派发时实际访问 8 / 128 个帧索引行
  it("reuses a saved binding without visiting frame rows of unrelated later assignments", async () => {
    const visited: number[] = [];
    for (const unrelated of [4, 64]) {
      const h = await createFormalReceiptHarness({ startupProofs: true, monotonicClock: () => 0 });
      const logRoot = path.join(h.root, "formal-executor");
      const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 5));
      expect(await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"))).toMatchObject({ accepted: true });
      // 保存目标派发的绑定检查点，之后目标不变，只经同一公开入口增加被拒的无关派发
      await h.ledger.dataPlaneBindings([{ assignmentId: ASSIGNMENT_ID, use: "observe" }]);
      for (let index = 0; index < unrelated; index++) {
        const assignmentId = `later-${index}`;
        const envelope = createSignedConversationEnvelope(
          createUnsignedEnvelope(h.identity, { assignmentId, runId: `run-later-${index}` }), h.identity, h.identity);
        expect(await h.ledger.dispatch(envelope, h.activation, ownerContext(assignmentId, "executor.dispatch"))).toMatchObject({ accepted: false });
      }
      await h.log.stopStorageMaintenance();
      const cold = new FileAuthorityCommitLog(logRoot, h.artifacts, { clock: () => NOW, integrity });
      onTestFinished(() => cold.stopStorageMaintenance());
      const governor = new ExecutorResourceGovernor({ log: cold, signer: h.identity, verifier: h.identity, guard: { assert() {} },
        executorId: EXECUTOR_ID, localDomainId: "local:device-1", localGovernorEpoch: 1, maxActiveRoots: 1, clock: () => NOW });
      const ledger = new ConversationAssignmentLedger({ log: cold, artifacts: h.artifacts, executorId: EXECUTOR_ID,
        signer: h.identity, verifier: h.identity, ownerControl, snapshotFor: matchingSnapshotFor,
        permissionSnapshotFor: digest => matchingPermissionSnapshotFor(h.identity, digest), resources: governor, clock: () => NOW });
      await cold.prepareProjections();
      let rows = 0;
      const scanRows = AuthenticatedFrameIndex.prototype.scanRows;
      const spy = vi.spyOn(AuthenticatedFrameIndex.prototype, "scanRows").mockImplementation(function (this: AuthenticatedFrameIndex,
        from: number, to: number, visit: (lsn: number, row: Buffer) => boolean | void) {
        return scanRows.call(this, from, to, (lsn, row) => { rows++; return visit(lsn, row); });
      });
      try {
        const [bound] = await ledger.dataPlaneBindings([{ assignmentId: ASSIGNMENT_ID, use: "observe" }]);
        expect(bound).toMatchObject({ ref: h.activation.ref, executorId: EXECUTOR_ID });
      } finally { spy.mockRestore(); }
      visited.push(rows);
    }
    expect(visited[1], JSON.stringify(visited)).toBe(visited[0]);
  }, 300_000);
});
