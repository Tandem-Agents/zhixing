import path from "node:path";
import type { DeviceIdentity, SecretRef, SecretStorePort, Signature } from "@zhixing/core/contracts";
import type { ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import type { SecureMeshConnection } from "@zhixing/mesh";
import type { MeshServiceDefinition, MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { createCredentialExposureRecord } from "@zhixing/mesh/credential-exposure";
import { DeviceKey, enrollDeviceIdentity, verifyDeviceSignature } from "@zhixing/mesh/device-identity";
import { loadActiveAnchorIssuerKey } from "@zhixing/mesh/device-key-store";
import { createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { DefaultDeviceCapacityArbiter, DefaultStorageMaintenanceGovernor, type DeviceCapacityPolicy } from "@zhixing/core/resources";
import { captureFileIo, createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  PlannedAnchorTransferJournal,
  PlannedAnchorTransferOwner,
  PlannedAnchorTransferTarget,
} from "./planned-anchor-transfer.js";
import {
  reconcilePlannedAnchorTrustFromPeer,
  registerPlannedAnchorTrustReconciliationService,
} from "./planned-anchor-transfer-mesh.js";
import { createPlannedAnchorTransferStagingInfrastructure } from "./planned-anchor-transfer-staging-infrastructure.js";
import { createPlannedAnchorReadinessCoordinator } from "../setup-delivery.js";

const NOW = Date.now();
const AT0 = new Date(NOW).toISOString();
const FROZEN = "Duty-device migration has frozen authority writes";

// 迁居历史在源端恢复里的作用（规格 6.3.1：源端永久 fence，同时要求 A→B→A 与同设备重任可行）
describe("planned duty-device migration history across devices", () => {
  it("migrates A→B→A: imported transfers stay inert, the old source follows trust and takes duty back", async () => {
    const h = await createHome();
    const first = await h.migrate(h.a, h.b, "xfer-01J00000000000000000000081");
    expect(first.committed.phase).toBe("committed");
    // 源端提交收尾时保存目标签出的同链头记录：旧源端信任前缀完整，之后才能向新值班设备对齐
    expect((await h.a.store.loadTrustRecord())?.issuer.deviceId).toBe(h.b.key.deviceId);

    // 导入前缀带着 A 作为源端的迁居：B 的源端恢复不处理它，新值班设备重启后照常写
    const bTransfers = [...(await new PlannedAnchorTransferJournal(h.b.store.authorityLog(), h.verifier).states()).values()]
      .map((state) => ({ phase: state.phase, sourceIsA: state.identity.sourceDeviceId === h.a.key.deviceId }));
    expect(bTransfers).toEqual([{ phase: "fenced", sourceIsA: true }]);
    await (await h.owner(h.b, first.issuerKey)).recoverBeforeAdmission();
    expect(await probeAppend(h.b)).toBe("written");

    // A 重启：已提交迁居的源端 fence 照装，旧任期不能再写权威
    await (await h.owner(h.a, h.a.key)).recoverBeforeAdmission();
    expect(await probeAppend(h.a)).toBe(FROZEN);

    // 迁回：B 当源端、A 当目标；安装耐久后释放 A 被新任期取代的旧 fence
    const back = await h.migrate(h.b, h.a, "xfer-01J00000000000000000000082", first.issuerKey);
    expect(back.committed.phase).toBe("committed");
    expect((await h.b.store.loadTrustRecord())?.issuer.deviceId).toBe(h.a.key.deviceId);
    expect((await h.a.store.loadTrustProjection())?.anchorEpoch).toBe(3);
    expect(await probeAppend(h.a)).toBe("written");

    // 两端各自冷重启：B 成为新的旧源端被 fence；A 是更高任期的 issuer，不再给旧迁居装 fence
    await (await h.owner(h.b, first.issuerKey)).recoverBeforeAdmission();
    expect(await probeAppend(h.b)).toBe(FROZEN);
    await (await h.owner(h.a, back.issuerKey)).recoverBeforeAdmission();
    expect(await probeAppend(h.a)).toBe("written");
  }, 180_000);
});

// 未完目录：冷启动的源端与目标端恢复只读未完候选与本机最近任期，读取不随历史迁居次数增长
describe("planned migration recovery reads across migration history", () => {
  it("recovers cold source and target state from unfinished directories without replaying migration history", async () => {
    const totals: Record<number, {
      readonly reads: number;
      readonly readBytes: number;
      readonly replayCalls: number;
      readonly replayCallers: readonly string[];
    }> = {};
    for (const count of [1, 5, 9]) {
      const h = await createHome();
      let source = h.a;
      let destination = h.b;
      let issuerKey = h.a.key;
      for (let index = 0; index < count; index++) {
        const result = await h.migrate(source, destination, `xfer-01J000000000000000000${String(index).padStart(5, "0")}`, issuerKey);
        issuerKey = result.issuerKey;
        [source, destination] = [destination, source];
      }
      // source 现在是当前值班设备：关掉存储，按生产入口冷开后计量两路恢复
      const duty = source;
      await h.stop(duty);
      const reopened: Node = { ...duty, store: await FileMeshBootstrapStore.open(duty.root, duty.key, { secretStore: duty.secrets, storageMaintenance: maintenance }) };
      onTestFinished(() => reopened.store.stopStorageMaintenance());
      // 按文件归类，失败时能看出增长落在哪本日志或哪类文件上
      const io = await captureFileIo(duty.root, (relative) => relative.replace(/^distributed-runtime\//u, "").replace(/[a-f0-9]{16,}/gu, "*"));
      const owner = await h.owner(reopened, issuerKey);
      const target = h.target(reopened);
      // 整流重放的三个入口：恢复只应走按键投影（transactDurableProjection），一次也不调用它们
      const replayCallers: string[] = [];
      const replays = ((["rebuildProjection", "transactProjection", "readStream"] as const).map((method) => {
        const original = FileAuthorityCommitLog.prototype[method] as (...args: unknown[]) => unknown;
        return vi.spyOn(FileAuthorityCommitLog.prototype, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
          replayCallers.push(`${method} <- ${new Error().stack?.split("\n").slice(2, 6).map((line) => line.trim().replace(/E:\\Dev\\longxia\\zhixing\\packages\\/gu, "")).join(" < ")}`);
          return original.apply(this, args);
        } as never);
      }));
      io.reset();
      await owner.recoverBeforeAdmission();
      await target.recoverBeforeAdmission();
      const snapshot = io.snapshot();
      const replayCalls = replays.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      for (const spy of replays) spy.mockRestore();
      totals[count] = { reads: snapshot.reads, readBytes: snapshot.readBytes, replayCalls, replayCallers };
      // 导入前缀里前任的候选与迁居不进入本机未完目录
      expect((await new PlannedAnchorTransferJournal(reopened.store.authorityLog(), h.verifier).unfinishedCandidates()).size).toBe(0);
      expect(await probeAppend(reopened)).toBe("written");
    }
    // 恢复逻辑与历史无关：每一档都不重放迁居流、候选流与 anchor-current 流。物理读量另含投影增量段
    // （上限 4 段，到上限合并），随段数在合并前小幅波动，不作断言
    for (const count of Object.keys(totals)) {
      const total = totals[Number(count)]!;
      expect(total.replayCalls, `K=${count} ${JSON.stringify(total.replayCallers)}`).toBe(0);
    }
  }, 600_000);
});

/** 一条合法的权威写入（凭据暴露记录），用来探测日志是否被源端 fence 冻结。 */
async function probeAppend(device: Node): Promise<string> {
  const label = `${device.identity.displayName}-${Math.random().toString(36).slice(2, 8)}`;
  return device.store.authorityLog().append([{
    stream: "exposure",
    body: createCredentialExposureRecord({
      deviceId: `probe-${label}`,
      bindingId: `user-alias:probe-${label}:credential-provider-main`,
      bindingRevision: 1,
      service: "provider-main",
      markedAt: AT0,
    }),
  }]).then(() => "written", (error: unknown) => (error as Error).message);
}

async function createHome() {
  const a = await node("值班电脑-A");
  const b = await node("值班电脑-B");
  const identities = new Map<string, DeviceIdentity>([a, b].map((item) => [item.identity.deviceId, item.identity]));
  const verifier: ProtocolSignatureVerifier = {
    verify: (schemaId: string, version: number, payload: unknown, signature: Signature) => {
      const identity = identities.get(signature.keyId);
      if (!identity) throw new TypeError("Unknown test signer");
      verifyDeviceSignature(identity, schemaId, version, payload, signature);
    },
  };
  onTestFinished(async () => {
    await Promise.allSettled([a.store.stopStorageMaintenance(), b.store.stopStorageMaintenance()]);
  });
  const initialized = await a.store.initializeLocalHome({ key: a.key, identity: a.identity, roles: ["anchor"], at: AT0, homeId: "home-history" });
  await a.store.appendTrustEvent({
    event: createSignedTrustEvent({ current: initialized.projection, signer: a.key, at: AT0, body: { t: "enroll", device: b.identity, roles: ["anchor"] } }),
    issuerKey: a.key,
  });
  const readiness = createPlannedAnchorReadinessCoordinator(async () => ({
    configuredCapabilities: { providers: [], mcpServers: [], channels: [] },
    protocolRevision: "protocol-v1",
    assetRevision: "assets-v1",
    serviceRevision: "services-v1",
    credentialRevision: "credentials-v1",
  }));
  const targets = new Map<Node, PlannedAnchorTransferTarget[]>();
  // 当前迁居的源端 owner：目标端的制品命令发给它
  let latestOwner: PlannedAnchorTransferOwner | undefined;
  const target = (device: Node) => {
    const created = new PlannedAnchorTransferTarget({
      deviceId: device.key.deviceId,
      identityKey: device.key,
      secretStore: device.secrets,
      bootstrapStore: device.store,
      authorityLog: device.store.authorityLog(),
      artifacts: device.store.artifactStore(),
      staging: createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: device.root, storageMaintenance: maintenance }),
      sourceFor: () => ({ applyArtifactCommand: (command) => latestOwner!.applyArtifactCommand(command) }),
      signer: device.key,
      verifier,
      readiness: readiness.port,
      now: () => NOW,
    });
    targets.set(device, [...(targets.get(device) ?? []), created]);
    onTestFinished(() => created.close());
    return created;
  };
  // 任期取自本机已验信任链（生产为 authority.anchorEpoch），源端恢复按它区分当前任期与历史
  const owner = async (device: Node, issuerKey: DeviceKey, targetPort?: PlannedAnchorTransferTarget) => {
    const anchorEpoch = (await device.store.loadTrustProjection())!.anchorEpoch;
    const created = new PlannedAnchorTransferOwner({
      deviceId: device.key.deviceId,
      anchorEpoch: () => anchorEpoch,
      identityKey: issuerKey,
      bootstrapStore: device.store,
      log: device.store.authorityLog(),
      signer: issuerKey,
      verifier,
      targetFor: () => {
        if (!targetPort) throw new Error("probe owner has no target");
        return targetPort;
      },
      artifacts: device.store.artifactStore(),
      retention: device.store.checkpointRetention(),
      ensureRecoveryCheckpoint: async () => `sha256:${"7".repeat(64)}`,
      lifecycle: { stopAccepting: () => {}, drainAccepted: async () => {}, resumeAfterAbort: () => {} },
    });
    if (targetPort) latestOwner = created;
    return created;
  };
  /** source → destination 计划迁居；目标先对齐源端当前信任，返回目标的迁居 issuer key 并登记进测试验签器。 */
  const migrate = async (source: Node, destination: Node, transferId: string, sourceIssuerKey: DeviceKey = source.key) => {
    const sourceTrust = (await source.store.loadTrustRecord())!;
    if ((await destination.store.loadTrustProjection()) === undefined) {
      await destination.store.importTrustBootstrap({
        events: await source.store.loadTrustEvents(),
        record: sourceTrust,
        localDeviceId: destination.key.deviceId,
      });
    } else {
      // 已入网的目标（例如迁回的旧值班设备）按生产经成员连接向现值班设备对齐信任
      await reconcileFrom(source, destination);
    }
    const transferOwner = await owner(source, sourceIssuerKey, target(destination));
    const step = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        throw new Error(`${label}: ${(error as Error).message}`, { cause: error });
      }
    };
    await step("prepare", () => transferOwner.prepare({ requestId: `request-${transferId}`, transferId, targetDeviceId: destination.key.deviceId }));
    await step("freeze", () => transferOwner.freeze({ requestId: `request-${transferId}`, transferId }));
    const committed = await step("commit", () => transferOwner.commit({ requestId: `request-${transferId}`, transferId }));
    const record = (await destination.store.loadTrustRecord())!;
    const issuerKey = await loadActiveAnchorIssuerKey(destination.secrets, record.issuer.issuerKeyId);
    if (!issuerKey) throw new Error("migrated issuer key is not active on the destination");
    identities.set(issuerKey.deviceId, enrollDeviceIdentity(issuerKey, { displayName: "issuer", platform: "headless", enrolledAt: AT0 }));
    return { committed, issuerKey };
  };
  /** 宿主停止：关闭这台设备上全部目标端 staging 与权威存储。 */
  const stop = async (device: Node) => {
    for (const created of targets.get(device) ?? []) await created.close();
    targets.delete(device);
    await device.store.stopStorageMaintenance();
  };
  return { a, b, verifier, migrate, owner, target, stop };
}

/** 经现值班设备的信任对齐服务把 peer 的信任对齐到当前链头（生产走成员连接，这里截获服务定义直接调用）。 */
async function reconcileFrom(current: Node, peer: Node): Promise<void> {
  const definitions = new Map<string, MeshServiceDefinition>();
  const registry = {
    register(serviceId: string, definition: MeshServiceDefinition) {
      definitions.set(serviceId, definition);
      return () => definitions.delete(serviceId);
    },
  } as MeshServiceRegistry;
  registerPlannedAnchorTrustReconciliationService(registry, {
    store: current.store,
    authorizePeer: (deviceId) => deviceId === peer.key.deviceId,
  });
  const connection = { peer: { deviceId: peer.key.deviceId } } as unknown as SecureMeshConnection;
  await reconcilePlannedAnchorTrustFromPeer({
    request: async (serviceId: string, payload: Uint8Array) => {
      const service = definitions.get(serviceId);
      if (!service || service.authorize?.(connection) === false) throw new Error("unauthorized test service");
      return service.handler(payload, connection, new AbortController().signal);
    },
  }, { store: peer.store, localDeviceId: peer.key.deviceId });
}


/** 与生产宿主同形状的存储维护调控器（宽裕容量，不制造背压）。 */
const maintenance = (() => {
  const mib = 1024 * 1024;
  const classWeights = {
    "workload-interactive": 1, "workload-advancement": 1, "workload-scheduler": 1, "workload-orchestration": 1,
    "storage-foreground": 1, "storage-recovery": 1, "storage-background": 1,
  } satisfies DeviceCapacityPolicy["classWeights"];
  return new DefaultStorageMaintenanceGovernor({
    capacity: new DefaultDeviceCapacityArbiter({
      policy: {
        version: 1,
        occupancy: { memoryReservationBytes: 256 * mib, temporaryBytes: 256 * mib, slots: 8, memorySafetyReserveBytes: 0, temporarySafetyReserveBytes: 0 },
        quantum: { readBytes: 1024 * mib, writeBytes: 1024 * mib, ioOperations: 1_000_000 },
        quantumRefillPerSecond: { readBytes: 1024 * mib, writeBytes: 1024 * mib, ioOperations: 1_000_000 },
        pressure: { maxCpuBusyRatio: 1, minimumAvailableMemoryBytes: 0 },
        retryAfterMs: 1,
        classWeights,
      },
      probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 256 * mib, processRssBytes: 0, temporaryBytesAvailable: 256 * mib }),
    }),
  });
})();

interface Node {
  readonly root: string;
  readonly key: DeviceKey;
  readonly identity: DeviceIdentity;
  readonly store: FileMeshBootstrapStore;
  readonly secrets: MemorySecretStore;
}

async function node(displayName: string): Promise<Node> {
  const root = await createTempDir("transfer-history");
  const key = await DeviceKey.generate();
  const identity = enrollDeviceIdentity(key, { displayName, platform: "headless", enrolledAt: AT0 });
  const secrets = new MemorySecretStore();
  // 生产入口：经统一 home 权威入口打开（认证日志、按需解析验签身份），与真实设备的信任前缀维护一致
  return { root, key, identity, store: await FileMeshBootstrapStore.open(root, key, { secretStore: secrets, storageMaintenance: maintenance }), secrets };
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> { this.values.set(key(ref), value); }
  async get(ref: SecretRef): Promise<string | null> { return this.values.get(key(ref)) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const existing = this.values.get(key(ref));
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(key(ref), value);
    return value;
  }
  async delete(ref: SecretRef): Promise<void> { this.values.delete(key(ref)); }
  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()].filter((value) => value.startsWith(prefix)).map((value) => {
      const separator = value.indexOf("/");
      return { kind: value.slice(0, separator) as SecretRef["kind"], bindingId: value.slice(separator + 1) };
    });
  }
  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}

function key(ref: SecretRef): string { return `${ref.kind}/${ref.bindingId}`; }
