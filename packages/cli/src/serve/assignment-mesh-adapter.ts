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
  validateArtifactReadResponse,
  validateArtifactReceiveProgress,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentEntry,
  AssignmentRecord,
  AssignmentActivationProof,
  AssignmentArtifactTransferGrant,
  AuthorityEpochRef,
  AuthorityCallContext,
  AuthorityCapability,
  CancelProofBody,
  DispatchEnvelope,
  DispatchResult,
  InteractionMirrorBatch,
  InteractionSettlementStreamProof,
  JobInteractionSettlementPort,
  LedgerEvidencePage,
  LedgerSnapshot,
  RunDispatchArguments,
  RunExecutorPort,
  ResourceUsageIntake,
  RunSubmissionPort,
  SealedBundle,
  SupersedeProof,
  UsageReport,
} from "@zhixing/core/contracts";
import { MAX_ASSIGNMENT_ARTIFACT_GRANT_TTL_MS } from "@zhixing/core/contracts";
import {
  canonicalize,
  assignmentActivationDigest,
  createSignedAssignmentArtifactTransferGrant,
  dispatchEnvelopeDigest,
  dispatchEnvelopeArtifact,
  protocolDigest,
  sealedBundleArtifact,
  validateConversationActivation,
  validateConversationEnvelope,
  validateDispatchControlBinding,
  validateDispatchResult,
  validateAuthorityError,
  validateAuthorityCapability,
  validateAssignmentActivationProof,
  validateAssignmentArtifactTransferGrant,
  validateAssignmentEntry,
  validateJobActivation,
  validateJobEnvelope,
  validateLedgerEvidencePage,
  validateLedgerSnapshot,
  validateSealedBundle,
  validateSupersedeProof,
  assertProtocolIdentifier,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
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
export const RESOURCE_USAGE_SERVICE = "resource.usage";

export interface AssignmentArtifactAuthorization {
  readonly assignmentId: string;
  readonly capability: AuthorityCapability;
  readonly activation: AnyAssignmentActivationProof;
  readonly grant: AssignmentArtifactTransferGrant;
  readonly access: "read" | "write";
  readonly ref: ArtifactRef;
  readonly connection: SecureMeshConnection;
  readonly signal: AbortSignal;
}

export interface AssignmentArtifactServiceOptions {
  readonly artifacts: ArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
  readonly verifier: ProtocolSignatureVerifier;
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

export interface AssignmentArtifactTransferAuthorization {
  readonly capability: AuthorityCapability;
  readonly activation: AnyAssignmentActivationProof;
  readonly grant: AssignmentArtifactTransferGrant;
}

export interface AssignmentArtifactAuthority {
  readonly capability: AuthorityCapability;
  readonly activation: AnyAssignmentActivationProof;
}

export interface MeshRunExecutorPortOptions {
  readonly client: MeshServiceClient;
  readonly artifacts: ArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
  readonly verifier: ProtocolSignatureVerifier;
  readonly signer: ProtocolSigner;
  readonly localDeviceId: string;
  readonly peerDeviceId: string;
  readonly authorizationFor: (
    assignmentId: string,
  ) => AssignmentArtifactAuthority | Promise<AssignmentArtifactAuthority>;
  readonly chunkBytes?: number;
  readonly clock?: () => number;
}

export interface RunExecutorMeshServiceOptions {
  readonly port: RunExecutorPort;
  readonly guard: OwnerControlPreflightPort;
  readonly artifacts: ArtifactStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly signer: ProtocolSigner;
  readonly localDeviceId: string;
  readonly artifactAuthorizationFor: (
    assignmentId: string,
  ) => AssignmentArtifactAuthority | Promise<AssignmentArtifactAuthority>;
  readonly clock?: () => number;
  readonly authorizePeer: (deviceId: string) => boolean;
  readonly onDispatchAccepted?: (
    envelope: DispatchEnvelope,
    activation: AnyAssignmentActivationProof,
    context: AuthorityCallContext,
  ) => void | Promise<void>;
  readonly onCancelAccepted?: (
    assignmentId: string,
    context: AuthorityCallContext,
  ) => void | Promise<void>;
}

export interface MeshRunSubmissionPortOptions {
  readonly client: MeshServiceClient;
  readonly artifacts: ArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
  readonly signer: ProtocolSigner;
  readonly localDeviceId: string;
  readonly peerDeviceId: string;
  readonly authorizationFor: (
    assignmentId: string,
  ) => AssignmentArtifactAuthority | Promise<AssignmentArtifactAuthority>;
  readonly chunkBytes?: number;
  readonly clock?: () => number;
}

export interface RunSubmissionMeshServiceOptions {
  readonly port: RunSubmissionPort & Partial<JobInteractionSettlementPort>;
  readonly guard: AssignmentSubmissionPreflightPort;
  readonly artifacts: ArtifactStore;
  readonly executorIdForPeer: (deviceId: string) => string | undefined;
}

export interface MeshResourceUsageIntakeOptions {
  readonly client: MeshServiceClient;
}

export interface ResourceUsageMeshServiceOptions {
  readonly intake: ResourceUsageIntake;
  readonly reporterIdForPeer: (deviceId: string) => string | undefined;
}

export type ExecutorControlPreflight = OwnerControlRequest;
export type SubmissionPreflight = AssignmentSubmissionIdentity;

type ArtifactRequest =
  | {
      readonly v: 1;
      readonly t: "probe";
      readonly direction: "receive" | "send";
      readonly assignmentId: string;
      readonly authorization: AssignmentArtifactTransferAuthorization;
      readonly ref: ArtifactRef;
    }
  | {
      readonly v: 1;
      readonly t: "append";
      readonly assignmentId: string;
      readonly authorization: AssignmentArtifactTransferAuthorization;
      readonly ref: ArtifactRef;
      readonly offset: number;
      readonly bytes: string;
    }
  | {
      readonly v: 1;
      readonly t: "read";
      readonly assignmentId: string;
      readonly authorization: AssignmentArtifactTransferAuthorization;
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
    }
  | {
      readonly v: 1;
      readonly method: "completeInteractionSettlement";
      readonly assignmentId: string;
      readonly proof?: InteractionSettlementStreamProof;
      readonly context: AuthorityCallContext;
    };

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_RANGE_BYTES = 256 * 1024;
export type AnyAssignmentActivationProof =
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
    const access = request.t === "read" ||
      (request.t === "probe" && request.direction === "send")
      ? "read"
      : "write";
    const authorization = validateArtifactTransferAuthorization(
      request.authorization,
      request.assignmentId,
      request.ref,
      options.verifier,
      options.clock,
    );
    const operation = linkedDeadlineSignal(
      signal,
      authorization.grant.expiry,
      options.clock,
    );
    try {
      operation.signal.throwIfAborted();
      await options.authorize({
        assignmentId: request.assignmentId,
        ...authorization,
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
    authorization: AssignmentArtifactTransferAuthorization,
    references: readonly ArtifactRef[],
    signal?: AbortSignal,
  ): Promise<void> {
    assertArtifactAuthorizationCovers(authorization, assignmentId, references);
    for (const ref of normalizedArtifactRefs(references)) {
      signal?.throwIfAborted();
      let progress = decodeProgress(await this.#request({
        v: 1,
        t: "probe",
        direction: "receive",
        assignmentId,
        authorization,
        ref,
      }, signal), ref);
      while (!progress.complete) {
        const offset = progress.receivedBytes;
        if (offset === ref.bytes) {
          const completed = decodeProgress(await this.#request({
            v: 1,
            t: "append",
            assignmentId,
            authorization,
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
          authorization,
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
    authorization: AssignmentArtifactTransferAuthorization,
    references: readonly ArtifactRef[],
    signal?: AbortSignal,
  ): Promise<void> {
    assertArtifactAuthorizationCovers(authorization, assignmentId, references);
    for (const ref of normalizedArtifactRefs(references)) {
      signal?.throwIfAborted();
      let progress = await this.options.receiver.progress(ref);
      if (progress.complete) continue;
      const remote = decodeProgress(await this.#request({
        v: 1,
        t: "probe",
        direction: "send",
        assignmentId,
        authorization,
        ref,
      }, signal), ref);
      if (!remote.complete) throw new TypeError("Remote assignment artifact is missing");
      while (!progress.complete) {
        const offset = progress.receivedBytes;
        const range = decodeRange(await this.#request({
          v: 1,
          t: "read",
          assignmentId,
          authorization,
          ref,
          offset,
          limit: this.#chunkBytes,
        }, signal), ref, offset, this.#chunkBytes);
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
    const durableAuthorization = await this.#authorization(envelope.assignmentId);
    const capability = durableAuthorization.capability;
    if (!envelope.capabilities.some(
      (candidate) => canonicalize(candidate) === canonicalize(capability),
    ) || canonicalize(durableAuthorization.activation) !== canonicalize(activation)) {
      throw new TypeError("Artifact capability is not part of the signed dispatch envelope");
    }
    const authorization = issueArtifactTransferAuthorization({
      ...durableAuthorization,
      refs: [artifact.ref, ...closure.transfer],
      direction: "owner-to-executor",
      sourceDeviceId: this.options.localDeviceId,
      targetDeviceId: this.options.peerDeviceId,
      signer: this.options.signer,
      clock: this.options.clock,
      notAfter: capability.expiry,
    });
    await this.#assets.upload(
      envelope.assignmentId,
      authorization,
      [artifact.ref, ...closure.transfer],
      undefined,
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
      undefined,
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
    assertNull(decode(await this.options.client.request(
      RUN_EXECUTOR_SERVICE,
      encode({ v: 1, method: "cancel", assignmentId, fence, context } satisfies ExecutorRequest),
    )));
  }

  async supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    context: AuthorityCallContext,
  ): Promise<SupersedeProof> {
    const capability = (await this.#authorization(assignmentId)).capability;
    const proof = validateSupersedeProof(decode(await this.options.client.request(
      RUN_EXECUTOR_SERVICE,
      encode({ v: 1, method: "supersede", assignmentId, fence, context } satisfies ExecutorRequest),
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
    const durableAuthorization = await this.#authorization(assignmentId);
    const capability = durableAuthorization.capability;
    const response = decode(await this.options.client.request(
      RUN_EXECUTOR_SERVICE,
      encode({
        v: 1,
        method: "queryLedger",
        assignmentId,
        context,
        ...(range ? { range } : {}),
      } satisfies ExecutorRequest),
    ));
    assertPlainObject(response, "Ledger query response");
    assertExactKeys(
      response,
      ["result", "v", ...(response.artifactGrant === undefined ? [] : ["artifactGrant"])],
    );
    if (response.v !== 1) throw new TypeError("Ledger query response version is invalid");
    const value = response.result;
    const transferAuthorization = response.artifactGrant === undefined
      ? undefined
      : {
          ...durableAuthorization,
          grant: validateAssignmentArtifactTransferGrant(
            response.artifactGrant,
            this.options.verifier,
          ),
        };
    if (
      transferAuthorization &&
      (
        transferAuthorization.grant.sourceDeviceId !== this.options.peerDeviceId ||
        transferAuthorization.grant.targetDeviceId !== this.options.localDeviceId ||
        transferAuthorization.grant.direction !== "executor-to-owner"
      )
    ) {
      throw new TypeError("Ledger artifact grant does not bind the queried executor");
    }
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
      await this.#downloadEvidenceArtifacts(
        assignmentId,
        transferAuthorization,
        page.entries,
      );
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
      if (!transferAuthorization) {
        throw new TypeError("Ledger snapshot omitted its artifact transfer grant");
      }
      await this.#assets.download(
        assignmentId,
        transferAuthorization,
        [snapshot.sealedBundleRef],
      );
      const bundle = await loadSealedBundle(
        snapshot.sealedBundleRef,
        this.options.artifacts,
      );
      const declared = describeSealedBundleArtifactClosure(bundle);
      await this.#assets.download(
        assignmentId,
        transferAuthorization,
        declared.transfer,
      );
      await resolveSealedBundleArtifactClosure(bundle, this.options.artifacts);
    }
    return snapshot;
  }

  async #authorization(assignmentId: string): Promise<AssignmentArtifactAuthority> {
    const authorization = await this.options.authorizationFor(assignmentId);
    assertCapabilityAssignment(authorization.capability, assignmentId);
    if (authorization.activation.assignmentId !== assignmentId) {
      throw new TypeError("Assignment activation names a different assignment");
    }
    return authorization;
  }

  async #downloadEvidenceArtifacts(
    assignmentId: string,
    authorization: AssignmentArtifactTransferAuthorization | undefined,
    entries: LedgerEvidencePage["entries"],
  ): Promise<void> {
    const initialRefs = normalizedArtifactRefs(collectArtifactRefs(entries));
    if (initialRefs.length > 0 && !authorization) {
      throw new TypeError("Ledger evidence omitted its artifact transfer grant");
    }
    if (!authorization) return;
    await this.#assets.download(
      assignmentId,
      authorization,
      initialRefs,
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
      authorization,
      normalizedArtifactRefs(collectArtifactRefs(materialized)),
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
        await this.#assets.download(assignmentId, authorization, closure.transfer);
        await resolveDispatchArtifactClosure(envelope, this.options.artifacts);
      } else if (entry.body.t === "bundle_sealed") {
        const bundle = await loadSealedBundle(
          entry.body.bundle.ref,
          this.options.artifacts,
        );
        const closure = describeSealedBundleArtifactClosure(bundle);
        await this.#assets.download(assignmentId, authorization, closure.transfer);
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
    authorize: (connection) => options.authorizePeer(connection.peer.deviceId),
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
    const requestedPreflight = executorRequestPreflight(request);
    let envelope: DispatchEnvelope | undefined;
    let preflight = requestedPreflight;
    if (request.method === "dispatch") {
      envelope = await loadDispatchEnvelope(request.dispatchRef, options.artifacts);
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
      if (canonicalize(actual) !== canonicalize(requestedPreflight)) {
        throw new TypeError("Dispatch payload does not bind its authorized preflight identity");
      }
      preflight = actual;
    }
    await options.guard.preflightOwnerControl(
      request.context,
      preflight,
      connection.peer.deviceId,
    );
    signal.throwIfAborted();
    if (request.method === "dispatch") {
      if (!envelope) throw new Error("Dispatch envelope was not loaded");
      await resolveDispatchArtifactClosure(envelope, options.artifacts);
      const result = await options.port.dispatch(
        ...dispatchArguments(envelope, request.activation, request.context),
      );
      if (result.accepted) {
        await options.onDispatchAccepted?.(
          envelope,
          request.activation,
          request.context,
        );
      }
      return encode(result);
    }
    if (request.method === "cancel") {
      await options.port.cancel(
        request.assignmentId,
        request.fence,
        request.context,
      );
      await options.onCancelAccepted?.(
        request.assignmentId,
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
    const rawResult = await options.port.queryLedger(
      request.assignmentId,
      request.context,
      request.range,
    );
    const result = "entries" in rawResult
      ? validateLedgerEvidencePage(rawResult, options.verifier)
      : validateLedgerSnapshot(rawResult, options.verifier);
    const refs = await collectLedgerTransferRefs(
      result,
      options.artifacts,
      options.verifier,
    );
    const authority = await options.artifactAuthorizationFor(request.assignmentId);
    const artifactGrant = refs.length === 0
      ? undefined
      : issueArtifactTransferAuthorization({
          ...authority,
          refs,
          direction: "executor-to-owner",
          sourceDeviceId: options.localDeviceId,
          targetDeviceId: connection.peer.deviceId,
          signer: options.signer,
          clock: options.clock,
        }).grant;
    return encode({
      v: 1,
      result,
      ...(artifactGrant ? { artifactGrant } : {}),
    });
  };
}

export class MeshRunSubmissionPort
  implements RunSubmissionPort, JobInteractionSettlementPort
{
  readonly #assets: AssignmentArtifactClient;

  constructor(private readonly options: MeshRunSubmissionPortOptions) {
    this.#assets = new AssignmentArtifactClient(options);
  }

  async reportStarted(
    assignmentId: string,
    context: AuthorityCallContext,
  ): Promise<void> {
    assertNull(decode(await this.options.client.request(
      RUN_SUBMISSION_SERVICE,
      encode({ v: 1, method: "reportStarted", assignmentId, context } satisfies SubmissionRequest),
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
    const durableAuthorization = await this.options.authorizationFor(bundle.assignmentId);
    if (canonicalize(durableAuthorization.capability) !== canonicalize(capability)) {
      throw new TypeError("Bundle artifact capability differs from the durable activation");
    }
    const validated = validateSealedBundle(bundle);
    const artifact = sealedBundleArtifact(validated);
    if (authorityContextAllowsArtifactWrite(context, capability, this.options.clock)) {
      const closure = await resolveSealedBundleArtifactClosure(validated, this.options.artifacts);
      const stored = await this.options.artifacts.put(artifact.bytes);
      assertSameRef(stored, artifact.ref, "Sealed bundle artifact");
      const authorization = issueArtifactTransferAuthorization({
        ...durableAuthorization,
        refs: [artifact.ref, ...closure.transfer],
        direction: "executor-to-owner",
        sourceDeviceId: this.options.localDeviceId,
        targetDeviceId: this.options.peerDeviceId,
        signer: this.options.signer,
        clock: this.options.clock,
        notAfter: capability.expiry,
      });
      await this.#assets.upload(
        bundle.assignmentId,
        authorization,
        [artifact.ref, ...closure.transfer],
      );
    }
    return decodeBundleResult(decode(await this.options.client.request(
      RUN_SUBMISSION_SERVICE,
      encode({
        v: 1,
        method: "submitBundle",
        assignmentId: bundle.assignmentId,
        bundleRef: artifact.ref,
        context,
      } satisfies SubmissionRequest),
    )));
  }

  async submitCancelProof(
    assignmentId: string,
    proof: CancelProofBody,
    context: AuthorityCallContext,
  ): Promise<void> {
    assertNull(decode(await this.options.client.request(
      RUN_SUBMISSION_SERVICE,
      encode({
        v: 1,
        method: "submitCancelProof",
        assignmentId,
        proof,
        context,
      } satisfies SubmissionRequest),
    )));
  }

  async mirrorInteractions(
    assignmentId: string,
    batch: InteractionMirrorBatch,
    context: AuthorityCallContext,
  ): Promise<{ mirroredUpTo: number; ordinal: number; mirrorDigest: import("@zhixing/core/contracts").Digest }> {
    const receipt = decodeMirrorReceipt(decode(await this.options.client.request(
      RUN_SUBMISSION_SERVICE,
      encode({
        v: 1,
        method: "mirrorInteractions",
        assignmentId,
        batch,
        context,
      } satisfies SubmissionRequest),
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

  async completeInteractionSettlement(
    assignmentId: string,
    proof: InteractionSettlementStreamProof | undefined,
    context: AuthorityCallContext,
  ): Promise<void> {
    assertNull(
      decode(
        await this.options.client.request(
          RUN_SUBMISSION_SERVICE,
          encode({
            v: 1,
            method: "completeInteractionSettlement",
            assignmentId,
            ...(proof === undefined ? {} : { proof }),
            context,
          } satisfies SubmissionRequest),
        ),
      ),
    );
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
    assertSubmissionPeer(
      request.context,
      connection,
      options.executorIdForPeer,
    );
    const preflight = await options.guard.preflightSubmission(request.context, identity);
    if (preflight.kind === "return") {
      if (request.method !== "submitBundle") {
        throw new TypeError("Submission preflight returned a bundle result for another method");
      }
      return encode(preflight.result);
    }
    signal.throwIfAborted();
    if (request.method === "reportStarted") {
      await options.port.reportStarted(request.assignmentId, request.context);
      return encode(null);
    }
    if (request.method === "submitBundle") {
      const bundle = await loadSealedBundle(request.bundleRef, options.artifacts);
      if (bundle.assignmentId !== request.assignmentId) {
        throw new TypeError("Sealed bundle does not bind its authorized assignment");
      }
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
    if (request.method === "completeInteractionSettlement") {
      if (!options.port.completeInteractionSettlement) {
        throw new TypeError(
          "Job interaction settlement is unavailable on this submission authority",
        );
      }
      await options.port.completeInteractionSettlement(
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
  };
}

export class MeshResourceUsageIntake implements ResourceUsageIntake {
  constructor(private readonly options: MeshResourceUsageIntakeOptions) {}

  async submitUsageReport(
    report: UsageReport,
    context: AuthorityCallContext,
  ): Promise<{ ackedThroughSeq: number }> {
    const value = decode(await this.options.client.request(
      RESOURCE_USAGE_SERVICE,
      encode({ v: 1, report, context }),
    ));
    if (!isPlainRecord(value)) throw new TypeError("Usage acknowledgement must be an object");
    assertExactKeys(value, ["ackedThroughSeq", "v"]);
    if (
      value.v !== 1 ||
      !Number.isSafeInteger(value.ackedThroughSeq) ||
      (value.ackedThroughSeq as number) < report.toUsageSeq
    ) {
      throw new TypeError("Usage acknowledgement does not cover the submitted report");
    }
    return { ackedThroughSeq: value.ackedThroughSeq as number };
  }
}

export function registerResourceUsageMeshService(
  registry: MeshServiceRegistry,
  options: ResourceUsageMeshServiceOptions,
): () => void {
  return registry.register(RESOURCE_USAGE_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    handler: createResourceUsageMeshServiceHandler(options),
  });
}

export function createResourceUsageMeshServiceHandler(
  options: ResourceUsageMeshServiceOptions,
): (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  return async (payload, connection, signal) => {
    signal.throwIfAborted();
    const value = decode(payload);
    if (!isPlainRecord(value)) throw new TypeError("Usage submission must be an object");
    assertExactKeys(value, ["context", "report", "v"]);
    if (value.v !== 1 || !isPlainRecord(value.context) || !isPlainRecord(value.report)) {
      throw new TypeError("Usage submission fields are invalid");
    }
    const context = value.context as unknown as AuthorityCallContext;
    const report = value.report as unknown as UsageReport;
    const expectedReporter = options.reporterIdForPeer(connection.peer.deviceId);
    if (
      !expectedReporter ||
      context.principal.kind !== "usage-reporter" ||
      context.principal.executorId !== expectedReporter ||
      report.reporterId !== expectedReporter
    ) {
      throw new TypeError("Usage report does not bind its authenticated executor peer");
    }
    signal.throwIfAborted();
    const receipt = await options.intake.submitUsageReport(report, context);
    if (
      !Number.isSafeInteger(receipt.ackedThroughSeq) ||
      receipt.ackedThroughSeq < report.toUsageSeq
    ) {
      throw new TypeError("Usage intake returned an invalid acknowledgement");
    }
    return encode({ v: 1, ackedThroughSeq: receipt.ackedThroughSeq });
  };
}

function decodeArtifactRequest(payload: Uint8Array, maxRangeBytes: number): ArtifactRequest {
  const value = decode(payload);
  assertPlainObject(value, "Artifact request");
  if (value.v !== 1 || (value.t !== "probe" && value.t !== "append" && value.t !== "read")) {
    throw new TypeError("Assignment artifact request kind is invalid");
  }
  assertPlainObject(value.authorization, "Artifact authorization");
  assertExactKeys(
    value.authorization,
    ["activation", "capability", "grant"],
  );
  assertPlainObject(value.authorization.activation, "Artifact activation");
  assertPlainObject(value.authorization.capability, "Artifact capability");
  assertPlainObject(value.authorization.grant, "Artifact transfer grant");
  assertArtifactRefValue(value.ref);
  if (typeof value.assignmentId !== "string" || value.assignmentId.length === 0) {
    throw new TypeError("Artifact assignmentId is invalid");
  }
  if (value.t === "probe") {
    assertExactKeys(value, ["assignmentId", "authorization", "direction", "ref", "t", "v"]);
    if (value.direction !== "receive" && value.direction !== "send") {
      throw new TypeError("Artifact probe direction is invalid");
    }
  } else if (value.t === "append") {
    assertExactKeys(value, ["assignmentId", "authorization", "bytes", "offset", "ref", "t", "v"]);
    assertNonNegativeInteger(value.offset, "Artifact chunk offset");
    if (typeof value.bytes !== "string" || value.bytes.length > Math.ceil(maxRangeBytes / 3) * 4) {
      throw new RangeError("Artifact range encoding exceeds its limit");
    }
  } else {
    assertExactKeys(value, ["assignmentId", "authorization", "limit", "offset", "ref", "t", "v"]);
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
  assertProtocolIdentifier(value.assignmentId, "Executor request assignmentId");
  assertPlainObject(value.context, "Executor request context");
  assertProtocolIdentifier(value.context.requestId, "Executor request context requestId");
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
    assertPlainObject(value.fence, "Executor request fence");
    assertExactKeys(value.fence, ["fenceSeq", "requestId"]);
    assertPositiveInteger(value.fence.fenceSeq, "Executor request fence sequence");
    assertProtocolIdentifier(value.fence.requestId, "Executor request fence requestId");
  } else if (value.method === "queryLedger") {
    assertExactKeys(
      value,
      ["assignmentId", "context", "method", ...(value.range === undefined ? [] : ["range"]), "v"],
    );
    if (value.range !== undefined) {
      assertPlainObject(value.range, "Executor request range");
      assertExactKeys(value.range, ["fromSeq", "limit"]);
      assertPositiveInteger(value.range.fromSeq, "Executor request range start");
      assertPositiveInteger(value.range.limit, "Executor request range limit");
    }
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
          : value.method === "completeInteractionSettlement"
            ? [
                "assignmentId",
                "context",
                "method",
                ...(value.proof === undefined ? [] : ["proof"]),
                "v",
              ]
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
  return validateSealedBundle(value);
}

async function loadCanonicalArtifact(ref: ArtifactRef, artifacts: ArtifactStore): Promise<unknown> {
  const bytes = await artifacts.get(ref);
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) throw new TypeError("Assignment artifact is not canonical JSON");
  return value;
}

async function collectLedgerTransferRefs(
  result: LedgerSnapshot | LedgerEvidencePage,
  artifacts: ArtifactStore,
  verifier: ProtocolSignatureVerifier,
): Promise<ArtifactRef[]> {
  const refs: ArtifactRef[] = [];
  if ("entries" in result) {
    refs.push(...collectArtifactRefs(result.entries));
    const materialized: AssignmentEntry[] = [];
    for (const entry of result.entries) {
      const body = isArtifactRecordReference(entry.body)
        ? await loadCanonicalArtifact(entry.body.ref, artifacts) as AssignmentRecord
        : entry.body;
      materialized.push(validateAssignmentEntry(
        { recordSeq: entry.recordSeq, body },
        verifier,
      ));
    }
    refs.push(...collectArtifactRefs(materialized));
    for (const entry of materialized) {
      if (entry.body.t === "received") {
        const envelope = await loadDispatchEnvelope(entry.body.envelope.ref, artifacts);
        validateDispatch(
          envelope,
          entry.body.activation as AnyAssignmentActivationProof,
          entry.body.envelope.ref,
          verifier,
        );
        refs.push(...describeDispatchArtifactClosure(envelope).transfer);
      } else if (entry.body.t === "bundle_sealed") {
        const bundle = await loadSealedBundle(entry.body.bundle.ref, artifacts);
        refs.push(...describeSealedBundleArtifactClosure(bundle).transfer);
      }
    }
  } else if (result.sealedBundleRef) {
    refs.push(result.sealedBundleRef);
    const bundle = await loadSealedBundle(result.sealedBundleRef, artifacts);
    refs.push(...describeSealedBundleArtifactClosure(bundle).transfer);
  }
  return normalizedArtifactRefs(refs);
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
          : request.method === "completeInteractionSettlement"
            ? "submission.completeInteractionSettlement"
            : "submission.mirrorInteractions",
    assignmentId: request.assignmentId,
  };
}

function assertSubmissionPeer(
  context: AuthorityCallContext,
  connection: SecureMeshConnection,
  executorIdForPeer: (deviceId: string) => string | undefined,
): void {
  const expectedExecutorId = executorIdForPeer(connection.peer.deviceId);
  if (
    !expectedExecutorId ||
    context.principal.kind !== "assignment" ||
    context.principal.capability.executorId !== expectedExecutorId
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

function validateArtifactTransferAuthorization(
  input: AssignmentArtifactTransferAuthorization,
  assignmentId: string,
  ref: ArtifactRef,
  verifier: ProtocolSignatureVerifier,
  clock: () => number = Date.now,
): AssignmentArtifactTransferAuthorization {
  const capability = validateAuthorityCapability(input.capability, verifier);
  const activation = input.activation as AnyAssignmentActivationProof;
  const activationPayload = validateAssignmentActivationProof(activation, verifier);
  const grant = validateAssignmentArtifactTransferGrant(input.grant, verifier);
  assertCapabilityAssignment(capability, assignmentId);
  if (
    activationPayload.assignmentId !== assignmentId ||
    activationPayload.assignmentId !== capability.assignmentId ||
    activationPayload.executorId !== capability.executorId ||
    !activationPayload.capIds.includes(capability.capId) ||
    activation.signature.keyId !== capability.signature.keyId ||
    grant.assignmentId !== assignmentId ||
    grant.executorId !== capability.executorId ||
    grant.capId !== capability.capId ||
    grant.activationDigest !== assignmentActivationDigest(activationPayload) ||
    !grant.refs.some((candidate) =>
      candidate.digest === ref.digest && candidate.bytes === ref.bytes)
  ) {
    throw new TypeError("Assignment artifact authorization does not bind this transfer");
  }
  const now = clock();
  if (now < Date.parse(grant.issuedAt) || now >= Date.parse(grant.expiry)) {
    throw new TypeError("Assignment artifact transfer grant is outside its validity interval");
  }
  return { capability, activation, grant };
}

function assertArtifactAuthorizationCovers(
  authorization: AssignmentArtifactTransferAuthorization,
  assignmentId: string,
  references: readonly ArtifactRef[],
): void {
  assertCapabilityAssignment(authorization.capability, assignmentId);
  if (
    authorization.activation.assignmentId !== assignmentId ||
    authorization.grant.assignmentId !== assignmentId
  ) {
    throw new TypeError("Assignment artifact authorization names a different assignment");
  }
  const granted = new Map(
    authorization.grant.refs.map((ref) => [ref.digest, ref.bytes] as const),
  );
  for (const ref of normalizedArtifactRefs(references)) {
    if (granted.get(ref.digest) !== ref.bytes) {
      throw new TypeError("Assignment artifact authorization does not cover the requested ref");
    }
  }
}

function issueArtifactTransferAuthorization(input: {
  readonly capability: AuthorityCapability;
  readonly activation: AnyAssignmentActivationProof;
  readonly refs: readonly ArtifactRef[];
  readonly direction: AssignmentArtifactTransferGrant["direction"];
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  readonly signer: ProtocolSigner;
  readonly clock?: () => number;
  readonly notAfter?: string;
}): AssignmentArtifactTransferAuthorization {
  const now = (input.clock ?? Date.now)();
  const issuedAt = new Date(now).toISOString();
  const expiryMs = Math.min(
    now + MAX_ASSIGNMENT_ARTIFACT_GRANT_TTL_MS,
    input.notAfter === undefined ? Number.POSITIVE_INFINITY : Date.parse(input.notAfter),
  );
  if (!Number.isFinite(expiryMs) || expiryMs <= now) {
    throw new TypeError("Assignment artifact transfer authorization is already stale");
  }
  const { signature: _, ...activationPayload } = input.activation;
  const grant = createSignedAssignmentArtifactTransferGrant({
    assignmentId: input.capability.assignmentId,
    executorId: input.capability.executorId,
    capId: input.capability.capId,
    sourceDeviceId: input.sourceDeviceId,
    targetDeviceId: input.targetDeviceId,
    direction: input.direction,
    activationDigest: assignmentActivationDigest(activationPayload),
    refs: normalizedArtifactRefs(input.refs),
    issuedAt,
    expiry: new Date(expiryMs).toISOString(),
    signer: input.signer,
  });
  return {
    capability: input.capability,
    activation: input.activation,
    grant,
  };
}

function decodeProgress(value: unknown, ref: ArtifactRef): { receivedBytes: number; complete: boolean } {
  assertPlainObject(value, "Artifact progress");
  assertExactKeys(value, ["complete", "receivedBytes"]);
  return validateArtifactReceiveProgress(value, ref);
}

function decodeRange(
  value: unknown,
  ref: ArtifactRef,
  offset: number,
  maxBytes: number,
): { bytes: Uint8Array; complete: boolean } {
  assertPlainObject(value, "Artifact range");
  assertExactKeys(value, ["bytes", "complete"]);
  if (typeof value.complete !== "boolean") throw new TypeError("Artifact range completion is invalid");
  const bytes = validateArtifactReadResponse(
    decodeBase64(value.bytes, maxBytes),
    ref,
    offset,
    maxBytes,
  );
  if (value.complete !== (offset + bytes.byteLength === ref.bytes)) {
    throw new TypeError("Artifact range completion does not match the declared reference");
  }
  return { bytes, complete: value.complete };
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

function authorityContextAllowsArtifactWrite(
  context: AuthorityCallContext,
  capability: AuthorityCapability,
  clock: () => number = Date.now,
): boolean {
  const deadline = parseCanonicalTime(context.deadlineAt, "Authority call deadline");
  const capabilityExpiry = parseCanonicalTime(
    capability.expiry,
    "Authority capability expiry",
  );
  return clock() < Math.min(deadline, capabilityExpiry);
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
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
