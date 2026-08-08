import { createServer } from "node:net";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import type {
  DeviceCapacityAdmission,
  StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import { createRootActivationCheckpoint } from "@zhixing/mesh/checkpoint";
import { enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { RecoveryRoot, keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import {
  FilePairedCheckpointStaging,
  PairedCheckpointReceiver,
  PairedRecoveryCheckpointTarget,
  registerPairedCheckpointMeshService,
} from "@zhixing/mesh/paired-checkpoint-target";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { createRecoveryRootEvent, createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { runBackupSetupCommand } from "./backup-command.js";
import { prepareMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { deferredPairedCheckpointTarget } from "./paired-checkpoint-runtime.js";
import { RecoveryRootEstablishmentRuntime } from "./recovery-root-establishment-runtime.js";
import { assertRecoveryRootActivationReplay } from "./recovery-root-activation.js";

vi.setConfig({ testTimeout: 120_000 });

describe("paired recovery backup setup", () => {
  it.each(["v1", "v2"] as const)(
    "establishes the first recovery root from a %s package over the restricted production transport",
    async (version) => {
      const fixture = await pairedHomeWithoutRecoveryRoot(version);
      const runtime = new RecoveryRootEstablishmentRuntime({
        zhixingHome: fixture.targetHome,
        mesh: fixture.targetBootstrap,
        secretStore: fixture.targetSecrets,
        storageMaintenance: fixture.targetStorage,
      });
      let displayedPackage: string | undefined;
      try {
        await runtime.start();
        await runBackupSetupCommand(
          { pairedDeviceId: fixture.targetDeviceId },
          {
            zhixingHome: fixture.sourceHome,
            secretStore: fixture.sourceSecrets,
            storageMaintenance: fixture.sourceStorage,
            writeLine: (line) => {
              if (line.startsWith("恢复包：")) displayedPackage = line.slice("恢复包：".length);
            },
            readRecoveryPackage: async () => {
              if (version === "v1") return fixture.legacyPackage!;
              if (!displayedPackage) throw new Error("recovery package was not displayed before read-back");
              return displayedPackage;
            },
          },
        );
        await withTimeout(runtime.waitUntilActivated(), "target did not observe recovery-root activation");
      } finally {
        await runtime.stop();
      }

      const sourceTrust = await fixture.sourceBootstrap.bootstrapStore.loadTrustRecord();
      const targetTrust = await fixture.targetBootstrap.bootstrapStore.loadTrustRecord();
      expect(sourceTrust?.recoveryRootPublicKey).toBeDefined();
      expect(sourceTrust?.recoveryBackupPublicKey).toBeDefined();
      expect(targetTrust?.recoveryRootPublicKey).toBe(sourceTrust?.recoveryRootPublicKey);
      expect(targetTrust?.recoveryBackupPublicKey).toBe(sourceTrust?.recoveryBackupPublicKey);

      const records = await fixture.sourceBootstrap.bootstrapStore.loadCheckpointRecords();
      const verified = records.find((record) => record.t === "checkpoint-verified");
      expect(verified).toBeDefined();
      const target = await FileRecoveryCheckpointTarget.openPaired({
        targetRoot: path.join(
          fixture.targetHome,
          "distributed-runtime",
          "recovery-checkpoints",
        ),
        targetDeviceId: fixture.targetDeviceId,
      });
      try {
        await expect(target.read(verified!.checkpointId)).resolves.toMatchObject({
          envelope: { checkpointId: verified!.checkpointId },
        });
        const event = (await fixture.sourceBootstrap.bootstrapStore.loadTrustEvents()).at(-1)!;
        const receiver = new PairedCheckpointReceiver({
          homeId: sourceTrust!.homeId,
          sourceDeviceId: sourceTrust!.issuer.deviceId,
          targetDeviceId: fixture.targetDeviceId,
          recipientKeyId: keyIdForPublicKey(sourceTrust!.recoveryBackupPublicKey!),
          replayRootActivation: ({ event: replayEvent, record }) =>
            assertRecoveryRootActivationReplay(
              fixture.targetBootstrap.bootstrapStore,
              replayEvent,
              record,
            ),
          staging: new FilePairedCheckpointStaging({
            root: path.join(
              fixture.targetHome,
              "distributed-runtime",
              "recovery-checkpoint-incoming",
            ),
            target,
            storageMaintenance: fixture.targetStorage,
          }),
        });
        const replayTarget = new PairedRecoveryCheckpointTarget({
          homeId: sourceTrust!.homeId,
          sourceDeviceId: sourceTrust!.issuer.deviceId,
          targetDeviceId: fixture.targetDeviceId,
          recipientKeyId: keyIdForPublicKey(sourceTrust!.recoveryBackupPublicKey!),
          transport: receiver,
          storageMaintenance: fixture.sourceStorage,
        });
        await expect(replayTarget.activateRoot({
          checkpointId: verified!.checkpointId,
          event,
          record: sourceTrust!,
        })).resolves.toBeUndefined();
        await expect(replayTarget.activateRoot({
          checkpointId: verified!.checkpointId,
          event,
          record: {
            ...sourceTrust!,
            chainHead: { ...sourceTrust!.chainHead, seq: sourceTrust!.chainHead.seq + 1 },
          },
        })).rejects.toThrow(/terminal replay|record|result/);
        expect(await fixture.targetBootstrap.bootstrapStore.loadTrustRecord()).toEqual(targetTrust);
      } finally {
        await target.close();
      }

      const active = await startActiveCheckpointReceiver(fixture);
      try {
        await runBackupSetupCommand(
          { pairedDeviceId: fixture.targetDeviceId },
          {
            zhixingHome: fixture.sourceHome,
            secretStore: fixture.sourceSecrets,
            storageMaintenance: fixture.sourceStorage,
            writeLine: () => undefined,
          },
        );
      } finally {
        await active.stop();
      }
      expect((await fixture.sourceBootstrap.bootstrapStore.loadCheckpointRecords()).some((record) =>
        record.t === "checkpoint-created" &&
        record.purpose.kind === "periodic" &&
        record.targetId === `backup-device:${fixture.targetDeviceId}`)).toBe(true);
    },
  );
});

async function startActiveCheckpointReceiver(
  fixture: Awaited<ReturnType<typeof pairedHomeWithoutRecoveryRoot>>,
): Promise<ProductionMeshControlPlane> {
  const mesh = await prepareMeshRuntimeBootstrap({
    zhixingHome: fixture.targetHome,
    secretStore: fixture.targetSecrets,
    storageMaintenance: fixture.targetStorage,
    configuration: { enabledRoles: ["executor"] },
  });
  if (
    mesh.mode !== "trusted-home" ||
    !mesh.trust.recoveryBackupPublicKey
  ) throw new Error("expected an activated target home");
  const services = new MeshServiceRegistry();
  const target = deferredPairedCheckpointTarget({
    zhixingHome: fixture.targetHome,
    deviceId: fixture.targetDeviceId,
    storageMaintenance: fixture.targetStorage,
  });
  registerPairedCheckpointMeshService(
    services,
    new PairedCheckpointReceiver({
      homeId: mesh.trust.homeId,
      sourceDeviceId: mesh.trust.issuer.deviceId,
      targetDeviceId: fixture.targetDeviceId,
      recipientKeyId: keyIdForPublicKey(mesh.trust.recoveryBackupPublicKey),
      replayRootActivation: ({ event, record }) =>
        assertRecoveryRootActivationReplay(mesh.bootstrapStore, event, record),
      staging: new FilePairedCheckpointStaging({
        root: path.join(
          fixture.targetHome,
          "distributed-runtime",
          "recovery-checkpoint-incoming",
        ),
        target,
        storageMaintenance: fixture.targetStorage,
      }),
    }),
    (deviceId) => deviceId === mesh.trust.issuer.deviceId,
  );
  const control = new ProductionMeshControlPlane({
    localIdentity: mesh.deviceKey,
    trust: mesh.trust,
    configuration: mesh.configuration,
    endpoints: mesh.endpoints,
    transportPeers: mesh.transportPeers,
    secretStore: fixture.targetSecrets,
    bootstrapStore: mesh.bootstrapStore,
    services,
    ...(mesh.localEndpoint ? { localEndpoint: mesh.localEndpoint } : {}),
  });
  await control.start();
  return control;
}

async function pairedHomeWithoutRecoveryRoot(version: "v1" | "v2") {
  const sourceHome = await createTempDir(`backup-command-source-${version}`);
  const targetHome = await createTempDir(`backup-command-target-${version}`);
  const sourceSecrets = new MemorySecretStore();
  const targetSecrets = new MemorySecretStore();
  const sourceStorage = storageGovernor();
  const targetStorage = storageGovernor();
  const sourceBootstrap = await prepareMeshRuntimeBootstrap({
    zhixingHome: sourceHome,
    secretStore: sourceSecrets,
  });
  const targetLocal = await prepareMeshRuntimeBootstrap({
    zhixingHome: targetHome,
    secretStore: targetSecrets,
  });
  const at = new Date().toISOString();
  const sourceIdentity = enrollDeviceIdentity(sourceBootstrap.deviceKey, {
    displayName: "recovery source",
    platform: "headless",
    enrolledAt: at,
  });
  const targetIdentity = enrollDeviceIdentity(targetLocal.deviceKey, {
    displayName: "recovery target",
    platform: "headless",
    enrolledAt: at,
  });
  const initialized = await sourceBootstrap.bootstrapStore.initializeLocalHome({
    key: sourceBootstrap.deviceKey,
    identity: sourceIdentity,
    roles: ["anchor", "executor"],
    at,
  });
  const enrolled = createSignedTrustEvent({
    current: initialized.projection,
    body: {
      t: "enroll",
      device: targetIdentity,
      roles: ["executor"],
      pairingTranscriptDigest: `sha256:${"1".repeat(64)}`,
    },
    at: new Date(Date.parse(at) + 1).toISOString(),
    signer: sourceBootstrap.deviceKey,
  });
  const projection = await sourceBootstrap.bootstrapStore.appendTrustEvent({
    event: enrolled,
    issuerKey: sourceBootstrap.deviceKey,
  });
  const record = await sourceBootstrap.bootstrapStore.loadTrustRecord();
  if (!record) throw new Error("source trust record was not persisted");
  await targetLocal.bootstrapStore.importTrustBootstrap({
    events: await sourceBootstrap.bootstrapStore.loadTrustEvents(),
    record,
    localDeviceId: targetIdentity.deviceId,
  });
  await sourceBootstrap.bootstrapStore.acceptTransportPeer({
    identity: targetIdentity,
    rootCertificatePem: targetLocal.deviceKey.rootCertificatePem,
  });
  await targetLocal.bootstrapStore.acceptTransportPeer({
    identity: sourceIdentity,
    rootCertificatePem: sourceBootstrap.deviceKey.rootCertificatePem,
  });
  const port = await freePort();
  await targetLocal.bootstrapStore.acceptEndpoint({
    v: 1,
    deviceId: sourceIdentity.deviceId,
    transports: [{ kind: "direct", host: "127.0.0.1", port }],
    revision: 1,
    at,
  });
  const rendezvous = `pairwise-${version}`;
  await sourceSecrets.put({ kind: "rendezvous", bindingId: targetIdentity.deviceId }, rendezvous);
  await targetSecrets.put({ kind: "rendezvous", bindingId: sourceIdentity.deviceId }, rendezvous);
  await writeFile(path.join(sourceHome, "config.jsonc"), JSON.stringify({
    mesh: {
      enabledRoles: ["anchor"],
      anchorListen: { bind: { host: "127.0.0.1", port } },
    },
  }), "utf8");
  const targetBootstrap = await prepareMeshRuntimeBootstrap({
    zhixingHome: targetHome,
    secretStore: targetSecrets,
    configuration: { enabledRoles: ["executor"] },
  });
  if (targetBootstrap.mode !== "trusted-home") throw new Error("expected trusted target home");

  const legacyPackage = version === "v1"
    ? createLegacyRecoveryPackage(projection, sourceBootstrap.deviceKey)
    : undefined;
  return {
    sourceHome,
    targetHome,
    sourceSecrets,
    targetSecrets,
    sourceStorage,
    targetStorage,
    sourceBootstrap,
    targetBootstrap,
    targetDeviceId: targetIdentity.deviceId,
    legacyPackage,
  };
}

function createLegacyRecoveryPackage(
  current: Parameters<typeof createRecoveryRootEvent>[0]["current"],
  signer: Parameters<typeof createRecoveryRootEvent>[0]["outerSigner"],
): string {
  const root = RecoveryRoot.generate();
  const at = new Date().toISOString();
  const plan = {
    v: 1 as const,
    kind: "establish" as const,
    rootEvent: createRecoveryRootEvent({
      current,
      op: "establish",
      candidate: root,
      outerSigner: signer,
      at,
    }),
  };
  const checkpoint = createRootActivationCheckpoint({
    checkpointId: "01J00000000000000000000033",
    createdAt: at,
    plan,
    recoveryRoot: root,
    issuer: signer,
    scope: ["trust"],
    domainRevisions: { trust: current.chainHead.seq },
    upToLsn: current.chainHead.seq,
    plaintextChunks: [Buffer.from("legacy trust checkpoint")],
  });
  return `zxrp1:${Buffer.from(canonicalize({
    checkpoint: {
      chunks: checkpoint.chunks.map((chunk) => ({
        bytes: Buffer.from(chunk.bytes).toString("base64url"),
        seq: chunk.seq,
      })),
      envelope: checkpoint.envelope,
    },
    recoverySecret: root.exportSecret(),
    v: 1,
  }), "utf8").toString("base64url")}`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function storageGovernor(): StorageMaintenanceGovernorPort {
  const permit = {
    granted: {
      memoryReservationBytes: 0,
      temporaryBytes: 0,
      slots: 0,
      readBytes: Number.MAX_SAFE_INTEGER,
      writeBytes: Number.MAX_SAFE_INTEGER,
      ioOperations: Number.MAX_SAFE_INTEGER,
    },
    tryBegin: () => ({ claim: () => undefined, complete: () => undefined }),
    release: () => undefined,
  };
  return {
    acquire: async (): Promise<DeviceCapacityAdmission> => ({ kind: "granted", permit }),
    snapshot: () => ({ queued: {}, inFlight: {} }),
  };
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  readonly refs = new Map<string, SecretRef>();

  async put(ref: SecretRef, value: string): Promise<void> {
    const key = `${ref.kind}/${ref.bindingId}`;
    this.values.set(key, value);
    this.refs.set(key, ref);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    const key = `${ref.kind}/${ref.bindingId}`;
    this.values.delete(key);
    this.refs.delete(key);
  }

  async list(prefix = ""): Promise<SecretRef[]> {
    return [...this.refs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, ref]) => ref);
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}
