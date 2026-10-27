import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { DeviceIdentity, MeshEndpointDescriptor, SecretRef, SecretStorePort, Signature } from "@zhixing/core/contracts";
import { DeviceLifecycleJournal, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { createSignedExecutorRemovalReceipt, protocolDigest, type ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import { BlindRendezvousMatcher, readBlindRendezvousHello } from "@zhixing/mesh/blind-rendezvous";
import {
  currentAndPreviousDiscoveryRendezvousKeys,
  currentAndPreviousRendezvousKeys,
  MeshEndpointDirectory,
  terminalRouteDigest,
} from "@zhixing/mesh/bootstrap";
import { DeviceKey, enrollDeviceIdentity, verifyDeviceSignature } from "@zhixing/mesh/device-identity";
import { loadActiveAnchorIssuerKey } from "@zhixing/mesh/device-key-store";
import { connectAuthenticatedMesh } from "@zhixing/mesh/handshake";
import { localChainOfEvents } from "@zhixing/mesh/home-discovery";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { createSignedTrustEvent, replayTrustChain } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  CurrentIssuerDeviceRemovalAuthority,
  ExecutorRemovalTarget,
  resolveExecutorRemovalTerminalRoute,
} from "./device-removal.js";
import { registerDeviceRemovalIssuerMeshService } from "./device-removal-mesh.js";
import { retrieveExecutorRemovalTerminal } from "./device-removal-retrieval.js";
import { adoptDiscoveredTrust, createHomeDiscoveryService } from "./home-discovery-service.js";
import {
  loadHomeDiscoverySecret,
  loadHomeRouteMaterial,
  loadOrCreateHomeRouteMaterial,
  persistHomeDiscoverySecret,
} from "./home-route-material.js";
import { createMeshBootstrapProjectionPorts, loadActiveMemberTransportPeers } from "./mesh-bootstrap-projection.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { ProductionMeshControlPlane, registerPairwiseRenegotiationService } from "./mesh-control-plane.js";
import {
  completePlannedAnchorInstallationBeforeBootstrap,
  finishPlannedAnchorPostInstall,
  PlannedAnchorTransferOwner,
  PlannedAnchorTransferTarget,
} from "./planned-anchor-transfer.js";
import { createPlannedAnchorTransferStagingInfrastructure } from "./planned-anchor-transfer-staging-infrastructure.js";
import { createPlannedAnchorReadinessCoordinator } from "../setup-delivery.js";

const NOW = Date.now();
const AT0 = new Date(NOW).toISOString();
const AT1 = new Date(NOW + 3_000).toISOString();
const TRANSFER_ID = "xfer-01J00000000000000000000077";
const OPERATION_ID = "remove-across-migration";

// 迁居与移除终态的交界：issuer 写下终态而回执没送到 target 时完成迁居，现值班设备手里有哪些事实
describe("executor removal terminal across a planned duty-device migration", () => {
  it("records what the new duty device holds for a removal the previous issuer terminated", async () => {
    const f = await createHomes();
    const route = await f.authorityA.terminalRoute(OPERATION_ID).catch(() => undefined);
    expect(route).toBeUndefined(); // 还没有接受，路由材料不存在

    // 移除走到 issuer 终态：接受、target 落盘路由材料、撤销、target 本机清理并发出 cleanup-ready
    const accepted = await f.authorityA.accept({
      requestId: "request-remove-t",
      operationId: OPERATION_ID,
      targetName: f.t.identity.displayName,
    });
    const terminalRoute = await f.authorityA.terminalRoute(OPERATION_ID);
    await f.target.accept(accepted, terminalRoute);
    const decision = await f.target.decide({
      operationId: OPERATION_ID,
      mode: "destroy",
      currentAnchorDeviceId: f.a.identity.deviceId,
    });
    if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
    const revoked = await f.authorityA.commitReady(decision.receipt);
    const cleanupReady = await f.target.finish(revoked);
    expect(cleanupReady).toMatchObject({ phase: "cleanup-ready" });
    // issuer 写下终态并释放移除 guard；这份回执在响应途中丢失，target 没有收到
    const removed = await f.authorityA.commitCleanupReady(cleanupReady!);
    expect(removed).toMatchObject({ phase: "removed" });
    expect(removed.signature.keyId).toBe(f.a.identity.deviceId);

    // 目标值班设备 B 此时对齐到当前信任（生产里经成员连接对齐），随后完成计划迁居 A → B
    const { issuerKeyB } = await migrate(f);

    // F1：B 的权威日志里有这次移除的终态事实与 removal-route 键
    const journalB = new DeviceLifecycleJournal(f.bStore.authorityLog(), f.verifier);
    const operationOnB = await journalB.state(OPERATION_ID);
    const routeOperationOnB = await journalB.removalForRoute(terminalRouteDigest(terminalRoute.locator));
    // F2：B 作为新 issuer 能否按 target 手里的定位解析这次移除
    const authorityB = new CurrentIssuerDeviceRemovalAuthority({
      store: f.bStore,
      issuerKey: issuerKeyB,
      secretStore: f.secretsB,
      verifier: f.verifier,
      isReachable: () => false,
      now: () => AT1,
    });
    const resolvedOnB = await authorityB.operationForRoute(terminalRoute.locator);
    // F3：B 按已存事实重算的终态回执由谁签名，target 是否接受
    const receiptOnB = await authorityB.terminal(OPERATION_ID).catch((error: unknown) => error as Error);
    const finishWithB = receiptOnB instanceof Error
      ? receiptOnB
      : await f.target.finish(receiptOnB!).then(() => "accepted", (error: unknown) => error as Error);
    // F4：B 能否按 deviceId 精确读到 target 的传输身份（终态入口验证客户端证书要用）
    const transportPeerOnB = await createMeshBootstrapProjectionPorts(f.bStore).transportPeers.transportPeer(f.t.identity.deviceId);
    // F5：issuer-terminal 效果里是否保存了原签名回执本身
    const issuerTerminal = operationOnB?.peerEffects.find((effect) => effect.kind === "issuer-terminal");

    const facts = {
      F1: { phaseOnB: operationOnB?.phase, acceptedIssuer: operationOnB?.identity.kind === "executor-removal"
        ? operationOnB.identity.acceptedIssuerDeviceId === f.a.identity.deviceId : undefined, routeKeyOnB: routeOperationOnB !== undefined },
      F2: { resolvedOnB: resolvedOnB !== undefined },
      F3: receiptOnB instanceof Error
        ? { error: receiptOnB.message }
        : { signer: receiptOnB?.signature.keyId === issuerKeyB.deviceId ? "B-issuer" : receiptOnB?.signature.keyId,
            targetFinish: finishWithB instanceof Error ? finishWithB.message : finishWithB },
      F4: { transportPeerOnB: transportPeerOnB !== undefined },
      F5: { issuerTerminalEvidence: issuerTerminal?.evidence.length ?? "missing" },
      targetRetired: await f.target.isRetired(OPERATION_ID),
    };
    // 迁居后现值班设备承接：按定位解析前任接受的移除、经成员连接目录拿到 T 的传输身份、
    // 原签名终态回执随效果耐久并原样转交，T 按接受时的 issuer key 验过后完成退休
    expect(facts.F2).toEqual({ resolvedOnB: true });
    expect(facts.F3).toEqual({ signer: f.a.identity.deviceId, targetFinish: "accepted" });
    expect(facts.F4).toEqual({ transportPeerOnB: true });
    expect(facts.F5).toEqual({ issuerTerminalEvidence: 1 });
    expect(facts.targetRetired).toBe(true);
  }, 120_000);

  // P1b：生产装配给新值班设备传入的是迁居生成的 issuer key；P1c：只和旧值班设备配过对的 active 执行端
  it("records how the new duty device treats a fresh removal and an executor paired only with the old one", async () => {
    const f = await createHomes();
    // E 一侧的真实控制面：按生产从本机传输身份目录装配（配对只存了 A），以执行端角色启动拨号
    const ePorts = createMeshBootstrapProjectionPorts(f.eStore);
    // 配对时 E 只拿到 A 的端点（mesh-pair-command.ts 1258），这里同样只预置 A 的
    const eEndpoints = new MeshEndpointDirectory();
    eEndpoints.accept({
      v: 1,
      deviceId: f.a.identity.deviceId,
      transports: [{ kind: "direct", host: "127.0.0.1", port: await freePort() }],
      revision: 1,
      at: AT0,
    });
    const startExecutorE = async (trust: NonNullable<Awaited<ReturnType<FileMeshBootstrapStore["loadCurrentTrust"]>>>) => {
      const control = new ProductionMeshControlPlane({
        localIdentity: f.e.key,
        trust,
        configuration: { enabledRoles: ["executor"] },
        endpoints: eEndpoints,
        transportPeers: await loadActiveMemberTransportPeers(ePorts.transportPeers, trust.members, f.e.key.deviceId),
        secretStore: new MemorySecretStore(),
        endpointDirectory: ePorts.endpoints,
        transportPeerDirectory: ePorts.transportPeers,
        trustProjection: Object.freeze({ loadCurrentTrust: async () => trust }),
        services: new MeshServiceRegistry(),
        watchTrust: false,
      });
      try {
        await control.start();
        return "started";
      } catch (error) {
        return (error as Error).message;
      } finally {
        await control.stop().catch(() => undefined);
      }
    };
    const executorBeforeMigration = await startExecutorE((await f.aStore.loadCurrentTrust())!);
    const { issuerKeyB } = await migrate(f);
    const executorAfterMigration = await startExecutorE((await f.bStore.loadCurrentTrust())!);
    const trustB = (await f.bStore.loadTrustRecord())!;
    const authorityB = new CurrentIssuerDeviceRemovalAuthority({
      store: f.bStore,
      issuerKey: issuerKeyB,
      secretStore: f.secretsB,
      verifier: f.verifier,
      isReachable: () => false,
      now: () => AT1,
    });
    const freshReceipt = await authorityB.accept({
      requestId: "request-remove-e",
      operationId: "remove-after-migration",
      targetName: f.e.identity.displayName,
    });
    const freshRemoval = {
      phase: freshReceipt.phase,
      // 回执由接受时链上授权的 issuer key 签，接受身份同时冻结设备与这把 key
      signedByIssuerKey: freshReceipt.signature.keyId === issuerKeyB.deviceId && freshReceipt.acceptedIssuerKeyId === issuerKeyB.deviceId,
      deviceIsB: freshReceipt.acceptedIssuerDeviceId === f.b.identity.deviceId,
    };
    // 变异：同一份内容改由 B 的设备钥签（迁居前设备钥与 issuer key 相同时碰巧成立的路径），E 必须拒收
    const eTarget = new ExecutorRemovalTarget({
      log: new FileAuthorityCommitLog(path.join(await createTempDir("succession-e-target"), "removal-target"), f.eStore.artifactStore()),
      homeId: "home-succession",
      deviceKey: f.e.key,
      verifier: f.verifier,
      secretStore: new MemorySecretStore(),
      issuerRoute: async () => ({
        peer: { identity: f.b.identity, rootCertificatePem: f.b.key.rootCertificatePem },
        endpoint: { v: 1, deviceId: f.b.identity.deviceId, transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: 9 } }], revision: 1, at: AT0 },
      }),
      closeAdmission: async () => undefined,
      settleAcceptedWork: async () => undefined,
      releaseAdmission: async () => undefined,
      transferToAnchor: async () => undefined,
      cleanup: async () => [],
      finalizeDeviceKey: async () => [],
      now: () => AT1,
    });
    const { signature: _genuineSignature, ...unsignedFresh } = freshReceipt;
    const deviceKeySigned = createSignedExecutorRemovalReceipt(unsignedFresh, f.b.key);
    const forgedAccept = await eTarget.accept(deviceKeySigned, await authorityB.terminalRoute("remove-after-migration"))
      .then(() => "accepted", (error: unknown) => (error as Error).message);
    const genuineAccept = await eTarget.accept(freshReceipt, await authorityB.terminalRoute("remove-after-migration"))
      .then(() => "accepted", (error: unknown) => (error as Error).message);

    const bPorts = createMeshBootstrapProjectionPorts(f.bStore);
    const ePeerOnB = await bPorts.transportPeers.transportPeer(f.e.identity.deviceId);
    const bPeerOnE = await createMeshBootstrapProjectionPorts(f.eStore).transportPeers.transportPeer(f.b.identity.deviceId);
    // 真实控制面：B 以生产的成员传输身份装配监听，E 拿到 B 的根证书（给它最好的条件）后直连
    const connectExecutorToB = async () => {
      const trust = (await f.bStore.loadCurrentTrust())!;
      const port = await freePort();
      const control = new ProductionMeshControlPlane({
        localIdentity: f.b.key,
        trust,
        configuration: { enabledRoles: ["anchor"], anchorListen: { bind: { host: "127.0.0.1", port } } },
        endpoints: new MeshEndpointDirectory(),
        transportPeers: await loadActiveMemberTransportPeers(bPorts.transportPeers, trust.members, f.b.key.deviceId),
        secretStore: f.secretsB,
        endpointDirectory: bPorts.endpoints,
        transportPeerDirectory: bPorts.transportPeers,
        trustProjection: Object.freeze({ loadCurrentTrust: () => f.bStore.loadCurrentTrust() }),
        services: new MeshServiceRegistry(),
        watchTrust: false,
      });
      try {
        await control.start();
        const connection = await connectAuthenticatedMesh({
          host: "127.0.0.1",
          port,
          trustedPeer: { identity: f.b.identity, rootCertificatePem: f.b.key.rootCertificatePem },
          identity: f.e.key,
          protocolRange: { min: "1", max: "1" },
          authorizePeer: (identity) => identity.deviceId === f.b.identity.deviceId,
          handshakeTimeoutMs: 5_000,
        });
        await connection.close();
        return "connected";
      } catch (error) {
        return (error as Error).message;
      } finally {
        await control.stop().catch(() => undefined);
      }
    };
    const withoutPeer = await connectExecutorToB();
    // 对照：补上 B 缺的 active 成员传输身份（T、E）后同一条连接应能建立，排除夹具本身的问题
    for (const member of [f.t, f.e]) {
      await bPorts.transportPeers.acceptTransportPeer({ identity: member.identity, rootCertificatePem: member.key.rootCertificatePem });
    }
    const withPeer = await connectExecutorToB();

    const facts = {
      P1b: {
        trustIssuerDevice: trustB.issuer.deviceId === f.b.identity.deviceId ? "B-device" : trustB.issuer.deviceId,
        issuerKeyIsDevice: issuerKeyB.deviceId === f.b.identity.deviceId,
        freshRemoval,
      },
      P1c: {
        ePeerOnB: ePeerOnB !== undefined,
        bPeerOnE: bPeerOnE !== undefined,
        executorBeforeMigration,
        executorAfterMigration,
        dutyWithoutPeer: withoutPeer,
        dutyWithPeer: withPeer,
      },
    };
    expect(withPeer).toBe("connected");
    // B 经迁居导入的成员连接目录认证只与 A 配过对的 E，不需要额外补传输身份
    expect(facts.P1c.ePeerOnB).toBe(true);
    expect(withoutPeer).toBe("connected");
    // 有第二台值班候选不再挡住只与值班设备配过对的执行端
    expect(executorBeforeMigration).toBe("started");
    // 迁居后新值班设备用迁居生成的 issuer key 发起移除
    expect(freshRemoval).toEqual({ phase: "accepted", signedByIssuerKey: true, deviceIsB: true });
    expect(forgedAccept).toBe("Removal receipt does not bind this target device");
    expect(genuineAccept).toBe("accepted");
  }, 120_000);
});

// 路线 A 端到端：issuer 写下终态、回执丢失后完成迁居并让 A 退役；T 只凭接受时拿到的耐久材料，
// 经冻结端点里的中继做终态发现找到 B，验过继任证明后在同一连接上进入终态入口，取回原签名回执完成退休
describe("executor removal terminal retrieval after a planned duty-device migration", () => {
  it("finds the new duty device through the frozen relay and finishes with the original receipt", async () => {
    const f = await createHomes();
    const relay = await startRelay();
    onTestFinished(() => relay.close());
    const live = await liveTarget(f, relay.port);
    const operationId = "remove-live-across-migration";
    const accepted = await f.authorityA.accept({ requestId: "request-remove-live", operationId, targetName: f.t.identity.displayName });
    // T 本机信任链停在接受时：之后的撤销与迁居都要靠继任证明补上
    const tEvents = await f.aStore.loadTrustEvents();
    await live.target.accept(accepted, await f.authorityA.terminalRoute(operationId));
    const decision = await live.target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: f.a.identity.deviceId });
    if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
    const cleanupReady = await live.target.finish(await f.authorityA.commitReady(decision.receipt));
    await f.authorityA.commitCleanupReady(cleanupReady!);
    const { issuerKeyB } = await migrate(f);
    const homeId = (await f.bStore.loadTrustRecord())!.homeId;
    // 迁居把同一份家级路由材料交给了 B
    expect(await loadHomeRouteMaterial(f.secretsB, homeId)).toEqual(await loadHomeRouteMaterial(f.secretsA, homeId));

    const controlB = await startDutyDevice(f, issuerKeyB, relay.port);
    onTestFinished(() => controlB.stop());
    const errors: string[] = [];
    await retrieveExecutorRemovalTerminal({
      target: live.target,
      deviceKey: f.t.key,
      verifier: f.verifier,
      operationId,
      signal: AbortSignal.timeout(100_000),
      localChain: async () => localChainOfEvents(tEvents),
      onError: (error) => errors.push(error.message),
      random: () => 0,
    });
    expect(await live.target.isRetired(operationId)).toBe(true);
    // 原 issuer 不通与发现兜底在同一次尝试里完成，没有报出的失败
    expect(errors).toEqual([]);
    const terminal = (await f.secretsB.get({ kind: "terminal-route", bindingId: `home-terminal/${homeId}` }))!;
    const [discoveryKey] = currentAndPreviousDiscoveryRendezvousKeys(terminal, "terminal");
    expect(relay.hellos.some((hello) => hello.role === "connect" && hello.key === discoveryKey)).toBe(true);
  }, 120_000);
});

// 第 11 节验收链：E 只与 A 配对、迁居期间离线；A 退役后 E 只凭配对所得的耐久材料经中继发现 B，B 认证 E，
// 双方在认证连接上重协商逐对秘密，之后按新秘密经中继重连。夹具不预置 B 的身份、端点或新秘密给 E。
describe("an executor paired only with the previous duty device", () => {
  it("reaches the new duty device after an offline migration with only its paired material", async () => {
    const f = await createHomes();
    const relay = await startRelay();
    onTestFinished(() => relay.close());
    const homeId = (await f.aStore.loadTrustRecord())!.homeId;
    // E 离线前的状态：A 的信任链、A 的传输身份与端点（中继），以及配对时随 committed 帧下发的家级 discovery 秘密
    await f.eStore.importTrustBootstrap({
      events: await f.aStore.loadTrustEvents(),
      record: (await f.aStore.loadTrustRecord())!,
      localDeviceId: f.e.key.deviceId,
    });
    const ePorts = createMeshBootstrapProjectionPorts(f.eStore);
    await ePorts.endpoints.acceptEndpoint({
      v: 1,
      deviceId: f.a.identity.deviceId,
      transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: relay.port } }],
      revision: 1,
      at: AT0,
    });
    const eSecrets = new MemorySecretStore();
    await persistHomeDiscoverySecret(eSecrets, homeId, (await loadOrCreateHomeRouteMaterial(f.secretsA, homeId)).discovery);

    const { issuerKeyB } = await migrate(f);
    // 夹具没有把 B 的身份、端点或逐对秘密交给 E
    expect(await ePorts.transportPeers.transportPeer(f.b.identity.deviceId)).toBeUndefined();
    expect((await ePorts.endpoints.loadEndpoints()).get(f.b.identity.deviceId)).toBeUndefined();
    expect(await eSecrets.get({ kind: "rendezvous", bindingId: f.b.identity.deviceId })).toBeNull();

    const bEndpoint: MeshEndpointDescriptor = {
      v: 1,
      deviceId: f.b.identity.deviceId,
      transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: relay.port } }],
      revision: 1,
      at: AT1,
    };
    const controlB = await startDutyDevice(f, issuerKeyB, relay.port, bEndpoint);
    onTestFinished(() => controlB.stop());

    const eTrust = (await f.eStore.loadCurrentTrust())!;
    expect(eTrust.issuer.deviceId).toBe(f.a.identity.deviceId);
    const controlE = new ProductionMeshControlPlane({
      localIdentity: f.e.key,
      trust: eTrust,
      configuration: { enabledRoles: ["executor"] },
      endpoints: await ePorts.endpoints.loadEndpoints(),
      transportPeers: await loadActiveMemberTransportPeers(ePorts.transportPeers, eTrust.members, f.e.key.deviceId),
      secretStore: eSecrets,
      endpointDirectory: ePorts.endpoints,
      transportPeerDirectory: ePorts.transportPeers,
      trustProjection: Object.freeze({ loadCurrentTrust: () => f.eStore.loadCurrentTrust() }),
      services: new MeshServiceRegistry(),
      memberDiscovery: {
        secret: () => loadHomeDiscoverySecret(eSecrets, homeId),
        localChain: () => f.eStore.discoveryLocalChain(),
        adopt: (verified) => adoptDiscoveredTrust({ store: f.eStore, verified, localIdentity: f.e.key }),
      },
      watchTrust: false,
    });
    onTestFinished(() => controlE.stop());
    await controlE.start();

    // 发现、接续与重协商之后，E 按新的逐对秘密经中继重连 B
    await waitFor(async () => {
      const secret = await eSecrets.get({ kind: "rendezvous", bindingId: f.b.identity.deviceId });
      if (!secret || secret !== await f.secretsB.get({ kind: "rendezvous", bindingId: f.e.identity.deviceId })) return false;
      const [pairwiseKey] = currentAndPreviousRendezvousKeys(secret);
      return controlB.connections.has(f.e.identity.deviceId) &&
        relay.hellos.some((hello) => hello.role === "connect" && hello.key === pairwiseKey);
    }, 60_000);
    const adopted = (await f.eStore.loadTrustRecord())!;
    expect(adopted.issuer.deviceId).toBe(f.b.identity.deviceId);
    expect(controlE.currentTrust().issuer.deviceId).toBe(f.b.identity.deviceId);
    expect((await ePorts.transportPeers.transportPeer(f.b.identity.deviceId))?.identity.deviceId).toBe(f.b.identity.deviceId);
    const discoveryKey = currentAndPreviousDiscoveryRendezvousKeys(
      (await loadOrCreateHomeRouteMaterial(f.secretsB, homeId)).discovery,
      "member",
    )[0];
    expect(relay.hellos.some((hello) => hello.role === "connect" && hello.key === discoveryKey)).toBe(true);
  }, 120_000);
});

// C22 P2b：安装完成后新值班设备上又发生信任变化（配对一台新设备），冷启动前的安装收尾核对是否还成立
describe("planned installation completion after the installed trust moves on", () => {
  it("records whether the next cold start still accepts the installation", async () => {
    const f = await createHomes();
    const { issuerKeyB } = await migrate(f);
    const complete = () => completePlannedAnchorInstallationBeforeBootstrap({
      deviceId: f.b.key.deviceId,
      secretStore: f.secretsB,
      bootstrapStore: f.bStore,
      verifier: f.verifier,
      staging: createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: f.bRoot }),
    }).then((descriptor) => ({ requiresPostInstallCompletion: descriptor?.requiresPostInstallCompletion }),
      (error: unknown) => ({ error: (error as Error).message }));
    const beforeTrustChange = await complete();
    // 运行时收尾完成：完成标记先于清理 staging 落盘（mesh-runtime-assembly 的 #completePlannedAnchorPostInstall）
    const firstStart = await completePlannedAnchorInstallationBeforeBootstrap({
      deviceId: f.b.key.deviceId,
      secretStore: f.secretsB,
      bootstrapStore: f.bStore,
      verifier: f.verifier,
      staging: createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: f.bRoot }),
    });
    if (!firstStart?.requiresPostInstallCompletion) throw new Error("fresh installation should still need post-install work");
    await finishPlannedAnchorPostInstall({
      transferId: firstStart.installation.transferId,
      readiness: f.readiness.port,
      staging: createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: f.bRoot }),
      authorityLog: f.bStore.authorityLog(),
      installedGeneration: firstStart.installedGeneration,
    });
    const newcomer = await device("新平板-N");
    f.identities.set(newcomer.identity.deviceId, newcomer.identity);
    await f.bStore.appendTrustEvent({
      event: createSignedTrustEvent({
        current: replayTrustChain(await f.bStore.loadTrustEvents()),
        signer: issuerKeyB,
        at: AT1,
        body: { t: "enroll", device: newcomer.identity, roles: ["executor"] },
      }),
      issuerKey: issuerKeyB,
    });
    const afterTrustChange = await complete();
    // 新装好时尚需收尾；收尾写下完成标记后，安装后的信任变化不再挡住冷启动
    expect(beforeTrustChange).toEqual({ requiresPostInstallCompletion: true });
    expect(afterTrustChange).toEqual({ requiresPostInstallCompletion: false });
  }, 120_000);
});

/** A → B 计划迁居：B 先对齐到当前信任（生产里经成员连接），返回 B 的迁居 issuer key 并登记进测试验签器。 */
/** 一台冻结端点指向测试中继的 target（T），其余与 createHomes 里的 target 相同。 */
async function liveTarget(f: Awaited<ReturnType<typeof createHomes>>, relayPort: number) {
  const root = await createTempDir("succession-t-live");
  const store = new FileMeshBootstrapStore(root, f.t.key);
  onTestFinished(() => store.stopStorageMaintenance());
  const endpoint: MeshEndpointDescriptor = {
    v: 1,
    deviceId: f.a.identity.deviceId,
    transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: relayPort } }],
    revision: 1,
    at: AT0,
  };
  const target = new ExecutorRemovalTarget({
    log: new FileAuthorityCommitLog(path.join(root, "removal-target"), store.artifactStore()),
    homeId: "home-succession",
    deviceKey: f.t.key,
    verifier: f.verifier,
    secretStore: new MemorySecretStore(),
    issuerRoute: async () => ({ peer: { identity: f.a.identity, rootCertificatePem: f.a.key.rootCertificatePem }, endpoint }),
    closeAdmission: async () => undefined,
    settleAcceptedWork: async () => undefined,
    releaseAdmission: async () => undefined,
    transferToAnchor: async () => undefined,
    cleanup: async () => [{ kind: "cleanup" as const, digest: protocolDigest("SuccessionCleanup", 1, { deviceId: f.t.identity.deviceId }) }],
    finalizeDeviceKey: async (operationId) => [{ kind: "cleanup" as const, digest: protocolDigest("SuccessionKeyDeleted", 1, { operationId }) }],
    now: () => AT1,
  });
  return { target };
}

/** B 以现任 issuer 启动：终态入口与家级发现入口只注册在中继上，发现服务走生产同一份逻辑。 */
async function startDutyDevice(
  f: Awaited<ReturnType<typeof createHomes>>,
  issuerKey: DeviceKey,
  relayPort: number,
  localEndpoint?: MeshEndpointDescriptor,
) {
  const authority = new CurrentIssuerDeviceRemovalAuthority({
    store: f.bStore,
    issuerKey,
    secretStore: f.secretsB,
    verifier: f.verifier,
    isReachable: () => false,
    now: () => AT1,
  });
  await authority.resumeActive();
  const terminalServices = new MeshServiceRegistry();
  registerDeviceRemovalIssuerMeshService(terminalServices, {
    authority,
    authorizeTarget: (deviceId) => authority.authorizesTarget(deviceId),
    terminalOnly: true,
  });
  const trust = (await f.bStore.loadCurrentTrust())!;
  const ports = createMeshBootstrapProjectionPorts(f.bStore);
  const services = new MeshServiceRegistry();
  const control = new ProductionMeshControlPlane({
    localIdentity: f.b.key,
    trust,
    configuration: { enabledRoles: ["anchor"], relayRegistration: { host: "127.0.0.1", port: relayPort } },
    endpoints: new MeshEndpointDirectory(),
    transportPeers: await loadActiveMemberTransportPeers(ports.transportPeers, trust.members, f.b.key.deviceId),
    secretStore: f.secretsB,
    endpointDirectory: ports.endpoints,
    transportPeerDirectory: ports.transportPeers,
    trustProjection: Object.freeze({ loadCurrentTrust: () => f.bStore.loadCurrentTrust() }),
    services,
    discovery: () => createHomeDiscoveryService({
      deviceId: f.b.key.deviceId,
      identityKey: f.b.key,
      issuerKey,
      authority,
      store: f.bStore,
      secretStore: f.secretsB,
      trust: () => trust,
      ...(localEndpoint ? { localEndpoint } : {}),
    }),
    terminalRoutes: {
      services: terminalServices,
      resolve: async (locator) => resolveExecutorRemovalTerminalRoute({
        authority,
        transportPeer: (deviceId) => ports.transportPeers.transportPeer(deviceId),
      }, locator),
      secret: async () => (await loadHomeRouteMaterial(f.secretsB, trust.homeId))?.terminal,
    },
    watchTrust: false,
  });
  registerPairwiseRenegotiationService(services, control);
  await control.start();
  return control;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startRelay() {
  const matcher = new BlindRendezvousMatcher();
  const sockets = new Set<Socket>();
  const hellos: { readonly role: string; readonly key: string }[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    void readBlindRendezvousHello(socket).then((hello) => {
      hellos.push({ role: hello.role, key: hello.key });
      try {
        matcher.accept(socket, hello);
      } catch {
        socket.destroy();
      }
    }, () => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing relay port");
  return {
    port: address.port,
    hellos,
    close: async () => {
      matcher.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function migrate(f: Awaited<ReturnType<typeof createHomes>>) {
  await f.bStore.importTrustBootstrap({
    events: await f.aStore.loadTrustEvents(),
    record: (await f.aStore.loadTrustRecord())!,
    localDeviceId: f.b.key.deviceId,
  });
  const owner = f.createOwner();
  await owner.prepare({ requestId: "request-migrate", transferId: TRANSFER_ID, targetDeviceId: f.b.key.deviceId });
  await owner.freeze({ requestId: "request-migrate", transferId: TRANSFER_ID });
  const committed = await owner.commit({ requestId: "request-migrate", transferId: TRANSFER_ID });
  expect(committed.phase).toBe("committed");
  const bTrust = (await f.bStore.loadTrustRecord())!;
  expect(bTrust.issuer.deviceId).toBe(f.b.key.deviceId);
  const issuerKeyB = await loadActiveAnchorIssuerKey(f.secretsB, bTrust.issuer.issuerKeyId);
  if (!issuerKeyB) throw new Error("migrated issuer key is not active on B");
  // 测试验签器按 keyId 查身份表：登记 B 的迁居 issuer key，后续测到的是产品的签名者核对而非测试表缺项
  f.identities.set(issuerKeyB.deviceId, enrollDeviceIdentity(issuerKeyB, { displayName: "B-issuer", platform: "headless", enrolledAt: AT0 }));
  return { issuerKeyB, committed };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  server.close();
  await once(server, "close");
  return port;
}

async function createHomes() {
  const aRoot = await createTempDir("succession-a");
  const bRoot = await createTempDir("succession-b");
  const tRoot = await createTempDir("succession-t");
  const eRoot = await createTempDir("succession-e");
  const a = await device("值班电脑-A");
  const b = await device("值班电脑-B");
  const t = await device("工作电脑-T");
  const e = await device("工作电脑-E");
  const identities = new Map<string, DeviceIdentity>([a, b, t, e].map((item) => [item.identity.deviceId, item.identity]));
  const verifier: ProtocolSignatureVerifier = {
    verify: (schemaId: string, version: number, payload: unknown, signature: Signature) => {
      const identity = identities.get(signature.keyId);
      if (!identity) throw new TypeError("Unknown test signer");
      verifyDeviceSignature(identity, schemaId, version, payload, signature);
    },
  };
  const aStore = new FileMeshBootstrapStore(aRoot, a.key);
  const bStore = new FileMeshBootstrapStore(bRoot, b.key);
  onTestFinished(async () => {
    await Promise.allSettled([aStore.stopStorageMaintenance(), bStore.stopStorageMaintenance()]);
  });
  const initialized = await aStore.initializeLocalHome({ key: a.key, identity: a.identity, roles: ["anchor"], at: AT0, homeId: "home-succession" });
  let trust = initialized.projection;
  for (const [member, roles] of [[b, ["anchor"]], [t, ["executor"]], [e, ["executor"]]] as const) {
    await aStore.appendTrustEvent({
      event: createSignedTrustEvent({
        current: trust,
        signer: a.key,
        at: AT0,
        body: { t: "enroll", device: member.identity, roles: [...roles] },
      }),
      issuerKey: a.key,
    });
    trust = replayTrustChain(await aStore.loadTrustEvents());
  }
  // 配对时双方各存对方的传输身份（mesh-pair-command.ts 870、1254）：A 与 B、T、E 各配过对，B 与 E 之间没有
  const aPorts = createMeshBootstrapProjectionPorts(aStore);
  for (const member of [b, t, e]) {
    await aPorts.transportPeers.acceptTransportPeer({ identity: member.identity, rootCertificatePem: member.key.rootCertificatePem });
  }
  const eStore = new FileMeshBootstrapStore(eRoot, e.key);
  for (const joiner of [bStore, eStore]) {
    await createMeshBootstrapProjectionPorts(joiner).transportPeers.acceptTransportPeer({ identity: a.identity, rootCertificatePem: a.key.rootCertificatePem });
  }
  const secretsA = new MemorySecretStore();
  const secretsB = new MemorySecretStore();
  const authorityA = new CurrentIssuerDeviceRemovalAuthority({
    store: aStore,
    issuerKey: a.key,
    secretStore: secretsA,
    verifier,
    isReachable: () => false,
    now: () => AT1,
  });
  const issuerEndpoint: MeshEndpointDescriptor = {
    v: 1,
    deviceId: a.identity.deviceId,
    transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: 9 } }],
    revision: 1,
    at: AT0,
  };
  const tStore = new FileMeshBootstrapStore(tRoot, t.key);
  const target = new ExecutorRemovalTarget({
    log: new FileAuthorityCommitLog(path.join(tRoot, "removal-target"), tStore.artifactStore()),
    homeId: "home-succession",
    deviceKey: t.key,
    verifier,
    secretStore: new MemorySecretStore(),
    issuerRoute: async () => ({
      peer: { identity: a.identity, rootCertificatePem: a.key.rootCertificatePem },
      endpoint: issuerEndpoint,
    }),
    closeAdmission: async () => undefined,
    settleAcceptedWork: async () => undefined,
    releaseAdmission: async () => undefined,
    transferToAnchor: async () => undefined,
    cleanup: async () => [{ kind: "cleanup" as const, digest: protocolDigest("SuccessionCleanup", 1, { deviceId: t.identity.deviceId }) }],
    finalizeDeviceKey: async (operationId) => [{ kind: "cleanup" as const, digest: protocolDigest("SuccessionKeyDeleted", 1, { operationId }) }],
    now: () => AT1,
  });
  const readiness = createPlannedAnchorReadinessCoordinator(async () => ({
    configuredCapabilities: { providers: [], mcpServers: [], channels: [] },
    protocolRevision: "protocol-v1",
    assetRevision: "assets-v1",
    serviceRevision: "services-v1",
    credentialRevision: "credentials-v1",
  }));
  let owner!: PlannedAnchorTransferOwner;
  const transferTarget = new PlannedAnchorTransferTarget({
    deviceId: b.key.deviceId,
    identityKey: b.key,
    secretStore: secretsB,
    bootstrapStore: bStore,
    authorityLog: bStore.authorityLog(),
    artifacts: bStore.artifactStore(),
    staging: createPlannedAnchorTransferStagingInfrastructure({ zhixingHome: bRoot }),
    // 与生产装配一致：目标经源端口取家级路由材料（请求方即目标设备）
    sourceFor: () => ({
      applyArtifactCommand: (command) => owner.applyArtifactCommand(command),
      routeMaterial: (transferId, requester) => owner.routeMaterial!(transferId, requester),
    }),
    signer: b.key,
    verifier,
    readiness: readiness.port,
    now: () => NOW,
  });
  onTestFinished(() => transferTarget.close());
  const createOwner = () => {
    owner = new PlannedAnchorTransferOwner({
      deviceId: a.key.deviceId,
      anchorEpoch: () => 1,
      identityKey: a.key,
      bootstrapStore: aStore,
      log: aStore.authorityLog(),
      signer: a.key,
      verifier,
      targetFor: () => transferTarget,
      artifacts: aStore.artifactStore(),
      retention: aStore.checkpointRetention(),
      ensureRecoveryCheckpoint: async () => `sha256:${"7".repeat(64)}`,
      lifecycle: { stopAccepting: () => {}, drainAccepted: async () => {}, resumeAfterAbort: () => {} },
      secretStore: secretsA,
    });
    return owner;
  };
  return { a, b, t, e, bRoot, identities, verifier, readiness, aStore, bStore, eStore, secretsA, secretsB, authorityA, target, createOwner };
}

async function device(displayName: string) {
  const key = await DeviceKey.generate();
  return { key, identity: enrollDeviceIdentity(key, { displayName, platform: "headless", enrolledAt: AT0 }) };
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
