import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  DeviceIdentity,
  DeviceRole,
  DisasterRecoveryCommand,
  HomeTrustEvent,
  MeshEndpointDescriptor,
  SecretRef,
  SecretStorePort,
  Signature,
} from "@zhixing/core/contracts";
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import {
  createSignedDisasterRecoveryCommand,
  protocolDigest,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import { BlindRendezvousMatcher, readBlindRendezvousHello } from "@zhixing/mesh/blind-rendezvous";
import { MeshEndpointDirectory } from "@zhixing/mesh/bootstrap";
import { DeviceKey, enrollDeviceIdentity, verifyDeviceSignature } from "@zhixing/mesh/device-identity";
import { loadActiveAnchorIssuerKey } from "@zhixing/mesh/device-key-store";
import { captureFullAuthorityCheckpoint } from "@zhixing/mesh/full-checkpoint";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createDomainResetEvent,
  createRecoveryRootEvent,
  createSignedTrustEvent,
  CURRENT_TRUST_PROJECTION_ID,
  homeTrustEventDigest,
  homeTrustRecordDigest,
  readTrustProjectionAt,
  replayTrustChain,
  trustBranchAdoptionId,
} from "@zhixing/mesh/trust-chain";
import { createCredentialExposureRecord } from "@zhixing/mesh/credential-exposure";
import { currentAndPreviousRendezvousKeys } from "@zhixing/mesh/bootstrap";
import {
  localChainOfEvents,
  openHomeDiscovery,
  serveHomeDiscovery,
  type HomeDiscoveryBudget,
  type HomeDiscoveryResumePoint,
  type HomeDiscoveryServerPorts,
} from "@zhixing/mesh/home-discovery";
import { createPlannedAnchorReadinessCoordinator } from "../setup-delivery.js";
import {
  createExecutorRemovalRecoveryEvidence,
  CurrentIssuerDeviceRemovalAuthority,
  ExecutorRemovalTarget,
  resolveExecutorRemovalTerminalRoute,
} from "./device-removal.js";
import { registerDeviceRemovalIssuerMeshService } from "./device-removal-mesh.js";
import { retrieveExecutorRemovalTerminal } from "./device-removal-retrieval.js";
import { createDisasterRecoveryStagingInfrastructure } from "./disaster-recovery-staging-infrastructure.js";
import {
  completeDisasterRecoveryInstallationBeforeBootstrap,
  DisasterRecoveryTarget,
} from "./disaster-recovery-target.js";
import { adoptDiscoveredTrust, createHomeDiscoveryService, memberDiscoveryResume } from "./home-discovery-service.js";
import { readDiscoveryProgress } from "./discovery-progress.js";
import {
  ensureSealedHomeRouteMaterial,
  loadHomeDiscoverySecret,
  loadHomeRouteMaterial,
  loadOrCreateHomeRouteMaterial,
  persistHomeDiscoverySecret,
} from "./home-route-material.js";
import { createMeshBootstrapProjectionPorts, loadActiveMemberTransportPeers } from "./mesh-bootstrap-projection.js";
import {
  readOpenSupersededTrustFacts,
  readPendingSupersededReports,
  readSupersededTrustFacts,
  recordSupersededTrustReport,
  restrictTrustBySupersededFacts,
  registerSupersededTrustReportService,
  SupersededTrustGovernance,
  reportSupersededTrust,
} from "./superseded-trust-report.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { ProductionMeshControlPlane, registerPairwiseRenegotiationService } from "./mesh-control-plane.js";

const AT = "2026-08-10T00:00:00.000Z";
const NOW = Date.parse("2026-08-10T01:00:00.000Z");
const HOME_ID = "home-disaster";

// 路线 A 灾备两类：issuer 写下撤销、target 的 cleanup-ready 送达前值班设备损毁。
// 基线内在途：检查点已含这次移除，B 恢复后按继任承接；基线后接受：检查点早于移除，B 按 T 的证据补做。
// 两种情况 T 都只凭接受时拿到的耐久材料，经冻结中继做终态发现找到 B（验根签提交证明），取回继任回执退休。
describe("executor removal terminal across a disaster recovery", () => {
  for (const story of ["in-flight-in-baseline", "accepted-after-baseline"] as const) {
    it(`lets the removed device finish when the removal was ${story}`, async () => {
      const f = await createHome();
      const relay = await startRelay();
      onTestFinished(() => relay.close());
      const live = await liveTarget(f, relay.port);
      const operationId = `remove-${story}`;
      if (story === "accepted-after-baseline") await f.captureCheckpoint();
      const accepted = await f.authorityA.accept({ requestId: `request-${story}`, operationId, targetName: f.t.identity.displayName });
      const tEvents = await f.sourceStore.loadTrustEvents();
      await live.target.accept(accepted, await f.authorityA.terminalRoute(operationId));
      const decision = await live.target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: f.a.identity.deviceId });
      if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
      // A 撤销 T；T 本机清理后发出 cleanup-ready，A 在收到之前损毁
      expect(await live.target.finish(await f.authorityA.commitReady(decision.receipt))).toMatchObject({ phase: "cleanup-ready" });
      if (story === "in-flight-in-baseline") await f.captureCheckpoint();

      const issuerKeyB = await f.recover();
      // 家级材料随检查点里的密封记录交到 B
      expect(await loadHomeRouteMaterial(f.secretsB, HOME_ID)).toEqual(await loadHomeRouteMaterial(f.secretsA, HOME_ID));
      const controlB = await startDutyDevice(f, issuerKeyB, relay.port);
      onTestFinished(() => controlB.stop());

      await retrieveExecutorRemovalTerminal({
        target: live.target,
        deviceKey: f.t.key,
        verifier: f.verifier,
        operationId,
        signal: AbortSignal.timeout(100_000),
        localChain: async () => localChainOfEvents(tEvents),
        random: () => 0,
      });
      expect(await live.target.isRetired(operationId)).toBe(true);
      const terminal = await live.terminalReceipt(operationId);
      // 接受这次移除的 A 已不在任：终态是 B 用灾备后 issuer key 签的继任回执，绑定 B 的任期
      expect(terminal.successor).toMatchObject({ issuerDeviceId: f.b.identity.deviceId, issuerKeyId: issuerKeyB.deviceId });
      expect(terminal.signature.keyId).toBe(issuerKeyB.deviceId);
    }, 150_000);
  }
});

// 总控 reply-05a0ac9c R3：后缀没有总量上限；超出单次会话预算时按已验证进度跨会话续做
describe("discovery suffixes beyond one session's budget", () => {
  it("lets the removed device finish across budgeted terminal discovery sessions from its durable progress", async () => {
    const f = await createHome();
    const relay = await startRelay();
    onTestFinished(() => relay.close());
    const live = await liveTarget(f, relay.port);
    const operationId = "remove-budgeted";
    const accepted = await f.authorityA.accept({ requestId: "request-budgeted", operationId, targetName: f.t.identity.displayName });
    const tEvents = await f.sourceStore.loadTrustEvents();
    await live.target.accept(accepted, await f.authorityA.terminalRoute(operationId));
    const decision = await live.target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: f.a.identity.deviceId });
    if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
    expect(await live.target.finish(await f.authorityA.commitReady(decision.receipt))).toMatchObject({ phase: "cleanup-ready" });
    await f.captureCheckpoint();
    const issuerKeyB = await f.recover();
    await appendRoleChanges(f, issuerKeyB, f.e.identity.deviceId, 3);
    const controlB = await startDutyDevice(f, issuerKeyB, relay.port, undefined, { budget: { events: 1, commits: 1 } });
    onTestFinished(() => controlB.stop());

    await retrieveExecutorRemovalTerminal({
      target: live.target,
      deviceKey: f.t.key,
      verifier: f.verifier,
      operationId,
      signal: AbortSignal.timeout(100_000),
      localChain: async () => localChainOfEvents(tEvents),
      discoveryProgress: live.progressLog,
      random: () => 0,
    });
    expect(await live.target.isRetired(operationId)).toBe(true);
    expect((await live.terminalReceipt(operationId)).successor).toMatchObject({ issuerDeviceId: f.b.identity.deviceId });
    // 中途的已验证进度耐久在 T 的本机日志里（不改 T 的信任视图）
    const last = tEvents.at(-1)!;
    const progress = await readDiscoveryProgress(live.progressLog, {
      purpose: "terminal", homeId: HOME_ID, localHead: { seq: last.seq, eventDigest: homeTrustEventDigest(last) },
    });
    expect(progress?.point.seq).toBeGreaterThan(last.seq);
    expect(progress?.point.seq).toBeLessThan((await f.targetStore.loadCurrentTrust())!.chainHead.seq);
  }, 150_000);

  it("switches a member to the recovered branch across budgeted sessions and survives a restart between them", async () => {
    const f = await createHome();
    await f.captureCheckpoint();
    const x = await device("后配的设备-X");
    await f.appendSeenByE(createSignedTrustEvent({
      current: (await f.sourceStore.loadCurrentTrust())!,
      signer: f.a.key,
      at: AT,
      body: { t: "enroll", device: x.identity, roles: ["executor"] },
    }));
    const issuerKeyB = await f.recover();
    await appendRoleChanges(f, issuerKeyB, f.t.identity.deviceId, 3);
    const budget = { events: 1, commits: 1 };
    let sessions = 0;
    for (;;) {
      const resume = await memberDiscoveryResume(f.eStore);
      // 第一次未完会话之后，后续每次都从耐久的进度接着（含冷重开之后）
      if (sessions > 0) expect(resume).toBeDefined();
      const verified = await discoverAsE(f, issuerKeyB, {}, { budget, ...(resume ? { resume } : {}) });
      sessions += 1;
      await adoptDiscoveredTrust({ store: f.eStore, verified, localIdentity: f.e.key });
      if (verified.complete) break;
      // 未完：只暂存，当前视图仍是旧分支
      expect((await f.eStore.loadTrustRecord())!.issuer.deviceId).toBe(f.a.identity.deviceId);
      if (sessions === 1) await f.reopenE();
      if (sessions > 20) throw new Error("member discovery did not complete");
    }
    expect(sessions).toBeGreaterThanOrEqual(3);
    const switched = await f.reopenE();
    expect((await switched.loadTrustRecord())!.issuer.deviceId).toBe(f.b.identity.deviceId);
    expect((await switched.loadTrustRecord())!.chainHead).toEqual((await f.targetStore.loadTrustRecord())!.chainHead);
    expect((await switched.loadCurrentTrust())!.members.some((member) => member.device.deviceId === x.identity.deviceId)).toBe(false);
  }, 150_000);
});

describe("executor removal evidence the recovered duty device must complete", () => {
  it("recovers a removal accepted on a branch the recovery superseded from the target's own chain segment", async () => {
    const f = await createHome();
    const relay = await startRelay();
    onTestFinished(() => relay.close());
    const live = await liveTarget(f, relay.port);
    await f.captureCheckpoint();
    // 检查点之后 A 又配了一台设备，再接受移除：接受点在灾备基线之外的分支上
    const x = await device("后配的设备-X");
    await f.sourceStore.appendTrustEvent({
      event: createSignedTrustEvent({ current: (await f.sourceStore.loadCurrentTrust())!, signer: f.a.key, at: AT, body: { t: "enroll", device: x.identity, roles: ["executor"] } }),
      issuerKey: f.a.key,
    });
    const operationId = "remove-on-superseded-branch";
    const accepted = await f.authorityA.accept({ requestId: "request-superseded", operationId, targetName: f.t.identity.displayName });
    const tEvents = await f.sourceStore.loadTrustEvents();
    await live.target.accept(accepted, await f.authorityA.terminalRoute(operationId));
    const decision = await live.target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: f.a.identity.deviceId });
    if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
    await live.target.finish(await f.authorityA.commitReady(decision.receipt));
    const issuerKeyB = await f.recover();
    const controlB = await startDutyDevice(f, issuerKeyB, relay.port);
    onTestFinished(() => controlB.stop());
    await retrieveExecutorRemovalTerminal({
      target: live.target,
      deviceKey: f.t.key,
      verifier: f.verifier,
      operationId,
      signal: AbortSignal.timeout(100_000),
      localChain: async () => localChainOfEvents(tEvents),
      random: () => 0,
    });
    expect(await live.target.isRetired(operationId)).toBe(true);
    // B 在自己的分支上撤销了 T（基线里它仍是 active）；X 不在 B 的分支上
    const trustB = replayTrustChain(await f.targetStore.loadTrustEvents());
    expect(trustB.members.find((member) => member.device.deviceId === f.t.identity.deviceId)?.state).toBe("revoked");
    expect(trustB.members.some((member) => member.device.deviceId === x.identity.deviceId)).toBe(false);
    expect((await live.terminalReceipt(operationId)).signature.keyId).toBe(issuerKeyB.deviceId);
  }, 150_000);

  it("completes a removal whose revocation reached the baseline without its lifecycle", async () => {
    const f = await createHome();
    const relay = await startRelay();
    onTestFinished(() => relay.close());
    const live = await liveTarget(f, relay.port);
    await f.captureCheckpoint();
    const operationId = "remove-revoked-in-baseline";
    const accepted = await f.authorityA.accept({ requestId: "request-revoked-baseline", operationId, targetName: f.t.identity.displayName });
    const tEvents = await f.sourceStore.loadTrustEvents();
    await live.target.accept(accepted, await f.authorityA.terminalRoute(operationId));
    const decision = await live.target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: f.a.identity.deviceId });
    if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
    await live.target.finish(await f.authorityA.commitReady(decision.receipt));
    // B 作为成员收到了撤销（可达证据带着它），检查点里没有这次移除
    await f.syncB();
    const issuerKeyB = await f.recover();
    expect(replayTrustChain(await f.targetStore.loadTrustEvents()).members.find((member) =>
      member.device.deviceId === f.t.identity.deviceId)?.state).toBe("revoked");
    const controlB = await startDutyDevice(f, issuerKeyB, relay.port);
    onTestFinished(() => controlB.stop());
    await retrieveExecutorRemovalTerminal({
      target: live.target,
      deviceKey: f.t.key,
      verifier: f.verifier,
      operationId,
      signal: AbortSignal.timeout(100_000),
      localChain: async () => localChainOfEvents(tEvents),
      random: () => 0,
    });
    expect(await live.target.isRetired(operationId)).toBe(true);
    expect((await live.terminalReceipt(operationId)).successor).toMatchObject({ issuerDeviceId: f.b.identity.deviceId });
  }, 150_000);
});

// 总控 reply-05a0ac9c：灾备后又经域重置、在现任链上挂起待重新配对的 target——有原撤销回执这一不可逆依据时
// 沿既有 revoke 转移收束、绝不激活；只有接受时给出领域结论，不当网络错误无限退避
describe("a removal target suspended on the current chain", () => {
  for (const irreversible of [true, false]) {
    it(irreversible
      ? "closes the removal through the existing revoke when the target holds the original revocation, never re-enrolling it"
      : "answers with the target-suspended domain state instead of retrying when only the acceptance exists", async () => {
      const f = await createHome();
      const relay = await startRelay();
      onTestFinished(() => relay.close());
      const live = await liveTarget(f, relay.port);
      const operationId = irreversible ? "remove-suspended-revoked" : "remove-suspended-accepted";
      await f.captureCheckpoint();
      const accepted = await f.authorityA.accept({ requestId: `request-${operationId}`, operationId, targetName: f.t.identity.displayName });
      const tEvents = await f.sourceStore.loadTrustEvents();
      await live.target.accept(accepted, await f.authorityA.terminalRoute(operationId));
      const decision = await live.target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: f.a.identity.deviceId });
      if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
      if (irreversible) {
        expect(await live.target.finish(await f.authorityA.commitReady(decision.receipt))).toMatchObject({ phase: "cleanup-ready" });
      }
      const issuerKeyB = await f.recover();
      // 恢复之后 home 又丢了恢复根：B 与 E 共签域重置，与新恢复根的建立原子提交；T 在 B 的链上挂起待重新配对
      const beforeReset = replayTrustChain(await f.targetStore.loadTrustEvents());
      const reset = createDomainResetEvent({ current: beforeReset, issuer: issuerKeyB, coSigner: f.e.key, at: AT });
      const afterReset = applyTrustEvent(beforeReset, reset);
      const establish = createRecoveryRootEvent({ current: afterReset, op: "establish", candidate: RecoveryRoot.generate(), outerSigner: issuerKeyB, at: AT });
      await f.targetStore.commitRecoveryRootLifecycle({
        events: [reset, establish],
        record: buildHomeTrustRecord(applyTrustEvent(afterReset, establish), issuerKeyB),
      });
      const tId = f.t.identity.deviceId;
      expect(replayTrustChain(await f.targetStore.loadTrustEvents()).members.find((member) => member.device.deviceId === tId)?.state)
        .toBe("pending-reenroll");
      const controlB = await startDutyDevice(f, issuerKeyB, relay.port);
      onTestFinished(() => controlB.stop());

      const errors: string[] = [];
      const result = await retrieveExecutorRemovalTerminal({
        target: live.target,
        deviceKey: f.t.key,
        verifier: f.verifier,
        operationId,
        signal: AbortSignal.timeout(30_000),
        localChain: async () => localChainOfEvents(tEvents),
        onError: (error) => {
          errors.push(error instanceof AggregateError ? error.errors.map((item: Error) => item.message).join(" ; ") : error.message);
        },
        random: () => 0,
      });
      const attempts = errors.length;
      const chain = await f.targetStore.loadTrustEvents();
      // 任何情形都不经重新配对把 T 激活
      expect(chain.some((event) => event.body.t === "reenroll" && event.body.deviceId === tId)).toBe(false);
      const authorityB = new CurrentIssuerDeviceRemovalAuthority({
        store: f.targetStore, issuerKey: issuerKeyB, secretStore: f.secretsB, verifier: f.verifier, isReachable: () => false,
      });
      if (irreversible) {
        expect(result, errors.slice(0, 2).join(" || ")).toEqual({ kind: "retired" });
        expect(replayTrustChain(chain).members.find((member) => member.device.deviceId === tId)?.state).toBe("revoked");
        expect((await live.terminalReceipt(operationId)).successor).toMatchObject({ issuerDeviceId: f.b.identity.deviceId });
        expect((await authorityB.operation(operationId))?.requestId).toBe(`recovered:suspended:${operationId}`);
      } else {
        // 领域结论：一次就停，不退避重试；B 的链与日志都不变（不冒充成功路径）
        expect(result).toEqual({ kind: "domain-state", state: "target-suspended" });
        expect(attempts).toBe(1);
        expect(replayTrustChain(chain).members.find((member) => member.device.deviceId === tId)?.state).toBe("pending-reenroll");
        expect(await authorityB.operation(operationId)).toBeUndefined();
        // 接受点不在现任链上（也没有可验的分叉段）：给出 domain-incompatible，同样不写任何东西
        const recovery = await live.target.terminalRecovery(operationId);
        const foreign = createExecutorRemovalRecoveryEvidence({
          transcript: "foreign-transcript",
          recovery: { ...recovery, identity: { ...recovery.identity, acceptedTrustHeadDigest: `sha256:${"9".repeat(64)}` } },
          deviceKey: f.t.key,
        });
        await expect(authorityB.acceptRecoveryEvidence(foreign, "foreign-transcript")).rejects.toMatchObject({ publicReason: "domain-incompatible" });
        expect(await authorityB.operation(operationId)).toBeUndefined();
      }
    }, 150_000);
  }
});

// 总控 reply-c0b7df17：合法灾备后仍是有效成员的离线设备自动接续当前权威分支，旧分支证据保留
describe("an offline member after a disaster recovery", () => {
  it("continues on the recovered branch without re-pairing and leaves a newer old-branch enrollment out", async () => {
    const f = await createHome();
    const relay = await startRelay();
    onTestFinished(() => relay.close());
    await f.captureCheckpoint();
    const x = await device("后配的设备-X");
    // 离线前 E 多收了一条旧值班设备的 enroll；检查点早于它，灾备基线里没有
    await f.appendSeenByE(createSignedTrustEvent({
      current: (await f.sourceStore.loadCurrentTrust())!,
      signer: f.a.key,
      at: AT,
      body: { t: "enroll", device: x.identity, roles: ["executor"] },
    }));
    // 离线前 E 还收到了旧值班设备对 T 的撤销：新分支里没有它，接续后要交给现任，而不是悄悄消失或自动生效
    await f.appendSeenByE(createSignedTrustEvent({
      current: (await f.sourceStore.loadCurrentTrust())!,
      signer: f.a.key,
      at: AT,
      body: { t: "revoke", deviceId: f.t.identity.deviceId, reason: "removed-before-disaster" },
    }));
    const marker = await appendLocalBusinessRecord(f.eStore, "before-switch");
    const issuerKeyB = await f.recover();
    const bEndpoint: MeshEndpointDescriptor = {
      v: 1,
      deviceId: f.b.identity.deviceId,
      transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: relay.port } }],
      revision: 1,
      at: AT,
    };
    const closure = { open: false };
    const controlB = await startDutyDevice(f, issuerKeyB, relay.port, bEndpoint, { closure });
    onTestFinished(() => controlB.stop());
    expect(controlB.authorizesPairwiseRenegotiation(f.t.identity.deviceId)).toBe(true);

    const ePorts = createMeshBootstrapProjectionPorts(f.eStore);
    await ePorts.endpoints.acceptEndpoint({
      v: 1,
      deviceId: f.a.identity.deviceId,
      transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: relay.port } }],
      revision: 1,
      at: AT,
    });
    const eTrust = (await f.eStore.loadCurrentTrust())!;
    const controlE = new ProductionMeshControlPlane({
      localIdentity: f.e.key,
      trust: eTrust,
      configuration: { enabledRoles: ["executor"] },
      endpoints: await ePorts.endpoints.loadEndpoints(),
      transportPeers: await loadActiveMemberTransportPeers(ePorts.transportPeers, eTrust.members, f.e.key.deviceId),
      secretStore: f.eSecrets,
      endpointDirectory: ePorts.endpoints,
      transportPeerDirectory: ePorts.transportPeers,
      trustProjection: Object.freeze({ loadCurrentTrust: () => f.eStore.loadCurrentTrust() }),
      services: new MeshServiceRegistry(),
      memberDiscovery: {
        secret: () => loadHomeDiscoverySecret(f.eSecrets, HOME_ID),
        localChain: () => f.eStore.discoveryLocalChain(),
        resume: () => memberDiscoveryResume(f.eStore),
        adopt: (verified) => adoptDiscoveredTrust({ store: f.eStore, verified, localIdentity: f.e.key }),
        onIssuerConnected: (_peer, client) => reportSupersededTrust(f.eStore, client),
      },
      watchTrust: false,
    });
    onTestFinished(() => controlE.stop());
    // 发现、分叉自查、接续发布与上报都不整读本机信任链（只在断言里读）
    const wholeChainReads = vi.spyOn(FileMeshBootstrapStore.prototype, "loadTrustEvents");
    onTestFinished(() => wholeChainReads.mockRestore());
    await controlE.start();
    await waitFor(async () => {
      const secret = await f.eSecrets.get({ kind: "rendezvous", bindingId: f.b.identity.deviceId });
      if (!secret || secret !== await f.secretsB.get({ kind: "rendezvous", bindingId: f.e.identity.deviceId })) return false;
      const [pairwiseKey] = currentAndPreviousRendezvousKeys(secret);
      return controlB.connections.has(f.e.identity.deviceId) && relay.hellos.some((hello) => hello.role === "connect" && hello.key === pairwiseKey);
    }, 60_000);
    // 现任 B 收到并验签耐久了旧分支上对 T 的撤销：收束提交之前它已是准入限制——B 的链上 T 仍是 active，
    // 但重协商授权与成员入口所读的 trust 里已没有 T
    const tId = f.t.identity.deviceId;
    await waitFor(async () => (await readSupersededTrustFacts(f.targetStore.authorityLog(), tId)).length === 1, 30_000);
    await waitFor(async () => !controlB.authorizesPairwiseRenegotiation(tId), 30_000);
    expect(controlB.currentTrust().members.some((member) => member.device.deviceId === tId)).toBe(false);
    expect((await f.targetStore.loadCurrentTrust())!.members.find((member) => member.device.deviceId === tId)?.state).toBe("active");
    // 现任按失联移除合同收束：T 在 B 的链上被撤销，限制随之解除（不再需要），T 也没有被复活
    closure.open = true;
    controlB.supersededTrust.resume();
    await controlB.supersededTrust.settled();
    expect(replayTrustChain(await f.targetStore.loadTrustEvents()).members.find((member) => member.device.deviceId === tId)?.state).toBe("revoked");
    expect(await readOpenSupersededTrustFacts(f.targetStore.authorityLog())).toEqual([]);
    expect(controlB.authorizesPairwiseRenegotiation(tId)).toBe(false);
    expect(controlB.authorizesPairwiseRenegotiation(f.e.identity.deviceId)).toBe(true);
    expect(wholeChainReads.mock.contexts.filter((store) => store === f.eStore)).toHaveLength(0);
    wholeChainReads.mockRestore();
    await controlE.stop();

    // 冷重启后仍是恢复后的分支：现任 B，旧分支独有的 X 不是成员；旧分支事件与本机业务资料都还在
    const reopened = await f.reopenE();
    const record = (await reopened.loadTrustRecord())!;
    expect(record.issuer.deviceId).toBe(f.b.identity.deviceId);
    expect((await reopened.loadCurrentTrust())!.members.some((member) => member.device.deviceId === x.identity.deviceId)).toBe(false);
    expect(replayHead(await reopened.loadTrustEvents())).toEqual(record.chainHead);
    const wal = await reopened.authorityLog().readStream<{ readonly t: string; readonly event?: { readonly body: { readonly t: string; readonly device?: { readonly deviceId: string } } } }>("trust");
    expect(wal.some(({ body }) => body.t === "home-trust-event" && body.event?.body.device?.deviceId === x.identity.deviceId)).toBe(true);
    expect(await hasLocalBusinessRecord(reopened, marker)).toBe(true);
  }, 150_000);

  it("does not let a member regain a role it lost on its own old branch between switching and reporting", async () => {
    const f = await createHome();
    // 祖先处 E 有 executor+surface；检查点之后旧值班设备拿掉了 surface（只有 E 收到）
    await f.appendSeenByE(createSignedTrustEvent({
      current: (await f.sourceStore.loadCurrentTrust())!, signer: f.a.key, at: AT,
      body: { t: "role-change", deviceId: f.e.identity.deviceId, roles: ["executor", "surface"] },
    }));
    await f.captureCheckpoint();
    await f.appendSeenByE(createSignedTrustEvent({
      current: (await f.sourceStore.loadCurrentTrust())!, signer: f.a.key, at: AT,
      body: { t: "role-change", deviceId: f.e.identity.deviceId, roles: ["executor"] },
    }));
    const issuerKeyB = await f.recover();
    const eId = f.e.identity.deviceId;
    const rolesOf = (record: { readonly members: readonly { readonly device: { readonly deviceId: string }; readonly roles: readonly string[] }[] }) =>
      record.members.find((member) => member.device.deviceId === eId)?.roles;
    const governanceE = new SupersededTrustGovernance({
      store: f.eStore, removal: () => undefined, issuerKey: () => undefined, reconcile: async () => undefined,
    });
    let atPublish: readonly string[] | undefined;
    const verified = await discoverAsE(f, issuerKeyB);
    await adoptDiscoveredTrust({
      store: f.eStore, verified, localIdentity: f.e.key,
      beforePublish: async () => {
        await governanceE.load();
        // 发布前：限制已载入（此时视图还是旧分支，E 只有 executor）
        atPublish = rolesOf(governanceE.apply((await f.eStore.loadCurrentTrust())!));
      },
    });
    expect(atPublish).toEqual(["executor"]);
    // 换视图之后：新分支上 E 仍有 surface，但进入本机控制面的视图没有
    const switched = (await f.eStore.loadCurrentTrust())!;
    expect(switched.issuer.deviceId).toBe(f.b.identity.deviceId);
    expect(rolesOf(switched)).toEqual(["executor", "surface"]);
    expect(rolesOf(governanceE.apply(switched))).toEqual(["executor"]);

    // 上报给现任 B：B 记下 E 自身的降权并立即限制；E 的待上报项确认后移出，本机限制解除
    const toB = {
      request: async (_service: string, payload: Uint8Array) => {
        const request = JSON.parse(Buffer.from(payload).toString("utf8"));
        const result = await recordSupersededTrustReport(f.targetStore.authorityLog(), {
          reportedBy: eId, ancestor: request.ancestor, branch: request.branch, from: request.from, events: request.events,
        }, { projectionAt: (point) => f.targetStore.trustProjectionAt(point), eventByDigest: (digest) => f.targetStore.trustEventByDigest(digest),
          revokedMemberAt: (deviceId, seq) => f.targetStore.revokedTrustMemberAt(deviceId, seq) });
        return Buffer.from(JSON.stringify({ v: 1, ...result }), "utf8");
      },
    } as unknown as MeshServiceClient;
    await reportSupersededTrust(f.eStore, toB);
    expect(await readPendingSupersededReports(f.eStore.authorityLog())).toEqual([]);
    const issuerView = restrictTrustBySupersededFacts(
      (await f.targetStore.loadCurrentTrust())!,
      await readOpenSupersededTrustFacts(f.targetStore.authorityLog()),
    );
    expect(rolesOf(issuerView)).toEqual(["executor"]);
  }, 150_000);

  it("keeps bounded projection snapshots identical to a full replay across a branch switch", async () => {
    const f = await createHome();
    await f.captureCheckpoint();
    // 旧分支段与新分支都跨过 64 的整数倍：切换时删旧快照、搬入暂存时算好的新快照
    for (let index = 0; index < 70; index++) {
      await f.appendSeenByE(createSignedTrustEvent({
        current: (await f.sourceStore.loadCurrentTrust())!, signer: f.a.key, at: AT,
        body: { t: "role-change", deviceId: f.t.identity.deviceId, roles: index % 2 === 0 ? ["executor", "surface"] : ["executor"] },
      }));
    }
    const issuerKeyB = await f.recover();
    await appendRoleChanges(f, issuerKeyB, f.t.identity.deviceId, 70);
    const verified = await discoverAsE(f, issuerKeyB);
    expect(verified.forked).toBe(true);
    await adoptDiscoveredTrust({ store: f.eStore, verified, localIdentity: f.e.key });
    const switched = await f.reopenE();
    // 对照用整链（只在断言里读）
    const events = await switched.loadTrustEvents();
    expect(events.length).toBeGreaterThan(70);
    for (const seq of [0, verified.ancestor!.seq, verified.ancestor!.seq + 1, 63, 64, 65, events.length - 1]) {
      const point = { seq, eventDigest: homeTrustEventDigest(events[seq]!) };
      expect(liveView(await switched.trustProjectionAt(point)), `seq ${seq}`).toEqual(liveView(replayTrustChain(events.slice(0, seq + 1))));
    }
    // 某点投影的读取与它在链上的位置无关：离最近快照同为 6 条、重放窗口同为角色变更的两点读数相同
    const reads = async (store: FileMeshBootstrapStore, chain: readonly HomeTrustEvent[], seq: number) => {
      let count = 0;
      await store.authorityLog().transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => {
        const counted = new Proxy(view, {
          get(target, property) {
            const value = Reflect.get(target, property) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (property === "get" || property === "scan") count += 1;
              return (value as (...inner: unknown[]) => unknown).apply(target, args);
            };
          },
        });
        await readTrustProjectionAt(counted, { seq, eventDigest: homeTrustEventDigest(chain[seq]!) });
        return { kind: "return" as const, value: undefined };
      });
      return count;
    };

    // 现任链上域重置之后再跨过 128：快照里旧 reset 代的成员按待重新配对写出，仍与整链重放相同
    const beforeReset = replayTrustChain(await f.targetStore.loadTrustEvents());
    const reset = createDomainResetEvent({ current: beforeReset, issuer: issuerKeyB, coSigner: f.e.key, at: AT });
    const afterReset = applyTrustEvent(beforeReset, reset);
    const establish = createRecoveryRootEvent({ current: afterReset, op: "establish", candidate: RecoveryRoot.generate(), outerSigner: issuerKeyB, at: AT });
    await f.targetStore.commitRecoveryRootLifecycle({ events: [reset, establish], record: buildHomeTrustRecord(applyTrustEvent(afterReset, establish), issuerKeyB) });
    await appendRoleChanges(f, issuerKeyB, f.b.identity.deviceId, 60, ["anchor", "executor"], ["anchor"]);
    const issuerEvents = await f.targetStore.loadTrustEvents();
    expect(issuerEvents.length).toBeGreaterThan(130);
    for (const seq of [reset.seq, 127, 128, 129, issuerEvents.length - 1]) {
      const point = { seq, eventDigest: homeTrustEventDigest(issuerEvents[seq]!) };
      expect(liveView(await f.targetStore.trustProjectionAt(point)), `issuer seq ${seq}`)
        .toEqual(liveView(replayTrustChain(issuerEvents.slice(0, seq + 1))));
      // 已撤销的历史设备不在投影里，仍按键可得（在它撤销之后的点上是已撤销成员）
      expect((await f.targetStore.revokedTrustMemberAt(f.a.identity.deviceId, seq))?.state, `issuer seq ${seq}`).toBe("revoked");
    }
    expect(issuerEvents[70]!.body.t).toBe("role-change");
    expect(issuerEvents[134]!.body.t).toBe("role-change");
    expect(await reads(f.targetStore, issuerEvents, 70)).toBe(await reads(f.targetStore, issuerEvents, 134));
  }, 150_000);

  it("resumes an interrupted switch from its staged pages", async () => {
    const f = await createHome();
    await f.captureCheckpoint();
    const x = await device("后配的设备-X");
    await f.appendSeenByE(createSignedTrustEvent({
      current: (await f.sourceStore.loadCurrentTrust())!,
      signer: f.a.key,
      at: AT,
      body: { t: "enroll", device: x.identity, roles: ["executor"] },
    }));
    const issuerKeyB = await f.recover();
    const verified = await discoverAsE(f, issuerKeyB);
    expect(verified.forked).toBe(true);
    // 中断：只写下暂存页就停了；当前视图仍是旧分支
    const superseded = (await f.eStore.loadTrustRecord())!.chainHead;
    const branch = verified.pages.flatMap((page) => page.events).filter((event) => event.seq > verified.ancestor!.seq);
    await f.eStore.authorityLog().append([{
      stream: "trust",
      body: {
        t: "home-trust-branch-staged",
        adoptionId: trustBranchAdoptionId(verified.ancestor!, superseded, homeTrustEventDigest(branch[0]!)),
        ancestor: verified.ancestor!,
        superseded,
        events: branch,
        recoveryCommits: [...verified.recoveryCommits],
      } as never,
    }]);
    const interrupted = await f.reopenE();
    expect((await interrupted.loadTrustRecord())!.issuer.deviceId).toBe(f.a.identity.deviceId);
    // 重做发现后按暂存进度续做，原子发布
    await adoptDiscoveredTrust({ store: interrupted, verified: await discoverAsE(f, issuerKeyB), localIdentity: f.e.key });
    const resumed = await f.reopenE();
    expect((await resumed.loadTrustRecord())!.issuer.deviceId).toBe(f.b.identity.deviceId);
    expect((await resumed.loadCurrentTrust())!.members.some((member) => member.device.deviceId === x.identity.deviceId)).toBe(false);
  }, 150_000);

  it("never switches for an uncommitted candidate, a superseded recovery root or its own revocation", async () => {
    // 只 prepared 的候选：链上有签名转移，拿不出根签提交证明
    const prepared = await createHome();
    await prepared.captureCheckpoint();
    await prepared.appendSeenByE(createSignedTrustEvent({
      current: (await prepared.sourceStore.loadCurrentTrust())!,
      signer: prepared.a.key,
      at: AT,
      body: { t: "enroll", device: (await device("后配的设备-Y")).identity, roles: ["executor"] },
    }));
    const preparedKey = await prepared.recover();
    const headBefore = (await prepared.eStore.loadTrustRecord())!.chainHead;
    await expect(discoverAsE(prepared, preparedKey, { recoveryCommit: async () => undefined })).rejects.toThrow();
    expect((await prepared.eStore.loadTrustRecord())!.chainHead).toEqual(headBefore);

    // E 已确认恢复根轮换：用旧根做的灾备分叉一律拒绝
    const rotated = await createHome();
    await rotated.captureCheckpoint();
    const nextRoot = RecoveryRoot.generate();
    await rotated.appendSeenByE(createRecoveryRootEvent({
      current: (await rotated.sourceStore.loadCurrentTrust())!,
      op: "rotate",
      candidate: nextRoot,
      outerSigner: rotated.recoveryRoot,
      at: AT,
    }));
    const oldRootKey = await rotated.recover();
    await expect(discoverAsE(rotated, oldRootKey)).rejects.toThrow(/superseded recovery root/);
    expect((await rotated.eStore.loadTrustRecord())!.issuer.deviceId).toBe(rotated.a.identity.deviceId);

    // E 在旧分支上已被撤销：新分支里它仍是 active，也不因换视图复活
    const revoked = await createHome();
    await revoked.captureCheckpoint();
    await revoked.appendSeenByE(createSignedTrustEvent({
      current: (await revoked.sourceStore.loadCurrentTrust())!,
      signer: revoked.a.key,
      at: AT,
      body: { t: "revoke", deviceId: revoked.e.identity.deviceId, reason: "removed" },
    }));
    const revokedKey = await revoked.recover();
    const discovered = await discoverAsE(revoked, revokedKey);
    await expect(adoptDiscoveredTrust({ store: revoked.eStore, verified: discovered, localIdentity: revoked.e.key }))
      .rejects.toThrow(/revoked on its own trust chain/);
    expect((await revoked.eStore.loadTrustRecord())!.issuer.deviceId).toBe(revoked.a.identity.deviceId);
  }, 300_000);
});

/** 投影的未撤销视图：元数据加未撤销成员（按设备排序）；有界投影不装已撤销的历史设备，按它与整链重放对照。 */
function liveView(projection: ReturnType<typeof replayTrustChain> | undefined) {
  if (!projection) return undefined;
  return {
    ...projection,
    members: projection.members
      .filter((member) => member.state !== "revoked")
      .sort((left, right) => left.device.deviceId.localeCompare(right.device.deviceId)),
  };
}

/** 现任 B 在恢复后再写 count 组角色变更（该设备在 executor 与 executor+surface 间切换），每组一条签名记录。 */
async function appendRoleChanges(
  f: Awaited<ReturnType<typeof createHome>>,
  issuerKey: DeviceKey,
  deviceId: string,
  count: number,
  even: DeviceRole[] = ["executor", "surface"],
  odd: DeviceRole[] = ["executor"],
) {
  for (let index = 0; index < count; index++) {
    await f.targetStore.appendTrustEvent({
      event: createSignedTrustEvent({
        current: (await f.targetStore.loadCurrentTrust())!,
        signer: issuerKey,
        at: AT,
        body: { t: "role-change", deviceId, roles: index % 2 === 0 ? even : odd },
      }),
      issuerKey,
    });
  }
}

/** E 与现任 B 之间的一次成员发现交换（回环连接），返回 E 验过的继任结果；ports 可替换以模拟异常服务端。 */
async function discoverAsE(
  f: Awaited<ReturnType<typeof createHome>>,
  issuerKey: DeviceKey,
  override: Partial<HomeDiscoveryServerPorts> = {},
  session: { readonly budget?: HomeDiscoveryBudget; readonly resume?: HomeDiscoveryResumePoint } = {},
) {
  const authority = new CurrentIssuerDeviceRemovalAuthority({
    store: f.targetStore,
    issuerKey,
    secretStore: f.secretsB,
    verifier: f.verifier,
    isReachable: () => false,
  });
  const trust = (await f.targetStore.loadCurrentTrust())!;
  const service = (await createHomeDiscoveryService({
    deviceId: f.b.key.deviceId,
    identityKey: f.b.key,
    issuerKey,
    authority,
    store: f.targetStore,
    secretStore: f.secretsB,
    trust: () => trust,
  }))!;
  const accepted = new Promise<Socket>((resolve) => {
    const server = createServer((socket) => resolve(socket));
    server.listen(0, "127.0.0.1");
    onTestFinished(() => server.close());
    void once(server, "listening").then(() => {
      const address = server.address() as { port: number };
      clientPort.resolve(address.port);
    });
  });
  const clientPort = deferredPort();
  const { connect } = await import("node:net");
  const client = connect({ host: "127.0.0.1", port: await clientPort.promise });
  await once(client, "connect");
  const serverSocket = await accepted;
  const served = serveHomeDiscovery({
    socket: serverSocket,
    purpose: "member",
    secret: service.secrets.member,
    ports: { ...service.ports, ...override },
    ...(session.budget ? { budget: session.budget } : {}),
    timeoutMs: 10_000,
  });
  served.catch(() => undefined);
  const opened = await openHomeDiscovery({
    socket: client,
    purpose: "member",
    secret: (await loadHomeDiscoverySecret(f.eSecrets, HOME_ID))!,
    local: (await f.eStore.discoveryLocalChain())!,
    ...(session.resume ? { resume: session.resume } : {}),
    timeoutMs: 10_000,
  });
  opened.close();
  return opened.verified;
}

function deferredPort() {
  let resolve!: (port: number) => void;
  const promise = new Promise<number>((next) => { resolve = next; });
  return { promise, resolve };
}

async function appendLocalBusinessRecord(store: FileMeshBootstrapStore, label: string) {
  const record = createCredentialExposureRecord({
    deviceId: "local-business",
    bindingId: `provider:${label}`,
    service: "provider",
    verifiedPrincipal: { verification: "service-verified", canonicalProviderPrincipal: `${label}@example.invalid` },
    markedAt: AT,
  });
  await store.authorityLog().append([{ stream: "exposure", body: record }]);
  return record.bindingId;
}

async function hasLocalBusinessRecord(store: FileMeshBootstrapStore, bindingId: string) {
  const records = await store.authorityLog().readStream<{ readonly bindingId?: string }>("exposure");
  return records.some(({ body }) => body.bindingId === bindingId);
}

function replayHead(events: readonly { readonly seq: number }[]) {
  const last = events.at(-1) as Parameters<typeof homeTrustEventDigest>[0];
  return { seq: last.seq, eventDigest: homeTrustEventDigest(last) };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function device(name: string) {
  const key = await DeviceKey.generate();
  return { key, identity: enrollDeviceIdentity(key, { displayName: name, platform: "headless", enrolledAt: AT }) };
}

async function createHome() {
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
  const sourceRoot = await createTempDir("route-a-disaster-a");
  const targetRoot = await createTempDir("route-a-disaster-b");
  const memberRoot = await createTempDir("route-a-disaster-e");
  const sourceStore = new FileMeshBootstrapStore(sourceRoot, a.key);
  const targetStore = new FileMeshBootstrapStore(targetRoot, b.key);
  let eStore = new FileMeshBootstrapStore(memberRoot, e.key);
  onTestFinished(async () => {
    await Promise.allSettled([sourceStore.stopStorageMaintenance(), targetStore.stopStorageMaintenance(), eStore.stopStorageMaintenance()]);
  });
  let trust = (await sourceStore.initializeLocalHome({ key: a.key, identity: a.identity, roles: ["anchor"], at: AT, homeId: HOME_ID })).projection;
  for (const [member, roles] of [[b, ["anchor"]], [t, ["executor"]], [e, ["executor"]]] as const) {
    trust = await sourceStore.appendTrustEvent({
      event: createSignedTrustEvent({ current: trust, signer: a.key, at: AT, body: { t: "enroll", device: member.identity, roles: [...roles] } }),
      issuerKey: a.key,
    });
  }
  const recoveryRoot = RecoveryRoot.generate();
  trust = await sourceStore.appendTrustEvent({
    event: createRecoveryRootEvent({ current: trust, op: "establish", candidate: recoveryRoot, outerSigner: a.key, at: AT }),
    issuerKey: a.key,
  });
  // 配对时 A 记下 B、T 的传输身份（随检查点交给 B）
  const aPorts = createMeshBootstrapProjectionPorts(sourceStore);
  for (const member of [b, t, e]) {
    await aPorts.transportPeers.acceptTransportPeer({ identity: member.identity, rootCertificatePem: member.key.rootCertificatePem });
  }
  const secretsA = new MemorySecretStore();
  const secretsB = new MemorySecretStore();
  // 现任启动时把家级材料密封给恢复备份钥
  await ensureSealedHomeRouteMaterial(sourceStore.authorityLog(), {
    material: await loadOrCreateHomeRouteMaterial(secretsA, HOME_ID),
    backupPublicKey: recoveryRoot.backupPublicKey,
    backupKeyId: recoveryRoot.backupKeyId,
  });
  await targetStore.importTrustBootstrap({
    events: await sourceStore.loadTrustEvents(),
    record: (await sourceStore.loadTrustRecord())!,
    localDeviceId: b.identity.deviceId,
  });
  await createMeshBootstrapProjectionPorts(targetStore).transportPeers.acceptTransportPeer({
    identity: a.identity,
    rootCertificatePem: a.key.rootCertificatePem,
  });
  await eStore.importTrustBootstrap({
    events: await sourceStore.loadTrustEvents(),
    record: (await sourceStore.loadTrustRecord())!,
    localDeviceId: e.identity.deviceId,
  });
  await createMeshBootstrapProjectionPorts(eStore).transportPeers.acceptTransportPeer({
    identity: a.identity,
    rootCertificatePem: a.key.rootCertificatePem,
  });
  const eSecrets = new MemorySecretStore();
  await persistHomeDiscoverySecret(eSecrets, HOME_ID, (await loadOrCreateHomeRouteMaterial(secretsA, HOME_ID)).discovery);
  const authorityA = new CurrentIssuerDeviceRemovalAuthority({
    store: sourceStore,
    issuerKey: a.key,
    secretStore: secretsA,
    verifier,
    isReachable: () => false,
    now: () => new Date(NOW).toISOString(),
  });
  let checkpoint: Awaited<ReturnType<typeof captureFullAuthorityCheckpoint>>["checkpoint"] | undefined;
  const staging = createDisasterRecoveryStagingInfrastructure({ zhixingHome: targetRoot });
  onTestFinished(() => staging.close());
  const readiness = createPlannedAnchorReadinessCoordinator(async () => ({
    configuredCapabilities: { providers: [], mcpServers: [], channels: [] },
    protocolRevision: "protocol-disaster-v1",
    assetRevision: "assets-disaster-v1",
    serviceRevision: "services-disaster-v1",
    credentialRevision: "credentials-disaster-v1",
  }));
  return {
    a, b, t, e, identities, verifier, sourceStore, targetStore, secretsA, secretsB, eSecrets, authorityA, recoveryRoot,
    get eStore() { return eStore; },
    /** E 冷重启：关掉旧实例，按同一目录重开。 */
    async reopenE() {
      await eStore.stopStorageMaintenance();
      eStore = new FileMeshBootstrapStore(memberRoot, e.key);
      return eStore;
    },
    /** B 与 A 的信任对齐（灾备前 B 作为成员收到了 A 的最新链）。 */
    async syncB() {
      const previous = (await targetStore.loadTrustRecord())!.chainHead;
      const events = await sourceStore.loadTrustEvents();
      await targetStore.reconcileTrustPage({ homeId: HOME_ID, previous, events: events.slice(previous.seq + 1), record: (await sourceStore.loadTrustRecord())! });
    },
    /** A 追加一条信任事件；E 在离线前收到它（按对齐分页导入）。 */
    async appendSeenByE(event: Parameters<typeof sourceStore.appendTrustEvent>[0]["event"]) {
      await sourceStore.appendTrustEvent({ event, issuerKey: a.key });
      const previous = (await eStore.loadTrustRecord())!.chainHead;
      const events = await sourceStore.loadTrustEvents();
      await eStore.reconcileTrustPage({ homeId: HOME_ID, previous, events: events.slice(previous.seq + 1), record: (await sourceStore.loadTrustRecord())! });
    },
    async captureCheckpoint() {
      const record = (await sourceStore.loadTrustRecord())!;
      checkpoint = (await captureFullAuthorityCheckpoint({
        checkpointId: "01J000000000000000000000D2",
        createdAt: new Date(NOW - 60_000).toISOString(),
        purpose: { kind: "periodic" },
        trust: record,
        issuer: Object.assign({}, a.identity, { sign: a.key.sign.bind(a.key) }),
        recipient: recoveryRoot.publicIdentity(),
        log: sourceStore.authorityLog(),
        artifacts: sourceStore.artifactStore(),
        retention: sourceStore.checkpointRetention(),
      })).checkpoint;
    },
    /** 人工无源恢复：B 以检查点与本机可达证据为基线，根签提交并安装，返回激活的 issuer key。 */
    async recover() {
      if (!checkpoint) throw new Error("no checkpoint captured");
      const target = new DisasterRecoveryTarget({
        deviceId: b.identity.deviceId,
        identity: b.identity,
        identityKey: b.key,
        secretStore: secretsB,
        sharedArtifacts: targetStore.artifactStore(),
        authorityLog: targetStore.authorityLog(),
        staging,
        readiness: readiness.port,
        now: () => NOW,
      });
      const root = recoveryRoot.publicIdentity();
      const prepare = createSignedDisasterRecoveryCommand({
        v: 1,
        op: "prepare",
        requestId: "request-recover",
        transferId: "xfer-01KXPWTM80BYB4SH423EJT1CV9",
        targetDeviceId: b.identity.deviceId,
        checkpointTargetId: "backup-dir:test",
        recoveryRoot: { homeId: HOME_ID, rootKeyId: root.rootKeyId, recipientKeyId: root.backupKeyId },
        checkpointEnvelope: checkpoint.envelope,
      }, recoveryRoot) as Extract<DisasterRecoveryCommand, { op: "prepare" }>;
      await target.prepareAndImport({ prepare, checkpoint, recoveryRoot, trustEvidence: await localTrustEvidence(targetStore, b.identity.deviceId) });
      const committed = await target.commit({ transferId: prepare.transferId, recoveryRoot });
      await completeDisasterRecoveryInstallationBeforeBootstrap({
        deviceId: b.identity.deviceId,
        secretStore: secretsB,
        bootstrapStore: targetStore,
        staging,
        now: () => NOW,
      });
      const issuerKey = await loadActiveAnchorIssuerKey(secretsB, committed.trustRecord.issuer.issuerKeyId);
      if (!issuerKey) throw new Error("recovered issuer key is not active on B");
      identities.set(issuerKey.deviceId, enrollDeviceIdentity(issuerKey, { displayName: "B-issuer", platform: "headless", enrolledAt: AT }));
      return issuerKey;
    },
  };
}

async function localTrustEvidence(store: FileMeshBootstrapStore, deviceId: string) {
  const events = await store.loadTrustEvents();
  const record = (await store.loadTrustRecord())!;
  const cut = Object.freeze([deviceId]);
  const evidence = Object.freeze([Object.freeze({ deviceId, events, record })]);
  return Object.freeze({
    cut,
    evidence,
    digest: protocolDigest("DisasterRecoveryReachabilityEvidence", 1, {
      cut,
      evidence: evidence.map((item) => ({
        deviceId: item.deviceId,
        chainHead: item.record.chainHead,
        trustEpoch: item.record.trustEpoch,
        recordDigest: homeTrustRecordDigest(item.record),
      })),
    }),
  });
}

async function liveTarget(f: Awaited<ReturnType<typeof createHome>>, relayPort: number) {
  const root = await createTempDir("route-a-disaster-t");
  const store = new FileMeshBootstrapStore(root, f.t.key);
  onTestFinished(() => store.stopStorageMaintenance());
  const endpoint: MeshEndpointDescriptor = {
    v: 1,
    deviceId: f.a.identity.deviceId,
    transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: relayPort } }],
    revision: 1,
    at: AT,
  };
  const log = new FileAuthorityCommitLog(path.join(root, "removal-target"), store.artifactStore());
  const target = new ExecutorRemovalTarget({
    log,
    homeId: HOME_ID,
    deviceKey: f.t.key,
    verifier: f.verifier,
    secretStore: new MemorySecretStore(),
    issuerRoute: async () => ({ peer: { identity: f.a.identity, rootCertificatePem: f.a.key.rootCertificatePem }, endpoint }),
    closeAdmission: async () => undefined,
    settleAcceptedWork: async () => undefined,
    releaseAdmission: async () => undefined,
    transferToAnchor: async () => undefined,
    cleanup: async () => [{ kind: "cleanup" as const, digest: protocolDigest("DisasterCleanup", 1, { deviceId: f.t.identity.deviceId }) }],
    finalizeDeviceKey: async (operationId) => [{ kind: "cleanup" as const, digest: protocolDigest("DisasterKeyDeleted", 1, { operationId }) }],
    now: () => new Date(NOW).toISOString(),
  });
  return {
    target,
    progressLog: store.authorityLog(),
    async terminalReceipt(operationId: string) {
      const { DeviceLifecycleJournal } = await import("@zhixing/core/authority");
      const state = await new DeviceLifecycleJournal(log, f.verifier).state(operationId);
      const ref = state?.peerEffects.find((effect) => effect.kind === "issuer-terminal")?.evidence.find((item) => item.artifact)?.artifact;
      if (!ref) throw new Error("no durable issuer terminal");
      return JSON.parse(Buffer.from(await log.artifactStore.get(ref)).toString("utf8")) as {
        readonly successor?: { readonly issuerDeviceId: string; readonly issuerKeyId: string };
        readonly signature: Signature;
      };
    },
  };
}

async function startDutyDevice(
  f: Awaited<ReturnType<typeof createHome>>,
  issuerKey: DeviceKey,
  relayPort: number,
  localEndpoint?: MeshEndpointDescriptor,
  options: {
    /** 旧分支事实的收束闸：关着时只有限制生效，用来观察收束前的准入。 */
    readonly closure?: { open: boolean };
    /** 发现会话预算：调小以逼出跨会话续做。 */
    readonly budget?: HomeDiscoveryBudget;
  } = {},
) {
  const supersededClosure = options.closure ?? { open: true };
  const authority = new CurrentIssuerDeviceRemovalAuthority({
    store: f.targetStore,
    issuerKey,
    secretStore: f.secretsB,
    verifier: f.verifier,
    isReachable: () => false,
    now: () => new Date(NOW).toISOString(),
  });
  await authority.resumeActive();
  const terminalServices = new MeshServiceRegistry();
  registerDeviceRemovalIssuerMeshService(terminalServices, {
    authority,
    authorizeTarget: (deviceId) => authority.authorizesTarget(deviceId),
    terminalOnly: true,
  });
  const trust = (await f.targetStore.loadCurrentTrust())!;
  const ports = createMeshBootstrapProjectionPorts(f.targetStore);
  const services = new MeshServiceRegistry();
  const supersededTrust = new SupersededTrustGovernance({
    store: f.targetStore,
    removal: () => (supersededClosure.open ? authority : undefined),
    issuerKey: () => issuerKey,
    reconcile: async () => {
      const current = await f.targetStore.loadCurrentTrust();
      if (current) await control.reconcileTrust(current);
    },
    now: () => new Date(NOW).toISOString(),
  });
  onTestFinished(() => supersededTrust.stop());
  await supersededTrust.load();
  const control = new ProductionMeshControlPlane({
    localIdentity: f.b.key,
    trust,
    configuration: { enabledRoles: ["anchor"], relayRegistration: { host: "127.0.0.1", port: relayPort } },
    endpoints: new MeshEndpointDirectory(),
    transportPeers: await loadActiveMemberTransportPeers(ports.transportPeers, trust.members, f.b.key.deviceId),
    secretStore: f.secretsB,
    endpointDirectory: ports.endpoints,
    transportPeerDirectory: ports.transportPeers,
    trustProjection: Object.freeze({ loadCurrentTrust: () => f.targetStore.loadCurrentTrust() }),
    services,
    discovery: async () => {
      const service = await createHomeDiscoveryService({
        deviceId: f.b.key.deviceId,
        identityKey: f.b.key,
        issuerKey,
        authority,
        store: f.targetStore,
        secretStore: f.secretsB,
        trust: () => trust,
        ...(localEndpoint ? { localEndpoint } : {}),
      });
      return service && options.budget ? { ...service, budget: options.budget } : service;
    },
    terminalRoutes: {
      services: terminalServices,
      resolve: async (locator) => resolveExecutorRemovalTerminalRoute({
        authority,
        transportPeer: (deviceId) => ports.transportPeers.transportPeer(deviceId),
      }, locator),
      secret: async () => (await loadHomeRouteMaterial(f.secretsB, HOME_ID))?.terminal,
    },
    restrictTrust: supersededTrust.apply,
    watchTrust: false,
  });
  registerPairwiseRenegotiationService(services, control);
  registerSupersededTrustReportService(services, {
    store: f.targetStore,
    authorize: (deviceId) => control.authorizesPairwiseRenegotiation(deviceId),
    onRecorded: () => supersededTrust.onRecorded(),
  });
  await control.start();
  supersededTrust.resume();
  return Object.assign(control, { supersededTrust });
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

class MemorySecretStore implements SecretStorePort {
  readonly #values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> { this.#values.set(`${ref.kind}/${ref.bindingId}`, value); }
  async get(ref: SecretRef): Promise<string | null> { return this.#values.get(`${ref.kind}/${ref.bindingId}`) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const key = `${ref.kind}/${ref.bindingId}`;
    const existing = this.#values.get(key);
    if (existing !== undefined) return existing;
    const value = create();
    this.#values.set(key, value);
    return value;
  }
  async delete(ref: SecretRef): Promise<void> { this.#values.delete(`${ref.kind}/${ref.bindingId}`); }
  async list(): Promise<readonly SecretRef[]> {
    return [...this.#values.keys()].map((value) => {
      const [kind, ...binding] = value.split("/");
      return { kind: kind as SecretRef["kind"], bindingId: binding.join("/") };
    });
  }
  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}
