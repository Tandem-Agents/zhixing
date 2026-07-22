import { Buffer } from "node:buffer";
import type { ArtifactStore } from "@zhixing/core/authority";
import {
  collectArtifactRefs,
  FileResumableArtifactReceiver,
  describeDispatchArtifactClosure,
  describeSealedBundleArtifactClosure,
  normalizedArtifactRefs,
  readArtifactRange,
  resolveDispatchArtifactClosure,
  resolveSealedBundleArtifactClosure,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentEntry,
  AssignmentRecord,
  AssignmentActivationProof,
  AuthorityEpochRef,
  AuthorityCallContext,
  AuthorityCapability,
  CancelProofBody,
  DispatchEnvelope,
  DispatchResult,
  InteractionMirrorBatch,
  LedgerEvidencePage,
  LedgerSnapshot,
  RunDispatchArguments,
  RunExecutorPort,
  RunSubmissionPort,
  SealedBundle,
  SupersedeProof,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  dispatchEnvelopeDigest,
  dispatchEnvelopeArtifact,
  protocolDigest,
  sealedBundleArtifact,
  validateConversationActivation,
  validateConversationEnvelope,
  validateConversationSealedBundle,
  validateDispatchControlBinding,
  validateDispatchResult,
  validateAuthorityError,
  validateAssignmentEntry,
  validateJobActivation,
  validateJobEnvelope,
  validateJobSealedBundle,
  validateLedgerEvidencePage,
  validateLedgerSnapshot,
  validateSupersedeProof,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type {
  MeshServiceRegistry,
  SecureMeshConnection,
} from "@zhixing/mesh";
import type {
  OwnerControlPreflightPort,
  OwnerControlRequest,
} from "@zhixing/executor";
import type {
  AssignmentSubmissionIdentity,
  AssignmentSubmissionPreflightPort,
} from "@zhixing/owner-kernel";

export const ASSIGNMENT_ARTIFACT_SERVICE = "assignment.artifacts";
export const RUN_EXECUTOR_SERVICE = "assignment.executor";
export const RUN_SUBMISSION_SERVICE = "assignment.submission";

export interface AssignmentArtifactAuthorization {
  readonly assignmentId: string;
  readonly capability: AuthorityCapability;
  readonly access: "read" | "write";
  readonly ref: ArtifactRef;
  readonly connection: SecureMeshConnection;
  readonly signal: AbortSignal;
}

export interface AssignmentArtifactServiceOptions {
  readonly artifacts: ArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
  readonly authorize: (
    request: AssignmentArtifactAuthorization,
  ) => void | Promise<void>;
  readonly maxRangeBytes?: number;
  readonly clock?: () => number;
}

export interface AssignmentArtifactClientOptions {
  readonly client: MeshServiceClient;
  readonly artifacts: ArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
  readonly chunkBytes?: number;
}

export interface MeshRunExecutorPortOptions {
  readonly client: MeshServiceClient;
  readonly artifacts: ArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
  readonly verifier: ProtocolSignatureVerifier;
  readonly capabilityFor: (
    assignmentId: string,
  ) => AuthorityCapability | Promise<AuthorityCapability>;
  readonly chunkBytes?: number;
  readonly clock?: () => number;
}

export interface RunExecutorMeshServiceOptions {
  readonly port: RunExecutorPort;
  readonly guard: OwnerControlPreflightPort;
  readonly artifacts: ArtifactStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly clock?: () => number;
}

export interface MeshRunSubmissionPortOptions {
  readonly client: MeshServiceClient;
  readonly artifacts: ArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
  readonly chunkBytes?: number;
  readonly clock?: () => number;
}

export interface RunSubmissionMeshServiceOptions {
  readonly port: RunSubmissionPort;
  readonly guard: AssignmentSubmissionPreflightPort;
  readonly artifacts: ArtifactStore;
  readonly clock?: () => number;
}

export type ExecutorControlPreflight = OwnerControlRequest;
export type SubmissionPreflight = AssignmentSubmissionIdentity;

type ArtifactRequest =
  | {
      readonly v: 1;
      readonly t: "probe";
      readonly direction: "receive" | "send";
      readonly assignmentId: string;
      readonly capability: AuthorityCapability;
      readonly ref: ArtifactRef;
    }
  | {
      readonly v: 1;
      readonly t: "append";
      readonly assignmentId: string;
      readonly capability: AuthorityCapability;
      readonly ref: ArtifactRef;
      readonly offset: number;
      readonly bytes: string;
    }
  | {
      readonly v: 1;
      readonly t: "read";
      readonly assignmentId: string;
      readonly capability: AuthorityCapability;
      readonly ref: ArtifactRef;
      readonly offset: number;
      readonly limit: number;
    };

type ExecutorRequest =
  | {
      readonly v: 1;
      readonly method: "dispatch";
      readonly assignmentId: string;
      readonly authority: AuthorityEpochRef;
      readonly expectedOwnerDeviceId: string;
      readonly dispatchDigest: string;
      readonly activationDigest: string;
      readonly dispatchRef: ArtifactRef;
      readonly activation: AnyAssignmentActivationProof;
      readonly context: AuthorityCallContext;
    }
  | {
      readonly v: 1;
      readonly method: "cancel";
      readonly assignmentId: string;
      readonly fence: { readonly fenceSeq: number; readonly requestId: string };
      readonly context: AuthorityCallContext;
    }
  | {
      readonly v: 1;
      readonly method: "supersede";
      readonly assignmentId: string;
      readonly fence: { readonly fenceSeq: number; readonly requestId: string };
      readonly context: AuthorityCallContext;
    }
  | {
      readonly v: 1;
      readonly method: "queryLedger";
      readonly assignmentId: string;
      readonly context: AuthorityCallContext;
      readonly range?: { readonly fromSeq: number; readonly limit: number };
    };

type SubmissionRequest =
  | {
      readonly v: 1;
      readonly method: "reportStarted";
      readonly assignmentId: string;
      readonly context: AuthorityCallContext;
    }
  | {
      readonly v: 1;
      readonly method: "submitBundle";
      readonly assignmentId: string;
      readonly bundleRef: ArtifactRef;
      readonly context: AuthorityCallContext;
    }
  | {
      readonly v: 1;
      readonly method: "submitCancelProof";
      readonly assignmentId: string;
      readonly proof: CancelProofBody;
      readonly context: AuthorityCallContext;
    }
  | {
      readonly v: 1;
      readonly method: "mirrorInteractions";
      readonly assignmentId: string;
      readonly batch: InteractionMirrorBatch;
      readonly context: AuthorityCallContext;
    };

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_RANGE_BYTES = 256 * 1024;
type AnyAssignmentActivationProof =
  | AssignmentActivationProof<"conversation">
  | AssignmentActivationProof<"job">;
type DispatchControlPreflight = ExecutorControlPreflight & {
  readonly authority: AuthorityEpochRef;
  readonly expectedOwnerDeviceId: string;
  readonly body: {
    readonly dispatchDigest: string;
    readonly activationDigest: string;
  };
};

export function registerAssignmentArtifactService(
  registry: MeshServiceRegistry,
  options: AssignmentArtifactServiceOptions,
): () => void {
  return registry.register(ASSIGNMENT_ARTIFACT_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    handler: createAssignmentArtifactServiceHandler(options),
  });
}

export function createAssignmentArtifactServiceHandler(
  options: AssignmentArtifactServiceOptions,
): (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  const maxRangeBytes = options.maxRangeBytes ?? DEFAULT_MAX_RANGE_BYTES;
  assertPositiveInteger(maxRangeBytes, "Maximum assignment artifact range");
  return async (payload, connection, signal) => {
    signal.throwIfAborted();
    const request = decodeArtifactRequest(payload, maxRangeBytes);
    const operation = linkedDeadlineSignal(
      signal,
      request.capability.expiry,
      options.clock,
    );
    try {
      operation.signal.throwIfAborted();
      const access = request.t === "read" ||
        (request.t === "probe" && request.direction === "send")
        ? "read"
        : "write";
      if (request.capability.assignmentId !== request.assignmentId) {
        throw new TypeError("Artifact capability does not bind the requested assignment");
      }
      await options.authorize({
        assignmentId: request.assignmentId,
        capability: request.capability,
        access,
        ref: request.ref,
        connection,
        signal: operation.signal,
      });
      operation.signal.throwIfAborted();
      if (request.t === "probe") {
        const result = request.direction === "receive"
          ? await options.receiver.progress(request.ref)
          : await sendProgress(options.artifacts, request.ref);
        return encode(result);
      }
      if (request.t === "append") {
        return encode(await options.receiver.append(
          request.ref,
          request.offset,
          decodeBase64(request.bytes, maxRangeBytes),
        ));
      }
      const result = await readArtifactRange(
        options.artifacts,
        request.ref,
        request.offset,
        request.limit,
      );
      return encode({
        bytes: Buffer.from(result.bytes).toString("base64"),
        complete: result.complete,
      });
    } finally {
      operation.dispose();
    }
  };
}

export class AssignmentArtifactClient {
  readonly #chunkBytes: number;

  constructor(private readonly options: AssignmentArtifactClientOptions) {
    this.#chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    assertPositiveInteger(this.#chunkBytes, "Assignment artifact chunk bytes");
  }

  async upload(
    assignmentId: string,
    capability: AuthorityCapability,
    references: readonly ArtifactRef[],
    signal?: AbortSignal,
  ): Promise<void> {
    assertCapabilityAssignment(capability, assignmentId);
    for (const ref of normalizedArtifactRefs(references)) {
      signal?.throwIfAborted();
      let progress = decodeProgress(await this.#request({
        v: 1,
        t: "probe",
        direction: "receive",
        assignmentId,
        capability,
        ref,
      }, signal), ref);
      while (!progress.complete) {
        const offset = progress.receivedBytes;
        if (offset === ref.bytes) {
          const completed = decodeProgress(await this.#request({
            v: 1,
            t: "append",
            assignmentId,
            capability,
            ref,
            offset,
            bytes: "",
          }, signal), ref);
          if (!completed.complete) {
            throw new TypeError("Artifact transfer finalization did not complete");
          }
          progress = completed;
          continue;
        }
        const chunk = await this.options.artifacts.readRange(ref, offset, this.#chunkBytes);
        if (chunk.byteLength === 0) {
          throw new TypeError("Artifact source returned an empty non-final range");
        }
        const next = decodeProgress(await this.#request({
          v: 1,
          t: "append",
          assignmentId,
          capability,
          ref,
          offset,
          bytes: Buffer.from(chunk).toString("base64"),
        }, signal), ref);
        if (next.receivedBytes <= offset) {
          throw new TypeError("Artifact upload did not advance its durable prefix");
        }
        progress = next;
      }
    }
  }

  async download(
    assignmentId: string,
    capability: AuthorityCapability,
    references: readonly ArtifactRef[],
    signal?: AbortSignal,
  ): Promise<void> {
    assertCapabilityAssignment(capability, assignmentId);
    for (const ref of normalizedArtifactRefs(references)) {
      signal?.throwIfAborted();
      let progress = await this.options.receiver.progress(ref);
      if (progress.complete) continue;
      const remote = decodeProgress(await this.#request({
        v: 1,
        t: "probe",
        direction: "send",
        assignmentId,
        capability,
        ref,
      }, signal), ref);
      if (!remote.complete) throw new TypeError("Remote assignment artifact is missing");
      while (!progress.complete) {
        const range = decodeRange(await this.#request({
          v: 1,
          t: "read",
          assignmentId,
          capability,
          ref,
          offset: progress.receivedBytes,
          limit: this.#chunkBytes,
        }, signal), this.#chunkBytes);
        if (range.bytes.byteLength === 0 && !range.complete) {
          throw new TypeError("Artifact download returned an empty non-final range");
        }
        progress = await this.options.receiver.append(
          ref,
          progress.receivedBytes,
          range.bytes,
        );
        if (range.complete !== progress.complete) {
          throw new TypeError("Artifact range completion does not match the declared reference");
        }
      }
    }
  }

  async #request(request: ArtifactRequest, signal?: AbortSignal): Promise<unknown> {
    return decode(await this.options.client.request(
      ASSIGNMENT_ARTIFACT_SERVICE,
      encode(request),
      signal,
    ));
  }
}

export class MeshRunExecutorPort implements RunExecutorPort {
  readonly #assets: AssignmentArtifactClient;

  constructor(private readonly options: MeshRunExecutorPortOptions) {
    this.#assets = new AssignmentArtifactClient(options);
  }

  async dispatch(...args: RunDispatchArguments): Promise<DispatchResult> {
    const [envelope, activation, context] = args;
    const artifact = dispatchEnvelopeArtifact(envelope);
    validateDispatch(envelope, activation, artifact.ref, this.options.verifier);
    const control = dispatchControlPreflight(
      envelope,
      activation,
      context,
      this.options.verifier,
    );
    const closure = await resolveDispatchArtifactClosure(envelope, this.options.artifacts);
    const stored = await this.options.artifacts.put(artifact.bytes);
    assertSameRef(stored, artifact.ref, "Dispatch artifact");
    const capability = await this.#capability(envelope.assignmentId);
    const signal = authorityDeadlineSignal(context, capability.expiry, this.options.clock);
    if (!envelope.capabilities.some(
      (candidate) => canonicalize(candidate) === canonicalize(capability),
    )) {
      throw new TypeError("Artifact capability is not part of the signed dispatch envelope");
    }
    await this.#assets.upload(
      envelope.assignmentId,
      capability,
      [artifact.ref, ...closure.transfer],
      signal,
    );
    const result = validateDispatchResult(decode(await this.options.client.request(
      RUN_EXECUTOR_SERVICE,
      encode({
        v: 1,
        method: "dispatch",
        assignmentId: control.assignmentId,
        authority: control.authority!,
        expectedOwnerDeviceId: control.expectedOwnerDeviceId!,
        dispatchDigest: control.body.dispatchDigest,
        activationDigest: control.body.activationDigest,
        dispatchRef: artifact.ref,
        activation,
        context,
      } satisfies ExecutorRequest),
      signal,
    )), this.options.verifier);
    if (!result.accepted && result.proof.assignmentId !== envelope.assignmentId) {
      throw new TypeError("Dispatch result proof names a different assignment");
    }
    return result;
  }

  async cancel(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    context: AuthorityCallContext,
  ): Promise<void> {
    const signal = authorityDeadlineSignal(context, undefined, this.options.clock);
    assertNull(decode(await this.options.client.request(
      RUN_EXECUTOR_SERVICE,
      encode({ v: 1, method: "cancel", assignmentId, fence, context } satisfies ExecutorRequest),
      signal,
    )));
  }

  async supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    context: AuthorityCallContext,
  ): Promise<SupersedeProof> {
    const capability = await this.#capability(assignmentId);
    const signal = authorityDeadlineSignal(context, capability.expiry, this.options.clock);
    const proof = validateSupersedeProof(decode(await this.options.client.request(
      RUN_EXECUTOR_SERVICE,
      encode({ v: 1, method: "supersede", assignmentId, fence, context } satisfies ExecutorRequest),
      signal,
    )) as SupersedeProof, this.options.verifier);
    if (
      proof.assignmentId !== assignmentId ||
      proof.executorId !== capability.executorId ||
      canonicalize(proof.fence) !== canonicalize(fence)
    ) {
      throw new TypeError("Supersede proof does not bind the requested operation");
    }
    return proof;
  }

  async queryLedger(
    assignmentId: string,
    context: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage> {
    const capability = await this.#capability(assignmentId);
    const signal = authorityDeadlineSignal(context, capability.expiry, this.options.clock);
    const value = decode(await this.options.client.request(
      RUN_EXECUTOR_SERVICE,
      encode({
        v: 1,
        method: "queryLedger",
        assignmentId,
        context,
        ...(range ? { range } : {}),
      } satisfies ExecutorRequest),
      signal,
    ));
    if (isPlainObject(value) && Array.isArray(value.entries)) {
      const page = validateLedgerEvidencePage(value, this.options.verifier);
      if (
        page.assignmentId !== assignmentId ||
        page.executorId !== capability.executorId ||
        range === undefined ||
        page.fromSeq !== range.fromSeq ||
        page.entries.length > range.limit
      ) {
        throw new TypeError("Ledger evidence page does not bind the requested range");
      }
      await this.#downloadEvidenceArtifacts(assignmentId, capability, page.entries, signal);
      return page;
    }
    if (range !== undefined) {
      throw new TypeError("Ledger snapshot does not bind the requested range");
    }
    const snapshot = validateLedgerSnapshot(value, this.options.verifier);
    if (snapshot.assignmentId !== assignmentId) {
      throw new TypeError("Ledger snapshot names a different assignment");
    }
    if (snapshot.sealedBundleRef) {
      await this.#assets.download(
        assignmentId,
        capability,
        [snapshot.sealedBundleRef],
        signal,
      );
      const bundle = await loadSealedBundle(
        snapshot.sealedBundleRef,
        this.options.artifacts,
      );
      const declared = describeSealedBundleArtifactClosure(bundle);
      await this.#assets.download(
        assignmentId,
        capability,
        declared.transfer,
        signal,
      );
      await resolveSealedBundleArtifactClosure(bundle, this.options.artifacts);
    }
    return snapshot;
  }

  async #capability(assignmentId: string): Promise<AuthorityCapability> {
    const capability = await this.options.capabilityFor(assignmentId);
    assertCapabilityAssignment(capability, assignmentId);
    return capability;
  }

  async #downloadEvidenceArtifacts(
    assignmentId: string,
    capability: AuthorityCapability,
    entries: LedgerEvidencePage["entries"],
    signal: AbortSignal,
  ): Promise<void> {
    await this.#assets.download(
      assignmentId,
      capability,
      normalizedArtifactRefs(collectArtifactRefs(entries)),
      signal,
    );
    const materialized: AssignmentEntry[] = [];
    for (const entry of entries) {
      const body = isArtifactRecordReference(entry.body)
        ? await loadCanonicalArtifact(entry.body.ref, this.options.artifacts) as AssignmentRecord
        : entry.body;
      const validated = validateAssignmentEntry(
        { recordSeq: entry.recordSeq, body },
        this.options.verifier,
      );
      materialized.push(validated);
    }
    await this.#assets.download(
      assignmentId,
      capability,
      normalizedArtifactRefs(collectArtifactRefs(materialized)),
      signal,
    );
    for (const entry of materialized) {
      if (entry.body.t === "received") {
        const envelope = await loadDispatchEnvelope(
          entry.body.envelope.ref,
          this.options.artifacts,
        );
        validateDispatch(
          envelope,
          entry.body.activation as AnyAssignmentActivationProof,
          entry.body.envelope.ref,
          this.options.verifier,
        );
        const closure = describeDispatchArtifactClosure(envelope);
        await this.#assets.download(assignmentId, capability, closure.transfer, signal);
        await resolveDispatchArtifactClosure(envelope, this.options.artifacts);
      } else if (entry.body.t === "bundle_sealed") {
        const bundle = await loadSealedBundle(
          entry.body.bundle.ref,
          this.options.artifacts,
        );
        const closure = describeSealedBundleArtifactClosure(bundle);
        await this.#assets.download(assignmentId, capability, closure.transfer, signal);
        await resolveSealedBundleArtifactClosure(bundle, this.options.artifacts);
      }
    }
  }
}

export function registerRunExecutorMeshService(
  registry: MeshServiceRegistry,
  options: RunExecutorMeshServiceOptions,
): () => void {
  return registry.register(RUN_EXECUTOR_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    handler: createRunExecutorMeshServiceHandler(options),
  });
}

export function createRunExecutorMeshServiceHandler(
  options: RunExecutorMeshServiceOptions,
): (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  return async (payload, connection, signal) => {
    signal.throwIfAborted();
    const request = decodeExecutorRequest(payload);
    const operation = linkedDeadlineSignal(
      signal,
      request.context.deadlineAt,
      options.clock,
    );
    try {
      operation.signal.throwIfAborted();
      const preflight = executorRequestPreflight(request);
      await options.guard.preflightOwnerControl(
        request.context,
        preflight,
        connection.peer.deviceId,
      );
      operation.signal.throwIfAborted();
      if (request.method === "dispatch") {
        const envelope = await loadDispatchEnvelope(request.dispatchRef, options.artifacts);
        validateDispatch(
          envelope,
          request.activation,
          request.dispatchRef,
          options.verifier,
        );
        const actual = dispatchControlPreflight(
          envelope,
          request.activation,
          request.context,
          options.verifier,
        );
        if (canonicalize(actual) !== canonicalize(preflight)) {
          throw new TypeError("Dispatch payload does not bind its authorized preflight identity");
        }
        await resolveDispatchArtifactClosure(envelope, options.artifacts);
        return encode(await options.port.dispatch(
          ...dispatchArguments(envelope, request.activation, request.context),
        ));
      }
      if (request.method === "cancel") {
        await options.port.cancel(
          request.assignmentId,
          request.fence,
          request.context,
        );
        return encode(null);
      }
      if (request.method === "supersede") {
        return encode(await options.port.supersede(
          request.assignmentId,
          request.fence,
          request.context,
        ));
      }
      return encode(await options.port.queryLedger(
        request.assignmentId,
        request.context,
        request.range,
      ));
    } finally {
      operation.dispose();
    }
  };
}

export class MeshRunSubmissionPort implements RunSubmissionPort {
  readonly #assets: AssignmentArtifactClient;

  constructor(private readonly options: MeshRunSubmissionPortOptions) {
    this.#assets = new AssignmentArtifactClient(options);
  }

  async reportStarted(
    assignmentId: string,
    context: AuthorityCallContext,
  ): Promise<void> {
    const signal = authorityDeadlineSignal(context, undefined, this.options.clock);
    assertNull(decode(await this.options.client.request(
      RUN_SUBMISSION_SERVICE,
      encode({ v: 1, method: "reportStarted", assignmentId, context } satisfies SubmissionRequest),
      signal,
    )));
  }

  async submitBundle(
    bundle: SealedBundle,
    context: AuthorityCallContext,
  ): Promise<
    | { committed: true; commitRevision: number }
    | { committed: false; error: import("@zhixing/core/contracts").AuthorityError }
  > {
    const capability = assignmentCapabilityFromContext(context, bundle.assignmentId);
    const signal = authorityDeadlineSignal(context, capability.expiry, this.options.clock);
    const validated = bundle.body.t === "conversation"
      ? validateConversationSealedBundle(bundle)
      : validateJobSealedBundle(bundle);
    const artifact = sealedBundleArtifact(validated);
    const closure = await resolveSealedBundleArtifactClosure(validated, this.options.artifacts);
    const stored = await this.options.artifacts.put(artifact.bytes);
    assertSameRef(stored, artifact.ref, "Sealed bundle artifact");
    await this.#assets.upload(
      bundle.assignmentId,
      capability,
      [artifact.ref, ...closure.transfer],
      signal,
    );
    return decodeBundleResult(decode(await this.options.client.request(
      RUN_SUBMISSION_SERVICE,
      encode({
        v: 1,
        method: "submitBundle",
        assignmentId: bundle.assignmentId,
        bundleRef: artifact.ref,
        context,
      } satisfies SubmissionRequest),
      signal,
    )));
  }

  async submitCancelProof(
    assignmentId: string,
    proof: CancelProofBody,
    context: AuthorityCallContext,
  ): Promise<void> {
    const signal = authorityDeadlineSignal(context, undefined, this.options.clock);
    assertNull(decode(await this.options.client.request(
      RUN_SUBMISSION_SERVICE,
      encode({
        v: 1,
        method: "submitCancelProof",
        assignmentId,
        proof,
        context,
      } satisfies SubmissionRequest),
      signal,
    )));
  }

  async mirrorInteractions(
    assignmentId: string,
    batch: InteractionMirrorBatch,
    context: AuthorityCallContext,
  ): Promise<{ mirroredUpTo: number; ordinal: number; mirrorDigest: import("@zhixing/core/contracts").Digest }> {
    const signal = authorityDeadlineSignal(context, undefined, this.options.clock);
    const receipt = decodeMirrorReceipt(decode(await this.options.client.request(
      RUN_SUBMISSION_SERVICE,
      encode({
        v: 1,
        method: "mirrorInteractions",
        assignmentId,
        batch,
        context,
      } satisfies SubmissionRequest),
      signal,
    )));
    const last = batch.entries.at(-1);
    if (
      !last ||
      receipt.mirroredUpTo !== last.seq ||
      receipt.ordinal !== last.ordinal ||
      receipt.mirrorDigest !== batch.mirrorDigest
    ) {
      throw new TypeError("Interaction mirror receipt does not bind the submitted batch");
    }
    return receipt;
  }
}

export function registerRunSubmissionMeshService(
  registry: MeshServiceRegistry,
  options: RunSubmissionMeshServiceOptions,
): () => void {
  return registry.register(RUN_SUBMISSION_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    handler: createRunSubmissionMeshServiceHandler(options),
  });
}

export function createRunSubmissionMeshServiceHandler(
  options: RunSubmissionMeshServiceOptions,
): (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  return async (payload, connection, signal) => {
    signal.throwIfAborted();
    const request = decodeSubmissionRequest(payload);
    const identity = submissionRequestPreflight(request);
    assertSubmissionPeer(request.context, connection);
    const operation = linkedDeadlineSignal(
      signal,
      submissionDeadline(request.context),
      options.clock,
    );
    try {
      operation.signal.throwIfAborted();
      await options.guard.preflightSubmission(request.context, identity);
      operation.signal.throwIfAborted();
      if (request.method === "reportStarted") {
        await options.port.reportStarted(request.assignmentId, request.context);
        return encode(null);
      }
      if (request.method === "submitBundle") {
        const bundle = await loadSealedBundle(request.bundleRef, options.artifacts);
        if (bundle.assignmentId !== request.assignmentId) {
          throw new TypeError("Sealed bundle does not bind its authorized assignment");
        }
        await resolveSealedBundleArtifactClosure(bundle, options.artifacts);
        return encode(await options.port.submitBundle(bundle, request.context));
      }
      if (request.method === "submitCancelProof") {
        await options.port.submitCancelProof(
          request.assignmentId,
          request.proof,
          request.context,
        );
        return encode(null);
      }
      return encode(await options.port.mirrorInteractions(
        request.assignmentId,
        request.batch,
        request.context,
      ));
    } finally {
      operation.dispose();
    }
  };
}

function decodeArtifactRequest(payload: Uint8Array, maxRangeBytes: number): ArtifactRequest {
  const value = decode(payload);
  assertPlainObject(value, "Artifact request");
  if (value.v !== 1 || (value.t !== "probe" && value.t !== "append" && value.t !== "read")) {
    throw new TypeError("Assignment artifact request kind is invalid");
  }
  assertPlainObject(value.capability, "Artifact capability");
  assertArtifactRefValue(value.ref);
  if (typeof value.assignmentId !== "string" || value.assignmentId.length === 0) {
    throw new TypeError("Artifact assignmentId is invalid");
  }
  if (value.t === "probe") {
    assertExactKeys(value, ["assignmentId", "capability", "direction", "ref", "t", "v"]);
    if (value.direction !== "receive" && value.direction !== "send") {
      throw new TypeError("Artifact probe direction is invalid");
    }
  } else if (value.t === "append") {
    assertExactKeys(value, ["assignmentId", "bytes", "capability", "offset", "ref", "t", "v"]);
    assertNonNegativeInteger(value.offset, "Artifact chunk offset");
    if (typeof value.bytes !== "string" || value.bytes.length > Math.ceil(maxRangeBytes / 3) * 4) {
      throw new RangeError("Artifact range encoding exceeds its limit");
    }
  } else {
    assertExactKeys(value, ["assignmentId", "capability", "limit", "offset", "ref", "t", "v"]);
    assertNonNegativeInteger(value.offset, "Artifact range offset");
    assertPositiveInteger(value.limit, "Artifact range limit");
    if (value.limit > maxRangeBytes) throw new RangeError("Artifact range exceeds its limit");
  }
  return value as unknown as ArtifactRequest;
}

function decodeExecutorRequest(payload: Uint8Array): ExecutorRequest {
  const value = decode(payload);
  assertPlainObject(value, "Executor request");
  if (value.v !== 1) throw new TypeError("Executor request version is invalid");
  if (value.method === "dispatch") {
    assertExactKeys(value, [
      "activation",
      "activationDigest",
      "assignmentId",
      "authority",
      "context",
      "dispatchDigest",
      "dispatchRef",
      "expectedOwnerDeviceId",
      "method",
      "v",
    ]);
    assertArtifactRefValue(value.dispatchRef);
  } else if (value.method === "cancel" || value.method === "supersede") {
    assertExactKeys(value, ["assignmentId", "context", "fence", "method", "v"]);
  } else if (value.method === "queryLedger") {
    assertExactKeys(
      value,
      ["assignmentId", "context", "method", ...(value.range === undefined ? [] : ["range"]), "v"],
    );
  } else {
    throw new TypeError("Executor request method is invalid");
  }
  return value as unknown as ExecutorRequest;
}

function decodeSubmissionRequest(payload: Uint8Array): SubmissionRequest {
  const value = decode(payload);
  assertPlainObject(value, "Submission request");
  if (value.v !== 1) throw new TypeError("Submission request version is invalid");
  const keys = value.method === "reportStarted"
    ? ["assignmentId", "context", "method", "v"]
    : value.method === "submitBundle"
      ? ["assignmentId", "bundleRef", "context", "method", "v"]
      : value.method === "submitCancelProof"
        ? ["assignmentId", "context", "method", "proof", "v"]
        : value.method === "mirrorInteractions"
          ? ["assignmentId", "batch", "context", "method", "v"]
          : undefined;
  if (!keys) throw new TypeError("Submission request method is invalid");
  assertExactKeys(value, keys);
  if (typeof value.assignmentId !== "string" || value.assignmentId.length === 0) {
    throw new TypeError("Submission request assignmentId is invalid");
  }
  if (value.method === "submitBundle") assertArtifactRefValue(value.bundleRef);
  return value as unknown as SubmissionRequest;
}

async function loadDispatchEnvelope(
  ref: ArtifactRef,
  artifacts: ArtifactStore,
): Promise<DispatchEnvelope> {
  const value = await loadCanonicalArtifact(ref, artifacts);
  return value as DispatchEnvelope;
}

async function loadSealedBundle(
  ref: ArtifactRef,
  artifacts: ArtifactStore,
): Promise<SealedBundle> {
  const value = await loadCanonicalArtifact(ref, artifacts) as SealedBundle;
  return value.body?.t === "conversation"
    ? validateConversationSealedBundle(value)
    : validateJobSealedBundle(value);
}

async function loadCanonicalArtifact(ref: ArtifactRef, artifacts: ArtifactStore): Promise<unknown> {
  const bytes = await artifacts.get(ref);
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) throw new TypeError("Assignment artifact is not canonical JSON");
  return value;
}

function validateDispatch(
  envelope: DispatchEnvelope,
  activation: AnyAssignmentActivationProof,
  dispatchRef: ArtifactRef,
  verifier: ProtocolSignatureVerifier,
): void {
  if (envelope.execution === "conversation") {
    const validated = validateConversationEnvelope(envelope, verifier);
    validateConversationActivation({
      envelope: validated,
      activation: activation as AssignmentActivationProof<"conversation">,
      dispatchRef,
      verifier,
    });
  } else {
    const validated = validateJobEnvelope(envelope, verifier);
    validateJobActivation({
      envelope: validated,
      activation: activation as AssignmentActivationProof<"job">,
      dispatchRef,
      verifier,
    });
  }
}

function dispatchControlPreflight(
  envelope: DispatchEnvelope,
  activation: AnyAssignmentActivationProof,
  context: AuthorityCallContext,
  verifier: ProtocolSignatureVerifier,
): DispatchControlPreflight {
  const binding = validateDispatchControlBinding(envelope, verifier);
  const { signature: _, ...activationPayload } = activation;
  return {
    method: "executor.dispatch",
    assignmentId: binding.assignmentId,
    authority: binding.authority,
    requestId: context.requestId,
    body: {
      dispatchDigest: dispatchEnvelopeDigest(envelope),
      activationDigest: protocolDigest(
        "AssignmentActivationPayload",
        1,
        activationPayload,
      ),
    },
    expectedOwnerDeviceId: binding.ownerDeviceId,
  };
}

function executorRequestPreflight(request: ExecutorRequest): ExecutorControlPreflight {
  if (request.method === "dispatch") {
    return {
      method: "executor.dispatch",
      assignmentId: request.assignmentId,
      authority: request.authority,
      requestId: request.context.requestId,
      body: {
        dispatchDigest: request.dispatchDigest,
        activationDigest: request.activationDigest,
      },
      expectedOwnerDeviceId: request.expectedOwnerDeviceId,
    };
  }
  if (request.method === "cancel" || request.method === "supersede") {
    return {
      method: request.method === "cancel" ? "executor.cancel" : "executor.supersede",
      assignmentId: request.assignmentId,
      requestId: request.fence.requestId,
      body: { fenceSeq: request.fence.fenceSeq },
    };
  }
  return {
    method: "executor.queryLedger",
    assignmentId: request.assignmentId,
    requestId: request.context.requestId,
    body: { range: request.range ?? null },
  };
}

function submissionRequestPreflight(request: SubmissionRequest): SubmissionPreflight {
  return {
    method: request.method === "reportStarted"
      ? "submission.reportStarted"
      : request.method === "submitBundle"
        ? "submission.submitBundle"
        : request.method === "submitCancelProof"
          ? "submission.submitCancelProof"
          : "submission.mirrorInteractions",
    assignmentId: request.assignmentId,
  };
}

function assertSubmissionPeer(
  context: AuthorityCallContext,
  connection: SecureMeshConnection,
): void {
  if (
    context.principal.kind !== "assignment" ||
    context.principal.capability.executorId !== connection.peer.deviceId
  ) {
    throw new TypeError("Assignment capability does not bind the authenticated executor");
  }
}

function dispatchArguments(
  envelope: DispatchEnvelope,
  activation: AnyAssignmentActivationProof,
  context: AuthorityCallContext,
): RunDispatchArguments {
  return [envelope, activation, context] as RunDispatchArguments;
}

function assignmentCapabilityFromContext(
  context: AuthorityCallContext,
  assignmentId: string,
): AuthorityCapability {
  if (context.principal.kind !== "assignment") {
    throw new TypeError("Assignment artifact transfer requires an assignment capability");
  }
  assertCapabilityAssignment(context.principal.capability, assignmentId);
  return context.principal.capability;
}

function assertCapabilityAssignment(
  capability: AuthorityCapability,
  assignmentId: string,
): void {
  if (capability.assignmentId !== assignmentId) {
    throw new TypeError("Assignment capability does not bind the artifact transfer");
  }
}

function decodeProgress(value: unknown, ref: ArtifactRef): { receivedBytes: number; complete: boolean } {
  assertPlainObject(value, "Artifact progress");
  assertExactKeys(value, ["complete", "receivedBytes"]);
  assertNonNegativeInteger(value.receivedBytes, "Artifact received bytes");
  if (typeof value.complete !== "boolean" || value.receivedBytes > ref.bytes) {
    throw new TypeError("Artifact progress is invalid");
  }
  if (value.complete && value.receivedBytes !== ref.bytes) {
    throw new TypeError("Completed artifact progress does not match its byte length");
  }
  return value as { receivedBytes: number; complete: boolean };
}

function decodeRange(value: unknown, maxBytes: number): { bytes: Uint8Array; complete: boolean } {
  assertPlainObject(value, "Artifact range");
  assertExactKeys(value, ["bytes", "complete"]);
  if (typeof value.complete !== "boolean") throw new TypeError("Artifact range completion is invalid");
  return { bytes: decodeBase64(value.bytes, maxBytes), complete: value.complete };
}

function decodeBundleResult(value: unknown):
  | { committed: true; commitRevision: number }
  | { committed: false; error: import("@zhixing/core/contracts").AuthorityError } {
  assertPlainObject(value, "Bundle submission result");
  if (value.committed === true) {
    assertExactKeys(value, ["commitRevision", "committed"]);
    assertNonNegativeInteger(value.commitRevision, "Commit revision");
  } else if (value.committed === false) {
    assertExactKeys(value, ["committed", "error"]);
    validateAuthorityError(value.error, "Bundle submission error");
  } else {
    throw new TypeError("Bundle submission outcome is invalid");
  }
  return value as ReturnType<typeof decodeBundleResult>;
}

function decodeMirrorReceipt(value: unknown): {
  mirroredUpTo: number;
  ordinal: number;
  mirrorDigest: import("@zhixing/core/contracts").Digest;
} {
  assertPlainObject(value, "Interaction mirror receipt");
  assertExactKeys(value, ["mirrorDigest", "mirroredUpTo", "ordinal"]);
  assertNonNegativeInteger(value.mirroredUpTo, "Mirrored sequence");
  assertNonNegativeInteger(value.ordinal, "Mirror ordinal");
  if (
    typeof value.mirrorDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.mirrorDigest)
  ) {
    throw new TypeError("Mirror receipt digest is invalid");
  }
  return value as ReturnType<typeof decodeMirrorReceipt>;
}

async function sendProgress(
  artifacts: ArtifactStore,
  ref: ArtifactRef,
): Promise<{ readonly receivedBytes: number; readonly complete: boolean }> {
  const complete = await artifacts.has(ref);
  return { receivedBytes: complete ? ref.bytes : 0, complete };
}

function authorityDeadlineSignal(
  context: AuthorityCallContext,
  capabilityExpiry?: string,
  clock: () => number = Date.now,
): AbortSignal {
  const deadline = parseCanonicalTime(context.deadlineAt, "Authority call deadline");
  const expiry = capabilityExpiry === undefined
    ? deadline
    : Math.min(deadline, parseCanonicalTime(capabilityExpiry, "Authority capability expiry"));
  const remaining = expiry - clock();
  if (remaining <= 0) {
    return AbortSignal.abort(new Error("Assignment mesh operation deadline has expired"));
  }
  return AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
}

function submissionDeadline(context: AuthorityCallContext): string {
  if (context.principal.kind !== "assignment") {
    throw new TypeError("Assignment submission requires an assignment capability");
  }
  const deadline = parseCanonicalTime(context.deadlineAt, "Authority call deadline");
  const capabilityExpiry = parseCanonicalTime(
    context.principal.capability.expiry,
    "Authority capability expiry",
  );
  return new Date(Math.min(deadline, capabilityExpiry)).toISOString();
}

function linkedDeadlineSignal(
  parent: AbortSignal,
  deadlineAt: string,
  clock: () => number = Date.now,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abortFromParent, { once: true });
  if (parent.aborted) abortFromParent();
  const remaining = parseCanonicalTime(deadlineAt, "Assignment mesh operation deadline") - clock();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (remaining <= 0) {
    controller.abort(new Error("Assignment mesh operation deadline has expired"));
  } else {
    timeout = setTimeout(
      () => controller.abort(new Error("Assignment mesh operation deadline has expired")),
      Math.min(remaining, 2_147_483_647),
    );
  }
  return {
    signal: controller.signal,
    dispose() {
      parent.removeEventListener("abort", abortFromParent);
      if (timeout !== undefined) clearTimeout(timeout);
    },
  };
}

function parseCanonicalTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return parsed;
}

function isArtifactRecordReference(
  value: AssignmentRecord | { readonly ref: ArtifactRef },
): value is { readonly ref: ArtifactRef } {
  return isPlainObject(value) && Object.keys(value).length === 1 && "ref" in value;
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function decode(payload: Uint8Array): unknown {
  const text = Buffer.from(payload).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) throw new TypeError("Assignment mesh payload is not canonical");
  return value;
}

function decodeBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError("Artifact range bytes are not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maxBytes || bytes.toString("base64") !== value) {
    throw new RangeError("Artifact range bytes exceed their limit or are not canonical");
  }
  return bytes;
}

function assertArtifactRefValue(value: unknown): asserts value is ArtifactRef {
  if (!isPlainObject(value)) throw new TypeError("Artifact reference is invalid");
  assertExactKeys(value, ["bytes", "digest"]);
  if (
    typeof value.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0
  ) {
    throw new TypeError("Artifact reference is invalid");
  }
}

function assertSameRef(actual: ArtifactRef, expected: ArtifactRef, label: string): void {
  if (actual.digest !== expected.digest || actual.bytes !== expected.bytes) {
    throw new TypeError(`${label} does not match its canonical bytes`);
  }
}

function assertNull(value: unknown): asserts value is null {
  if (value !== null) throw new TypeError("Void assignment response must be null");
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new TypeError("Assignment mesh payload contains missing or unknown fields");
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}
