import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AuthorityStorageError,
  FileArtifactStore,
  FileAuthorityCommitLog,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type ArtifactStore,
} from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core";
import type {
  AssignmentEntry,
  AuthorityCallContext,
  AuthorityCapability,
  LedgerEvidencePage,
  LedgerSnapshot,
  LogicalRecord,
  PermissionSnapshotLease,
  Signature,
  SystemJobResourceLease,
  StreamFrame,
  TaskDeliveryDto,
  TaskDefinition,
  TrustRuleSnapshot,
} from "@zhixing/core/contracts";
import {
  advanceAssignmentLedger,
  assignmentLedgerSeed,
  buildJobActivationPayload,
  canonicalize,
  createMutationBatch,
  createJobCommitFence,
  createJobSealedBundle,
  createSignedConversationInteractionMirrorBatch,
  createSignedChannelChallengeToken,
  createSignedJobEnvelope,
  createSignedTrustRuleSnapshot,
  dataPlaneTicketDigest,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  interactionMirrorSeed,
  interactionDisplayDigest,
  jobDeliveryPlanDigest,
  mutationBatchArtifact,
  ownerControlRequestDigest,
  protocolBytes,
  protocolDigest,
  queuedTerminalDequeueRecord,
  sealedBundleArtifact,
  signCancelProof,
  signJobActivation,
  StreamFrameVerifier,
  systemJobParamsDigest,
  validateJobMutationBatch,
  validateJobStagedMutationRecord,
  validateSystemJobResourceLease,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type ExecutorCapabilitySnapshot,
  type UnsignedJobEnvelope,
} from "@zhixing/core/protocol";
import {
  ControlAdmissionJournal,
  createJobControlEnvelope,
} from "@zhixing/owner-kernel/control-admission";
import { OwnerDeliveryParticipant } from "@zhixing/owner-kernel";
import {
  InProcessJobDispatcher,
  JOB_JOURNAL_RECORD_SHAPES,
  JobJournal,
  type JobAssignmentPlan,
  type JobCompatibilityProjection,
  type JobJournalRecordType,
  type PendingJobDispatch,
  type SystemJobHandler,
  type SystemJobResourceCoordinator,
} from "@zhixing/owner-kernel/job-assignment";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
  type AssignmentLedgerOptions,
} from "../assignment-ledger.js";

const NOW = "2026-07-15T09:00:00.000Z";
const EXPIRY = "2026-07-15T10:00:00.000Z";
const CONTROL_EXPIRY = "2026-07-15T09:01:00.000Z";
const TASK_ID = "task-1";
const JOB_RUN_ID = "job-run-1";
const ASSIGNMENT_ID = "assignment-1";
const EXECUTOR_ID = "executor-1";
const SHA256_ZERO = `sha256:${"0".repeat(64)}`;
const ABORT_TICKET_DIGEST = `sha256:${"a".repeat(64)}`;
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

const legacyAbortTickets: NonNullable<
  ConstructorParameters<typeof JobJournal>[0]["legacyAbortTickets"]
> = {
  authorize(input) {
    if (
      input.assignmentId !== ASSIGNMENT_ID ||
      input.executorId !== EXECUTOR_ID ||
      input.ticketDigest !== ABORT_TICKET_DIGEST ||
      input.surfacePrincipal !== "surface:user-1"
    ) {
      throw new Error("abort ticket rejected");
    }
  },
};

function matchingSnapshotFor(executorId: string): ExecutorCapabilitySnapshot | undefined {
  if (executorId !== EXECUTOR_ID) return undefined;
  const signature = { alg: "test", keyId: "test", sig: "test" };
  return {
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
      signature,
    },
    inventory: {
      v: 1,
      executorId,
      inventoryRevision: 1,
      capabilityRevision: 1,
      configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
      assetVersions: {
        skillsRev: 1,
        rubricsRev: 1,
        promptAssetsRev: 1,
      },
      permissionSnapshotHighWater: 1,
      credentialBindingRevisions: [],
      at: NOW,
      signature,
    },
  };
}

function matchingPermissionSnapshotFor(
  identity: TestProtocolIdentity,
  digest: string,
): TrustRuleSnapshot | undefined {
  const snapshot = createSignedTrustRuleSnapshot(
    { snapshotVersion: 1, rules: [], generatedAt: NOW },
    identity,
  );
  return snapshot.digest === digest ? snapshot : undefined;
}

function assignmentPlan(
  unsigned: UnsignedJobEnvelope,
  materialize: () => UnsignedJobEnvelope = () => unsigned,
): JobAssignmentPlan {
  return {
    taskId: unsigned.work.taskId,
    jobRunId: unsigned.work.jobRunId,
    anchorEpoch: unsigned.work.fence.anchorEpoch,
    assignmentId: unsigned.assignmentId,
    executorId: unsigned.executorId,
    manifest: unsigned.manifest,
    materialize,
  };
}

function deliveryParticipant(log: FileAuthorityCommitLog): OwnerDeliveryParticipant {
  return new OwnerDeliveryParticipant({
    authority: new DeliveryAuthority({ log, anchorEpoch: 3 }),
  });
}

class TestProtocolIdentity implements ProtocolSigner, ProtocolSignatureVerifier {
  readonly #key = Buffer.from("unit-14-protocol-identity", "utf8");
  #nonce = 0;

  sign(schemaId: string, version: number, payload: unknown): Signature {
    const nonce = String(++this.#nonce);
    const mac = createHmac("sha256", this.#key)
      .update(protocolBytes(schemaId, version, payload))
      .update("\0")
      .update(nonce)
      .digest("base64url");
    return {
      alg: "test-hmac-sha256",
      keyId: "test-owner",
      sig: `${nonce}.${mac}`,
    };
  }

  verify(
    schemaId: string,
    version: number,
    payload: unknown,
    signature: Signature,
  ): void {
    const [nonce, encoded, extra] = signature.sig.split(".");
    if (
      signature.alg !== "test-hmac-sha256" ||
      signature.keyId !== "test-owner" ||
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

const submission = {
  authenticate(context: AuthorityCallContext, identity: { assignmentId: string; method: string }) {
    if (
      context.principal.kind !== "assignment" ||
      context.principal.capability.assignmentId !== identity.assignmentId ||
      !context.principal.capability.methods.includes(
        identity.method as AuthorityCapability["methods"][number],
      )
    ) {
      throw new Error("assignment submission authentication failed");
    }
  },
  authorize(
    context: AuthorityCallContext,
    authorization: { assignmentId: string; method: string },
  ) {
    this.authenticate(context, authorization);
  },
};

const ownerControl: import("../assignment-ledger.js").OwnerControlAuthorizer = {
  authorize(context, request) {
    if (
      context.principal.kind !== "owner-control" ||
      context.principal.grant.assignmentId !== request.assignmentId ||
      !context.principal.grant.methods.includes(
        request.method,
      ) ||
      (request.authority !== undefined &&
        canonicalize(context.principal.grant.scope) !== canonicalize(request.authority))
    ) {
      throw new Error("owner control authorization failed");
    }
    return {
      authority: structuredClone(context.principal.grant.scope),
      ownerDeviceId: context.principal.grant.callerDeviceId,
      controlLease: structuredClone(context.principal.grant.controlLease),
    };
  },
};

function userDefinition(
  revision = 1,
  prompt = "perform scheduled work",
  state: TaskDefinition["state"] = "enabled",
): TaskDefinition {
  return {
    taskId: TASK_ID,
    taskRevision: revision,
    state,
    definition: {
      kind: "user",
      spec: {
        name: "scheduled work",
        enabled: state === "enabled",
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt },
        delivery: { kind: "none" },
      },
    },
  };
}

class WriteCountingArtifactStore implements ArtifactStore {
  readonly #delegate: ArtifactStore;
  writes = 0;

  constructor(delegate: ArtifactStore) {
    this.#delegate = delegate;
  }

  put(bytes: Uint8Array) {
    this.writes += 1;
    return this.#delegate.put(bytes);
  }

  putVerifiedStream(...args: Parameters<ArtifactStore["putVerifiedStream"]>) {
    this.writes += 1;
    return this.#delegate.putVerifiedStream(...args);
  }

  get(ref: Parameters<ArtifactStore["get"]>[0]) {
    return this.#delegate.get(ref);
  }

  readRange(...args: Parameters<ArtifactStore["readRange"]>) {
    return this.#delegate.readRange(...args);
  }

  has(ref: Parameters<ArtifactStore["has"]>[0]) {
    return this.#delegate.has(ref);
  }

  reset(): void {
    this.writes = 0;
  }
}

class FaultingArtifactStore implements ArtifactStore {
  readonly #delegate: ArtifactStore;
  failDigest?: string;

  constructor(delegate: ArtifactStore) {
    this.#delegate = delegate;
  }

  put(bytes: Uint8Array) {
    return this.#delegate.put(bytes);
  }

  putVerifiedStream(...args: Parameters<ArtifactStore["putVerifiedStream"]>) {
    return this.#delegate.putVerifiedStream(...args);
  }

  get(ref: Parameters<ArtifactStore["get"]>[0]) {
    if (ref.digest === this.failDigest) {
      throw new Error("simulated transient delivery content read failure");
    }
    return this.#delegate.get(ref);
  }

  readRange(...args: Parameters<ArtifactStore["readRange"]>) {
    if (args[0].digest === this.failDigest) {
      throw new Error("simulated transient delivery content read failure");
    }
    return this.#delegate.readRange(...args);
  }

  has(ref: Parameters<ArtifactStore["has"]>[0]) {
    return this.#delegate.has(ref);
  }
}

function systemDefinition(revision = 1, state: TaskDefinition["state"] = "enabled"): TaskDefinition {
  return {
    taskId: TASK_ID,
    taskRevision: revision,
    state,
    definition: {
      kind: "system",
      handler: "__journal-gc",
      params: { retainDays: 30 },
    },
  };
}

async function createUserHarness(
  options: {
    assign?: boolean;
    definition?: TaskDefinition;
    trigger?: boolean;
    ownerArtifacts?: (artifacts: FileArtifactStore) => ArtifactStore;
    ownerSnapshotFor?: (executorId: string) => ExecutorCapabilitySnapshot | undefined;
    executorSnapshotFor?: (executorId: string) => ExecutorCapabilitySnapshot | undefined;
    runtimeBindingGuard?: AssignmentLedgerOptions["runtimeBindingGuard"];
    clock?: () => string;
  } = {},
) {
  const root = await createTempDir("job-assignment");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const clock = options.clock ?? (() => NOW);
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock,
    lockWaitMs: 2_000,
  });
  const identity = new TestProtocolIdentity();
  const ownerArtifacts = options.ownerArtifacts?.(artifacts) ?? artifacts;
  const compatibilityFacts: Array<{ definition: TaskDefinition; occurrences: unknown[] }> = [];
  const compatibility: JobCompatibilityProjection = {
    async project(input) {
      compatibilityFacts.push({
        definition: structuredClone(input.definition),
        occurrences: structuredClone(input.occurrences),
      });
    },
    async remove() {},
  };
  const journal = new JobJournal({
    taskId: TASK_ID,
    anchorEpoch: 3,
    log,
    artifacts: ownerArtifacts,
    signer: identity,
    verifier: identity,
    delivery: deliveryParticipant(log),
    submission,
    compatibility,
    ingress: {
      authorize(context, action, definition) {
        if (definition.definition.kind === "system" || action.startsWith("system")) {
          if (context.principal.kind !== "host") throw new Error("system ingress rejected");
        } else if (context.principal.kind !== "surface") {
          throw new Error("user ingress rejected");
        }
      },
    },
    legacyAbortTickets,
    clock,
    snapshotFor: options.ownerSnapshotFor ?? matchingSnapshotFor,
  });
  const ledger = new ConversationAssignmentLedger({
    log,
    artifacts,
    executorId: EXECUTOR_ID,
    signer: identity,
    verifier: identity,
    ownerControl,
    snapshotFor: options.executorSnapshotFor ?? matchingSnapshotFor,
    permissionSnapshotFor: (digest) => matchingPermissionSnapshotFor(identity, digest),
    runtimeBindingGuard: options.runtimeBindingGuard,
    clock,
    surfaceAbort: {
      authorize(assignmentId, input) {
        if (
          assignmentId !== ASSIGNMENT_ID ||
          input.ticketDigest !== ABORT_TICKET_DIGEST ||
          input.surfacePrincipal !== "surface:user-1"
        ) {
          throw new Error("surface abort rejected");
        }
      },
    },
  });
  const definition = options.definition ?? userDefinition();
  await journal.define(definition, surfaceContext("define-user"));
  const unsigned = createUnsignedJob(identity, {
    delivery:
      definition.definition.kind === "user"
        ? definition.definition.spec.delivery ?? { kind: "none" }
        : { kind: "none" },
  });
  let dispatch: PendingJobDispatch | undefined;
  if (options.trigger !== false) {
    await journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: surfaceContext("trigger-user"),
      source: "user",
    });
    if (options.assign !== false) dispatch = await journal.assign(assignmentPlan(unsigned));
  }
  return {
    root,
    artifacts,
    log,
    identity,
    compatibilityFacts,
    journal,
    ledger,
    unsigned,
    dispatch,
  };
}

async function receive(harness: Awaited<ReturnType<typeof createUserHarness>>) {
  if (!harness.dispatch) throw new Error("test harness has no assignment");
  await harness.ledger.dispatch(
    harness.dispatch.envelope,
    harness.dispatch.activation,
    ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
  );
}

function reopenUserJournal(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
  artifacts: ArtifactStore = harness.artifacts,
  clock: () => string = () => NOW,
): JobJournal {
  return new JobJournal({
    taskId: TASK_ID,
    anchorEpoch: 3,
    log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
      clock,
      lockWaitMs: 2_000,
    }),
    artifacts,
    signer: harness.identity,
    verifier: harness.identity,
    delivery: deliveryParticipant(harness.log),
    submission,
    snapshotFor: matchingSnapshotFor,
    ingress: { authorize() {} },
    legacyAbortTickets,
    clock,
  });
}

async function appendRawTaskRevision(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
  definition: TaskDefinition,
): Promise<void> {
  await harness.log.append([
    {
      stream: `job:${TASK_ID}`,
      body: {
        t: "task-revision" as const,
        taskId: definition.taskId,
        taskRevision: definition.taskRevision,
        state: definition.state,
        kind: definition.definition.kind,
        def: definition,
      },
    },
  ]);
}

async function expectTaskRevisionRejectedByFullAndGuard(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
): Promise<void> {
  await expect(reopenUserJournal(harness).taskDefinition()).rejects.toThrow();
  await expect(
    harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    ),
  ).rejects.toThrow();
}

async function start(harness: Awaited<ReturnType<typeof createUserHarness>>) {
  await receive(harness);
  const adapter = new InProcessAssignmentSubmission({
    ledger: harness.ledger,
    owner: harness.journal,
  });
  await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
}

async function seal(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
  summary = "done",
) {
  return harness.ledger.sealJobBundle(ASSIGNMENT_ID, {
    fence: harness.unsigned.work.fence,
    outcome: { status: "completed", summary },
    contentAssets: [],
    streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
    usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
    usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
  });
}

async function resolve(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
  decision:
    | "user-verified-side-effects"
    | "user-abandoned"
    | "user-retry-acknowledged",
) {
  const fact = await harness.journal.currentResolution(JOB_RUN_ID);
  if (!fact) throw new Error("test job has no uncertain fact");
  const source = trustedSource();
  const envelope = createJobControlEnvelope({
    requestId: `resolve-${decision}`,
    source,
    at: NOW,
    body: {
      t: "uncertain-resolve",
      ref: {
        execution: "job",
        taskId: TASK_ID,
        jobRunId: JOB_RUN_ID,
        anchorEpoch: 3,
      },
      openFactDigest: fact.openFactDigest,
      decision,
    },
  });
  return harness.journal.applyControl({
    admission: new ControlAdmissionJournal(harness.log, harness.artifacts),
    envelope,
    source,
  });
}

describe("user job durable protocol", () => {
  it("issues data-plane tickets only for a manual job's original surface", async () => {
    const scheduled = await createUserHarness();
    await receive(scheduled);
    await scheduled.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    await expect(
      scheduled.journal.issueDataPlaneTicket({
        ticketId: "scheduled-ticket",
        assignmentId: ASSIGNMENT_ID,
        surfacePrincipal: "surface:user-1",
        kind: "run-observe",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("Scheduled jobs cannot receive data-plane tickets");

    const manual = await createUserHarness({ assign: false });
    await manual.journal.expireQueued(JOB_RUN_ID);
    const source = jobRunSource(NOW, "manual-ticket-ingress");
    const outcome = await manual.journal.applyControl({
      admission: new ControlAdmissionJournal(manual.log, manual.artifacts),
      envelope: createJobControlEnvelope({
        requestId: "manual-ticket-run",
        source,
        at: NOW,
        body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
      }),
      source,
    });
    const jobRunId =
      outcome.kind === "applied" && outcome.result.status === "ok"
        ? outcome.result.body.jobRunId
        : undefined;
    if (!jobRunId) throw new Error("manual job-run result is missing");
    const unsigned = createUnsignedJob(manual.identity, { jobRunId });
    const dispatch = await manual.journal.assign(assignmentPlan(unsigned));
    await manual.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await manual.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    await expect(
      manual.journal.issueDataPlaneTicket({
        ticketId: "manual-foreign-interact",
        assignmentId: ASSIGNMENT_ID,
        surfacePrincipal: "surface:observer-1",
        kind: "run-interact",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("restricted to the original surface");
    const originalRequest = {
      ticketId: "manual-interact-1",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: source.ingress.surfacePrincipal,
      kind: "run-interact" as const,
      ttlMs: 60_000,
    };
    const original =
      await manual.journal.issueDataPlaneTicket(originalRequest);
    await expect(
      manual.journal.issueDataPlaneTicket(originalRequest),
    ).resolves.toEqual(original);
    await expect(
      manual.journal.issueDataPlaneTicket({
        ...originalRequest,
        ttlMs: 30_000,
      }),
    ).rejects.toThrow("different grant");
    const renewalRequest = {
      ticketId: "manual-interact-2",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: source.ingress.surfacePrincipal,
      kind: "run-interact" as const,
      ttlMs: 60_000,
      replacesTicketId: original.ticketId,
    };
    const renewed =
      await manual.journal.issueDataPlaneTicket(renewalRequest);
    await expect(
      manual.journal.issueDataPlaneTicket(renewalRequest),
    ).resolves.toEqual(renewed);
    const { replacesTicketId: _, ...renewalWithoutReplacement } =
      renewalRequest;
    await expect(
      manual.journal.issueDataPlaneTicket(renewalWithoutReplacement),
    ).rejects.toThrow("different grant");
    const abort = await manual.journal.issueDataPlaneTicket({
      ticketId: "manual-abort",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: source.ingress.surfacePrincipal,
      kind: "abort",
      ttlMs: 60_000,
    });
    expect(await manual.journal.dataPlaneTicketFacts()).toEqual({
      issued: [abort, original, renewed].sort((left, right) =>
        left.ticketId.localeCompare(right.ticketId),
      ),
      revokedTicketIds: [original.ticketId],
    });
    await expect(manual.journal.cancel({
      jobRunId,
      requestId: "manual-ticket-cancel",
      context: surfaceContext("manual-ticket-cancel"),
    })).resolves.toMatchObject({ state: "cancel-requested" });
    expect(await manual.journal.dataPlaneTicketFacts()).toEqual({
      issued: [abort, original, renewed].sort((left, right) =>
        left.ticketId.localeCompare(right.ticketId),
      ),
      revokedTicketIds: [
        abort.ticketId,
        original.ticketId,
        renewed.ticketId,
      ].sort(),
    });
    await expect(
      manual.journal.issueDataPlaneTicket({
        ticketId: "manual-ticket-after-cancel",
        assignmentId: ASSIGNMENT_ID,
        surfacePrincipal: source.ingress.surfacePrincipal,
        kind: "run-observe",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("current acknowledged assignment");
    const abortProof = signCancelProof(
      {
        ...withoutSignature(contradictoryNotStartedProof(manual)),
        ticketDigest: dataPlaneTicketDigest(abort),
        surfacePrincipal: source.ingress.surfacePrincipal,
      },
      manual.identity,
    );
    await expect(
      manual.journal.submitCancelProof(
        ASSIGNMENT_ID,
        abortProof,
        submissionContext(unsigned),
      ),
    ).resolves.toBeUndefined();
    expect(await manual.journal.currentState(jobRunId)).toBe("cancelled");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("keeps manual-job ticket synchronization behind a durable non-regressing frontier", async () => {
    let nowMs = Date.parse(NOW);
    const manual = await createUserHarness({
      assign: false,
      clock: () => new Date(nowMs).toISOString(),
    });
    await manual.journal.expireQueued(JOB_RUN_ID);
    const source = jobRunSource(NOW, "manual-ticket-finite-frontier");
    const outcome = await manual.journal.applyControl({
      admission: new ControlAdmissionJournal(manual.log, manual.artifacts),
      envelope: createJobControlEnvelope({
        requestId: "manual-ticket-finite-frontier",
        source,
        at: NOW,
        body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
      }),
      source,
    });
    const jobRunId =
      outcome.kind === "applied" && outcome.result.status === "ok"
        ? outcome.result.body.jobRunId
        : undefined;
    if (!jobRunId) throw new Error("manual run id is missing");
    const unsigned = createUnsignedJob(manual.identity, { jobRunId });
    const dispatch = await manual.journal.assign(assignmentPlan(unsigned));
    await manual.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await manual.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    const ticket = await manual.journal.issueDataPlaneTicket({
      ticketId: "manual-ticket-finite-sync-frontier",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: source.ingress.surfacePrincipal,
      kind: "run-observe",
      ttlMs: 60_000,
    });
    expect(await manual.journal.dataPlaneTicketFacts()).toEqual({
      issued: [ticket],
      revokedTicketIds: [],
    });

    nowMs += 4 * 60 * 1_000;
    expect(await manual.journal.dataPlaneTicketFacts()).toEqual({
      issued: [],
      revokedTicketIds: [],
    });
    nowMs -= 3 * 60 * 1_000;
    expect(await manual.journal.dataPlaneTicketFacts()).toEqual({
      issued: [],
      revokedTicketIds: [],
    });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("does not apply the conversation runtime binding guard to job dispatch", async () => {
    let calls = 0;
    const harness = await createUserHarness({
      runtimeBindingGuard() {
        calls += 1;
        return {
          code: "revision-conflict",
          message: "conversation runtime changed",
          retryable: true,
        };
      },
    });

    await expect(receive(harness)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("keeps the dispatched job instruction within the frozen task bound", () => {
    const identity = new TestProtocolIdentity();
    const envelope = createUnsignedJob(identity);
    envelope.work.instruction.prompt = "x".repeat(65_537);

    expect(() => createSignedJobEnvelope(envelope, identity, identity)).toThrow(
      "Job execution prompt must be a non-empty bounded string",
    );
  });

  it("requires every job instruction tool to be frozen in its manifest", () => {
    const identity = new TestProtocolIdentity();
    const envelope = createUnsignedJob(identity);
    envelope.work.instruction.tools = ["Read"];

    expect(() => createSignedJobEnvelope(envelope, identity, identity)).toThrow(
      "Job execution tool is not frozen in the manifest",
    );
  });

  it("does not let a direct trigger persist caller-supplied ingress", async () => {
    const harness = await createUserHarness({ assign: false, trigger: false });
    const unsafeInput = {
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: surfaceContext("trigger-with-untrusted-ingress"),
      source: "user" as const,
      ingress: jobRunSource().ingress,
    };
    await harness.journal.trigger(unsafeInput);
    await expect(reopenUserJournal(harness).currentState(JOB_RUN_ID)).resolves.toBe("queued");
    const records = await harness.log.readStream<{
      readonly t: string;
      readonly ingress?: unknown;
    }>(`job:${TASK_ID}`);
    expect(records.find((entry) => entry.body.t === "admitted")?.body.ingress).toBeUndefined();
  });

  it("rejects surface ingress without an atomic manual control result", async () => {
    const harness = await createUserHarness({ assign: false, trigger: false });
    await harness.log.append([
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "occurrence" as const,
          occ: {
            taskId: TASK_ID,
            jobRunId: JOB_RUN_ID,
            scheduledFor: NOW,
            taskRevision: 1,
            deliveryPlan: {
              delivery: { kind: "none" as const },
              planDigest: jobDeliveryPlanDigest({ kind: "none" }),
            },
            state: "queued" as const,
          },
        },
      },
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "admitted" as const,
          taskId: TASK_ID,
          jobRunId: JOB_RUN_ID,
          scheduledFor: NOW,
          ingress: jobRunSource().ingress,
        },
      },
    ]);
    await expect(reopenUserJournal(harness).currentState(JOB_RUN_ID)).rejects.toThrow(
      "atomic control result",
    );
  });

  it("rejects task definitions whose compatibility enabled flag contradicts authority state", async () => {
    const harness = await createUserHarness({ assign: false });
    const contradictory = userDefinition(2);
    if (contradictory.definition.kind !== "user") {
      throw new Error("test fixture must be a user task definition");
    }
    contradictory.definition.spec.enabled = false;
    await expect(
      harness.journal.define(contradictory, surfaceContext("contradictory-state")),
    ).rejects.toThrow("enabled flag must match task state");
  });

  it("externalizes and replays a task definition larger than one journal record", async () => {
    const harness = await createUserHarness({
      assign: false,
      definition: userDefinition(1, "p".repeat(40_000)),
    });
    const records = await harness.log.readStream<{
      readonly t: string;
      readonly def?: unknown;
    }>(`job:${TASK_ID}`);
    expect(records.find((entry) => entry.body.t === "task-revision")?.body.def).toMatchObject({
      ref: { digest: expect.stringMatching(/^sha256:/u) },
    });
    const replayed = await reopenUserJournal(harness).taskDefinition();
    if (replayed?.definition.kind !== "user") {
      throw new Error("replayed task definition is not a user task");
    }
    expect(replayed.definition.spec.action.prompt.length).toBe(40_000);
  });

  it("rejects a raw occurrence produced after the current task definition is disabled", async () => {
    const harness = await createUserHarness({ assign: false });
    const first = await harness.journal.occurrence(JOB_RUN_ID);
    if (!first) throw new Error("initial occurrence is missing");
    await harness.journal.define(
      userDefinition(2, "disabled", "disabled"),
      surfaceContext("disable-before-raw-occurrence"),
    );
    const jobRunId = "job-run-disabled-definition";
    const scheduledFor = "2026-07-15T09:01:00.000Z";
    await harness.log.append([
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "occurrence" as const,
          occ: {
            ...first,
            jobRunId,
            scheduledFor,
            taskRevision: 2,
            state: "queued" as const,
          },
        },
      },
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "admitted" as const,
          taskId: TASK_ID,
          jobRunId,
          scheduledFor,
        },
      },
    ]);
    await expect(reopenUserJournal(harness).currentState(jobRunId)).rejects.toThrow(
      "current task definition",
    );
  });

  it("rejects a raw missed user occurrence while the current occurrence is still queued", async () => {
    const harness = await createUserHarness({ assign: false });
    const first = await harness.journal.occurrence(JOB_RUN_ID);
    if (!first) throw new Error("initial occurrence is missing");
    const jobRunId = "job-run-illegal-user-miss";
    await harness.log.append([
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "occurrence" as const,
          occ: {
            ...first,
            jobRunId,
            scheduledFor: "2026-07-15T09:01:00.000Z",
            state: "missed" as const,
          },
        },
      },
    ]);
    await expect(reopenUserJournal(harness).currentState(jobRunId)).rejects.toThrow(
      "in-flight task occurrence",
    );
  });

  it.each(["noncanonical", "wrong-binding"] as const)(
    "rejects a %s task-definition sidecar during full replay",
    async (kind) => {
      const harness = await createUserHarness({ assign: false });
      const sidecarDefinition = userDefinition(kind === "wrong-binding" ? 3 : 2);
      const bytes = Buffer.from(
        kind === "noncanonical"
          ? JSON.stringify(sidecarDefinition)
          : canonicalize(sidecarDefinition),
        "utf8",
      );
      const ref = await harness.artifacts.put(bytes);
      await harness.log.append([
        {
          stream: `job:${TASK_ID}`,
          body: {
            t: "task-revision" as const,
            taskId: TASK_ID,
            taskRevision: 2,
            state: "enabled" as const,
            kind: "user" as const,
            def: { ref },
          },
        },
      ]);
      await expect(reopenUserJournal(harness).taskDefinition()).rejects.toThrow(
        kind === "noncanonical" ? "artifact is not canonical" : "different stream",
      );
    },
  );

  it.each([
    [
      "different task",
      () => ({ ...userDefinition(2), taskId: "task-other" }),
    ],
    ["skipped revision", () => userDefinition(3)],
    ["changed kind", () => systemDefinition(2)],
  ] as const)(
    "rejects a raw task revision with %s in both full and compact replay",
    async (_name, definition) => {
      const harness = await createUserHarness({ assign: false, trigger: false });
      await appendRawTaskRevision(harness, definition());
      await expectTaskRevisionRejectedByFullAndGuard(harness);
    },
  );

  it("rejects task-definition resurrection in both full and compact replay", async () => {
    const harness = await createUserHarness({ assign: false, trigger: false });
    await harness.journal.define(
      userDefinition(2, "deleted", "deleted"),
      surfaceContext("delete-before-resurrection"),
    );
    await appendRawTaskRevision(harness, userDefinition(3));
    await expectTaskRevisionRejectedByFullAndGuard(harness);
  });

  it.each([
    ["queued cancellation", { assign: false }, userDefinition(2, "disabled", "disabled")],
    ["assigned cancellation", {}, userDefinition(2, "deleted", "deleted")],
  ] as const)(
    "rejects a task revision missing its atomic %s in both replay projections",
    async (_name, options, definition) => {
      const harness = await createUserHarness(options);
      await appendRawTaskRevision(harness, definition);
      await expectTaskRevisionRejectedByFullAndGuard(harness);
    },
  );

  it("freezes a task revision and delivery plan in each occurrence", async () => {
    const harness = await createUserHarness({ assign: false });
    await harness.journal.define(
      userDefinition(2, "new prompt applies only to future occurrences"),
      surfaceContext("update-user"),
    );
    const dispatch = await harness.journal.assign(assignmentPlan(harness.unsigned));
    expect(dispatch.envelope.work.instruction.prompt).toBe("perform scheduled work");
    expect(dispatch.envelope.work.fence.taskRevision).toBe(1);
  });

  it("keeps task creation provenance immutable across definition revisions", async () => {
    const definition = userDefinition();
    definition.definition = {
      ...definition.definition,
      origin: { channelId: "channel-1", to: "user-1" },
      createdInTurn: "turn-1",
    };
    const harness = await createUserHarness({ assign: false, definition });
    const changed = userDefinition(2);
    changed.definition = {
      ...changed.definition,
      origin: { channelId: "channel-2", to: "user-1" },
      createdInTurn: "turn-1",
    };
    await expect(
      harness.journal.define(changed, surfaceContext("change-provenance")),
    ).rejects.toThrow("creation provenance is immutable");
  });

  it("uses the creation origin when delivery is absent or explicitly none", async () => {
    const definition = userDefinition();
    definition.definition = {
      ...definition.definition,
      origin: { channelId: "channel-1", to: "user-1", threadId: "thread-1" },
    };
    const harness = await createUserHarness({ assign: false, definition });
    await expect(harness.journal.occurrence(JOB_RUN_ID)).resolves.toMatchObject({
      deliveryPlan: {
        delivery: {
          kind: "channel",
          channel: "channel-1",
          to: "user-1",
          threadId: "thread-1",
        },
      },
    });
  });

  it("atomically persists job relay verifier state with requested and finished frames", async () => {
    const definition = userDefinition();
    if (definition.definition.kind !== "user") {
      throw new Error("fixture definition is not user-owned");
    }
    definition.definition = {
      ...definition.definition,
      origin: { channelId: "feishu", to: "chat-1" },
      interactionResponder: {
        channelId: "feishu",
        platformSubject: "user-1",
      },
      spec: {
        ...definition.definition.spec,
        delivery: { kind: "channel", channel: "feishu", to: "chat-1" },
      },
    };
    const harness = await createUserHarness({ definition });
    const jobRef = {
      execution: "job" as const,
      taskId: TASK_ID,
      jobRunId: JOB_RUN_ID,
      anchorEpoch: 3,
    };
    const display = { title: "Approve?", lines: ["run"] };
    const requested: StreamFrame = {
      v: 1,
      ref: jobRef,
      assignmentId: ASSIGNMENT_ID,
      streamEpoch: 1,
      seq: 1,
      payload: {
        kind: "interaction",
        event: {
          t: "requested",
          requestId: "interaction-1",
          toolName: "bash",
          display,
          issuedAt: NOW,
          ttlMs: 60_000,
          expiresAt: "2026-07-15T09:01:00.000Z",
        },
      },
      meta: {},
    };
    const verifier = new StreamFrameVerifier({
      assignmentId: ASSIGNMENT_ID,
      ref: jobRef,
    });
    verifier.accept(requested);
    const token = createSignedChannelChallengeToken(
      {
        v: 1,
        challengeId: "challenge-1",
        ref: jobRef,
        assignmentId: ASSIGNMENT_ID,
        interactionRequestId: "interaction-1",
        route: definition.definition.origin!,
        displayDigest: interactionDisplayDigest("bash", display),
        issuedAt: NOW,
        expiry: "2026-07-15T09:01:00.000Z",
      },
      harness.identity,
    );

    const first = await harness.journal.adoptChannelRelayFrame({
      frame: requested,
      checkpoint: verifier.checkpoint(),
      prepared: {
        t: "channel-challenge-prepared",
        ref: jobRef,
        assignmentId: ASSIGNMENT_ID,
        frameSeq: 1,
        token,
        responder: definition.definition.interactionResponder!,
        toolName: "bash",
        display,
      },
    });
    expect(first).toMatchObject({
      checkpoint: { lastSeq: 1 },
      prepared: { frameSeq: 1 },
    });
    const commitCount = (await harness.log.readAll()).length;
    await expect(
      harness.journal.adoptChannelRelayFrame({
        frame: requested,
        checkpoint: verifier.checkpoint(),
        prepared: first.prepared,
      }),
    ).resolves.toMatchObject({ checkpoint: { lastSeq: 1 } });
    expect((await harness.log.readAll()).length).toBe(commitCount);
    await expect(
      reopenUserJournal(harness).channelRelayCheckpoint(ASSIGNMENT_ID),
    ).resolves.toEqual(verifier.checkpoint());

    const finished: StreamFrame = {
      v: 1,
      ref: jobRef,
      assignmentId: ASSIGNMENT_ID,
      streamEpoch: 2,
      seq: 2,
      payload: {
        kind: "interaction",
        event: {
          t: "finished",
          requestId: "interaction-1",
          outcome: "allowed",
        },
      },
      meta: {},
    };
    verifier.accept(finished);
    await expect(
      harness.journal.adoptChannelRelayFrame({
        frame: finished,
        checkpoint: verifier.checkpoint(),
      }),
    ).resolves.toMatchObject({
      checkpoint: { lastSeq: 2 },
      closed: { challengeId: "challenge-1", outcome: "allowed" },
    });
  });

  it("durably grants a channel answer and mirrors the same authority into the job owner", async () => {
    const definition = userDefinition();
    if (definition.definition.kind !== "user") {
      throw new Error("fixture definition is not user-owned");
    }
    definition.definition = {
      ...definition.definition,
      origin: { channelId: "feishu", to: "chat-1" },
      interactionResponder: {
        channelId: "feishu",
        platformSubject: "user-1",
      },
      spec: {
        ...definition.definition.spec,
        delivery: { kind: "channel", channel: "feishu", to: "chat-1" },
      },
    };
    const harness = await createUserHarness({ definition });
    await start(harness);
    const jobRef = {
      execution: "job" as const,
      taskId: TASK_ID,
      jobRunId: JOB_RUN_ID,
      anchorEpoch: 3,
    };
    const interactionRequest = {
      t: "requested" as const,
      requestId: "channel-interaction-1",
      toolName: "bash",
      display: { title: "Approve?", lines: ["run"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-15T09:01:00.000Z",
    };
    const requested: StreamFrame = {
      v: 1,
      ref: jobRef,
      assignmentId: ASSIGNMENT_ID,
      streamEpoch: 1,
      seq: 1,
      payload: {
        kind: "interaction",
        event: interactionRequest,
      },
      meta: {},
    };
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, interactionRequest);
    const preparation = await harness.journal.prepareChannelRelayRequest(requested);
    if (preparation.kind !== "prepared") {
      throw new Error("channel interaction unexpectedly had no responder");
    }
    const streamVerifier = new StreamFrameVerifier({
      assignmentId: ASSIGNMENT_ID,
      ref: jobRef,
    });
    streamVerifier.accept(requested);
    await harness.journal.adoptChannelRelayFrame({
      frame: requested,
      checkpoint: streamVerifier.checkpoint(),
      prepared: preparation.prepared,
    });
    const decision = { allowed: true, reason: "approved" };
    const grant = await harness.journal.grantChannelChallenge({
      token: preparation.prepared.token,
      responder: definition.definition.interactionResponder,
      decision,
      at: NOW,
    });
    const answer = await harness.ledger.prepareInteractionAnswerFromChannel({
      assignmentId: ASSIGNMENT_ID,
      requestId: interactionRequest.requestId,
      grant,
      at: NOW,
    });
    if (answer.kind !== "authorized") {
      throw new Error("fresh channel grant was unexpectedly replayed");
    }
    const finished = await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).finishAndMirror(
      ASSIGNMENT_ID,
      interactionRequest.requestId,
      answer.outcome,
      submissionContext(harness.unsigned),
    );
    expect(finished.outcome).toMatchObject({
      t: "answered",
      authority: { via: "channel-grant", grant },
      decision,
    });
    await expect(
      harness.ledger.prepareInteractionAnswerFromChannel({
        assignmentId: ASSIGNMENT_ID,
        requestId: interactionRequest.requestId,
        grant,
        at: NOW,
      }),
    ).resolves.toMatchObject({ kind: "replayed", result: finished });
    await expect(
      harness.ledger.prepareInteractionAnswerFromChannel({
        assignmentId: ASSIGNMENT_ID,
        requestId: interactionRequest.requestId,
        grant: {
          ...grant,
          decision: { allowed: false },
        },
        at: NOW,
      }),
    ).rejects.toThrow();
  });

  it("distinguishes task pause from deletion for already-dispatched work", async () => {
    const harness = await createUserHarness();
    const disabled = userDefinition(2, "perform scheduled work", "disabled");
    await harness.journal.define(disabled, surfaceContext("disable-dispatched"));
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("dispatched");
    const deleted = userDefinition(3, "perform scheduled work", "deleted");
    await harness.journal.define(deleted, surfaceContext("delete-dispatched"));
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancel-requested");
  });

  it("cancels proven-not-started uncertain work when its task is no longer enabled", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "disable-uncertain",
    );
    const fact = await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    const disabled = userDefinition(2, "perform scheduled work", "disabled");
    await harness.journal.define(disabled, surfaceContext("disable-uncertain"));
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancelled");
    expect((await harness.journal.currentResolution(JOB_RUN_ID))?.resolution?.kind).toBe(
      "proven-not-started-cancelled",
    );
    expect((await harness.journal.statusHistory(JOB_RUN_ID, 0)).at(-1)).toMatchObject({
      state: "uncertain-closed",
      openFactDigest: fact.openFactDigest,
      closedBy: "proven-not-started-cancelled",
      resultingState: "cancelled",
    });
  }, 15_000);

  it("keeps uncertain retry closed while the task remains disabled", async () => {
    const harness = await createUserHarness();
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    const disabled = userDefinition(2, "perform scheduled work", "disabled");
    await harness.journal.define(disabled, surfaceContext("disable-before-retry"));
    await expect(resolve(harness, "user-retry-acknowledged")).resolves.toMatchObject({
      result: { error: { code: "fence-rejected" } },
    });
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("uncertain");
  });

  it("runs a user job through the shared ledger without conversation semantics", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const bundle = await seal(harness);
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 1 });
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
  });

  it("atomically derives result and staged deliveries without intermediate status noise", async () => {
    const base = userDefinition();
    if (base.definition.kind !== "user") throw new Error("fixture definition is not user-owned");
    const definition: TaskDefinition = {
      ...base,
      definition: {
        ...base.definition,
        origin: { channelId: "feishu", to: "chat-1" },
        spec: {
          ...base.definition.spec,
          delivery: { kind: "channel", channel: "feishu", to: "chat-1" },
        },
      },
    };
    const harness = await createUserHarness({ definition });
    await start(harness);
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "deliver-job-staged-result",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: {
          target: {
            kind: "explicit",
            target: { channelId: "feishu", to: "chat-2" },
          },
          content: "staged result",
        },
      },
    });
    const bundle = await seal(harness);
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 1 });

    const commits = await harness.log.readAll();
    const committed = commits.find((commit) =>
      commit.entries.some(
        (entry) =>
          entry.stream === `job:${TASK_ID}` &&
          (entry.body as { readonly t?: string }).t === "committed",
      ),
    );
    const commitDeliveryKinds = committed?.entries
      .filter((entry) => entry.stream === "delivery")
      .map(
        (entry) =>
          (entry.body as { readonly keyBody: { readonly kind: string } }).keyBody.kind,
      );
    expect(commitDeliveryKinds).toEqual(["job-result-delivery", "staged-delivery"]);
    expect(
      commits.some((commit) =>
        commit.entries.some(
          (entry) =>
            entry.stream === "delivery" &&
            (entry.body as { readonly keyBody?: { readonly kind?: string } }).keyBody
              ?.kind === "job-status-delivery",
        ),
      ),
    ).toBe(false);
  });

  it("does not write delivery content for a none plan or during committed replay", async () => {
    let counted: WriteCountingArtifactStore | undefined;
    const noDelivery = await createUserHarness({
      ownerArtifacts(store) {
        counted = new WriteCountingArtifactStore(store);
        return counted;
      },
    });
    await start(noDelivery);
    const noneBundle = await seal(
      noDelivery,
      "x".repeat(MAX_INLINE_LOGICAL_RECORD_BYTES),
    );
    counted!.reset();
    await expect(
      noDelivery.journal.submitBundle(
        noneBundle,
        submissionContext(noDelivery.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 1 });
    expect(counted!.writes).toBe(0);

    const base = userDefinition();
    if (base.definition.kind !== "user") throw new Error("fixture definition is not user-owned");
    const definition: TaskDefinition = {
      ...base,
      definition: {
        ...base.definition,
        spec: {
          ...base.definition.spec,
          delivery: { kind: "channel", channel: "feishu", to: "chat-1" },
        },
      },
    };
    const routed = await createUserHarness({ definition });
    await start(routed);
    const routedBundle = await seal(
      routed,
      "y".repeat(MAX_INLINE_LOGICAL_RECORD_BYTES),
    );
    await routed.journal.submitBundle(
      routedBundle,
      submissionContext(routed.unsigned),
    );
    counted = new WriteCountingArtifactStore(routed.artifacts);
    counted.reset();
    await expect(reopenUserJournal(routed, counted).currentState(JOB_RUN_ID)).resolves.toBe(
      "committed",
    );
    expect(counted.writes).toBe(0);
  }, 15_000);

  it("retries a job commit after transient staged-content storage failure", async () => {
    let faulting: FaultingArtifactStore | undefined;
    const harness = await createUserHarness({
      ownerArtifacts(store) {
        faulting = new FaultingArtifactStore(store);
        return faulting;
      },
    });
    await start(harness);
    const content = await harness.artifacts.put(
      Buffer.from(canonicalize({ text: "staged", markdown: "staged" }), "utf8"),
    );
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "transient-job-staged-content",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: {
          target: {
            kind: "explicit",
            target: { channelId: "feishu", to: "chat-2" },
          },
          content: { ref: content },
        },
      },
    });
    const bundle = await seal(harness);
    const before = (await harness.log.readAll()).length;
    faulting!.failDigest = content.digest;

    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).rejects.toThrow("simulated transient delivery content read failure");
    expect((await harness.log.readAll()).length).toBe(before);

    faulting!.failDigest = undefined;
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 1 });
  }, 15_000);

  it("bounds long task names in job result and status delivery records", async () => {
    const base = userDefinition();
    if (base.definition.kind !== "user") throw new Error("fixture definition is not user-owned");
    const definition: TaskDefinition = {
      ...base,
      definition: {
        ...base.definition,
        origin: { channelId: "feishu", to: "chat-1" },
        spec: {
          ...base.definition.spec,
          name: "任".repeat(40_000),
          delivery: { kind: "channel", channel: "feishu", to: "chat-1" },
        },
      },
    };
    const resultHarness = await createUserHarness({ definition });
    await start(resultHarness);
    await resultHarness.journal.submitBundle(
      await seal(resultHarness),
      submissionContext(resultHarness.unsigned),
    );
    const resultRecord = (await resultHarness.log.readAll())
      .flatMap((envelope) => envelope.entries)
      .find(
        (entry) =>
          entry.stream === "delivery" &&
          (entry.body as { readonly keyBody?: { readonly kind?: string } }).keyBody?.kind ===
            "job-result-delivery",
      );
    expect(resultRecord).toBeDefined();
    expect(
      (resultRecord!.body as { readonly intent: { readonly source: { readonly taskName: string } } })
        .intent.source.taskName,
    ).toHaveLength(480);
    expect(Buffer.byteLength(canonicalize(resultRecord), "utf8")).toBeLessThan(
      MAX_INLINE_LOGICAL_RECORD_BYTES,
    );

    const statusHarness = await createUserHarness({ definition, assign: false });
    await statusHarness.journal.expireQueued(JOB_RUN_ID);
    const statusRecord = (await statusHarness.log.readAll())
      .flatMap((envelope) => envelope.entries)
      .find(
        (entry) =>
          entry.stream === "delivery" &&
          (entry.body as { readonly keyBody?: { readonly kind?: string } }).keyBody?.kind ===
            "job-status-delivery",
      );
    expect(statusRecord).toBeDefined();
    expect(
      (statusRecord!.body as { readonly intent: { readonly source: { readonly taskName: string } } })
        .intent.source.taskName,
    ).toHaveLength(480);
    expect(Buffer.byteLength(canonicalize(statusRecord), "utf8")).toBeLessThan(
      MAX_INLINE_LOGICAL_RECORD_BYTES,
    );
  }, 20_000);

  it("commits a job while durably conflicting one invalid staged delivery", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const invalidContent = await harness.artifacts.put(
      Buffer.from("not canonical delivery content", "utf8"),
    );
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "invalid-job-staged-content",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: {
          target: {
            kind: "explicit",
            target: { channelId: "feishu", to: "chat-2" },
          },
          content: { ref: invalidContent },
        },
      },
    });
    const bundle = await seal(harness);

    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 1 });
    const commit = (await harness.log.readAll()).find((envelope) =>
      envelope.entries.some(
        (entry) =>
          entry.stream === `job:${TASK_ID}` &&
          (entry.body as { readonly t?: string }).t === "committed",
      ),
    );
    expect(
      commit?.entries.filter(
        (entry) =>
          entry.stream === "delivery" &&
          (entry.body as { readonly keyBody?: { readonly kind?: string } }).keyBody
            ?.kind === "staged-delivery",
      ),
    ).toEqual([]);
    expect(
      commit?.entries.find(
        (entry) =>
          entry.stream === "publish" &&
          (entry.body as { readonly t?: string }).t === "publish-decision",
      )?.body,
    ).toMatchObject({
      assignmentId: ASSIGNMENT_ID,
      outcomes: [
        {
          seq: 1,
          outcome: {
            t: "conflicted",
            error: { code: "invalid", retryable: false },
          },
        },
      ],
    });
  });

  it("rejects a turn-origin delivery mutation at every job trust boundary", async () => {
    const mutation = {
      kind: "delivery-enqueue" as const,
      request: {
        target: { kind: "turn-origin" as const },
        content: "job output",
      },
    };
    const staged = {
      v: 1 as const,
      t: "staged-mutation" as const,
      seq: 1,
      domain: "global" as const,
      requestId: "invalid-job-delivery",
      expected: { anchorEpoch: 3 },
      mutation,
    };
    const batch = createMutationBatch(ASSIGNMENT_ID, [staged]);
    expect(() => validateJobStagedMutationRecord(staged)).toThrow("explicit staged delivery");
    expect(() => validateJobMutationBatch(batch)).toThrow("explicit staged delivery");

    const producer = await createUserHarness();
    await start(producer);
    await expect(
      producer.ledger.stageMutation(ASSIGNMENT_ID, {
        domain: "global",
        requestId: "invalid-job-delivery",
        expected: { anchorEpoch: 3 },
        mutation,
      }),
    ).rejects.toThrow("explicit staged delivery");
    const snapshotBeforeCorruption = await producer.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    if ("fromSeq" in snapshotBeforeCorruption) throw new Error("expected ledger snapshot");
    await producer.log.append([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: snapshotBeforeCorruption.lastSeq + 1,
          body: staged,
        },
      },
    ]);
    const replayedLedger = new ConversationAssignmentLedger({
      log: new FileAuthorityCommitLog(producer.log.rootDir, producer.artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts: producer.artifacts,
      executorId: EXECUTOR_ID,
      signer: producer.identity,
      verifier: producer.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(producer.identity, digest),
      clock: () => NOW,
    });
    await expect(
      replayedLedger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("explicit staged delivery");

    const owner = await createUserHarness();
    await start(owner);
    const batchArtifact = mutationBatchArtifact(batch);
    await owner.artifacts.put(batchArtifact.bytes);
    const bundle = createJobSealedBundle({
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      dependencyArtifacts: [],
      body: {
        t: "job",
        taskId: TASK_ID,
        jobRunId: JOB_RUN_ID,
        fence: owner.unsigned.work.fence,
        outcome: { status: "completed", summary: "done" },
        contentAssets: [],
        mutationBatch: {
          ref: batchArtifact.ref,
          sessionCount: 0,
          globalCount: 1,
        },
      },
    });
    await owner.artifacts.put(sealedBundleArtifact(bundle).bytes);
    await expect(
      owner.journal.submitBundle(bundle, submissionContext(owner.unsigned)),
    ).resolves.toMatchObject({
      committed: false,
      error: {
        code: "invalid",
        message: expect.stringContaining("explicit staged delivery"),
      },
    });
  });

  it("revalidates the committed bundle closure while rebuilding the job journal", async () => {
    const harness = await createUserHarness();
    await start(harness);
    await submitSealed(harness);
    const recovered = new JobJournal({
      taskId: TASK_ID,
      anchorEpoch: 3,
      log: harness.log,
      artifacts: harness.artifacts,
      signer: harness.identity,
      verifier: harness.identity,
      delivery: deliveryParticipant(harness.log),
      submission,
      snapshotFor: matchingSnapshotFor,
      ingress: {
        authorize(context) {
          if (context.principal.kind !== "surface") {
            throw new Error("user ingress rejected");
          }
        },
      },
      clock: () => NOW,
    });
    expect(await recovered.currentState(JOB_RUN_ID)).toBe("committed");
  });

  it("rejects an old assignment after uncertain retry creates a successor", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await resolve(harness, "user-retry-acknowledged");
    const second = createUnsignedJob(harness.identity, {
      assignmentId: "assignment-2",
      reservationId: "reservation-2",
      capabilityId: "capability-2",
    });
    await harness.journal.assign(assignmentPlan(second));
    await expect(
      harness.journal.reportStarted(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("historical assignment");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("dispatched");
  });

  it("opens a new uncertain fact when a successor attempt becomes uncertain", async () => {
    const harness = await createUserHarness();
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    const first = await harness.journal.currentResolution(JOB_RUN_ID);
    await resolve(harness, "user-retry-acknowledged");
    const second = createUnsignedJob(harness.identity, {
      assignmentId: "assignment-2",
      reservationId: "reservation-2",
      capabilityId: "capability-2",
    });
    await harness.journal.assign(assignmentPlan(second));
    await harness.journal.markUncertain("assignment-2", "ledger-unknown");
    const current = await harness.journal.currentResolution(JOB_RUN_ID);

    expect(first?.resolution).toBeUndefined();
    expect(current).toMatchObject({
      subject: { assignmentId: "assignment-2" },
      cause: "ledger-unknown",
    });
    expect(current?.resolution).toBeUndefined();
    expect(current?.openFactDigest).not.toBe(first?.openFactDigest);
  }, 15_000);

  it("pauses a task on uncertain and records later clock occurrences as missed", async () => {
    const harness = await createUserHarness();
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    expect(harness.compatibilityFacts.at(-1)?.occurrences).toContainEqual(
      expect.objectContaining({ jobRunId: JOB_RUN_ID, state: "uncertain" }),
    );
    const missed = await harness.journal.trigger({
      jobRunId: "job-run-missed",
      scheduledFor: "2026-07-15T09:01:00.000Z",
      context: surfaceContext("trigger-missed"),
      source: "user",
    });
    expect(missed.state).toBe("missed");
  });

  it("accepts only a durable not-started fence before redispatch", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-job",
    );
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    await harness.journal.acceptSupersedeProof(proof);
    await expect(
      harness.journal.requestSupersede(ASSIGNMENT_ID, "supersede-job"),
    ).resolves.toEqual(fence);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("queued");
  });

  it("replays assignment creation and cancellation without creating a second fact", async () => {
    const harness = await createUserHarness();
    const replay = await harness.journal.replayAssignment(harness.unsigned);
    expect(replay.assignmentId).toBe(ASSIGNMENT_ID);
    const first = await harness.journal.cancel({
      jobRunId: JOB_RUN_ID,
      requestId: "cancel-replay",
      context: surfaceContext("cancel-first"),
    });
    const second = await harness.journal.cancel({
      jobRunId: JOB_RUN_ID,
      requestId: "cancel-replay",
      context: surfaceContext("cancel-second"),
    });
    expect(second).toEqual(first);
  });

  it("replays a not-started cancellation proof after it resolves uncertainty", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, surfaceAbortInput());
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!proof) throw new Error("test ledger did not produce a cancel proof");
    const fact = await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    const context = submissionContext(harness.unsigned);
    await harness.journal.submitCancelProof(ASSIGNMENT_ID, proof, context);
    await harness.journal.submitCancelProof(ASSIGNMENT_ID, proof, context);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("queued");
    const closures = (await harness.journal.statusHistory(JOB_RUN_ID, 0)).filter(
      (notice) => notice.state === "uncertain-closed",
    );
    expect(closures).toEqual([
      expect.objectContaining({
        openFactDigest: fact.openFactDigest,
        closedBy: "proven-not-started-redispatched",
        resultingState: "queued",
      }),
    ]);
  });

  it("accepts a lost started response replay after the job commits", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const bundle = await seal(harness);
    await harness.journal.submitBundle(bundle, submissionContext(harness.unsigned));
    await expect(
      harness.journal.reportStarted(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toBeUndefined();
  });

  it("replays an exact committed bundle after its capability is durably revoked", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const bundle = await seal(harness);
    const context = submissionContext(harness.unsigned);
    const first = await harness.journal.submitBundle(bundle, context);
    const replay = await harness.journal.submitBundle(bundle, context);
    expect(replay).toEqual(first);
  });

  it("authorizes job tools only from active received permission facts across replay", async () => {
    const harness = await createUserHarness();
    await expect(
      harness.ledger.authorizeToolExecution(
        ASSIGNMENT_ID,
        harness.unsigned.permissionLease,
      ),
    ).rejects.toThrow("inactive");

    await start(harness);
    await expect(
      harness.ledger.authorizeToolExecution(
        ASSIGNMENT_ID,
        harness.unsigned.permissionLease,
      ),
    ).resolves.toEqual([]);
    await expect(
      reopenAssignmentLedger(harness).authorizeToolExecution(
        ASSIGNMENT_ID,
        harness.unsigned.permissionLease,
      ),
    ).resolves.toEqual([]);

    const { signature: _, ...leasePayload } = harness.unsigned.permissionLease;
    const replacementPayload = {
      ...leasePayload,
      controlLeaseId: "control-lease-replacement",
    };
    const replacementLease: PermissionSnapshotLease<"job"> = {
      ...replacementPayload,
      signature: harness.identity.sign(
        "PermissionSnapshotLease",
        1,
        replacementPayload,
      ),
    };
    await expect(
      harness.ledger.authorizeToolExecution(ASSIGNMENT_ID, replacementLease),
    ).rejects.toThrow("inactive");

    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      { fenceSeq: 1, requestId: "permission-cancel" },
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await expect(
      harness.ledger.authorizeToolExecution(
        ASSIGNMENT_ID,
        harness.unsigned.permissionLease,
      ),
    ).rejects.toThrow("inactive");
  });

  it("rejects a submission capability outside the current job authority", async () => {
    const harness = await createUserHarness();
    const context = submissionContext(harness.unsigned);
    if (context.principal.kind !== "assignment") {
      throw new Error("test fixture must use an assignment capability");
    }
    const assignedPayload = withoutSignature(context.principal.capability);
    const sameIdMutations = [
      {
        ...assignedPayload,
        methods: [...assignedPayload.methods].reverse(),
      },
      {
        ...assignedPayload,
        resources: [...assignedPayload.resources, "task:other"],
      },
      {
        ...assignedPayload,
        expiry: "2026-07-15T09:30:00.000Z",
      },
    ] as const;
    for (const mutation of sameIdMutations) {
      const forgedContext = submissionContext(harness.unsigned);
      if (forgedContext.principal.kind !== "assignment") {
        throw new Error("test fixture must use an assignment capability");
      }
      forgedContext.deadlineAt = mutation.expiry;
      forgedContext.principal.capability = {
        ...mutation,
        methods: [...mutation.methods],
        resources: [...mutation.resources],
        signature: harness.identity.sign("AuthorityCapability", 1, mutation),
      };
      await expect(
        harness.journal.reportStarted(ASSIGNMENT_ID, forgedContext),
      ).rejects.toThrow("does not match the durable dispatch capability");
    }
    const forgedPayload = {
      ...withoutSignature(context.principal.capability),
      scope: { execution: "job" as const, taskId: "task-other" },
    };
    context.principal.capability = {
      ...forgedPayload,
      signature: harness.identity.sign("AuthorityCapability", 1, forgedPayload),
    };
    await expect(
      harness.journal.reportStarted(ASSIGNMENT_ID, context),
    ).rejects.toThrow("not activated by durable authority state");
  });

  it("keeps contradictory not-started evidence uncertain after durable started", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const payload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      authority: { execution: "job" as const, taskId: TASK_ID, anchorEpoch: 3 },
      lastRecordSeq: 2,
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      ledgerDigest: SHA256_ZERO,
      issuedAt: NOW,
      cause: "abort-ticket" as const,
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
      decision: "not-started" as const,
    };
    const proof = signCancelProof(payload, harness.identity);
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("uncertain");
  });

  it("settles all three uncertain user decisions through durable control", async () => {
    for (const [decision, state] of [
      ["user-verified-side-effects", "failed"],
      ["user-abandoned", "cancelled"],
      ["user-retry-acknowledged", "queued"],
    ] as const) {
      const harness = await createUserHarness();
      const liveNotices: Awaited<ReturnType<typeof harness.journal.statusHistory>> = [];
      harness.journal.onStatus(() => {
        throw new Error("simulated status consumer failure");
      });
      harness.journal.onStatus((notice) => {
        liveNotices.push(notice);
      });
      const fact = await harness.journal.markUncertain(
        ASSIGNMENT_ID,
        "ledger-unknown",
      );
      const result = await resolve(harness, decision);
      expect(result.kind).toBe("applied");
      expect(await harness.journal.currentState(JOB_RUN_ID)).toBe(state);
      const uncertainNotices = (await harness.journal.statusHistory(JOB_RUN_ID, 0)).filter(
        (notice) => notice.state === "uncertain" || notice.state === "uncertain-closed",
      );
      expect(uncertainNotices).toEqual([
        expect.objectContaining({
          state: "uncertain",
          openFactDigest: fact.openFactDigest,
        }),
        expect.objectContaining({
          state: "uncertain-closed",
          openFactDigest: fact.openFactDigest,
          closedBy: decision,
          resultingState: state,
        }),
      ]);
      await vi.waitFor(() => expect(liveNotices).toEqual(uncertainNotices));
    }
  }, 20_000);

  it("makes job control request replay return the original occurrence", async () => {
    const harness = await createUserHarness({ assign: false });
    await harness.journal.expireQueued(JOB_RUN_ID);
    const control = new ControlAdmissionJournal(harness.log, harness.artifacts);
    const source = jobRunSource();
    const envelope = createJobControlEnvelope({
      requestId: "manual-job-run",
      source,
      at: "2026-07-15T09:02:00.000Z",
      body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
    });
    const first = await harness.journal.applyControl({ admission: control, envelope, source });
    const replay = await harness.journal.applyControl({ admission: control, envelope, source });
    expect(first.kind).toBe("applied");
    expect(replay.kind).toBe("replayed");
    expect(replay.result).toEqual(first.result);
    const manualJobRunId = first.kind === "applied" && first.result.status === "ok"
      ? first.result.body.jobRunId
      : undefined;
    const records = await harness.log.readStream<{
      readonly t: string;
      readonly jobRunId?: string;
      readonly ingress?: unknown;
    }>(`job:${TASK_ID}`);
    expect(
      records.find(
        (entry) => entry.body.t === "admitted" && entry.body.jobRunId === manualJobRunId,
      )?.body.ingress,
    ).toEqual(source.ingress);
    if (!manualJobRunId) throw new Error("manual job-run result is missing");
    await expect(reopenUserJournal(harness).currentState(manualJobRunId)).resolves.toBe(
      "queued",
    );
  });

  it("atomically replaces an active queued occurrence for a manual run", async () => {
    const harness = await createUserHarness({ assign: false });
    const source = jobRunSource();
    const outcome = await harness.journal.applyControl({
      admission: new ControlAdmissionJournal(harness.log, harness.artifacts),
      envelope: createJobControlEnvelope({
        requestId: "manual-replace-queued",
        source,
        at: NOW,
        body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
      }),
      source,
    });
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("expired");
    expect(outcome).toMatchObject({
      kind: "applied",
      result: {
        status: "ok",
        body: { t: "job-run", jobRunId: expect.stringMatching(/^jobrun-[0-9A-HJKMNP-TV-Z]{26}$/u) },
      },
    });
  });

  it("finishes a received-only job request from its first durable envelope and ingress", async () => {
    const harness = await createUserHarness({ assign: false });
    const firstSource = jobRunSource(NOW, "manual-crash-retry");
    const firstEnvelope = createJobControlEnvelope({
      requestId: "manual-crash-retry",
      source: firstSource,
      at: NOW,
      body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
    });
    const firstAdmission = new ControlAdmissionJournal(harness.log, harness.artifacts);
    await expect(
      firstAdmission.applyAuthority({
        envelope: firstEnvelope,
        source: firstSource,
        stream: `job:${TASK_ID}`,
        initial: 0,
        reducer: (state) => state,
        decide: () => {
          throw new Error("simulated loss after received");
        },
      }),
    ).rejects.toThrow("simulated loss after received");

    const retrySource = jobRunSource(
      "2026-07-15T09:05:00.000Z",
      "manual-crash-retry",
    );
    const retryEnvelope = createJobControlEnvelope({
      requestId: "manual-crash-retry",
      source: retrySource,
      at: "2026-07-15T09:06:00.000Z",
      body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
    });
    let durableAt: string | undefined;
    let durableReceivedAt: string | undefined;
    const restarted = new ControlAdmissionJournal(
      new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      harness.artifacts,
    );
    const outcome = await restarted.applyAuthority({
      envelope: retryEnvelope,
      source: retrySource,
      stream: `job:${TASK_ID}`,
      initial: 0,
      reducer: (state) => state,
      decide: (_state, context) => {
        durableAt = context.envelope.at;
        durableReceivedAt = context.ingress?.receivedAt;
        return {
          result: {
            v: 1,
            status: "ok",
            body: { t: "job-run", jobRunId: "jobrun-recovered" },
          },
        };
      },
    });
    expect(outcome.kind).toBe("applied");
    expect(durableAt).toBe(NOW);
    expect(durableReceivedAt).toBe(NOW);
  });

  it("replays an interaction mirror so job sealing can close its ledger", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const requestId = "interaction-1";
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId,
      toolName: "write",
      display: { title: "confirm", lines: ["write result"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-15T09:01:00.000Z",
    });
    await harness.ledger.finishInteraction(ASSIGNMENT_ID, requestId, {
      t: "auto-resolved",
      decision: "denied",
      reason: "no-interactive-surface",
    });
    const batch = await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID);
    if (!batch) throw new Error("test interaction mirror is missing");
    const first = await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      batch,
      submissionContext(harness.unsigned),
    );
    const replay = await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      batch,
      submissionContext(harness.unsigned),
    );
    expect(replay).toEqual(first);
    expect(batch.previousDigest).toBe(interactionMirrorSeed(ASSIGNMENT_ID));
  });

  it("gates the in-process dispatcher and redrives durable outboxes", async () => {
    const harness = await createUserHarness();
    const cancellation = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    const disabled = new InProcessJobDispatcher({
      enabled: false,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
    });
    expect(await disabled.dispatchPending()).toEqual([]);
    const enabled = new InProcessJobDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: {
        submitCancellation(assignmentId) {
          return cancellation.submitCancellation(
            assignmentId,
            submissionContext(harness.unsigned),
          );
        },
      },
      bundleSubmission: {
        submitSealedBundle(assignmentId) {
          return cancellation.submitSealedBundle(
            assignmentId,
            submissionContext(harness.unsigned),
          );
        },
      },
    });
    expect(await enabled.dispatchPending()).toHaveLength(1);
    expect(await enabled.dispatchPending()).toEqual([]);
  });

  it("rejects a job manifest mismatch before durable receipt", async () => {
    const harness = await createUserHarness({
      executorSnapshotFor(executorId) {
        const value = matchingSnapshotFor(executorId);
        if (!value) return undefined;
        value.inventory.assetVersions.skillsRev = 2;
        return value;
      },
    });
    if (!harness.dispatch) throw new Error("test harness has no assignment");

    const result = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );

    expect(result).toMatchObject({
      accepted: false,
      error: { code: "revision-conflict", retryable: true },
    });
  });

  it("rejects a job dispatch from the wrong anchor before any durable control fact", async () => {
    const harness = await createUserHarness();
    if (!harness.dispatch) throw new Error("test harness has no assignment");
    await expect(harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(
        ASSIGNMENT_ID,
        "executor.dispatch",
        undefined,
        { execution: "job", taskId: TASK_ID, anchorEpoch: 4 },
      ),
    )).rejects.toThrow("owner control authorization failed");
    await expect(
      harness.log.readStream(`assignment:${ASSIGNMENT_ID}`),
    ).resolves.toHaveLength(0);
    await expect(harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    )).resolves.toMatchObject({ accepted: true });
  });

  it("does not derive durable job control from an unverified activation authority", async () => {
    const harness = await createUserHarness();
    if (!harness.dispatch) throw new Error("test harness has no assignment");
    const unverifiedActivation = {
      ...harness.dispatch.activation,
      ref: {
        ...harness.dispatch.activation.ref,
        taskId: "task-other",
      },
    } as typeof harness.dispatch.activation;

    await expect(harness.ledger.dispatch(
      harness.dispatch.envelope,
      unverifiedActivation,
      ownerContext(
        ASSIGNMENT_ID,
        "executor.dispatch",
        undefined,
        { execution: "job", taskId: "task-other", anchorEpoch: 3 },
      ),
    )).rejects.toThrow("owner control authorization failed");
    await expect(
      harness.log.readStream(`assignment:${ASSIGNMENT_ID}`),
    ).resolves.toHaveLength(0);
    await expect(harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    )).resolves.toMatchObject({ accepted: true });
  });

  it("keeps a mismatched job queued before signing or assigning it", async () => {
    const harness = await createUserHarness({
      assign: false,
      ownerSnapshotFor(executorId) {
        const value = matchingSnapshotFor(executorId);
        if (!value) return undefined;
        value.inventory.assetVersions.skillsRev = 2;
        return value;
      },
    });

    let materialized = false;
    await expect(harness.journal.assign(assignmentPlan(harness.unsigned, () => {
      materialized = true;
      return harness.unsigned;
    }))).rejects.toThrow(
      "Execution snapshot revision mismatch: skillsRev",
    );
    expect(materialized).toBe(false);
    await expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("queued");
    await expect(harness.journal.pendingDispatches()).resolves.toEqual([]);
  });

  it("redrives a sealed bundle after owner commit response loss and acknowledges it", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const bundle = await seal(harness);
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 1 });
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "sealed" });

    expect(await recoverAssignments(harness)).toBe(1);
    const acknowledged = await harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      );
    expect(acknowledged).toMatchObject({
      phase: "acked",
      acknowledgedCommitRevision: 1,
    });
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
    let secondRestartQueries = 0;
    expect(
      await recoverAssignments(harness, {
        onQuery: () => {
          secondRestartQueries += 1;
        },
      }),
    ).toBe(0);
    expect(secondRestartQueries).toBe(0);
  });

  it("redrives a late bundle after uncertain commit response loss", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const bundle = await seal(harness);
    const fact = await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 1 });
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({ phase: "sealed" });
    expect((await harness.journal.statusHistory(JOB_RUN_ID, 0)).at(-1)).toMatchObject({
      state: "uncertain-closed",
      openFactDigest: fact.openFactDigest,
      closedBy: "late-bundle-committed",
      resultingState: "committed",
    });
    const restarted = reopenUserJournal(harness);
    await expect(restarted.statusHistory(JOB_RUN_ID, 0)).resolves.toEqual(
      await harness.journal.statusHistory(JOB_RUN_ID, 0),
    );
    expect(await restarted.assignmentsAwaitingRecovery()).toEqual([
      expect.objectContaining({ assignmentId: ASSIGNMENT_ID, state: "committed" }),
    ]);

    let submissions = 0;
    expect(
      await recoverAssignments(
        harness,
        {
          onSubmit: () => {
            submissions += 1;
          },
        },
        restarted,
      ),
    ).toBe(1);
    expect(submissions).toBe(1);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).resolves.toMatchObject({
      phase: "acked",
      acknowledgedCommitRevision: 1,
    });
    const secondRestart = reopenUserJournal(harness);
    expect(await secondRestart.assignmentsAwaitingRecovery()).toEqual([]);

    let secondRestartQueries = 0;
    expect(
      await recoverAssignments(
        harness,
        {
          onQuery: () => {
            secondRestartQueries += 1;
          },
        },
        secondRestart,
      ),
    ).toBe(0);
    expect(secondRestartQueries).toBe(0);
  });

  it("closes an already-acked bundle outbox without resubmission and rejects a wrong binding", async () => {
    const harness = await createUserHarness();
    await start(harness);
    await seal(harness);
    const adapter = submissionAdapter(harness);
    await expect(
      adapter.submitSealedBundle(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 1 });
    const raw = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    if ("fromSeq" in raw) throw new Error("expected a ledger snapshot");
    await expect(
      harness.journal.observeBundleAcknowledgement(ASSIGNMENT_ID, {
        ...raw,
        acknowledgedCommitRevision: 2,
      }),
    ).rejects.toThrow("does not bind the committed job revision");
    await expect(
      harness.journal.observeBundleAcknowledgement(ASSIGNMENT_ID, {
        ...raw,
        sealedBundleRef: { digest: SHA256_ZERO, bytes: 0 },
      }),
    ).rejects.toThrow("does not bind the committed job revision");

    let queries = 0;
    let submissions = 0;
    expect(
      await recoverAssignments(harness, {
        onQuery: () => {
          queries += 1;
        },
        onSubmit: () => {
          submissions += 1;
        },
      }),
    ).toBe(1);
    expect({ queries, submissions }).toEqual({ queries: 1, submissions: 0 });

    queries = 0;
    expect(
      await recoverAssignments(harness, {
        onQuery: () => {
          queries += 1;
        },
      }),
    ).toBe(0);
    expect(queries).toBe(0);
  });

  it("re-enters cancellation after audit settlement closes a pending interaction", async () => {
    const harness = await createUserHarness();
    const submission = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    const dispatcher = new InProcessJobDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: {
        submitCancellation(assignmentId) {
          return submission.submitCancellation(
            assignmentId,
            submissionContext(harness.unsigned),
          );
        },
      },
      bundleSubmission: {
        submitSealedBundle(assignmentId) {
          return submission.submitSealedBundle(
            assignmentId,
            submissionContext(harness.unsigned),
          );
        },
      },
    });
    await dispatcher.dispatchPending();
    await submission.startAndReport(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "cancel-pending-interaction",
      toolName: "write",
      display: { title: "confirm", lines: ["write result"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-15T09:01:00.000Z",
    });
    await dispatcher.cancel({
      jobRunId: JOB_RUN_ID,
      requestId: "cancel-after-audit-settlement",
      context: surfaceContext("cancel-after-audit-settlement"),
    });
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancelled");
  }, DURABLE_IO_TEST_TIMEOUT_MS);
});

const USER_JOB_ROWS = [
  [1, "trigger creates a queued occurrence"],
  [2, "an open uncertain fact turns the next clock occurrence into missed"],
  [3, "a complete dispatch decision activates the assignment"],
  [4, "a recoverable selection conflict leaves the occurrence queued"],
  [5, "a permanent capability gap fails a queued occurrence"],
  [6, "disabling the task cancels a queued occurrence"],
  [7, "job cancellation closes a queued occurrence"],
  [8, "queue expiry closes an overdue occurrence"],
  [9, "durable started evidence advances a dispatch to running"],
  [10, "a legal bundle commits when the started response was lost"],
  [11, "a durable not-started supersede proof returns work to the queue"],
  [12, "an unverifiable dispatch timeout opens ledger uncertainty"],
  [13, "a running assignment commits its legal bundle"],
  [14, "loss after durable started opens uncertainty"],
  [15, "cancelling a dispatched assignment records a fence"],
  [16, "cancelling a running assignment records a fence"],
  [17, "an owner-fence not-started proof cancels dispatched work"],
  [18, "an owner-fence halted proof cancels started work"],
  [19, "an abort-ticket not-started proof closes the cancellation race"],
  [20, "an abort-ticket halted proof closes the cancellation race"],
  [21, "an open effect behind an abort ticket opens cancellation uncertainty"],
  [22, "a bundle sealed before cancellation wins the race"],
  [23, "loss while cancellation is pending opens cancellation uncertainty"],
  [24, "a legal late bundle commits from uncertainty"],
  [25, "a durable termination proof resolves uncertainty back to queued"],
  [26, "verified side effects resolve uncertainty to failed"],
  [27, "abandoning an uncertain run resolves it to cancelled"],
  [28, "risk-acknowledged retry resolves uncertainty to queued"],
  [29, "a recoverable offline target remains durably queued"],
  [30, "recovery accepts an abort-ticket not-started proof while dispatched"],
  [31, "recovery accepts an abort-ticket halted proof while dispatched"],
  [32, "recovery opens uncertainty for an unresolved dispatched abort"],
  [33, "recovery accepts an abort-ticket halted proof while running"],
  [34, "recovery rejects not-started evidence after durable started"],
  [35, "recovery opens uncertainty for an unresolved running abort"],
  [36, "a conflict that accepted the durable dispatch only acknowledges it"],
  [37, "a conflict that accepted another dispatch opens uncertainty"],
  [38, "a halted conflict fence contains effects without resolving the fact"],
] as const;

describe("user job state machine rows", () => {
  it.each(USER_JOB_ROWS)("[6.2 row %i] %s", async (row) => {
    await exerciseUserJobRow(row);
  }, 15_000);
});

describe("job cancellation evidence authority binding", () => {
  it("rejects pre-received control evidence that does not bind the assigned envelope", async () => {
    const harness = await createUserHarness();
    const cancellation = await harness.journal.cancel({
      jobRunId: JOB_RUN_ID,
      requestId: "polluted-job-control-evidence",
      context: surfaceContext("polluted-job-control-evidence"),
    });
    if (cancellation.state !== "cancel-requested") {
      throw new Error("expected cancellation fence");
    }
    if (!harness.dispatch) throw new Error("test harness has no assignment");
    const { signature: _, ...lease } = harness.dispatch.envelope.controlLease;
    const leasePayload = {
      ...lease,
      authority: {
        execution: "job" as const,
        taskId: "task-other",
        anchorEpoch: 3,
      },
    };
    const entries: AssignmentEntry[] = [
      {
        recordSeq: 1,
        body: {
          v: 1,
          t: "control-lease-renewed",
          lease: {
            ...leasePayload,
            signature: harness.identity.sign("ControlLease", 1, leasePayload),
          },
        },
      },
      {
        recordSeq: 2,
        body: {
          v: 1,
          t: "abort-requested",
          via: "owner-fence",
          refId: cancellation.fence.requestId,
        },
      },
    ];
    let chainDigest = assignmentLedgerSeed(ASSIGNMENT_ID);
    for (const entry of entries) {
      chainDigest = advanceAssignmentLedger(chainDigest, entry);
    }
    const payload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      fromSeq: 1,
      toSeq: entries.at(-1)!.recordSeq,
      entries,
      chainDigest,
    };
    const pollutedPage: LedgerEvidencePage = {
      ...payload,
      signature: harness.identity.sign("LedgerEvidencePage", 1, payload),
    };
    const snapshot: LedgerSnapshot = {
      v: 1,
      assignmentId: ASSIGNMENT_ID,
      lastSeq: entries.length,
      phase: "unknown",
    };
    await expect(
      harness.journal.reconcileCancellationEvidence(
        ASSIGNMENT_ID,
        snapshot,
        (async function* () {
          yield pollutedPage;
        })(),
      ),
    ).rejects.toThrow(
      "Control lease evidence does not bind the durable job assignment",
    );
  });
});

const CANCELLATION_RACE_PERMUTATIONS = [
  ["owner-fence", "abort-ticket", "sealed"],
  ["owner-fence", "sealed", "abort-ticket"],
  ["abort-ticket", "owner-fence", "sealed"],
  ["abort-ticket", "sealed", "owner-fence"],
  ["sealed", "owner-fence", "abort-ticket"],
  ["sealed", "abort-ticket", "owner-fence"],
] as const;

describe("user job three-party cancellation race", () => {
  it.each(CANCELLATION_RACE_PERMUTATIONS)(
    "%s -> %s -> %s",
    async (...order) => {
      const harness = await createUserHarness();
      await receive(harness);
      await harness.ledger.start(ASSIGNMENT_ID);
      let sealed = false;
      for (const event of order) {
        if (event === "owner-fence") {
          await requestOwnerCancellation(harness, `race-${order.join("-")}`, false);
        } else if (event === "abort-ticket") {
          await harness.ledger.abortFromSurface(ASSIGNMENT_ID, surfaceAbortInput());
        } else {
          try {
            await seal(harness);
            sealed = true;
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain("cannot seal");
          }
        }
      }
      if (sealed) {
        await submitExistingSeal(harness);
        expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
      } else {
        await expect(
          submissionAdapter(harness).submitCancellation(
            ASSIGNMENT_ID,
            submissionContext(harness.unsigned),
          ),
        ).resolves.toBe(true);
        expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancelled");
      }
    },
    15_000,
  );
});

describe("system job local protocol", () => {
  it("rejects surface construction of system run and cancellation controls", async () => {
    const harness = await createSystemHarness();
    const source = jobRunSource();
    const run = createJobControlEnvelope({
      requestId: "surface-system-run",
      source,
      at: NOW,
      body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
    });
    await expect(
      harness.journal.applyControl({ admission: harness.control, envelope: run, source }),
    ).resolves.toMatchObject({
      kind: "applied",
      result: { error: { code: "unauthorized" } },
    });
  });

  it("rejects a system occurrence carrying surface ingress during full replay", async () => {
    const harness = await createSystemHarness();
    await harness.log.append([
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "occurrence" as const,
          occ: {
            taskId: TASK_ID,
            jobRunId: JOB_RUN_ID,
            scheduledFor: NOW,
            taskRevision: 1,
            deliveryPlan: {
              delivery: { kind: "none" as const },
              planDigest: jobDeliveryPlanDigest({ kind: "none" }),
            },
            state: "queued" as const,
          },
        },
      },
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "admitted" as const,
          taskId: TASK_ID,
          jobRunId: JOB_RUN_ID,
          scheduledFor: NOW,
          ingress: jobRunSource().ingress,
        },
      },
    ]);
    await expect(harness.createJournal().currentState(JOB_RUN_ID)).rejects.toThrow(
      "cannot originate from a surface",
    );
  });

  it("executes, settles, and replays a completed system occurrence once", async () => {
    const harness = await createSystemHarness();
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run")),
    ).resolves.toBe("committed");
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-replay")),
    ).resolves.toBe("committed");
    expect(harness.handlerCalls).toBe(1);
    expect(harness.terminalCalls).toBe(1);
    await expect(harness.journal.systemResult(JOB_RUN_ID)).resolves.toMatchObject({
      outcome: "committed",
      summary: "collected",
    });
  });

  it("records handler failure and releases its resource root", async () => {
    const harness = await createSystemHarness({ fail: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-fail"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run-fail")),
    ).resolves.toBe("failed");
    expect(harness.terminalCalls).toBe(1);
    await expect(harness.journal.systemResult(JOB_RUN_ID)).resolves.toMatchObject({
      outcome: "failed",
      error: "handler failed",
    });
  });

  it("normalizes an invalid handler result into one durable failure", async () => {
    const harness = await createSystemHarness({ handlerSummary: 42 });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-invalid-result"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run-invalid-result")),
    ).resolves.toBe("failed");
    await expect(
      harness.journal.resumeSystemJobs(hostContext("system-recover-invalid-result")),
    ).resolves.toBe(0);
    expect(harness.handlerCalls).toBe(1);
    expect(harness.terminalCalls).toBe(1);
    await expect(harness.journal.systemResult(JOB_RUN_ID)).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("summary"),
    });
  });

  it.each([
    { name: "summary", options: { handlerSummary: "s".repeat(40_000) }, outcome: "committed" },
    {
      name: "error",
      options: { fail: true, failureMessage: "e".repeat(40_000) },
      outcome: "failed",
    },
  ] as const)("externalizes and replays an oversized system $name", async ({ options, outcome }) => {
    const harness = await createSystemHarness(options);
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext(`system-trigger-large-${outcome}`),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext(`system-run-large-${outcome}`)),
    ).resolves.toBe(outcome);
    const records = await harness.log.readStream<{
      readonly t: string;
      readonly detail?: unknown;
    }>(`job:${TASK_ID}`);
    expect(records.find((entry) => entry.body.t === "system-result")?.body.detail).toMatchObject({
      ref: { digest: expect.stringMatching(/^sha256:/u) },
    });
    const replayed = await harness.createJournal().systemResult(JOB_RUN_ID);
    expect(replayed?.outcome).toBe(outcome);
    expect((replayed?.summary ?? replayed?.error)?.length).toBe(40_000);
  });

  it("coalesces concurrent local starts behind one durable system fence", async () => {
    const harness = await createSystemHarness();
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-concurrent"),
      source: "system",
    });
    await expect(
      Promise.all([
        harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run-concurrent-a")),
        harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run-concurrent-b")),
      ]),
    ).resolves.toEqual(["committed", "committed"]);
    expect(harness.prepareCalls).toBe(1);
    expect(harness.handlerCalls).toBe(1);
  });

  it("does not mistake an active runner in another journal instance for recovery", async () => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const harness = await createSystemHarness({ handlerGate });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-rival"),
      source: "system",
    });
    const active = harness.journal.runSystem(
      JOB_RUN_ID,
      hostContext("system-run-primary"),
    );
    while ((await harness.journal.currentState(JOB_RUN_ID)) !== "running") {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const rival = harness.createJournal();
    await expect(
      rival.runSystem(JOB_RUN_ID, hostContext("system-run-rival")),
    ).rejects.toThrow("already owned by an active runner");
    releaseHandler();
    await expect(active).resolves.toBe("committed");
    expect(harness.handlerCalls).toBe(1);
  });

  it("rejects a system resource candidate outside scheduler admission", async () => {
    const harness = await createSystemHarness({ invalidAdmission: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-invalid-lease"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run-invalid-lease")),
    ).rejects.toThrow("System job resource root has an invalid contract combination");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("queued");
    expect(harness.handlerCalls).toBe(0);
  });

  it.each(["activation", "terminal"] as const)(
    "rejects system %s records that do not bind the durable fence",
    async (invalidResourceBinding) => {
      const harness = await createSystemHarness({ invalidResourceBinding });
      await harness.journal.trigger({
        jobRunId: JOB_RUN_ID,
        scheduledFor: NOW,
        context: hostContext(`system-trigger-invalid-${invalidResourceBinding}`),
        source: "system",
      });
      await expect(
        harness.journal.runSystem(
          JOB_RUN_ID,
          hostContext(`system-run-invalid-${invalidResourceBinding}`),
        ),
      ).rejects.toThrow("do not bind the durable");
      expect(await harness.journal.currentState(JOB_RUN_ID)).toBe(
        invalidResourceBinding === "activation" ? "queued" : "running",
      );
    },
  );

  it("fails closed when system resource replay has no binding coordinator", async () => {
    const harness = await createSystemHarness({ crashAfterStart: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-missing-replay-coordinator"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(
        JOB_RUN_ID,
        hostContext("system-run-missing-replay-coordinator"),
      ),
    ).rejects.toThrow("simulated process loss");
    await expect(
      harness.createJournal({ omitSystemResources: true }).currentState(JOB_RUN_ID),
    ).rejects.toThrow("resource coordination is not configured");
  });

  it("redrives a running system occurrence with an incremented replacement attempt", async () => {
    const harness = await createSystemHarness({ crashAfterStart: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-recover"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-first")),
    ).rejects.toThrow("simulated process loss");
    harness.crashAfterStart.value = false;
    await expect(
      harness.journal.resumeSystemJobs(hostContext("system-recover")),
    ).resolves.toBe(1);
    expect(harness.recoverCalls).toBe(1);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
  });

  it("redrives a queued system occurrence after resource admission is deferred", async () => {
    const harness = await createSystemHarness({ deferFirstPrepare: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-deferred"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run-deferred")),
    ).rejects.toThrow("admission deferred");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("queued");
    await expect(
      harness.journal.resumeSystemJobs(hostContext("system-resume-deferred")),
    ).resolves.toBe(1);
    expect(harness.prepareCalls).toBe(2);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
  });

  it("redrives a running system occurrence with its still-valid durable lease", async () => {
    const harness = await createSystemHarness({
      crashAfterStart: true,
      recovery: "reuse",
    });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-reuse"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-first-reuse")),
    ).rejects.toThrow("simulated process loss");
    harness.crashAfterStart.value = false;
    await expect(
      harness.journal.resumeSystemJobs(hostContext("system-recover-reuse")),
    ).resolves.toBe(1);
    expect(harness.recoverCalls).toBe(1);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
  });

  it("coalesces repeated misses while one system occurrence is active", async () => {
    const harness = await createSystemHarness({ crashAfterStart: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-active"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run-active")),
    ).rejects.toThrow("simulated process loss");
    const first = await harness.journal.trigger({
      jobRunId: "system-miss-1",
      scheduledFor: "2026-07-15T09:01:00.000Z",
      context: hostContext("system-miss-1"),
      source: "system",
    });
    const second = await harness.journal.trigger({
      jobRunId: "system-miss-2",
      scheduledFor: "2026-07-15T09:02:00.000Z",
      context: hostContext("system-miss-2"),
      source: "system",
    });
    expect(first.state).toBe("missed");
    expect(second.jobRunId).toBe(first.jobRunId);
  });

  it("rejects a coalesced miss that does not bind the pending missed occurrence", async () => {
    const harness = await createSystemHarness({ crashAfterStart: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-invalid-alias"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("system-run-invalid-alias")),
    ).rejects.toThrow("simulated process loss");
    await harness.journal.trigger({
      jobRunId: "system-pending-miss",
      scheduledFor: "2026-07-15T09:01:00.000Z",
      context: hostContext("system-pending-miss"),
      source: "system",
    });
    await harness.log.append([
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "system-miss-coalesced" as const,
          requestedJobRunId: "system-invalid-alias",
          scheduledFor: "2026-07-15T09:02:00.000Z",
          coalescedJobRunId: JOB_RUN_ID,
        },
      },
    ]);
    await expect(harness.createJournal().currentState(JOB_RUN_ID)).rejects.toThrow(
      "alias is invalid",
    );
  });

  it("coalesces clock misses without expiring a queued system occurrence", async () => {
    const harness = await createSystemHarness();
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-queued"),
      source: "system",
    });
    const first = await harness.journal.trigger({
      jobRunId: "system-queued-miss-1",
      scheduledFor: "2026-07-15T09:01:00.000Z",
      context: hostContext("system-queued-miss-1"),
      source: "system",
    });
    const second = await harness.journal.trigger({
      jobRunId: "system-queued-miss-2",
      scheduledFor: "2026-07-15T09:02:00.000Z",
      context: hostContext("system-queued-miss-2"),
      source: "system",
    });
    const restarted = harness.createJournal();
    const replay = await restarted.trigger({
      jobRunId: "system-queued-miss-2",
      scheduledFor: "2026-07-15T09:02:00.000Z",
      context: hostContext("system-queued-miss-2-retry"),
      source: "system",
    });
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("queued");
    expect(first.state).toBe("missed");
    expect(second.jobRunId).toBe(first.jobRunId);
    expect(replay).toEqual(second);
  });

  it("cancels an unleased queued system occurrence when disabled", async () => {
    const harness = await createSystemHarness();
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-disable"),
      source: "system",
    });
    await harness.journal.define(
      systemDefinition(2, "disabled"),
      hostContext("disable-system"),
    );
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancelled");
    expect(harness.prepareCalls).toBe(0);
  });

  it("keeps user-only selection outcomes out of the system job state machine", async () => {
    const harness = await createSystemHarness();
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("system-trigger-selection-boundary"),
      source: "system",
    });
    await expect(harness.journal.failQueued(JOB_RUN_ID)).rejects.toThrow(
      "Only user job occurrences",
    );
    await expect(harness.journal.expireQueued(JOB_RUN_ID)).rejects.toThrow(
      "Only user job occurrences",
    );
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("queued");
  });
});

const SYSTEM_JOB_ROWS = [
  [1, "host trigger is queued and surface construction is rejected"],
  [2, "a prepared resource root and system fence activate running atomically"],
  [3, "handler completion commits and settles the resource root"],
  [4, "handler failure fails and releases the resource root"],
  [5, "recovery replaces the lost attempt and completes it"],
  [6, "disabling an unleased occurrence cancels it"],
] as const;

describe("system job state machine rows", () => {
  it.each(SYSTEM_JOB_ROWS)("[6.2b row %i] %s", async (row) => {
    await exerciseSystemJobRow(row);
  }, 15_000);
});

describe("user job clock occurrences while one is in flight", () => {
  it.each([
    ["dispatched"],
    ["running"],
    ["cancel-requested"],
    ["uncertain"],
  ] as const)(
    "records the next clock occurrence as missed while the task is %s",
    async (occupied) => {
      const harness = await createUserHarness();
      if (occupied === "running") {
        await start(harness);
      } else if (occupied === "cancel-requested") {
        await requestOwnerCancellation(harness, `occupied-${occupied}`, false);
      } else if (occupied === "uncertain") {
        await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
      }
      const occurrence = await harness.journal.trigger({
        jobRunId: "job-run-next",
        scheduledFor: "2026-07-15T09:05:00.000Z",
        context: surfaceContext(`occupied-${occupied}`),
        source: "user",
      });
      expect(occurrence.state).toBe("missed");
      expect(await harness.journal.currentState(JOB_RUN_ID)).toBe(occupied);
    },
    15_000,
  );

  it("expires a still-queued user occurrence and admits the next clock occurrence", async () => {
    const harness = await createUserHarness({ assign: false });
    const next = await harness.journal.trigger({
      jobRunId: "job-run-next",
      scheduledFor: "2026-07-15T09:05:00.000Z",
      context: surfaceContext("queued-handover"),
      source: "user",
    });
    expect(next.state).toBe("queued");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("expired");
    expect(await harness.journal.currentState("job-run-next")).toBe("queued");
  });
});

const FENCE_TAMPERS = [
  ["taskId", { taskId: "task-2" }],
  ["jobRunId", { jobRunId: "job-run-2" }],
  ["scheduledFor", { scheduledFor: "2026-07-15T09:00:01.000Z" }],
  ["taskRevision", { taskRevision: 2 }],
  [
    "deliveryPlanDigest",
    {
      deliveryPlanDigest: jobDeliveryPlanDigest({
        kind: "channel",
        channel: "channel-1",
        to: "user-1",
      }),
    },
  ],
  ["anchorEpoch", { anchorEpoch: 4 }],
  ["assignmentId", { assignmentId: "assignment-2" }],
  ["executorId", { executorId: "executor-2" }],
] as const;

describe("job commit fence field pollution", () => {
  it.each(FENCE_TAMPERS)(
    "rejects a self-consistent bundle whose fence %s does not match the occurrence",
    async (_field, override) => {
      const harness = await createUserHarness();
      await start(harness);
      const fence = createJobCommitFence({
        taskId: TASK_ID,
        jobRunId: JOB_RUN_ID,
        scheduledFor: NOW,
        taskRevision: 1,
        deliveryPlanDigest: jobDeliveryPlanDigest({ kind: "none" }),
        anchorEpoch: 3,
        assignmentId: ASSIGNMENT_ID,
        executorId: EXECUTOR_ID,
        ...override,
      });
      const bundle = createJobSealedBundle({
        assignmentId: ASSIGNMENT_ID,
        executorId: EXECUTOR_ID,
        streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        dependencyArtifacts: [],
        body: {
          t: "job",
          jobRunId: fence.jobRunId,
          taskId: fence.taskId,
          fence,
          outcome: { status: "completed", summary: "polluted" },
          contentAssets: [],
        },
      });
      await harness.artifacts.put(Buffer.from(canonicalize(bundle), "utf8"));
      const result = await harness.journal.submitBundle(
        bundle,
        submissionContext(harness.unsigned),
      );
      expect(result).toMatchObject({
        committed: false,
        error: { code: "fence-rejected" },
      });
      expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("running");
    },
    15_000,
  );

  it("rejects sealing a job result whose fence does not match the durable dispatch", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    await harness.ledger.start(ASSIGNMENT_ID);
    await expect(
      harness.ledger.sealJobBundle(ASSIGNMENT_ID, {
        fence: createJobCommitFence({
          taskId: TASK_ID,
          jobRunId: JOB_RUN_ID,
          scheduledFor: NOW,
          taskRevision: 1,
          deliveryPlanDigest: jobDeliveryPlanDigest({ kind: "none" }),
          anchorEpoch: 4,
          assignmentId: ASSIGNMENT_ID,
          executorId: EXECUTOR_ID,
        }),
        outcome: { status: "completed", summary: "wrong fence" },
        contentAssets: [],
        streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      }),
    ).rejects.toThrow("does not match the durable dispatch");
  });
});

describe("job submission guard preflight", () => {
  it("rejects a user occurrence polluted by system activation in full and compact replay", async () => {
    const harness = await createUserHarness();
    const fence = {
      taskId: TASK_ID,
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      taskRevision: 1,
      anchorEpoch: 3,
      handler: "__journal-gc" as const,
      paramsDigest: systemJobParamsDigest({ retainDays: 30 }),
      reservationId: "system-reservation-1",
      attempt: 1,
    };
    await harness.log.append([
      resourceRecord("reserve", 1),
      {
        stream: `job:${TASK_ID}`,
        body: { t: "system-started" as const, jobRunId: JOB_RUN_ID, fence },
      },
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "state" as const,
          jobRunId: JOB_RUN_ID,
          state: "running" as const,
          statusRevision: 3,
        },
      },
    ]);
    await expect(reopenUserJournal(harness).currentState(JOB_RUN_ID)).rejects.toThrow(
      "System job fence",
    );
    const candidate = createJobSealedBundle({
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      dependencyArtifacts: [],
      body: {
        t: "job",
        jobRunId: JOB_RUN_ID,
        taskId: TASK_ID,
        fence: harness.unsigned.work.fence,
        outcome: { status: "completed", summary: "invalid replay probe" },
        contentAssets: [],
      },
    });
    await expect(
      reopenUserJournal(harness).submitBundle(
        candidate,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("System job fence");
  });

  it("stably rejects a historical assignment before dereferencing any bundle closure", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    const fence = await harness.journal.requestSupersede(ASSIGNMENT_ID, "guard-historical");
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    const bundle = createJobSealedBundle({
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      dependencyArtifacts: [],
      body: {
        t: "job",
        jobRunId: JOB_RUN_ID,
        taskId: TASK_ID,
        fence: harness.unsigned.work.fence,
        outcome: { status: "completed", summary: "late" },
        contentAssets: [],
      },
    });
    const result = await harness.journal.submitBundle(
      bundle,
      submissionContext(harness.unsigned),
    );
    expect(result).toMatchObject({
      committed: false,
      error: {
        code: "fence-rejected",
        message: expect.stringContaining("historical"),
      },
    });
  });

  it("rejects an unactivated submission anchor epoch before consuming the bundle", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const context = submissionContext(harness.unsigned);
    if (context.principal.kind !== "assignment") {
      throw new Error("test fixture must use an assignment capability");
    }
    const activated = context.principal.capability;
    const stalePayload = { ...withoutSignature(activated), anchorEpoch: 4 };
    context.principal.capability = {
      ...stalePayload,
      signature: harness.identity.sign("AuthorityCapability", 1, stalePayload),
    } as AuthorityCapability<"job">;
    const bundle = await seal(harness);
    await expect(
      harness.journal.submitBundle(bundle, context),
    ).rejects.toThrow(
      "Assignment capability is not activated by durable authority state",
    );
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("running");
  });

  it("replays an exact committed bundle through a cold journal instance", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const bundle = await seal(harness);
    await submitExistingSeal(harness);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
    const cold = new JobJournal({
      taskId: TASK_ID,
      anchorEpoch: 3,
      log: harness.log,
      artifacts: harness.artifacts,
      signer: harness.identity,
      verifier: harness.identity,
      delivery: deliveryParticipant(harness.log),
      submission,
      snapshotFor: matchingSnapshotFor,
      ingress: {
        authorize() {},
      },
    });
    const replay = await cold.submitBundle(bundle, submissionContext(harness.unsigned));
    expect(replay).toMatchObject({ committed: true, commitRevision: 1 });
  });

  it.each(["wrong-bundle", "wrong-revision", "duplicate"] as const)(
    "rejects a %s bundle acknowledgement in full and compact replay",
    async (kind) => {
      const harness = await createUserHarness();
      await start(harness);
      const bundle = await seal(harness);
      const committed = await submitExistingSeal(harness);
      if (!committed.committed) throw new Error("test bundle did not commit");
      const bundleRef = sealedBundleArtifact(bundle).ref;
      const alternateBundleRef = await harness.artifacts.put(
        Buffer.from("alternate-bundle-ack", "utf8"),
      );
      const valid = {
        t: "bundle-ack-observed" as const,
        assignmentId: ASSIGNMENT_ID,
        bundleRef,
        jobRevision: committed.commitRevision,
      };
      const body =
        kind === "wrong-bundle"
          ? { ...valid, bundleRef: alternateBundleRef }
          : kind === "wrong-revision"
            ? { ...valid, jobRevision: committed.commitRevision + 1 }
            : valid;
      await harness.log.append(
        (kind === "duplicate" ? [body, body] : [body]).map((record) => ({
          stream: `job:${TASK_ID}`,
          body: record,
        })),
      );
      await expect(reopenUserJournal(harness).currentState(JOB_RUN_ID)).rejects.toThrow(
        "acknowledgement",
      );
      await expect(
        reopenUserJournal(harness).submitBundle(
          bundle,
          submissionContext(harness.unsigned),
        ),
      ).rejects.toThrow("acknowledgement");
    },
  );
});

async function finishedInteractionBatch(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
  requestId = "interaction-1",
) {
  await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
    requestId,
    toolName: "write",
    display: { title: "confirm", lines: ["write result"] },
    issuedAt: NOW,
    ttlMs: 60_000,
    expiresAt: "2026-07-15T09:01:00.000Z",
  });
  await harness.ledger.finishInteraction(ASSIGNMENT_ID, requestId, {
    t: "auto-resolved",
    decision: "denied",
    reason: "no-interactive-surface",
  });
  const batch = await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID);
  if (!batch) throw new Error("test interaction mirror is missing");
  return batch;
}

describe("job interaction mirror contract", () => {
  it("rejects a fresh mirror batch while uncertain without a durable cancel fence", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const batch = await finishedInteractionBatch(harness);
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        batch,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("mirror replay contract");
  });

  it("mirrors an audit batch under the durable cancel fence while cancel-requested", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const batch = await finishedInteractionBatch(harness);
    await requestOwnerCancellation(harness, "mirror-under-fence", false);
    const receipt = await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      batch,
      submissionContext(harness.unsigned),
    );
    expect(receipt.mirroredUpTo).toBe(batch.entries.at(-1)!.seq);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancel-requested");
  });

  it("rejects a mirror batch that repeats a durable request identity", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const first = await finishedInteractionBatch(harness);
    await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      first,
      submissionContext(harness.unsigned),
    );
    const last = first.entries.at(-1)!;
    const repeated = createSignedConversationInteractionMirrorBatch({
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      previousDigest: first.mirrorDigest,
      entries: [
        {
          ordinal: last.ordinal + 1,
          seq: last.seq + 1,
          requestId: last.requestId,
          kind: "allow-once",
          outcome: {
            t: "auto-resolved",
            decision: "denied",
            reason: "no-interactive-surface",
          },
          at: NOW,
        },
      ],
      signer: harness.identity,
    });
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        repeated,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("mirror replay contract");
  });
});

describe("job cancel proof durable replay", () => {
  it("replays an accepted cancel proof after the executor re-signs the same payload", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    await requestOwnerCancellation(harness, "replay-resign", true);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancelled");
    const durable = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!durable) throw new Error("test cancel proof is missing");
    const resigned = signCancelProof(withoutSignature(durable), harness.identity);
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        resigned,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toBeUndefined();
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancelled");
  });

  it("replays a contained halted proof and rejects a conflicting one", async () => {
    const harness = await createUserHarness();
    if (!harness.dispatch) throw new Error("test harness has no assignment");
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const conflict = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.recordDispatchConflict(harness.dispatch, conflict);
    await harness.ledger.start(ASSIGNMENT_ID);
    const [pending] = await harness.journal.pendingCancellations();
    if (!pending) throw new Error("conflict cancellation fence is missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await submissionAdapter(harness).submitCancellation(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    const durable = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!durable) throw new Error("contained cancel proof is missing");
    const resigned = signCancelProof(withoutSignature(durable), harness.identity);
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        resigned,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toBeUndefined();
    const conflicting = signCancelProof(
      { ...withoutSignature(durable), lastRecordSeq: durable.lastRecordSeq + 1 },
      harness.identity,
    );
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        conflicting,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("different durable termination proof");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("uncertain");
  });

  it("replays a rejected contradictory not-started proof and rejects a conflicting one", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const proof = contradictoryNotStartedProof(harness);
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("uncertain");
    const resigned = signCancelProof(withoutSignature(proof), harness.identity);
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        resigned,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toBeUndefined();
    const conflicting = signCancelProof(
      { ...withoutSignature(proof), lastRecordSeq: 3 },
      harness.identity,
    );
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        conflicting,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("different durable termination proof");
  });

  it("rejects a standalone not-started conflict containment during full replay", async () => {
    const harness = await createUserHarness();
    if (!harness.dispatch) throw new Error("test harness has no assignment");
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const conflict = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.recordDispatchConflict(harness.dispatch, conflict);
    const [pending] = await harness.journal.pendingCancellations();
    if (!pending) throw new Error("conflict cancellation fence is missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    const open = await harness.journal.currentResolution(JOB_RUN_ID);
    if (!proof || proof.decision !== "not-started" || !open) {
      throw new Error("not-started conflict fixture is incomplete");
    }
    await harness.log.append([
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "dispatch-conflict-contained" as const,
          assignmentId: ASSIGNMENT_ID,
          openFactDigest: open.openFactDigest,
          proof,
        },
      },
    ]);
    await expect(reopenUserJournal(harness).currentState(JOB_RUN_ID)).rejects.toThrow(
      "atomic closure",
    );
  });
});

describe("job abort ticket authorization", () => {
  it("rejects an abort-ticket proof whose ticket fails owner re-authorization", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    const forged = signCancelProof(
      {
        ...withoutSignature(contradictoryNotStartedProof(harness)),
        ticketDigest: `sha256:${"1".repeat(64)}`,
      },
      harness.identity,
    );
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        forged,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("abort ticket rejected");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("dispatched");
  });

  it("fails closed when abort-ticket validation is not configured", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    const unconfigured = new JobJournal({
      taskId: TASK_ID,
      anchorEpoch: 3,
      log: harness.log,
      artifacts: harness.artifacts,
      signer: harness.identity,
      verifier: harness.identity,
      delivery: deliveryParticipant(harness.log),
      submission,
      snapshotFor: matchingSnapshotFor,
      ingress: {
        authorize() {},
      },
    });
    await expect(
      unconfigured.submitCancelProof(
        ASSIGNMENT_ID,
        contradictoryNotStartedProof(harness),
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("Abort proof does not bind an owner-issued abort ticket");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("dispatched");
  });

  it("rejects an interaction mirror batch above the durable record limit", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const entries = Array.from({ length: 256 }, (_, index) => ({
      ordinal: index + 1,
      seq: index + 1,
      requestId: `request-${"x".repeat(300)}-${index}`,
      kind: "allow-once" as const,
      outcome: {
        t: "auto-resolved" as const,
        decision: "denied" as const,
        reason: "no-interactive-surface" as const,
      },
      at: NOW,
    }));
    const oversized = createSignedConversationInteractionMirrorBatch({
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      previousDigest: interactionMirrorSeed(ASSIGNMENT_ID),
      entries,
      signer: harness.identity,
    });
    await expect(
      harness.journal.mirrorInteractions(
        ASSIGNMENT_ID,
        oversized,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("durable record limit");
  });
});

async function exerciseUserJobRow(row: (typeof USER_JOB_ROWS)[number][0]) {
  switch (row) {
    case 1: {
      const harness = await createUserHarness({ assign: false });
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("queued");
    }
    case 2: {
      const harness = await createUserHarness();
      await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
      const occurrence = await harness.journal.trigger({
        jobRunId: "job-run-missed",
        scheduledFor: "2026-07-15T09:01:00.000Z",
        context: surfaceContext("row-2"),
        source: "user",
      });
      expect(occurrence.state).toBe("missed");
      return;
    }
    case 3: {
      const harness = await createUserHarness();
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("dispatched");
    }
    case 4:
    case 29: {
      const harness = await createUserHarness({ assign: false });
      expect(await harness.journal.pendingDispatches()).toEqual([]);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("queued");
    }
    case 5: {
      const harness = await createUserHarness({ assign: false });
      await harness.journal.failQueued(JOB_RUN_ID);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("failed");
    }
    case 6: {
      const harness = await createUserHarness({ assign: false });
      await harness.journal.define(userDefinition(2), surfaceContext("row-6-disable"));
      const disabled = userDefinition(3, "perform scheduled work", "disabled");
      await harness.journal.define(disabled, surfaceContext("row-6-disabled"));
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("cancelled");
    }
    case 7: {
      const harness = await createUserHarness({ assign: false });
      await harness.journal.cancel({
        jobRunId: JOB_RUN_ID,
        requestId: "row-7-cancel",
        context: surfaceContext("row-7"),
      });
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("cancelled");
    }
    case 8: {
      const harness = await createUserHarness({ assign: false });
      await harness.journal.expireQueued(JOB_RUN_ID);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("expired");
    }
    case 9: {
      const harness = await createUserHarness();
      await start(harness);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("running");
    }
    case 10: {
      const harness = await createUserHarness();
      await receive(harness);
      await harness.ledger.start(ASSIGNMENT_ID);
      await submitSealed(harness);
      await harness.journal.reportStarted(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      );
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("committed");
    }
    case 11: {
      const harness = await createUserHarness();
      await receive(harness);
      const fence = await harness.journal.requestSupersede(ASSIGNMENT_ID, "row-11");
      const proof = await harness.ledger.supersede(
        ASSIGNMENT_ID,
        fence,
        ownerContext(ASSIGNMENT_ID, "executor.supersede"),
      );
      await harness.journal.acceptSupersedeProof(proof);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("queued");
    }
    case 12: {
      const harness = await createUserHarness();
      await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("uncertain");
    }
    case 13: {
      const harness = await createUserHarness();
      await start(harness);
      await submitSealed(harness);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("committed");
    }
    case 14: {
      const harness = await createUserHarness();
      await start(harness);
      await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("uncertain");
    }
    case 15: {
      const harness = await createUserHarness();
      await requestOwnerCancellation(harness, "row-15", false);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("cancel-requested");
    }
    case 16: {
      const harness = await createUserHarness();
      await start(harness);
      await requestOwnerCancellation(harness, "row-16", false);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("cancel-requested");
    }
    case 17: {
      const harness = await createUserHarness();
      await receive(harness);
      await requestOwnerCancellation(harness, "row-17", true);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("cancelled");
    }
    case 18: {
      const harness = await createUserHarness();
      await receive(harness);
      await harness.ledger.start(ASSIGNMENT_ID);
      await requestOwnerCancellation(harness, "row-18", true);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("cancelled");
    }
    case 19: {
      const harness = await createUserHarness();
      await receive(harness);
      await requestOwnerCancellation(harness, "row-19", false);
      await submitSurfaceAbort(harness);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("cancelled");
    }
    case 20: {
      const harness = await createUserHarness();
      await receive(harness);
      await harness.ledger.start(ASSIGNMENT_ID);
      await requestOwnerCancellation(harness, "row-20", false);
      await submitSurfaceAbort(harness);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("cancelled");
    }
    case 21: {
      const harness = await createUserHarness();
      await receive(harness);
      await harness.ledger.start(ASSIGNMENT_ID);
      await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
        kind: "external-call",
        toolName: "notify",
        summary: "pending external effect",
        target: "external-service",
      });
      await requestOwnerCancellation(harness, "row-21", false);
      await harness.ledger.abortFromSurface(ASSIGNMENT_ID, surfaceAbortInput());
      await reconcileOpenAbort(harness);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("uncertain");
    }
    case 22: {
      const harness = await createUserHarness();
      await receive(harness);
      await harness.ledger.start(ASSIGNMENT_ID);
      await seal(harness);
      await requestOwnerCancellation(harness, "row-22", false);
      await submitExistingSeal(harness);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("committed");
    }
    case 23: {
      const harness = await createUserHarness();
      await requestOwnerCancellation(harness, "row-23", false);
      await harness.journal.markUncertain(ASSIGNMENT_ID, "job-cancel-unknown");
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("uncertain");
    }
    case 24: {
      const harness = await createUserHarness();
      await receive(harness);
      await harness.ledger.start(ASSIGNMENT_ID);
      await seal(harness);
      await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
      await submitExistingSeal(harness);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("committed");
    }
    case 25: {
      const harness = await createUserHarness();
      await receive(harness);
      const fence = await harness.journal.requestSupersede(ASSIGNMENT_ID, "row-25");
      await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
      const proof = await harness.ledger.supersede(
        ASSIGNMENT_ID,
        fence,
        ownerContext(ASSIGNMENT_ID, "executor.supersede"),
      );
      await harness.journal.acceptSupersedeProof(proof);
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("queued");
    }
    case 26:
    case 27:
    case 28: {
      const harness = await createUserHarness();
      await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
      const decision =
        row === 26
          ? "user-verified-side-effects"
          : row === 27
            ? "user-abandoned"
            : "user-retry-acknowledged";
      await resolve(harness, decision);
      const expected = row === 26 ? "failed" : row === 27 ? "cancelled" : "queued";
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe(expected);
    }
    case 30:
    case 31:
    case 32:
    case 33:
    case 35: {
      const harness = await createUserHarness();
      await receive(harness);
      if (row === 31 || row === 32) await harness.ledger.start(ASSIGNMENT_ID);
      if (row === 33 || row === 35) await startOwnerOnly(harness);
      if (row === 32 || row === 35) {
        await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
          kind: "external-call",
          toolName: "notify",
          summary: "pending recovery effect",
          target: "external-service",
        });
      }
      await harness.ledger.abortFromSurface(ASSIGNMENT_ID, surfaceAbortInput());
      await recoverAssignments(harness);
      const expected = row === 32 || row === 35 ? "uncertain" : "cancelled";
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe(expected);
    }
    case 34: {
      const harness = await createUserHarness();
      await start(harness);
      await harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        contradictoryNotStartedProof(harness),
        submissionContext(harness.unsigned),
      );
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("uncertain");
    }
    case 36: {
      const harness = await createUserHarness();
      await receive(harness);
      const alternative = createAlternativeDispatch(harness);
      const conflict = await harness.ledger.dispatch(
        alternative.envelope,
        alternative.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      );
      expect(await harness.journal.recordDispatchConflict(alternative, conflict)).toBe("acked-original");
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("dispatched");
    }
    case 37:
    case 38: {
      const harness = await createUserHarness();
      if (!harness.dispatch) throw new Error("test harness has no assignment");
      const alternative = createAlternativeDispatch(harness);
      await harness.ledger.dispatch(
        alternative.envelope,
        alternative.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      );
      const conflict = await harness.ledger.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      );
      expect(await harness.journal.recordDispatchConflict(harness.dispatch, conflict)).toBe(
        "opened-uncertain",
      );
      if (row === 38) {
        await harness.ledger.start(ASSIGNMENT_ID);
        const [pending] = await harness.journal.pendingCancellations();
        if (!pending) throw new Error("conflict cancellation fence is missing");
        await harness.ledger.cancel(
          ASSIGNMENT_ID,
          pending.fence,
          ownerContext(ASSIGNMENT_ID, "executor.cancel"),
        );
        await submissionAdapter(harness).submitCancellation(
          ASSIGNMENT_ID,
          submissionContext(harness.unsigned),
        );
        expect(await harness.journal.pendingCancellations()).toEqual([]);
      }
      return expect(harness.journal.currentState(JOB_RUN_ID)).resolves.toBe("uncertain");
    }
  }
}

async function exerciseSystemJobRow(row: (typeof SYSTEM_JOB_ROWS)[number][0]) {
  const harness = await createSystemHarness({
    fail: row === 4,
    crashAfterStart: row === 2 || row === 5,
  });
  await harness.journal.trigger({
    jobRunId: JOB_RUN_ID,
    scheduledFor: NOW,
    context: hostContext(`system-row-${row}-trigger`),
    source: "system",
  });
  if (row === 1) {
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("queued");
    const source = jobRunSource();
    const envelope = createJobControlEnvelope({
      requestId: "system-row-1-surface",
      source,
      at: NOW,
      body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
    });
    await expect(
      harness.journal.applyControl({ admission: harness.control, envelope, source }),
    ).resolves.toMatchObject({ result: { error: { code: "unauthorized" } } });
    return;
  }
  if (row === 6) {
    await harness.journal.define(systemDefinition(2, "disabled"), hostContext("system-row-6"));
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("cancelled");
    return;
  }
  if (row === 2 || row === 5) {
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext(`system-row-${row}-start`)),
    ).rejects.toThrow("simulated process loss");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("running");
    if (row === 2) return;
    harness.crashAfterStart.value = false;
    expect(await harness.journal.resumeSystemJobs(hostContext("system-row-5-recover"))).toBe(1);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
    return;
  }
  const outcome = await harness.journal.runSystem(
    JOB_RUN_ID,
    hostContext(`system-row-${row}-run`),
  );
  expect(outcome).toBe(row === 4 ? "failed" : "committed");
  expect(harness.terminalCalls).toBe(1);
}

async function createSystemHarness(
  options: {
    fail?: boolean;
    failureMessage?: string;
    handlerSummary?: unknown;
    crashAfterStart?: boolean;
    handlerGate?: Promise<void>;
    invalidAdmission?: boolean;
    deferFirstPrepare?: boolean;
    recovery?: "reuse" | "replace";
    invalidResourceBinding?: "activation" | "terminal";
  } = {},
) {
  const root = await createTempDir("system-job");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  });
  const identity = new TestProtocolIdentity();
  const crashAfterStart = { value: options.crashAfterStart ?? false };
  let prepareCalls = 0;
  let recoverCalls = 0;
  let terminalCalls = 0;
  let handlerCalls = 0;
  const resources: SystemJobResourceCoordinator = {
    async coordinate(operation) {
      return operation();
    },
    prepareQueuedTerminal({ workload, reason }) {
      return [queuedTerminalDequeueRecord(workload, reason)];
    },
    async prepare(input) {
      prepareCalls += 1;
      if (options.deferFirstPrepare && prepareCalls === 1) {
        throw new Error("resource admission deferred");
      }
      const lease = systemLease(identity, input.attempt);
      return {
        lease: options.invalidAdmission
          ? mutateSystemLease(
              identity,
              (payload) => {
                payload.admissionClass = "interactive";
              },
              input.attempt,
            )
          : lease,
        records: [
          resourceRecord(
            "reserve",
            input.attempt,
            options.invalidResourceBinding === "activation"
              ? "wrong-reservation"
              : undefined,
          ),
        ],
      };
    },
    async recover({ fence }) {
      recoverCalls += 1;
      if (options.recovery === "reuse") {
        return {
          kind: "reuse" as const,
          lease: systemLease(identity, fence.attempt),
        };
      }
      const attempt = fence.attempt + 1;
      return {
        kind: "replace" as const,
        lease: systemLease(identity, attempt),
        records: [
          resourceRecord("reclaim", fence.attempt),
          resourceRecord("reserve", attempt),
        ],
      };
    },
    terminal({ outcome, lease }) {
      terminalCalls += 1;
      if (crashAfterStart.value) throw new Error("simulated process loss");
      const reservationId =
        options.invalidResourceBinding === "terminal"
          ? "wrong-reservation"
          : undefined;
      return [
        resourceRecord("settle", lease.workload.attempt, reservationId, outcome),
        resourceRecord("release", lease.workload.attempt, reservationId, outcome),
      ];
    },
    preflightActivationRecords(input) {
      resources.assertActivationRecords(input);
    },
    preflightTerminalRecords(input) {
      resources.assertTerminalRecords(input);
    },
    assertActivationRecords({ previousFence, fence, records }) {
      const expected = previousFence
        ? [
            resourceRecord(
              "reclaim",
              previousFence.attempt,
              previousFence.reservationId,
            ),
            resourceRecord("reserve", fence.attempt, fence.reservationId),
          ]
        : [resourceRecord("reserve", fence.attempt, fence.reservationId)];
      if (canonicalize(records) !== canonicalize(expected)) {
        throw new Error("system activation resource records do not bind the durable fences");
      }
    },
    assertTerminalRecords({ fence, outcome, records }) {
      const expected = [
        resourceRecord("settle", fence.attempt, fence.reservationId, outcome),
        resourceRecord("release", fence.attempt, fence.reservationId, outcome),
      ];
      if (canonicalize(records) !== canonicalize(expected)) {
        throw new Error("system terminal resource records do not bind the durable outcome");
      }
    },
  };
  const handler = (async () => {
    handlerCalls += 1;
    if (options.handlerGate) await options.handlerGate;
    if (options.fail) throw new Error(options.failureMessage ?? "handler failed");
    return { summary: options.handlerSummary ?? "collected" };
  }) as unknown as SystemJobHandler;
  const systemHandlers = new Map([
    [
      "__journal-gc" as const,
      handler,
    ],
  ]);
  const createJournal = (
    journalOptions: { readonly omitSystemResources?: boolean } = {},
  ) => new JobJournal({
      taskId: TASK_ID,
      anchorEpoch: 3,
      log,
      artifacts,
      signer: identity,
      verifier: identity,
      delivery: deliveryParticipant(log),
      submission,
      snapshotFor: matchingSnapshotFor,
      ingress: {
        authorize(context) {
          if (context.principal.kind !== "host") throw new Error("system host required");
        },
      },
      ...(journalOptions.omitSystemResources ? {} : { systemResources: resources }),
      systemHandlers,
      clock: () => NOW,
    });
  const journal = createJournal();
  await journal.define(systemDefinition(), hostContext("define-system"));
  return {
    root,
    artifacts,
    log,
    identity,
    journal,
    createJournal,
    control: new ControlAdmissionJournal(log, artifacts),
    crashAfterStart,
    get prepareCalls() {
      return prepareCalls;
    },
    get recoverCalls() {
      return recoverCalls;
    },
    get terminalCalls() {
      return terminalCalls;
    },
    get handlerCalls() {
      return handlerCalls;
    },
  };
}

function createUnsignedJob(
  identity: TestProtocolIdentity,
  ids: {
    assignmentId?: string;
    jobRunId?: string;
    reservationId?: string;
    capabilityId?: string;
    issuedAt?: string;
    delivery?: TaskDeliveryDto;
  } = {},
): UnsignedJobEnvelope {
  const assignmentId = ids.assignmentId ?? ASSIGNMENT_ID;
  const jobRunId = ids.jobRunId ?? JOB_RUN_ID;
  const issuedAt = ids.issuedAt ?? NOW;
  const manifestPayload = {
    v: 1 as const,
    baseRef: {
      execution: "job" as const,
      taskId: TASK_ID,
      jobRunId,
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
  const manifest = {
    ...manifestPayload,
    digest: protocolDigest("ExecutionManifest", 1, manifestPayload),
  };
  const controlPayload = {
    v: 1 as const,
    controlLeaseId: "control-lease-1",
    assignmentId,
    authority: {
      execution: "job" as const,
      taskId: TASK_ID,
      anchorEpoch: 3,
    },
    renewalSeq: 1,
    issuedAt,
    expiry: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
  };
  const controlLease = {
    ...controlPayload,
    signature: identity.sign("ControlLease", 1, controlPayload),
  };
  const permissionPayload = {
    v: 1 as const,
    snapshotVersion: 1,
    snapshotDigest: createSignedTrustRuleSnapshot(
      { snapshotVersion: 1, rules: [], generatedAt: NOW },
      identity,
    ).digest,
    binding: {
      execution: "job" as const,
      jobRunId,
      taskId: TASK_ID,
      anchorEpoch: 3,
    },
    assignmentId,
    executorId: EXECUTOR_ID,
    controlLeaseId: "control-lease-1",
    issuedAt,
    expiry: EXPIRY,
  };
  const permissionLease: PermissionSnapshotLease<"job"> = {
    ...permissionPayload,
    signature: identity.sign("PermissionSnapshotLease", 1, permissionPayload),
  };
  const capabilityPayload = {
    v: 1 as const,
    capId: ids.capabilityId ?? "capability-1",
    executorId: EXECUTOR_ID,
    scope: { execution: "job" as const, taskId: TASK_ID },
    anchorEpoch: 3,
    methods: [
      "submission.mirrorInteractions",
      "submission.reportStarted",
      "submission.submitBundle",
      "submission.submitCancelProof",
    ] as AuthorityCapability<"job">["methods"],
    resources: [`task:${TASK_ID}`] as AuthorityCapability<"job">["resources"],
    assignmentId,
    issuedAt,
    expiry: EXPIRY,
  };
  const capability: AuthorityCapability<"job"> = {
    ...capabilityPayload,
    signature: identity.sign("AuthorityCapability", 1, capabilityPayload),
  };
  const leasePayload = {
    v: 1 as const,
    reservationId: ids.reservationId ?? "reservation-1",
    admissionClass: "scheduler" as const,
    workload: { kind: "job" as const, id: jobRunId, attempt: 1 },
    scopeBinding: { kind: "job" as const, taskId: TASK_ID, anchorEpoch: 3 },
    audience: { executorId: EXECUTOR_ID },
    budget: { maxCalls: 20, maxTokens: 10_000 },
    domain: { kind: "anchor" as const, anchorEpoch: 3 },
    activation: { kind: "assignment" as const, assignmentId },
    issuedAt,
    expiry: EXPIRY,
  };
  const leaseWithDigest = {
    ...leasePayload,
    digest: protocolDigest("ResourceLease", 1, leasePayload),
  };
  const resourceLease = {
    ...leaseWithDigest,
    signature: identity.sign("ResourceLease", 1, leaseWithDigest),
  };
  const fence = createJobCommitFence({
    taskId: TASK_ID,
    jobRunId,
    scheduledFor: NOW,
    taskRevision: 1,
    deliveryPlanDigest: jobDeliveryPlanDigest(ids.delivery ?? { kind: "none" }),
    anchorEpoch: 3,
    assignmentId,
    executorId: EXECUTOR_ID,
  });
  return {
    v: 1,
    execution: "job",
    assignmentId,
    executorId: EXECUTOR_ID,
    manifest,
    controlLease,
    permissionLease,
    capabilities: [capability],
    resourceLease,
    dependencyArtifacts: [],
    issuedAt,
    work: {
      t: "job",
      jobRunId,
      taskId: TASK_ID,
      fence,
      instruction: { kind: "agent-turn", prompt: "perform scheduled work" },
    },
  };
}

function createAlternativeDispatch(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
) {
  if (!harness.dispatch) throw new Error("test harness has no assignment");
  const envelope = createSignedJobEnvelope(
    { ...harness.unsigned, issuedAt: "2026-07-15T09:00:01.000Z" },
    harness.identity,
    harness.identity,
  );
  const activationPayload = buildJobActivationPayload({
    envelope,
    dispatchRef: dispatchEnvelopeArtifact(envelope).ref,
    commit: harness.dispatch.activation.commit,
    issuedAt: harness.dispatch.activation.issuedAt,
  });
  return {
    assignmentId: ASSIGNMENT_ID,
    envelope,
    activation: signJobActivation(activationPayload, harness.identity),
  };
}

function submissionAdapter(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
) {
  return new InProcessAssignmentSubmission({
    ledger: harness.ledger,
    owner: harness.journal,
  });
}

async function submitExistingSeal(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
) {
  return submissionAdapter(harness).submitSealedBundle(
    ASSIGNMENT_ID,
    submissionContext(harness.unsigned),
  );
}

async function submitSealed(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
) {
  await seal(harness);
  return submitExistingSeal(harness);
}

async function requestOwnerCancellation(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
  requestId: string,
  submitProof: boolean,
) {
  const result = await harness.journal.cancel({
    jobRunId: JOB_RUN_ID,
    requestId,
    context: surfaceContext(`${requestId}-surface`),
  });
  if (result.state !== "cancel-requested") return result;
  await harness.ledger.cancel(
    ASSIGNMENT_ID,
    result.fence,
    ownerContext(ASSIGNMENT_ID, "executor.cancel"),
  );
  if (submitProof) {
    await submissionAdapter(harness).submitCancellation(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
  }
  return result;
}

function surfaceAbortInput() {
  return {
    ticketDigest: ABORT_TICKET_DIGEST,
    surfacePrincipal: "surface:user-1",
  } as const;
}

async function submitSurfaceAbort(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
) {
  return submissionAdapter(harness).abortFromSurfaceAndSubmit(
    ASSIGNMENT_ID,
    surfaceAbortInput(),
    submissionContext(harness.unsigned),
  );
}

async function reconcileOpenAbort(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
) {
  const raw = await harness.ledger.queryLedger(
    ASSIGNMENT_ID,
    ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
  );
  if ("fromSeq" in raw) throw new Error("expected a ledger snapshot");
  const ledger: LedgerSnapshot = raw;
  async function* pages(): AsyncIterable<LedgerEvidencePage> {
    let fromSeq = 1;
    while (fromSeq <= ledger.lastSeq) {
      const page = await harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
        { fromSeq, limit: 256 },
      );
      if (!("fromSeq" in page)) throw new Error("expected a ledger evidence page");
      yield page;
      fromSeq = page.toSeq + 1;
    }
  }
  return harness.journal.reconcileCancellationEvidence(
    ASSIGNMENT_ID,
    ledger,
    pages(),
  );
}

async function recoverAssignments(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
  observe: {
    readonly onQuery?: () => void;
    readonly onSubmit?: () => void;
  } = {},
  journal = harness.journal,
) {
  const adapter = new InProcessAssignmentSubmission({
    ledger: harness.ledger,
    owner: journal,
  });
  const executor = new Proxy(harness.ledger, {
    get(target, property, receiver) {
      if (property === "queryLedger") {
        return (...args: Parameters<typeof target.queryLedger>) => {
          observe.onQuery?.();
          return target.queryLedger(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const dispatcher = new InProcessJobDispatcher({
    enabled: true,
    journal,
    executor,
    contexts: { create: ownerContext },
    cancellationSubmission: {
      submitCancellation(assignmentId) {
        return adapter.submitCancellation(
          assignmentId,
          submissionContext(harness.unsigned),
        );
      },
    },
    bundleSubmission: {
      submitSealedBundle(assignmentId) {
        observe.onSubmit?.();
        return adapter.submitSealedBundle(
          assignmentId,
          submissionContext(harness.unsigned),
        );
      },
    },
  });
  return dispatcher.recoverAssignments();
}

async function startOwnerOnly(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
) {
  await harness.ledger.start(ASSIGNMENT_ID);
  await harness.journal.reportStarted(
    ASSIGNMENT_ID,
    submissionContext(harness.unsigned),
  );
}

function contradictoryNotStartedProof(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
) {
  return signCancelProof(
    {
      v: 1,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      authority: { execution: "job", taskId: TASK_ID, anchorEpoch: 3 },
      lastRecordSeq: 2,
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      ledgerDigest: SHA256_ZERO,
      issuedAt: NOW,
      cause: "abort-ticket",
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
      decision: "not-started",
    },
    harness.identity,
  );
}

function ownerContext(
  assignmentId: string,
  method:
    | "executor.dispatch"
    | "executor.cancel"
    | "executor.supersede"
    | "executor.queryLedger",
  request: { readonly requestId: string; readonly body: unknown } = {
    requestId: `request-${method}-${assignmentId}`,
    body: {},
  },
  scope: { readonly execution: "job"; readonly taskId: string; readonly anchorEpoch: number } = {
    execution: "job",
    taskId: TASK_ID,
    anchorEpoch: 3,
  },
): AuthorityCallContext {
  const controlPayload = {
    v: 1 as const,
    controlLeaseId: "control-lease-1",
    assignmentId,
    authority: scope,
    renewalSeq: 1,
    issuedAt: NOW,
    expiry: CONTROL_EXPIRY,
  };
  const controlLease = {
    ...controlPayload,
    signature: new TestProtocolIdentity().sign("ControlLease", 1, controlPayload),
  };
  const requestId = request.requestId;
  return {
    principal: {
      kind: "owner-control",
      grant: {
        v: 1,
        assignmentId,
        scope,
        methods: [method],
        callerDeviceId: "test-owner",
        requestId,
        requestDigest: ownerControlRequestDigest({
          method,
          assignmentId,
          authority: scope,
          requestId,
          body: request.body,
        }),
        controlLease,
        issuedAt: NOW,
        expiry: CONTROL_EXPIRY,
        signature: { alg: "test", keyId: "test-owner", sig: "context" },
      },
    },
    requestId,
    deadlineAt: CONTROL_EXPIRY,
  };
}

function submissionContext(envelope: UnsignedJobEnvelope): AuthorityCallContext {
  return {
    principal: { kind: "assignment", capability: envelope.capabilities[0]! },
    requestId: "job-submission",
    deadlineAt: EXPIRY,
  };
}

function surfaceContext(requestId: string): AuthorityCallContext {
  return {
    principal: {
      kind: "surface",
      surfacePrincipal: "surface:user-1",
      connectionId: "connection-1",
    },
    requestId,
    deadlineAt: EXPIRY,
  };
}

function hostContext(requestId: string): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "scheduler-anchor" },
    requestId,
    deadlineAt: EXPIRY,
  };
}

function trustedSource() {
  return {
    principal: {
      surfacePrincipal: "surface:user-1",
      deviceId: "device-1",
      connectionId: "connection-1",
    },
  };
}

function jobRunSource(
  receivedAt = NOW,
  ingressId = "manual-job-run",
) {
  return {
    ...trustedSource(),
    ingress: {
      kind: "first-party" as const,
      surfacePrincipal: "surface:user-1",
      deviceId: "device-1",
      ingressId,
      receivedAt,
    },
  };
}

function systemLease(
  identity: TestProtocolIdentity,
  attempt: number,
): SystemJobResourceLease {
  const payload = {
    v: 1 as const,
    reservationId: `system-reservation-${attempt}`,
    admissionClass: "scheduler" as const,
    workload: { kind: "job" as const, id: JOB_RUN_ID, attempt },
    scopeBinding: { kind: "job" as const, taskId: TASK_ID, anchorEpoch: 3 },
    audience: { executorId: EXECUTOR_ID },
    budget: { maxCalls: 1 },
    domain: { kind: "anchor" as const, anchorEpoch: 3 },
    activation: { kind: "system-job" as const, jobRunId: JOB_RUN_ID },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: identity.sign("ResourceLease", 1, withDigest),
  };
}

function mutateSystemLease(
  identity: TestProtocolIdentity,
  mutate: (payload: Record<string, unknown>) => void,
  attempt = 1,
): SystemJobResourceLease {
  const lease = systemLease(identity, attempt);
  const payload = structuredClone(lease) as unknown as Record<string, unknown>;
  delete payload.digest;
  delete payload.signature;
  mutate(payload);
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: identity.sign("ResourceLease", 1, withDigest),
  } as unknown as SystemJobResourceLease;
}

function resourceRecord(
  action: "reserve" | "reclaim" | "settle" | "release",
  attempt: number,
  reservationId = `system-reservation-${attempt}`,
  outcome?: "committed" | "failed",
): LogicalRecord {
  return {
    stream: "governor",
    body: {
      v: 1,
      t: "system-job-resource",
      action,
      taskId: TASK_ID,
      jobRunId: JOB_RUN_ID,
      attempt,
      reservationId,
      ...(outcome ? { outcome } : {}),
    },
  };
}

function withoutSignature<T extends { signature: unknown }>(value: T): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return payload;
}

function jobWithLease(
  identity: TestProtocolIdentity,
  mutate: (payload: Record<string, unknown>) => void,
): UnsignedJobEnvelope {
  const unsigned = createUnsignedJob(identity);
  const { digest: _digest, signature: _signature, ...payload } =
    unsigned.resourceLease as unknown as Record<string, unknown> & {
      digest: unknown;
      signature: unknown;
    };
  mutate(payload);
  const withDigest = { ...payload, digest: protocolDigest("ResourceLease", 1, payload) };
  const resourceLease = {
    ...withDigest,
    signature: identity.sign("ResourceLease", 1, withDigest),
  } as UnsignedJobEnvelope["resourceLease"];
  return { ...unsigned, resourceLease };
}

function rogueLedger(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
): ConversationAssignmentLedger {
  return new ConversationAssignmentLedger({
    log: new FileAuthorityCommitLog(
      path.join(harness.root, "rogue-ledger"),
      harness.artifacts,
      { clock: () => NOW, lockWaitMs: 2_000 },
    ),
    artifacts: harness.artifacts,
    executorId: EXECUTOR_ID,
    signer: harness.identity,
    verifier: harness.identity,
    ownerControl,
    snapshotFor: matchingSnapshotFor,
    permissionSnapshotFor: (digest) =>
      matchingPermissionSnapshotFor(harness.identity, digest),
    clock: () => NOW,
  });
}

function reopenAssignmentLedger(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
): ConversationAssignmentLedger {
  return new ConversationAssignmentLedger({
    log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
      clock: () => NOW,
      lockWaitMs: 2_000,
    }),
    artifacts: harness.artifacts,
    executorId: EXECUTOR_ID,
    signer: harness.identity,
    verifier: harness.identity,
    ownerControl,
    snapshotFor: matchingSnapshotFor,
    permissionSnapshotFor: (digest) =>
      matchingPermissionSnapshotFor(harness.identity, digest),
    clock: () => NOW,
  });
}

describe("task deletion stops uncertain occupancy", () => {
  it("establishes a durable cancel fence when deleting a task whose occurrence is uncertain", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await harness.journal.define(
      userDefinition(2, "perform scheduled work", "deleted"),
      surfaceContext("delete-uncertain"),
    );
    const pending = await harness.journal.pendingCancellations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.assignmentId).toBe(ASSIGNMENT_ID);
    expect(pending[0]?.fence.requestId).toBe("task-revision:2");
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("uncertain");
    const open = await harness.journal.currentResolution(JOB_RUN_ID);
    expect(open?.resolution).toBeUndefined();
    await expect(reopenUserJournal(harness).currentState(JOB_RUN_ID)).resolves.toBe(
      "uncertain",
    );
  });

  it("idempotently reuses the existing cancel fence when deleting an uncertain occurrence", async () => {
    const harness = await createUserHarness();
    await start(harness);
    await harness.journal.cancel({
      jobRunId: JOB_RUN_ID,
      requestId: "cancel-before-delete",
      context: surfaceContext("cancel-before-delete"),
    });
    await harness.journal.markUncertain(ASSIGNMENT_ID, "job-cancel-unknown");
    await harness.journal.define(
      userDefinition(2, "perform scheduled work", "deleted"),
      surfaceContext("delete-after-cancel"),
    );
    const pending = await harness.journal.pendingCancellations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.fence.requestId).toBe("cancel-before-delete");
  });

  it("rejects a raw deleted revision that leaves an uncertain occurrence unfenced", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await appendRawTaskRevision(
      harness,
      userDefinition(2, "perform scheduled work", "deleted"),
    );
    await expectTaskRevisionRejectedByFullAndGuard(harness);
  });

  it("still commits a legal bundle sealed before the deletion fence resolves", async () => {
    const harness = await createUserHarness();
    await start(harness);
    const bundle = await seal(harness);
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await harness.journal.define(
      userDefinition(2, "perform scheduled work", "deleted"),
      surfaceContext("delete-before-late-bundle"),
    );
    const submitted = await harness.journal.submitBundle(
      bundle,
      submissionContext(harness.unsigned),
    );
    expect(submitted.committed).toBe(true);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("committed");
  });
});

describe("contradictory proof kinds stop only their own recovery action", () => {
  it("stops the owner-fence cancel redrive and keeps other recovery duties", async () => {
    const harness = await createUserHarness();
    await start(harness);
    await harness.journal.cancel({
      jobRunId: JOB_RUN_ID,
      requestId: "cancel-owner-stop",
      context: surfaceContext("cancel-owner-stop"),
    });
    const [before] = await harness.journal.pendingCancellations();
    if (!before) throw new Error("cancel fence is missing");
    const payload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      authority: { execution: "job" as const, taskId: TASK_ID, anchorEpoch: 3 },
      lastRecordSeq: 2,
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
      ledgerDigest: SHA256_ZERO,
      issuedAt: NOW,
      cause: "owner-fence" as const,
      fence: before.fence,
      decision: "not-started" as const,
    };
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      signCancelProof(payload, harness.identity),
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
    await expect(reopenUserJournal(harness).pendingCancellations()).resolves.toEqual([]);
    const candidate = (await harness.journal.assignmentsAwaitingRecovery()).find(
      (entry) => entry.assignmentId === ASSIGNMENT_ID,
    );
    expect(candidate?.stoppedProofKinds).toEqual(["cancel-owner-fence"]);
  });

  it("stops the supersede redrive after its contradictory proof while cancel duties survive", async () => {
    const harness = await createUserHarness();
    await receive(harness);
    const fence = await harness.journal.requestSupersede(ASSIGNMENT_ID, "supersede-stop");
    expect(await harness.journal.pendingSupersedes()).toHaveLength(1);
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const proof = await rogueLedger(harness).supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
    await expect(reopenUserJournal(harness).pendingSupersedes()).resolves.toEqual([]);
  });

  it("keeps an abort-ticket rejection from silencing the owner-fence outbox", async () => {
    const harness = await createUserHarness();
    await start(harness);
    await harness.journal.cancel({
      jobRunId: JOB_RUN_ID,
      requestId: "owner-fence-survives",
      context: surfaceContext("owner-fence-survives"),
    });
    expect(await harness.journal.pendingCancellations()).toHaveLength(1);
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictoryNotStartedProof(harness),
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(JOB_RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toHaveLength(1);
    const candidate = (await harness.journal.assignmentsAwaitingRecovery()).find(
      (entry) => entry.assignmentId === ASSIGNMENT_ID,
    );
    expect(candidate?.stoppedProofKinds).toEqual(["cancel-abort-ticket"]);
  });

  it("stops the dispatch-rejection replay after contradictory rejection evidence", async () => {
    const harness = await createUserHarness();
    await start(harness);
    if (!harness.dispatch) throw new Error("test harness has no assignment");
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    const payload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      dispatchDigest: dispatchEnvelopeDigest(harness.dispatch.envelope),
      error: {
        code: "invalid" as const,
        message: "matrix rejection evidence",
        retryable: false,
      },
      lastRecordSeq: 1,
      ledgerDigest: SHA256_ZERO,
    };
    const proof = {
      ...payload,
      signature: harness.identity.sign("DispatchRejectionProof", 1, payload),
    };
    await harness.log.append([
      {
        stream: `job:${TASK_ID}`,
        body: { t: "not-started-rejected" as const, assignmentId: ASSIGNMENT_ID, proof },
      },
    ]);
    const journal = reopenUserJournal(harness);
    expect(await journal.currentState(JOB_RUN_ID)).toBe("uncertain");
    const candidate = (await journal.assignmentsAwaitingRecovery()).find(
      (entry) => entry.assignmentId === ASSIGNMENT_ID,
    );
    expect(candidate?.stoppedProofKinds).toEqual(["dispatch-rejection"]);
  });
});

describe("job resource lease domain closure", () => {
  it("rejects a validly signed local-domain lease on a job dispatch", () => {
    const identity = new TestProtocolIdentity();
    const envelope = jobWithLease(identity, (payload) => {
      payload.domain = {
        kind: "local",
        localDomainId: "local:device-1",
        localGovernorEpoch: 1,
      };
    });
    expect(() => createSignedJobEnvelope(envelope, identity, identity)).toThrow(
      "Job assignment resource root has an invalid contract combination",
    );
  });

  it("rejects an anchor domain whose epoch disagrees with the commit fence", () => {
    const identity = new TestProtocolIdentity();
    const envelope = jobWithLease(identity, (payload) => {
      payload.domain = { kind: "anchor", anchorEpoch: 2 };
    });
    expect(() => createSignedJobEnvelope(envelope, identity, identity)).toThrow(
      "Resource lease does not bind the dispatch",
    );
  });

  it("rejects a polluted, missing or unknown lease domain before any binding check", () => {
    const identity = new TestProtocolIdentity();
    const polluted = jobWithLease(identity, (payload) => {
      payload.domain = { kind: "anchor", anchorEpoch: 3, extra: true };
    });
    expect(() => createSignedJobEnvelope(polluted, identity, identity)).toThrow(
      "Resource lease domain",
    );
    const unknownKind = jobWithLease(identity, (payload) => {
      payload.domain = { kind: "galactic", anchorEpoch: 3 };
    });
    expect(() => createSignedJobEnvelope(unknownKind, identity, identity)).toThrow(
      "Resource lease domain kind is invalid",
    );
    const missing = jobWithLease(identity, (payload) => {
      delete payload.domain;
    });
    expect(() => createSignedJobEnvelope(missing, identity, identity)).toThrow(
      "Resource lease fields are incomplete or unknown",
    );
  });

  it("rejects out-of-union admission classes and negative budgets on the wire", () => {
    const identity = new TestProtocolIdentity();
    const admission = jobWithLease(identity, (payload) => {
      payload.admissionClass = "bogus";
    });
    expect(() => createSignedJobEnvelope(admission, identity, identity)).toThrow(
      "Resource lease admission class is invalid",
    );
    const budget = jobWithLease(identity, (payload) => {
      payload.budget = { maxCalls: -1 };
    });
    expect(() => createSignedJobEnvelope(budget, identity, identity)).toThrow(
      "Resource lease budget maxCalls",
    );
  });

  it("enforces the shared lease audience, budget, delegation and time-window contract", () => {
    const identity = new TestProtocolIdentity();
    const emptyAudience = jobWithLease(identity, (payload) => {
      payload.audience = {};
    });
    expect(() => createSignedJobEnvelope(emptyAudience, identity, identity)).toThrow(
      "Resource lease audience must bind at least one value",
    );

    const emptyBudget = jobWithLease(identity, (payload) => {
      payload.budget = {};
    });
    expect(() => createSignedJobEnvelope(emptyBudget, identity, identity)).toThrow(
      "Resource lease budget must contain at least one limit",
    );

    const emptyDelegationBudget = jobWithLease(identity, (payload) => {
      payload.delegation = {
        executorId: EXECUTOR_ID,
        maxDepth: 1,
        maxBudget: {},
      };
    });
    expect(() =>
      createSignedJobEnvelope(emptyDelegationBudget, identity, identity),
    ).toThrow("Resource lease delegation budget must contain at least one limit");

    const invalidWindow = jobWithLease(identity, (payload) => {
      payload.expiry = payload.issuedAt;
    });
    expect(() => createSignedJobEnvelope(invalidWindow, identity, identity)).toThrow(
      "Resource lease must expire after issuance",
    );
  });

  it("applies the same base contract to system leases and permits bounded root delegation", () => {
    const identity = new TestProtocolIdentity();
    const verifier = { verify: identity.verify.bind(identity) };

    const emptyAudience = mutateSystemLease(identity, (payload) => {
      payload.audience = {};
    });
    expect(() => validateSystemJobResourceLease(emptyAudience, verifier)).toThrow(
      "Resource lease audience must bind at least one value",
    );

    const emptyBudget = mutateSystemLease(identity, (payload) => {
      payload.budget = {};
    });
    expect(() => validateSystemJobResourceLease(emptyBudget, verifier)).toThrow(
      "Resource lease budget must contain at least one limit",
    );

    const invalidWindow = mutateSystemLease(identity, (payload) => {
      payload.expiry = payload.issuedAt;
    });
    expect(() => validateSystemJobResourceLease(invalidWindow, verifier)).toThrow(
      "Resource lease must expire after issuance",
    );

    const delegated = mutateSystemLease(identity, (payload) => {
      payload.delegation = {
        executorId: EXECUTOR_ID,
        maxDepth: 1,
        maxBudget: { maxCalls: 1 },
      };
    });
    expect(validateSystemJobResourceLease(delegated, verifier)).toEqual(delegated);
  });
});

type JobBehaviorScenarioId =
  | "commit"
  | "manualAdmission"
  | "mirror"
  | "conflictAcked"
  | "cancelHalted"
  | "cancelUncertainContained"
  | "supersedeStarted"
  | "supersedeNotStarted"
  | "conflictContained"
  | "uncertainRejected"
  | "system"
  | "systemMiss"
  | "ticketLifecycle";

interface JobBehaviorHarness {
  readonly log: FileAuthorityCommitLog;
  readonly fullProbe: () => Promise<unknown>;
  // system 域没有以本任务为界的提交入口(鉴权先于 guard 加载),guard 对
  // system 记录的行为由既有 raw 注入专项测试承载——事实化 N/A。
  readonly guardProbe?: () => Promise<unknown>;
}

function userBehaviorHarness(
  harness: Awaited<ReturnType<typeof createUserHarness>>,
): JobBehaviorHarness {
  return {
    log: harness.log,
    fullProbe: () => reopenUserJournal(harness).taskDefinition(),
    guardProbe: () =>
      reopenUserJournal(harness).reportStarted(
        ASSIGNMENT_ID,
        submissionContext(harness.unsigned),
      ),
  };
}

const JOB_BEHAVIOR_SCENARIOS: Record<
  JobBehaviorScenarioId,
  () => Promise<JobBehaviorHarness>
> = {
  async ticketLifecycle() {
    let nowMs = Date.parse(NOW);
    const clock = () => new Date(nowMs).toISOString();
    const harness = await createUserHarness({ assign: false, clock });
    await harness.journal.expireQueued(JOB_RUN_ID);
    const source = jobRunSource(NOW, "matrix-ticket-ingress");
    const outcome = await harness.journal.applyControl({
      admission: new ControlAdmissionJournal(harness.log, harness.artifacts),
      envelope: createJobControlEnvelope({
        requestId: "matrix-ticket-run",
        source,
        at: NOW,
        body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
      }),
      source,
    });
    const jobRunId =
      outcome.kind === "applied" && outcome.result.status === "ok"
        ? outcome.result.body.jobRunId
        : undefined;
    if (!jobRunId) throw new Error("matrix manual job-run result is missing");
    const unsigned = createUnsignedJob(harness.identity, { jobRunId });
    const dispatch = await harness.journal.assign(assignmentPlan(unsigned));
    await harness.ledger.dispatch(
      dispatch.envelope,
      dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    const ticket = await harness.journal.issueDataPlaneTicket({
      ticketId: "matrix-job-observer-ticket",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:observer-1",
      kind: "run-observe",
      ttlMs: 60_000,
    });
    await harness.journal.revokeDataPlaneTicket(ticket.ticketId);
    nowMs += 4 * 60 * 1_000;
    await harness.journal.dataPlaneTicketFacts();
    return {
      log: harness.log,
      fullProbe: () =>
        reopenUserJournal(harness, harness.artifacts, clock).taskDefinition(),
      guardProbe: () =>
        reopenUserJournal(harness, harness.artifacts, clock).reportStarted(
          ASSIGNMENT_ID,
          submissionContext(unsigned),
        ),
    };
  },
  async commit() {
    const harness = await createUserHarness();
    await start(harness);
    await seal(harness);
    await submissionAdapter(harness).submitSealedBundle(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await recoverAssignments(harness);
    return userBehaviorHarness(harness);
  },
  async conflictAcked() {
    const harness = await createUserHarness();
    await receive(harness);
    if (!harness.dispatch) throw new Error("matrix harness has no assignment");
    const alternative = createAlternativeDispatch(harness);
    const conflict = await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.recordDispatchConflict(alternative, conflict);
    return userBehaviorHarness(harness);
  },
  async mirror() {
    const harness = await createUserHarness();
    await start(harness);
    const requestId = "matrix-interaction";
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId,
      toolName: "write",
      display: { title: "confirm", lines: ["write result"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-15T09:01:00.000Z",
    });
    await harness.ledger.finishInteraction(ASSIGNMENT_ID, requestId, {
      t: "auto-resolved",
      decision: "denied",
      reason: "no-interactive-surface",
    });
    const batch = await harness.ledger.pendingInteractionMirrorBatch(ASSIGNMENT_ID);
    if (!batch) throw new Error("matrix interaction mirror is missing");
    await harness.journal.mirrorInteractions(
      ASSIGNMENT_ID,
      batch,
      submissionContext(harness.unsigned),
    );
    return userBehaviorHarness(harness);
  },
  async manualAdmission() {
    const harness = await createUserHarness({ assign: false });
    await harness.journal.expireQueued(JOB_RUN_ID);
    const source = jobRunSource();
    const envelope = createJobControlEnvelope({
      requestId: "matrix-manual-run",
      source,
      at: NOW,
      body: { t: "job-run", taskId: TASK_ID, anchorEpoch: 3 },
    });
    await harness.journal.applyControl({
      admission: new ControlAdmissionJournal(harness.log, harness.artifacts),
      envelope,
      source,
    });
    return userBehaviorHarness(harness);
  },
  async cancelHalted() {
    const harness = await createUserHarness();
    await start(harness);
    await requestOwnerCancellation(harness, "matrix-cancel-halted", true);
    return userBehaviorHarness(harness);
  },
  async cancelUncertainContained() {
    const harness = await createUserHarness();
    await start(harness);
    const result = await harness.journal.cancel({
      jobRunId: JOB_RUN_ID,
      requestId: "matrix-cancel-contained",
      context: surfaceContext("matrix-cancel-contained"),
    });
    if (result.state !== "cancel-requested") throw new Error("cancel did not fence");
    await harness.journal.markUncertain(ASSIGNMENT_ID, "job-cancel-unknown");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      result.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await submissionAdapter(harness).submitCancellation(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    return userBehaviorHarness(harness);
  },
  async supersedeStarted() {
    const harness = await createUserHarness();
    await receive(harness);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "matrix-supersede-started",
    );
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await harness.ledger.start(ASSIGNMENT_ID);
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    return userBehaviorHarness(harness);
  },
  async supersedeNotStarted() {
    const harness = await createUserHarness();
    await receive(harness);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "matrix-supersede-fresh",
    );
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    return userBehaviorHarness(harness);
  },
  async conflictContained() {
    const harness = await createUserHarness();
    if (!harness.dispatch) throw new Error("matrix harness has no assignment");
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const conflict = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.recordDispatchConflict(harness.dispatch, conflict);
    await harness.ledger.start(ASSIGNMENT_ID);
    const [pending] = await harness.journal.pendingCancellations();
    if (!pending) throw new Error("matrix conflict fence is missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await submissionAdapter(harness).submitCancellation(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    return userBehaviorHarness(harness);
  },
  async uncertainRejected() {
    const harness = await createUserHarness();
    await start(harness);
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictoryNotStartedProof(harness),
      submissionContext(harness.unsigned),
    );
    return userBehaviorHarness(harness);
  },
  async system() {
    const harness = await createSystemHarness();
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("matrix-system-trigger"),
      source: "system",
    });
    await harness.journal.runSystem(JOB_RUN_ID, hostContext("matrix-system-run"));
    return {
      log: harness.log,
      fullProbe: () => harness.createJournal().taskDefinition(),
    };
  },
  async systemMiss() {
    const harness = await createSystemHarness({ crashAfterStart: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("matrix-miss-trigger"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("matrix-miss-run")),
    ).rejects.toThrow("simulated process loss");
    await harness.journal.trigger({
      jobRunId: "system-miss-matrix",
      scheduledFor: "2026-07-15T09:01:00.000Z",
      context: hostContext("matrix-miss-second"),
      source: "system",
    });
    await harness.journal.trigger({
      jobRunId: "system-miss-matrix-2",
      scheduledFor: "2026-07-15T09:02:00.000Z",
      context: hostContext("matrix-miss-third"),
      source: "system",
    });
    return {
      log: harness.log,
      fullProbe: () => harness.createJournal().taskDefinition(),
    };
  },
};

const JOB_RECOVERY_PROBES = {
  async dispatchOutbox() {
    const harness = await createUserHarness();
    expect(await harness.journal.pendingDispatches()).toHaveLength(1);
    await start(harness);
    await expect(reopenUserJournal(harness).pendingDispatches()).resolves.toEqual([]);
  },
  async cancellationOutbox() {
    const harness = await createUserHarness();
    await start(harness);
    await requestOwnerCancellation(harness, "matrix-recovery-cancel", false);
    expect(await harness.journal.pendingCancellations()).toHaveLength(1);
    await submissionAdapter(harness).submitCancellation(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await expect(reopenUserJournal(harness).pendingCancellations()).resolves.toEqual([]);
  },
  async conflictCancellation() {
    const harness = await createUserHarness();
    if (!harness.dispatch) throw new Error("matrix recovery harness has no assignment");
    const alternative = createAlternativeDispatch(harness);
    await harness.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const conflict = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.recordDispatchConflict(harness.dispatch, conflict);
    const [pending] = await harness.journal.pendingCancellations();
    if (!pending) throw new Error("matrix conflict cancellation is missing");
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      pending.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await submissionAdapter(harness).submitCancellation(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await expect(reopenUserJournal(harness).pendingCancellations()).resolves.toEqual([]);
  },
  async supersedeOutbox() {
    const harness = await createUserHarness();
    await receive(harness);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "matrix-recovery-supersede",
    );
    expect(await harness.journal.pendingSupersedes()).toHaveLength(1);
    await harness.journal.markUncertain(ASSIGNMENT_ID, "ledger-unknown");
    await harness.ledger.start(ASSIGNMENT_ID);
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await harness.journal.acceptSupersedeProof(proof);
    await expect(reopenUserJournal(harness).pendingSupersedes()).resolves.toEqual([]);
  },
  async bundleAcknowledgementOutbox() {
    const harness = await createUserHarness();
    await start(harness);
    await seal(harness);
    await submissionAdapter(harness).submitSealedBundle(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    expect(
      (await harness.journal.assignmentsAwaitingRecovery()).some(
        (candidate) => candidate.assignmentId === ASSIGNMENT_ID,
      ),
    ).toBe(true);
    await recoverAssignments(harness);
    expect(
      (await reopenUserJournal(harness).assignmentsAwaitingRecovery()).some(
        (candidate) => candidate.assignmentId === ASSIGNMENT_ID,
      ),
    ).toBe(false);
  },
  async contradictoryProofStop() {
    const harness = await createUserHarness();
    await start(harness);
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictoryNotStartedProof(harness),
      submissionContext(harness.unsigned),
    );
    const candidate = (await reopenUserJournal(harness).assignmentsAwaitingRecovery()).find(
      (entry) => entry.assignmentId === ASSIGNMENT_ID,
    );
    expect(candidate?.stoppedProofKinds).toContain("cancel-abort-ticket");
  },
  async systemRecovery() {
    const harness = await createSystemHarness({ crashAfterStart: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("matrix-recovery-system-trigger"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("matrix-recovery-system-run")),
    ).rejects.toThrow("simulated process loss");
    harness.crashAfterStart.value = false;
    await expect(
      harness.journal.resumeSystemJobs(hostContext("matrix-recovery-system-resume")),
    ).resolves.toBe(1);
    await expect(
      harness.journal.resumeSystemJobs(hostContext("matrix-recovery-system-done")),
    ).resolves.toBe(0);
  },
  async systemMissAlias() {
    const harness = await createSystemHarness({ crashAfterStart: true });
    await harness.journal.trigger({
      jobRunId: JOB_RUN_ID,
      scheduledFor: NOW,
      context: hostContext("matrix-recovery-miss-trigger"),
      source: "system",
    });
    await expect(
      harness.journal.runSystem(JOB_RUN_ID, hostContext("matrix-recovery-miss-run")),
    ).rejects.toThrow("simulated process loss");
    const first = await harness.journal.trigger({
      jobRunId: "matrix-recovery-miss-1",
      scheduledFor: "2026-07-15T09:01:00.000Z",
      context: hostContext("matrix-recovery-miss-1"),
      source: "system",
    });
    const second = await harness.journal.trigger({
      jobRunId: "matrix-recovery-miss-2",
      scheduledFor: "2026-07-15T09:02:00.000Z",
      context: hostContext("matrix-recovery-miss-2"),
      source: "system",
    });
    expect(second.jobRunId).toBe(first.jobRunId);
    await expect(
      harness.createJournal().trigger({
        jobRunId: "matrix-recovery-miss-2",
        scheduledFor: "2026-07-15T09:02:00.000Z",
        context: hostContext("matrix-recovery-miss-replay"),
        source: "system",
      }),
    ).resolves.toMatchObject({ jobRunId: first.jobRunId, state: "missed" });
  },
} as const;

type JobRecoveryProbeId = keyof typeof JOB_RECOVERY_PROBES;
type JobRecoveryExpectation =
  | { readonly kind: "probe"; readonly id: JobRecoveryProbeId }
  | { readonly kind: "not-applicable"; readonly reason: string };

const jobRecovery = (id: JobRecoveryProbeId): JobRecoveryExpectation => ({
  kind: "probe",
  id,
});

const noJobRecovery = (reason: string): JobRecoveryExpectation => ({
  kind: "not-applicable",
  reason,
});

// 每类记录绑定真实生产场景、恢复合同或事实化 N/A 与对抗向量。引擎执行
// 生产、full/guard 接受、真实恢复消费者和 corrupt 拒绝；新增记录或恢复合同
// 缺格由 satisfies/注册表对账失败。
interface JobRecordBehaviorSpec {
  readonly scenario: JobBehaviorScenarioId;
  readonly corrupt?: (body: Record<string, unknown>) => Record<string, unknown>;
  readonly recovery: JobRecoveryExpectation;
}

const CONFLICT_TIME = "2026-07-15T09:03:00.000Z";

const JOB_RECORD_BEHAVIOR = {
  "task-revision": {
    scenario: "commit",
    recovery: noJobRecovery("restart state is rebuilt by the full reducer itself"),
    corrupt: (body) => ({
      ...body,
      state: body.state === "enabled" ? "disabled" : "enabled",
      def: { ...(body.def as Record<string, unknown>), state: body.state === "enabled" ? "disabled" : "enabled" },
    }),
  },
  occurrence: {
    scenario: "commit",
    recovery: noJobRecovery("occurrence replay has no separate recovery outbox"),
    corrupt: (body) => ({
      ...body,
      occ: { ...(body.occ as Record<string, unknown>), scheduledFor: CONFLICT_TIME },
    }),
  },
  "system-miss-coalesced": {
    scenario: "systemMiss",
    recovery: jobRecovery("systemMissAlias"),
    corrupt: (body) => ({ ...body, scheduledFor: CONFLICT_TIME }),
  },
  admitted: {
    scenario: "manualAdmission",
    recovery: noJobRecovery("admission is consumed by normal state replay only"),
  },
  assigned: {
    scenario: "commit",
    recovery: jobRecovery("dispatchOutbox"),
    corrupt: (body) => ({ ...body, manifestDigest: SHA256_ZERO }),
  },
  "dispatch-acked": {
    scenario: "conflictAcked",
    recovery: jobRecovery("dispatchOutbox"),
    corrupt: (body) => ({ ...body, assignmentId: "assignment-ghost" }),
  },
  "dispatch-conflict": {
    scenario: "conflictContained",
    recovery: jobRecovery("conflictCancellation"),
  },
  "dispatch-conflict-contained": {
    scenario: "conflictContained",
    recovery: jobRecovery("conflictCancellation"),
  },
  "assignment-superseded": {
    scenario: "supersedeNotStarted",
    recovery: jobRecovery("supersedeOutbox"),
  },
  "supersede-requested": {
    scenario: "supersedeStarted",
    recovery: jobRecovery("supersedeOutbox"),
    corrupt: (body) => ({ ...body, requestId: "matrix-conflicting-supersede" }),
  },
  "supersede-started-observed": {
    scenario: "supersedeStarted",
    recovery: jobRecovery("supersedeOutbox"),
    corrupt: (body) => ({ ...body, assignmentId: "assignment-ghost" }),
  },
  "cancel-fence": {
    scenario: "cancelHalted",
    recovery: jobRecovery("cancellationOutbox"),
  },
  "cancel-contained": {
    scenario: "cancelUncertainContained",
    recovery: jobRecovery("cancellationOutbox"),
  },
  "cancel-proof-accepted": {
    scenario: "cancelHalted",
    recovery: jobRecovery("cancellationOutbox"),
  },
  "not-started-rejected": {
    scenario: "uncertainRejected",
    recovery: jobRecovery("contradictoryProofStop"),
  },
  "capability-revoked": {
    scenario: "commit",
    recovery: noJobRecovery("capability revocation is consumed by authorization guards"),
    corrupt: (body) => ({ ...body, capId: "capability-ghost" }),
  },
  "ticket-issued": {
    scenario: "ticketLifecycle",
    recovery: noJobRecovery("ticket delivery is driven by the owner ticket-fact synchronizer"),
  },
  "ticket-revoked": {
    scenario: "ticketLifecycle",
    recovery: noJobRecovery("ticket revocation is driven by the owner ticket-fact synchronizer"),
  },
  "ticket-sync-frontier": {
    scenario: "ticketLifecycle",
    recovery: noJobRecovery("ticket synchronization advances only when facts are queried"),
  },
  "interaction-mirror": {
    scenario: "mirror",
    recovery: noJobRecovery("mirrored interaction ordinals have no owner outbox"),
    corrupt: (body) => ({ ...body, assignmentId: "assignment-ghost" }),
  },
  state: { scenario: "commit", recovery: jobRecovery("dispatchOutbox") },
  committed: {
    scenario: "commit",
    recovery: jobRecovery("bundleAcknowledgementOutbox"),
  },
  "bundle-ack-observed": {
    scenario: "commit",
    recovery: jobRecovery("bundleAcknowledgementOutbox"),
  },
  resolution: {
    scenario: "uncertainRejected",
    recovery: noJobRecovery("resolution closes authority state without a separate outbox"),
  },
  "system-started": { scenario: "system", recovery: jobRecovery("systemRecovery") },
  "system-result": { scenario: "system", recovery: jobRecovery("systemRecovery") },
} as const satisfies Record<JobJournalRecordType, JobRecordBehaviorSpec>;

async function expectBehaviorRejected(probe: () => Promise<unknown>): Promise<void> {
  try {
    await probe();
  } catch (error) {
    // 合同拒绝面 = 权威记录 corrupt(AuthorityStorageError)或结构 validator
    // 拒绝(TypeError);其余错误(鉴权、业务)不算对抗向量被拦截。
    if (error instanceof AuthorityStorageError || error instanceof TypeError) return;
    throw new Error(
      `behavior probe failed outside the corruption contract: ${String(error)}`,
    );
  }
  throw new Error("behavior probe accepted a corrupted job log");
}

async function expectGuardReplayAccepted(probe: () => Promise<unknown>): Promise<void> {
  try {
    await probe();
  } catch (error) {
    if (error instanceof AuthorityStorageError) {
      throw new Error(`behavior probe rejected a legal job log: ${String(error)}`);
    }
    // The guard has accepted and loaded the journal; the requested business action may
    // still be stably rejected by the already-replayed terminal state.
  }
}

describe("job record execution-point behavior matrix", () => {
  it("binds every job record type to a producing scenario", () => {
    expect(Object.keys(JOB_RECORD_BEHAVIOR).sort()).toEqual(
      Object.keys(JOB_JOURNAL_RECORD_SHAPES).sort(),
    );
    const referencedRecoveryProbes = new Set<JobRecoveryProbeId>();
    for (const [recordType, spec] of Object.entries(JOB_RECORD_BEHAVIOR)) {
      if (spec.recovery.kind === "not-applicable") {
        expect(spec.recovery.reason.length, recordType).toBeGreaterThan(20);
      } else {
        referencedRecoveryProbes.add(spec.recovery.id);
      }
    }
    expect([...referencedRecoveryProbes].sort()).toEqual(
      Object.keys(JOB_RECOVERY_PROBES).sort(),
    );
  });

  it.each(Object.entries(JOB_RECOVERY_PROBES))(
    "recovery contract %s executes its real consumer",
    async (_id, probe) => probe(),
    20_000,
  );

  it.each(Object.keys(JOB_RECORD_BEHAVIOR) as JobJournalRecordType[])(
    "%s: real production, full/guard acceptance, adversarial-vector rejection",
    async (recordType) => {
      const spec = JOB_RECORD_BEHAVIOR[recordType] as JobRecordBehaviorSpec;
      const behavior = await JOB_BEHAVIOR_SCENARIOS[spec.scenario]();
      const records = await behavior.log.readStream<Record<string, unknown> & { t: string }>(
        `job:${TASK_ID}`,
      );
      const produced = records.filter((record) => record.body.t === recordType);
      expect(produced.length, recordType).toBeGreaterThan(0);
      await behavior.fullProbe();
      if (behavior.guardProbe) await expectGuardReplayAccepted(behavior.guardProbe);
      const target = produced[produced.length - 1];
      if (!target) throw new Error("matrix target record is missing");
      const vector = spec.corrupt
        ? spec.corrupt(structuredClone(target.body))
        : structuredClone(target.body);
      await behavior.log.append([{ stream: `job:${TASK_ID}`, body: vector }]);
      await expectBehaviorRejected(behavior.fullProbe);
      if (behavior.guardProbe) await expectBehaviorRejected(behavior.guardProbe);
    },
    20_000,
  );
});

describe("user assigned state edges are closed by domain", () => {
  it("rejects a raw assigned edge outside the user state machine in full and guard replay", async () => {
    const harness = await createUserHarness();
    await start(harness);
    await harness.log.append([
      {
        stream: `job:${TASK_ID}`,
        body: {
          t: "state" as const,
          jobRunId: JOB_RUN_ID,
          state: "failed" as const,
          statusRevision: 4,
          assignmentId: ASSIGNMENT_ID,
        },
      },
    ]);
    await expect(reopenUserJournal(harness).currentState(JOB_RUN_ID)).rejects.toThrow(
      "legal assigned edge",
    );
    await expect(
      harness.journal.reportStarted(ASSIGNMENT_ID, submissionContext(harness.unsigned)),
    ).rejects.toThrow("legal assigned edge");
  });
});
