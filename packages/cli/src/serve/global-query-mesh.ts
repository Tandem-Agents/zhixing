import type {
  AssignmentGlobalQueryPort,
  AuthorityCapability,
  GlobalQuery,
  GlobalReadResult,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  protocolDigest,
  validateAuthorityCapability,
  validateGlobalQuery,
  validateGlobalQueryResult,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";

const GLOBAL_QUERY_SERVICE = "authority.global.read";

type GlobalQueryRequest = {
  readonly query: GlobalQuery;
  readonly capability: AuthorityCapability;
  readonly anchorEpoch: number;
  readonly requestId: string;
  readonly deadlineAt: string;
};

/** Authenticated, path-free assignment read facade for remote executors. */
export class MeshAssignmentGlobalQueryPort implements AssignmentGlobalQueryPort {
  constructor(
    private readonly client: MeshServiceClient,
    private readonly capability: AuthorityCapability,
    private readonly anchorEpoch: number,
  ) {}

  async read(query: GlobalQuery): Promise<GlobalReadResult> {
    const request: GlobalQueryRequest = {
      query: validateGlobalQuery(query),
      capability: this.capability,
      anchorEpoch: this.anchorEpoch,
      requestId: `global-read:${protocolDigest("AssignmentGlobalQuery", 1, query)}`,
      deadlineAt: this.capability.expiry,
    };
    return validateGlobalQueryResult(
      request.query,
      decode(await this.client.request(GLOBAL_QUERY_SERVICE, encode(request))),
    );
  }
}

export function registerGlobalQueryMeshService(
  registry: MeshServiceRegistry,
  state: GlobalStatePort,
  verifier: ProtocolSignatureVerifier,
  executorIdForPeer: (deviceId: string) => string | undefined,
): () => void {
  return registry.register(GLOBAL_QUERY_SERVICE, {
    access: "read",
    availability: "negotiated-version",
    authorize: (connection) => executorIdForPeer(connection.peer.deviceId) !== undefined,
    handler: async (payload, connection, signal) => {
      signal.throwIfAborted();
      const request = validateRequest(decode(payload), verifier);
      if (executorIdForPeer(connection.peer.deviceId) !== request.capability.executorId) {
        throw new Error("Global query capability is bound to another executor");
      }
      const result = await state.read(request.query, {
        principal: { kind: "assignment", capability: request.capability },
        requestId: request.requestId,
        deadlineAt: request.deadlineAt,
        authority: { domain: "global", anchorEpoch: request.anchorEpoch },
      });
      signal.throwIfAborted();
      return encode(validateGlobalQueryResult(request.query, result));
    },
  });
}

function validateRequest(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): GlobalQueryRequest {
  const value = object(input, "Global query request");
  exactKeys(value, ["query", "capability", "anchorEpoch", "requestId", "deadlineAt"]);
  const capability = validateAuthorityCapability(value.capability, verifier);
  const anchorEpoch = positiveInteger(value.anchorEpoch, "Global query anchor epoch");
  if (
    ("ownerEpoch" in capability && capability.ownerEpoch !== anchorEpoch) ||
    ("anchorEpoch" in capability && capability.anchorEpoch !== anchorEpoch)
  ) {
    throw new TypeError("Global query authority fence is not capability-bound");
  }
  return {
    query: validateGlobalQuery(value.query),
    capability,
    anchorEpoch,
    requestId: nonEmptyString(value.requestId, "Global query request id"),
    deadlineAt: isoTime(value.deadlineAt, "Global query deadline"),
  };
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(label);
  return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !optional.includes(key) && !(key in value))) {
    throw new TypeError("Protocol object has invalid keys");
  }
}

function nonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim().length === 0) invalid(label);
  return input;
}

function positiveInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || Number(input) <= 0) invalid(label);
  return Number(input);
}

function isoTime(input: unknown, label: string): string {
  const value = nonEmptyString(input, label);
  if (!Number.isFinite(Date.parse(value))) invalid(label);
  return value;
}

function invalid(label: string): never {
  throw new TypeError(`${label} is invalid`);
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function decode(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("Global query payload is not JSON");
  }
  if (canonicalize(value) !== text) throw new TypeError("Global query payload is not canonical");
  return value;
}
