import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished } from "vitest";
import type { DeviceIdentity, HomeTrustEvent, SecretRef, SecretStorePort, Signature } from "@zhixing/core/contracts";
import type { ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import { DeviceKey, enrollDeviceIdentity, verifyDeviceSignature } from "@zhixing/mesh/device-identity";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import {
  applyTrustEvent,
  createSignedTrustEvent,
  homeTrustEventDigest,
  replayTrustChain,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import { CurrentIssuerDeviceRemovalAuthority } from "./device-removal.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  readOpenSupersededTrustFacts,
  readPendingSupersededReports,
  recordSupersededTrustPending,
  recordSupersededTrustReport,
  reportSupersededTrust,
  restrictTrustBySupersededFacts,
  SupersededTrustGovernance,
  type SupersededTrustChainPort,
  type SupersededTrustFact,
} from "./superseded-trust-report.js";

const AT = "2026-08-10T00:00:00.000Z";

async function device(name: string) {
  const key = await DeviceKey.generate();
  return { key, identity: enrollDeviceIdentity(key, { displayName: name, platform: "headless", enrolledAt: AT }) };
}

/** 现任 A 的家：M 有两个角色，T、E、R 各一个；旧分支事件由 A 从当前链头签出，不写进本机链。 */
async function createHome() {
  const [a, m, t, e, r, x] = await Promise.all(["A", "M", "T", "E", "R", "X"].map((name) => device(name)));
  const identities = new Map<string, DeviceIdentity>([a, m, t, e, r, x].map((item) => [item.identity.deviceId, item.identity]));
  const verifier: ProtocolSignatureVerifier = {
    verify: (schemaId: string, version: number, payload: unknown, signature: Signature) => {
      const identity = identities.get(signature.keyId);
      if (!identity) throw new TypeError("Unknown test signer");
      verifyDeviceSignature(identity, schemaId, version, payload, signature);
    },
  };
  const store = new FileMeshBootstrapStore(await createTempDir("superseded-trust"), a.key);
  onTestFinished(() => store.stopStorageMaintenance());
  let trust: TrustProjection = (await store.initializeLocalHome({ key: a.key, identity: a.identity, roles: ["anchor"], at: AT, homeId: "home" })).projection;
  for (const [member, roles] of [[m, ["executor", "surface"]], [t, ["executor"]], [e, ["executor"]], [r, ["executor"]]] as const) {
    trust = await store.appendTrustEvent({
      event: createSignedTrustEvent({ current: trust, signer: a.key, at: AT, body: { t: "enroll", device: member.identity, roles: [...roles] } }),
      issuerKey: a.key,
    });
  }
  /** 从公共祖先另起一条旧分支（同一祖先可以先后被取代多条）。 */
  const forkFromAncestor = () => {
    const events: HomeTrustEvent[] = [];
    let branch = trust;
    const sign = (body: Parameters<typeof createSignedTrustEvent>[0]["body"]) => {
      const event = createSignedTrustEvent({ current: branch, signer: a.key, at: AT, body });
      branch = applyTrustEvent(branch, event);
      events.push(event);
    };
    return { events, sign };
  };
  const first = forkFromAncestor();
  return { a, m, t, e, r, x, store, verifier, ancestor: trust.chainHead, oldBranch: first.events, sign: first.sign, forkFromAncestor };
}

const roles = (projection: TrustProjection, deviceId: string) =>
  projection.members.find((member) => member.device.deviceId === deviceId);

/** 现任验上报的本机链读取，全部按摘要与键（不整读信任流）。 */
const chainOf = (store: FileMeshBootstrapStore): SupersededTrustChainPort => ({
  projectionAt: (point) => store.trustProjectionAt(point),
  eventByDigest: (digest) => store.trustEventByDigest(digest),
  revokedMemberAt: (deviceId, seq) => store.revokedTrustMemberAt(deviceId, seq),
});
const pointOf = (event: HomeTrustEvent) => ({ seq: event.seq, eventDigest: homeTrustEventDigest(event) });
const branchOf = (events: readonly HomeTrustEvent[]) => homeTrustEventDigest(events[0]!);

describe("superseded trust facts on the current issuer", () => {
  it("records only revocations and ancestor-role removals of devices the common ancestor already had", async () => {
    const f = await createHome();
    f.sign({ t: "role-change", deviceId: f.m.identity.deviceId, roles: ["executor"] });
    f.sign({ t: "revoke", deviceId: f.t.identity.deviceId, reason: "removed-before-disaster" });
    // 旧分支独有的配对与提权、以及提权后再拿掉的角色：都不并入
    f.sign({ t: "enroll", device: f.x.identity, roles: ["executor"] });
    f.sign({ t: "revoke", deviceId: f.x.identity.deviceId, reason: "old-branch-only" });
    f.sign({ t: "role-change", deviceId: f.e.identity.deviceId, roles: ["executor", "surface"] });
    f.sign({ t: "role-change", deviceId: f.e.identity.deviceId, roles: ["executor"] });
    const log = f.store.authorityLog();
    const chain = chainOf(f.store);
    const report = { reportedBy: f.r.identity.deviceId, ancestor: f.ancestor, branch: branchOf(f.oldBranch), from: f.ancestor, events: f.oldBranch };
    const head = pointOf(f.oldBranch.at(-1)!);
    expect(await recordSupersededTrustReport(log, report, chain)).toEqual({ recorded: 2, through: head });
    // 重投已处理的批：只答复现任进度，不重复记
    expect(await recordSupersededTrustReport(log, report, chain)).toEqual({ recorded: 0, through: head });
    const open = await readOpenSupersededTrustFacts(log);
    expect(open.map((fact) => [fact.deviceId, fact.event.body.t, fact.removedRoles ?? []]).sort()).toEqual([
      [f.m.identity.deviceId, "role-change", ["surface"]],
      [f.t.identity.deviceId, "revoke", []],
    ].sort());

    // 被篡改的旧分支事件（序号与前驱都对，只换了内容）：从公共祖先逐条验签失败，不记录
    const forged = { ...f.oldBranch[0]!, body: { t: "revoke", deviceId: f.e.identity.deviceId, reason: "forged" } } as HomeTrustEvent;
    await expect(recordSupersededTrustReport(log, {
      ...report, reportedBy: f.m.identity.deviceId, branch: homeTrustEventDigest(forged), events: [forged],
    }, chain)).rejects.toThrow();
    // 声明的分支身份与首条不符：拒绝
    await expect(recordSupersededTrustReport(log, { ...report, reportedBy: f.m.identity.deviceId, branch: `sha256:${"0".repeat(64)}` }, chain))
      .rejects.toThrow(/declared branch/);
    // 不在本机链上的祖先、与本机链没分叉的“旧分支”：都拒绝
    await expect(recordSupersededTrustReport(log, {
      ...report, reportedBy: f.m.identity.deviceId, ancestor: head, from: head, branch: branchOf([f.oldBranch[0]!]),
    }, chain)).rejects.toThrow(/does not start on this trust chain|declared branch/);
    const local = await f.store.loadTrustEvents();
    await expect(recordSupersededTrustReport(log, {
      reportedBy: f.m.identity.deviceId, ancestor: pointOf(local[1]!), from: pointOf(local[1]!), branch: branchOf(local.slice(2, 4)),
      events: local.slice(2, 4),
    }, chain)).rejects.toThrow(/not a fork/);
    expect(await readOpenSupersededTrustFacts(log)).toHaveLength(2);
  });

  it("verifies batches from its recorded progress and answers stale or skipped batches with that progress", async () => {
    const f = await createHome();
    for (let index = 0; index < 4; index++) {
      f.sign({ t: "role-change", deviceId: f.e.identity.deviceId, roles: index % 2 === 0 ? ["executor", "surface"] : ["executor"] });
    }
    f.sign({ t: "revoke", deviceId: f.t.identity.deviceId, reason: "removed-before-disaster" });
    const log = f.store.authorityLog();
    const chain = chainOf(f.store);
    const base = { reportedBy: f.r.identity.deviceId, ancestor: f.ancestor, branch: branchOf(f.oldBranch) };
    const [e1, e2, e3, e4, revoke] = f.oldBranch as [HomeTrustEvent, HomeTrustEvent, HomeTrustEvent, HomeTrustEvent, HomeTrustEvent];
    expect(await recordSupersededTrustReport(log, { ...base, from: f.ancestor, events: [e1, e2] }, chain))
      .toEqual({ recorded: 0, through: pointOf(e2) });
    // 越过的批（从 e3 之后接）与落后的批（又从祖先接）：都只答复进度
    expect(await recordSupersededTrustReport(log, { ...base, from: pointOf(e3), events: [e4] }, chain))
      .toEqual({ recorded: 0, through: pointOf(e2) });
    expect(await recordSupersededTrustReport(log, { ...base, from: f.ancestor, events: [e1] }, chain))
      .toEqual({ recorded: 0, through: pointOf(e2) });
    // 从进度点接着的批用该点的旧分支投影验签：撤销事实在这里被记下
    expect(await recordSupersededTrustReport(log, { ...base, from: pointOf(e2), events: [e3, e4, revoke] }, chain))
      .toEqual({ recorded: 1, through: pointOf(revoke) });
    expect((await readOpenSupersededTrustFacts(log)).map((fact) => fact.deviceId)).toEqual([f.t.identity.deviceId]);
    // 批大小越界拒收
    await expect(recordSupersededTrustReport(log, { ...base, from: pointOf(revoke), events: [] }, chain)).rejects.toThrow(/out of bounds/);
  });

  it("reports in bounded batches, advances its acknowledgement and resends only what the current issuer has not processed", async () => {
    const f = await createHome();
    for (let index = 0; index < 4; index++) {
      f.sign({ t: "role-change", deviceId: f.e.identity.deviceId, roles: index % 2 === 0 ? ["executor", "surface"] : ["executor"] });
    }
    f.sign({ t: "revoke", deviceId: f.t.identity.deviceId, reason: "removed-before-disaster" });
    const requests: number[] = [];
    const client = reportingClient(f, f.r.identity.deviceId, requests);
    const member = await memberWith(f, f.r.key, [{ adoptionId: "adoption-1", events: f.oldBranch }]);
    await reportSupersededTrust(member, client, 2);
    expect(requests).toEqual([2, 2, 1]);
    // 确认到旧分支链头即移出待办；再连上现任时不读也不发任何东西
    expect(await readPendingSupersededReports(member.authorityLog())).toEqual([]);
    expect(await readOpenSupersededTrustFacts(f.store.authorityLog())).toHaveLength(1);
    await reportSupersededTrust(member, client, 2);
    expect(requests).toHaveLength(3);

    // 确认水位丢失（另一份本机日志从头来）：首批即得到现任进度，直接确认完成，不重复记事实
    const amnesiac = await memberWith(f, f.r.key, [{ adoptionId: "adoption-1", events: f.oldBranch }]);
    await reportSupersededTrust(amnesiac, client, 2);
    expect(requests).toEqual([2, 2, 1, 2]);
    expect(await readPendingSupersededReports(amnesiac.authorityLog())).toEqual([]);
    expect(await readOpenSupersededTrustFacts(f.store.authorityLog())).toHaveLength(1);
  });

  it("records the reporter's own downgrade so it does not regain the removed ancestor role", async () => {
    // 总控反例：M 在祖先有 executor+surface，旧分支拿掉 surface，由 M 自己上报
    const f = await createHome();
    f.sign({ t: "role-change", deviceId: f.m.identity.deviceId, roles: ["executor"] });
    const report = await recordSupersededTrustReport(f.store.authorityLog(), {
      reportedBy: f.m.identity.deviceId, ancestor: f.ancestor, branch: branchOf(f.oldBranch), from: f.ancestor, events: f.oldBranch,
    }, chainOf(f.store));
    expect(report.recorded).toBe(1);
    const restricted = restrictTrustBySupersededFacts((await f.store.loadCurrentTrust())!, await readOpenSupersededTrustFacts(f.store.authorityLog()));
    expect(roles(restricted, f.m.identity.deviceId)?.roles).toEqual(["executor"]);

    // 成员侧：待上报项里的自身降权在现任确认之前就是本机限制，确认覆盖后解除
    const self = { deviceId: f.m.identity.deviceId, event: f.oldBranch[0]!, reportedBy: f.m.identity.deviceId, ancestor: f.ancestor, removedRoles: ["surface" as const] };
    const member = await memberWith(f, f.m.key, [{ adoptionId: "adoption-self", events: f.oldBranch, self: [self] }]);
    const governance = new SupersededTrustGovernance({
      store: member, removal: () => undefined, issuerKey: () => undefined, reconcile: async () => undefined,
    });
    await governance.load();
    expect(roles(governance.apply((await f.store.loadCurrentTrust())!), f.m.identity.deviceId)?.roles).toEqual(["executor"]);
    await reportSupersededTrust(member, reportingClient(f, f.m.identity.deviceId, []), 8);
    await governance.load();
    expect(roles(governance.apply((await f.store.loadCurrentTrust())!), f.m.identity.deviceId)?.roles).toEqual(["executor", "surface"]);
  });

  it("keeps progress per superseded branch when one member is superseded twice from the same ancestor", async () => {
    // 连续两次从同一检查点恢复：同一成员、同一祖先，先后被取代两条不同的旧分支
    const f = await createHome();
    f.sign({ t: "role-change", deviceId: f.e.identity.deviceId, roles: ["executor", "surface"] });
    f.sign({ t: "role-change", deviceId: f.e.identity.deviceId, roles: ["executor"] });
    const second = f.forkFromAncestor();
    second.sign({ t: "revoke", deviceId: f.t.identity.deviceId, reason: "removed-on-second-branch" });
    const requests: number[] = [];
    const member = await memberWith(f, f.r.key, [
      { adoptionId: "adoption-first", events: f.oldBranch },
      { adoptionId: "adoption-second", events: second.events },
    ]);
    await reportSupersededTrust(member, reportingClient(f, f.r.identity.deviceId, requests), 8);
    // 两条都按各自的进度完整上报：第二条的撤销被记下，没有被第一条的进度挡住
    expect(requests).toEqual([2, 1]);
    expect(await readPendingSupersededReports(member.authorityLog())).toEqual([]);
    expect((await readOpenSupersededTrustFacts(f.store.authorityLog())).map((fact) => fact.deviceId)).toEqual([f.t.identity.deviceId]);
  });

  it("restricts admission at once and closes the facts through the removal and role contracts", async () => {
    const f = await createHome();
    f.sign({ t: "role-change", deviceId: f.m.identity.deviceId, roles: ["executor"] });
    f.sign({ t: "revoke", deviceId: f.t.identity.deviceId, reason: "removed-before-disaster" });
    const log = f.store.authorityLog();
    await recordSupersededTrustReport(log, {
      reportedBy: f.r.identity.deviceId, ancestor: f.ancestor, branch: branchOf(f.oldBranch), from: f.ancestor, events: f.oldBranch,
    }, chainOf(f.store));

    const authority = new CurrentIssuerDeviceRemovalAuthority({
      store: f.store,
      issuerKey: f.a.key,
      secretStore: new MemorySecretStore(),
      verifier: f.verifier,
      isReachable: () => false,
    });
    const gate = { open: false };
    let reconciled = 0;
    const governance = new SupersededTrustGovernance({
      store: f.store,
      removal: () => (gate.open ? authority : undefined),
      issuerKey: () => f.a.key,
      reconcile: async () => { reconciled++; },
    });
    onTestFinished(() => governance.stop());
    await governance.load();

    // 收束之前：本机链上 T 仍 active、M 仍两个角色，但进入控制面的 trust 已按限制收紧；现任自身不受影响
    const before = (await f.store.loadCurrentTrust())!;
    expect(roles(before, f.t.identity.deviceId)?.state).toBe("active");
    const restricted = governance.apply(before);
    expect(roles(restricted, f.t.identity.deviceId)?.state).toBe("revoked");
    expect(roles(restricted, f.m.identity.deviceId)?.roles).toEqual(["executor"]);
    expect(roles(restricted, f.a.identity.deviceId)).toEqual(roles(before, f.a.identity.deviceId));
    expect(restrictTrustBySupersededFacts(before, [])).toBe(before);

    // 不是现任（无移除权威）时不收束，限制保持
    governance.resume();
    await governance.settled();
    expect(await readOpenSupersededTrustFacts(log)).toHaveLength(2);

    gate.open = true;
    governance.resume();
    await governance.settled();
    const chain = replayTrustChain(await f.store.loadTrustEvents());
    expect(roles(chain, f.t.identity.deviceId)?.state).toBe("revoked");
    expect(roles(chain, f.m.identity.deviceId)).toMatchObject({ state: "active", roles: ["executor"] });
    expect(await readOpenSupersededTrustFacts(log)).toEqual([]);
    expect(reconciled).toBeGreaterThan(0);
    const after = (await f.store.loadCurrentTrust())!;
    expect(governance.apply(after)).toBe(after);

    // 重放：没有未收束事实，链头不再变化
    const head = chain.chainHead;
    governance.resume();
    await governance.settled();
    expect(replayTrustChain(await f.store.loadTrustEvents()).chainHead).toEqual(head);
  });

  it("waits for another removal of the same device instead of racing it", async () => {
    const f = await createHome();
    f.sign({ t: "revoke", deviceId: f.t.identity.deviceId, reason: "removed-before-disaster" });
    const log = f.store.authorityLog();
    await recordSupersededTrustReport(log, {
      reportedBy: f.r.identity.deviceId, ancestor: f.ancestor, branch: branchOf(f.oldBranch), from: f.ancestor, events: f.oldBranch,
    }, chainOf(f.store));
    const authority = new CurrentIssuerDeviceRemovalAuthority({
      store: f.store,
      issuerKey: f.a.key,
      secretStore: new MemorySecretStore(),
      verifier: f.verifier,
      isReachable: () => false,
    });
    await authority.acceptForDevice({ requestId: "manual", operationId: "manual-removal", targetDeviceId: f.t.identity.deviceId });
    const governance = new SupersededTrustGovernance({
      store: f.store,
      removal: () => authority,
      issuerKey: () => f.a.key,
      reconcile: async () => undefined,
    });
    onTestFinished(() => governance.stop());
    await governance.load();
    governance.resume();
    await governance.settled();
    expect(await readOpenSupersededTrustFacts(log)).toHaveLength(1);
    expect(roles(governance.apply((await f.store.loadCurrentTrust())!), f.t.identity.deviceId)?.state).toBe("revoked");

    // 那次移除结束后（守卫解除时重试）：设备已不是 active，事实随之收束
    await authority.commitLost("manual-removal");
    governance.resume();
    await governance.settled();
    expect(await readOpenSupersededTrustFacts(log)).toEqual([]);
  });
});

/** 成员侧：自己的权威日志里写好待上报项，旧分支事件由测试直接给出（已发布）。 */
async function memberWith(
  f: Awaited<ReturnType<typeof createHome>>,
  key: DeviceKey,
  branches: readonly { readonly adoptionId: string; readonly events: readonly HomeTrustEvent[]; readonly self?: readonly SupersededTrustFact[] }[],
): Promise<FileMeshBootstrapStore> {
  const own = new FileMeshBootstrapStore(await createTempDir("superseded-member"), key);
  onTestFinished(() => own.stopStorageMaintenance());
  for (const branch of branches) {
    await recordSupersededTrustPending(own.authorityLog(), {
      adoptionId: branch.adoptionId, ancestor: f.ancestor, superseded: pointOf(branch.events.at(-1)!),
      branch: branchOf(branch.events), self: branch.self ?? [],
    });
  }
  const byId = new Map(branches.map((branch) => [branch.adoptionId, branch.events]));
  return {
    authorityLog: () => own.authorityLog(),
    trustBranchAdopted: async (adoptionId: string) => byId.has(adoptionId),
    supersededTrustEvents: async (adoptionId: string, afterSeq: number, limit: number) =>
      (byId.get(adoptionId) ?? []).filter((event) => event.seq > afterSeq).slice(0, limit),
  } as unknown as FileMeshBootstrapStore;
}

/** 现任侧上报服务的同口径调用（记录每批事件数）。 */
function reportingClient(f: Awaited<ReturnType<typeof createHome>>, reportedBy: string, requests: number[]): MeshServiceClient {
  return {
    request: async (_service: string, payload: Uint8Array) => {
      const request = JSON.parse(Buffer.from(payload).toString("utf8"));
      requests.push(request.events.length);
      const result = await recordSupersededTrustReport(f.store.authorityLog(), {
        reportedBy, ancestor: request.ancestor, branch: request.branch, from: request.from, events: request.events,
      }, chainOf(f.store));
      return Buffer.from(JSON.stringify({ v: 1, ...result }), "utf8");
    },
  } as unknown as MeshServiceClient;
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
