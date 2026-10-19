import { afterEach, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { HomeTrustEvent, HomeTrustEventBody } from "@zhixing/core/contracts";
import { FileAuthorityCommitLog } from "../../../core/src/authority/commit-log.js";
import { FileArtifactStore } from "../../../core/src/authority/artifact-store.js";
import { AuthorityCacheIntegrity } from "../../../core/src/authority/startup-proofs.js";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import { RecoveryRoot } from "../recovery-root.js";
import { applyTrustEvent, buildHomeTrustRecord, createDomainResetEvent, createRecoveryRootEvent,
  createSignedTrustEvent, createTrustGenesisEvent, initializeTrustChain, replayTrustChain, type TrustProjection } from "../trust-chain.js";
import { currentTrustIndex, CURRENT_TRUST_PROJECTION_ID, readCurrentTrust, readCurrentTrustRecord, readTrustIdentity, readAnchorTenureAt, readCurrentAnchorTenure } from "../trust-current-index.js";

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
  return { log, root, issuer, genesis, get state() { return state; }, append,
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
  const signed = buildHomeTrustRecord(f.state, f.issuer.key);
  const { signature: _signature, ...unsigned } = signed;
  const missing = { ...unsigned, members: unsigned.members.slice(0, 1) };
  await expect(f.log.append([{ stream: "trust", body: { t: "home-trust-record",
    record: { ...missing, signature: f.issuer.key.sign("HomeTrustRecord", 1, missing) } } }])).rejects.toThrow("member set");
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
    expect(record.value?.members.length).toBe(replayed.members.length);
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
