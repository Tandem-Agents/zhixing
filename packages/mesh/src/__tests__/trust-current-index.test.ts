import { afterEach, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { HomeTrustEvent, HomeTrustEventBody } from "@zhixing/core/contracts";
import { FileAuthorityCommitLog } from "../../../core/src/authority/commit-log.js";
import { FileArtifactStore } from "../../../core/src/authority/artifact-store.js";
import { AuthorityCacheIntegrity } from "../../../core/src/authority/startup-proofs.js";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import { RecoveryRoot } from "../recovery-root.js";
import { applyTrustEvent, buildHomeTrustRecord, createDomainResetEvent, createRecoveryRootEvent,
  createSignedTrustEvent, createTrustGenesisEvent, homeTrustEventDigest, initializeTrustChain, replayTrustChain, type TrustProjection } from "../trust-chain.js";
import { currentTrustIndex, CURRENT_TRUST_PROJECTION_ID, LEGACY_TRUST_RECORD_MESSAGE, readCurrentTrust, readCurrentTrustRecord,
  readLegacyClosedTrust, readTrustIdentity, readAnchorTenureAt, readCurrentAnchorTenure, readRevokedTrustMemberAt,
  readTrustProjectionAt } from "../trust-current-index.js";

const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => { await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance())); });
const at = "2026-10-16T00:00:00.000Z";
async function device(name: string) {
  const key = await DeviceKey.generate();
  return { key, identity: enrollDeviceIdentity(key, { displayName: name, platform: "linux", enrolledAt: at }) };
}
async function fixture() {
  const root = await createTempDir("b2-trust");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")),
    { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 83)) });
  logs.push(log); currentTrustIndex(log);
  const issuer = await device("issuer");
  const genesis = createTrustGenesisEvent({ homeId: "b2-home", issuer: issuer.identity, signer: issuer.key, at });
  let state: TrustProjection = initializeTrustChain(genesis);
  async function append(event: HomeTrustEvent, next: TrustProjection, signer = issuer.key) {
    const result = await log.append([{ stream: "trust", body: { t: "home-trust-event", event } },
      { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(next, signer) } }]);
    state = next; return result;
  }
  await append(genesis, state);
  /** 多条事件与收尾快照同一次提交（domain-reset 必须与新根同提交）。 */
  async function appendGroup(events: readonly HomeTrustEvent[], next: TrustProjection, signer = issuer.key) {
    const entries: { stream: string; body: unknown }[] = [
      ...events.map(event => ({ stream: "trust", body: { t: "home-trust-event", event } })),
      { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(next, signer) } },
    ];
    await log.append(entries as Parameters<typeof log.append>[0]);
    state = next;
  }
  return { log, root, issuer, genesis, get state() { return state; }, append, appendGroup,
    async event(body: HomeTrustEventBody) {
      const event = createSignedTrustEvent({ current: state, body, at, signer: issuer.key });
      return append(event, applyTrustEvent(state, event));
    },
    read: () => log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID,
      async view => ({ kind: "return", value: await readCurrentTrust(view) })).then(result => result.value),
  };
}
it("returns only active members while historical identities stay exact and position-bound", async () => {
  const f = await fixture(), peer = await device("peer");
  const before = await f.log.checkpoint();
  await f.event({ t: "enroll", device: peer.identity, roles: ["executor"] });
  await f.event({ t: "revoke", deviceId: peer.identity.deviceId });
  const current = await f.read();
  expect(current?.members.map(member => member.device.deviceId)).toEqual([f.issuer.identity.deviceId]);
  await f.log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async view => {
    expect((await readTrustIdentity(view, peer.identity.deviceId))?.identity).toEqual(peer.identity);
    expect(await readTrustIdentity(view, peer.identity.deviceId, before)).toBeUndefined();
    return { kind: "return", value: undefined };
  });
}, 20_000);

it("represents reset without rewriting every historical member and re-enrolls by exact key", async () => {
  const f = await fixture(), peer = await device("peer"), old = await device("revoked");
  await f.event({ t: "enroll", device: peer.identity, roles: ["executor"] });
  await f.event({ t: "enroll", device: old.identity, roles: ["executor"] });
  await f.event({ t: "revoke", deviceId: old.identity.deviceId });
  const root = RecoveryRoot.generate();
  const establish = createRecoveryRootEvent({ current: f.state, op: "establish", candidate: root, outerSigner: f.issuer.key, at });
  await f.append(establish, applyTrustEvent(f.state, establish));
  const reset = createDomainResetEvent({ current: f.state, issuer: f.issuer.key, coSigner: peer.key, at });
  const resetState = applyTrustEvent(f.state, reset);
  const nextRoot = createRecoveryRootEvent({ current: resetState, op: "establish", candidate: RecoveryRoot.generate(), outerSigner: f.issuer.key, at });
  const nextState = applyTrustEvent(resetState, nextRoot);
  await f.log.append([{ stream: "trust", body: { t: "home-trust-event", event: reset } },
    { stream: "trust", body: { t: "home-trust-event", event: nextRoot } },
    { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(nextState, f.issuer.key) } }]);
  expect((await f.read())?.members).toHaveLength(1);
  expect((await f.read())?.anchorEpoch).toBe(1);
  const reenroll = createSignedTrustEvent({ current: nextState, body: { t: "reenroll", deviceId: peer.key.deviceId }, signer: f.issuer.key, at });
  await f.append(reenroll, applyTrustEvent(nextState, reenroll));
  expect((await f.read())?.members.map(member => member.device.deviceId).sort()).toEqual([f.issuer.key.deviceId, peer.key.deviceId].sort());
});

it("matches a full chain replay at every step and reads the latest signed record by its exact locator", async () => {
  const f = await fixture();
  const events: HomeTrustEvent[] = [];
  const records: unknown[] = [];
  // 与旧整链读取的同一份结果：重放全部事件得到当前状态，最新签名记录即最后一条。
  f.log.registerAppendAdmissionGuard((entries) => {
    for (const entry of entries) {
      const body = entry.body as { t?: string; event?: HomeTrustEvent; record?: unknown };
      if (body.t === "home-trust-event" && body.event) events.push(body.event);
      if (body.t === "home-trust-record") records.push(body.record);
    }
  });
  const assertEquivalent = async () => {
    const current = await f.read();
    const replayed = events.length ? replayTrustChain([genesisOf(f), ...events]) : f.state;
    expect(current?.chainHead).toEqual(replayed.chainHead);
    expect(current?.trustEpoch).toBe(replayed.trustEpoch);
    expect(current?.issuer).toEqual(replayed.issuer);
    expect(current?.members.map(member => member.device.deviceId).sort())
      .toEqual(replayed.members.filter(member => member.state === "active").map(member => member.device.deviceId).sort());
    const record = await f.log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view, context) =>
      ({ kind: "return", value: await readCurrentTrustRecord(view, checkpoint => context.readEnvelopeAt!(checkpoint)) }));
    expect(record.value).toEqual(records.at(-1) ?? record.value);
    // 当前快照只列 active 成员：与按整链重放构建的记录逐字相同
    expect(record.value).toEqual(buildHomeTrustRecord(replayed, f.issuer.key));
  };
  const a = await device("member-a"), b = await device("member-b");
  await f.event({ t: "enroll", device: a.identity, roles: ["executor"] }); await assertEquivalent();
  await f.event({ t: "enroll", device: b.identity, roles: ["executor", "anchor"] }); await assertEquivalent();
  await f.event({ t: "role-change", deviceId: b.identity.deviceId, roles: ["anchor"] }); await assertEquivalent();
  await f.event({ t: "revoke", deviceId: a.identity.deviceId }); await assertEquivalent();
  // 撤销后的历史身份仍可按 keyId 精确读到，供验签补齐；它不再是当前成员。
  await f.log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async view => {
    expect((await readTrustIdentity(view, a.identity.deviceId))?.identity.publicKey).toBe(a.identity.publicKey);
    expect(await readTrustIdentity(view, "never-enrolled")).toBeUndefined();
    return { kind: "return", value: undefined };
  });
  // 只有事件、没有对应签名记录时，与旧实现一样拒绝落后的记录。
  const pending = createSignedTrustEvent({ current: f.state, body: { t: "role-change", deviceId: b.identity.deviceId, roles: ["anchor", "executor"] }, at, signer: f.issuer.key });
  await f.log.append([{ stream: "trust", body: { t: "home-trust-event", event: pending } }]);
  await expect(f.read()).rejects.toThrow("missing or stale");
  await expect(f.log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view, context) =>
    ({ kind: "return", value: await readCurrentTrustRecord(view, checkpoint => context.readEnvelopeAt!(checkpoint)) })))
    .rejects.toThrow("missing or stale");
}, 30_000);

function genesisOf(f: Awaited<ReturnType<typeof fixture>>): HomeTrustEvent {
  return f.genesis;
}

/** 按原 v1 规则签出的旧格式快照（列全成员），只用来构造开发资料里的历史帧。 */
function legacyRecord(projection: TrustProjection, signer: DeviceKey) {
  const unsigned = {
    v: 1 as const,
    homeId: projection.homeId,
    trustEpoch: projection.trustEpoch,
    chainHead: { ...projection.chainHead },
    issuer: { ...projection.issuer },
    ...(projection.recoveryRootPublicKey ? { recoveryRootPublicKey: projection.recoveryRootPublicKey } : {}),
    ...(projection.recoveryBackupPublicKey ? { recoveryBackupPublicKey: projection.recoveryBackupPublicKey } : {}),
    members: projection.members.map(member => ({ device: member.device, roles: [...member.roles], state: member.state })),
  };
  return { ...unsigned, signature: signer.sign("HomeTrustRecord", 1, unsigned) };
}

async function currentRecord(log: FileAuthorityCommitLog) {
  return (await log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view, context) =>
    ({ kind: "return", value: await readCurrentTrustRecord(view, checkpoint => context.readEnvelopeAt!(checkpoint)) }))).value;
}

it("keeps the signed snapshot equal to the active subset of a full replay through every trust transition", async () => {
  const f = await fixture();
  const a = await device("member-a"), b = await device("member-b"), c = await device("member-c");
  let signer = f.issuer.key;
  const assertActiveSnapshot = async () => {
    const current = await f.read();
    const active = f.state.members.filter(member => member.state === "active");
    expect(current?.members.map(member => member.device.deviceId).sort()).toEqual(active.map(member => member.device.deviceId).sort());
    const record = await currentRecord(f.log);
    expect(record).toEqual(buildHomeTrustRecord(f.state, signer));
    expect(record?.v).toBe(2);
    expect(record?.members.map(member => member.device.deviceId)).toEqual(active.map(member => member.device.deviceId).sort());
    expect(record?.members.every(member => member.state === "active")).toBe(true);
  };
  await f.event({ t: "enroll", device: a.identity, roles: ["executor"], pairingTranscriptDigest: "sha256:pair-a" }); await assertActiveSnapshot();
  await f.event({ t: "enroll", device: b.identity, roles: ["anchor", "executor"], pairingTranscriptDigest: "sha256:pair-b" }); await assertActiveSnapshot();
  await f.event({ t: "enroll", device: c.identity, roles: ["executor"], pairingTranscriptDigest: "sha256:pair-c" }); await assertActiveSnapshot();
  await f.event({ t: "role-change", deviceId: b.identity.deviceId, roles: ["anchor"] }); await assertActiveSnapshot();
  await f.event({ t: "revoke", deviceId: c.identity.deviceId, reason: "device-removed" }); await assertActiveSnapshot();
  const root = RecoveryRoot.generate();
  const establish = createRecoveryRootEvent({ current: f.state, op: "establish", candidate: root, outerSigner: f.issuer.key, at });
  await f.append(establish, applyTrustEvent(f.state, establish)); await assertActiveSnapshot();
  // domain-reset 与新根原子提交：全部非签发设备转待重新配对，快照只剩签发者
  const reset = createDomainResetEvent({ current: f.state, issuer: f.issuer.key, coSigner: b.key, at });
  const resetState = applyTrustEvent(f.state, reset);
  const nextRoot = createRecoveryRootEvent({ current: resetState, op: "establish", candidate: RecoveryRoot.generate(), outerSigner: f.issuer.key, at });
  const nextState = applyTrustEvent(resetState, nextRoot);
  await f.appendGroup([reset, nextRoot], nextState); await assertActiveSnapshot();
  expect((await f.read())?.members.map(member => member.device.deviceId)).toEqual([f.issuer.identity.deviceId]);
  // 待重新配对的设备不在快照里，但按链仍可重新入网
  const reenroll = createSignedTrustEvent({ current: nextState, body: { t: "reenroll", deviceId: b.key.deviceId, pairingTranscriptDigest: "sha256:repair-b" }, signer: f.issuer.key, at });
  await f.append(reenroll, applyTrustEvent(nextState, reenroll)); await assertActiveSnapshot();
  // 签发权移交给 b 设备上的独立签发密钥
  const issuerKey = await DeviceKey.generate();
  const transition = createSignedTrustEvent({ current: f.state, at, signer: f.issuer.key, body: {
    t: "issuer-transition", nextTrustEpoch: f.state.trustEpoch + 1, fromIssuerKeyId: f.state.issuer.issuerKeyId,
    toIssuerKeyId: issuerKey.deviceId, toIssuerPublicKey: issuerKey.publicKey, toDeviceId: b.key.deviceId,
    reason: "migration", signedBy: "issuer",
  } });
  signer = issuerKey;
  await f.append(transition, applyTrustEvent(f.state, transition), issuerKey); await assertActiveSnapshot();
}, 30_000);

it("rejects snapshots that omit, duplicate, add or alter current members, or mix versions", async () => {
  const f = await fixture();
  const a = await device("member-a"), b = await device("member-b"), c = await device("member-c"), other = await device("other");
  await f.event({ t: "enroll", device: a.identity, roles: ["executor"], pairingTranscriptDigest: "sha256:pair-a" });
  await f.event({ t: "enroll", device: b.identity, roles: ["executor"], pairingTranscriptDigest: "sha256:pair-b" });
  await f.event({ t: "enroll", device: c.identity, roles: ["executor"], pairingTranscriptDigest: "sha256:pair-c" });
  await f.event({ t: "revoke", deviceId: c.identity.deviceId, reason: "device-removed" });
  const accepted = await currentRecord(f.log);
  const { signature: _signature, ...unsigned } = buildHomeTrustRecord(f.state, f.issuer.key);
  const memberA = unsigned.members.find(member => member.device.deviceId === a.identity.deviceId)!;
  const revokedC = { device: c.identity, roles: ["executor" as const], state: "active" as const };
  const forged: { readonly name: string; readonly record: unknown; readonly reason: string }[] = [
    { name: "missing", record: { ...unsigned, members: unsigned.members.filter(member => member !== memberA) } },
    { name: "duplicate", record: { ...unsigned, members: [...unsigned.members, memberA] } },
    { name: "extra revoked", record: { ...unsigned, members: [...unsigned.members, revokedC].sort((x, y) => x.device.deviceId < y.device.deviceId ? -1 : 1) } },
    { name: "wrong roles", record: { ...unsigned, members: unsigned.members.map(member => member === memberA ? { ...member, roles: ["anchor"] } : member) } },
    { name: "wrong key", record: { ...unsigned, members: unsigned.members.map(member => member === memberA
      ? { ...member, device: { ...member.device, publicKey: other.identity.publicKey } } : member) } },
  ].map(({ name, record }) => ({ name, record: { ...record, signature: f.issuer.key.sign("HomeTrustRecord", 2, record) },
    reason: "does not match its event-chain projection" }));
  forged.push({ name: "signed as version 1", record: { ...unsigned, signature: f.issuer.key.sign("HomeTrustRecord", 1, unsigned) },
    reason: "signature" });
  const activeOnlyV1 = { ...unsigned, v: 1 };
  forged.push({ name: "v1 with active members only", record: { ...activeOnlyV1, signature: f.issuer.key.sign("HomeTrustRecord", 1, activeOnlyV1) },
    reason: "cannot follow a current snapshot" });
  // 链上已有 v2 当前快照，再来一份按原规则签好的 v1 也拒绝
  forged.push({ name: "v1 after v2", record: legacyRecord(f.state, f.issuer.key), reason: "cannot follow a current snapshot" });
  for (const { name, record, reason } of forged) {
    await expect(f.log.append([{ stream: "trust", body: { t: "home-trust-record", record } }]), name).rejects.toThrow(reason);
  }
  expect(await currentRecord(f.log)).toEqual(accepted);
}, 30_000);

it("reads legacy v1 snapshots as history, continues the head with one v2 snapshot and rebuilds cold", async () => {
  const root = await createTempDir("b2-trust-legacy");
  const open = () => {
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")),
      { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 83)) });
    logs.push(log); currentTrustIndex(log); return log;
  };
  const log = open();
  const issuer = await device("issuer"), a = await device("member-a"), revoked = await device("revoked");
  const genesis = createTrustGenesisEvent({ homeId: "b2-home", issuer: issuer.identity, signer: issuer.key, at });
  let state = initializeTrustChain(genesis);
  const appendLegacy = async (event: HomeTrustEvent) => {
    state = event === genesis ? state : applyTrustEvent(state, event);
    await log.append([{ stream: "trust", body: { t: "home-trust-event", event } },
      { stream: "trust", body: { t: "home-trust-record", record: legacyRecord(state, issuer.key) } }]);
  };
  await appendLegacy(genesis);
  const bodies: HomeTrustEventBody[] = [
    { t: "enroll", device: a.identity, roles: ["executor"], pairingTranscriptDigest: "sha256:pair-a" },
    { t: "enroll", device: revoked.identity, roles: ["executor"], pairingTranscriptDigest: "sha256:pair-r" },
    { t: "revoke", deviceId: revoked.identity.deviceId, reason: "device-removed" },
  ];
  for (const body of bodies) await appendLegacy(createSignedTrustEvent({ current: state, body, at, signer: issuer.key }));
  // 历史帧照常闭合链头：当前视图可用，当前快照的读者拒绝 v1
  expect((await log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async view => ({ kind: "return", value: await readCurrentTrust(view) }))).value
    ?.members.map(member => member.device.deviceId).sort()).toEqual([issuer.identity.deviceId, a.identity.deviceId].sort());
  await expect(currentRecord(log)).rejects.toThrow(LEGACY_TRUST_RECORD_MESSAGE);
  // 一次性接续：当前签发者按当前视图为同一链头补签 v2
  const legacyView = (await log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async view =>
    ({ kind: "return", value: await readLegacyClosedTrust(view) }))).value!;
  const continued = buildHomeTrustRecord(legacyView, issuer.key);
  expect(continued).toEqual(buildHomeTrustRecord(replayTrustChain([genesis, ...await trustEvents(log)]), issuer.key));
  await log.append([{ stream: "trust", body: { t: "home-trust-record", record: continued } }]);
  expect(await currentRecord(log)).toEqual(continued);
  expect((await log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async view =>
    ({ kind: "return", value: await readLegacyClosedTrust(view) }))).value).toBeUndefined();
  await expect(log.append([{ stream: "trust", body: { t: "home-trust-record", record: legacyRecord(state, issuer.key) } }])).rejects.toThrow();
  // 冷重建：历史 v1 帧与之后的 v2 快照一起重放，结果相同
  await log.stopStorageMaintenance();
  await rm(path.join(root, "authority", "projections"), { recursive: true, force: true });
  const reopened = open();
  expect(await currentRecord(reopened)).toEqual(continued);
}, 30_000);

async function trustEvents(log: FileAuthorityCommitLog): Promise<HomeTrustEvent[]> {
  return (await log.readStream("trust"))
    .map(entry => entry.body as { t?: string; event?: HomeTrustEvent })
    .filter(body => body.t === "home-trust-event" && body.event!.seq > 0)
    .map(body => body.event!);
}

it('derives distinct A to B to A tenures, historical bases and disaster succession across restart', async () => {
  const f = await fixture(), b = await device('next-anchor');
  await f.event({ t: 'enroll', device: b.identity, roles: ['anchor', 'executor'] });
  const original = await f.log.checkpoint();
  const move = async (to: typeof b, from: DeviceKey, recovery?: RecoveryRoot) => {
    const event = createSignedTrustEvent({ current: f.state, at, signer: recovery ?? from,
      body: { t: 'issuer-transition', nextTrustEpoch: f.state.trustEpoch + 1,
        fromIssuerKeyId: f.state.issuer.issuerKeyId, toIssuerKeyId: to.key.deviceId, toDeviceId: to.key.deviceId,
        ...(recovery ? { reason: 'disaster-recovery', signedBy: 'recovery-root' } as const : { reason: 'migration', signedBy: 'issuer' } as const) } });
    await f.append(event, applyTrustEvent(f.state, event), to.key);
  };
  await move(b, f.issuer.key);
  const second = await f.log.checkpoint();
  expect((await f.read())?.anchorEpoch).toBe(2);
  await move(f.issuer, b.key);
  expect((await f.read())?.anchorEpoch).toBe(3);
  const recovery = RecoveryRoot.generate();
  const establish = createRecoveryRootEvent({ current: f.state, op: 'establish', candidate: recovery, outerSigner: f.issuer.key, at });
  await f.append(establish, applyTrustEvent(f.state, establish));
  await move(b, f.issuer.key, recovery);
  expect((await f.read())?.anchorEpoch).toBe(4);
  await f.log.stopStorageMaintenance();
  const restarted = new FileAuthorityCommitLog(path.join(f.root, 'authority'), new FileArtifactStore(path.join(f.root, 'artifacts')),
    { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 83)) });
  logs.push(restarted); currentTrustIndex(restarted);
  await restarted.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async view => {
    expect(await readAnchorTenureAt(view, original)).toMatchObject({ anchorEpoch: 1, deviceId: f.issuer.key.deviceId });
    expect(await readAnchorTenureAt(view, second)).toMatchObject({ anchorEpoch: 2, deviceId: b.key.deviceId });
    expect(await readCurrentAnchorTenure(view)).toMatchObject({ anchorEpoch: 4, deviceId: b.key.deviceId });
    return { kind: 'return', value: undefined };
  });
}, 30_000);

// 总控反例（宽度）：当前活跃=1、读同一快照位置，只增已撤销完的设备历史——读取、写出与物化对象都不随它增长
it("keeps historical projections and the 64th-event snapshot independent of retired device history", async () => {
  const rows: Record<string, number>[] = [];
  for (const count of [4, 16]) {
    const f = await fixture();
    let state = f.state;
    const events: HomeTrustEvent[] = [];
    const push = (body: HomeTrustEventBody) => {
      const event = createSignedTrustEvent({ current: state, body, at, signer: f.issuer.key });
      events.push(event);
      state = applyTrustEvent(state, event);
    };
    const retired: string[] = [];
    for (let index = 0; index < count; index++) {
      const old = await device(`retired-${index}`);
      retired.push(old.key.deviceId);
      push({ t: "enroll", device: old.identity, roles: ["executor"] });
      push({ t: "revoke", deviceId: old.key.deviceId });
    }
    while (state.chainHead.seq < 70) push({ t: "role-change", deviceId: f.issuer.key.deviceId, roles: ["anchor"] });
    await f.log.append([
      ...events.map((event) => ({ stream: "trust", body: { t: "home-trust-event", event } })),
      { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(state, f.issuer.key) } },
    ] as Parameters<typeof f.log.append>[0]);
    const measure = async (seq: number) => {
      let reads = 0;
      let readBytes = 0;
      const point = { seq, eventDigest: homeTrustEventDigest(events[seq - 1]!) };
      const projection = (await f.log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => {
        const measured = {
          get: async (key: string) => {
            const value = await view.get(key);
            reads += 1;
            readBytes += Buffer.byteLength(JSON.stringify(value ?? null));
            return value;
          },
          scan: async (...args: Parameters<typeof view.scan>) => {
            const page = await view.scan(...args);
            reads += 1;
            readBytes += Buffer.byteLength(JSON.stringify(page.entries));
            return page;
          },
        } as unknown as typeof view;
        return { kind: "return" as const, value: await readTrustProjectionAt(measured, point) };
      })).value!;
      return { reads, readBytes, members: projection.members.length };
    };
    const atSnapshot = await measure(64);
    const replayed = await measure(70);
    // 写出：第 64 条之后存的快照行与它枚举的 live 目录
    const written = (await f.log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: "return" as const,
      value: {
        snapshotBytes: Buffer.byteLength(JSON.stringify(await view.get("trust/snapshot/" + String(64).padStart(16, "0")))),
        live: (await view.scan({ gte: "trust/live/", lt: "trust/live/￿" }, 256)).entries.length,
      },
    }))).value;
    // 历史设备仍按键可得：在它们撤销之后的点上是已撤销成员，重复配对它们照样被拒
    const revokedLater = (await f.log.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async (view) => ({
      kind: "return" as const, value: await readRevokedTrustMemberAt(view, retired[0]!, 64),
    }))).value;
    expect(revokedLater?.state).toBe("revoked");
    rows.push({
      history: count,
      snapshotReads: atSnapshot.reads, snapshotBytes: atSnapshot.readBytes, snapshotMembers: atSnapshot.members,
      replayReads: replayed.reads, replayBytes: replayed.readBytes, replayMembers: replayed.members,
      writtenSnapshotBytes: written.snapshotBytes, live: written.live,
    });
  }
  const [small, large] = rows as [Record<string, number>, Record<string, number>];
  for (const key of ["snapshotReads", "snapshotMembers", "replayReads", "replayMembers", "live"]) expect(large[key], key).toBe(small[key]);
  // 字节只允许序号位数之类的常数差
  for (const key of ["snapshotBytes", "replayBytes", "writtenSnapshotBytes"]) expect(large[key]! - small[key]!, key).toBeLessThanOrEqual(128);
}, 60_000);
