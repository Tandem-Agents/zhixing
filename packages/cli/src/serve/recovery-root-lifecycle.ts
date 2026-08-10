import type {
  CheckpointEnvelope,
  DeviceIdentity,
  HomeTrustEvent,
  HomeTrustEventWithBody,
  HomeTrustRecord,
} from "@zhixing/core/contracts";
import type { CheckpointPackage } from "@zhixing/mesh/checkpoint";
import type { RetirableRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { RecoveryActivationCoordinator } from "@zhixing/mesh/bootstrap-authority";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

export const RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR = Object.freeze({
  owner: "current-issuer",
  roles: Object.freeze(["anchor-executor", "anchor-only"]),
  operations: Object.freeze(["rotate", "invalidate", "domain-reset-establish"] as const),
  checkpointed: Object.freeze(["rotate", "domain-reset-establish"] as const),
});

export class RecoveryRootLifecycleService {
  readonly #activation: RecoveryActivationCoordinator;

  constructor(private readonly options: {
    readonly store: FileMeshBootstrapStore;
    readonly issuerKey: DeviceKey;
    readonly issuerIdentity: DeviceIdentity;
    readonly sourceIndependenceDomain: string;
    readonly now?: () => string;
  }) {
    this.#activation = new RecoveryActivationCoordinator(options.store.bootstrapAuthority());
  }

  async rotate(input: {
    readonly currentRoot: RecoveryRoot;
    readonly candidateRoot: RecoveryRoot;
    readonly rootEvent: HomeTrustEventWithBody<
      Extract<HomeTrustEvent["body"], { t: "recovery-root"; op: "rotate" }>
    >;
    readonly checkpoint: CheckpointPackage;
    readonly target: RetirableRecoveryCheckpointTarget;
    readonly supersedeCheckpointIds?: readonly string[];
  }): Promise<HomeTrustRecord> {
    const current = await this.#current();
    assertCurrentRoot(current, input.currentRoot);
    const next = applyTrustEvent(current, input.rootEvent);
    const targetRecord = buildHomeTrustRecord(next, this.options.issuerKey);
    await this.#activation.activatePrepared({
      current,
      plan: {
        v: 1,
        kind: RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR.operations[0],
        rootEvent: input.rootEvent,
      },
      checkpoint: input.checkpoint,
      candidateRoot: input.candidateRoot,
      issuerIdentity: this.options.issuerIdentity,
      target: input.target,
      sourceIndependenceDomain: this.options.sourceIndependenceDomain,
      now: () => this.#now(),
      onStep: async (step) => {
        if (step === "verified") {
          await activateIndependentPeer(input.target, {
            checkpointId: input.checkpoint.envelope.checkpointId,
            event: input.rootEvent,
            record: targetRecord,
          });
        }
      },
      ...(input.supersedeCheckpointIds
        ? { supersedeCheckpointIds: input.supersedeCheckpointIds }
        : {}),
    });
    const record = await this.options.store.loadTrustRecord();
    if (!record) throw new Error("恢复根轮换没有形成耐久信任记录");
    return record;
  }

  async invalidate(currentRoot: RecoveryRoot): Promise<HomeTrustRecord> {
    const current = await this.#current();
    assertCurrentRoot(current, currentRoot);
    const event = createSignedTrustEvent({
      current,
      at: this.#now(),
      signer: currentRoot,
      body: {
        t: "recovery-root",
        op: RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR.operations[1],
        signedBy: "recovery-root",
      },
    });
    const next = applyTrustEvent(current, event);
    const record = buildHomeTrustRecord(next, this.options.issuerKey);
    await this.options.store.appendTrustEvent({ event, record });
    return record;
  }

  async reset(input: {
    readonly resetEvent: HomeTrustEventWithBody<
      Extract<HomeTrustEvent["body"], { t: "domain-reset" }>
    >;
    readonly rootEvent: HomeTrustEventWithBody<
      Extract<HomeTrustEvent["body"], { t: "recovery-root"; op: "establish" }>
    >;
    readonly candidateRoot: RecoveryRoot;
    readonly checkpoint: CheckpointPackage;
    readonly target: RetirableRecoveryCheckpointTarget;
    readonly supersedeCheckpointIds?: readonly string[];
  }): Promise<HomeTrustRecord> {
    const current = await this.#current();
    const reset = applyTrustEvent(current, input.resetEvent);
    const next = applyTrustEvent(reset, input.rootEvent);
    const targetRecord = buildHomeTrustRecord(next, this.options.issuerKey);
    await this.#activation.activatePrepared({
      current,
      plan: {
        v: 1,
        kind: RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR.operations[2],
        resetEvent: input.resetEvent,
        rootEvent: input.rootEvent,
      },
      checkpoint: input.checkpoint,
      candidateRoot: input.candidateRoot,
      issuerIdentity: this.options.issuerIdentity,
      target: input.target,
      sourceIndependenceDomain: this.options.sourceIndependenceDomain,
      now: () => this.#now(),
      onStep: async (step) => {
        if (step === "verified") {
          await activateIndependentPeer(input.target, {
            checkpointId: input.checkpoint.envelope.checkpointId,
            event: input.rootEvent,
            record: targetRecord,
          });
        }
      },
      ...(input.supersedeCheckpointIds
        ? { supersedeCheckpointIds: input.supersedeCheckpointIds }
        : {}),
    });
    const record = await this.options.store.loadTrustRecord();
    if (!record) throw new Error("恢复根重置没有形成耐久信任记录");
    return record;
  }

  async #current(): Promise<TrustProjection> {
    const current = await this.options.store.loadTrustProjection();
    if (!current || current.issuer.issuerKeyId !== this.options.issuerKey.deviceId) {
      throw new Error("只有当前值班设备可以管理恢复根");
    }
    return current;
  }

  #now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function assertCurrentRoot(current: TrustProjection, root: RecoveryRoot): void {
  const identity = root.publicIdentity();
  if (
    current.recoveryRootPublicKey !== identity.rootPublicKey ||
    current.recoveryBackupPublicKey !== identity.backupPublicKey
  ) throw new Error("恢复包不是当前有效恢复根");
}

export function recoveryRootCheckpointIdentity(envelope: CheckpointEnvelope): {
  readonly checkpointId: string;
  readonly recipientKeyId: string;
} {
  return Object.freeze({
    checkpointId: envelope.checkpointId,
    recipientKeyId: envelope.recipientKeyId,
  });
}

export type RecoveryRootLifecycleEvent = HomeTrustEvent;

async function activateIndependentPeer(
  target: RetirableRecoveryCheckpointTarget,
  input: {
    readonly checkpointId: string;
    readonly event: HomeTrustEvent;
    readonly record: HomeTrustRecord;
  },
): Promise<void> {
  if (!("activateRoot" in target) || typeof target.activateRoot !== "function") return;
  await (target.activateRoot as (value: typeof input) => Promise<void>)(input);
}
