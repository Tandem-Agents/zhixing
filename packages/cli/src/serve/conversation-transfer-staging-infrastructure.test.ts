import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { ArtifactRef, Signature } from "@zhixing/core/contracts";
import {
  createSignedConversationTransferAbort,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  ConversationTransferSource,
  ConversationTransferTarget,
} from "@zhixing/owner-kernel";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { createConversationTransferStagingInfrastructure } from "./conversation-transfer-staging-infrastructure.js";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ABORT_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CONVERSATION_ID = "local-device-source-01K1ZZZZZZ0000000000000000";
const ABORT_CONVERSATION_ID = "local-device-source-01K1ZZZZZZ0000000000000001";
const NOW = "2026-08-07T09:00:00.000Z";

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
    await sourceLog.append([{
      stream: `run:${CONVERSATION_ID}`,
      body: { t: "identity", conversationId: CONVERSATION_ID, content },
    }]);
    const source = new ConversationTransferSource({
      deviceId: "device-source",
      log: sourceLog,
      artifacts: sourceArtifacts,
      signer,
      verifier,
      acceptsConversationId: (conversationId) => conversationId === CONVERSATION_ID,
      isCurrentAnchor: (deviceId) => deviceId === "device-target",
      conversationState: async () => ({ exists: true, deleted: false, ownerEpoch: 4 }),
      settleConversation: async () => undefined,
      snapshotSessionState: async () => ({
        reducerVersion: "session-state-v1",
        value: { conversationId: CONVERSATION_ID, revision: 1 },
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
    const staging = createConversationTransferStagingInfrastructure({
      zhixingHome: targetHome,
    });
    const target = new ConversationTransferTarget({
      deviceId: "device-target",
      log: targetLog,
      artifacts: targetArtifacts,
      staging,
      signer,
      verifier,
      isActiveSource: (deviceId) => deviceId === "device-source",
      acceptsSourceConversationId: (deviceId, conversationId) =>
        deviceId === "device-source" && conversationId.startsWith("local-device-source-"),
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
    sourceDeviceId: "device-source",
    targetDeviceId: "device-target",
    conversationId,
    sourceOwnerEpoch: 4,
    nextOwnerEpoch: 5,
  };
}

function transferRoot(home: string, transferId: string): string {
  return path.join(
    home,
    "distributed-runtime",
    "conversation-transfer-staging",
    transferId,
  );
}
