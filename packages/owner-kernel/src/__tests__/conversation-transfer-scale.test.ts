/**
 * 会话迁移的规模对照：保留一个未终结迁移，只增加已终结（准备后取消）的迁移历史。正常停止后
 * 冷开，分阶段计量全部文件读写：打开并追平投影、列出未终结迁移、按会话读取迁移、停止。
 * 原先的全量列表随迁移历史线性增长，作为对照。
 */
import path from "node:path";
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { Signature } from "@zhixing/core/contracts";
import { protocolDigest, type ProtocolSignatureVerifier, type ProtocolSigner } from "@zhixing/core/protocol";
import { captureFileIo, createTempDir, type FileIoSnapshot } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TRANSFER_PROJECTION_ID,
  ConversationTransferSource,
  listConversationTransferStates,
  listConversationTransfersFor,
  listOpenConversationTransfers,
  registerConversationTransferProjection,
} from "../conversation-transfer.js";

const NOW = "2026-08-07T09:00:00.000Z";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return { alg: "test-sha256", keyId: "device-source", sig: protocolDigest(schemaId, version, payload) };
  },
};
const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.sig !== signer.sign(schemaId, version, payload).sig) throw new TypeError("Signature mismatch");
  },
};

/** 合法的 26 位 ULID 尾部：固定前缀 + 四位序号 */
const ulid = (index: number) => "01ARZ3NDEKTSV4RRFFQ69G" + [3, 2, 1, 0].map(shift => CROCKFORD[Math.floor(index / 32 ** shift) % 32]).join("");
const conversation = (index: number) => `local-12345678-${ulid(index)}`;

const summary = (io: FileIoSnapshot) => ({ readBytes: io.readBytes, reads: io.reads, writeBytes: io.writeBytes, segmentEntryProbes: io.segmentEntryProbes,
  log: io.byCategory.log?.readBytes ?? 0, checkpoint: io.byCategory.checkpoint?.readBytes ?? 0,
  projection: io.byCategory.projection?.readBytes ?? 0, projectionWrites: io.byCategory.projection?.writeBytes ?? 0 });
type Phase = ReturnType<typeof summary>;

describe("conversation transfers with one open transfer and growing ended history", () => {
  it("keeps cold open, open-transfer listing and per-conversation reads within fixed bounds at 16 / 64 / 256 / 1024 / 2048 ended transfers while the full list grows", async () => {
    const rows: { ended: number; open: Phase; list: Phase; forConversation: Phase; stop: Phase; fullList: Phase }[] = [];
    for (const ended of [16, 64, 256, 1024, 2048]) {
      const root = await createTempDir("transfer-scale-" + ended);
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
      const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 9));
      const logRoot = path.join(root, "authority");
      const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity };
      const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      const source = new ConversationTransferSource({
        deviceId: "device-source", log, artifacts, signer, verifier,
        acceptsConversationId: () => true,
        isCurrentAnchor: deviceId => deviceId === "device-target",
        conversationState: async () => ({ exists: true, deleted: false, ownerEpoch: 4 }),
        settleConversation: async () => {},
        snapshotSessionState: async () => ({ reducerVersion: "session-state-v1", value: { revision: 1 } }),
        clock: () => NOW,
      });
      // 已终结历史：每个会话一次迁移，准备后取消
      for (let index = 0; index < ended; index++) {
        const transferId = `xfer-${ulid(index)}`;
        await source.prepare({ requestId: "request-" + index, transferId, targetDeviceId: "device-target", conversationId: conversation(index), sourceOwnerEpoch: 4 });
        await source.abort(transferId, "operator-cancelled");
      }
      // 当前状态固定：一个未终结迁移
      const openConversation = conversation(9_000), openTransfer = `xfer-${ulid(9_000)}`;
      await source.prepare({ requestId: "request-open", transferId: openTransfer, targetDeviceId: "device-target", conversationId: openConversation, sourceOwnerEpoch: 4 });
      await log.stopStorageMaintenance();

      const io = await captureFileIo(root);
      const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      registerConversationTransferProjection(cold, verifier);
      await cold.prepareProjections([CONVERSATION_TRANSFER_PROJECTION_ID]);
      const open = summary(io.snapshot());
      io.reset();
      expect(await listOpenConversationTransfers(cold, verifier)).toEqual([{ conversationId: openConversation, transferId: openTransfer }]);
      const list = summary(io.snapshot());
      io.reset();
      const states = await listConversationTransfersFor(cold, verifier, openConversation);
      expect(states.map(state => [state.identity.transferId, state.phase])).toEqual([[openTransfer, "prepared"]]);
      const forConversation = summary(io.snapshot());
      io.reset();
      await cold.stopStorageMaintenance();
      const stop = summary(io.snapshot());

      // 对照：原先的全量列表
      io.reset();
      const reference = new FileAuthorityCommitLog(logRoot, artifacts, settings);
      expect(await listConversationTransferStates(reference, verifier)).toHaveLength(ended + 1);
      const fullList = summary(io.snapshot());
      await reference.stopStorageMaintenance();
      rows.push({ ended, open, list, forConversation, stop, fullList });
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      for (const phase of [row.open, row.list, row.forConversation, row.stop]) {
        expect(phase.checkpoint).toBe(0);
        // 冷读与停止都不补做段整理或其他投影写入
        expect(phase.projectionWrites).toBe(0);
      }
      // 固定上界：追尾只续算停止后的有界尾部；扫描至多触及有界的增量窗口（至多五段）与基础层一条根到叶路径，
      // 每段一次定位加一批 64KB 顺序预读。与已终结迁移数量无关
      expect(row.open.readBytes).toBeLessThanOrEqual(256 * 1024);
      expect(row.list.readBytes + row.forConversation.readBytes).toBeLessThanOrEqual(640 * 1024);
      expect(row.stop.readBytes).toBeLessThanOrEqual(1024);
      expect(row.stop.writeBytes).toBe(0);
    }
    const at = (ended: number) => rows.find(row => row.ended === ended)!;
    // 增量窗口饱和之后，历史翻倍不再增加读取；原先的全量列表随历史线性增长
    for (const phase of ["open", "list", "forConversation"] as const) {
      expect(at(2048)[phase].readBytes).toBeLessThanOrEqual(at(1024)[phase].readBytes * 1.5);
      expect(at(2048)[phase].reads).toBeLessThanOrEqual(at(1024)[phase].reads * 1.5);
    }
    expect(at(2048).fullList.projection).toBeGreaterThan(at(1024).fullList.projection * 1.8);
    expect(at(2048).fullList.readBytes).toBeGreaterThan(4 * (at(2048).list.readBytes + at(2048).forConversation.readBytes));
  }, 900_000);
});
