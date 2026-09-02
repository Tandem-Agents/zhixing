import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import {
  decodePairedCheckpointResult,
  MeshPairedCheckpointTransport,
  PairedRecoveryCheckpointTarget,
  type PairedCheckpointCommand,
  type PairedCheckpointResult,
  type PairedCheckpointTransport,
} from "@zhixing/mesh/paired-checkpoint-target";
import {
  type BorrowedPairedCheckpointTargetSessions,
  type OwnedPairedCheckpointInventorySession,
  type OwnedPairedCheckpointTargetSession,
  type PairedCheckpointTargetBinding,
  projectPairedRecoveryRootActivation,
} from "./paired-checkpoint-target.js";
import {
  type PublishedRecoveryCheckpointTarget,
  projectInventoryPublishedRecoveryCheckpointTarget,
  projectPublishedRecoveryCheckpointTarget,
  projectRetirablePublishedRecoveryCheckpointTarget,
} from "./published-checkpoint-target.js";

interface MeshCheckpointConnectionDirectory {
  readonly client: (deviceId: string) => MeshServiceClient;
}

interface PairingCheckpointFrameExchange {
  readonly send: (frame: unknown) => Promise<void>;
  readonly receive: () => Promise<unknown>;
}

interface PairedCheckpointTargetInfrastructureInput {
  readonly connections: MeshCheckpointConnectionDirectory;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
}

export function createOwnedMeshPairedCheckpointTargetSession(
  input: PairedCheckpointTargetInfrastructureInput & {
    readonly binding: PairedCheckpointTargetBinding;
    readonly closeControlPlane: () => Promise<void>;
  },
): OwnedPairedCheckpointTargetSession {
  const physical = createMeshTarget(input);
  return Object.freeze({
    target: projectRetirablePublishedRecoveryCheckpointTarget(physical),
    rootActivation: projectPairedRecoveryRootActivation(physical),
    close: once(input.closeControlPlane),
  });
}

export function createOwnedMeshPairedCheckpointInventorySession(
  input: PairedCheckpointTargetInfrastructureInput & {
    readonly binding: PairedCheckpointTargetBinding;
    readonly closeControlPlane: () => Promise<void>;
  },
): OwnedPairedCheckpointInventorySession {
  const physical = createMeshTarget(input);
  return Object.freeze({
    target: projectInventoryPublishedRecoveryCheckpointTarget(physical),
    close: once(input.closeControlPlane),
  });
}

export function createBorrowedMeshPairedCheckpointTargetSessions(
  input:
    | {
        readonly kind: "available";
        readonly connections: MeshCheckpointConnectionDirectory;
        readonly storageMaintenance: StorageMaintenanceGovernorPort;
      }
    | {
        readonly kind: "runtime-unavailable";
        readonly storageMaintenance: StorageMaintenanceGovernorPort;
      },
): BorrowedPairedCheckpointTargetSessions {
  return Object.freeze({
    open: async (binding: PairedCheckpointTargetBinding) => {
      if (input.kind === "runtime-unavailable") {
        return Object.freeze({ kind: "runtime-unavailable" as const });
      }
      const physical = createMeshTarget({
        connections: input.connections,
        storageMaintenance: input.storageMaintenance,
        binding,
      });
      return Object.freeze({
        kind: "available" as const,
        session: Object.freeze({
          target: projectRetirablePublishedRecoveryCheckpointTarget(physical),
          close: async () => undefined,
        }),
      });
    },
  });
}

export function createPairingSocketPublishedCheckpointTarget(input: {
  readonly binding: PairedCheckpointTargetBinding;
  readonly exchange: PairingCheckpointFrameExchange;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
}): PublishedRecoveryCheckpointTarget {
  return projectPublishedRecoveryCheckpointTarget(
    createPhysicalTarget(
      input.binding,
      new PairingSocketCheckpointTransport(input.exchange),
      input.storageMaintenance,
    ),
  );
}

function createMeshTarget(
  input: PairedCheckpointTargetInfrastructureInput & {
    readonly binding: PairedCheckpointTargetBinding;
  },
): PairedRecoveryCheckpointTarget {
  return createPhysicalTarget(
    input.binding,
    new MeshPairedCheckpointTransport(input.connections.client(input.binding.targetDeviceId)),
    input.storageMaintenance,
  );
}

function createPhysicalTarget(
  binding: PairedCheckpointTargetBinding,
  transport: PairedCheckpointTransport,
  storageMaintenance: StorageMaintenanceGovernorPort,
): PairedRecoveryCheckpointTarget {
  return new PairedRecoveryCheckpointTarget({
    ...binding,
    transport,
    storageMaintenance,
  });
}

class PairingSocketCheckpointTransport implements PairedCheckpointTransport {
  constructor(private readonly exchange: PairingCheckpointFrameExchange) {}

  async request(command: PairedCheckpointCommand): Promise<PairedCheckpointResult> {
    await this.exchange.send(
      Object.freeze({
        t: "recovery-onboarding-command",
        command,
      }),
    );
    const frame = await this.exchange.receive();
    if (!isRecord(frame) || frame.t !== "recovery-onboarding-result" || !isRecord(frame.result)) {
      throw new Error("Pairing target returned an invalid recovery checkpoint result");
    }
    assertExactKeys(frame, ["result", "t"]);
    return decodePairedCheckpointResult(frame.result);
  }
}

function once(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= close();
    return closing;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== [...expected].sort()[index])
  ) {
    throw new TypeError("Recovery onboarding result contains unexpected fields");
  }
}
