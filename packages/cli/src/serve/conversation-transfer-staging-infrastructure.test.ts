import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { ArtifactRef, Signature } from "@zhixing/core/contracts";
import { localConversationId } from "@zhixing/core/conversation";
import {
  createSignedConversationTransferAbort,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { ConversationRunJournal } from "@zhixing/owner-kernel/conversation-assignment";
import {
  ConversationTransferSource,
  ConversationTransferTarget,
} from "@zhixing/owner-kernel/conversation-transfer";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  initializeTrustChain,
} from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { bindConversationAnchorTenure } from "./conversation-anchor-tenure.js";
import { createConversationTransferStagingInfrastructure } from "./conversation-transfer-staging-infrastructure.js";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ABORT_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NOW = "2026-08-07T09:00:00.000Z";
// 目标端接管会话要求日志上有已核验的 anchor 任期：设备身份用真实设备密钥，信任链由目标 anchor 签发。
const sourceKey = await DeviceKey.generate();
const targetKey = await DeviceKey.generate();
const SOURCE_DEVICE = sourceKey.deviceId;
const TARGET_DEVICE = targetKey.deviceId;
const CONVERSATION_ID = localConversationId(SOURCE_DEVICE, "01K1ZZZZZZ0000000000000000");
const ABORT_CONVERSATION_ID = localConversationId(SOURCE_DEVICE, "01K1ZZZZZZ0000000000000001");

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device-test",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.sig !== signer.sign(schemaId, version, payload).sig) {
      throw new TypeError("Signature mismatch");
    }
  },
};

describe("conversation transfer staging infrastructure", () => {
  it("projects a frozen finite port and resumes the same durable prefix across instances", async () => {
    const home = await createTempDir("conversation-transfer-staging-resume");
    const first = createConversationTransferStagingInfrastructure({ zhixingHome: home });
    const staging = first.forTransfer(TRANSFER_ID);
    expect(Object.keys(first)).toEqual(["forTransfer"]);
    expect(Object.keys(staging)).toEqual(["artifacts", "receiver", "cleanup"]);
    expect(Object.keys(staging.artifacts)).toEqual(["get", "readRange", "has"]);
    expect(Object.keys(staging.receiver)).toEqual(["progress", "append"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(staging)).toBe(true);
    expect(Object.isFrozen(staging.artifacts)).toBe(true);
    expect(Object.isFrozen(staging.receiver)).toBe(true);

    const bytes = Buffer.from("resumable conversation transfer", "utf8");
    const ref = artifactRef(bytes);
    const prefix = bytes.subarray(0, 9);
    await expect(staging.receiver.append(ref, 0, prefix)).resolves.toEqual({
      receivedBytes: prefix.byteLength,
      complete: false,
    });
    await expect(staging.receiver.append(ref, 0, prefix)).resolves.toEqual({
      receivedBytes: prefix.byteLength,
      complete: false,
    });
    await expect(
      staging.receiver.append(ref, 0, Buffer.from("different", "utf8")),
    ).rejects.toThrow("differs from the durable prefix");
    await expect(staging.receiver.append(ref, prefix.byteLength + 1, bytes.subarray(9)))
      .rejects.toThrow("does not continue the durable prefix");

    const restarted = createConversationTransferStagingInfrastructure({ zhixingHome: home })
      .forTransfer(TRANSFER_ID);
    await expect(restarted.receiver.progress(ref)).resolves.toEqual({
      receivedBytes: prefix.byteLength,
      complete: false,
    });
    await expect(
      restarted.receiver.append(ref, prefix.byteLength, bytes.subarray(prefix.byteLength)),
    ).resolves.toEqual({ receivedBytes: bytes.byteLength, complete: true });
    await expect(restarted.artifacts.get(ref)).resolves.toEqual(bytes);

    const corrupt = { ...ref, digest: `sha256:${"0".repeat(64)}` as const };
    await expect(
      first.forTransfer(ABORT_ID).receiver.append(corrupt, 0, bytes),
    ).rejects.toThrow("does not match its declared reference");
    expect(() => first.forTransfer("../escape")).toThrow(
      "Conversation transfer staging id is invalid",
    );
    await expect(staging.receiver.progress({
      digest: `sha256:${"0".repeat(64)}`,
      bytes: 512 * 1024 * 1024 + 1,
    })).rejects.toThrow("configured byte limit");
    const oversizedChunk = Buffer.alloc(256 * 1024 + 1);
    await expect(
      staging.receiver.append(artifactRef(oversizedChunk), 0, oversizedChunk),
    ).rejects.toThrow("configured byte limit");
  });

  it("promotes the complete closure, retains committed staging, and deletes only after durable abort", async () => {
    const sourceRoot = await createTempDir("conversation-transfer-staging-source");
    const targetHome = await createTempDir("conversation-transfer-staging-target");
    const sourceArtifacts = new FileArtifactStore(path.join(sourceRoot, "artifacts"));
    const sourceLog = new FileAuthorityCommitLog(
      path.join(sourceRoot, "authority"),
      sourceArtifacts,
      { clock: () => NOW },
    );
    const content = await sourceArtifacts.put(Buffer.from("content asset", "utf8"));
    // 源会话历史与会话快照都由运行日志写者产生：导入端按会话记录合同校验并核对快照，附件进入迁移闭包。
    const journal = new ConversationRunJournal({
      conversationId: CONVERSATION_ID,
      ownerEpoch: 4,
      log: sourceLog,
      artifacts: sourceArtifacts,
      signer,
      verifier,
      clock: () => NOW,
      submission: { authenticate() {}, authorize() {} },
      authority: { decideAtPrefix: () => ({ committed: false, error: { code: "capability-gap", message: "Fixture has no executor", retryable: false } }) },
      projection: { async project() {} },
    });
    await journal.admit({
      runId: "run-1",
      ingressKey: "run-1",
      queuedPosition: 0,
      userInput: { parts: [{ type: "text", text: "附件" }] },
      attachments: [{ ...content, kind: "file" }],
      invocation: { kind: "agent", source: "interactive" },
      ingress: {
        kind: "first-party",
        surfacePrincipal: "rpc:fixture",
        deviceId: SOURCE_DEVICE,
        ingressId: "run-1",
        receivedAt: NOW,
        turnOrigin: { channel: "rpc" },
      },
    });
    const source = new ConversationTransferSource({
      deviceId: SOURCE_DEVICE,
      log: sourceLog,
      artifacts: sourceArtifacts,
      signer,
      verifier,
      acceptsConversationId: (conversationId) => conversationId === CONVERSATION_ID,
      isCurrentAnchor: (deviceId) => deviceId === TARGET_DEVICE,
      conversationState: async () => ({ exists: true, deleted: false, ownerEpoch: 4 }),
      settleConversation: async () => undefined,
      snapshotSessionState: async () => ({
        reducerVersion: "session-state-v1",
        value: JSON.parse(JSON.stringify({
          meta: await journal.sessionMeta(),
          taskList: await journal.taskList(),
          transcript: (await journal.transcriptTail()).records,
          advancement: (await journal.advancementSessions()).at(-1) ?? null,
        })),
      }),
      clock: () => NOW,
    });
    const prepared = preparedRecord(TRANSFER_ID);
    await source.prepare(prepared);
    const frozen = await source.freeze(TRANSFER_ID);

    const targetArtifacts = new FileArtifactStore(
      path.join(targetHome, "distributed-runtime", "artifacts"),
    );
    const targetLog = new FileAuthorityCommitLog(
      path.join(targetHome, "distributed-runtime", "authority"),
      targetArtifacts,
      { clock: () => NOW },
    );
    await installAnchorTenure(targetLog);
    const staging = createConversationTransferStagingInfrastructure({
      zhixingHome: targetHome,
    });
    const target = new ConversationTransferTarget({
      deviceId: TARGET_DEVICE,
      log: targetLog,
      artifacts: targetArtifacts,
      staging,
      signer,
      verifier,
      isActiveSource: (deviceId) => deviceId === SOURCE_DEVICE,
      acceptsSourceConversationId: (deviceId, conversationId) =>
        deviceId === SOURCE_DEVICE && [CONVERSATION_ID, ABORT_CONVERSATION_ID].includes(conversationId),
      conversationExists: () => false,
      sourceOwnerEpoch: () => 4,
      reducerVersion: "session-state-v1",
    });
    await target.prepare(prepared);
    await target.import({
      transferId: TRANSFER_ID,
      manifestRef: frozen.manifestRef,
      proof: frozen.proof,
      source: source.readPort,
    });
    await expect(targetArtifacts.has(frozen.manifestRef)).resolves.toBe(true);
    await expect(targetArtifacts.has(frozen.manifest.authorityBase.records)).resolves.toBe(true);
    await expect(targetArtifacts.has(frozen.manifest.authorityBase.sessionState)).resolves.toBe(true);
    await expect(targetArtifacts.has(content)).resolves.toBe(true);
    await target.commit(TRANSFER_ID);

    const committedRoot = transferRoot(targetHome, TRANSFER_ID);
    await expect(access(committedRoot)).resolves.toBeUndefined();
    await expect(
      createConversationTransferStagingInfrastructure({ zhixingHome: targetHome })
        .forTransfer(TRANSFER_ID).artifacts.has(frozen.manifestRef),
    ).resolves.toBe(true);

    const abortPrepared = preparedRecord(ABORT_ID, ABORT_CONVERSATION_ID);
    await target.prepare(abortPrepared);
    const abandoned = Buffer.from("abandoned", "utf8");
    await staging.forTransfer(ABORT_ID).receiver.append(artifactRef(abandoned), 0, abandoned);
    await target.recordAbort(createSignedConversationTransferAbort({
      v: 1,
      requestId: abortPrepared.requestId,
      transferId: ABORT_ID,
      sourceDeviceId: abortPrepared.sourceDeviceId,
      targetDeviceId: abortPrepared.targetDeviceId,
      conversationId: abortPrepared.conversationId,
      sourceOwnerEpoch: abortPrepared.sourceOwnerEpoch,
      reason: "operator-cancelled",
      at: NOW,
    }, signer));
    await expect(target.cleanupAborted(ABORT_ID)).resolves.toBe(1);
    await expect(access(transferRoot(targetHome, ABORT_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(committedRoot)).resolves.toBeUndefined();
  });
});

function artifactRef(bytes: Uint8Array): ArtifactRef {
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}

function preparedRecord(
  transferId: string,
  conversationId = CONVERSATION_ID,
) {
  return {
    v: 1 as const,
    t: "prepared" as const,
    requestId: `request:${transferId}`,
    transferId,
    sourceDeviceId: SOURCE_DEVICE,
    targetDeviceId: TARGET_DEVICE,
    conversationId,
    sourceOwnerEpoch: 4,
    nextOwnerEpoch: 5,
  };
}

/** 在目标日志上建立由目标 anchor 签发、登记源执行器的真实信任链。 */
async function installAnchorTenure(log: FileAuthorityCommitLog): Promise<void> {
  const anchor = enrollDeviceIdentity(targetKey, { displayName: "target", platform: "linux", enrolledAt: NOW });
  const member = enrollDeviceIdentity(sourceKey, { displayName: "source", platform: "linux", enrolledAt: NOW });
  bindConversationAnchorTenure(log);
  const genesis = createTrustGenesisEvent({ homeId: "staging-home", issuer: anchor, signer: targetKey, at: NOW });
  const initial = initializeTrustChain(genesis);
  const enroll = createSignedTrustEvent({
    current: initial,
    signer: targetKey,
    at: NOW,
    body: { t: "enroll", device: member, roles: ["executor"] },
  });
  await log.append([
    { stream: "trust", body: { t: "home-trust-event", event: genesis } },
    { stream: "trust", body: { t: "home-trust-event", event: enroll } },
    { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(applyTrustEvent(initial, enroll), targetKey) } },
  ]);
}

function transferRoot(home: string, transferId: string): string {
  return path.join(
    home,
    "distributed-runtime",
    "conversation-transfer-staging",
    transferId,
  );
}
