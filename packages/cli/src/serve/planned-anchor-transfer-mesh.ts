import type {
  AnchorTransferCommand,
  AnchorTransferResult,
  HomeTrustEvent,
  HomeTrustRecord,
  ReadyProof,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  protocolDigest,
  validateAnchorTransferCommand,
  validateAnchorTransferResult,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { currentMaintenanceAbortSignal } from "@zhixing/core/resources";
import type {
  PlannedAnchorTransferArtifactSourcePort,
  PlannedAnchorCandidateIdentity,
  PlannedAnchorCandidateRelease,
  PlannedAnchorTransferRuntimeLifecycle,
  PlannedAnchorTargetReadinessSummary,
  PlannedAnchorTransferTargetPort,
} from "./planned-anchor-transfer.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

export const PLANNED_ANCHOR_TRANSFER_READY_SERVICE = "anchor.transfer.ready";
export const PLANNED_ANCHOR_TRANSFER_SUMMARY_SERVICE = "anchor.transfer.summary";
export const PLANNED_ANCHOR_TRANSFER_SERVICE = "anchor.transfer";
export const PLANNED_ANCHOR_CANDIDATE_RELEASE_SERVICE =
  "anchor.transfer.candidate-release";
export const PLANNED_ANCHOR_TRUST_RECONCILIATION_SERVICE =
  "anchor.transfer.trust-reconciliation";

export const PLANNED_ANCHOR_TRANSFER_ASSEMBLY_DESCRIPTOR = Object.freeze({
  owner: "current-duty-device",
  receiver: "prepared-duty-target",
  roles: Object.freeze(["anchor-executor", "anchor-only"]),
  targetPhases: Object.freeze([
    "prepare",
    "status",
    "freeze",
    "import",
    "commit",
    "abort",
  ]),
  sourcePhases: Object.freeze(["probe", "read-range"]),
  order: Object.freeze(["ready", "prepare", "freeze", "import", "commit"]),
  trustReconciliation: "single-planned-issuer-transition",
  readinessReservation: "target-lifecycle",
});

interface ReadyRequest {
  readonly v: 1;
  readonly candidate: PlannedAnchorCandidateIdentity;
  readonly targetDeviceId: string;
}

interface SummaryRequest {
  readonly v: 1;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
}

interface TrustReconciliationRequest {
  readonly v: 1;
  readonly homeId: string;
  readonly chainHead: HomeTrustRecord["chainHead"];
}

interface TrustReconciliationResult {
  readonly v: 1;
  readonly events: readonly HomeTrustEvent[];
  readonly record: HomeTrustRecord;
}

/** Authenticated mesh client; command/result correlation remains in the strict protocol codec. */
export class PlannedAnchorTransferMeshClient
  implements PlannedAnchorTransferTargetPort, PlannedAnchorTransferArtifactSourcePort {
  constructor(
    private readonly client: MeshServiceClient,
    private readonly sourceDeviceId: string,
    private readonly targetDeviceId: string,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  async summary(): Promise<PlannedAnchorTargetReadinessSummary> {
    const value = decode(await this.client.request(
      PLANNED_ANCHOR_TRANSFER_SUMMARY_SERVICE,
      encode({
        v: 1,
        sourceDeviceId: this.sourceDeviceId,
        targetDeviceId: this.targetDeviceId,
      } satisfies SummaryRequest),
      currentMaintenanceAbortSignal(),
    ));
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      canonicalize(Object.keys(value).sort()) !== canonicalize(["ready"]) ||
      (value as { ready?: unknown }).ready !== true
    ) {
      throw new TypeError("Migration target readiness summary is invalid");
    }
    return Object.freeze({ ready: true as const });
  }

  async ready(input: {
    readonly candidate: PlannedAnchorCandidateIdentity;
  }): Promise<ReadyProof> {
    if (input.candidate.sourceDeviceId !== this.sourceDeviceId) {
      throw new TypeError("Migration ready request changed its source device");
    }
    if (input.candidate.targetDeviceId !== this.targetDeviceId) {
      throw new TypeError("Migration ready request changed its target device");
    }
    return decode(await this.client.request(
      PLANNED_ANCHOR_TRANSFER_READY_SERVICE,
      encode({
        v: 1,
        candidate: input.candidate,
        targetDeviceId: this.targetDeviceId,
      } satisfies ReadyRequest),
      currentMaintenanceAbortSignal(),
    )) as ReadyProof;
  }

  async releaseCandidate(input: PlannedAnchorCandidateRelease): Promise<void> {
    if (
      input.identity.sourceDeviceId !== this.sourceDeviceId ||
      input.identity.targetDeviceId !== this.targetDeviceId
    ) {
      throw new TypeError("Migration candidate release changed its authenticated devices");
    }
    const value = decode(await this.client.request(
      PLANNED_ANCHOR_CANDIDATE_RELEASE_SERVICE,
      encode(input),
      currentMaintenanceAbortSignal(),
    ));
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      canonicalize(Object.keys(value).sort()) !== canonicalize(["released"]) ||
      (value as { released?: unknown }).released !== true
    ) {
      throw new TypeError("Migration candidate release result is invalid");
    }
  }

  async apply(command: AnchorTransferCommand): Promise<AnchorTransferResult> {
    const result = validateAnchorTransferResult(
      decode(await this.client.request(
        PLANNED_ANCHOR_TRANSFER_SERVICE,
        encode(command),
        currentMaintenanceAbortSignal(),
      )),
      command,
      this.verifier,
    );
    return result;
  }

  applyArtifactCommand(command: AnchorTransferCommand): Promise<AnchorTransferResult> {
    return this.apply(command);
  }
}

export function registerPlannedAnchorTransferMeshServices(
  registry: MeshServiceRegistry,
  options: {
    readonly target: () => PlannedAnchorTransferTargetPort | undefined;
    readonly targetDeviceId: string;
    readonly currentSourceDeviceId: () => string;
    readonly verifier: ProtocolSignatureVerifier;
    readonly lifecycle?: PlannedAnchorTransferRuntimeLifecycle;
  },
): () => void {
  const authorize = (deviceId: string) =>
    deviceId === options.currentSourceDeviceId();
  const disposeSummary = registry.register(
    PLANNED_ANCHOR_TRANSFER_SUMMARY_SERVICE,
    {
      access: "read",
      availability: "negotiated-version",
      authorize: (connection) => authorize(connection.peer.deviceId),
      handler: async (payload, connection) => {
        const request = summaryRequest(decode(payload));
        if (
          request.sourceDeviceId !== connection.peer.deviceId ||
          request.sourceDeviceId !== options.currentSourceDeviceId() ||
          request.targetDeviceId !== options.targetDeviceId
        ) {
          throw new TypeError("Migration summary request does not bind its authenticated devices");
        }
        const target = options.target();
        if (!target) throw new Error("Migration target receiver is unavailable");
        return encode(await (options.lifecycle
          ? options.lifecycle.run(() => target.summary())
          : target.summary()));
      },
    },
  );
  const disposeReady = registry.register(
    PLANNED_ANCHOR_TRANSFER_READY_SERVICE,
    {
      access: "write",
      availability: "negotiated-version",
      authorize: (connection) => authorize(connection.peer.deviceId),
      handler: async (payload, connection) => {
        const request = readyRequest(decode(payload));
        if (
          request.candidate.sourceDeviceId !== connection.peer.deviceId ||
          request.candidate.sourceDeviceId !== options.currentSourceDeviceId() ||
          request.candidate.targetDeviceId !== options.targetDeviceId ||
          request.targetDeviceId !== options.targetDeviceId
        ) {
          throw new TypeError("Migration ready request does not bind its authenticated devices");
        }
        const target = options.target();
        if (!target) throw new Error("Migration target receiver is unavailable");
        return encode(await (options.lifecycle
          ? options.lifecycle.run(() => target.ready({ candidate: request.candidate }))
          : target.ready({ candidate: request.candidate })));
      },
    },
  );
  const disposeCommand = registry.register(PLANNED_ANCHOR_TRANSFER_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => authorize(connection.peer.deviceId),
    handler: async (payload, connection) => {
      const command = validateAnchorTransferCommand(decode(payload), options.verifier);
      if (!PLANNED_ANCHOR_TRANSFER_ASSEMBLY_DESCRIPTOR.targetPhases.includes(
        command.op as (typeof PLANNED_ANCHOR_TRANSFER_ASSEMBLY_DESCRIPTOR.targetPhases)[number],
      )) {
        throw new TypeError("Migration target command is outside the planned receiver exact-set");
      }
      if (
        command.op === "prepare" &&
        (command.sourceDeviceId !== connection.peer.deviceId ||
          command.targetDeviceId !== options.targetDeviceId)
      ) {
        throw new TypeError("Migration command does not bind its authenticated devices");
      }
      const target = options.target();
      if (!target) throw new Error("Migration target receiver is unavailable");
      return encode(await (options.lifecycle
        ? options.lifecycle.run(() => target.apply(command))
        : target.apply(command)));
    },
  });
  const disposeRelease = registry.register(
    PLANNED_ANCHOR_CANDIDATE_RELEASE_SERVICE,
    {
      access: "write",
      availability: "negotiated-version",
      authorize: (connection) => authorize(connection.peer.deviceId),
      handler: async (payload, connection) => {
        const release = candidateReleaseRequest(decode(payload));
        if (
          release.identity.sourceDeviceId !== connection.peer.deviceId ||
          release.identity.targetDeviceId !== options.targetDeviceId
        ) {
          throw new TypeError(
            "Migration candidate release does not bind its authenticated devices",
          );
        }
        const target = options.target();
        if (!target) throw new Error("Migration target receiver is unavailable");
        await (options.lifecycle
          ? options.lifecycle.run(() => target.releaseCandidate(release))
          : target.releaseCandidate(release));
        return encode({ released: true });
      },
    },
  );
  return () => {
    disposeRelease();
    disposeCommand();
    disposeReady();
    disposeSummary();
  };
}

export function registerPlannedAnchorTransferSourceMeshService(
  registry: MeshServiceRegistry,
  options: {
    readonly source: () => PlannedAnchorTransferArtifactSourcePort | undefined;
    readonly authorizeTarget: (deviceId: string) => boolean;
    readonly verifier: ProtocolSignatureVerifier;
    readonly lifecycle?: PlannedAnchorTransferRuntimeLifecycle;
  },
): () => void {
  return registry.register(PLANNED_ANCHOR_TRANSFER_SERVICE, {
    access: "read",
    availability: "negotiated-version",
    authorize: (connection) => options.authorizeTarget(connection.peer.deviceId),
    handler: async (payload, connection) => {
      const command = validateAnchorTransferCommand(decode(payload), options.verifier);
      if (
        !PLANNED_ANCHOR_TRANSFER_ASSEMBLY_DESCRIPTOR.sourcePhases.includes(
          command.op as (typeof PLANNED_ANCHOR_TRANSFER_ASSEMBLY_DESCRIPTOR.sourcePhases)[number],
        ) ||
        command.signature.keyId !== connection.peer.deviceId
      ) {
        throw new TypeError("Migration artifact request does not bind its authenticated target");
      }
      const source = options.source();
      if (!source) throw new Error("Migration artifact source is unavailable");
      return encode(await (options.lifecycle
        ? options.lifecycle.run(() => source.applyArtifactCommand(command))
        : source.applyArtifactCommand(command)));
    },
  });
}

/** Replays only the single planned issuer transition missed by an authenticated peer. */
export function registerPlannedAnchorTrustReconciliationService(
  registry: MeshServiceRegistry,
  options: {
    readonly store: FileMeshBootstrapStore;
    readonly authorizePeer: (deviceId: string) => boolean;
  },
): () => void {
  return registry.register(PLANNED_ANCHOR_TRUST_RECONCILIATION_SERVICE, {
    access: "read",
    availability: "negotiated-version",
    authorize: (connection) => options.authorizePeer(connection.peer.deviceId),
    handler: async (payload) => {
      const request = trustReconciliationRequest(decode(payload));
      const events = await options.store.loadTrustEvents();
      const record = await options.store.loadTrustRecord();
      if (!record || record.homeId !== request.homeId) {
        throw new Error("Planned anchor trust reconciliation has no matching home");
      }
      const prefix = request.chainHead.seq === 0
        ? undefined
        : events.find((event) => event.seq === request.chainHead.seq);
      if (
        (request.chainHead.seq > 0 && !prefix) ||
        (prefix && protocolEventDigest(prefix) !== request.chainHead.eventDigest)
      ) {
        throw new Error("Planned anchor trust reconciliation prefix is not current");
      }
      const suffix = events.filter((event) => event.seq > request.chainHead.seq);
      if (
        suffix.length > 1 ||
        suffix.some((event) =>
          event.body.t !== "issuer-transition" ||
          event.body.reason !== "migration" ||
          event.body.signedBy !== "issuer")
      ) {
        throw new Error("Planned anchor trust reconciliation exceeds its finite transition");
      }
      return encode({ v: 1, events: suffix, record } satisfies TrustReconciliationResult);
    },
  });
}

export async function reconcilePlannedAnchorTrustFromPeer(
  client: MeshServiceClient,
  options: {
    readonly store: FileMeshBootstrapStore;
    readonly localDeviceId: string;
  },
): Promise<HomeTrustRecord> {
  const local = await options.store.loadTrustRecord();
  if (!local) throw new Error("Local trust record is unavailable");
  const result = trustReconciliationResult(decode(await client.request(
    PLANNED_ANCHOR_TRUST_RECONCILIATION_SERVICE,
    encode({
      v: 1,
      homeId: local.homeId,
      chainHead: local.chainHead,
    } satisfies TrustReconciliationRequest),
    currentMaintenanceAbortSignal(),
  )));
  if (result.record.homeId !== local.homeId) {
    throw new Error("Planned anchor trust reconciliation returned another home");
  }
  if (result.record.chainHead.seq < local.chainHead.seq) return local;
  if (
    result.record.chainHead.seq === local.chainHead.seq &&
    result.record.chainHead.eventDigest !== local.chainHead.eventDigest
  ) {
    throw new Error("Planned anchor trust reconciliation returned a conflicting chain head");
  }
  await options.store.reconcileTrustSuffix({
    events: result.events,
    record: result.record,
    localDeviceId: options.localDeviceId,
  });
  const reconciled = await options.store.loadTrustRecord();
  if (!reconciled) throw new Error("Reconciled planned anchor trust record is unavailable");
  return reconciled;
}

function readyRequest(input: unknown): ReadyRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Migration ready request must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    canonicalize(Object.keys(value).sort()) !==
      canonicalize(["candidate", "targetDeviceId", "v"]) ||
    value.v !== 1 ||
    !value.candidate || typeof value.candidate !== "object" ||
    Array.isArray(value.candidate) ||
    typeof value.targetDeviceId !== "string"
  ) {
    throw new TypeError("Migration ready request fields are incomplete or unknown");
  }
  return value as unknown as ReadyRequest;
}

function candidateReleaseRequest(input: unknown): PlannedAnchorCandidateRelease {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Migration candidate release request must be an object");
  }
  const value = input as Partial<PlannedAnchorCandidateRelease> & Record<string, unknown>;
  if (
    canonicalize(Object.keys(value).sort()) !==
      canonicalize(["identity", "reason", "signature", "t", "v"]) ||
    value.v !== 1 ||
    value.t !== "planned-anchor-candidate-release" ||
    !value.identity || typeof value.identity !== "object" ||
    Array.isArray(value.identity) ||
    !value.signature || typeof value.signature !== "object"
  ) {
    throw new TypeError("Migration candidate release request fields are invalid");
  }
  return value as PlannedAnchorCandidateRelease;
}

function summaryRequest(input: unknown): SummaryRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Migration summary request must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    canonicalize(Object.keys(value).sort()) !==
      canonicalize(["sourceDeviceId", "targetDeviceId", "v"]) ||
    value.v !== 1 ||
    typeof value.sourceDeviceId !== "string" ||
    typeof value.targetDeviceId !== "string"
  ) {
    throw new TypeError("Migration summary request fields are incomplete or unknown");
  }
  return value as unknown as SummaryRequest;
}

function trustReconciliationRequest(input: unknown): TrustReconciliationRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Planned anchor trust reconciliation request must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    canonicalize(Object.keys(value).sort()) !== canonicalize(["chainHead", "homeId", "v"]) ||
    value.v !== 1 ||
    typeof value.homeId !== "string" ||
    value.chainHead === null ||
    typeof value.chainHead !== "object" ||
    Array.isArray(value.chainHead)
  ) {
    throw new TypeError("Planned anchor trust reconciliation request fields are invalid");
  }
  const chainHead = value.chainHead as Record<string, unknown>;
  if (
    canonicalize(Object.keys(chainHead).sort()) !== canonicalize(["eventDigest", "seq"]) ||
    !Number.isSafeInteger(chainHead.seq) ||
    (chainHead.seq as number) < 0 ||
    typeof chainHead.eventDigest !== "string"
  ) {
    throw new TypeError("Planned anchor trust reconciliation chain head is invalid");
  }
  return value as unknown as TrustReconciliationRequest;
}

function trustReconciliationResult(input: unknown): TrustReconciliationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Planned anchor trust reconciliation result must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    canonicalize(Object.keys(value).sort()) !== canonicalize(["events", "record", "v"]) ||
    value.v !== 1 ||
    !Array.isArray(value.events) ||
    value.events.length > 1 ||
    value.record === null ||
    typeof value.record !== "object" ||
    Array.isArray(value.record)
  ) {
    throw new TypeError("Planned anchor trust reconciliation result fields are invalid");
  }
  return value as unknown as TrustReconciliationResult;
}

function protocolEventDigest(event: HomeTrustEvent): string {
  const { signature: _signature, ...unsigned } = event;
  return protocolDigest("HomeTrustEvent", 1, unsigned);
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function decode(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) {
    throw new TypeError("Migration mesh payload is not canonical");
  }
  return value;
}
