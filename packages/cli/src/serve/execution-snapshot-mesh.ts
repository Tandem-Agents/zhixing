import type { TrustRuleSnapshot } from "@zhixing/core/contracts";
import {
  canonicalize,
  type ExecutorCapabilitySnapshot,
  validateExecutorCapabilitySnapshot,
  validateTrustRuleSnapshot,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";

const EXECUTION_SNAPSHOT_SERVICE = "execution.snapshot";

type ExecutionSnapshotRequest =
  | { readonly v: 1; readonly method: "read-capability" }
  | {
      readonly v: 1;
      readonly method: "install-permission";
      readonly snapshot: TrustRuleSnapshot;
    };

export interface ExecutionSnapshotPublisher {
  currentCapability(): Promise<ExecutorCapabilitySnapshot>;
  installPermission(snapshot: TrustRuleSnapshot): Promise<ExecutorCapabilitySnapshot>;
}

/** Synchronizes already frozen S4 snapshots before an assignment becomes remotely receivable. */
export class MeshExecutionSnapshotClient {
  constructor(
    private readonly client: MeshServiceClient,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  async currentCapability(signal?: AbortSignal): Promise<ExecutorCapabilitySnapshot> {
    return validateExecutorCapabilitySnapshot(
      decode(await this.client.request(
        EXECUTION_SNAPSHOT_SERVICE,
        encode({ v: 1, method: "read-capability" } satisfies ExecutionSnapshotRequest),
        signal,
      )) as ExecutorCapabilitySnapshot,
      this.verifier,
    );
  }

  async installPermission(
    snapshot: TrustRuleSnapshot,
    signal?: AbortSignal,
  ): Promise<ExecutorCapabilitySnapshot> {
    const validated = validateTrustRuleSnapshot(snapshot, this.verifier);
    return validateExecutorCapabilitySnapshot(
      decode(await this.client.request(
        EXECUTION_SNAPSHOT_SERVICE,
        encode({
          v: 1,
          method: "install-permission",
          snapshot: validated,
        } satisfies ExecutionSnapshotRequest),
        signal,
      )) as ExecutorCapabilitySnapshot,
      this.verifier,
    );
  }
}

export function registerExecutionSnapshotMeshService(
  registry: MeshServiceRegistry,
  publisher: ExecutionSnapshotPublisher,
  authorizePeer: (deviceId: string, access: "read" | "write") => boolean,
  verifier: ProtocolSignatureVerifier,
): () => void {
  return registry.register(EXECUTION_SNAPSHOT_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    handler: async (payload, connection, signal) => {
      signal.throwIfAborted();
      const request = decodeRequest(payload, verifier);
      const access = request.method === "read-capability" ? "read" : "write";
      if (!authorizePeer(connection.peer.deviceId, access)) {
        throw new TypeError("Authenticated mesh peer cannot synchronize execution snapshots");
      }
      const snapshot = request.method === "read-capability"
        ? await publisher.currentCapability()
        : await publisher.installPermission(request.snapshot);
      signal.throwIfAborted();
      return encode(validateExecutorCapabilitySnapshot(snapshot, verifier));
    },
  });
}

function decodeRequest(
  bytes: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): ExecutionSnapshotRequest {
  const value = decode(bytes);
  if (!isRecord(value) || value.v !== 1) {
    throw new TypeError("Execution snapshot request is invalid");
  }
  if (value.method === "read-capability") {
    assertExactKeys(value, ["method", "v"]);
    return { v: 1, method: "read-capability" };
  }
  if (value.method === "install-permission") {
    assertExactKeys(value, ["method", "snapshot", "v"]);
    return {
      v: 1,
      method: "install-permission",
      snapshot: validateTrustRuleSnapshot(value.snapshot, verifier),
    };
  }
  throw new TypeError("Execution snapshot method is unsupported");
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
    throw new TypeError("Execution snapshot payload is not JSON");
  }
  if (canonicalize(value) !== text) {
    throw new TypeError("Execution snapshot payload is not canonical");
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new TypeError("Execution snapshot request fields are invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
