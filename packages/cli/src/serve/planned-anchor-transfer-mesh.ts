import type {
  AnchorTransferCommand,
  AnchorTransferResult,
  ReadyProof,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  validateAnchorTransferCommand,
  validateAnchorTransferResult,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type {
  PlannedAnchorTransferArtifactSourcePort,
  PlannedAnchorTransferTargetPort,
} from "./planned-anchor-transfer.js";

export const PLANNED_ANCHOR_TRANSFER_READY_SERVICE = "anchor.transfer.ready";
export const PLANNED_ANCHOR_TRANSFER_SERVICE = "anchor.transfer";

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
});

interface ReadyRequest {
  readonly v: 1;
  readonly transferId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
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

  async ready(input: {
    readonly transferId: string;
    readonly sourceDeviceId: string;
  }): Promise<ReadyProof> {
    if (input.sourceDeviceId !== this.sourceDeviceId) {
      throw new TypeError("Migration ready request changed its source device");
    }
    return decode(await this.client.request(
      PLANNED_ANCHOR_TRANSFER_READY_SERVICE,
      encode({
        v: 1,
        transferId: input.transferId,
        sourceDeviceId: this.sourceDeviceId,
        targetDeviceId: this.targetDeviceId,
      } satisfies ReadyRequest),
    )) as ReadyProof;
  }

  async apply(command: AnchorTransferCommand): Promise<AnchorTransferResult> {
    const result = validateAnchorTransferResult(
      decode(await this.client.request(
        PLANNED_ANCHOR_TRANSFER_SERVICE,
        encode(command),
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
  },
): () => void {
  const authorize = (deviceId: string) =>
    deviceId === options.currentSourceDeviceId();
  const disposeReady = registry.register(
    PLANNED_ANCHOR_TRANSFER_READY_SERVICE,
    {
      access: "write",
      availability: "negotiated-version",
      authorize: (connection) => authorize(connection.peer.deviceId),
      handler: async (payload, connection) => {
        const request = readyRequest(decode(payload));
        if (
          request.sourceDeviceId !== connection.peer.deviceId ||
          request.sourceDeviceId !== options.currentSourceDeviceId() ||
          request.targetDeviceId !== options.targetDeviceId
        ) {
          throw new TypeError("Migration ready request does not bind its authenticated devices");
        }
        const target = options.target();
        if (!target) throw new Error("Migration target receiver is unavailable");
        return encode(await target.ready(request));
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
      return encode(await target.apply(command));
    },
  });
  return () => {
    disposeCommand();
    disposeReady();
  };
}

export function registerPlannedAnchorTransferSourceMeshService(
  registry: MeshServiceRegistry,
  options: {
    readonly source: () => PlannedAnchorTransferArtifactSourcePort | undefined;
    readonly authorizeTarget: (deviceId: string) => boolean;
    readonly verifier: ProtocolSignatureVerifier;
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
      return encode(await source.applyArtifactCommand(command));
    },
  });
}

function readyRequest(input: unknown): ReadyRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Migration ready request must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    canonicalize(Object.keys(value).sort()) !==
      canonicalize(["sourceDeviceId", "targetDeviceId", "transferId", "v"]) ||
    value.v !== 1 ||
    typeof value.transferId !== "string" ||
    typeof value.sourceDeviceId !== "string" ||
    typeof value.targetDeviceId !== "string"
  ) {
    throw new TypeError("Migration ready request fields are incomplete or unknown");
  }
  return value as unknown as ReadyRequest;
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
