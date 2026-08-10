import type {
  DeviceRole,
  ReadyProof,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  createSignedReadyProof,
  validateReadyProof,
} from "@zhixing/core/protocol";
import { canonicalize } from "./canonical.js";
import {
  DeviceKey,
  deviceIdFromPublicKey,
  verifyDeviceSignature,
} from "./device-identity.js";
import { loadOrCreateAnchorIssuerKey } from "./device-key-store.js";
import type { TrustProjection } from "./trust-chain.js";

export interface AnchorTransferReadySnapshot {
  readonly configuredCapabilities: {
    readonly providers: readonly string[];
    readonly mcpServers: readonly string[];
    readonly channels: readonly string[];
  };
  readonly protocolRevision: string;
  readonly assetRevision: string;
  readonly serviceRevision: string;
  readonly credentialRevision: string;
}

export async function createAnchorTransferReadyProof(input: {
  readonly requestId: string;
  readonly transferId: string;
  readonly candidateDigest: string;
  readonly targetIdentityKey: DeviceKey;
  readonly trust: TrustProjection;
  readonly secretStore: SecretStorePort;
  readonly snapshot: AnchorTransferReadySnapshot;
  readonly now?: number;
  readonly ttlMs?: number;
}): Promise<{ readonly proof: ReadyProof; readonly issuerKey: DeviceKey }> {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("Ready proof time bounds are invalid");
  }
  const member = readyTarget(input.trust, input.targetIdentityKey.deviceId);
  if (input.trust.issuer.deviceId === member.device.deviceId) {
    throw new TypeError("Current duty device cannot be its own migration target");
  }
  if ((await input.secretStore.unlockState()) !== "unlocked") {
    throw new Error("Target credentials are not unlocked");
  }
  const issuerKey = await loadOrCreateAnchorIssuerKey(
    input.secretStore,
    input.transferId,
  );
  const proof = createSignedReadyProof({
    v: 1,
    requestId: input.requestId,
    transferId: input.transferId,
    homeId: input.trust.homeId,
    candidateDigest: input.candidateDigest,
    targetDeviceId: member.device.deviceId,
    trustEpoch: input.trust.trustEpoch,
    trustChainHead: { ...input.trust.chainHead },
    targetIssuerKeyId: issuerKey.deviceId,
    targetIssuerPublicKey: issuerKey.publicKey,
    roles: canonicalRoles(member.roles),
    configuredCapabilities: {
      providers: canonicalStrings(input.snapshot.configuredCapabilities.providers),
      mcpServers: canonicalStrings(input.snapshot.configuredCapabilities.mcpServers),
      channels: canonicalStrings(input.snapshot.configuredCapabilities.channels),
    },
    protocolRevision: stableRevision(input.snapshot.protocolRevision, "protocol"),
    assetRevision: stableRevision(input.snapshot.assetRevision, "asset"),
    serviceRevision: stableRevision(input.snapshot.serviceRevision, "service"),
    credentialRevision: stableRevision(input.snapshot.credentialRevision, "credential"),
    secretStore: "unlocked",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  }, input.targetIdentityKey, issuerKey);
  return { proof: Object.freeze(proof), issuerKey };
}

export function validateAnchorTransferReadyProof(input: {
  readonly proof: unknown;
  readonly trust: TrustProjection;
  readonly targetDeviceId: string;
  readonly expected?: AnchorTransferReadySnapshot;
  readonly expectedIdentity?: {
    readonly requestId: string;
    readonly candidateDigest: string;
  };
  readonly now?: number;
}): ReadyProof {
  const member = readyTarget(input.trust, input.targetDeviceId);
  if (input.trust.issuer.deviceId === input.targetDeviceId) {
    throw new TypeError("Current duty device cannot be its own migration target");
  }
  const candidate = input.proof as Partial<ReadyProof>;
  if (
    candidate.targetDeviceId !== input.targetDeviceId ||
    (input.expectedIdentity !== undefined &&
      (candidate.requestId !== input.expectedIdentity.requestId ||
        candidate.candidateDigest !== input.expectedIdentity.candidateDigest)) ||
    candidate.homeId !== input.trust.homeId ||
    candidate.trustEpoch !== input.trust.trustEpoch ||
    canonicalize(candidate.trustChainHead) !== canonicalize(input.trust.chainHead) ||
    typeof candidate.targetIssuerPublicKey !== "string" ||
    deviceIdFromPublicKey(candidate.targetIssuerPublicKey) !== candidate.targetIssuerKeyId
  ) {
    throw new TypeError("Ready proof does not bind the current trusted target generation");
  }
  const issuerIdentity = {
    ...member.device,
    deviceId: candidate.targetIssuerKeyId,
    publicKey: candidate.targetIssuerPublicKey,
  };
  const proof = validateReadyProof(
    input.proof,
    { verify: (schemaId, version, payload, signature) =>
      verifyDeviceSignature(member.device, schemaId, version, payload, signature) },
    { verify: (schemaId, version, payload, signature) =>
      verifyDeviceSignature(issuerIdentity, schemaId, version, payload, signature) },
    input.now ?? Date.now(),
  );
  if (canonicalize(proof.roles) !== canonicalize(canonicalRoles(member.roles))) {
    throw new TypeError("Ready proof role set changed from the current trust chain");
  }
  if (input.expected) {
    const actual = {
      configuredCapabilities: proof.configuredCapabilities,
      protocolRevision: proof.protocolRevision,
      assetRevision: proof.assetRevision,
      serviceRevision: proof.serviceRevision,
      credentialRevision: proof.credentialRevision,
    };
    const expected = {
      configuredCapabilities: {
        providers: canonicalStrings(input.expected.configuredCapabilities.providers),
        mcpServers: canonicalStrings(input.expected.configuredCapabilities.mcpServers),
        channels: canonicalStrings(input.expected.configuredCapabilities.channels),
      },
      protocolRevision: input.expected.protocolRevision,
      assetRevision: input.expected.assetRevision,
      serviceRevision: input.expected.serviceRevision,
      credentialRevision: input.expected.credentialRevision,
    };
    if (canonicalize(actual) !== canonicalize(expected)) {
      throw new TypeError("Ready proof configuration changed before migration");
    }
  }
  return proof;
}

function readyTarget(trust: TrustProjection, deviceId: string) {
  const member = trust.members.find((candidate) => candidate.device.deviceId === deviceId);
  if (!member || member.state !== "active" || !member.roles.includes("anchor")) {
    throw new TypeError("Migration target must be a paired active duty-capable device");
  }
  return member;
}

function canonicalRoles(roles: readonly DeviceRole[]): readonly DeviceRole[] {
  return Object.freeze([...new Set(roles)].sort((left, right) => left.localeCompare(right, "en-US")));
}

function canonicalStrings(values: readonly string[]): readonly string[] {
  const result = [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
  if (result.some((value) => !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/u.test(value))) {
    throw new TypeError("Ready capability identifiers must be stable and non-secret");
  }
  return Object.freeze(result);
}

function stableRevision(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/u.test(value)) {
    throw new TypeError(`Ready ${label} revision is invalid`);
  }
  return value;
}
