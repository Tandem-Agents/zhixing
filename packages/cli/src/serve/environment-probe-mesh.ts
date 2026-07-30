import type {
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "@zhixing/core/contracts";
import type { WorkspaceProbePort } from "@zhixing/core/environment";
import {
  canonicalize,
  validateWorkspaceProbeRequest,
  validateWorkspaceProbeResult,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";

const ENVIRONMENT_PROBE_SERVICE = "environment.probe";

/** Path-free mesh adapter for the executor-local workspace probe authority. */
export class EnvironmentProbeMeshClient implements WorkspaceProbePort {
  constructor(
    private readonly client: MeshServiceClient,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  async probe(
    request: WorkspaceProbeRequest,
    abort?: AbortSignal,
  ): Promise<WorkspaceProbeResult> {
    return validateWorkspaceProbeResult(
      decode(
        await this.client.request(
          ENVIRONMENT_PROBE_SERVICE,
          encode(validateWorkspaceProbeRequest(request, this.verifier)),
          abort,
        ),
      ),
      this.verifier,
    );
  }
}

export function registerEnvironmentProbeMeshService(
  registry: MeshServiceRegistry,
  probe: WorkspaceProbePort,
  verifier: ProtocolSignatureVerifier,
  authorizePeer: (deviceId: string) => boolean,
): () => void {
  return registry.register(ENVIRONMENT_PROBE_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => authorizePeer(connection.peer.deviceId),
    handler: async (payload, _connection, signal) => {
      signal.throwIfAborted();
      const request = validateWorkspaceProbeRequest(
        decode(payload),
        verifier,
      );
      const result = await probe.probe(request, signal);
      signal.throwIfAborted();
      return encode(validateWorkspaceProbeResult(result, verifier));
    },
  });
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
    throw new TypeError("Environment probe payload is not JSON");
  }
  if (canonicalize(value) !== text) {
    throw new TypeError("Environment probe payload is not canonical");
  }
  return value;
}
