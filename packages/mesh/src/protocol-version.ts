import type { ProtocolVersion } from "@zhixing/core/contracts";

const MAX_PROTOCOL_VERSION = (1n << 64n) - 1n;

/** Inclusive range of monotonically increasing mesh protocol versions. */
export interface MeshProtocolRange {
  readonly min: ProtocolVersion;
  readonly max: ProtocolVersion;
}

export type MeshProtocolCompatibility =
  | {
      readonly mode: "read-write";
      readonly protocolVersion: ProtocolVersion;
    }
  | {
      readonly mode: "read-only";
      readonly reason: "incompatible-version";
    };

export function snapshotMeshProtocolRange(
  range: MeshProtocolRange,
): MeshProtocolRange {
  const min = parseProtocolVersion(range.min);
  const max = parseProtocolVersion(range.max);
  if (max < min) {
    throw new TypeError("Invalid mesh protocol range");
  }
  return Object.freeze({ min: range.min, max: range.max });
}

export function negotiateMeshProtocol(
  local: MeshProtocolRange,
  peer: MeshProtocolRange,
): MeshProtocolCompatibility {
  const localRange = snapshotMeshProtocolRange(local);
  const peerRange = snapshotMeshProtocolRange(peer);
  const lower = maxVersion(localRange.min, peerRange.min);
  const upper = minVersion(localRange.max, peerRange.max);
  if (compareProtocolVersions(lower, upper) > 0) {
    return Object.freeze({
      mode: "read-only" as const,
      reason: "incompatible-version" as const,
    });
  }
  return Object.freeze({
    mode: "read-write" as const,
    protocolVersion: upper,
  });
}

export function sameMeshProtocolCompatibility(
  left: MeshProtocolCompatibility,
  right: MeshProtocolCompatibility,
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode === "read-only" ||
      (right.mode === "read-write" &&
        left.protocolVersion === right.protocolVersion))
  );
}

function parseProtocolVersion(value: ProtocolVersion): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new TypeError(
      "Mesh protocol versions must be canonical positive decimal strings",
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_PROTOCOL_VERSION) {
    throw new TypeError("Mesh protocol version exceeds uint64 range");
  }
  return parsed;
}

function compareProtocolVersions(
  left: ProtocolVersion,
  right: ProtocolVersion,
): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function minVersion(
  left: ProtocolVersion,
  right: ProtocolVersion,
): ProtocolVersion {
  return compareProtocolVersions(left, right) <= 0 ? left : right;
}

function maxVersion(
  left: ProtocolVersion,
  right: ProtocolVersion,
): ProtocolVersion {
  return compareProtocolVersions(left, right) >= 0 ? left : right;
}
