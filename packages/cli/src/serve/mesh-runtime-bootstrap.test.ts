import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import type { CheckpointStreamRecord } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { projectRecoveryReadiness } from "@zhixing/mesh/bootstrap-authority";
import { createRootActivationCheckpoint } from "@zhixing/mesh/checkpoint";
import { enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { createRecoveryRootEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { prepareMeshRuntimeBootstrap as prepareProductionMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { activateInitialRecoveryRoot } from "./mesh-pair-command.js";
import { createPlannedAnchorTransferStagingInfrastructure } from "./planned-anchor-transfer-staging-infrastructure.js";
import { createDisasterRecoveryStagingInfrastructure } from "./disaster-recovery-staging-infrastructure.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";

vi.setConfig({ testTimeout: 30_000 });

function prepareMeshRuntimeBootstrap(
  input: Omit<Parameters<typeof prepareProductionMeshRuntimeBootstrap>[0],
    "plannedAnchorTransferStaging" | "disasterRecoveryStaging">,
) {
  return prepareProductionMeshRuntimeBootstrap({
    ...input,
    plannedAnchorTransferStaging: createPlannedAnchorTransferStagingInfrastructure({
      zhixingHome: input.zhixingHome,
      ...(input.storageMaintenance
        ? { storageMaintenance: input.storageMaintenance }
        : {}),
    }),
    disasterRecoveryStaging: createDisasterRecoveryStagingInfrastructure({
      zhixingHome: input.zhixingHome,
      ...(input.storageMaintenance
        ? { storageMaintenance: input.storageMaintenance }
        : {}),
    }),
  });
}

describe("production mesh runtime bootstrap", () => {
  it("rejects a removed executor identity before ordinary runtime bootstrap and never recreates its key", async () => {
    const root = await createTempDir("mesh-runtime-removed-device");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "removed executor",
      platform: "headless",
      enrolledAt: "2026-08-12T00:00:00.000Z",
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
      homeId: "home-removed",
      at: "2026-08-12T00:00:00.000Z",
    });
    const executorLog = new FileAuthorityCommitLog(
      path.join(root, "distributed-runtime", "executor-authority"),
      local.bootstrapStore.artifactStore(),
    );
    const journal = new DeviceLifecycleJournal(
      executorLog,
      createTrustedDeviceProtocolVerifier([identity]),
    );
    await journal.accept({
      v: 1,
      kind: "executor-removal",
      requestId: "request-remove",
      operationId: "remove-local",
      homeId: initialized.projection.homeId,
      targetDeviceId: local.deviceKey.deviceId,
      targetMemberPublicKey: local.deviceKey.publicKey,
      targetDeviceKeyGeneration: protocolDigest("DeviceKeyGeneration", 1, {
        deviceId: local.deviceKey.deviceId,
        publicKey: local.deviceKey.publicKey,
      }),
      acceptedIssuerDeviceId: "previous-duty-device",
      acceptedIssuerKeyId: "previous-duty-device",
      acceptedTrustHeadDigest: initialized.projection.chainHead.eventDigest,
    });
    for (const phase of [
      "gate-frozen",
      "authority-decided",
      "authority-settled",
      "revocation-ready",
      "revoked",
      "cleanup-complete",
    ] as const) await journal.advance("remove-local", phase);
    await journal.terminal("remove-local", "removed");

    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets }))
      .rejects.toThrow("pair it again to create a new identity");
    expect((await secrets.list("")).filter((ref) => ref.kind === "device-key")).toHaveLength(0);
    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets }))
      .rejects.toThrow("pair it again to create a new identity");
  });

  it("finishes a removal from its durable issuer terminal before ordinary bootstrap, without the network, a private key or a new identity", async () => {
    for (const keyAlreadyDeleted of [false, true]) {
      const removal = await removeTargetUntilFinalizeCrash(`local-terminal-${keyAlreadyDeleted}`, {
        crash: keyAlreadyDeleted ? "after-key-deleted" : "before-key-deleted",
      });
      expect((await removal.secrets.list("device-key/")).length).toBe(keyAlreadyDeleted ? 0 : 1);
      expect(await removal.secrets.list("terminal-route/")).toHaveLength(1);
      // 值班设备已停、中继端口不可达：完成只能来自本机已耐久的终态回执
      await expect(prepareMeshRuntimeBootstrap({ zhixingHome: removal.root, secretStore: removal.secrets }))
        .rejects.toThrow("pair it again to create a new identity");
      expect(await removal.secrets.list("device-key/")).toEqual([]);
      expect(await removal.secrets.list("terminal-route/")).toEqual([]);
      // 重复启动仍停在退休路径，不新建身份
      await expect(prepareMeshRuntimeBootstrap({ zhixingHome: removal.root, secretStore: removal.secrets }))
        .rejects.toThrow("pair it again to create a new identity");
      expect(await removal.secrets.list("device-key/")).toEqual([]);
    }
  });

  it("retries a failed route-copy deletion at the next startup because the local terminal comes after it", async () => {
    const removal = await removeTargetUntilFinalizeCrash("delete-retry", { crash: "before-key-deleted" });
    const original = removal.secrets.delete.bind(removal.secrets);
    let pending = true;
    removal.secrets.delete = async (ref) => {
      if (pending && ref.kind === "terminal-route") {
        pending = false;
        throw new Error("simulated secret store delete failure");
      }
      return original(ref);
    };
    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: removal.root, secretStore: removal.secrets }))
      .rejects.toThrow("simulated secret store delete failure");
    // 删除失败时还没写本机 terminal：副本留着，下一次启动结算会重做
    expect(await removal.secrets.list("terminal-route/")).toHaveLength(1);
    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: removal.root, secretStore: removal.secrets }))
      .rejects.toThrow("pair it again to create a new identity");
    expect(await removal.secrets.list("terminal-route/")).toEqual([]);
    expect(await removal.secrets.list("device-key/")).toEqual([]);
  });

  it("opens only the dedicated retrieval while the duty device's terminal is still missing", async () => {
    const removal = await removeTargetUntilFinalizeCrash("retrieval-mode", { crash: "before-issuer-terminal" });
    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: removal.root, secretStore: removal.secrets }))
      .rejects.toThrow("finishing its removal");
    const staging = {
      plannedAnchorTransferStaging: createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: removal.root }),
      disasterRecoveryStaging: createDisasterRecoveryStagingInfrastructure({ zhixingHome: removal.root }),
    };
    const prepared = await prepareProductionMeshRuntimeBootstrap({
      zhixingHome: removal.root,
      secretStore: removal.secrets,
      ...staging,
      allowRemovalRetrieval: true,
    });
    try {
      expect(prepared).toMatchObject({ mode: "removal-retrieval", operationId: removal.operationId });
      expect(prepared.deviceKey.deviceId).toBe(removal.targetDeviceId);
      // 不进入普通装配：没有角色、信任投影与传输对端
      expect(prepared).not.toHaveProperty("roles");
      expect(prepared).not.toHaveProperty("transportPeers");
    } finally {
      await prepared.bootstrapStore.stopStorageMaintenance();
    }
  });

  it("fails closed when the durable issuer terminal is not signed by the accepting duty device", async () => {
    const removal = await removeTargetUntilFinalizeCrash("forged-terminal", { crash: "forged-issuer-terminal" });
    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: removal.root, secretStore: removal.secrets }))
      .rejects.toThrow("does not bind this operation");
    expect((await removal.secrets.list("device-key/")).length).toBe(1);
  });

  it("keeps a retired anchor home closed to ordinary startup", async () => {
    const root = await createTempDir("mesh-runtime-retired-anchor");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "retired anchor",
      platform: "headless",
      enrolledAt: "2026-08-12T00:00:00.000Z",
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor"],
      homeId: "home-retired",
      at: "2026-08-12T00:00:00.000Z",
    });
    // 统一入口已用本 home 的活验签器登记生命周期定义；同一日志的其他 journal 沿用该登记。
    const journal = new DeviceLifecycleJournal(local.bootstrapStore.authorityLog());
    await journal.accept({
      v: 1,
      kind: "anchor-uninstall",
      requestId: "request-uninstall",
      operationId: "uninstall-local",
      homeId: initialized.projection.homeId,
      currentDeviceId: local.deviceKey.deviceId,
      anchorEpoch: 1,
      trustHeadDigest: initialized.projection.chainHead.eventDigest,
      path: { kind: "migration", targetDeviceId: "new-anchor", transferId: "transfer-1" },
    });
    for (const phase of ["gate-frozen", "transfer-committed", "cleanup-complete"] as const) {
      await journal.advance("uninstall-local", phase);
    }
    await journal.terminal("uninstall-local", "retired");

    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets }))
      .rejects.toThrow("use the recovery flow");
    expect((await secrets.list("")).filter((ref) => ref.kind === "device-key")).toHaveLength(0);
  });

  it("rejects invalid role configuration before creating a device key", async () => {
    const root = await createTempDir("mesh-runtime-invalid-config");
    const secrets = new MemorySecretStore();

    await expect(prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "0.0.0.0", port: 7443 } },
      },
    })).rejects.toThrow(/requires direct or relay reachability/);
    expect(secrets.values.size).toBe(0);
  });

  it("exposes only the trusted-home bootstrap needed for recovery-root establishment", async () => {
    const root = await createTempDir("mesh-runtime-recovery-root-guard");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "home anchor",
      platform: "headless",
      enrolledAt: new Date().toISOString(),
    });
    await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
    });
    const bootstrap = await prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    });
    expect(bootstrap.mode).toBe("trusted-home");
    if (bootstrap.mode !== "trusted-home") throw new Error("expected trusted home");
    expect(bootstrap.trust.recoveryRootPublicKey).toBeUndefined();
    expect(bootstrap.trust.recoveryBackupPublicKey).toBeUndefined();
  });

  it("keeps the pre-genesis topology local and switches permanently to trust-authorized roles", async () => {
    const root = await createTempDir("mesh-runtime-bootstrap");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
    });
    expect(local.mode).toBe("single-machine");
    expect(local.roles).toEqual(["anchor", "executor"]);

    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "home anchor",
      platform: "headless",
      enrolledAt: new Date().toISOString(),
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
    });
    await activateInitialRecoveryRoot({
      store: local.bootstrapStore,
      issuerKey: local.deviceKey,
      issuerIdentity: identity,
      current: initialized.projection,
      targetId: "backup-device:test-recovery-target",
      targetIndependenceDomain: "device:test-recovery-target",
      createTarget: () => FileRecoveryCheckpointTarget.openPaired({
        targetRoot: `${root}/recovery-target`,
        targetDeviceId: "test-recovery-target",
      }),
      writeLine: () => undefined,
      confirmRecoveryPackage: async (value) => value,
    });

    await expect(prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
    })).rejects.toThrow("requires role configuration");
    const trusted = await prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    });
    expect(trusted.mode).toBe("trusted-home");
    if (trusted.mode !== "trusted-home") throw new Error("expected trusted home");
    expect(trusted.roles).toEqual(["anchor"]);
    expect(trusted.localEndpoint?.transports).toEqual([
      { kind: "direct", host: "127.0.0.1", port: 7443 },
    ]);
    const replay = await prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    });
    expect(replay.mode).toBe("trusted-home");
    if (replay.mode !== "trusted-home") throw new Error("expected trusted home");
    expect(replay.localEndpoint?.revision).toBe(trusted.localEndpoint?.revision);
  });

  it("replays a strict legacy trust-only package after target response loss without claiming a full backup", async () => {
    const home = await createTempDir("mesh-runtime-legacy-root");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: home, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "home anchor",
      platform: "headless",
      enrolledAt: "2026-08-12T00:00:00.000Z",
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
      at: "2026-08-12T00:00:00.000Z",
    });
    const recoveryRoot = RecoveryRoot.generate();
    const plan = {
      v: 1 as const,
      kind: "establish" as const,
      rootEvent: createRecoveryRootEvent({
        current: initialized.projection,
        op: "establish",
        candidate: recoveryRoot,
        outerSigner: local.deviceKey,
        at: "2026-08-12T00:01:00.000Z",
      }),
    };
    const checkpoint = createRootActivationCheckpoint({
      checkpointId: "01J00000000000000000000041",
      createdAt: "2026-08-12T00:01:00.000Z",
      plan,
      recoveryRoot,
      issuer: Object.assign({}, identity, { sign: local.deviceKey.sign.bind(local.deviceKey) }),
      scope: ["trust"],
      domainRevisions: { trust: initialized.projection.chainHead.seq },
      upToLsn: initialized.projection.chainHead.seq,
      plaintextChunks: [Buffer.from("legacy trust checkpoint")],
    });
    const legacyPackage = encodeLegacyRecoveryPackage(recoveryRoot, checkpoint);
    const durableTarget = await FileRecoveryCheckpointTarget.openPaired({
      targetRoot: `${home}/recovery-target`,
      targetDeviceId: "legacy-target",
    });
    let loseWriteResponse = true;
    const responseLossTarget = {
      targetId: durableTarget.targetId,
      independenceDomain: durableTarget.independenceDomain,
      async writeDurable(value: Parameters<typeof durableTarget.writeDurable>[0]) {
        await durableTarget.writeDurable(value);
        if (loseWriteResponse) {
          loseWriteResponse = false;
          throw new Error("simulated target response loss");
        }
      },
      read: durableTarget.read.bind(durableTarget),
    };
    const activation = {
      store: local.bootstrapStore,
      issuerKey: local.deviceKey,
      issuerIdentity: identity,
      current: initialized.projection,
      targetId: durableTarget.targetId,
      targetIndependenceDomain: durableTarget.independenceDomain,
      createTarget: async () => responseLossTarget,
      writeLine: () => undefined,
      confirmRecoveryPackage: async () => legacyPackage,
    };
    try {
      await expect(activateInitialRecoveryRoot(activation)).rejects.toThrow(
        "simulated target response loss",
      );
      await expect(activateInitialRecoveryRoot(activation)).resolves.toMatchObject({
        recoveryRootPublicKey: recoveryRoot.rootPublicKey,
        recoveryBackupPublicKey: recoveryRoot.backupPublicKey,
      });

      const trust = await local.bootstrapStore.loadTrustProjection();
      if (!trust) throw new Error("recovery trust projection is missing");
      const records = await local.bootstrapStore.authorityLog().readStream<import("@zhixing/core/contracts").CheckpointStreamRecord>("checkpoint").then((entries) => entries.map((entry) => entry.body));
      const readiness = projectRecoveryReadiness({
        trust,
        verifiedRecords: records.filter(
          (record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }> =>
            record.t === "checkpoint-verified",
        ),
        createdRecords: records.filter(
          (record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> =>
            record.t === "checkpoint-created",
        ),
        checkpointEnvelopes: [checkpoint.envelope],
      });
      expect(readiness).toMatchObject({ ready: true, fullBackupReady: false });
    } finally {
      await durableTarget.close();
    }
  });

  it("rejects a configured role outside the signed trust projection", async () => {
    const root = await createTempDir("mesh-runtime-role-guard");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "executor",
      platform: "headless",
      enrolledAt: new Date().toISOString(),
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor"],
    });
    await activateInitialRecoveryRoot({
      store: local.bootstrapStore,
      issuerKey: local.deviceKey,
      issuerIdentity: identity,
      current: initialized.projection,
      targetId: "backup-device:test-recovery-target",
      targetIndependenceDomain: "device:test-recovery-target",
      createTarget: () => FileRecoveryCheckpointTarget.openPaired({
        targetRoot: `${root}/recovery-target`,
        targetDeviceId: "test-recovery-target",
      }),
      writeLine: () => undefined,
      confirmRecoveryPackage: async (value) => value,
    });
    await expect(prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["executor"],
      },
    })).rejects.toThrow("not authorized");
  });

});

function encodeLegacyRecoveryPackage(
  recoveryRoot: RecoveryRoot,
  checkpoint: ReturnType<typeof createRootActivationCheckpoint>,
): string {
  return `zxrp1:${Buffer.from(canonicalize({
    v: 1,
    recoverySecret: recoveryRoot.exportSecret(),
    checkpoint: {
      envelope: checkpoint.envelope,
      chunks: checkpoint.chunks?.map((chunk) => ({
        seq: chunk.seq,
        bytes: Buffer.from(chunk.bytes).toString("base64url"),
      })) ?? [],
    },
  }), "utf8").toString("base64url")}`;
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(key(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(key(ref)) ?? null;
  }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const storageKey = key(ref);
    const existing = this.values.get(storageKey);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(storageKey, value);
    return value;
  }


  async delete(ref: SecretRef): Promise<void> {
    this.values.delete(key(ref));
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

function key(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}

const REMOVAL_AT = "2026-08-12T00:00:00.000Z";
const REMOVAL_LATER = "2026-08-12T00:00:03.000Z";

/**
 * 两个 home：值班设备与被移除设备持有同一条信任链（配对之后的状态）。按真实协议走到指定落盘点后，
 * 让被移除设备在那一步“崩溃”，再关闭两边存储；之后不存在任何可达的网络端点。
 */
async function removeTargetUntilFinalizeCrash(
  label: string,
  input: {
    readonly crash: "before-key-deleted" | "after-key-deleted" | "before-issuer-terminal" | "forged-issuer-terminal";
  },
) {
  const root = await createTempDir(`mesh-runtime-${label}`);
  const secrets = new MemorySecretStore();
  const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
  const targetKey = local.deviceKey;
  const issuerKey = await DeviceKey.generate();
  const issuer = enrollDeviceIdentity(issuerKey, { displayName: "值班电脑", platform: "headless", enrolledAt: REMOVAL_AT });
  const target = enrollDeviceIdentity(targetKey, { displayName: "被移除的电脑", platform: "headless", enrolledAt: REMOVAL_AT });
  const issuerStore = new FileMeshBootstrapStore(await createTempDir(`mesh-runtime-${label}-issuer`), issuerKey);
  const genesis = await issuerStore.initializeLocalHome({
    key: issuerKey, identity: issuer, roles: ["anchor"], homeId: "home-removal", at: REMOVAL_AT,
  });
  const enroll = createSignedTrustEvent({
    current: genesis.projection,
    body: { t: "enroll", device: target, roles: ["executor"] },
    signer: issuerKey,
    at: REMOVAL_AT,
  });
  await issuerStore.appendTrustEvent({ event: enroll, issuerKey });
  await local.bootstrapStore.initializeLocalHome({
    key: issuerKey, identity: issuer, roles: ["anchor"], homeId: "home-removal", at: REMOVAL_AT,
  });
  await local.bootstrapStore.appendTrustEvent({ event: enroll, issuerKey });
  await local.bootstrapStore.stopStorageMaintenance();
  // 重新打开：与配对之后的进程一样，打开时就预载当前信任里的 issuer 与本机身份
  const targetStore = await FileMeshBootstrapStore.open(root, undefined, { secretStore: secrets });

  const identities = new Map([[issuer.deviceId, issuer], [target.deviceId, target]] as const);
  const authority = new CurrentIssuerDeviceRemovalAuthority({
    store: issuerStore,
    issuerKey,
    secretStore: new MemorySecretStore(),
    verifier: createLiveTrustedDeviceProtocolVerifier((deviceId) => identities.get(deviceId)),
    isReachable: () => false,
    now: () => REMOVAL_LATER,
  });
  const operationId = `remove-${label}`;
  const accepted = await authority.accept({ requestId: `request-${label}`, operationId, targetName: "被移除的电脑" });
  const log = targetStore.authorityLog();
  const removed = new ExecutorRemovalTarget({
    log,
    homeId: "home-removal",
    deviceKey: targetKey,
    verifier: targetStore.authoritySources()!.verifier,
    secretStore: secrets,
    issuerRoute: async () => ({
      peer: { identity: issuer, rootCertificatePem: issuerKey.rootCertificatePem },
      endpoint: {
        v: 1,
        deviceId: issuer.deviceId,
        transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: 9 } }],
        revision: 1,
        at: REMOVAL_AT,
      },
    }),
    closeAdmission: async () => undefined,
    settleAcceptedWork: async () => undefined,
    releaseAdmission: async () => undefined,
    transferToAnchor: async () => undefined,
    cleanup: async () => [{ kind: "cleanup" as const, digest: protocolDigest("LocalTerminalCleanup", 1, { label }) }],
    finalizeDeviceKey: async () => {
      if (input.crash === "after-key-deleted") await deleteDeviceKeyExact(secrets, targetKey);
      throw new Error("simulated crash around device key deletion");
    },
    now: () => REMOVAL_LATER,
  });
  await removed.accept(accepted, await authority.terminalRoute(operationId));
  const decision = await removed.decide({ operationId, mode: "destroy", currentAnchorDeviceId: issuer.deviceId });
  if (decision.kind !== "ready") throw new Error("removed device did not reach revocation-ready");
  const cleanupReady = await removed.finish(await authority.commitReady(decision.receipt));
  if (input.crash === "forged-issuer-terminal") {
    // 终态回执由错误的设备签发：本机核验必须失败关闭
    const forged = createSignedExecutorRemovalReceipt({
      v: 1,
      operationId,
      homeId: accepted.homeId,
      targetDeviceId: accepted.targetDeviceId,
      targetDeviceKeyGeneration: accepted.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: accepted.acceptedIssuerDeviceId,
      acceptedIssuerKeyId: accepted.acceptedIssuerKeyId,
      acceptedTrustHeadDigest: accepted.acceptedTrustHeadDigest,
      phase: "removed",
      evidenceDigest: protocolDigest("ForgedTerminal", 1, { label }),
      at: REMOVAL_LATER,
    }, targetKey);
    const ref = await log.artifactStore.put(Buffer.from(canonicalize(forged), "utf8"));
    await new DeviceLifecycleJournal(log).peerEffect(operationId, {
      kind: "issuer-terminal",
      digest: protocolDigest("ExecutorRemovalIssuerTerminalReceipt", 1, forged),
      evidence: [{ kind: "cleanup", digest: ref.digest, artifact: ref }],
    });
  } else if (input.crash !== "before-issuer-terminal") {
    await expect(removed.finish(await authority.commitCleanupReady(cleanupReady!)))
      .rejects.toThrow("simulated crash");
  }
  await targetStore.stopStorageMaintenance();
  await issuerStore.stopStorageMaintenance();
  return { root, secrets, operationId, targetDeviceId: targetKey.deviceId };
}

import path from "node:path";
import { DeviceLifecycleJournal, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { createSignedExecutorRemovalReceipt } from "@zhixing/core/protocol";
import { DeviceKey } from "@zhixing/mesh/device-identity";
import { deleteDeviceKeyExact } from "@zhixing/mesh/device-key-store";
import { createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { CurrentIssuerDeviceRemovalAuthority, ExecutorRemovalTarget } from "./device-removal.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createLiveTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";
