import type {
  EvidenceExecutionResult,
  EvidenceHandlerPort,
  EvidenceRequest,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  validateEvidenceBundle,
  validateEvidenceRequest,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";

const EVIDENCE_SERVICE = "advancement.evidence.collect";

export class EvidenceMeshClient implements EvidenceHandlerPort {
  constructor(
    private readonly client: MeshServiceClient,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  async collect(
    request: EvidenceRequest,
    abort: AbortSignal,
  ): Promise<EvidenceExecutionResult> {
    return decodeResult(
      await this.client.request(
        EVIDENCE_SERVICE,
        encode(validateEvidenceRequest(request, this.verifier)),
        abort,
      ),
      this.verifier,
    );
  }
}

export function registerEvidenceMeshService(
  registry: MeshServiceRegistry,
  handler: EvidenceHandlerPort,
  verifier: ProtocolSignatureVerifier,
  authorizePeer: (deviceId: string) => boolean,
): () => void {
  return registry.register(EVIDENCE_SERVICE, {
    access: "read",
    availability: "negotiated-version",
    authorize: (connection) => authorizePeer(connection.peer.deviceId),
    handler: async (payload, _connection, signal) => {
      const request = validateEvidenceRequest(decode(payload), verifier);
      return encode(await handler.collect(request, signal));
    },
  });
}

function decodeResult(
  bytes: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): EvidenceExecutionResult {
  const value = decode(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Evidence response is invalid");
  }
  const result = value as Record<string, unknown>;
  if (result.kind === "capability-gap" && Object.keys(result).length === 1) {
    return { kind: "capability-gap" };
  }
  if (result.kind === "bundle" && Object.keys(result).length === 2) {
    return {
      kind: "bundle",
      bundle: validateEvidenceBundle(result.bundle, verifier),
    };
  }
  throw new TypeError("Evidence response is invalid");
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
    throw new TypeError("Evidence payload is not JSON");
  }
  if (canonicalize(value) !== text) {
    throw new TypeError("Evidence payload is not canonical");
  }
  return value;
}
