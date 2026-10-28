import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { applyTrustEvent, buildHomeTrustRecord, createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { HomeAuthoritySources, openHomeAuthoritySources } from "./home-authority-sources.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { provePriorHostExited, reclaimRetiredContentCopies, RETIRED_CONTENT_COPIES } from "./retired-projection-copies.js";
import { FileAuthorityCommitLog, durableProjectionDirectoryName } from "@zhixing/core/authority";
import { verifyProtocolStep } from "@zhixing/core/protocol";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import { mkdir, writeFile } from "node:fs/promises";
import { conversationRecoveryPage } from "@zhixing/owner-kernel/conversation-assignment";

const AT = "2026-10-16T00:00:00.000Z";

class AtomicMemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  creates = 0;
  async put(ref: SecretRef, value: string): Promise<void> { this.values.set(ref.kind + "/" + ref.bindingId, value); }
  async get(ref: SecretRef): Promise<string | null> { return this.values.get(ref.kind + "/" + ref.bindingId) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const id = ref.kind + "/" + ref.bindingId;
    const existing = this.values.get(id);
    if (existing !== undefined) return existing;
    this.creates++;
    const value = create();
    this.values.set(id, value);
    return value;
  }
  async delete(ref: SecretRef): Promise<void> { this.values.delete(ref.kind + "/" + ref.bindingId); }
  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()].filter(value => value.startsWith(prefix)).map(value => {
      const separator = value.indexOf("/");
      return { kind: value.slice(0, separator) as SecretRef["kind"], bindingId: value.slice(separator + 1) };
    });
  }
  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const values: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath, entry.name);
    if (!entry.isFile()) { values.push(path.relative(root, absolute) + "/"); continue; }
    // 正在释放的锁文件可能在列目录与读取之间消失；它本身记为存在，由调用方等待其消失。
    const bytes = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return Buffer.from("released");
      throw error;
    });
    values.push(path.relative(root, absolute) + ":" + bytes.toString("base64"));
  }
  return values.sort();
}

/** 写者关闭后其日志锁会话按既有延迟释放；等锁文件消失再取快照，只读访问者不得留下任何文件。 */
async function settledTree(root: string): Promise<string[]> {
  const until = Date.now() + 10_000;
  for (;;) {
    const values = await tree(root);
    if (!values.some(value => value.includes(".commit-log.lock")) || Date.now() > until) return values;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function trustedHome() {
  const home = await createTempDir("b2-home-sources");
  const secrets = new AtomicMemorySecretStore();
  const key = await DeviceKey.generate();
  const store = await FileMeshBootstrapStore.open(home, key, { secretStore: secrets });
  const identity = enrollDeviceIdentity(key, { displayName: "anchor", platform: "linux", enrolledAt: AT });
  const created = await store.initializeLocalHome({ key, identity, roles: ["anchor", "executor"], homeId: "b2-home", at: AT });
  return { home, secrets, key, store, identity, created };
}

describe("home authority sources", () => {
  it("prepares every actual fixed definition at Host.ready, including constructor-owned Core definitions", async () => {
    const home = await createTempDir("b2-ready-definition-inventory");
    const registered = new Map<string, Set<string>>();
    const original = FileAuthorityCommitLog.prototype.durableProjection;
    const spy = vi.spyOn(FileAuthorityCommitLog.prototype, "durableProjection").mockImplementation(function(this: FileAuthorityCommitLog, definition) {
      const result = original.call(this, definition);
      const ids = registered.get(this.rootDir) ?? new Set<string>();
      ids.add(definition.projectionId); registered.set(this.rootDir, ids);
      return result;
    });
    const lease = await openHomeAuthoritySources({ home, secretStore: new AtomicMemorySecretStore() });
    try {
      const ready = await lease.sources.prepareRuntime("host-ready");
      for (const [position, log] of [lease.sources.authority, lease.sources.executor].entries()) {
        // Exercise the actual recovery consumer after the boundary; comparing
        // only the original registration list with itself missed this dependency.
        await conversationRecoveryPage(log, lease.sources.artifacts);
        expect(new Set(ready[position]!.projections)).toEqual(registered.get(log.rootDir));
      }
      // 扩展当前状态索引随固定定义在首次写入前登记，不等扩展首次被调用
      expect(registered.get(lease.sources.authority.rootDir)).toContain("extension-current-state");
    } finally { await lease.close(); spy.mockRestore(); }
  }, 60_000);

  it("serializes writer replacement with the previous owner's actual close", async () => {
    const home = await createTempDir("b2-owner-close-fence");
    const secrets = new AtomicMemorySecretStore();
    const first = await openHomeAuthoritySources({ home, secretStore: secrets });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const realClose = first.sources.close.bind(first.sources);
    const close = vi.spyOn(first.sources, "close").mockImplementation(async () => {
      entered.resolve(); await release.promise; await realClose();
    });
    const nextSource = { close: vi.fn(async () => undefined) } as unknown as HomeAuthoritySources;
    const open = vi.spyOn(HomeAuthoritySources, "open").mockResolvedValue(nextSource);
    const closing = first.close();
    await entered.promise;
    const next = openHomeAuthoritySources({ home, secretStore: secrets });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([next.then(() => "opened"), new Promise(resolve => { timer = setTimeout(() => resolve("waiting"), 1_000); })])).toBe("waiting");
      expect(open).not.toHaveBeenCalled();
      release.resolve(); await closing;
      expect((await next).sources).toBe(nextSource);
      expect(open).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(timer); release.resolve(); await closing;
      await (await next).close(); open.mockRestore(); close.mockRestore();
    }
  }, 60_000);

  it("shares one writer owner per physical home, injects one atomically created cache key and rejects a split commit clock", async () => {
    const home = await createTempDir("b2-home-owner");
    const secrets = new AtomicMemorySecretStore();
    const [first, second] = await Promise.all([
      openHomeAuthoritySources({ home, secretStore: secrets }),
      openHomeAuthoritySources({ home: path.join(home, "."), secretStore: secrets }),
    ]);
    expect(second.sources).toBe(first.sources);
    expect(secrets.creates).toBe(1);
    expect(first.sources.integrity).toBeDefined();
    await expect(openHomeAuthoritySources({ home, secretStore: secrets, clock: () => AT })).rejects.toThrow("one commit clock");
    await first.close();
    // 另一个使用者仍持有：日志尚未停止，可以继续读写。
    await second.sources.authority.append([{ stream: "control", body: { t: "probe" } }]).catch((error: unknown) => {
      // 固定领域投影会拒绝未知控制记录；这里只证明日志仍由在用的 owner 打开。
      expect(String(error)).not.toContain("stopped");
    });
    await second.close();
    const reopened = await openHomeAuthoritySources({ home, secretStore: secrets });
    expect(reopened.sources).not.toBe(first.sources);
    expect(secrets.creates).toBe(1);
    await reopened.close();
  }, 60_000);

  it("reads a fresh or an established home without creating, repairing or writing any file", async () => {
    const fresh = await createTempDir("b2-readonly-fresh");
    const before = await tree(fresh);
    const readOnly = await FileMeshBootstrapStore.open(fresh, undefined, { readOnly: true });
    expect(await readOnly.loadTrustRecord()).toBeUndefined();
    expect(await readOnly.loadCurrentTrust()).toBeUndefined();
    await readOnly.stopStorageMaintenance();
    expect(await tree(fresh)).toEqual(before);

    const h = await trustedHome();
    await h.store.stopStorageMaintenance();
    const established = await settledTree(h.home);
    expect(established.some(value => value.includes(".commit-log.lock"))).toBe(false);
    const reader = await FileMeshBootstrapStore.open(h.home, undefined, { readOnly: true });
    expect(await reader.loadTrustRecord()).toEqual(h.created.record);
    expect((await reader.loadCurrentTrust())?.members.map(member => member.device.deviceId)).toEqual([h.key.deviceId]);
    await expect(reader.authorityLog().append([{ stream: "control", body: {} }])).rejects.toThrow("read-only");
    await reader.stopStorageMaintenance();
    expect(await tree(h.home)).toEqual(established);
  }, 60_000);

  it("verifies a revoked signer only by an exact trust lookup and fails closed for a stranger", async () => {
    const h = await trustedHome();
    const peerKey = await DeviceKey.generate();
    const peer = enrollDeviceIdentity(peerKey, { displayName: "peer", platform: "linux", enrolledAt: AT });
    let state = h.created.projection;
    for (const body of [{ t: "enroll" as const, device: peer, roles: ["executor" as const] }, { t: "revoke" as const, deviceId: peer.deviceId }]) {
      const event = createSignedTrustEvent({ current: state, body, at: AT, signer: h.key });
      state = applyTrustEvent(state, event);
      await h.store.authorityLog().append([{ stream: "trust", body: { t: "home-trust-event", event } },
        { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(state, h.key) } }]);
    }
    await h.store.stopStorageMaintenance();
    const lease = await openHomeAuthoritySources({ home: h.home, secretStore: h.secrets });
    const { verifier, identities, authority } = lease.sources;
    const payload = { probe: true };
    const signature = peerKey.sign("B2Probe", 1, payload);
    // 已撤销设备不是常驻身份：日志外直接验签是普通的不受信拒绝。
    expect(() => verifier.verify("B2Probe", 1, payload, signature)).toThrow("untrusted device");
    // Resolve a cold historical signer while holding this very authority log:
    // the resolver must reuse the bound view, not acquire the non-reentrant lock.
    let decisions = 0;
    await authority.transactDurableProjection("home-current-trust", async () => {
      decisions++;
      await verifyProtocolStep(() => verifier.verify("B2Probe", 1, payload, signature));
      return { kind: "return", value: undefined };
    });
    expect(decisions).toBe(1);
    const stranger = await DeviceKey.generate();
    await expect(identities.verifying(() => verifier.verify("B2Probe", 1, payload, stranger.sign("B2Probe", 1, payload))))
      .rejects.toThrow("untrusted device");
    // 当前成员与本机身份在打开时即常驻。
    expect(() => verifier.verify("B2Probe", 1, payload, h.key.sign("B2Probe", 1, payload))).not.toThrow();
    // 信任日志自身操作之内的补齐不可重入：信号交给外层操作处理。
    await authority.transactDurableProjection("home-current-trust", async () => {
      expect(authority.holdsOperation()).toBe(true);
      return { kind: "return", value: undefined };
    });
    await lease.close();
  }, 60_000);

  it("reclaims the old schedule content copy only with an on-the-spot prior Host exit proof", async () => {
    const h = await trustedHome();
    const log = h.store.authorityLog();
    const copy = RETIRED_CONTENT_COPIES[0]!;
    const directory = path.join(log.rootDir, "projections", durableProjectionDirectoryName(copy.projectionId));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ projectionId: copy.projectionId, reducerVersion: copy.version }));
    await writeFile(path.join(directory, "segment-copy.data"), "task definition copy");
    const records: unknown[] = [];
    const port = { record: (value: unknown) => { records.push(typeof value === "function" ? (value as () => unknown)() : value); } };
    await reclaimRetiredContentCopies({ log, priorHostExitProven: false, records: port });
    await expect(stat(directory)).resolves.toBeDefined();
    expect(records).toContainEqual(expect.objectContaining({ event: "retired", data: expect.objectContaining({ outcome: "pending", reason: "prior-host-exit-unproven" }) }));

    // 发现文件缺失（正常停止时已删除）不是退出证明；残留记录所指进程经出生身份核实已不在才成立。
    const lockPaths = { pidPath: path.join(h.home, "server.pid"), portPath: path.join(h.home, "server.port") };
    expect(await provePriorHostExited(lockPaths)).toBe(false);
    await writeFile(lockPaths.pidPath, JSON.stringify({ pidFileVersion: 2, pid: 4242, port: 1, startTime: 1, startedAt: AT }));
    expect(await provePriorHostExited(lockPaths, { birth: async () => ({ kind: "absent" }) })).toBe(true);
    expect(await provePriorHostExited(lockPaths, { birth: async () => ({ kind: "unknown" }) })).toBe(false);
    expect(await provePriorHostExited(lockPaths, { birth: async () => ({ kind: "present", startTime: 1 }) as never })).toBe(false);
    expect(await provePriorHostExited(lockPaths, {}, 4242)).toBe(false);

    await reclaimRetiredContentCopies({ log, priorHostExitProven: true, records: port });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(records).toContainEqual(expect.objectContaining({ event: "retired", data: expect.objectContaining({ outcome: "removed" }) }));
    // A downgraded binary can recreate the legacy copy. A prior intermediate
    // upgrade can also leave an explicit v1 directory; neither is a one-time flag.
    const recreated = [directory, directory + ".v1"];
    for (const root of recreated) {
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "manifest.json"), JSON.stringify({ projectionId: copy.projectionId, reducerVersion: copy.version }));
      await writeFile(path.join(root, "segment-copy.data"), "recreated definition copy");
    }
    await reclaimRetiredContentCopies({ log, priorHostExitProven: false, records: port });
    for (const root of recreated) await expect(stat(root)).resolves.toBeDefined();
    await reclaimRetiredContentCopies({ log, priorHostExitProven: true, records: port });
    for (const root of recreated) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await h.store.stopStorageMaintenance();
  }, 60_000);

  it("does not grant a new signer verification identity from the same uncommitted envelope", async () => {
    const h = await trustedHome();
    const key = await DeviceKey.generate();
    const device = enrollDeviceIdentity(key, { displayName: "new", platform: "linux", enrolledAt: AT });
    const event = createSignedTrustEvent({ current: h.created.projection,
      body: { t: "enroll", device, roles: ["executor"] }, at: AT, signer: h.key });
    const projection = applyTrustEvent(h.created.projection, event);
    const log = h.store.authorityLog();
    const { verifier } = h.store.authoritySources()!;
    const payload = { probe: "precommit" };
    const signature = key.sign("B2Probe", 1, payload);
    log.durableProjection({ projectionId: "b2-precommit-verification", reducerVersion: 1, authenticated: true,
      inputs: { streams: ["job:b2-probe"] }, reduce(envelope) {
        for (const entry of envelope.entries) if (entry.stream === "job:b2-probe") verifier.verify("B2Probe", 1, payload, signature);
        return [];
      } });
    const before = await log.checkpoint();
    await expect(log.append([
      { stream: "trust", body: { t: "home-trust-event", event } },
      { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(projection, h.key) } },
      { stream: "job:b2-probe", body: payload },
    ])).rejects.toThrow("untrusted device");
    expect((await log.checkpoint()).lsn).toBe(before.lsn);
    expect((await h.store.loadCurrentTrust())!.members).toHaveLength(1);
    await h.store.stopStorageMaintenance();
  }, 60_000);

  it("returns cross-log hydration backpressure before waiting on an occupied source and commits only after retry", async () => {
    const h = await trustedHome();
    const peerKey = await DeviceKey.generate();
    const peer = enrollDeviceIdentity(peerKey, { displayName: "old peer", platform: "linux", enrolledAt: AT });
    let trust = h.created.projection;
    for (const body of [{ t: "enroll" as const, device: peer, roles: ["executor" as const] }, { t: "revoke" as const, deviceId: peer.deviceId }]) {
      const event = createSignedTrustEvent({ current: trust, body, at: AT, signer: h.key });
      trust = applyTrustEvent(trust, event);
      await h.store.authorityLog().append([{ stream: "trust", body: { t: "home-trust-event", event } },
        { stream: "trust", body: { t: "home-trust-record", record: buildHomeTrustRecord(trust, h.key) } }]);
    }
    await h.store.stopStorageMaintenance();
    const lease = await openHomeAuthoritySources({ home: h.home, secretStore: h.secrets });
    const { authority, executor, verifier } = lease.sources;
    await lease.sources.prepareRuntime("host-ready");
    const payload = { crossLog: true }, signature = peerKey.sign("B2Probe", 1, payload);
    const id = "b2-cross-log-verification";
    const index = executor.durableProjection({ projectionId: id, reducerVersion: 1, authenticated: true,
      inputs: { streams: ["job:b2-probe"] }, reduce() {
        verifier.verify("B2Probe", 1, payload, signature);
        return [{ kind: "put", key: "verified", value: peer.deviceId }];
      } });
    await executor.prepareProjections([id]);
    const before = await executor.checkpoint();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const held = authority.transactDurableProjection("home-current-trust", async () => {
      entered.resolve(); await release.promise;
      return { kind: "return", value: undefined };
    });
    await entered.promise;
    const domain = new SerialTaskQueue();
    const attempt = domain.run(() => executor.append([{ stream: "job:b2-probe", body: payload }]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([attempt, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("cross-log verifier waited on the occupied source")), 3_000);
      })])).rejects.toMatchObject({ admission: { kind: "backpressured", blockedBy: "slots" } });
    } finally {
      clearTimeout(timer); release.resolve(); await held; await attempt.catch(() => undefined);
    }
    expect((await executor.checkpoint()).lsn).toBe(before.lsn);
    await executor.append([{ stream: "job:b2-probe", body: payload }]);
    expect((await executor.checkpoint()).lsn).toBe(before.lsn + 1);
    expect(await index.get("verified")).toBe(peer.deviceId);
    await lease.close();
  }, 60_000);
});
