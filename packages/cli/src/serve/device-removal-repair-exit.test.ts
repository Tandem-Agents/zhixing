import { describe, expect, it, vi } from "vitest";

// 同一台机器上的两个 home 默认都用本机名：配对时按角色给出不同名称，按名称选择移除目标
const host = vi.hoisted(() => ({ name: "duty-device" }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), hostname: () => host.name }));
import type { MeshEndpointDescriptor, SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceLifecycleJournal } from "@zhixing/core/authority";
import { protocolDigest } from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { applyTrustEvent, buildHomeTrustRecord, createDomainResetEvent, createRecoveryRootEvent, homeTrustEventDigest, replayTrustChain } from "@zhixing/mesh/trust-chain";
import { CurrentIssuerDeviceRemovalAuthority, ExecutorRemovalTarget, settleExecutorRemovalBeforeBootstrap, supersedeRemovalsByPairing } from "./device-removal.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { loadExistingDeviceKey, replacedDeviceOf } from "./mesh-device-key.js";
import { createPairingTrustEvent, runPairCommand } from "./mesh-pair-command.js";

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> { this.values.set(`${ref.kind}/${ref.bindingId}`, value); }
  async get(ref: SecretRef): Promise<string | null> { return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const existing = await this.get(ref);
    if (existing !== null) return existing;
    const value = create();
    await this.put(ref, value);
    return value;
  }
  async delete(ref: SecretRef): Promise<void> { this.values.delete(`${ref.kind}/${ref.bindingId}`); }
  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => {
      const separator = entry.indexOf("/");
      return { kind: entry.slice(0, separator) as SecretRef["kind"], bindingId: entry.slice(separator + 1) };
    });
  }
  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}

/** 真实配对入口：值班设备发起，加入方完成加入。 */
async function pair(anchor: { home: string; secrets: MemorySecretStore }, joiner: { home: string; secrets: MemorySecretStore }): Promise<void> {
  let resolveInvitation!: (value: string) => void;
  const invitation = new Promise<string>((resolve) => { resolveInvitation = resolve; });
  host.name = "duty-device";
  const issuer = runPairCommand({
    zhixingHome: anchor.home, secretStore: anchor.secrets, composition: "production",
    confirmRecoveryPackage: async (encoded) => encoded,
    showPairingInvitation: async (display) => { resolveInvitation(display.invitation); },
    reconcileManagedService: async () => undefined,
    advertise: "127.0.0.1:0",
    selectDutyDevice: async () => "paired",
    migrateDutyTo: async () => undefined,
    writeLine: () => undefined,
  });
  const encoded = await invitation;
  host.name = "removed-device";
  await runPairCommand({
    zhixingHome: joiner.home, secretStore: joiner.secrets, composition: "production",
    promptExecutorAutoStart: async () => false,
    invitation: encoded,
    completeDeviceConfiguration: async () => "ready",
    reconcileManagedService: async () => undefined,
    writeLine: () => undefined,
  });
  await issuer;
}

// 值班链上待重新配对的设备（撤销阶段、没有撤销凭据的旧移除）经显式重新配对以原身份接回：
// 旧移除被取代后冷重开正常装配；值班设备随后用这次移除的旧 ready 回执撤销时，在撤销提交点被取代守卫挡下
describe("explicit re-pairing as the exit of a suspended removal target", () => {
  it("re-enrolls the same identity, supersedes the old removal and refuses the late old revocation", async () => {
    const anchor = { home: await createTempDir("resume-anchor"), secrets: new MemorySecretStore() };
    const device = { home: await createTempDir("resume-device"), secrets: new MemorySecretStore() };
    await pair(anchor, device);
    const anchorKey = (await loadExistingDeviceKey(anchor.secrets))!;
    const deviceKey = (await loadExistingDeviceKey(device.secrets))!;
    const anchorStore = await FileMeshBootstrapStore.open(anchor.home, anchorKey, { secretStore: anchor.secrets });
    const deviceStore = await FileMeshBootstrapStore.open(device.home, deviceKey, { secretStore: device.secrets });
    const anchorVerifier = anchorStore.authoritySources()!.verifier;
    const deviceVerifier = deviceStore.authoritySources()!.verifier;
    const trust = (await anchorStore.loadTrustRecord())!;
    const anchorIdentity = trust.members.find((member) => member.device.deviceId === anchorKey.deviceId)!.device;
    const targetName = trust.members.find((member) => member.device.deviceId === deviceKey.deviceId)!.device.displayName;
    // 值班端运行期守卫：生产装配里由它决定这台设备能否使用、迁居门是否开放
    const guards = new Map<string, string>();
    const authority = () => new CurrentIssuerDeviceRemovalAuthority({
      store: anchorStore, issuerKey: anchorKey, secretStore: anchor.secrets, verifier: anchorVerifier, isReachable: () => false,
      onGuardChanged: (deviceId, operationId) => { if (operationId === undefined) guards.delete(deviceId); else guards.set(deviceId, operationId); },
    });
    const endpoint: MeshEndpointDescriptor = {
      v: 1, deviceId: anchorKey.deviceId, transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: 9 } }],
      revision: 1, at: "2026-10-28T00:00:00.000Z",
    };
    let cleaned = 0, keyDeleted = 0;
    const target = new ExecutorRemovalTarget({
      log: deviceStore.authorityLog(), homeId: trust.homeId, deviceKey, verifier: deviceVerifier, secretStore: device.secrets,
      issuerRoute: async () => ({ peer: { identity: anchorIdentity, rootCertificatePem: anchorKey.rootCertificatePem }, endpoint }),
      closeAdmission: async () => undefined, settleAcceptedWork: async () => undefined, releaseAdmission: async () => undefined,
      transferToAnchor: async () => undefined,
      cleanup: async () => { cleaned++; return [{ kind: "cleanup" as const, digest: protocolDigest("ResumeExitCleanup", 1, {}) }]; },
      finalizeDeviceKey: async () => { keyDeleted++; return [{ kind: "cleanup" as const, digest: protocolDigest("ResumeExitKey", 1, {}) }]; },
    });
    const operationId = "remove-suspended-repair";
    const accepted = await authority().accept({ requestId: `request-${operationId}`, operationId, targetName });
    await target.accept(accepted, await authority().terminalRoute(operationId));
    const decision = await target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: anchorKey.deviceId });
    if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
    // 值班链域重置（T 共签）并建立新恢复根：T 在值班链上待重新配对，本机仍停在撤销阶段、没有撤销凭据
    const before = replayTrustChain(await anchorStore.loadTrustEvents());
    const reset = createDomainResetEvent({ current: before, issuer: anchorKey, coSigner: deviceKey, at: "2026-10-28T00:10:00.000Z" });
    const afterReset = applyTrustEvent(before, reset);
    const establish = createRecoveryRootEvent({ current: afterReset, op: "establish", candidate: RecoveryRoot.generate(), outerSigner: anchorKey, at: "2026-10-28T00:10:30.000Z" });
    await anchorStore.commitRecoveryRootLifecycle({ events: [reset, establish], record: buildHomeTrustRecord(applyTrustEvent(afterReset, establish), anchorKey) });
    expect(replayTrustChain(await anchorStore.loadTrustEvents()).members.find((member) => member.device.deviceId === deviceKey.deviceId)?.state)
      .toBe("pending-reenroll");
    expect(await settleExecutorRemovalBeforeBootstrap({ log: deviceStore.authorityLog(), verifier: deviceVerifier, secretStore: device.secrets }))
      .toMatchObject({ kind: "retrieval", operationId });
    await deviceStore.stopStorageMaintenance();

    expect(guards.get(deviceKey.deviceId)).toBe(operationId);

    // 值班设备发起配对、这台设备以原身份完成加入：reenroll，不切换身份
    await pair(anchor, device);
    expect((await loadExistingDeviceKey(device.secrets))!.deviceId).toBe(deviceKey.deviceId);
    expect(await replacedDeviceOf(device.secrets, deviceKey.deviceId)).toBeUndefined();
    // 值班端：已知的旧移除随配对提交结束，不需要迟到的旧消息；运行中的宿主在信任对账时按同一事实解除守卫
    expect((await new DeviceLifecycleJournal(anchorStore.authorityLog(), anchorVerifier).state(operationId))?.terminalOutcome).toBe("superseded");
    await authority().releaseSupersededGuard(deviceKey.deviceId, operationId);
    expect(guards.has(deviceKey.deviceId)).toBe(false);
    // 冷开：启动恢复不再为它设守卫
    await authority().resumeActive();
    expect(guards.size).toBe(0);
    // 这台设备：加入完成时旧移除已在本机终结，冷开结算直接正常装配
    const reopened = await FileMeshBootstrapStore.open(device.home, deviceKey, { secretStore: device.secrets });
    try {
      const verifier = reopened.authoritySources()!.verifier;
      expect((await new DeviceLifecycleJournal(reopened.authorityLog(), verifier).state(operationId))?.terminalOutcome).toBe("superseded");
      expect(await settleExecutorRemovalBeforeBootstrap({ log: reopened.authorityLog(), verifier, secretStore: device.secrets }))
        .toEqual({ kind: "none" });
      expect(cleaned).toBe(0);
      expect(keyDeleted).toBe(0);
      expect((await reopened.loadTrustRecord())!.members.find((member) => member.device.deviceId === deviceKey.deviceId)?.state).toBe("active");
    } finally { await reopened.stopStorageMaintenance(); }

    // 旧 ready 回执迟到：不撤销，给出 superseded 结论，守卫保持解除
    await expect(authority().commitReady(decision.receipt)).rejects.toMatchObject({ publicReason: "superseded" });
    expect(guards.has(deviceKey.deviceId)).toBe(false);
    const chain = await anchorStore.loadTrustEvents();
    expect(chain.at(-1)?.body).toMatchObject({ t: "reenroll", deviceId: deviceKey.deviceId });
    expect(replayTrustChain(chain).members.find((member) => member.device.deviceId === deviceKey.deviceId)?.state).toBe("active");
    await anchorStore.stopStorageMaintenance();
  }, 180_000);

  it("converges the issuer guard by the same fact when the pairing was committed but its termination was interrupted", async () => {
    const anchor = { home: await createTempDir("resume-anchor-cut"), secrets: new MemorySecretStore() };
    const device = { home: await createTempDir("resume-device-cut"), secrets: new MemorySecretStore() };
    await pair(anchor, device);
    const anchorKey = (await loadExistingDeviceKey(anchor.secrets))!;
    const deviceKey = (await loadExistingDeviceKey(device.secrets))!;
    const anchorStore = await FileMeshBootstrapStore.open(anchor.home, anchorKey, { secretStore: anchor.secrets });
    const anchorVerifier = anchorStore.authoritySources()!.verifier;
    const trust = (await anchorStore.loadTrustRecord())!;
    const targetName = trust.members.find((member) => member.device.deviceId === deviceKey.deviceId)!.device.displayName;
    const running = new Map<string, string>(), cold = new Map<string, string>();
    const authority = (guards: Map<string, string>) => new CurrentIssuerDeviceRemovalAuthority({
      store: anchorStore, issuerKey: anchorKey, secretStore: anchor.secrets, verifier: anchorVerifier, isReachable: () => false,
      onGuardChanged: (deviceId, operationId) => { if (operationId === undefined) guards.delete(deviceId); else guards.set(deviceId, operationId); },
    });
    try {
      const operationId = "remove-before-repair";
      await authority(running).accept({ requestId: `request-${operationId}`, operationId, targetName });
      // 别的设备、配对之后才发起的移除不受影响：这里先确认只有它被守卫
      expect([...running]).toEqual([[deviceKey.deviceId, operationId]]);
      const before = replayTrustChain(await anchorStore.loadTrustEvents());
      const reset = createDomainResetEvent({ current: before, issuer: anchorKey, coSigner: deviceKey, at: "2026-10-28T00:10:00.000Z" });
      const afterReset = applyTrustEvent(before, reset);
      const establish = createRecoveryRootEvent({ current: afterReset, op: "establish", candidate: RecoveryRoot.generate(), outerSigner: anchorKey, at: "2026-10-28T00:10:30.000Z" });
      await anchorStore.commitRecoveryRootLifecycle({ events: [reset, establish], record: buildHomeTrustRecord(applyTrustEvent(afterReset, establish), anchorKey) });
      // 配对已提交（生产配对事件）、终结旧移除之前中断：旧移除仍活着
      const pairing = createPairingTrustEvent({
        current: replayTrustChain(await anchorStore.loadTrustEvents()), device: trust.members.find((member) => member.device.deviceId === deviceKey.deviceId)!.device,
        roles: ["executor"], pairingTranscriptDigest: "sha256:interrupted-repair", at: "2026-10-28T00:11:00.000Z", issuerKey: anchorKey,
      });
      expect(pairing.body.t).toBe("reenroll");
      await anchorStore.appendTrustEvent({ event: pairing, issuerKey: anchorKey });
      expect((await new DeviceLifecycleJournal(anchorStore.authorityLog(), anchorVerifier).state(operationId))?.phase).not.toBe("terminal");
      // 冷开：启动恢复按同一事实终结它，不设守卫、不中断启动
      await authority(cold).resumeActive();
      expect(cold.size).toBe(0);
      expect((await new DeviceLifecycleJournal(anchorStore.authorityLog(), anchorVerifier).state(operationId))?.terminalOutcome).toBe("superseded");
      // 仍在运行、守卫着它的宿主：信任对账即解除，不需要旧消息
      await authority(running).releaseSupersededGuard(deviceKey.deviceId, operationId);
      expect(running.size).toBe(0);
      // 配对之后对同一设备的新移除照常被守卫，不被这次配对取代
      const next = "remove-after-repair";
      await authority(running).accept({ requestId: `request-${next}`, operationId: next, targetName });
      await authority(running).releaseSupersededGuard(deviceKey.deviceId, next);
      expect(running.get(deviceKey.deviceId)).toBe(next);
      // 旧配对的收尾迟到重放（响应丢失后的续接）：只终结接受点早于这次配对的移除，新移除照常可撤销
      await supersedeRemovalsByPairing({
        log: anchorStore.authorityLog(), verifier: anchorVerifier, deviceId: deviceKey.deviceId, pairingEventDigest: homeTrustEventDigest(pairing),
      });
      const after = await new DeviceLifecycleJournal(anchorStore.authorityLog(), anchorVerifier).state(next);
      expect(after?.phase).not.toBe("terminal");
      await authority(cold).resumeActive();
      expect(cold.get(deviceKey.deviceId)).toBe(next);
    } finally { await anchorStore.stopStorageMaintenance(); }
  }, 180_000);
});

// 已按失联移出的设备经显式重新配对重新接入：值班设备发起配对、这台设备完成加入，以新身份加入；
// 旧移除被取代后冷重开正常装配，不删资料、不重开旧成员权限，旧钥隔离保留
describe("explicit re-pairing as the exit of a lost removal", () => {
  it("joins with a new identity, supersedes the old removal and starts normally after a cold reopen", async () => {
    const anchor = { home: await createTempDir("repair-anchor"), secrets: new MemorySecretStore() };
    const device = { home: await createTempDir("repair-device"), secrets: new MemorySecretStore() };
    await pair(anchor, device);

    const anchorKey = (await loadExistingDeviceKey(anchor.secrets))!;
    const oldKey = (await loadExistingDeviceKey(device.secrets))!;
    const anchorStore = await FileMeshBootstrapStore.open(anchor.home, anchorKey, { secretStore: anchor.secrets });
    const deviceStore = await FileMeshBootstrapStore.open(device.home, oldKey, { secretStore: device.secrets });
    const anchorVerifier = anchorStore.authoritySources()!.verifier;
    const deviceVerifier = deviceStore.authoritySources()!.verifier;
    const trust = (await anchorStore.loadTrustRecord())!;
    const anchorIdentity = trust.members.find((member) => member.device.deviceId === anchorKey.deviceId)!.device;
    const targetName = trust.members.find((member) => member.device.deviceId === oldKey.deviceId)!.device.displayName;
    const authority = new CurrentIssuerDeviceRemovalAuthority({
      store: anchorStore, issuerKey: anchorKey, secretStore: anchor.secrets, verifier: anchorVerifier, isReachable: () => false,
    });
    const endpoint: MeshEndpointDescriptor = {
      v: 1, deviceId: anchorKey.deviceId, transports: [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: 9 } }],
      revision: 1, at: "2026-10-28T00:00:00.000Z",
    };
    let cleaned = 0, keyDeleted = 0;
    const target = new ExecutorRemovalTarget({
      log: deviceStore.authorityLog(), homeId: trust.homeId, deviceKey: oldKey, verifier: deviceVerifier, secretStore: device.secrets,
      issuerRoute: async () => ({ peer: { identity: anchorIdentity, rootCertificatePem: anchorKey.rootCertificatePem }, endpoint }),
      closeAdmission: async () => undefined, settleAcceptedWork: async () => undefined, releaseAdmission: async () => undefined,
      transferToAnchor: async () => undefined,
      cleanup: async () => { cleaned++; return [{ kind: "cleanup" as const, digest: protocolDigest("RepairExitCleanup", 1, {}) }]; },
      finalizeDeviceKey: async () => { keyDeleted++; return [{ kind: "cleanup" as const, digest: protocolDigest("RepairExitKey", 1, {}) }]; },
    });
    const operationId = "remove-lost-repair";
    const accepted = await authority.accept({ requestId: `request-${operationId}`, operationId, targetName });
    await target.accept(accepted, await authority.terminalRoute(operationId));
    expect((await target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: anchorKey.deviceId })).kind).toBe("ready");
    // 值班设备按失联移出：本机持 lost 回执，启动被旧 lost 门挡住
    await target.finish(await authority.commitLost(operationId));
    expect(await settleExecutorRemovalBeforeBootstrap({ log: deviceStore.authorityLog(), verifier: deviceVerifier, secretStore: device.secrets }))
      .toMatchObject({ kind: "lost" });
    await deviceStore.stopStorageMaintenance();
    await anchorStore.stopStorageMaintenance();

    // 显式重新配对：原身份已撤销，以新身份加入；配对完成并校验后才切换当前身份
    await pair(anchor, device);
    const newKey = (await loadExistingDeviceKey(device.secrets))!;
    expect(newKey.deviceId).not.toBe(oldKey.deviceId);
    expect(await replacedDeviceOf(device.secrets, newKey.deviceId)).toBe(oldKey.deviceId);
    expect(device.secrets.values.has(`device-key/retired/v1/${oldKey.deviceId}`)).toBe(true);

    // 冷重开：旧移除在加入完成时已按 superseded 终结（绑定本次配对），启动结算直接正常装配，不读信任链
    const reopened = await FileMeshBootstrapStore.open(device.home, newKey, { secretStore: device.secrets });
    try {
      const verifier = reopened.authoritySources()!.verifier;
      expect(await settleExecutorRemovalBeforeBootstrap({ log: reopened.authorityLog(), verifier, secretStore: device.secrets }))
        .toEqual({ kind: "none" });
      const superseded = await new DeviceLifecycleJournal(reopened.authorityLog(), verifier).state(operationId);
      expect(superseded?.terminalOutcome).toBe("superseded");
      expect(superseded?.evidence.map((item) => item.kind)).toEqual(expect.arrayContaining(["trust-event", "accepted-work"]));
      // 旧移除没有清理、没有删钥
      expect(cleaned).toBe(0);
      expect(keyDeleted).toBe(0);
      const local = (await reopened.loadTrustRecord())!.members.find((member) => member.device.deviceId === newKey.deviceId);
      expect(local?.state).toBe("active");
      expect((await reopened.loadTrustRecord())!.members.find((member) => member.device.deviceId === oldKey.deviceId)?.state).not.toBe("active");

      // 新配对之后对新身份发起的新移除照常可用：撤销提交点的取代判断只看那次移除自己的接受点
      const anchorAgain = await FileMeshBootstrapStore.open(anchor.home, anchorKey, { secretStore: anchor.secrets });
      try {
        const authorityAgain = new CurrentIssuerDeviceRemovalAuthority({
          store: anchorAgain, issuerKey: anchorKey, secretStore: anchor.secrets, verifier: anchorAgain.authoritySources()!.verifier, isReachable: () => false,
        });
        const nextTarget = new ExecutorRemovalTarget({
          log: reopened.authorityLog(), homeId: trust.homeId, deviceKey: newKey, verifier, secretStore: device.secrets,
          issuerRoute: async () => ({ peer: { identity: anchorIdentity, rootCertificatePem: anchorKey.rootCertificatePem }, endpoint }),
          closeAdmission: async () => undefined, settleAcceptedWork: async () => undefined, releaseAdmission: async () => undefined,
          transferToAnchor: async () => undefined,
          cleanup: async () => [{ kind: "cleanup" as const, digest: protocolDigest("RepairExitNextCleanup", 1, {}) }],
          finalizeDeviceKey: async () => [{ kind: "cleanup" as const, digest: protocolDigest("RepairExitNextKey", 1, {}) }],
        });
        const nextOperation = "remove-after-repair";
        const nextAccepted = await authorityAgain.accept({ requestId: `request-${nextOperation}`, operationId: nextOperation, targetName });
        await nextTarget.accept(nextAccepted, await authorityAgain.terminalRoute(nextOperation));
        const decision = await nextTarget.decide({ operationId: nextOperation, mode: "destroy", currentAnchorDeviceId: anchorKey.deviceId });
        if (decision.kind !== "ready") throw new Error("new removal did not reach revocation-ready");
        const revoked = await authorityAgain.commitReady(decision.receipt);
        expect(revoked.phase).toBe("revoked");
        expect(await nextTarget.finish(revoked)).toMatchObject({ phase: "cleanup-ready" });
        expect(await nextTarget.isSuperseded(nextOperation)).toBe(false);
      } finally { await anchorAgain.stopStorageMaintenance(); }
    } finally { await reopened.stopStorageMaintenance(); }
  }, 180_000);
});
