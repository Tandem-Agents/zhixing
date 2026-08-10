import type { HomeTrustEvent, HomeTrustRecord } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  homeTrustEventDigest,
  replayTrustChain,
  verifyHomeTrustRecord,
} from "@zhixing/mesh/trust-chain";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

export const DISASTER_RECOVERY_TRUST_EVIDENCE_SERVICE =
  "anchor.disaster-recovery.trust-evidence";

interface TrustEvidenceRequest {
  readonly v: 1;
  readonly homeId: string;
  readonly knownHeads: readonly {
    readonly seq: number;
    readonly eventDigest: string;
  }[];
}

interface TrustEvidenceResult {
  readonly v: 1;
  readonly prefix: { readonly seq: number; readonly eventDigest: string };
  readonly events: readonly HomeTrustEvent[];
  readonly record: HomeTrustRecord;
}

export interface DisasterRecoveryPeerEvidence {
  readonly deviceId: string;
  readonly events: readonly HomeTrustEvent[];
  readonly record: HomeTrustRecord;
}

export interface DisasterRecoveryReachabilityEvidence {
  readonly cut: readonly string[];
  readonly evidence: readonly DisasterRecoveryPeerEvidence[];
  readonly digest: string;
}

export function registerDisasterRecoveryTrustEvidenceService(
  registry: MeshServiceRegistry,
  options: {
    readonly store: FileMeshBootstrapStore;
    readonly authorizePeer: (deviceId: string) => boolean;
  },
): () => void {
  return registry.register(DISASTER_RECOVERY_TRUST_EVIDENCE_SERVICE, {
    access: "read",
    availability: "negotiated-version",
    authorize: (connection) => options.authorizePeer(connection.peer.deviceId),
    handler: async (payload) => {
      const request = decodeRequest(payload);
      const [events, record] = await Promise.all([
        options.store.loadTrustEvents(),
        options.store.loadTrustRecord(),
      ]);
      if (!record || record.homeId !== request.homeId || events.length === 0) {
        throw new Error("Disaster recovery trust evidence has no matching home");
      }
      const known = new Map(request.knownHeads.map((head) => [head.seq, head.eventDigest]));
      const prefixEvent = [...events].reverse().find((event) =>
        known.get(event.seq) === homeTrustEventDigest(event));
      if (!prefixEvent) {
        throw new Error("Disaster recovery trust evidence has no common signed ancestor");
      }
      return encode({
        v: 1,
        prefix: {
          seq: prefixEvent.seq,
          eventDigest: homeTrustEventDigest(prefixEvent),
        },
        events: events.filter((event) => event.seq > prefixEvent.seq),
        record,
      } satisfies TrustEvidenceResult);
    },
  });
}

export async function collectDisasterRecoveryTrustEvidence(input: {
  readonly store: FileMeshBootstrapStore;
  readonly localDeviceId: string;
  readonly peers: readonly {
    readonly deviceId: string;
    readonly client: MeshServiceClient;
  }[];
  readonly signal: AbortSignal;
}): Promise<DisasterRecoveryReachabilityEvidence> {
  const [localEvents, localRecord] = await Promise.all([
    input.store.loadTrustEvents(),
    input.store.loadTrustRecord(),
  ]);
  if (!localRecord || localEvents.length === 0) {
    throw new Error("Local disaster recovery trust evidence is unavailable");
  }
  const uniquePeers = [...new Map(input.peers.map((peer) => [peer.deviceId, peer])).values()]
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId, "en-US"));
  const cut = Object.freeze([
    input.localDeviceId,
    ...uniquePeers.map((peer) => peer.deviceId),
  ].sort((left, right) => left.localeCompare(right, "en-US")));
  const knownHeads = localEvents.map((event) => ({
    seq: event.seq,
    eventDigest: homeTrustEventDigest(event),
  }));
  const peerEvidence = await Promise.all(uniquePeers.map(async (peer) => {
    const result = decodeResult(await peer.client.request(
      DISASTER_RECOVERY_TRUST_EVIDENCE_SERVICE,
      encode({ v: 1, homeId: localRecord.homeId, knownHeads } satisfies TrustEvidenceRequest),
      input.signal,
    ));
    const prefixIndex = localEvents.findIndex((event) =>
      event.seq === result.prefix.seq &&
      homeTrustEventDigest(event) === result.prefix.eventDigest);
    if (prefixIndex < 0) {
      throw new Error("Peer trust evidence changed its requested ancestor");
    }
    const events = Object.freeze([
      ...localEvents.slice(0, prefixIndex + 1),
      ...result.events,
    ]);
    return validateEvidence(peer.deviceId, localRecord.homeId, events, result.record);
  }));
  const localEvidence = validateEvidence(
    input.localDeviceId,
    localRecord.homeId,
    localEvents,
    localRecord,
  );
  const evidence = Object.freeze([localEvidence, ...peerEvidence]
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId, "en-US")));
  return Object.freeze({
    cut,
    evidence,
    digest: protocolDigest("DisasterRecoveryReachabilityEvidence", 1, {
      cut,
      evidence: evidence.map((item) => ({
        deviceId: item.deviceId,
        chainHead: item.record.chainHead,
        trustEpoch: item.record.trustEpoch,
        recordDigest: protocolDigest("HomeTrustRecord", 1, item.record),
      })),
    }),
  });
}

function validateEvidence(
  deviceId: string,
  homeId: string,
  events: readonly HomeTrustEvent[],
  record: HomeTrustRecord,
): DisasterRecoveryPeerEvidence {
  const projection = replayTrustChain(events);
  verifyHomeTrustRecord(record, projection);
  if (projection.homeId !== homeId || record.homeId !== homeId) {
    throw new Error("Disaster recovery trust evidence belongs to another home");
  }
  const member = projection.members.find((candidate) =>
    candidate.device.deviceId === deviceId);
  if (!member || member.state !== "active") {
    throw new Error("Disaster recovery trust evidence peer is not an active member");
  }
  return Object.freeze({
    deviceId,
    events: Object.freeze(events.map((event) => structuredClone(event))),
    record: structuredClone(record),
  });
}

function decodeRequest(bytes: Uint8Array): TrustEvidenceRequest {
  const value = decode(bytes);
  if (!isRecord(value) || value.v !== 1 || typeof value.homeId !== "string" ||
    !Array.isArray(value.knownHeads) ||
    canonicalize(Object.keys(value).sort()) !== canonicalize(["homeId", "knownHeads", "v"])) {
    throw new TypeError("Disaster recovery trust evidence request is invalid");
  }
  for (const head of value.knownHeads) {
    if (!isRecord(head) || !Number.isSafeInteger(head.seq) || (head.seq as number) < 0 ||
      typeof head.eventDigest !== "string" ||
      canonicalize(Object.keys(head).sort()) !== canonicalize(["eventDigest", "seq"])) {
      throw new TypeError("Disaster recovery trust evidence ancestor is invalid");
    }
  }
  return value as unknown as TrustEvidenceRequest;
}

function decodeResult(bytes: Uint8Array): TrustEvidenceResult {
  const value = decode(bytes);
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.prefix) ||
    !Array.isArray(value.events) || !isRecord(value.record) ||
    canonicalize(Object.keys(value).sort()) !== canonicalize(["events", "prefix", "record", "v"]) ||
    canonicalize(Object.keys(value.prefix).sort()) !== canonicalize(["eventDigest", "seq"]) ||
    !Number.isSafeInteger(value.prefix.seq) || (value.prefix.seq as number) < 0 ||
    typeof value.prefix.eventDigest !== "string") {
    throw new TypeError("Disaster recovery trust evidence result is invalid");
  }
  return value as unknown as TrustEvidenceResult;
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function decode(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) {
    throw new TypeError("Disaster recovery trust evidence payload is not canonical");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
