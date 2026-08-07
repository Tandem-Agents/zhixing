import { describe, expect, it } from "vitest";
import type {
  ArtifactRef,
  ConversationTransferManifest,
  TransferRecord,
} from "../contracts/index.js";
import { protocolDigest } from "./canonical.js";
import {
  assertConversationFreezeProofBinding,
  conversationTransferCommitDigest,
  createSignedConversationTransferAbort,
  createSignedConversationTransferCommand,
  createSignedConversationTransferCommit,
  createSignedSourceFreezeProof,
  prepareConversationTransferManifest,
  reduceConversationTransfer,
  sourceFreezeProofDigest,
  validateConversationTransferCommand,
  validateConversationTransferManifest,
  validateConversationTransferResult,
} from "./conversation-transfer.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
const AT = "2026-08-07T00:00:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "device-source",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

describe("conversation transfer protocol", () => {
  it("prepares a canonical manifest whose freeze proof binds the artifact digest", () => {
    const prepared = prepareConversationTransferManifest(manifest());
    expect(prepared.ref.bytes).toBe(prepared.bytes.byteLength);
    expect(prepared.ref.digest).toMatch(/^sha256:/u);
    const proof = freezeProof(prepared.ref);
    expect(() =>
      assertConversationFreezeProofBinding(proof, prepared.manifest, prepared.ref),
    ).not.toThrow();
    expect(() =>
      assertConversationFreezeProofBinding(proof, prepared.manifest, {
        ...prepared.ref,
        digest: digest("wrong-manifest"),
      }),
    ).toThrow("does not bind");
  });

  it("rejects identity, epoch, ordering and unknown-field drift before transfer", () => {
    const value = manifest();
    expect(() =>
      validateConversationTransferManifest({
        ...value,
        nextOwnerEpoch: value.sourceOwnerEpoch + 2,
      }),
    ).toThrow("sourceOwnerEpoch + 1");
    expect(() =>
      validateConversationTransferManifest({
        ...value,
        streams: [...value.streams].reverse(),
      }),
    ).toThrow("canonically sorted");
    expect(() =>
      validateConversationTransferManifest({ ...value, checkpointEnvelope: {} }),
    ).toThrow("incomplete or unknown");
  });

  it("advances only through the frozen state graph and replays every exact record", () => {
    const preparedManifest = prepareConversationTransferManifest(manifest());
    const proof = freezeProof(preparedManifest.ref);
    const records = transferRecords(preparedManifest.ref, proof);
    let state = reduceConversationTransfer(undefined, records.prepared, identity);
    for (const phase of ["frozen", "imported", "committed", "tombstoned"] as const) {
      state = reduceConversationTransfer(state, records[phase], identity);
      expect(state.phase).toBe(phase);
      expect(reduceConversationTransfer(state, records[phase], identity)).toBe(state);
    }
    expect(() =>
      reduceConversationTransfer(state, {
        ...records.committed,
        commit: { ...records.committed.commit, checkpointDigest: digest("drift") },
      }, identity),
    ).toThrow("Conflicting committed");
    expect(() =>
      reduceConversationTransfer(state, {
        v: 1,
        t: "aborted",
        transferId: TRANSFER_ID,
        abort: abort(),
      }, identity),
    ).toThrow("cannot be aborted");
  });

  it("allows a signed abort only before commit and makes it terminal", () => {
    const prepared = preparedRecord();
    const abortRecord: TransferRecord = {
      v: 1,
      t: "aborted",
      transferId: TRANSFER_ID,
      abort: abort(),
    };
    const state = reduceConversationTransfer(
      reduceConversationTransfer(undefined, prepared, identity),
      abortRecord,
      identity,
    );
    expect(state.phase).toBe("aborted");
    expect(reduceConversationTransfer(state, abortRecord, identity)).toBe(state);
    expect(() =>
      reduceConversationTransfer(state, {
        v: 1,
        t: "frozen",
        transferId: TRANSFER_ID,
        manifest: ref("manifest"),
        proof: freezeProof(ref("manifest")),
      }, identity),
    ).toThrow("cannot enter frozen");
  });

  it("strictly authenticates the finite mesh command and result unions", () => {
    const command = createSignedConversationTransferCommand(
      {
        v: 1,
        op: "prepare",
        requestId: "request-1",
        transferId: TRANSFER_ID,
        sourceDeviceId: "device-source",
        targetDeviceId: "device-target",
        conversationId: "conversation-1",
        sourceOwnerEpoch: 4,
        nextOwnerEpoch: 5,
      },
      identity,
    );
    expect(validateConversationTransferCommand(command, identity)).toEqual(command);
    expect(() =>
      validateConversationTransferCommand(
        { ...command, op: "read-any-path", absolutePath: "C:\\secret" },
        identity,
      ),
    ).toThrow();
    expect(
      validateConversationTransferResult({
        v: 1,
        status: "ok",
        requestId: "request-1",
        transferId: TRANSFER_ID,
        state: "prepared",
      }),
    ).toEqual({
      v: 1,
      status: "ok",
      requestId: "request-1",
      transferId: TRANSFER_ID,
      state: "prepared",
    });
  });
});

function manifest(): ConversationTransferManifest {
  return {
    v: 1,
    requestId: "request-1",
    transferId: TRANSFER_ID,
    sourceDeviceId: "device-source",
    targetDeviceId: "device-target",
    conversationId: "conversation-1",
    sourceOwnerEpoch: 4,
    nextOwnerEpoch: 5,
    lastLsn: 10,
    authorityBase: {
      checkpoint: {
        logId: "executor-log-source",
        lsn: 10,
        frameEndOffset: 1024,
        prefixDigest: digest("prefix"),
      },
      records: ref("records"),
      sessionState: ref("session-state"),
      reducerVersion: "conversation-transfer-base-v1",
    },
    streams: [
      { stream: "control", firstLsn: 2, lastLsn: 8, recordCount: 3, digest: digest("control") },
      { stream: "run:conversation-1", firstLsn: 1, lastLsn: 10, recordCount: 5, digest: digest("run") },
    ],
    contentAssets: [],
  };
}

function transferRecords(manifestRef: ArtifactRef, proof: ReturnType<typeof freezeProof>) {
  const commit = createSignedConversationTransferCommit(
    {
      v: 1,
      transferId: TRANSFER_ID,
      conversationId: "conversation-1",
      sourceDeviceId: "device-source",
      targetDeviceId: "device-target",
      freezeProofDigest: sourceFreezeProofDigest(proof),
      checkpointDigest: manifestRef.digest,
      sourceOwnerEpoch: 4,
      nextOwnerEpoch: 5,
      at: AT,
    },
    identity,
  );
  return {
    prepared: preparedRecord(),
    frozen: { v: 1, t: "frozen", transferId: TRANSFER_ID, manifest: manifestRef, proof } as const,
    imported: { v: 1, t: "imported", transferId: TRANSFER_ID, manifestDigest: manifestRef.digest, importedRecordBase: ref("imported") } as const,
    committed: { v: 1, t: "committed", transferId: TRANSFER_ID, commit } as const,
    tombstoned: { v: 1, t: "tombstoned", transferId: TRANSFER_ID, commitDigest: conversationTransferCommitDigest(commit), at: AT } as const,
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
    conversationId: "conversation-1",
    sourceOwnerEpoch: 4,
    nextOwnerEpoch: 5,
  };
}

function freezeProof(manifestRef: ArtifactRef) {
  return createSignedSourceFreezeProof(
    {
      v: 1,
      transferId: TRANSFER_ID,
      scope: "conversation",
      subject: "conversation-1",
      sourceEpoch: 4,
      checkpointDigest: manifestRef.digest,
      lastLsn: 10,
    },
    identity,
  );
}

function abort() {
  return createSignedConversationTransferAbort(
    {
      v: 1,
      requestId: "request-1",
      transferId: TRANSFER_ID,
      sourceDeviceId: "device-source",
      targetDeviceId: "device-target",
      conversationId: "conversation-1",
      sourceOwnerEpoch: 4,
      reason: "operator-cancelled",
      at: AT,
    },
    identity,
  );
}

function ref(label: string): ArtifactRef {
  return { digest: digest(label), bytes: 8 };
}

function digest(label: string) {
  return protocolDigest("TestDigest", 1, { label });
}
