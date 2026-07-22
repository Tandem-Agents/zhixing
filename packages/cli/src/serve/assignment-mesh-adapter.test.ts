import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import type { Server as TlsServer } from "node:tls";
import {
  DeliveryAuthority,
} from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
  type ArtifactStore,
} from "@zhixing/core/authority";
import type {
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AuthorityCallContext,
  AuthorityCapability,
  CancelProofBody,
  DispatchEnvelope,
  InteractionMirrorBatch,
  LedgerEvidencePage,
  RunDispatchArguments,
  RunExecutorPort,
  RunSubmissionPort,
  SealedBundle,
  Signature,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  buildConversationActivationPayload,
  canonicalize,
  createConversationSealedBundle,
  createSignedConversationInteractionMirrorBatch,
  createSignedConversationEnvelope,
  createSignedTrustRuleSnapshot,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  interactionMirrorSeed,
  ownerControlRequestDigest,
  protocolBytes,
  protocolDigest,
  sealedBundleArtifact,
  signCancelProof,
  signConversationActivation,
  signSupersedeProof,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type UnsignedConversationEnvelope,
} from "@zhixing/core/protocol";
import { ConversationAssignmentLedger } from "@zhixing/executor";
import {
  DeviceKey,
  HandshakeReplayWindow,
  MeshRequestChannel,
  MeshServiceRegistry,
  connectAuthenticatedMesh,
  createAuthenticatedMeshServer,
  enrollDeviceIdentity,
  type SecureMeshConnection,
  type TrustedMeshPeer,
} from "@zhixing/mesh";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import {
  ConversationRunJournal,
  OwnerDeliveryParticipant,
  type AssignmentSubmissionAuthorizer,
} from "@zhixing/owner-kernel";
import { createTempDir } from "@zhixing/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSIGNMENT_ARTIFACT_SERVICE,
  RUN_EXECUTOR_SERVICE,
  RUN_SUBMISSION_SERVICE,
  AssignmentArtifactClient,
  MeshRunExecutorPort,
  MeshRunSubmissionPort,
  createAssignmentArtifactServiceHandler,
  createRunExecutorMeshServiceHandler,
  createRunSubmissionMeshServiceHandler,
} from "./assignment-mesh-adapter.js";

const NOW = "2026-07-21T00:00:00.000Z";
const EXPIRY = "2026-07-21T01:00:00.000Z";
const CONTROL_EXPIRY = "2026-07-21T00:00:30.000Z";
const DIGEST = `sha256:${"2".repeat(64)}` as const;
const TEST_DURABLE_IO_TIMEOUT_MS = 120_000;
const meshClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(meshClosers.splice(0).map((close) => close()));
});

describe("assignment mesh adapters", () => {
  it("preserves RunExecutorPort semantics after transferring the exact dispatch closure", async () => {
    const fixture = await createFixture();
    const directReceived: DispatchEnvelope[] = [];
    const directResult = await runExecutorPort(directReceived).dispatch(
      fixture.envelope,
      fixture.activation,
      ownerContext(),
    );
    const received: DispatchEnvelope[] = [];
    const executorPort = runExecutorPort(received);
    const sourceArtifacts = new CountingArtifactStore(fixture.ownerArtifacts);
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        port: executorPort,
        guard: conformanceExecutorGuard(fixture.ownerDeviceId),
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        clock: () => Date.parse(NOW),
      }),
    );
    const adapter = new MeshRunExecutorPort({
      client: fixture.executorClient,
      artifacts: sourceArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      capabilityFor: () => fixture.capability,
      chunkBytes: 1024,
      clock: () => Date.parse(NOW),
    });

    const result = await adapter.dispatch(
      fixture.envelope,
      fixture.activation,
      ownerContext(),
    );

    expect(result).toEqual(directResult);
    expect(received).toEqual(directReceived);
    expect(sourceArtifacts.getDigests).not.toContain(fixture.dispatchReferences[2]!.digest);
    expect(sourceArtifacts.rangeDigests).toContain(fixture.dispatchReferences[2]!.digest);
    for (const ref of fixture.dispatchReferences) {
      expect(await fixture.executorArtifacts.has(ref)).toBe(true);
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("materializes registered artifact closures referenced by ledger evidence", async () => {
    const fixture = await createFixture();
    const entry = {
      recordSeq: 1,
      body: {
        v: 1 as const,
        t: "received" as const,
        envelope: { ref: fixture.dispatchReferences[0]! },
        activation: fixture.activation,
      },
    };
    const pagePayload = {
      v: 1 as const,
      assignmentId: "assignment-1",
      fromSeq: 1,
      toSeq: 1,
      entries: [entry],
      chainDigest: DIGEST,
      executorId: fixture.executorId,
    };
    const page: LedgerEvidencePage = {
      ...pagePayload,
      signature: fixture.identity.sign("LedgerEvidencePage", 1, pagePayload),
    };
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        clock: () => Date.parse(NOW),
        guard: conformanceExecutorGuard(fixture.ownerDeviceId),
        port: {
          ...runExecutorPort([]),
          async queryLedger() {
            return page;
          },
        },
      }),
    );
    const sender = new MeshRunExecutorPort({
      client: fixture.executorClient,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      capabilityFor: () => fixture.capability,
      chunkBytes: 1024,
      clock: () => Date.parse(NOW),
    });
    await sender.dispatch(fixture.envelope, fixture.activation, ownerContext());

    const auditRoot = await temporaryRoot();
    const auditArtifacts = new FileArtifactStore(path.join(auditRoot, "artifacts"));
    const auditReceiver = new FileResumableArtifactReceiver(
      auditArtifacts,
      path.join(auditRoot, "partial"),
      { maxArtifactBytes: 1024 * 1024 },
    );
    const reader = new MeshRunExecutorPort({
      client: fixture.executorClient,
      artifacts: auditArtifacts,
      receiver: auditReceiver,
      verifier: fixture.identity,
      capabilityFor: () => fixture.capability,
      chunkBytes: 1024,
      clock: () => Date.parse(NOW),
    });

    await expect(
      reader.queryLedger("assignment-1", ownerContext(), { fromSeq: 1, limit: 1 }),
    ).resolves.toEqual(page);
    await expect(reader.queryLedger("assignment-1", ownerContext())).rejects.toThrow(
      "does not bind the requested range",
    );
    for (const ref of fixture.dispatchReferences) {
      expect(await auditArtifacts.has(ref)).toBe(true);
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("rejects a signed ledger page that exceeds the protocol byte budget", async () => {
    const fixture = await createFixture();
    const entries = Array.from({ length: 256 }, (_, index) => ({
      recordSeq: index + 1,
      body: {
        v: 1,
        t: "oversized-test-record",
        padding: "x".repeat(2 * 1024),
      },
    }));
    const payload = {
      v: 1 as const,
      assignmentId: "assignment-1",
      fromSeq: 1,
      toSeq: entries.length,
      entries,
      chainDigest: DIGEST,
      executorId: fixture.executorId,
    };
    const page = {
      ...payload,
      signature: fixture.identity.sign("LedgerEvidencePage", 1, payload),
    } as unknown as LedgerEvidencePage;
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        clock: () => Date.parse(NOW),
        guard: conformanceExecutorGuard(fixture.ownerDeviceId),
        port: {
          ...runExecutorPort([]),
          async queryLedger() {
            return page;
          },
        },
      }),
    );
    const reader = new MeshRunExecutorPort({
      client: fixture.executorClient,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      capabilityFor: () => fixture.capability,
      clock: () => Date.parse(NOW),
    });

    await expect(
      reader.queryLedger("assignment-1", ownerContext(), { fromSeq: 1, limit: 256 }),
    ).rejects.toThrow("protocol byte limit");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("uploads a sealed bundle and its dependencies before invoking RunSubmissionPort", async () => {
    const fixture = await createFixture();
    const outputRef = await fixture.executorArtifacts.put(Buffer.from("output attachment"));
    const runRecord = {
      type: "run" as const,
      runId: "run-1",
      runIndex: 1,
      timestamp: NOW,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "write" }] },
        {
          role: "assistant" as const,
          content: [{
            type: "tool_use" as const,
            id: "tool-1",
            name: "write",
            input: { output: outputRef },
          }],
        },
      ],
    };
    const runRecordRef = await fixture.executorArtifacts.put(
      Buffer.from(canonicalize(runRecord), "utf8"),
    );
    const bundle = createConversationSealedBundle({
      assignmentId: "assignment-1",
      executorId: fixture.executorId,
      streamFinal: { finalSeq: 1, streamDigest: DIGEST },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      usageFinal: { reportDigest: DIGEST, upToUsageSeq: 1 },
      dependencyArtifacts: [outputRef],
      body: {
        t: "conversation",
        runId: "run-1",
        conversationId: "conversation-1",
        ownerEpoch: 1,
        baseRevision: 0,
        runRecord: { ref: runRecordRef },
        contentAssets: [],
      },
    });
    const context = assignmentContext(fixture.capability);
    const directSubmitted: SealedBundle[] = [];
    const directResult = await runSubmissionPort(directSubmitted).submitBundle(bundle, context);
    const submitted: SealedBundle[] = [];
    fixture.ownerServices.set(
      RUN_SUBMISSION_SERVICE,
      createRunSubmissionMeshServiceHandler({
        port: runSubmissionPort(submitted),
        guard: conformanceSubmissionGuard(),
        artifacts: fixture.ownerArtifacts,
        clock: () => Date.parse(NOW),
      }),
    );
    const adapter = new MeshRunSubmissionPort({
      client: fixture.ownerClient,
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      chunkBytes: 1024,
      clock: () => Date.parse(NOW),
    });

    await expect(adapter.submitBundle(bundle, context)).resolves.toEqual(directResult);
    expect(submitted).toEqual(directSubmitted);
    expect(await fixture.ownerArtifacts.has(runRecordRef)).toBe(true);
    expect(await fixture.ownerArtifacts.has(outputRef)).toBe(true);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("pulls the sealed bundle closure returned by ledger recovery", async () => {
    const fixture = await createFixture();
    const nestedRef = await fixture.executorArtifacts.put(Buffer.from("recovered attachment"));
    const runRecord = {
      type: "run" as const,
      runId: "run-1",
      runIndex: 1,
      timestamp: NOW,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "read" }] },
        {
          role: "assistant" as const,
          content: [{
            type: "tool_use" as const,
            id: "tool-1",
            name: "read",
            input: { attachment: nestedRef },
          }],
        },
      ],
    };
    const runRecordRef = await fixture.executorArtifacts.put(
      Buffer.from(canonicalize(runRecord), "utf8"),
    );
    const bundle = createConversationSealedBundle({
      assignmentId: "assignment-1",
      executorId: fixture.executorId,
      streamFinal: { finalSeq: 1, streamDigest: DIGEST },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      usageFinal: { reportDigest: DIGEST, upToUsageSeq: 1 },
      dependencyArtifacts: [nestedRef],
      body: {
        t: "conversation",
        runId: "run-1",
        conversationId: "conversation-1",
        ownerEpoch: 1,
        baseRevision: 0,
        runRecord: { ref: runRecordRef },
        contentAssets: [],
      },
    });
    const bundleArtifact = sealedBundleArtifact(bundle);
    await fixture.executorArtifacts.put(bundleArtifact.bytes);
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        clock: () => Date.parse(NOW),
        guard: conformanceExecutorGuard(fixture.ownerDeviceId),
        port: {
          ...runExecutorPort([]),
          async queryLedger(assignmentId) {
            return {
              v: 1,
              assignmentId,
              lastSeq: 2,
              phase: "sealed",
              sealedBundleRef: bundleArtifact.ref,
            };
          },
        },
      }),
    );
    const adapter = new MeshRunExecutorPort({
      client: fixture.executorClient,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      capabilityFor: () => fixture.capability,
      chunkBytes: 1024,
      clock: () => Date.parse(NOW),
    });

    const snapshot = await adapter.queryLedger("assignment-1", ownerContext());

    expect(snapshot).toMatchObject({ phase: "sealed", sealedBundleRef: bundleArtifact.ref });
    for (const ref of [bundleArtifact.ref, runRecordRef, nestedRef]) {
      expect(await fixture.ownerArtifacts.has(ref)).toBe(true);
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("resumes a failed range upload, skips an existing digest and rejects the wrong assignment", async () => {
    const fixture = await createFixture();
    const ref = await fixture.ownerArtifacts.put(Buffer.alloc(40, 0x6b));
    let appendCalls = 0;
    let failOnce = true;
    const unstableClient: MeshServiceClient = {
      request: async (serviceId, payload) => {
        if (serviceId === ASSIGNMENT_ARTIFACT_SERVICE) {
          const request = JSON.parse(Buffer.from(payload).toString("utf8")) as { t?: string };
          if (request.t === "append" && ++appendCalls === 2 && failOnce) {
            failOnce = false;
            throw new Error("connection lost");
          }
        }
        return fixture.executorClient.request(serviceId, payload);
      },
    };
    const first = new AssignmentArtifactClient({
      client: unstableClient,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      chunkBytes: 10,
    });
    await expect(first.upload("assignment-1", fixture.capability, [ref])).rejects.toThrow(
      "connection lost",
    );

    const resumed = new AssignmentArtifactClient({
      client: fixture.executorClient,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      chunkBytes: 10,
    });
    await resumed.upload("assignment-1", fixture.capability, [ref]);
    expect(await fixture.executorArtifacts.has(ref)).toBe(true);
    const callsAfterCompletion = fixture.executorClient.calls;
    await resumed.upload("assignment-1", fixture.capability, [ref]);
    expect(fixture.executorClient.calls).toBe(callsAfterCompletion + 1);

    const emptyRef = await fixture.ownerArtifacts.put(Buffer.alloc(0));
    await resumed.upload("assignment-1", fixture.capability, [emptyRef]);
    expect(await fixture.executorArtifacts.has(emptyRef)).toBe(true);
    await resumed.upload("assignment-1", fixture.capability, [emptyRef]);

    const downloadRoot = await temporaryRoot();
    const downloadArtifacts = new FileArtifactStore(path.join(downloadRoot, "artifacts"));
    const downloadReceiver = new FileResumableArtifactReceiver(
      downloadArtifacts,
      path.join(downloadRoot, "partial"),
      { maxArtifactBytes: 1024 * 1024 },
    );
    const downloader = new AssignmentArtifactClient({
      client: fixture.executorClient,
      artifacts: downloadArtifacts,
      receiver: downloadReceiver,
      chunkBytes: 10,
    });
    await downloader.download("assignment-1", fixture.capability, [emptyRef]);
    expect(await downloadArtifacts.has(emptyRef)).toBe(true);
    await downloader.download("assignment-1", fixture.capability, [emptyRef]);

    await expect(resumed.upload("assignment-other", fixture.capability, [ref])).rejects.toThrow(
      "does not bind",
    );
    let customAuthorizationReached = false;
    const handler = createAssignmentArtifactServiceHandler({
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      authorize: () => {
        customAuthorizationReached = true;
      },
      clock: () => Date.parse(NOW),
    });
    await expect(handler(
      Buffer.from(canonicalize({
        v: 1,
        t: "probe",
        direction: "receive",
        assignmentId: "assignment-other",
        capability: fixture.capability,
        ref,
      }), "utf8"),
      { peer: { deviceId: "peer-1" } } as SecureMeshConnection,
      new AbortController().signal,
    )).rejects.toThrow("does not bind");
    expect(customAuthorizationReached).toBe(false);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("finalizes a non-empty durable prefix before reporting upload success", async () => {
    const fixture = await createFixture();
    const content = Buffer.from("complete prefix awaiting finalization");
    const ref = await fixture.ownerArtifacts.put(content);
    const requests: Array<{ readonly t: string; readonly offset?: number; readonly bytes?: string }> = [];
    const client: MeshServiceClient = {
      async request(serviceId, payload) {
        expect(serviceId).toBe(ASSIGNMENT_ARTIFACT_SERVICE);
        const request = JSON.parse(Buffer.from(payload).toString("utf8")) as {
          readonly t: string;
          readonly offset?: number;
          readonly bytes?: string;
        };
        requests.push(request);
        const response = request.t === "probe"
          ? { receivedBytes: 0, complete: false }
          : request.bytes === ""
            ? { receivedBytes: ref.bytes, complete: true }
            : { receivedBytes: ref.bytes, complete: false };
        return Buffer.from(canonicalize(response), "utf8");
      },
    };
    const uploader = new AssignmentArtifactClient({
      client,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      chunkBytes: ref.bytes,
    });

    await uploader.upload("assignment-1", fixture.capability, [ref]);

    expect(requests.map(({ t, offset, bytes }) => ({ t, offset, bytes }))).toEqual([
      { t: "probe", offset: undefined, bytes: undefined },
      { t: "append", offset: 0, bytes: content.toString("base64") },
      { t: "append", offset: ref.bytes, bytes: "" },
    ]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("preserves the non-artifact methods of both assignment ports", async () => {
    const fixture = await createFixture();
    const fence = { fenceSeq: 2, requestId: "fence-2" };
    const supersedeProof = signSupersedeProof({
      v: 1,
      assignmentId: "assignment-1",
      executorId: fixture.executorId,
      fence,
      decision: "not-started-fenced",
      lastRecordSeq: 2,
      ledgerDigest: DIGEST,
    }, fixture.identity);
    const executorCalls: unknown[][] = [];
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        clock: () => Date.parse(NOW),
        guard: conformanceExecutorGuard(fixture.ownerDeviceId),
        port: {
          ...runExecutorPort([]),
          async cancel(...args) {
            executorCalls.push(["cancel", ...args]);
          },
          async supersede(...args) {
            executorCalls.push(["supersede", ...args]);
            return supersedeProof;
          },
          async queryLedger(...args) {
            executorCalls.push(["queryLedger", ...args]);
            return { v: 1, assignmentId: args[0], lastSeq: 0, phase: "unknown" };
          },
        },
      }),
    );
    const executorAdapter = new MeshRunExecutorPort({
      client: fixture.executorClient,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      capabilityFor: () => fixture.capability,
      chunkBytes: 1024,
      clock: () => Date.parse(NOW),
    });
    const owner = ownerContext();
    await executorAdapter.cancel("assignment-1", fence, owner);
    await expect(executorAdapter.supersede("assignment-1", fence, owner)).resolves.toEqual(
      supersedeProof,
    );
    await expect(
      executorAdapter.queryLedger("assignment-1", owner, { fromSeq: 1, limit: 16 }),
    ).rejects.toThrow("does not bind the requested range");
    expect(executorCalls).toEqual([
      ["cancel", "assignment-1", fence, owner],
      ["supersede", "assignment-1", fence, owner],
      ["queryLedger", "assignment-1", owner, { fromSeq: 1, limit: 16 }],
    ]);
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        clock: () => Date.parse(NOW),
        guard: conformanceExecutorGuard(fixture.ownerDeviceId),
        port: {
          ...runExecutorPort([]),
          async queryLedger() {
            return { v: 1, assignmentId: "assignment-other", lastSeq: 0, phase: "unknown" };
          },
        },
      }),
    );
    await expect(executorAdapter.queryLedger("assignment-1", owner)).rejects.toThrow(
      "different assignment",
    );

    const cancelProof: CancelProofBody = signCancelProof({
      v: 1,
      assignmentId: "assignment-1",
      executorId: fixture.executorId,
      authority: {
        execution: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      lastRecordSeq: 3,
      usageFinal: { reportDigest: DIGEST, upToUsageSeq: 1 },
      ledgerDigest: DIGEST,
      issuedAt: NOW,
      cause: "owner-fence",
      fence,
      decision: "not-started",
    }, fixture.identity);
    const mirror = createSignedConversationInteractionMirrorBatch({
      assignmentId: "assignment-1",
      executorId: fixture.executorId,
      previousDigest: DIGEST,
      entries: [{
        seq: 1,
        ordinal: 1,
        requestId: "interaction-1",
        kind: "allow-once",
        outcome: { t: "expired" },
        at: NOW,
      }],
      signer: fixture.identity,
    });
    const submissionCalls: unknown[][] = [];
    fixture.ownerServices.set(
      RUN_SUBMISSION_SERVICE,
      createRunSubmissionMeshServiceHandler({
        artifacts: fixture.ownerArtifacts,
        clock: () => Date.parse(NOW),
        guard: conformanceSubmissionGuard(),
        port: {
          ...runSubmissionPort([]),
          async reportStarted(...args) {
            submissionCalls.push(["reportStarted", ...args]);
          },
          async submitCancelProof(...args) {
            submissionCalls.push(["submitCancelProof", ...args]);
          },
          async mirrorInteractions(...args) {
            submissionCalls.push(["mirrorInteractions", ...args]);
            return {
              mirroredUpTo: mirror.entries[0]!.seq,
              ordinal: mirror.entries[0]!.ordinal,
              mirrorDigest: mirror.mirrorDigest,
            };
          },
        },
      }),
    );
    const submissionAdapter = new MeshRunSubmissionPort({
      client: fixture.ownerClient,
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      clock: () => Date.parse(NOW),
    });
    const assignment = assignmentContext(fixture.capability);
    await submissionAdapter.reportStarted("assignment-1", assignment);
    await submissionAdapter.submitCancelProof("assignment-1", cancelProof, assignment);
    await expect(
      submissionAdapter.mirrorInteractions("assignment-1", mirror, assignment),
    ).resolves.toEqual({
      mirroredUpTo: 1,
      ordinal: 1,
      mirrorDigest: mirror.mirrorDigest,
    });
    expect(submissionCalls).toEqual([
      ["reportStarted", "assignment-1", assignment],
      ["submitCancelProof", "assignment-1", cancelProof, assignment],
      ["mirrorInteractions", "assignment-1", mirror, assignment],
    ]);
    fixture.ownerServices.set(
      RUN_SUBMISSION_SERVICE,
      createRunSubmissionMeshServiceHandler({
        artifacts: fixture.ownerArtifacts,
        clock: () => Date.parse(NOW),
        guard: conformanceSubmissionGuard(),
        port: {
          ...runSubmissionPort([]),
          async mirrorInteractions() {
            return { mirroredUpTo: 1, ordinal: 1, mirrorDigest: DIGEST };
          },
        },
      }),
    );
    await expect(
      submissionAdapter.mirrorInteractions("assignment-1", mirror, assignment),
    ).rejects.toThrow("does not bind");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("preserves a real journal and ledger lifecycle across the mesh boundary", async () => {
    const fixture = await createFixture();
    const protocol = await createRealProtocolFixture(fixture);
    installRealProtocolServices(fixture, protocol);
    const executor = realExecutorAdapter(fixture, protocol);
    const submission = realSubmissionAdapter(fixture);
    const dispatchContext = realOwnerContext({
      dispatch: protocol.dispatch,
      method: "executor.dispatch",
      requestId: "real-dispatch",
      body: {
        dispatchDigest: dispatchEnvelopeDigest(protocol.dispatch.envelope),
        activationDigest: activationDigest(protocol.dispatch.activation),
      },
      ownerDeviceId: fixture.ownerDeviceId,
      identity: fixture.identity,
    });

    const remoteDispatch = await executor.dispatch(
      protocol.dispatch.envelope,
      protocol.dispatch.activation,
      dispatchContext,
    );
    const executorAfterDispatch = await protocol.executorLog.readAll();
    await expect(protocol.ledger.dispatch(
      protocol.dispatch.envelope,
      protocol.dispatch.activation,
      dispatchContext,
    )).resolves.toEqual(remoteDispatch);
    expect(await protocol.executorLog.readAll()).toEqual(executorAfterDispatch);

    const queryContext = realOwnerContext({
      dispatch: protocol.dispatch,
      method: "executor.queryLedger",
      requestId: "real-query",
      body: { range: null },
      ownerDeviceId: fixture.ownerDeviceId,
      identity: fixture.identity,
    });
    await expect(
      executor.queryLedger("assignment-1", queryContext),
    ).resolves.toEqual(
      await protocol.ledger.queryLedger("assignment-1", queryContext),
    );

    await protocol.ledger.start("assignment-1");
    const assignment = assignmentContext(protocol.dispatch.envelope.capabilities[0]!);
    await submission.reportStarted("assignment-1", assignment);
    const ownerAfterStarted = await protocol.ownerLog.readAll();
    await expect(
      protocol.journal.reportStarted("assignment-1", assignment),
    ).resolves.toBeUndefined();
    expect(await protocol.ownerLog.readAll()).toEqual(ownerAfterStarted);

    await protocol.ledger.requestInteraction("assignment-1", {
      requestId: "real-interaction",
      toolName: "write",
      display: { title: "Write", lines: ["workspace/result.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-21T00:01:00.000Z",
    });
    await protocol.ledger.finishInteraction("assignment-1", "real-interaction", {
      t: "expired",
    });
    const batch = await protocol.ledger.pendingInteractionMirrorBatch("assignment-1");
    if (!batch) throw new Error("expected a pending interaction mirror batch");
    const remoteMirror = await submission.mirrorInteractions(
      "assignment-1",
      batch,
      assignment,
    );
    const ownerAfterMirror = await protocol.ownerLog.readAll();
    await expect(
      protocol.journal.mirrorInteractions("assignment-1", batch, assignment),
    ).resolves.toEqual(remoteMirror);
    expect(await protocol.ownerLog.readAll()).toEqual(ownerAfterMirror);
    await protocol.ledger.markInteractionsMirrored("assignment-1", remoteMirror);

    const bundle = await protocol.ledger.sealConversationBundle("assignment-1", {
      runRecord: {
        type: "run",
        runId: "run-1",
        runIndex: 1,
        timestamp: NOW,
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      } satisfies TranscriptRunRecord,
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: DIGEST },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: DIGEST, upToUsageSeq: 0 },
    });
    const remoteCommit = await submission.submitBundle(bundle, assignment);
    const ownerAfterCommit = await protocol.ownerLog.readAll();
    await expect(protocol.journal.submitBundle(bundle, assignment)).resolves.toEqual(
      remoteCommit,
    );
    expect(await protocol.ownerLog.readAll()).toEqual(ownerAfterCommit);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("preserves real cancellation and supersede guards across the mesh boundary", async () => {
    const fixture = await createFixture();
    const protocol = await createRealProtocolFixture(fixture);
    installRealProtocolServices(fixture, protocol);
    const executor = realExecutorAdapter(fixture, protocol);
    const submission = realSubmissionAdapter(fixture);
    const dispatchContext = realOwnerContext({
      dispatch: protocol.dispatch,
      method: "executor.dispatch",
      requestId: "cancel-dispatch",
      body: {
        dispatchDigest: dispatchEnvelopeDigest(protocol.dispatch.envelope),
        activationDigest: activationDigest(protocol.dispatch.activation),
      },
      ownerDeviceId: fixture.ownerDeviceId,
      identity: fixture.identity,
    });
    await executor.dispatch(
      protocol.dispatch.envelope,
      protocol.dispatch.activation,
      dispatchContext,
    );

    const cancellation = await protocol.journal.cancelRun({
      runId: "run-1",
      requestId: "real-cancel",
    });
    if (cancellation.state !== "cancel-requested") {
      throw new Error("expected a durable cancellation fence");
    }
    const cancelContext = realOwnerContext({
      dispatch: protocol.dispatch,
      method: "executor.cancel",
      requestId: cancellation.fence.requestId,
      body: { fenceSeq: cancellation.fence.fenceSeq },
      ownerDeviceId: fixture.ownerDeviceId,
      identity: fixture.identity,
    });
    await executor.cancel("assignment-1", cancellation.fence, cancelContext);
    const executorAfterCancel = await protocol.executorLog.readAll();
    await expect(
      protocol.ledger.cancel("assignment-1", cancellation.fence, cancelContext),
    ).resolves.toBeUndefined();
    expect(await protocol.executorLog.readAll()).toEqual(executorAfterCancel);
    const proof = await protocol.ledger.cancelProof("assignment-1");
    if (!proof) throw new Error("expected a durable cancellation proof");
    const assignment = assignmentContext(protocol.dispatch.envelope.capabilities[0]!);
    await submission.submitCancelProof("assignment-1", proof, assignment);
    const ownerAfterCancel = await protocol.ownerLog.readAll();
    await expect(
      protocol.journal.submitCancelProof("assignment-1", proof, assignment),
    ).resolves.toBeUndefined();
    expect(await protocol.ownerLog.readAll()).toEqual(ownerAfterCancel);

    const fence = { fenceSeq: cancellation.fence.fenceSeq + 1, requestId: "real-supersede" };
    const supersedeContext = realOwnerContext({
      dispatch: protocol.dispatch,
      method: "executor.supersede",
      requestId: fence.requestId,
      body: { fenceSeq: fence.fenceSeq },
      ownerDeviceId: fixture.ownerDeviceId,
      identity: fixture.identity,
    });
    await expect(
      executor.supersede("assignment-1", fence, supersedeContext),
    ).rejects.toThrow("Terminated assignment cannot be superseded through a new fence");
    await expect(
      protocol.ledger.supersede("assignment-1", fence, supersedeContext),
    ).rejects.toThrow("Terminated assignment cannot be superseded through a new fence");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("authorizes authenticated peers before decoding or dereferencing protected payloads", async () => {
    const fixture = await createFixture();
    const deniedArtifact = createAssignmentArtifactServiceHandler({
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      authorize: () => {
        throw new Error("artifact denied");
      },
      clock: () => Date.parse(NOW),
    });
    await expect(deniedArtifact(
      Buffer.from(canonicalize({
        v: 1,
        t: "append",
        assignmentId: "assignment-1",
        capability: fixture.capability,
        ref: fixture.dispatchReferences[0],
        offset: 0,
        bytes: "not-base64",
      }), "utf8"),
      { peer: { deviceId: "test-owner" } } as SecureMeshConnection,
      new AbortController().signal,
    )).rejects.toThrow("artifact denied");

    const countingExecutor = new CountingArtifactStore(fixture.executorArtifacts);
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        artifacts: countingExecutor,
        verifier: fixture.identity,
        clock: () => Date.parse(NOW),
        guard: {
          async preflightOwnerControl() {
            throw new Error("owner denied");
          },
        },
        port: runExecutorPort([]),
      }),
    );
    const executorAdapter = new MeshRunExecutorPort({
      client: fixture.executorClient,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      capabilityFor: () => fixture.capability,
      chunkBytes: 1024,
      clock: () => Date.parse(NOW),
    });
    await expect(
      executorAdapter.dispatch(fixture.envelope, fixture.activation, ownerContext()),
    ).rejects.toThrow("owner denied");
    expect(countingExecutor.getCalls).toBe(0);

    const countingOwner = new CountingArtifactStore(fixture.ownerArtifacts);
    const submissionHandler = createRunSubmissionMeshServiceHandler({
      artifacts: countingOwner,
      clock: () => Date.parse(NOW),
      guard: conformanceSubmissionGuard(),
      port: runSubmissionPort([]),
    });
    await expect(submissionHandler(
      Buffer.from(canonicalize({
        v: 1,
        method: "submitBundle",
        assignmentId: "assignment-1",
        bundleRef: fixture.dispatchReferences[0],
        context: assignmentContext(fixture.capability),
      }), "utf8"),
      { peer: { deviceId: "executor-other" } } as SecureMeshConnection,
      new AbortController().signal,
    )).rejects.toThrow("authenticated executor");
    expect(countingOwner.getCalls).toBe(0);

    let expiredGuardCalls = 0;
    let expiredPortCalls = 0;
    const expiredSubmission = createRunSubmissionMeshServiceHandler({
      artifacts: fixture.ownerArtifacts,
      clock: () => Date.parse(EXPIRY) + 1,
      guard: {
        async preflightSubmission() {
          expiredGuardCalls += 1;
        },
      },
      port: {
        ...runSubmissionPort([]),
        async reportStarted() {
          expiredPortCalls += 1;
        },
      },
    });
    await expect(expiredSubmission(
      Buffer.from(canonicalize({
        v: 1,
        method: "reportStarted",
        assignmentId: "assignment-1",
        context: assignmentContext(fixture.capability),
      }), "utf8"),
      { peer: { deviceId: fixture.executorId } } as SecureMeshConnection,
      new AbortController().signal,
    )).rejects.toThrow("deadline has expired");
    expect(expiredGuardCalls).toBe(0);
    expect(expiredPortCalls).toBe(0);
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});

async function createFixture() {
  const root = await temporaryRoot();
  const ownerServices = new Map<string, ServiceHandler>();
  const executorServices = new Map<string, ServiceHandler>();
  const mesh = await createAuthenticatedChannelPair(ownerServices, executorServices);
  meshClosers.push(mesh.close);
  const identity = new TestProtocolIdentity(mesh.ownerDeviceId);
  const ownerArtifacts = new FileArtifactStore(path.join(root, "owner-artifacts"));
  const executorArtifacts = new FileArtifactStore(path.join(root, "executor-artifacts"));
  const ownerReceiver = new FileResumableArtifactReceiver(
    ownerArtifacts,
    path.join(root, "owner-partial"),
    { maxArtifactBytes: 1024 * 1024 },
  );
  const executorReceiver = new FileResumableArtifactReceiver(
    executorArtifacts,
    path.join(root, "executor-partial"),
    { maxArtifactBytes: 1024 * 1024 },
  );
  const nestedRef = await ownerArtifacts.put(Buffer.from("window attachment"));
  const messages = [{
    role: "user" as const,
    content: [{
      type: "tool_use" as const,
      id: "tool-1",
      name: "read",
      input: { attachment: nestedRef },
    }],
  }];
  const windowRef = await ownerArtifacts.put(Buffer.from(canonicalize(messages), "utf8"));
  const unsigned = createUnsignedEnvelope(
    identity,
    windowRef,
    nestedRef,
    mesh.executorDeviceId,
  );
  const envelope = createSignedConversationEnvelope(unsigned, identity, identity);
  const dispatchRef = dispatchEnvelopeArtifact(envelope).ref;
  const activationPayload: AssignmentActivationPayload<"conversation"> =
    buildConversationActivationPayload({
      envelope,
      dispatchRef,
      commit: { lsn: 1, envelopeDigest: DIGEST },
      issuedAt: NOW,
    });
  const activation = signConversationActivation(activationPayload, identity);
  const capability = envelope.capabilities[0]!;
  const authorize = (
    expectedPeerDeviceId: string,
  ) => ({
    capability: presented,
    connection,
  }: {
    capability: AuthorityCapability;
    connection: SecureMeshConnection;
  }) => {
    if (presented.assignmentId !== capability.assignmentId) {
      throw new Error("wrong assignment");
    }
    if (connection.peer.deviceId !== expectedPeerDeviceId) {
      throw new Error("wrong authenticated artifact peer");
    }
  };
  ownerServices.set(
    ASSIGNMENT_ARTIFACT_SERVICE,
    createAssignmentArtifactServiceHandler({
      artifacts: ownerArtifacts,
      receiver: ownerReceiver,
      authorize: authorize(mesh.executorDeviceId),
      maxRangeBytes: 2048,
      clock: () => Date.parse(NOW),
    }),
  );
  executorServices.set(
    ASSIGNMENT_ARTIFACT_SERVICE,
    createAssignmentArtifactServiceHandler({
      artifacts: executorArtifacts,
      receiver: executorReceiver,
      authorize: authorize(mesh.ownerDeviceId),
      maxRangeBytes: 2048,
      clock: () => Date.parse(NOW),
    }),
  );
  const ownerClient = new CountingClient(mesh.ownerClient);
  const executorClient = new CountingClient(mesh.executorClient);
  return {
    root,
    identity,
    ownerArtifacts,
    executorArtifacts,
    ownerReceiver,
    executorReceiver,
    ownerServices,
    executorServices,
    ownerClient,
    executorClient,
    envelope,
    unsigned,
    activation,
    capability,
    ownerDeviceId: mesh.ownerDeviceId,
    executorId: mesh.executorDeviceId,
    dispatchReferences: [dispatchRef, windowRef, nestedRef],
  };
}

async function createRealProtocolFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const ownerLog = new FileAuthorityCommitLog(
    path.join(fixture.root, "owner-authority"),
    fixture.ownerArtifacts,
    { clock: () => NOW, lockWaitMs: 2_000 },
  );
  const executorLog = new FileAuthorityCommitLog(
    path.join(fixture.root, "executor-authority"),
    fixture.executorArtifacts,
    { clock: () => NOW, lockWaitMs: 2_000 },
  );
  const submissionAuthorizer: AssignmentSubmissionAuthorizer = {
    authenticate(context, identity) {
      if (
        context.principal.kind !== "assignment" ||
        context.principal.capability.assignmentId !== identity.assignmentId ||
        !context.principal.capability.methods.includes(identity.method)
      ) {
        throw new Error("assignment submission authentication failed");
      }
    },
    authorize(context, authorization) {
      this.authenticate(context, authorization);
    },
  };
  const journal = new ConversationRunJournal({
    conversationId: "conversation-1",
    ownerEpoch: 1,
    log: ownerLog,
    artifacts: fixture.ownerArtifacts,
    signer: fixture.identity,
    verifier: fixture.identity,
    submission: submissionAuthorizer,
    authority: {
      decideAtPrefix: () => ({ committed: true, commitRevision: 1 }),
    },
    projection: { async project() {} },
    delivery: new OwnerDeliveryParticipant({
      authority: new DeliveryAuthority({ log: ownerLog, anchorEpoch: 1 }),
    }),
    clock: () => NOW,
  });
  await journal.admit({
    ingressKey: "surface-1/ingress-1",
    runId: "run-1",
    userInput: { parts: [{ type: "text", text: "hello" }] },
    ingress: fixture.unsigned.work.ingress,
    invocation: { kind: "agent", source: "interactive" },
    queuedPosition: 0,
  });
  const dispatch = await journal.assign(fixture.unsigned);
  const trustSnapshot = createSignedTrustRuleSnapshot(
    { snapshotVersion: 1, rules: [], generatedAt: NOW },
    fixture.identity,
  );
  const capabilitySignature = { alg: "test", keyId: "test", sig: "test" };
  const ledger = new ConversationAssignmentLedger({
    log: executorLog,
    artifacts: fixture.executorArtifacts,
    executorId: fixture.executorId,
    signer: fixture.identity,
    verifier: fixture.identity,
    ownerControl: {
      authorize(context, request, authenticatedCallerDeviceId) {
        if (context.principal.kind !== "owner-control") {
          throw new Error("owner control principal is required");
        }
        const grant = context.principal.grant;
        const expectedDigest = ownerControlRequestDigest({
          method: request.method,
          assignmentId: request.assignmentId,
          ...(request.authority === undefined ? {} : { authority: request.authority }),
          requestId: request.requestId,
          body: request.body,
        });
        if (
          grant.assignmentId !== request.assignmentId ||
          grant.callerDeviceId !== authenticatedCallerDeviceId ||
          grant.callerDeviceId !== fixture.ownerDeviceId ||
          grant.requestId !== request.requestId ||
          grant.requestDigest !== expectedDigest ||
          !grant.methods.includes(request.method) ||
          (request.expectedOwnerDeviceId !== undefined &&
            request.expectedOwnerDeviceId !== grant.callerDeviceId)
        ) {
          throw new Error("owner control authorization failed");
        }
        return {
          authority: structuredClone(grant.scope),
          ownerDeviceId: grant.callerDeviceId,
          controlLease: structuredClone(grant.controlLease),
        };
      },
    },
    snapshotFor: (executorId) => executorId === fixture.executorId
      ? {
          descriptor: {
            v: 1,
            executorId,
            revision: 1,
            protocolVersion: "1",
            workspaces: [],
            tools: [],
            mcpServers: [],
            credentialBindings: [],
            evidenceCapabilities: [],
            at: NOW,
            signature: capabilitySignature,
          },
          inventory: {
            v: 1,
            executorId,
            inventoryRevision: 1,
            capabilityRevision: 1,
            configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
            assetVersions: { skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1 },
            permissionSnapshotHighWater: 1,
            credentialBindingRevisions: [],
            at: NOW,
            signature: capabilitySignature,
          },
        }
      : undefined,
    permissionSnapshotFor: (digest) => trustSnapshot.digest === digest
      ? trustSnapshot
      : undefined,
    clock: () => NOW,
  });
  return { dispatch, journal, ledger, ownerLog, executorLog };
}

function installRealProtocolServices(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  protocol: Awaited<ReturnType<typeof createRealProtocolFixture>>,
): void {
  fixture.executorServices.set(
    RUN_EXECUTOR_SERVICE,
    createRunExecutorMeshServiceHandler({
      port: protocol.ledger,
      guard: protocol.ledger,
      artifacts: fixture.executorArtifacts,
      verifier: fixture.identity,
      clock: () => Date.parse(NOW),
    }),
  );
  fixture.ownerServices.set(
    RUN_SUBMISSION_SERVICE,
    createRunSubmissionMeshServiceHandler({
      port: protocol.journal,
      guard: protocol.journal,
      artifacts: fixture.ownerArtifacts,
      clock: () => Date.parse(NOW),
    }),
  );
}

function realExecutorAdapter(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  protocol: Awaited<ReturnType<typeof createRealProtocolFixture>>,
): MeshRunExecutorPort {
  return new MeshRunExecutorPort({
    client: fixture.executorClient,
    artifacts: fixture.ownerArtifacts,
    receiver: fixture.ownerReceiver,
    verifier: fixture.identity,
    capabilityFor: () => protocol.dispatch.envelope.capabilities[0]!,
    chunkBytes: 1024,
    clock: () => Date.parse(NOW),
  });
}

function realSubmissionAdapter(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): MeshRunSubmissionPort {
  return new MeshRunSubmissionPort({
    client: fixture.ownerClient,
    artifacts: fixture.executorArtifacts,
    receiver: fixture.executorReceiver,
    chunkBytes: 1024,
    clock: () => Date.parse(NOW),
  });
}

function activationDigest(
  activation: AssignmentActivationProof<"conversation">,
): string {
  const { signature: _, ...payload } = activation;
  return protocolDigest("AssignmentActivationPayload", 1, payload);
}

function realOwnerContext(input: {
  readonly dispatch: Awaited<ReturnType<ConversationRunJournal["assign"]>>;
  readonly method:
    | "executor.dispatch"
    | "executor.queryLedger"
    | "executor.cancel"
    | "executor.supersede";
  readonly requestId: string;
  readonly body: unknown;
  readonly ownerDeviceId: string;
  readonly identity: TestProtocolIdentity;
}): AuthorityCallContext {
  const scope = input.dispatch.envelope.controlLease.authority;
  const grantPayload = {
    v: 1 as const,
    assignmentId: input.dispatch.envelope.assignmentId,
    scope,
    methods: [input.method],
    callerDeviceId: input.ownerDeviceId,
    requestId: input.requestId,
    requestDigest: ownerControlRequestDigest({
      method: input.method,
      assignmentId: input.dispatch.envelope.assignmentId,
      authority: scope,
      requestId: input.requestId,
      body: input.body,
    }),
    controlLease: input.dispatch.envelope.controlLease,
    issuedAt: NOW,
    expiry: CONTROL_EXPIRY,
  };
  return {
    principal: {
      kind: "owner-control",
      grant: {
        ...grantPayload,
        signature: input.identity.sign("OwnerControlGrant", 1, grantPayload),
      },
    },
    requestId: input.requestId,
    deadlineAt: CONTROL_EXPIRY,
  };
}

type ServiceHandler = (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array>;

class CountingClient implements MeshServiceClient {
  calls = 0;

  constructor(private readonly delegate: MeshServiceClient) {}

  async request(
    serviceId: string,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.calls += 1;
    return this.delegate.request(serviceId, payload, signal);
  }
}

class CountingArtifactStore implements ArtifactStore {
  getCalls = 0;
  readonly getDigests: string[] = [];
  readonly rangeDigests: string[] = [];

  constructor(private readonly delegate: ArtifactStore) {}

  put(...args: Parameters<ArtifactStore["put"]>) {
    return this.delegate.put(...args);
  }

  putVerifiedStream(...args: Parameters<ArtifactStore["putVerifiedStream"]>) {
    return this.delegate.putVerifiedStream(...args);
  }

  get(...args: Parameters<ArtifactStore["get"]>) {
    this.getCalls += 1;
    this.getDigests.push(args[0].digest);
    return this.delegate.get(...args);
  }

  readRange(...args: Parameters<ArtifactStore["readRange"]>) {
    this.rangeDigests.push(args[0].digest);
    return this.delegate.readRange(...args);
  }

  has(...args: Parameters<ArtifactStore["has"]>) {
    return this.delegate.has(...args);
  }
}

function conformanceExecutorGuard(ownerDeviceId: string) {
  return {
    async preflightOwnerControl(
      _context: AuthorityCallContext,
      request: { readonly expectedOwnerDeviceId?: string },
      authenticatedCallerDeviceId: string,
    ) {
      if (
        authenticatedCallerDeviceId !== ownerDeviceId ||
        (request.expectedOwnerDeviceId !== undefined &&
          request.expectedOwnerDeviceId !== ownerDeviceId)
      ) {
        throw new Error("owner control peer is not authorized");
      }
    },
  };
}

function conformanceSubmissionGuard() {
  return {
    async preflightSubmission(
      context: AuthorityCallContext,
      identity: { readonly assignmentId: string; readonly method: string },
    ) {
      if (
        context.principal.kind !== "assignment" ||
        context.principal.capability.assignmentId !== identity.assignmentId ||
        !context.principal.capability.methods.includes(
          identity.method as AuthorityCapability["methods"][number],
        )
      ) {
        throw new Error("assignment submission is not authorized");
      }
    },
  };
}

function runExecutorPort(received: DispatchEnvelope[]): RunExecutorPort {
  return {
    async dispatch(...[envelope]: RunDispatchArguments) {
      received.push(envelope);
      return { v: 1, accepted: true };
    },
    async cancel() {},
    async supersede() {
      throw new Error("not used");
    },
    async queryLedger(assignmentId) {
      return { v: 1, assignmentId, lastSeq: 0, phase: "unknown" };
    },
  };
}

function runSubmissionPort(submitted: SealedBundle[]): RunSubmissionPort {
  return {
    async reportStarted() {},
    async submitBundle(bundle) {
      submitted.push(bundle);
      return { committed: true, commitRevision: 1 };
    },
    async submitCancelProof() {},
    async mirrorInteractions(_assignmentId, batch: InteractionMirrorBatch) {
      return {
        mirroredUpTo: batch.entries.at(-1)?.seq ?? 0,
        ordinal: batch.entries.at(-1)?.ordinal ?? 0,
        mirrorDigest: batch.mirrorDigest,
      };
    },
  };
}

function createUnsignedEnvelope(
  identity: TestProtocolIdentity,
  windowRef: import("@zhixing/core/contracts").ArtifactRef,
  dependency: import("@zhixing/core/contracts").ArtifactRef,
  executorId: string,
): UnsignedConversationEnvelope {
  const manifestBody = {
    v: 1 as const,
    baseRef: {
      execution: "conversation" as const,
      conversationId: "conversation-1",
      baseRevision: 0,
    },
    requires: {
      runtimeConfigRev: 1,
      modelProfileRev: 1,
      policyRev: 1,
      skillsRev: 1,
      rubricsRev: 1,
      promptAssetsRev: 1,
      permissionSnapshotVersion: 1,
    },
    protocolVersion: "1",
    tools: [],
    mcpServers: [],
    environment: {},
    credentialBindings: [],
  };
  const controlBody = {
    v: 1 as const,
    controlLeaseId: "control-1",
    assignmentId: "assignment-1",
    authority: {
      execution: "conversation" as const,
      conversationId: "conversation-1",
      ownerEpoch: 1,
    },
    renewalSeq: 1,
    issuedAt: NOW,
    expiry: CONTROL_EXPIRY,
  };
  const permissionBody = {
    v: 1 as const,
    snapshotVersion: 1,
    snapshotDigest: createSignedTrustRuleSnapshot(
      { snapshotVersion: 1, rules: [], generatedAt: NOW },
      identity,
    ).digest,
    binding: {
      execution: "conversation" as const,
      runId: "run-1",
      conversationId: "conversation-1",
      ownerEpoch: 1,
    },
    assignmentId: "assignment-1",
    executorId,
    controlLeaseId: "control-1",
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const capabilityBody = {
    v: 1 as const,
    capId: "capability-1",
    executorId,
    scope: { execution: "conversation" as const, conversationId: "conversation-1" },
    ownerEpoch: 1,
    methods: [
      "submission.mirrorInteractions",
      "submission.reportStarted",
      "submission.submitBundle",
      "submission.submitCancelProof",
    ] as AuthorityCapability<"conversation">["methods"],
    resources: ["conversation:conversation-1"] as AuthorityCapability<"conversation">["resources"],
    assignmentId: "assignment-1",
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const resourceBody = {
    v: 1 as const,
    reservationId: "reservation-1",
    admissionClass: "interactive" as const,
    workload: { kind: "run" as const, id: "run-1", attempt: 1 },
    scopeBinding: {
      kind: "conversation" as const,
      conversationId: "conversation-1",
      ownerEpoch: 1,
    },
    audience: { executorId },
    budget: { maxCalls: 10, maxTokens: 10_000 },
    domain: {
      kind: "local" as const,
      localDomainId: "local:device-1",
      localGovernorEpoch: 1,
    },
    activation: { kind: "assignment" as const, assignmentId: "assignment-1" },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const resourceWithDigest = {
    ...resourceBody,
    digest: protocolDigest("ResourceLease", 1, resourceBody),
  };
  return {
    v: 1,
    execution: "conversation",
    assignmentId: "assignment-1",
    executorId,
    manifest: {
      ...manifestBody,
      digest: protocolDigest("ExecutionManifest", 1, manifestBody),
    },
    controlLease: {
      ...controlBody,
      signature: identity.sign("ControlLease", 1, controlBody),
    },
    permissionLease: {
      ...permissionBody,
      signature: identity.sign("PermissionSnapshotLease", 1, permissionBody),
    },
    capabilities: [{
      ...capabilityBody,
      signature: identity.sign("AuthorityCapability", 1, capabilityBody),
    }],
    resourceLease: {
      ...resourceWithDigest,
      signature: identity.sign("ResourceLease", 1, resourceWithDigest),
    },
    dependencyArtifacts: [dependency],
    issuedAt: NOW,
    work: {
      t: "conversation",
      runId: "run-1",
      conversationId: "conversation-1",
      ownerEpoch: 1,
      baseRevision: 0,
      ingress: {
        kind: "first-party",
        surfacePrincipal: "surface-1",
        deviceId: "device-1",
        ingressId: "ingress-1",
        receivedAt: NOW,
      },
      windowInput: { t: "full", windowEpoch: 1, messages: { ref: windowRef } },
      controlContext: [],
    },
  };
}

function ownerContext(): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "mesh-conformance" },
    requestId: "executor-dispatch-1",
    deadlineAt: EXPIRY,
  };
}

function assignmentContext(capability: AuthorityCapability): AuthorityCallContext {
  return {
    principal: { kind: "assignment", capability },
    requestId: "submission-bundle-1",
    deadlineAt: EXPIRY,
  };
}

class TestProtocolIdentity implements ProtocolSigner, ProtocolSignatureVerifier {
  readonly #key = Buffer.from("unit-19-protocol-identity", "utf8");
  #nonce = 0;

  constructor(private readonly keyId = "test-owner") {}

  sign(schemaId: string, version: number, payload: unknown): Signature {
    const nonce = String(++this.#nonce);
    const mac = createHmac("sha256", this.#key)
      .update(protocolBytes(schemaId, version, payload))
      .update("\0")
      .update(nonce)
      .digest("base64url");
    return { alg: "test-hmac-sha256", keyId: this.keyId, sig: `${nonce}.${mac}` };
  }

  verify(schemaId: string, version: number, payload: unknown, signature: Signature): void {
    const [nonce, encoded, extra] = signature.sig.split(".");
    if (
      signature.alg !== "test-hmac-sha256" ||
      signature.keyId !== this.keyId ||
      !nonce ||
      !encoded ||
      extra !== undefined
    ) {
      throw new Error("test signature identity mismatch");
    }
    const expected = createHmac("sha256", this.#key)
      .update(protocolBytes(schemaId, version, payload))
      .update("\0")
      .update(nonce)
      .digest();
    const actual = Buffer.from(encoded, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("test signature invalid");
    }
  }
}

async function temporaryRoot(): Promise<string> {
  return createTempDir("assignment-mesh");
}

async function createAuthenticatedChannelPair(
  ownerServices: ReadonlyMap<string, ServiceHandler>,
  executorServices: ReadonlyMap<string, ServiceHandler>,
): Promise<{
  readonly ownerClient: MeshServiceClient;
  readonly executorClient: MeshServiceClient;
  readonly ownerDeviceId: string;
  readonly executorDeviceId: string;
  readonly close: () => Promise<void>;
}> {
  const owner = await createMeshDevice("owner");
  const executor = await createMeshDevice("executor");
  const ownerRegistry = dynamicRegistry(ownerServices, [
    ASSIGNMENT_ARTIFACT_SERVICE,
    RUN_SUBMISSION_SERVICE,
  ]);
  const executorRegistry = dynamicRegistry(executorServices, [
    ASSIGNMENT_ARTIFACT_SERVICE,
    RUN_EXECUTOR_SERVICE,
  ]);
  let accept!: (connection: SecureMeshConnection) => void;
  let rejectAccept!: (error: Error) => void;
  const accepted = new Promise<SecureMeshConnection>((resolve, reject) => {
    accept = resolve;
    rejectAccept = reject;
  });
  const range = { min: "1", max: "1" } as const;
  const server = await createAuthenticatedMeshServer(
    {
      identity: executor.key,
      trustedPeers: [owner.peer],
      protocolRange: range,
      authorizePeer: () => true,
      replayWindow: new HandshakeReplayWindow(),
      onHandshakeError: rejectAccept,
    },
    accept,
  );
  const port = await listen(server);
  try {
    const ownerConnection = await connectAuthenticatedMesh({
      host: "127.0.0.1",
      port,
      identity: owner.key,
      trustedPeer: executor.peer,
      protocolRange: range,
      authorizePeer: () => true,
    });
    const executorConnection = await accepted;
    const ownerChannel = new MeshRequestChannel(ownerConnection, ownerRegistry);
    const executorChannel = new MeshRequestChannel(executorConnection, executorRegistry);
    let closed = false;
    return {
      ownerClient: executorChannel,
      executorClient: ownerChannel,
      ownerDeviceId: owner.key.deviceId,
      executorDeviceId: executor.key.deviceId,
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled([ownerChannel.close(), executorChannel.close()]);
        await closeServer(server);
      },
    };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

async function createMeshDevice(name: string): Promise<{
  readonly key: DeviceKey;
  readonly peer: TrustedMeshPeer;
}> {
  const key = await DeviceKey.generate();
  return {
    key,
    peer: {
      identity: enrollDeviceIdentity(key, {
        displayName: name,
        platform: "headless",
        enrolledAt: new Date().toISOString(),
      }),
      rootCertificatePem: key.rootCertificatePem,
    },
  };
}

function dynamicRegistry(
  services: ReadonlyMap<string, ServiceHandler>,
  serviceIds: readonly string[],
): MeshServiceRegistry {
  const registry = new MeshServiceRegistry();
  for (const serviceId of serviceIds) {
    registry.register(serviceId, {
      access: "write",
      availability: "negotiated-version",
      handler: async (payload, connection, signal) => {
        const handler = services.get(serviceId);
        if (!handler) throw new Error(`missing service: ${serviceId}`);
        return handler(payload, connection, signal);
      },
    });
  }
  return registry;
}

async function listen(server: TlsServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing mesh test address");
  return address.port;
}

async function closeServer(server: TlsServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
