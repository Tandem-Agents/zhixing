import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localConversationId } from "@zhixing-ai/core/conversation";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing-ai/core/authority";
import {
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import { ConversationRunJournal } from "@zhixing-ai/owner-kernel/conversation-assignment";
import {
  ConversationTransferIncompatibleTargetError,
  ConversationTransferSource,
  ConversationTransferTarget,
  readConversationTransferState,
} from "@zhixing-ai/owner-kernel/conversation-transfer";
import { MeshServiceRegistry } from "@zhixing-ai/mesh/service-registry";
import { DeviceKey, enrollDeviceIdentity, verifyDeviceSignature } from "@zhixing-ai/mesh/device-identity";
import { connectAuthenticatedMesh, createAuthenticatedMeshServer } from "@zhixing-ai/mesh/handshake";
import { HandshakeReplayWindow } from "@zhixing-ai/mesh/replay-window";
import { MeshRequestChannel } from "@zhixing-ai/mesh/request-channel";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  ConversationTransferMeshClient,
  registerConversationTransferMeshService,
} from "../conversation-transfer-mesh.js";
import {
  adoptLocalConversation,
  assertLocalConversationsDurablyTransferred,
} from "../local-conversation-transfer-coordinator.js";
import { deriveLocalConversationTransferAttemptIdentity } from "../local-conversation-transfer-identity.js";

const NOW = "2026-11-27T08:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

describe("adoptLocalConversation coordinator — target-only-prepared race", () => {
  it("aborts target-only prepared on legacy v1 anchor when program input arrives before source.prepare, keeps source writable, and commits after v2 upgrade", { timeout: 30_000 }, async () => {
    const root = await createTempDir("local-xfer-coord");
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const anchorKey = await DeviceKey.generate();
    const srcKey = await DeviceKey.generate();
    const anchorIdent = enrollDeviceIdentity(anchorKey, {
      displayName: "anchor",
      platform: "windows",
      enrolledAt: NOW,
    });
    const srcIdent = enrollDeviceIdentity(srcKey, {
      displayName: "exec-src",
      platform: "windows",
      enrolledAt: NOW,
    });
    const protoVerifier: ProtocolSignatureVerifier = {
      verify(schema, version, payload, sig) {
        const ident = [anchorIdent, srcIdent].find((i) => i.deviceId === sig.keyId);
        if (!ident) throw new TypeError("Unknown device");
        verifyDeviceSignature(ident, schema, version, payload, sig);
      },
    };

    const srcArt = new FileArtifactStore(path.join(root, "src-art"));
    const srcLog = new FileAuthorityCommitLog(path.join(root, "src-log"), srcArt, {
      clock: () => NOW,
    });
    cleanups.push(() => srcLog.stopStorageMaintenance());
    const convId = localConversationId(srcIdent.deviceId, "01K2AAAAAA0000000000000009");
    const srcJournal = new ConversationRunJournal({
      conversationId: convId,
      ownerEpoch: 1,
      log: srcLog,
      artifacts: srcArt,
      signer: srcKey,
      verifier: protoVerifier,
      clock: () => NOW,
      currentAuthority: { deviceId: srcIdent.deviceId, executorId: srcIdent.deviceId },
      submission: { authenticate() {}, authorize() {} },
      authority: {
        decideAtPrefix: () => ({
          committed: false,
          error: { code: "capability-gap", message: "none", retryable: false },
        }),
      },
      projection: { async project() {} },
    });
    await srcJournal.admit({
      runId: "r-init",
      ingressKey: "k-init",
      queuedPosition: 1,
      userInput: { parts: [{ type: "text", text: "v1 start" }] },
      invocation: { kind: "agent", source: "interactive" },
      ingress: {
        kind: "first-party",
        surfacePrincipal: "cli:local",
        deviceId: srcIdent.deviceId,
        ingressId: "k-init",
        receivedAt: NOW,
      },
    });

    let targetSupportsV2 = false;
    const tgtArt = new FileArtifactStore(path.join(root, "tgt-art"));
    const tgtLog = new FileAuthorityCommitLog(path.join(root, "tgt-log"), tgtArt, {
      clock: () => NOW,
    });
    cleanups.push(() => tgtLog.stopStorageMaintenance());
    const {
      currentTrustIndex,
      createTrustGenesisEvent,
      initializeTrustChain,
      createSignedTrustEvent,
      applyTrustEvent,
      buildHomeTrustRecord,
      CURRENT_TRUST_PROJECTION_ID,
      readCurrentAnchorTenure,
      readAnchorTenureAt,
    } = await import("@zhixing-ai/mesh/trust-chain");
    const { registerConversationAnchorTenure } = await import(
      "@zhixing-ai/owner-kernel/conversation-owner-authority"
    );
    currentTrustIndex(tgtLog);
    registerConversationAnchorTenure(tgtLog, {
      projectionId: CURRENT_TRUST_PROJECTION_ID,
      current: readCurrentAnchorTenure,
      at: readAnchorTenureAt,
    });
    const genesis = createTrustGenesisEvent({
      homeId: "home-coord",
      issuer: anchorIdent,
      signer: anchorKey,
      at: NOW,
    });
    const trust0 = initializeTrustChain(genesis);
    const enroll = createSignedTrustEvent({
      current: trust0,
      signer: anchorKey,
      at: NOW,
      body: { t: "enroll", device: srcIdent, roles: ["executor"] },
    });
    const trust1 = applyTrustEvent(trust0, enroll);
    await tgtLog.append([
      { stream: "trust", body: { t: "home-trust-event", event: genesis } },
      { stream: "trust", body: { t: "home-trust-event", event: enroll } },
      { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(trust1, anchorKey) } },
    ]);

    const stagingStore = new Map<string, Map<string, Uint8Array>>();
    const staging = {
      forTransfer(id: string) {
        let m = stagingStore.get(id);
        if (!m) {
          m = new Map();
          stagingStore.set(id, m);
        }
        const k = (ref: { digest: string; bytes: number }) => `${ref.digest}:${ref.bytes}`;
        return {
          artifacts: {
            get: async (ref: { digest: string; bytes: number }) => m!.get(k(ref))!,
            readRange: async (ref: { digest: string; bytes: number }, o: number, l: number) =>
              m!.get(k(ref))!.subarray(o, o + l),
            has: async (ref: { digest: string; bytes: number }) => m!.has(k(ref)),
          },
          receiver: {
            progress: async (ref: { digest: string; bytes: number }) => ({
              receivedBytes: m!.has(k(ref)) ? ref.bytes : 0,
              complete: m!.has(k(ref)),
            }),
            append: async (ref: { digest: string; bytes: number }, _o: number, b: Uint8Array) => {
              m!.set(k(ref), b);
              return { receivedBytes: ref.bytes, complete: true };
            },
          },
          cleanup: async () => {
            const count = m!.size;
            stagingStore.delete(id);
            return count;
          },
        };
      },
    };
    const tgtJournal = new ConversationRunJournal({
      conversationId: convId,
      ownerEpoch: 2,
      log: tgtLog,
      artifacts: tgtArt,
      signer: anchorKey,
      verifier: protoVerifier,
      clock: () => NOW,
      currentAuthority: { deviceId: anchorIdent.deviceId, executorId: anchorIdent.deviceId },
      submission: { authenticate() {}, authorize() {} },
      authority: {
        decideAtPrefix: () => ({
          committed: false,
          error: { code: "capability-gap", message: "none", retryable: false },
        }),
      },
      projection: { async project() {} },
    });
    const target = new ConversationTransferTarget({
      deviceId: anchorIdent.deviceId,
      log: tgtLog,
      artifacts: tgtArt,
      staging: staging as never,
      signer: anchorKey,
      verifier: protoVerifier,
      isActiveSource: (d) => d === srcIdent.deviceId,
      acceptsSourceConversationId: (d) => d === srcIdent.deviceId,
      conversationExists: () => false,
      sourceOwnerEpoch: () => 1,
      reducerVersion: "conversation-session-state-v1",
      preparePublication: async (pub) => {
        await tgtJournal.installImportedBase(pub.source);
        return { publish() {} };
      },
    });
    const source = new ConversationTransferSource({
      deviceId: srcIdent.deviceId,
      log: srcLog,
      artifacts: srcArt,
      signer: srcKey,
      verifier: protoVerifier,
      clock: () => NOW,
      targetSupportsV2InputSources: async () => targetSupportsV2,
      acceptsConversationId: (id) => id === convId,
      isCurrentAnchor: (id) => id === anchorIdent.deviceId,
      conversationState: async () => {
        const s = await srcJournal.authorityState();
        return { exists: s.hasDurableIdentity, deleted: s.deleted, ownerEpoch: 1 };
      },
      settleConversation: async () => {
        await srcJournal.resumeLifecycleProjections(async () => {});
      },
      snapshotSessionState: async () => ({
        reducerVersion: "conversation-session-state-v1",
        value: JSON.parse(
          JSON.stringify({
            meta: await srcJournal.sessionMeta(),
            taskList: await srcJournal.taskList(),
            transcript: (await srcJournal.transcriptTail()).records,
            advancement: null,
          }),
        ),
      }),
    });

    let serverChannel!: MeshRequestChannel;
    const tgtReg = new MeshServiceRegistry();
    registerConversationTransferMeshService(tgtReg, {
      target,
      signer: anchorKey,
      verifier: protoVerifier,
      clientFor: () => serverChannel,
      authorizePeer: () => true,
    });
    const srcReg = new MeshServiceRegistry();
    registerConversationTransferMeshService(srcReg, {
      source,
      signer: srcKey,
      verifier: protoVerifier,
      clientFor: () => {
        throw new Error("unused");
      },
      authorizePeer: () => true,
    });
    const server = await createAuthenticatedMeshServer(
      {
        identity: anchorKey,
        trustedPeers: [{ identity: srcIdent, rootCertificatePem: srcKey.rootCertificatePem }],
        protocolRange: { min: "1", max: "1" },
        replayWindow: new HandshakeReplayWindow(),
        authorizePeer: () => true,
      },
      (conn) => {
        serverChannel = new MeshRequestChannel(conn, tgtReg);
      },
    );
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    cleanups.push(() => new Promise<void>((res) => server.close(() => res())));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("missing port");
    const conn = await connectAuthenticatedMesh({
      host: "127.0.0.1",
      port: addr.port,
      identity: srcKey,
      trustedPeer: { identity: anchorIdent, rootCertificatePem: anchorKey.rootCertificatePem },
      protocolRange: { min: "1", max: "1" },
      authorizePeer: () => true,
    });
    const clientChannel = new MeshRequestChannel(conn, srcReg);
    cleanups.push(async () => {
      await clientChannel.close().catch(() => {});
      await conn.close().catch(() => {});
    });

    const meshClient = new ConversationTransferMeshClient(clientChannel, srcKey, protoVerifier);
    let injected = false;
    const raceClient = {
      status: (id: string) => meshClient.status(id),
      importAndCommit: (frozen: Parameters<ConversationTransferMeshClient["importAndCommit"]>[0]) =>
        meshClient.importAndCommit(frozen),
      abort: (abort: Parameters<ConversationTransferMeshClient["abort"]>[0]) =>
        meshClient.abort(abort),
      async prepare(record: Parameters<ConversationTransferMeshClient["prepare"]>[0]) {
        await meshClient.prepare(record);
        if (!injected) {
          injected = true;
          // Inject concurrent program input AFTER target prepared and BEFORE source.prepare
          await srcJournal.admit({
            runId: "r-prog-race",
            ingressKey: "k-prog-race",
            queuedPosition: 2,
            userInput: { parts: [{ type: "text", text: "concurrent program input" }] },
            invocation: { kind: "agent", source: "interactive" },
            ingress: {
              kind: "first-party",
              surfacePrincipal: "program:local",
              deviceId: srcIdent.deviceId,
              ingressId: "k-prog-race",
              receivedAt: NOW,
              turnOrigin: {
                channel: "program",
                messageIdentity: { id: "k-prog-race", source: { kind: "program" } },
              },
            },
          });
        }
      },
    };

    const prepareSpy = vi.spyOn(source, "prepare");
    await adoptLocalConversation({
      conversationId: convId,
      targetDeviceId: anchorIdent.deviceId,
      identity: { deviceId: srcIdent.deviceId, ownerEpoch: 1 },
      source,
      client: raceClient,
      executorLog: srcLog,
      verifier: protoVerifier,
    });
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    await expect(
      prepareSpy.mock.results[0]!.value,
    ).rejects.toThrow(ConversationTransferIncompatibleTargetError);

    const a1 = deriveLocalConversationTransferAttemptIdentity({
      conversationId: convId,
      sourceDeviceId: srcIdent.deviceId,
      targetDeviceId: anchorIdent.deviceId,
      sourceOwnerEpoch: 1,
      states: [],
    })!;
    expect((await target.state(a1.attempt.transferId))?.phase).toBe("aborted");
    expect((await readConversationTransferState(srcLog, a1.attempt.transferId, protoVerifier))?.phase).toBe(
      "aborted",
    );
    await expect(
      assertLocalConversationsDurablyTransferred({
        executorLog: srcLog,
        verifier: protoVerifier,
        targetDeviceId: anchorIdent.deviceId,
        conversationIds: [convId],
      }),
    ).rejects.toThrow("Device removal conversation transfer is not durably complete");

    // Upgrade target to v2 and re-run adoptLocalConversation -> derives attempt 2 and commits!
    targetSupportsV2 = true;
    await adoptLocalConversation({
      conversationId: convId,
      targetDeviceId: anchorIdent.deviceId,
      identity: { deviceId: srcIdent.deviceId, ownerEpoch: 1 },
      source,
      client: meshClient,
      executorLog: srcLog,
      verifier: protoVerifier,
    });
    await expect(
      assertLocalConversationsDurablyTransferred({
        executorLog: srcLog,
        verifier: protoVerifier,
        targetDeviceId: anchorIdent.deviceId,
        conversationIds: [convId],
      }),
    ).resolves.toBeUndefined();
    const importedMeta = await tgtJournal.sessionMeta();
    expect(importedMeta.conversationId).toBe(convId);
  });
});
