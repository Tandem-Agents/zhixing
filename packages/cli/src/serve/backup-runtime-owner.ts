import path from "node:path";
import { canonicalize } from "@zhixing/core/protocol";
import type { ArtifactCheckpointRetentionPort } from "@zhixing/core/authority";
import type { HomeTrustRecord } from "@zhixing/core/contracts";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { CheckpointPackage, CheckpointSigner } from "@zhixing/mesh/checkpoint";
import type { RecoveryCheckpointVerification } from "@zhixing/core/contracts";
import type { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import {
  AuthorityCheckpointOwner,
  type AuthorityCheckpointOwnerPort,
} from "@zhixing/mesh/checkpoint-owner";
import {
  AuthorityCheckpointService,
  projectDurableRecoveryBackupStatus,
  type RecoveryBackupStatus,
} from "@zhixing/mesh/checkpoint-service";
import {
  FileRecoveryCheckpointTarget,
  type RetirableRecoveryCheckpointTarget,
} from "@zhixing/mesh/checkpoint-target";
import {
  MeshPairedCheckpointTransport,
  PairedRecoveryCheckpointTarget,
} from "@zhixing/mesh/paired-checkpoint-target";
import { keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import { FileBackupTargetConfiguration, type BackupTargetBinding } from "./backup-target-config.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import type { MeshRuntimeAssembly } from "./mesh-runtime-assembly.js";

const TURN_MS = 60 * 60 * 1000;

export async function createConfiguredCheckpointOwner(input: {
  readonly zhixingHome: string;
  readonly mesh: MeshRuntimeBootstrap;
  readonly meshRuntime?: MeshRuntimeAssembly;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly checkpointRetention?: ArtifactCheckpointRetentionPort;
  readonly onError?: (error: unknown) => void;
}): Promise<AuthorityCheckpointOwnerPort | undefined> {
  const trust = await input.mesh.bootstrapStore.loadTrustRecord();
  if (!trust) return undefined;
  assertHomeAuthority(trust, input.mesh.deviceKey.deviceId);
  if (!trust.recoveryBackupPublicKey) return undefined;
  return new ConfiguredCheckpointOwnerSlot(input);
}

type RuntimeSlot =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "unavailable";
      readonly code: BackupUnavailableCode;
      readonly fullBackupReady: boolean;
    }
  | {
      readonly kind: "available";
      readonly fingerprint: string;
      readonly owner: AuthorityCheckpointOwner;
      readonly target: RetirableRecoveryCheckpointTarget;
    };

type BackupUnavailableCode =
  | "configuration-invalid"
  | "target-unavailable"
  | "runtime-unavailable";

class ConfiguredCheckpointOwnerSlot implements AuthorityCheckpointOwnerPort {
  #slot: RuntimeSlot = { kind: "disabled" };
  #loading: Promise<RuntimeSlot> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #started = false;

  constructor(private readonly input: {
    readonly zhixingHome: string;
    readonly mesh: MeshRuntimeBootstrap;
    readonly meshRuntime?: MeshRuntimeAssembly;
    readonly storageMaintenance: StorageMaintenanceGovernorPort;
    readonly checkpointRetention?: ArtifactCheckpointRetentionPort;
    readonly onError?: (error: unknown) => void;
  }) {}

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#reload();
    this.#schedule(0);
  }

  async ensureDaily(): Promise<CheckpointPackage> {
    return (await this.#requireOwner()).ensureDaily();
  }

  async force(requestId: string): Promise<CheckpointPackage> {
    return (await this.#requireOwner()).force(requestId);
  }

  async verify(
    checkpointId: string,
    recoveryRoot: RecoveryRoot,
  ): Promise<RecoveryCheckpointVerification> {
    return (await this.#requireOwner()).verify(checkpointId, recoveryRoot);
  }

  async status(): Promise<RecoveryBackupStatus> {
    const slot = await this.#reload();
    if (slot.kind === "disabled") return { state: "not-configured", fullBackupReady: false };
    if (slot.kind === "unavailable") {
      return {
        state: "unavailable",
        fullBackupReady: slot.fullBackupReady,
        code: slot.code,
      };
    }
    return slot.owner.status();
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#slot.kind === "available") {
      try {
        await this.#slot.owner.stop();
      } finally {
        await this.#slot.target.close?.();
      }
    }
    this.#slot = { kind: "disabled" };
  }

  async #requireOwner(): Promise<AuthorityCheckpointOwner> {
    const slot = await this.#reload();
    if (slot.kind === "available") return slot.owner;
    throw new Error(slot.kind === "unavailable" ? slot.code : "recovery-backup-disabled");
  }

  #reload(): Promise<RuntimeSlot> {
    if (this.#loading) return this.#loading;
    const loading = this.#load().finally(() => {
      if (this.#loading === loading) this.#loading = undefined;
    });
    this.#loading = loading;
    return loading;
  }

  async #load(): Promise<RuntimeSlot> {
    const trust = await this.input.mesh.bootstrapStore.loadTrustRecord();
    if (!trust) throw new Error("Home trust disappeared while recovery backup was active");
    assertHomeAuthority(trust, this.input.mesh.deviceKey.deviceId);
    if (!trust.recoveryBackupPublicKey) return this.#replace({ kind: "disabled" });

    const targets = new FileBackupTargetConfiguration(this.input.zhixingHome);
    let config;
    try {
      config = await targets.load();
    } catch {
      return this.#replace({
        kind: "unavailable",
        code: "configuration-invalid",
        fullBackupReady: false,
      });
    }
    if (!config) return this.#replace({ kind: "disabled" });
    const binding = config.bindings.find((candidate) => candidate.targetId === config.currentTargetId);
    if (!binding) {
      return this.#replace({
        kind: "unavailable",
        code: "configuration-invalid",
        fullBackupReady: false,
      });
    }
    const recipientKeyId = keyIdForPublicKey(trust.recoveryBackupPublicKey);
    let target: RetirableRecoveryCheckpointTarget;
    try {
      target = await targetForBinding(
        binding,
        this.input,
        trust,
        recipientKeyId,
      );
    } catch (error) {
      const code: BackupUnavailableCode = binding.kind === "paired-device" && !this.input.meshRuntime
        ? "runtime-unavailable"
        : "target-unavailable";
      this.input.onError?.(error);
      return this.#replace(await this.#unavailable(code, binding, trust));
    }
    const fingerprint = canonicalize({
      binding,
      chainHead: trust.chainHead,
      root: trust.recoveryRootPublicKey,
      recipientKeyId,
    });
    if (this.#slot.kind === "available" && this.#slot.fingerprint === fingerprint) {
      await target.close?.();
      return this.#slot;
    }

    const member = trust.members.find((candidate) =>
      candidate.state === "active" && candidate.device.deviceId === this.input.mesh.deviceKey.deviceId)!;
    const resolveTarget = async (targetId: string, targetRecipientKeyId: string) => {
      const latest = await targets.load();
      const historical = latest?.bindings.find((candidate) => candidate.targetId === targetId);
      if (!historical) throw new Error("Recovery checkpoint target binding is unavailable");
      return targetForBinding(historical, this.input, trust, targetRecipientKeyId);
    };
    const service = new AuthorityCheckpointService({
      log: this.input.mesh.bootstrapStore.authorityLog(),
      artifacts: this.input.mesh.bootstrapStore.artifactStore(),
      retention: this.input.checkpointRetention ?? this.input.mesh.bootstrapStore.checkpointRetention(),
      target,
      resolveTarget,
      trust,
      issuer: Object.assign({}, member.device, {
        sign: this.input.mesh.deviceKey.sign.bind(this.input.mesh.deviceKey),
      }) as typeof member.device & CheckpointSigner,
      recipient: { backupPublicKey: trust.recoveryBackupPublicKey, backupKeyId: recipientKeyId },
      currentAnchor: true,
      storageMaintenance: this.input.storageMaintenance,
    });
    const owner = new AuthorityCheckpointOwner({
      service,
      identitySeed: `${trust.homeId}:${trust.issuer.deviceId}:${binding.targetId}`,
      ...(this.input.onError ? { onError: this.input.onError } : {}),
    });
    try {
      await service.recoverPending();
      await owner.start(false);
      return this.#replace({ kind: "available", fingerprint, owner, target });
    } catch (error) {
      try {
        await owner.stop();
      } finally {
        await target.close?.();
      }
      if (error instanceof TypeError) throw error;
      this.input.onError?.(error);
      return this.#replace(await this.#unavailable("target-unavailable", binding, trust));
    }
  }

  async #unavailable(
    code: BackupUnavailableCode,
    binding: BackupTargetBinding,
    trust: HomeTrustRecord,
  ): Promise<Extract<RuntimeSlot, { kind: "unavailable" }>> {
    const status = await projectDurableRecoveryBackupStatus({
      log: this.input.mesh.bootstrapStore.authorityLog(),
      artifacts: this.input.mesh.bootstrapStore.artifactStore(),
      trust,
      currentAnchor: true,
      targetId: binding.targetId,
      storageMaintenance: this.input.storageMaintenance,
    });
    return { kind: "unavailable", code, fullBackupReady: status.fullBackupReady };
  }

  async #replace(next: RuntimeSlot): Promise<RuntimeSlot> {
    if (this.#slot.kind === "available" &&
      (next.kind !== "available" || next.owner !== this.#slot.owner)) {
      try {
        await this.#slot.owner.stop();
      } finally {
        await this.#slot.target.close?.();
      }
    }
    this.#slot = next;
    return next;
  }

  #schedule(delay: number): void {
    if (!this.#started) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.ensureDaily()
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.#schedule(TURN_MS));
    }, delay);
    this.#timer.unref?.();
  }
}

async function targetForBinding(
  binding: BackupTargetBinding,
  input: {
    readonly zhixingHome: string;
    readonly mesh: MeshRuntimeBootstrap;
    readonly meshRuntime?: MeshRuntimeAssembly;
    readonly storageMaintenance: StorageMaintenanceGovernorPort;
  },
  trust: HomeTrustRecord,
  recipientKeyId: string,
): Promise<RetirableRecoveryCheckpointTarget> {
  if (binding.kind === "paired-device") {
    if (!input.meshRuntime) throw new Error("Paired recovery target requires an authenticated mesh runtime");
    return new PairedRecoveryCheckpointTarget({
      homeId: trust.homeId,
      sourceDeviceId: input.mesh.deviceKey.deviceId,
      targetDeviceId: binding.deviceId,
      recipientKeyId,
      transport: new MeshPairedCheckpointTransport(input.meshRuntime.connections.client(binding.deviceId)),
      storageMaintenance: input.storageMaintenance,
    });
  }
  const target = await FileRecoveryCheckpointTarget.open({
    targetRoot: binding.directory,
    sourceRoot: path.join(input.zhixingHome, "distributed-runtime", "authority"),
    create: false,
    storageMaintenance: input.storageMaintenance,
  });
  if (target.targetId !== binding.targetId) {
    await target.close();
    throw new Error("Recovery backup target physical identity changed");
  }
  return target;
}

function assertHomeAuthority(trust: HomeTrustRecord, deviceId: string): void {
  if (trust.issuer.deviceId !== deviceId) throw new Error("Current device is not the home trust issuer");
  if (!trust.members.some((candidate) => candidate.state === "active" && candidate.device.deviceId === deviceId)) {
    throw new Error("Current anchor is not an active trust member");
  }
  if (!!trust.recoveryBackupPublicKey !== !!trust.recoveryRootPublicKey) {
    throw new Error("Recovery root identity is inconsistent");
  }
}
