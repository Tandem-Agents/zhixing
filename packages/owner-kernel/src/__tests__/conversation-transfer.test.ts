import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { Signature, TransferRecord } from "@zhixing/core/contracts";
import {
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TRANSFER_PROJECTION_ID,
  ConversationTransferSource,
  ConversationTransferTarget,
  assertConversationTransferWriteAuthority,
  readConversationTransferState,
} from "../conversation-transfer.js";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONVERSATION = "local-12345678-01K1ZZZZZZ0000000000000000";
const NOW = "2026-08-07T09:00:00.000Z";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device-source",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const targetSigner: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device-target",
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

describe("conversation transfer source and target", () => {
  it("freezes only the conversation domain and serves only manifest-bound refs", async () => {
    const fixture = await sourceHarness();
    const content = await fixture.artifacts.put(Buffer.from("attachment", "utf8"));
    await fixture.log.append([
      {
        stream: `run:${CONVERSATION}`,
        body: {
          t: "admitted",
          assignmentId: "assignment-a",
          conversationId: CONVERSATION,
          attachment: { ...content, kind: "file" },
        },
      },
      {
        stream: "publish",
        body: { t: "publish-progress", assignmentId: "assignment-a", state: "settled" },
      },
      {
        stream: "final-outbox",
        body: { t: "final", conversationId: CONVERSATION, state: "published" },
      },
      {
        stream: "final-outbox",
        body: { t: "final", conversationId: "other-conversation", state: "published" },
      },
      { stream: "job:job-a", body: { t: "must-not-transfer" } },
    ]);
    await fixture.source.prepare(prepareRecord());
    expect(fixture.settled).toEqual([CONVERSATION]);
    const frozen = await fixture.source.freeze(TRANSFER_ID);
    expect(fixture.settled).toEqual([CONVERSATION]);
    expect(frozen.manifest.streams.map((item) => item.stream)).toEqual([
      "final-outbox",
      "publish",
      `run:${CONVERSATION}`,
    ]);
    expect(frozen.manifest.contentAssets).toContainEqual(content);
    await expect(
      fixture.source.readPort.probe({
        transferId: TRANSFER_ID,
        targetDeviceId: "device-target",
        ref: frozen.manifestRef,
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.source.readPort.probe({
        transferId: TRANSFER_ID,
        targetDeviceId: "device-target",
        ref: { digest: protocolDigest("Unknown", 1, {}), bytes: 1 },
      }),
    ).rejects.toThrow("outside the frozen manifest");
    await expect(
      fixture.source.readPort.probe({
        transferId: TRANSFER_ID,
        targetDeviceId: "another-device",
        ref: frozen.manifestRef,
      }),
    ).rejects.toThrow("prepared target");
  });

  it("closes fresh writes durably at prepared and reopens the same epoch after abort", async () => {
    const fixture = await sourceHarness();
    await fixture.log.append([
      { stream: `run:${CONVERSATION}`, body: { t: "identity", conversationId: CONVERSATION } },
    ]);
    await fixture.source.prepare(prepareRecord());
    await expect(
      fixture.log.transactDurableProjection(
        CONVERSATION_TRANSFER_PROJECTION_ID,
        async (projection) => {
          await assertConversationTransferWriteAuthority(projection, CONVERSATION, {
            deviceId: "device-source",
            ownerEpoch: 4,
          });
          return { kind: "return", value: undefined };
        },
      ),
    ).rejects.toThrow("not writable");
    await fixture.source.abort(TRANSFER_ID, "operator-cancelled");
    await expect(
      fixture.log.transactDurableProjection(
        CONVERSATION_TRANSFER_PROJECTION_ID,
        async (projection) => {
          await assertConversationTransferWriteAuthority(projection, CONVERSATION, {
            deviceId: "device-source",
            ownerEpoch: 4,
          });
          return { kind: "return", value: true };
        },
      ),
    ).resolves.toMatchObject({ value: true });
    await expect(
      fixture.source.readPort.probe({
        transferId: TRANSFER_ID,
        targetDeviceId: "device-target",
        ref: { digest: protocolDigest("Unknown", 1, {}), bytes: 1 },
      }),
    ).rejects.toThrow("not readable");
  });

  it("imports all declared bytes idempotently and rejects corrupt or stale preparations", async () => {
    const source = await sourceHarness();
    const targetRoot = await createTempDir("conversation-transfer-target");
    const targetArtifacts = new FileArtifactStore(path.join(targetRoot, "artifacts"), {
      lockWaitMs: 2_000,
    });
    const targetLog = new FileAuthorityCommitLog(
      path.join(targetRoot, "authority"),
      targetArtifacts,
      { clock: () => NOW, lockWaitMs: 2_000 },
    );
    await source.log.append([
      { stream: `run:${CONVERSATION}`, body: { t: "identity", conversationId: CONVERSATION } },
      { stream: `intent:${CONVERSATION}`, body: { t: "intent", conversationId: CONVERSATION } },
    ]);
    const prepared = prepareRecord();
    await source.source.prepare(prepared);
    const frozen = await source.source.freeze(TRANSFER_ID);
    const target = new ConversationTransferTarget({
      deviceId: "device-target",
      log: targetLog,
      artifacts: targetArtifacts,
      signer: targetSigner,
      verifier,
      isActiveSource: (deviceId) => deviceId === "device-source",
      acceptsSourceConversationId: (deviceId, conversationId) =>
        deviceId === "device-source" && conversationId === CONVERSATION,
      conversationExists: () => false,
      sourceOwnerEpoch: () => 4,
      reducerVersion: "session-state-v1",
    });
    await target.prepare(preparedRecord());
    const imported = await target.import({
      transferId: TRANSFER_ID,
      manifestRef: frozen.manifestRef,
      proof: frozen.proof,
      source: source.source.readPort,
    });
    expect(imported.state.phase).toBe("imported");
    await expect(targetArtifacts.get(frozen.manifest.authorityBase.records)).resolves.toBeInstanceOf(Uint8Array);
    expect(
      (await target.import({
        transferId: TRANSFER_ID,
        manifestRef: frozen.manifestRef,
        proof: frozen.proof,
        source: source.source.readPort,
      })).state.phase,
    ).toBe("imported");
    expect((await readConversationTransferState(targetLog, TRANSFER_ID, verifier))?.phase).toBe("imported");

    const committed = await target.commit(TRANSFER_ID);
    expect(committed.state.phase).toBe("committed");
    expect(committed.commit.signature.keyId).toBe("device-target");
    await source.source.acceptCommit({
      manifest: frozen.manifest,
      commit: committed.commit,
    });
    await expect(
      source.log.transactDurableProjection(
        CONVERSATION_TRANSFER_PROJECTION_ID,
        async (projection) => {
          await assertConversationTransferWriteAuthority(projection, CONVERSATION, {
            deviceId: "device-source",
            ownerEpoch: 4,
          });
          return { kind: "return", value: undefined };
        },
      ),
    ).rejects.toThrow("not writable");
    await expect(
      targetLog.transactDurableProjection(
        CONVERSATION_TRANSFER_PROJECTION_ID,
        async (projection) => {
          await assertConversationTransferWriteAuthority(projection, CONVERSATION, {
            deviceId: "device-target",
            ownerEpoch: 5,
          });
          return { kind: "return", value: true };
        },
      ),
    ).resolves.toMatchObject({ value: true });
    await expect(target.committedBase(TRANSFER_ID)).resolves.toMatchObject({
      manifest: { conversationId: CONVERSATION },
    });
    await expect(target.commit(TRANSFER_ID)).resolves.toMatchObject({
      commit: committed.commit,
      state: { phase: "committed" },
    });

    const staleTarget = new ConversationTransferTarget({
      deviceId: "device-target",
      log: targetLog,
      artifacts: targetArtifacts,
      signer: targetSigner,
      verifier,
      isActiveSource: () => true,
      acceptsSourceConversationId: () => true,
      conversationExists: () => false,
      sourceOwnerEpoch: () => 3,
      reducerVersion: "session-state-v1",
    });
    await expect(
      staleTarget.prepare({ ...preparedRecord(), transferId: "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAW" }),
    ).rejects.toThrow("stale");
  });
});

async function sourceHarness() {
  const root = await createTempDir("conversation-transfer-source");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  });
  const settled: string[] = [];
  const source = new ConversationTransferSource({
    deviceId: "device-source",
    log,
    artifacts,
    signer,
    verifier,
    acceptsConversationId: (conversationId) => conversationId === CONVERSATION,
    isCurrentAnchor: (deviceId) => deviceId === "device-target",
    conversationState: async (conversationId) => ({
      exists: conversationId === CONVERSATION,
      deleted: false,
      ownerEpoch: 4,
    }),
    settleConversation: async (conversationId) => {
      settled.push(conversationId);
    },
    snapshotSessionState: async () => ({
      reducerVersion: "session-state-v1",
      value: { conversationId: CONVERSATION, revision: 3 },
    }),
    clock: () => NOW,
  });
  return { artifacts, log, settled, source };
}

function prepareRecord() {
  return {
    requestId: "request-1",
    transferId: TRANSFER_ID,
    targetDeviceId: "device-target",
    conversationId: CONVERSATION,
    sourceOwnerEpoch: 4,
  };
}

function preparedRecord(): Extract<TransferRecord, { t: "prepared" }> {
  return {
    v: 1,
    t: "prepared",
    requestId: "request-1",
    transferId: TRANSFER_ID,
    sourceDeviceId: "device-source",
    targetDeviceId: "device-target",
    conversationId: CONVERSATION,
    sourceOwnerEpoch: 4,
    nextOwnerEpoch: 5,
  };
}
