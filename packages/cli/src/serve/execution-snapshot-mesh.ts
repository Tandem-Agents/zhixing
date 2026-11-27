import type {
  ExecutionAssetBundle,
  TrustRuleSnapshot,
} from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  type ExecutorCapabilitySnapshot,
  validateExecutionAssetSnapshot,
  validateExecutorCapabilitySnapshot,
  validateTrustRuleSnapshot,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import type { MeshServiceClient } from "@zhixing-ai/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing-ai/mesh/service-registry";
import type { ExecutionAssetV2SyncSource } from "./execution-asset-cache.js";
import {
  ExecutionAssetV2UnsupportedError,
  syncExecutionAssetsV2OverMesh,
  type ExecutionSnapshotV2SyncHandler,
} from "./execution-snapshot-v2-sync.js";
import { executorSupportsCrossDeviceV2 } from "./workscene-runtime-projection.js";

const EXECUTION_SNAPSHOT_SERVICE = "execution.snapshot";

type ExecutionSnapshotRequest =
  | { readonly v: 1; readonly method: "read-capability" }
  | {
      readonly v: 1;
      readonly method: "install-permission";
      readonly snapshot: TrustRuleSnapshot;
    }
  | {
      readonly v: 1;
      readonly method: "install-assets";
      readonly bundle: ExecutionAssetBundle;
    };

export type ExecutionAssetBundleProvider =
  | ExecutionAssetBundle
  | (() => Promise<ExecutionAssetBundle | undefined>)
  | undefined;

export interface ExecutionSnapshotPublisher {
  currentCapability(): Promise<ExecutorCapabilitySnapshot>;
  installPermission(snapshot: TrustRuleSnapshot): Promise<ExecutorCapabilitySnapshot>;
  installAssets(bundle: ExecutionAssetBundle): Promise<ExecutorCapabilitySnapshot>;
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
    executionAssets?: ExecutionAssetBundleProvider,
    executionAssetsV2OrSignal?: ExecutionAssetV2SyncSource | AbortSignal,
    maybeSignal?: AbortSignal,
  ): Promise<ExecutorCapabilitySnapshot> {
    const executionAssetsV2 =
      executionAssetsV2OrSignal && !(executionAssetsV2OrSignal instanceof AbortSignal)
        ? executionAssetsV2OrSignal
        : undefined;
    const signal =
      executionAssetsV2OrSignal instanceof AbortSignal
        ? executionAssetsV2OrSignal
        : maybeSignal;
    const validated = validateTrustRuleSnapshot(snapshot, this.verifier);
    const permissionResult = validateExecutorCapabilitySnapshot(
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
    const peerSupportsV2 = executorSupportsCrossDeviceV2(permissionResult.descriptor);
    if (executionAssetsV2 && (peerSupportsV2 || executionAssets === undefined)) {
      try {
        return await syncExecutionAssetsV2OverMesh({
          client: this.client,
          verifier: this.verifier,
          source: executionAssetsV2,
          signal,
        });
      } catch (error) {
        if (
          !(error instanceof ExecutionAssetV2UnsupportedError) ||
          peerSupportsV2 ||
          executionAssets === undefined
        ) {
          throw error;
        }
      }
    }
    if (executionAssets === undefined) return permissionResult;
    const resolvedAssets =
      typeof executionAssets === "function" ? await executionAssets() : executionAssets;
    if (!resolvedAssets) return permissionResult;
    const bundle = decodeExecutionAssetBundle(resolvedAssets, this.verifier);
    return validateExecutorCapabilitySnapshot(
      decode(await this.client.request(
        EXECUTION_SNAPSHOT_SERVICE,
        encode({ v: 1, method: "install-assets", bundle } satisfies ExecutionSnapshotRequest),
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
  v2Sync?: ExecutionSnapshotV2SyncHandler,
): () => void {
  return registry.register(EXECUTION_SNAPSHOT_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    handler: async (payload, connection, signal) => {
      signal.throwIfAborted();
      const raw = decode(payload);
      if (isRecord(raw) && raw.v === 2 && v2Sync) {
        const result = await v2Sync.handleRequest(raw, {
          peerId: connection.peer.deviceId,
          authorizePeer,
          signal,
        });
        signal.throwIfAborted();
        return encode(result);
      }
      const request = decodeRequest(raw, verifier);
      const access = request.method === "read-capability" ? "read" : "write";
      if (!authorizePeer(connection.peer.deviceId, access)) {
        throw new TypeError("Authenticated mesh peer cannot synchronize execution snapshots");
      }
      const snapshot = request.method === "read-capability"
        ? await publisher.currentCapability()
        : request.method === "install-permission"
          ? await publisher.installPermission(request.snapshot)
          : await publisher.installAssets(request.bundle);
      signal.throwIfAborted();
      return encode(validateExecutorCapabilitySnapshot(snapshot, verifier));
    },
  });
}

function decodeRequest(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): ExecutionSnapshotRequest {
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
  if (value.method === "install-assets") {
    assertExactKeys(value, ["bundle", "method", "v"]);
    return {
      v: 1,
      method: "install-assets",
      bundle: decodeExecutionAssetBundle(value.bundle, verifier),
    };
  }
  throw new TypeError("Execution snapshot method is unsupported");
}

function decodeExecutionAssetBundle(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ExecutionAssetBundle {
  if (!isRecord(input)) throw new TypeError("Execution asset bundle is invalid");
  assertExactKeys(input, ["artifacts", "snapshot", "v"]);
  if (input.v !== 1 || !Array.isArray(input.artifacts)) {
    throw new TypeError("Execution asset bundle is invalid");
  }
  const artifacts = input.artifacts.map((item) => {
    if (!isRecord(item)) throw new TypeError("Execution asset bundle artifact is invalid");
    assertExactKeys(item, ["contentBase64", "ref"]);
    if (!isRecord(item.ref)) throw new TypeError("Execution asset bundle ref is invalid");
    assertExactKeys(item.ref, ["bytes", "digest"]);
    if (
      typeof item.ref.digest !== "string" ||
      !Number.isSafeInteger(item.ref.bytes) ||
      (item.ref.bytes as number) < 0 ||
      typeof item.contentBase64 !== "string"
    ) {
      throw new TypeError("Execution asset bundle artifact fields are invalid");
    }
    return {
      ref: { digest: item.ref.digest, bytes: item.ref.bytes as number },
      contentBase64: item.contentBase64,
    };
  });
  return {
    v: 1,
    snapshot: validateExecutionAssetSnapshot(input.snapshot, verifier),
    artifacts,
  };
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
