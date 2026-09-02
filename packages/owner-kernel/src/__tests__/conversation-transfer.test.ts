import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { ArtifactRef, Signature, TransferRecord } from "@zhixing/core/contracts";
import {
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type {
  StorageMaintenanceGovernorPort,
  StorageMaintenanceRequest,
} from "@zhixing/core/resources";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TRANSFER_PROJECTION_ID,
  ConversationTransferSource,
  ConversationTransferTarget,
  assertConversationTransferWriteAuthority,
  readConversationTransferState,
  type ConversationTransferStaging,
  type ConversationTransferStagingArea,
  type ConversationTransferSourceOptions,
} from "../conversation-transfer.js";
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";

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

describe("conversation transfer source and target", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("revalidates the source identity after settling before appending prepared", async () => {
    let deleted = false;
    const fixture = await sourceHarness({
      conversationState: async (conversationId) => ({
        exists: conversationId === CONVERSATION,
        deleted,
        ownerEpoch: 4,
      }),
      settleConversation: async () => {
        deleted = true;
      },
    });

    await expect(fixture.source.prepare(prepareRecord())).rejects.toThrow(
      "identity changed while settling",
    );
    await expect(
      readConversationTransferState(fixture.log, TRANSFER_ID, verifier),
    ).resolves.toBeUndefined();
  });

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
    const targetLog = trackAuthorityLog(new FileAuthorityCommitLog(
      path.join(targetRoot, "authority"),
      targetArtifacts,
      { clock: () => NOW, lockWaitMs: 2_000 },
    ));
    await source.log.append([
      { stream: `run:${CONVERSATION}`, body: { t: "identity", conversationId: CONVERSATION } },
      { stream: `intent:${CONVERSATION}`, body: { t: "intent", conversationId: CONVERSATION } },
    ]);
    const prepared = prepareRecord();
    await source.source.prepare(prepared);
    const frozen = await source.source.freeze(TRANSFER_ID);
    const targetStaging = memoryStagingArea();
    const target = new ConversationTransferTarget({
      deviceId: "device-target",
      log: targetLog,
      artifacts: targetArtifacts,
      staging: targetStaging.port,
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
    expect(targetStaging.count(TRANSFER_ID)).toBeGreaterThan(0);

    const staleStaging = memoryStagingArea();
    const staleTarget = new ConversationTransferTarget({
      deviceId: "device-target",
      log: targetLog,
      artifacts: targetArtifacts,
      staging: staleStaging.port,
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

  it("cleans only transfer-private staging and preserves promoted shared digests", async () => {
    const maintenance = recordingGovernor();
    const source = await sourceHarness({ storageMaintenance: maintenance.port });
    const targetRoot = await createTempDir("conversation-transfer-private-staging");
    const targetArtifacts = new FileArtifactStore(path.join(targetRoot, "artifacts"), {
      lockWaitMs: 2_000,
    });
    const targetLog = trackAuthorityLog(new FileAuthorityCommitLog(
      path.join(targetRoot, "authority"),
      targetArtifacts,
      { clock: () => NOW, lockWaitMs: 2_000 },
    ));
    const staging = memoryStagingArea();
    const shared = await source.artifacts.put(Buffer.from("shared-attachment", "utf8"));
    await source.log.append([
      {
        stream: `run:${CONVERSATION}`,
        body: { t: "identity", conversationId: CONVERSATION, attachment: shared },
      },
    ]);
    await source.source.prepare(prepareRecord());
    const frozen = await source.source.freeze(TRANSFER_ID);
    await targetArtifacts.putVerifiedStream(
      shared,
      (async function* () {
        yield Buffer.from("shared-attachment", "utf8");
      })(),
    );
    const target = new ConversationTransferTarget({
      deviceId: "device-target",
      log: targetLog,
      artifacts: targetArtifacts,
      staging: staging.port,
      storageMaintenance: maintenance.port,
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
    await target.import({
      transferId: TRANSFER_ID,
      manifestRef: frozen.manifestRef,
      proof: frozen.proof,
      source: source.source.readPort,
    });
    const abort = await source.source.prepareAbort(TRANSFER_ID, "operator-cancelled");
    await target.recordAbort(abort);
    await expect(target.cleanupAborted(TRANSFER_ID)).resolves.toBeGreaterThan(0);

    await expect(targetArtifacts.has(shared)).resolves.toBe(true);
    expect(staging.count(TRANSFER_ID)).toBe(0);
    expect(maintenance.requests.length).toBeGreaterThan(0);
    expect(maintenance.requests.every((request) => request.kind === "conversation-transfer"))
      .toBe(true);
    expect(new Set(maintenance.requests.map((request) => request.workKey)).size)
      .toBeGreaterThan(1);
  });
});

function memoryStagingArea(): {
  readonly port: ConversationTransferStagingArea;
  readonly count: (transferId: string) => number;
} {
  const sessions = new Map<string, {
    readonly artifacts: Map<string, Uint8Array>;
    readonly partials: Map<string, Uint8Array>;
    readonly projection: ConversationTransferStaging;
  }>();
  const keyFor = (ref: ArtifactRef) => `${ref.digest}:${ref.bytes}`;
  const forTransfer = (transferId: string): ConversationTransferStaging => {
    const current = sessions.get(transferId);
    if (current) return current.projection;
    const artifacts = new Map<string, Uint8Array>();
    const partials = new Map<string, Uint8Array>();
    const projection = Object.freeze({
      artifacts: Object.freeze({
        get: async (ref: ArtifactRef) => {
          const value = artifacts.get(keyFor(ref));
          if (!value) throw new Error("Artifact does not exist");
          return value.slice();
        },
        readRange: async (ref: ArtifactRef, offset: number, limit: number) => {
          const value = artifacts.get(keyFor(ref));
          if (!value) throw new Error("Artifact does not exist");
          return value.slice(offset, offset + limit);
        },
        has: async (ref: ArtifactRef) => artifacts.has(keyFor(ref)),
      }),
      receiver: Object.freeze({
        progress: async (ref: ArtifactRef, runPhysicalStep = (_identity, operation) => operation()) =>
          runPhysicalStep({ step: "progress", digest: ref.digest }, async () => {
            const complete = artifacts.has(keyFor(ref));
            return {
              receivedBytes: complete ? ref.bytes : (partials.get(keyFor(ref))?.byteLength ?? 0),
              complete,
            };
          }),
        append: async (
          ref: ArtifactRef,
          offset: number,
          bytes: Uint8Array,
          runPhysicalStep = (_identity, operation) => operation(),
        ) => runPhysicalStep({ step: "append", digest: ref.digest }, async () => {
          const key = keyFor(ref);
          if (artifacts.has(key)) return { receivedBytes: ref.bytes, complete: true };
          const prefix = partials.get(key) ?? new Uint8Array();
          if (offset !== prefix.byteLength) {
            throw new RangeError("Artifact chunk does not continue the durable prefix");
          }
          const next = Buffer.concat([prefix, bytes]);
          if (next.byteLength > ref.bytes) {
            throw new RangeError("Artifact chunk exceeds the declared byte length");
          }
          if (next.byteLength === ref.bytes) {
            artifacts.set(key, next);
            partials.delete(key);
            return { receivedBytes: ref.bytes, complete: true };
          }
          partials.set(key, next);
          return { receivedBytes: next.byteLength, complete: false };
        }),
      }),
      cleanup: async () => {
        const removed = artifacts.size;
        sessions.delete(transferId);
        return removed;
      },
    }) satisfies ConversationTransferStaging;
    sessions.set(transferId, { artifacts, partials, projection });
    return projection;
  };
  return {
    port: Object.freeze({ forTransfer }),
    count: (transferId) => sessions.get(transferId)?.artifacts.size ?? 0,
  };
}

async function sourceHarness(options: {
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly conversationState?: ConversationTransferSourceOptions["conversationState"];
  readonly settleConversation?: ConversationTransferSourceOptions["settleConversation"];
} = {}) {
  const root = await createTempDir("conversation-transfer-source");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  }));
  const settled: string[] = [];
  const source = new ConversationTransferSource({
    deviceId: "device-source",
    log,
    artifacts,
    signer,
    verifier,
    acceptsConversationId: (conversationId) => conversationId === CONVERSATION,
    isCurrentAnchor: (deviceId) => deviceId === "device-target",
    storageMaintenance: options.storageMaintenance,
    conversationState: options.conversationState ?? (async (conversationId) => ({
      exists: conversationId === CONVERSATION,
      deleted: false,
      ownerEpoch: 4,
    })),
    settleConversation: options.settleConversation ?? (async (conversationId) => {
      settled.push(conversationId);
    }),
    snapshotSessionState: async () => ({
      reducerVersion: "session-state-v1",
      value: { conversationId: CONVERSATION, revision: 3 },
    }),
    clock: () => NOW,
  });
  return { artifacts, log, settled, source };
}

function recordingGovernor(): {
  readonly port: StorageMaintenanceGovernorPort;
  readonly requests: StorageMaintenanceRequest[];
} {
  const requests: StorageMaintenanceRequest[] = [];
  return {
    requests,
    port: {
      acquire: async (request, signal) => {
        if (signal.aborted) return { kind: "cancelled" };
        requests.push(request);
        return {
          kind: "granted",
          permit: {
            granted: request.preferred,
            tryBegin: () => ({ claim: () => undefined, complete: () => undefined }),
            release: () => undefined,
          },
        };
      },
      snapshot: () => ({
        queued: {},
        inFlight: {},
        estimatedDebt: {
          occupancy: { memoryReservationBytes: 0, temporaryBytes: 0, slots: 0 },
          quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
        },
        capacity: {} as never,
      }),
    },
  };
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
