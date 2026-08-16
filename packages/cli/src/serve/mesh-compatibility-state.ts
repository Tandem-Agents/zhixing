import { validateProtocolVersion } from "@zhixing/core/protocol";
import type {
  MeshConnectionProjectionEntry,
  MeshConnectionProjectionPort,
} from "@zhixing/mesh/bootstrap";
import type {
  PidFileContents,
  ServerStateFile,
  ServerStateSnapshot,
} from "@zhixing/server";

export const MESH_COMPATIBILITY_EXTENSION_KEY = "meshCompatibility";

export interface MeshCompatibilityHostGeneration {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startTime: number | null;
  readonly startedAt: string;
}

export type MeshCompatibilityProjectionHealth =
  | { readonly kind: "healthy" }
  | { readonly kind: "local-older" }
  | { readonly kind: "peers-older"; readonly peerDisplayNames: readonly string[] }
  | { readonly kind: "unknown" };

interface MeshCompatibilityStateV1 {
  readonly version: 1;
  readonly hostGeneration: MeshCompatibilityHostGeneration;
  readonly connections: readonly MeshConnectionProjectionEntry[];
}

export function createMeshCompatibilityStateProjection(
  stateFile: ServerStateFile,
  hostGeneration: MeshCompatibilityHostGeneration,
): MeshConnectionProjectionPort {
  const host = validateHostGeneration(hostGeneration);
  return Object.freeze({
    replaceCurrent: async (connections: readonly MeshConnectionProjectionEntry[]) => {
      const projection = validateMeshCompatibilityState({
        version: 1,
        hostGeneration: host,
        connections: [...connections],
      });
      await stateFile.replaceExtension(MESH_COMPATIBILITY_EXTENSION_KEY, projection);
    },
  });
}

export function projectMeshCompatibilityHealth(
  lock: PidFileContents,
  state: ServerStateSnapshot | null,
): MeshCompatibilityProjectionHealth {
  if (!state || !sameStateGeneration(lock, state)) return { kind: "unknown" };
  let projection: MeshCompatibilityStateV1;
  try {
    projection = validateMeshCompatibilityState(
      state.extensions?.[MESH_COMPATIBILITY_EXTENSION_KEY],
    );
  } catch {
    return { kind: "unknown" };
  }
  if (!sameHostGeneration(lock, projection.hostGeneration)) return { kind: "unknown" };
  if (projection.connections.length === 0) return { kind: "healthy" };

  const olderPeers: string[] = [];
  for (const connection of projection.connections) {
    if (connection.compatibility.mode === "read-write") continue;
    if (compareVersions(connection.localRange.max, connection.peerRange.min) < 0) {
      return { kind: "local-older" };
    }
    if (compareVersions(connection.peerRange.max, connection.localRange.min) < 0) {
      olderPeers.push(connection.peerDisplayName);
      continue;
    }
    return { kind: "unknown" };
  }
  if (olderPeers.length === 0) return { kind: "healthy" };
  return {
    kind: "peers-older",
    peerDisplayNames: Object.freeze(olderPeers.sort(ordinalCompare)),
  };
}

function validateMeshCompatibilityState(value: unknown): MeshCompatibilityStateV1 {
  const record = exactRecord(value, ["connections", "hostGeneration", "version"]);
  if (record.version !== 1 || !Array.isArray(record.connections)) {
    throw new TypeError("Mesh compatibility projection is invalid");
  }
  const hostGeneration = validateHostGeneration(record.hostGeneration);
  const connections = record.connections.map(validateConnection);
  for (let index = 1; index < connections.length; index += 1) {
    if (compareConnection(connections[index - 1]!, connections[index]!) >= 0) {
      throw new TypeError("Mesh compatibility connections must be an ordinal exact-set");
    }
  }
  return Object.freeze({
    version: 1,
    hostGeneration,
    connections: Object.freeze(connections),
  });
}

function validateHostGeneration(value: unknown): MeshCompatibilityHostGeneration {
  const record = exactRecord(value, ["host", "pid", "port", "startedAt", "startTime"]);
  if (
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) < 1 ||
    !Number.isSafeInteger(record.port) ||
    (record.port as number) < 1 ||
    (record.port as number) > 65_535 ||
    (record.startTime !== null && !Number.isFinite(record.startTime)) ||
    !isStableText(record.host, 255) ||
    !isStableText(record.startedAt, 128)
  ) {
    throw new TypeError("Mesh compatibility host generation is invalid");
  }
  return Object.freeze({
    pid: record.pid as number,
    host: record.host,
    port: record.port as number,
    startTime: record.startTime as number | null,
    startedAt: record.startedAt,
  });
}

function validateConnection(value: unknown): MeshConnectionProjectionEntry {
  const record = exactRecord(value, [
    "compatibility",
    "connectionId",
    "localRange",
    "peerDeviceId",
    "peerDisplayName",
    "peerRange",
  ]);
  if (
    !isStableText(record.connectionId, 480) ||
    !isStableText(record.peerDeviceId, 480) ||
    !isStableText(record.peerDisplayName, 255)
  ) {
    throw new TypeError("Mesh compatibility connection identity is invalid");
  }
  const localRange = validateRange(record.localRange);
  const peerRange = validateRange(record.peerRange);
  const compatibility = validateCompatibility(record.compatibility);
  const lower = maxVersion(localRange.min, peerRange.min);
  const upper = minVersion(localRange.max, peerRange.max);
  const rangesOverlap = compareVersions(lower, upper) <= 0;
  if (
    (compatibility.mode === "read-write" &&
      (!rangesOverlap || compatibility.protocolVersion !== upper)) ||
    (compatibility.mode === "read-only" && rangesOverlap)
  ) {
    throw new TypeError("Mesh compatibility result does not match its ranges");
  }
  return Object.freeze({
    connectionId: record.connectionId,
    peerDeviceId: record.peerDeviceId,
    peerDisplayName: record.peerDisplayName,
    localRange,
    peerRange,
    compatibility,
  });
}

function validateRange(value: unknown): MeshConnectionProjectionEntry["localRange"] {
  const record = exactRecord(value, ["max", "min"]);
  const min = validateProtocolVersion(record.min);
  const max = validateProtocolVersion(record.max);
  if (compareVersions(min, max) > 0) throw new TypeError("Mesh protocol range is invalid");
  return Object.freeze({ min, max });
}

function validateCompatibility(
  value: unknown,
): MeshConnectionProjectionEntry["compatibility"] {
  if (!isPlainRecord(value) || typeof value.mode !== "string") {
    throw new TypeError("Mesh compatibility result is invalid");
  }
  if (value.mode === "read-write") {
    const record = exactRecord(value, ["mode", "protocolVersion"]);
    return Object.freeze({
      mode: "read-write",
      protocolVersion: validateProtocolVersion(record.protocolVersion),
    });
  }
  const record = exactRecord(value, ["mode", "reason"]);
  if (record.mode !== "read-only" || record.reason !== "incompatible-version") {
    throw new TypeError("Mesh compatibility result is invalid");
  }
  return Object.freeze({ mode: "read-only", reason: "incompatible-version" });
}

function sameStateGeneration(lock: PidFileContents, state: ServerStateSnapshot): boolean {
  return state.pid === lock.pid &&
    state.port === lock.port &&
    state.host === lock.host &&
    state.startedAt === lock.startedAt;
}

function sameHostGeneration(
  lock: PidFileContents,
  generation: MeshCompatibilityHostGeneration,
): boolean {
  return generation.pid === lock.pid &&
    generation.port === lock.port &&
    generation.host === lock.host &&
    generation.startTime === lock.startTime &&
    generation.startedAt === lock.startedAt;
}

function compareConnection(
  left: MeshConnectionProjectionEntry,
  right: MeshConnectionProjectionEntry,
): number {
  const peer = ordinalCompare(left.peerDeviceId, right.peerDeviceId);
  return peer !== 0 ? peer : ordinalCompare(left.connectionId, right.connectionId);
}

function compareVersions(left: string, right: string): number {
  const lhs = BigInt(left);
  const rhs = BigInt(right);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

function minVersion(left: string, right: string): string {
  return compareVersions(left, right) <= 0 ? left : right;
}

function maxVersion(left: string, right: string): string {
  return compareVersions(left, right) >= 0 ? left : right;
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError("Expected a plain object");
  const actual = Object.keys(value).sort(ordinalCompare);
  const expected = [...keys].sort(ordinalCompare);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("Object keys do not match the exact schema");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStableText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
