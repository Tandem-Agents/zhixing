import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { Server as TlsServer } from "node:tls";
import {
  DeliveryAuthority,
  createEventBus,
  skillNameToId,
  type AgentEventMap,
} from "@zhixing/core";
import {
  SkillCatalogSaveApplicationService,
  type SkillCatalogSaveOverlayRecord,
} from "@zhixing/core/skills/catalog";
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
  InteractionSettlementStreamProof,
  InteractionMirrorBatch,
  LedgerEvidencePage,
  RunDispatchArguments,
  RunExecutorPort,
  RunSubmissionPort,
  SealedBundle,
  Signature,
  TaskDefinition,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  buildConversationActivationPayload,
  assignmentMutationRequestId,
  assignmentActivationDigest,
  canonicalize,
  createSignedAssignmentArtifactTransferGrant,
  createJobCommitFence,
  createConversationSealedBundle,
  createSignedConversationInteractionMirrorBatch,
  createSignedConversationEnvelope,
  createSignedTrustRuleSnapshot,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  interactionMirrorSeed,
  jobDeliveryPlanDigest,
  ownerControlRequestDigest,
  protocolBytes,
  protocolDigest,
  sealedBundleArtifact,
  signCancelProof,
  signConversationActivation,
  signSupersedeProof,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type UnsignedJobEnvelope,
  type UnsignedConversationEnvelope,
} from "@zhixing/core/protocol";
import { ConversationAssignmentLedger } from "@zhixing/executor";
import { BUILTIN_TOOL_FACTORIES } from "@zhixing/tools-builtin";
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
import { createOwnerDeliveryParticipant } from "@zhixing/owner-kernel/delivery";
import {
  JobJournal,
  type JobAssignmentPlan,
} from "@zhixing/owner-kernel/job-assignment";
import { createTempDir } from "@zhixing/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  registerRunExecutorMeshService,
} from "./assignment-mesh-adapter.js";
import { createAssignmentMutationPort } from "./assignment-schedule-stager.js";
import { createAssignmentSkillPorts } from "../../../orchestrator/src/runtime/assignment-skill-port.js";
import { runContextStorage } from "../../../orchestrator/src/runtime/run-context.js";

const NOW = "2026-07-21T00:00:00.000Z";
const EXPIRY = "2026-07-21T01:00:00.000Z";
const CONTROL_EXPIRY = "2026-07-21T00:00:30.000Z";
const DIGEST = `sha256:${"2".repeat(64)}` as const;
const TEST_DURABLE_IO_TIMEOUT_MS = 120_000;
const meshClosers: Array<() => Promise<void>> = [];
const identityExecutorIdForPeer = (deviceId: string) => deviceId;

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
        ...executorServiceSecurity(fixture),
      }),
    );
    const adapter = new MeshRunExecutorPort({
      client: fixture.executorClient,
      artifacts: sourceArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      ...ownerExecutorPortSecurity(fixture),
      chunkBytes: 1024,
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
        ...executorServiceSecurity(fixture),
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
      ...ownerExecutorPortSecurity(fixture),
      chunkBytes: 1024,
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
      ...ownerExecutorPortSecurity(fixture),
      chunkBytes: 1024,
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
        ...executorServiceSecurity(fixture),
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
      ...ownerExecutorPortSecurity(fixture),
    });

    await expect(
      reader.queryLedger("assignment-1", ownerContext(), { fromSeq: 1, limit: 256 }),
    ).rejects.toThrow("Mesh service failed");
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
        executorIdForPeer: identityExecutorIdForPeer,
      }),
    );
    const adapter = new MeshRunSubmissionPort({
      client: fixture.ownerClient,
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      ...executorSubmissionPortSecurity(fixture),
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
        ...executorServiceSecurity(fixture),
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
      ...ownerExecutorPortSecurity(fixture),
      chunkBytes: 1024,
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
    const uploadAuthorization = transferAuthorization({
      fixture,
      direction: "owner-to-executor",
      refs: [ref],
    });
    await expect(first.upload("assignment-1", uploadAuthorization, [ref])).rejects.toThrow(
      "connection lost",
    );

    const resumed = new AssignmentArtifactClient({
      client: fixture.executorClient,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      chunkBytes: 10,
    });
    await resumed.upload("assignment-1", uploadAuthorization, [ref]);
    expect(await fixture.executorArtifacts.has(ref)).toBe(true);
    const callsAfterCompletion = fixture.executorClient.calls;
    await resumed.upload("assignment-1", uploadAuthorization, [ref]);
    expect(fixture.executorClient.calls).toBe(callsAfterCompletion + 1);

    const emptyRef = await fixture.ownerArtifacts.put(Buffer.alloc(0));
    const emptyUploadAuthorization = transferAuthorization({
      fixture,
      direction: "owner-to-executor",
      refs: [emptyRef],
    });
    await resumed.upload("assignment-1", emptyUploadAuthorization, [emptyRef]);
    expect(await fixture.executorArtifacts.has(emptyRef)).toBe(true);
    await resumed.upload("assignment-1", emptyUploadAuthorization, [emptyRef]);

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
    const emptyDownloadAuthorization = transferAuthorization({
      fixture,
      direction: "executor-to-owner",
      refs: [emptyRef],
    });
    await downloader.download("assignment-1", emptyDownloadAuthorization, [emptyRef]);
    expect(await downloadArtifacts.has(emptyRef)).toBe(true);
    await downloader.download("assignment-1", emptyDownloadAuthorization, [emptyRef]);

    await expect(resumed.upload("assignment-other", uploadAuthorization, [ref])).rejects.toThrow(
      "does not bind",
    );
    let customAuthorizationReached = false;
    const handler = createAssignmentArtifactServiceHandler({
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      verifier: fixture.identity,
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
        authorization: uploadAuthorization,
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

    await uploader.upload("assignment-1", transferAuthorization({
      fixture,
      direction: "owner-to-executor",
      refs: [ref],
    }), [ref]);

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
    const onCancelAccepted = vi.fn(async () => undefined);
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        ...executorServiceSecurity(fixture),
        guard: conformanceExecutorGuard(fixture.ownerDeviceId),
        onCancelAccepted,
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
      ...ownerExecutorPortSecurity(fixture),
      chunkBytes: 1024,
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
    expect(onCancelAccepted).toHaveBeenCalledWith("assignment-1", owner);
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        ...executorServiceSecurity(fixture),
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
        guard: conformanceSubmissionGuard(),
        executorIdForPeer: identityExecutorIdForPeer,
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
      ...executorSubmissionPortSecurity(fixture),
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
        guard: conformanceSubmissionGuard(),
        executorIdForPeer: identityExecutorIdForPeer,
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

  it("binds an authenticated device to its logical executor identity", async () => {
    const fixture = await createFixture();
    const logicalExecutorId = `executor:${fixture.executorId}`;
    let started = 0;
    const handler = createRunSubmissionMeshServiceHandler({
      artifacts: fixture.ownerArtifacts,
      guard: conformanceSubmissionGuard(),
      executorIdForPeer: (deviceId) =>
        deviceId === fixture.executorId ? logicalExecutorId : undefined,
      port: {
        ...runSubmissionPort([]),
        async reportStarted() {
          started += 1;
        },
      },
    });
    const context = assignmentContext({
      ...fixture.capability,
      executorId: logicalExecutorId,
    });

    await expect(handler(
      Buffer.from(canonicalize({
        v: 1,
        method: "reportStarted",
        assignmentId: "assignment-1",
        context,
      }), "utf8"),
      { peer: { deviceId: fixture.executorId } } as SecureMeshConnection,
      new AbortController().signal,
    )).resolves.toEqual(Buffer.from("null", "utf8"));
    expect(started).toBe(1);
  });

  it("preserves a real journal and ledger lifecycle across the mesh boundary", async () => {
    const fixture = await createFixture();
    const protocol = await createRealProtocolFixture(fixture);
    installRealProtocolServices(fixture, protocol);
    const executor = realExecutorAdapter(fixture, protocol);
    const submission = realSubmissionAdapter(fixture, protocol);
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

    protocol.setOwnerClock("2026-07-21T02:00:00.000Z");
    const replayArtifacts = new CountingArtifactStore(fixture.ownerArtifacts);
    fixture.ownerServices.set(
      RUN_SUBMISSION_SERVICE,
      createRunSubmissionMeshServiceHandler({
        port: protocol.journal,
        guard: protocol.journal,
        artifacts: replayArtifacts,
        executorIdForPeer: identityExecutorIdForPeer,
      }),
    );
    const expiredReplay = new MeshRunSubmissionPort({
      client: fixture.ownerClient,
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      ...executorSubmissionPortSecurity(fixture, () => ({
        capability: protocol.dispatch.envelope.capabilities[0]!,
        activation: protocol.dispatch.activation,
      })),
      chunkBytes: 1024,
      clock: () => Date.parse("2026-07-21T02:00:00.000Z"),
    });
    await expect(expiredReplay.submitBundle(bundle, assignment)).resolves.toEqual(
      remoteCommit,
    );
    expect(await protocol.ownerLog.readAll()).toEqual(ownerAfterCommit);
    expect(replayArtifacts.getDigests).toEqual([sealedBundleArtifact(bundle).ref.digest]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("replays save_skill through the real assignment ledger after its overlay becomes visible", async () => {
    const fixture = await createFixture();
    const protocol = await createRealProtocolFixture(fixture);
    installRealProtocolServices(fixture, protocol);
    const executor = realExecutorAdapter(fixture, protocol);
    const dispatchContext = realOwnerContext({
      dispatch: protocol.dispatch,
      method: "executor.dispatch",
      requestId: "skill-save-dispatch",
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
    await protocol.ledger.start("assignment-1");

    const encoder = new TextEncoder();
    const runSave = async (
      draft: {
        readonly name: string;
        readonly description: string;
        readonly body: string;
        readonly mode: "main" | "work";
      },
      toolCallId: string,
      options: { readonly hideOverlay?: boolean } = {},
    ) => {
      const assignmentMutations = createAssignmentMutationPort({
        ledger: protocol.ledger,
        assignmentId: "assignment-1",
        execution: "conversation",
        anchorEpoch: 1,
      });
      const service = new SkillCatalogSaveApplicationService({
        async readCatalogEntry() {
          return null;
        },
        async readOverlay() {
          if (options.hideOverlay) return [];
          const records: SkillCatalogSaveOverlayRecord[] = [];
          for (const record of await assignmentMutations.readOverlay()) {
            if (
              record.domain !== "global" ||
              (record.mutation.kind !== "skill-create" &&
                record.mutation.kind !== "skill-admit" &&
                record.mutation.kind !== "skill-update")
            ) {
              continue;
            }
            records.push({
              recordSeq: record.recordSeq,
              requestIdentity: record.requestId,
              mutation: record.mutation,
              mutationDigest: record.mutationDigest,
            });
          }
          return records;
        },
        requestIdentityFor(operationId) {
          return assignmentMutationRequestId({
            assignmentId: assignmentMutations.assignmentId,
            domain: "global",
            operationId,
          });
        },
        putContent: (document) =>
          fixture.executorArtifacts.put(encoder.encode(document)),
        async stage(operationId, mutation) {
          await assignmentMutations.stage({
            domain: "global",
            operationId,
            mutation,
          });
        },
        assignmentIssuedAt: () => NOW,
      });
      return service.save(draft, toolCallId);
    };
    const draft = {
      name: "Durable Replay",
      description: "Replay a staged Skill save",
      body: "Keep the same mutation payload.",
      mode: "main" as const,
    };

    const first = await runSave(draft, "tool-visible-replay");
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(1);
    await expect(runSave(
      draft,
      "tool-visible-replay",
      { hideOverlay: true },
    )).resolves.toEqual(first);
    await expect(runSave(draft, "tool-visible-replay")).resolves.toEqual(first);
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(1);

    for (const changed of [
      { ...draft, name: "Changed Name" },
      { ...draft, description: "Changed description" },
      { ...draft, body: "Changed body" },
      { ...draft, mode: "work" as const },
    ]) {
      await expect(runSave(changed, "tool-visible-replay")).rejects.toThrow(
        "Staged mutation requestId has a conflicting payload",
      );
    }
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(1);

    await expect(runSave(
      { ...draft, body: "A later operation sees the first save." },
      "tool-next-save",
    )).resolves.toMatchObject({ outcome: "updated" });
    const overlay = await protocol.ledger.readStagedMutationOverlay("assignment-1");
    expect(overlay).toHaveLength(2);
    expect(overlay[1]).toMatchObject({
      mutation: {
        kind: "skill-update",
        expectedRevision: 1,
      },
    });
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("loads overlay Skills and replays one durable usage through the real factory and ledger", async () => {
    const fixture = await createFixture();
    const protocol = await createRealProtocolFixture(fixture);
    installRealProtocolServices(fixture, protocol);
    const executor = realExecutorAdapter(fixture, protocol);
    await executor.dispatch(
      protocol.dispatch.envelope,
      protocol.dispatch.activation,
      realOwnerContext({
        dispatch: protocol.dispatch,
        method: "executor.dispatch",
        requestId: "skill-load-dispatch",
        body: {
          dispatchDigest: dispatchEnvelopeDigest(protocol.dispatch.envelope),
          activationDigest: activationDigest(protocol.dispatch.activation),
        },
        ownerDeviceId: fixture.ownerDeviceId,
        identity: fixture.identity,
      }),
    );
    await protocol.ledger.start("assignment-1");
    const assignmentMutations = createAssignmentMutationPort({
      ledger: protocol.ledger,
      assignmentId: "assignment-1",
      execution: "conversation",
      anchorEpoch: 1,
    });
    const ports = createAssignmentSkillPorts(fixture.executorArtifacts, {
      admissionLlm: async () => JSON.stringify({ decision: "safe", reason: "safe" }),
    });
    const tool = BUILTIN_TOOL_FACTORIES.load_skill!({
      skillCatalogLoad: ports.loadApplication,
    });
    const run = <T>(action: () => Promise<T>) => runContextStorage.run(
      {
        bus: createEventBus<AgentEventMap>({ lineage: "main" }),
        lineage: "main",
        globalQuery: {
          async read(query) {
            if (query.kind === "skill-get") {
              return { kind: "skill-get", catalogRevision: 0, entry: null };
            }
            if (query.kind === "skill-catalog") {
              return { kind: "skill-catalog", catalogRevision: 0, entries: [] };
            }
            throw new Error(`Unexpected query: ${query.kind}`);
          },
        },
        assignmentMutations,
        assignmentIssuedAt: NOW,
      },
      action,
    );
    const firstId = skillNameToId("Durable Load One");
    const secondId = skillNameToId("Durable Load Two");
    await run(() => ports.saveApplication.save({
      name: "Durable Load One",
      description: "First overlay Skill",
      body: "First durable body.",
      mode: "main",
    }, "tool-save-one"));
    await run(() => ports.saveApplication.save({
      name: "Durable Load Two",
      description: "Second overlay Skill",
      body: "Second durable body.",
      mode: "main",
    }, "tool-save-two"));

    const invoke = (id: string, toolCallId: string) => run(() => tool.call(
      { id },
      { workingDirectory: fixture.root, toolCallId },
    ));
    const first = await invoke(firstId, "tool-load-replay");
    expect(first).toMatchObject({ isError: false });
    expect(first.content).toContain("First durable body.");
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(3);

    await expect(invoke(firstId, "tool-load-replay")).resolves.toEqual(first);
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(3);

    const conflict = await invoke(secondId, "tool-load-replay");
    expect(conflict).toMatchObject({ isError: true });
    expect(conflict.content).toContain("conflicting payload");
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(3);

    const next = await invoke(secondId, "tool-load-next");
    expect(next).toMatchObject({ isError: false });
    expect(next.content).toContain("Second durable body.");
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(4);

    const builtin = await run(() => tool.call(
      { id: skillNameToId("提炼技能") },
      { workingDirectory: fixture.root },
    ));
    expect(builtin).toMatchObject({ isError: false });
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(4);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("replays admit_skill through the real factory, domain adapter and assignment ledger", async () => {
    const fixture = await createFixture();
    const protocol = await createRealProtocolFixture(fixture);
    installRealProtocolServices(fixture, protocol);
    const executor = realExecutorAdapter(fixture, protocol);
    await executor.dispatch(
      protocol.dispatch.envelope,
      protocol.dispatch.activation,
      realOwnerContext({
        dispatch: protocol.dispatch,
        method: "executor.dispatch",
        requestId: "skill-admit-dispatch",
        body: {
          dispatchDigest: dispatchEnvelopeDigest(protocol.dispatch.envelope),
          activationDigest: activationDigest(protocol.dispatch.activation),
        },
        ownerDeviceId: fixture.ownerDeviceId,
        identity: fixture.identity,
      }),
    );
    await protocol.ledger.start("assignment-1");
    const source = path.join(fixture.root, "admission-source");
    await fs.mkdir(source);
    const writeSource = (description: string, body: string) => fs.writeFile(
      path.join(source, "SKILL.md"),
      `---\nname: Durable Admission\ndescription: ${description}\n---\n${body}`,
    );
    await writeSource("Admit once", "Stable body");
    const assignmentMutations = createAssignmentMutationPort({
      ledger: protocol.ledger,
      assignmentId: "assignment-1",
      execution: "conversation",
      anchorEpoch: 1,
    });
    const ports = createAssignmentSkillPorts(fixture.executorArtifacts, {
      admissionLlm: async () => JSON.stringify({ decision: "safe", reason: "safe" }),
    });
    const tool = BUILTIN_TOOL_FACTORIES.admit_skill!({
      skillCatalogAdmission: ports.admissionApplication,
      skillMode: "main",
    });
    const runTool = (toolCallId: string) => runContextStorage.run(
      {
        bus: createEventBus<AgentEventMap>({ lineage: "main" }),
        lineage: "main",
        globalQuery: {
          async read(query) {
            if (query.kind === "skill-get") {
              return { kind: "skill-get", catalogRevision: 0, entry: null };
            }
            if (query.kind === "skill-catalog") {
              return { kind: "skill-catalog", catalogRevision: 0, entries: [] };
            }
            throw new Error(`Unexpected query: ${query.kind}`);
          },
        },
        assignmentMutations,
        assignmentIssuedAt: NOW,
      },
      () => tool.call(
        { path: source },
        { workingDirectory: fixture.root, toolCallId },
      ),
    );

    const first = await runTool("tool-admit-replay");
    expect(first).toMatchObject({ isError: false });
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(1);
    await expect(runTool("tool-admit-replay")).resolves.toEqual(first);
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(1);

    await writeSource("Changed", "Changed body");
    const conflicting = await runTool("tool-admit-replay");
    expect(conflicting).toMatchObject({ isError: true });
    expect(conflicting.content).toContain("conflicting payload");
    expect(await protocol.ledger.readStagedMutationOverlay("assignment-1"))
      .toHaveLength(1);

    const later = await runTool("tool-admit-next");
    expect(later).toMatchObject({ isError: false });
    const overlay = await protocol.ledger.readStagedMutationOverlay("assignment-1");
    expect(overlay).toHaveLength(2);
    expect(overlay.map((record) => record.mutation.kind)).toEqual([
      "skill-admit",
      "skill-admit",
    ]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("forwards interaction-settlement completion through the submission service", async () => {
    const fixture = await createFixture();
    const protocol = await createRealJobProtocolFixture(fixture);
    let completed = 0;
    let receivedProof: InteractionSettlementStreamProof | undefined;
    const handler = createRunSubmissionMeshServiceHandler({
      artifacts: fixture.ownerArtifacts,
      executorIdForPeer: identityExecutorIdForPeer,
      guard: conformanceSubmissionGuard(),
      port: {
        ...runSubmissionPort([]),
        async completeInteractionSettlement(_assignmentId, proof) {
          completed += 1;
          receivedProof = proof;
        },
      },
    });
    const context = assignmentContext(
      protocol.dispatch.envelope.capabilities[0]!,
    );
    const proof: InteractionSettlementStreamProof = {
      v: 2,
      assignmentId: "job-assignment-1",
      executorId: fixture.executorId,
      ticketDigest: DIGEST,
      sourceLastSeq: 1,
      sourceChainDigest: DIGEST,
      targetInteractionRecordSeq: 2,
      projectedRecordSeq: 3,
      upToRecordSeq: 2,
      lastStreamSeq: 2,
      streamDigest: DIGEST,
      ledgerChainDigest: DIGEST,
      signature: { alg: "test", keyId: fixture.executorId, sig: "proof" },
    };

    await expect(
      handler(
        Buffer.from(
          canonicalize({
            v: 1,
            method: "completeInteractionSettlement",
            assignmentId: "job-assignment-1",
            proof,
            context,
          }),
          "utf8",
        ),
        { peer: { deviceId: fixture.executorId } } as SecureMeshConnection,
        new AbortController().signal,
      ),
    ).resolves.toEqual(Buffer.from("null", "utf8"));
    expect(completed).toBe(1);
    expect(receivedProof).toEqual(proof);
  });

  it("preserves a real user-job journal and ledger lifecycle across the mesh boundary", async () => {
    const fixture = await createFixture();
    const protocol = await createRealJobProtocolFixture(fixture);
    installRealJobProtocolServices(fixture, protocol);
    const executor = realExecutorAdapter(fixture, protocol);
    const submission = realSubmissionAdapter(fixture, protocol);
    const dispatchContext = realOwnerContext({
      dispatch: protocol.dispatch,
      method: "executor.dispatch",
      requestId: "real-job-dispatch",
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
      requestId: "real-job-query",
      body: { range: null },
      ownerDeviceId: fixture.ownerDeviceId,
      identity: fixture.identity,
    });
    await expect(
      executor.queryLedger("job-assignment-1", queryContext),
    ).resolves.toEqual(
      await protocol.ledger.queryLedger("job-assignment-1", queryContext),
    );

    await protocol.ledger.start("job-assignment-1");
    const assignment = assignmentContext(protocol.dispatch.envelope.capabilities[0]!);
    await submission.reportStarted("job-assignment-1", assignment);
    const ownerAfterStarted = await protocol.ownerLog.readAll();
    await expect(
      protocol.journal.reportStarted("job-assignment-1", assignment),
    ).resolves.toBeUndefined();
    expect(await protocol.ownerLog.readAll()).toEqual(ownerAfterStarted);

    const bundle = await protocol.ledger.sealJobBundle("job-assignment-1", {
      fence: protocol.dispatch.envelope.work.fence,
      outcome: { status: "completed", summary: "scheduled work completed" },
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
    const statuses = await protocol.journal.statusHistory("job-run-1", 0);
    expect(statuses.length).toBeGreaterThan(0);
    expect(
      statuses.every(
        (notice) =>
          notice.ref.taskId === "task-1" &&
          notice.ref.jobRunId === "job-run-1",
      ),
    ).toBe(true);
    const deliveryItems = await protocol.deliveryAuthority.list();
    expect(deliveryItems).toHaveLength(1);
    expect(deliveryItems[0]).toMatchObject({
      keyBody: {
        kind: "job-result-delivery",
        taskId: "task-1",
        jobRunId: "job-run-1",
      },
      state: "queued",
      statusRevision: 1,
    });
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("preserves real cancellation and supersede guards across the mesh boundary", async () => {
    const fixture = await createFixture();
    const protocol = await createRealProtocolFixture(fixture);
    installRealProtocolServices(fixture, protocol);
    const executor = realExecutorAdapter(fixture, protocol);
    const submission = realSubmissionAdapter(fixture, protocol);
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
    await expect(protocol.journal.preflightSubmission(assignment, {
      method: "submission.submitBundle",
      assignmentId: "assignment-1",
    })).resolves.toMatchObject({
      kind: "return",
      result: { committed: false, error: { code: "fence-rejected", retryable: false } },
    });

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
    ).rejects.toThrow("Mesh service failed");
    await expect(
      protocol.ledger.supersede("assignment-1", fence, supersedeContext),
    ).rejects.toThrow("Terminated assignment cannot be superseded through a new fence");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("authorizes peers before payload access and leaves durable expiry classification to guards", async () => {
    const fixture = await createFixture();
    const deniedArtifact = createAssignmentArtifactServiceHandler({
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      verifier: fixture.identity,
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
        authorization: transferAuthorization({
          fixture,
          direction: "owner-to-executor",
          refs: [fixture.dispatchReferences[0]!],
        }),
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
        ...executorServiceSecurity(fixture),
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
      ...ownerExecutorPortSecurity(fixture),
      chunkBytes: 1024,
    });
    await expect(
      executorAdapter.dispatch(fixture.envelope, fixture.activation, ownerContext()),
    ).rejects.toThrow("Mesh service failed");
    expect(countingExecutor.getCalls).toBe(1);

    const countingOwner = new CountingArtifactStore(fixture.ownerArtifacts);
    const submissionHandler = createRunSubmissionMeshServiceHandler({
      artifacts: countingOwner,
      guard: conformanceSubmissionGuard(),
      port: runSubmissionPort([]),
      executorIdForPeer: identityExecutorIdForPeer,
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
      executorIdForPeer: identityExecutorIdForPeer,
      guard: {
        async preflightSubmission() {
          expiredGuardCalls += 1;
          return { kind: "continue" as const };
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
    )).resolves.toEqual(Buffer.from("null", "utf8"));
    expect(expiredGuardCalls).toBe(1);
    expect(expiredPortCalls).toBe(1);

    let expiredArtifactAuthorizations = 0;
    const expiredArtifact = createAssignmentArtifactServiceHandler({
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      verifier: fixture.identity,
      authorize: () => {
        expiredArtifactAuthorizations += 1;
      },
      clock: () => Date.parse(EXPIRY) + 1,
    });
    await expect(expiredArtifact(
      Buffer.from(canonicalize({
        v: 1,
        t: "probe",
        direction: "send",
        assignmentId: "assignment-1",
        authorization: transferAuthorization({
          fixture,
          direction: "executor-to-owner",
          refs: [fixture.dispatchReferences[0]!],
          clock: () => Date.parse(EXPIRY) + 1,
        }),
        ref: fixture.dispatchReferences[0],
      }), "utf8"),
      { peer: { deviceId: fixture.ownerDeviceId } } as SecureMeshConnection,
      new AbortController().signal,
    )).resolves.toBeInstanceOf(Uint8Array);
    await expect(expiredArtifact(
      Buffer.from(canonicalize({
        v: 1,
        t: "append",
        assignmentId: "assignment-1",
        authorization: transferAuthorization({
          fixture,
          direction: "owner-to-executor",
          refs: [fixture.dispatchReferences[0]!],
        }),
        ref: fixture.dispatchReferences[0],
        offset: 0,
        bytes: "",
      }), "utf8"),
      { peer: { deviceId: fixture.ownerDeviceId } } as SecureMeshConnection,
      new AbortController().signal,
    )).rejects.toThrow("outside its validity interval");
    expect(expiredArtifactAuthorizations).toBe(1);

    const rejectedResult = {
      committed: false as const,
      error: {
        code: "fence-rejected" as const,
        message: "Bundle belongs to a historical assignment",
        retryable: false,
      },
    };
    const unreadArtifacts = new CountingArtifactStore(fixture.ownerArtifacts);
    let rejectedPortCalls = 0;
    const durableRejection = createRunSubmissionMeshServiceHandler({
      artifacts: unreadArtifacts,
      executorIdForPeer: identityExecutorIdForPeer,
      guard: {
        async preflightSubmission() {
          return { kind: "return" as const, result: rejectedResult };
        },
      },
      port: {
        ...runSubmissionPort([]),
        async submitBundle() {
          rejectedPortCalls += 1;
          throw new Error("stable rejection must not reach the payload port");
        },
      },
    });
    const missingBundleRef = {
      digest: `sha256:${"f".repeat(64)}` as const,
      bytes: 1,
    };
    await expect(durableRejection(
      Buffer.from(canonicalize({
        v: 1,
        method: "submitBundle",
        assignmentId: "assignment-1",
        bundleRef: missingBundleRef,
        context: assignmentContext(fixture.capability),
      }), "utf8"),
      { peer: { deviceId: fixture.executorId } } as SecureMeshConnection,
      new AbortController().signal,
    )).resolves.toEqual(Buffer.from(canonicalize(rejectedResult), "utf8"));
    expect(unreadArtifacts.getCalls).toBe(0);
    expect(rejectedPortCalls).toBe(0);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("binds the executor service to its owning anchor at registration", async () => {
    const fixture = await createFixture();
    let authorize: ((connection: SecureMeshConnection) => boolean) | undefined;
    const registry = {
      register(serviceId: string, definition: {
        readonly authorize?: (connection: SecureMeshConnection) => boolean;
      }) {
        expect(serviceId).toBe(RUN_EXECUTOR_SERVICE);
        authorize = definition.authorize;
        return () => {};
      },
    } as unknown as MeshServiceRegistry;
    registerRunExecutorMeshService(registry, {
      port: runExecutorPort([]),
      guard: conformanceExecutorGuard(fixture.ownerDeviceId),
      artifacts: fixture.executorArtifacts,
      verifier: fixture.identity,
      ...executorServiceSecurity(fixture),
    });

    expect(authorize?.({
      peer: { deviceId: fixture.ownerDeviceId },
    } as SecureMeshConnection)).toBe(true);
    expect(authorize?.({
      peer: { deviceId: fixture.executorId },
    } as SecureMeshConnection)).toBe(false);
  });

  it("rejects a mismatched dispatch binding before durable preflight", async () => {
    const fixture = await createFixture();
    const preflight = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({ v: 1 as const, accepted: true as const }));
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        port: { ...runExecutorPort([]), dispatch },
        guard: { preflightOwnerControl: preflight },
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        ...executorServiceSecurity(fixture),
      }),
    );
    const client: MeshServiceClient = {
      request: async (serviceId, payload, signal) => {
        if (serviceId !== RUN_EXECUTOR_SERVICE) {
          return fixture.executorClient.request(serviceId, payload, signal);
        }
        const request = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<
          string,
          unknown
        >;
        return fixture.executorClient.request(
          serviceId,
          Buffer.from(canonicalize({ ...request, dispatchDigest: DIGEST }), "utf8"),
          signal,
        );
      },
    };
    const adapter = new MeshRunExecutorPort({
      client,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      ...ownerExecutorPortSecurity(fixture),
      chunkBytes: 1024,
    });

    await expect(
      adapter.dispatch(fixture.envelope, fixture.activation, ownerContext()),
    ).rejects.toThrow("Mesh service failed");
    expect(preflight).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("rejects an invalid dispatch activation before durable preflight", async () => {
    const fixture = await createFixture();
    const preflight = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({ v: 1 as const, accepted: true as const }));
    fixture.executorServices.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        port: { ...runExecutorPort([]), dispatch },
        guard: { preflightOwnerControl: preflight },
        artifacts: fixture.executorArtifacts,
        verifier: fixture.identity,
        ...executorServiceSecurity(fixture),
      }),
    );
    const client: MeshServiceClient = {
      request: async (serviceId, payload, signal) => {
        if (serviceId !== RUN_EXECUTOR_SERVICE) {
          return fixture.executorClient.request(serviceId, payload, signal);
        }
        const request = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<
          string,
          unknown
        >;
        const activation = request.activation as Record<string, unknown>;
        const signature = activation.signature as Record<string, unknown>;
        return fixture.executorClient.request(
          serviceId,
          Buffer.from(canonicalize({
            ...request,
            activation: {
              ...activation,
              signature: { ...signature, sig: "invalid.invalid" },
            },
          }), "utf8"),
          signal,
        );
      },
    };
    const adapter = new MeshRunExecutorPort({
      client,
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      ...ownerExecutorPortSecurity(fixture),
      chunkBytes: 1024,
    });

    await expect(
      adapter.dispatch(fixture.envelope, fixture.activation, ownerContext()),
    ).rejects.toThrow("Mesh service failed");
    expect(preflight).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});

async function createFixture() {
  const root = await temporaryRoot();
  const ownerServices = new Map<string, ServiceHandler>();
  const executorServices = new Map<string, ServiceHandler>();
  const mesh = await createAuthenticatedChannelPair(ownerServices, executorServices);
  meshClosers.push(mesh.close);
  const trustedSignerIds = [mesh.ownerDeviceId, mesh.executorDeviceId];
  const identity = new TestProtocolIdentity(mesh.ownerDeviceId, trustedSignerIds);
  const executorIdentity = new TestProtocolIdentity(
    mesh.executorDeviceId,
    trustedSignerIds,
  );
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
      verifier: identity,
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
      verifier: identity,
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
    executorIdentity,
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

type AssignmentMeshFixture = Awaited<ReturnType<typeof createFixture>>;

type TestArtifactAuthority = {
  readonly capability: AuthorityCapability;
  readonly activation:
    | AssignmentActivationProof<"conversation">
    | AssignmentActivationProof<"job">;
};

function fixtureAuthority(fixture: AssignmentMeshFixture): TestArtifactAuthority {
  return {
    capability: fixture.capability,
    activation: fixture.activation,
  };
}

function executorServiceSecurity(
  fixture: AssignmentMeshFixture,
  authorizationFor: (assignmentId: string) => TestArtifactAuthority = () =>
    fixtureAuthority(fixture),
) {
  return {
    signer: fixture.executorIdentity,
    localDeviceId: fixture.executorId,
    artifactAuthorizationFor: authorizationFor,
    authorizePeer: (deviceId: string) => deviceId === fixture.ownerDeviceId,
    clock: () => Date.parse(NOW),
  };
}

function ownerExecutorPortSecurity(
  fixture: AssignmentMeshFixture,
  authorizationFor: (assignmentId: string) => TestArtifactAuthority = () =>
    fixtureAuthority(fixture),
) {
  return {
    signer: fixture.identity,
    localDeviceId: fixture.ownerDeviceId,
    peerDeviceId: fixture.executorId,
    authorizationFor,
    clock: () => Date.parse(NOW),
  };
}

function executorSubmissionPortSecurity(
  fixture: AssignmentMeshFixture,
  authorizationFor: (assignmentId: string) => TestArtifactAuthority = () =>
    fixtureAuthority(fixture),
) {
  return {
    signer: fixture.executorIdentity,
    localDeviceId: fixture.executorId,
    peerDeviceId: fixture.ownerDeviceId,
    authorizationFor,
    clock: () => Date.parse(NOW),
  };
}

function transferAuthorization(input: {
  readonly fixture: AssignmentMeshFixture;
  readonly direction: "owner-to-executor" | "executor-to-owner";
  readonly refs: readonly import("@zhixing/core/contracts").ArtifactRef[];
  readonly capability?: AuthorityCapability;
  readonly activation?: AssignmentActivationProof<"conversation"> | AssignmentActivationProof<"job">;
  readonly clock?: () => number;
}) {
  const capability = input.capability ?? input.fixture.capability;
  const activation = input.activation ?? input.fixture.activation;
  const sourceIsOwner = input.direction === "owner-to-executor";
  const signer = sourceIsOwner ? input.fixture.identity : input.fixture.executorIdentity;
  const now = (input.clock ?? (() => Date.parse(NOW)))();
  const { signature: _, ...activationPayload } = activation;
  return {
    capability,
    activation,
    grant: createSignedAssignmentArtifactTransferGrant({
      assignmentId: capability.assignmentId,
      executorId: capability.executorId,
      capId: capability.capId,
      sourceDeviceId: sourceIsOwner
        ? input.fixture.ownerDeviceId
        : input.fixture.executorId,
      targetDeviceId: sourceIsOwner
        ? input.fixture.executorId
        : input.fixture.ownerDeviceId,
      direction: input.direction,
      activationDigest: assignmentActivationDigest(activationPayload),
      refs: input.refs,
      issuedAt: new Date(now).toISOString(),
      expiry: new Date(now + 60_000).toISOString(),
      signer,
    }),
  };
}

async function createRealProtocolFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  let ownerClock = NOW;
  const ownerLog = new FileAuthorityCommitLog(
    path.join(fixture.root, "owner-authority"),
    fixture.ownerArtifacts,
    { clock: () => ownerClock, lockWaitMs: 2_000 },
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
    delivery: createOwnerDeliveryParticipant({
      authority: new DeliveryAuthority({ log: ownerLog, anchorEpoch: 1 }),
    }),
    clock: () => ownerClock,
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
  return {
    dispatch,
    journal,
    ledger,
    ownerLog,
    executorLog,
    setOwnerClock(value: string) {
      ownerClock = value;
    },
  };
}

async function createRealJobProtocolFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const ownerLog = new FileAuthorityCommitLog(
    path.join(fixture.root, "owner-job-authority"),
    fixture.ownerArtifacts,
    { clock: () => NOW, lockWaitMs: 2_000 },
  );
  const executorLog = new FileAuthorityCommitLog(
    path.join(fixture.root, "executor-job-authority"),
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
  const snapshotFor = (executorId: string) => executorId === fixture.executorId
    ? executorCapabilitySnapshot(executorId)
    : undefined;
  const deliveryAuthority = new DeliveryAuthority({
    log: ownerLog,
    anchorEpoch: 3,
  });
  const journal = new JobJournal({
    taskId: "task-1",
    anchorEpoch: 3,
    log: ownerLog,
    artifacts: fixture.ownerArtifacts,
    signer: fixture.identity,
    verifier: fixture.identity,
    snapshotFor,
    submission: submissionAuthorizer,
    ingress: { authorize() {} },
    delivery: createOwnerDeliveryParticipant({ authority: deliveryAuthority }),
    clock: () => NOW,
  });
  const definition: TaskDefinition = {
    taskId: "task-1",
    taskRevision: 1,
    state: "enabled",
    definition: {
      kind: "user",
      spec: {
        name: "scheduled work",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "perform scheduled work" },
        delivery: {
          kind: "channel",
          channel: "feishu",
          to: "chat-fixed",
        },
      },
    },
  };
  const surfaceContext: AuthorityCallContext = {
    principal: {
      kind: "surface",
      surfacePrincipal: "surface-1",
      connectionId: "connection-1",
    },
    requestId: "define-job",
    deadlineAt: EXPIRY,
  };
  await journal.define(definition, surfaceContext);
  await journal.trigger({
    jobRunId: "job-run-1",
    scheduledFor: NOW,
    context: { ...surfaceContext, requestId: "trigger-job" },
    source: "user",
  });
  const unsigned = createUnsignedJobEnvelope(fixture.identity, fixture.executorId);
  const plan: JobAssignmentPlan = {
    taskId: "task-1",
    jobRunId: "job-run-1",
    anchorEpoch: 3,
    assignmentId: "job-assignment-1",
    executorId: fixture.executorId,
    manifest: unsigned.manifest,
    materialize: () => unsigned,
  };
  const dispatch = await journal.assign(plan);
  const trustSnapshot = createSignedTrustRuleSnapshot(
    { snapshotVersion: 1, rules: [], generatedAt: NOW },
    fixture.identity,
  );
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
    snapshotFor,
    permissionSnapshotFor: (digest) => trustSnapshot.digest === digest
      ? trustSnapshot
      : undefined,
    clock: () => NOW,
  });
  return {
    dispatch,
    journal,
    ledger,
    deliveryAuthority,
    ownerLog,
    executorLog,
  };
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
      ...executorServiceSecurity(
        fixture,
        (assignmentId) => protocol.ledger.assignmentArtifactAuthority(assignmentId),
      ),
    }),
  );
  fixture.ownerServices.set(
    RUN_SUBMISSION_SERVICE,
    createRunSubmissionMeshServiceHandler({
      port: protocol.journal,
      guard: protocol.journal,
      artifacts: fixture.ownerArtifacts,
      executorIdForPeer: identityExecutorIdForPeer,
    }),
  );
}

function installRealJobProtocolServices(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  protocol: Awaited<ReturnType<typeof createRealJobProtocolFixture>>,
): void {
  const authorizeArtifact = (expectedPeerDeviceId: string) => ({
    assignmentId,
    capability,
    connection,
  }: {
    readonly assignmentId: string;
    readonly capability: AuthorityCapability;
    readonly connection: SecureMeshConnection;
  }) => {
    if (
      assignmentId !== "job-assignment-1" ||
      capability.assignmentId !== assignmentId ||
      connection.peer.deviceId !== expectedPeerDeviceId
    ) {
      throw new Error("job artifact transfer is not authorized");
    }
  };
  fixture.ownerServices.set(
    ASSIGNMENT_ARTIFACT_SERVICE,
    createAssignmentArtifactServiceHandler({
      artifacts: fixture.ownerArtifacts,
      receiver: fixture.ownerReceiver,
      verifier: fixture.identity,
      authorize: authorizeArtifact(fixture.executorId),
      maxRangeBytes: 2048,
      clock: () => Date.parse(NOW),
    }),
  );
  fixture.executorServices.set(
    ASSIGNMENT_ARTIFACT_SERVICE,
    createAssignmentArtifactServiceHandler({
      artifacts: fixture.executorArtifacts,
      receiver: fixture.executorReceiver,
      verifier: fixture.identity,
      authorize: authorizeArtifact(fixture.ownerDeviceId),
      maxRangeBytes: 2048,
      clock: () => Date.parse(NOW),
    }),
  );
  fixture.executorServices.set(
    RUN_EXECUTOR_SERVICE,
    createRunExecutorMeshServiceHandler({
      port: protocol.ledger,
      guard: protocol.ledger,
      artifacts: fixture.executorArtifacts,
      verifier: fixture.identity,
      ...executorServiceSecurity(
        fixture,
        (assignmentId) => protocol.ledger.assignmentArtifactAuthority(assignmentId),
      ),
    }),
  );
  fixture.ownerServices.set(
    RUN_SUBMISSION_SERVICE,
    createRunSubmissionMeshServiceHandler({
      port: protocol.journal,
      guard: protocol.journal,
      artifacts: fixture.ownerArtifacts,
      executorIdForPeer: identityExecutorIdForPeer,
    }),
  );
}

function realExecutorAdapter(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  protocol: {
    readonly dispatch: {
      readonly envelope: DispatchEnvelope;
      readonly activation:
        | AssignmentActivationProof<"conversation">
        | AssignmentActivationProof<"job">;
    };
  },
): MeshRunExecutorPort {
  return new MeshRunExecutorPort({
    client: fixture.executorClient,
    artifacts: fixture.ownerArtifacts,
    receiver: fixture.ownerReceiver,
    verifier: fixture.identity,
    ...ownerExecutorPortSecurity(fixture, () => ({
      capability: protocol.dispatch.envelope.capabilities[0]!,
      activation: protocol.dispatch.activation,
    })),
    chunkBytes: 1024,
  });
}

function realSubmissionAdapter(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  protocol: {
    readonly dispatch: {
      readonly envelope: DispatchEnvelope;
      readonly activation:
        | AssignmentActivationProof<"conversation">
        | AssignmentActivationProof<"job">;
    };
  },
): MeshRunSubmissionPort {
  return new MeshRunSubmissionPort({
    client: fixture.ownerClient,
    artifacts: fixture.executorArtifacts,
    receiver: fixture.executorReceiver,
    ...executorSubmissionPortSecurity(fixture, () => ({
      capability: protocol.dispatch.envelope.capabilities[0]!,
      activation: protocol.dispatch.activation,
    })),
    chunkBytes: 1024,
    clock: () => Date.parse(NOW),
  });
}

function activationDigest(
  activation:
    | AssignmentActivationProof<"conversation">
    | AssignmentActivationProof<"job">,
): string {
  const { signature: _, ...payload } = activation;
  return protocolDigest("AssignmentActivationPayload", 1, payload);
}

function realOwnerContext(input: {
  readonly dispatch: { readonly envelope: DispatchEnvelope };
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
      return { kind: "continue" as const };
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

function executorCapabilitySnapshot(executorId: string) {
  const signature = { alg: "test", keyId: "test", sig: "test" };
  return {
    descriptor: {
      v: 1 as const,
      executorId,
      revision: 1,
      protocolVersion: "1",
      workspaces: [],
      tools: [],
      mcpServers: [],
      credentialBindings: [],
      evidenceCapabilities: [],
      at: NOW,
      signature,
    },
    inventory: {
      v: 1 as const,
      executorId,
      inventoryRevision: 1,
      capabilityRevision: 1,
      configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
      assetVersions: { skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1 },
      permissionSnapshotHighWater: 1,
      credentialBindingRevisions: [],
      at: NOW,
      signature,
    },
  };
}

function createUnsignedJobEnvelope(
  identity: TestProtocolIdentity,
  executorId: string,
): UnsignedJobEnvelope {
  const assignmentId = "job-assignment-1";
  const delivery = {
    kind: "channel" as const,
    channel: "feishu",
    to: "chat-fixed",
  };
  const manifestBody = {
    v: 1 as const,
    baseRef: {
      execution: "job" as const,
      taskId: "task-1",
      jobRunId: "job-run-1",
      taskRevision: 1,
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
    controlLeaseId: "job-control-1",
    assignmentId,
    authority: { execution: "job" as const, taskId: "task-1", anchorEpoch: 3 },
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
      execution: "job" as const,
      jobRunId: "job-run-1",
      taskId: "task-1",
      anchorEpoch: 3,
    },
    assignmentId,
    executorId,
    controlLeaseId: "job-control-1",
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const capabilityBody = {
    v: 1 as const,
    capId: "job-capability-1",
    executorId,
    scope: { execution: "job" as const, taskId: "task-1" },
    anchorEpoch: 3,
    methods: [
      "submission.completeInteractionSettlement",
      "submission.mirrorInteractions",
      "submission.reportStarted",
      "submission.submitBundle",
      "submission.submitCancelProof",
    ] as AuthorityCapability<"job">["methods"],
    resources: ["task:task-1"] as AuthorityCapability<"job">["resources"],
    assignmentId,
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const leaseBody = {
    v: 1 as const,
    reservationId: "job-reservation-1",
    admissionClass: "scheduler" as const,
    workload: { kind: "job" as const, id: "job-run-1", attempt: 1 },
    scopeBinding: { kind: "job" as const, taskId: "task-1", anchorEpoch: 3 },
    audience: { executorId },
    budget: { maxCalls: 20, maxTokens: 10_000 },
    domain: { kind: "anchor" as const, anchorEpoch: 3 },
    activation: { kind: "assignment" as const, assignmentId },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const leaseWithDigest = {
    ...leaseBody,
    digest: protocolDigest("ResourceLease", 1, leaseBody),
  };
  return {
    v: 1,
    execution: "job",
    assignmentId,
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
      ...leaseWithDigest,
      signature: identity.sign("ResourceLease", 1, leaseWithDigest),
    },
    dependencyArtifacts: [],
    issuedAt: NOW,
    work: {
      t: "job",
      jobRunId: "job-run-1",
      taskId: "task-1",
      fence: createJobCommitFence({
        taskId: "task-1",
        jobRunId: "job-run-1",
        scheduledFor: NOW,
        taskRevision: 1,
        deliveryPlanDigest: jobDeliveryPlanDigest(delivery),
        anchorEpoch: 3,
        assignmentId,
        executorId,
      }),
      instruction: { kind: "agent-turn", prompt: "perform scheduled work" },
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
      contentAssets: [],
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

  constructor(
    private readonly keyId = "test-owner",
    private readonly trustedKeyIds: readonly string[] = [keyId],
  ) {}

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
      !this.trustedKeyIds.includes(signature.keyId) ||
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
