import path from "node:path";
import { AUTHORITY_RECOVERY_BUDGET, FileAuthorityCommitLog, FileDurableProjectionIndex } from "@zhixing/core/authority";
import type { Digest, SecretRef, SecretStorePort, SurfaceAssetScope } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createHomeAssetLifecycle } from "../home-asset-lifecycle.js";
import { FileMeshBootstrapStore } from "../mesh-bootstrap-store.js";
import { loadOrCreateDeviceKey } from "../mesh-device-key.js";
import { createSurfaceAssetAuthority } from "../surface-asset-authority.js";

const TIMEOUT_MS = 120_000;
const T0 = "2026-07-25T00:00:00.000Z";
const MINUTE = 60 * 1_000;

/**
 * 统一入口的日志按真实时钟提交，协调器取时钟与已耐久时间的较大者。要让 grant 真的过期，
 * 时钟必须是真实时间往后拨，而不是一个固定的过去时刻。
 */
function shiftedClock() {
  const clock = { offset: 0, now: () => new Date(Date.now() + clock.offset).toISOString() };
  return clock;
}
const scope: SurfaceAssetScope = { domain: "global", anchorEpoch: 1 };

/**
 * 生产入口打开的 home：统一 home 权威入口、认证日志、本机设备钥签名与入口自己的验签器；资产权威按
 * 宿主装配取 authority＋executor 两个源。
 */
async function openHome(home: string, secrets: SecretStorePort, clock: () => string) {
  const key = await loadOrCreateDeviceKey(secrets);
  const store = await FileMeshBootstrapStore.open(home, key, { secretStore: secrets });
  const sources = store.authoritySources()!;
  const assets = createSurfaceAssetAuthority({
    authorityRoot: path.join(home, "distributed-runtime"),
    log: sources.authority,
    retentionLogs: [sources.authority, sources.executor],
    ownsLogs: false,
    shared: sources.assetLifecycle(),
    artifacts: sources.artifacts,
    signer: key,
    verifier: sources.verifier,
    anchorEpoch: 1,
    clock,
  });
  return {
    store,
    sources,
    assets,
    async close() {
      await assets.stopStorageMaintenance();
      await store.stopStorageMaintenance();
    },
  };
}

describe("asset lifecycle startup", () => {
  it("keeps one source vector when backup retention and the asset authority share a home", async () => {
    const home = await createTempDir("asset-lifecycle-source-vector");
    const secrets = new MemorySecretStore();
    const opened = await openHome(home, secrets, () => T0);
    try {
      for (let index = 0; index < 24; index += 1) {
        await opened.sources.authority.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: T0 } }]);
      }
      const first = await opened.assets.checkpointRetention.checkpointRetentionSnapshot();
      expect(Object.keys(first.sourceHeads)).toHaveLength(2);
      const readTail = vi.spyOn(FileAuthorityCommitLog.prototype, "readTail");
      const fromOrigin = () => {
        const count = readTail.mock.calls.filter(([checkpoint]) => checkpoint.lsn === 0).length;
        readTail.mockClear();
        return count;
      };
      try {
        // 备份命令经 bootstrap store 取检查点保留，随后宿主资产权威照常读取
        const backup = await opened.store.checkpointRetention().checkpointRetentionSnapshot();
        const backupReplay = fromOrigin();
        const again = await opened.assets.checkpointRetention.checkpointRetentionSnapshot();
        const assetReplay = fromOrigin();
        expect({ backupSources: Object.keys(backup.sourceHeads).length, backupReplay, assetReplay, again: again.sourceHeads })
          .toEqual({ backupSources: 2, backupReplay: 0, assetReplay: 0, again: first.sourceHeads });
      } finally {
        readTail.mockRestore();
      }
    } finally {
      await opened.close();
    }
  }, TIMEOUT_MS);

  it("opens without draining expired grants", async () => {
    const recoverWork: Record<number, number> = {};
    const drainWork: Record<number, number> = {};
    for (const expired of [8, 32]) {
      const home = await createTempDir(`asset-lifecycle-expired-${expired}`);
      const secrets = new MemorySecretStore();
      const clock = shiftedClock();
      const opened = await openHome(home, secrets, clock.now);
      const expiries: string[] = [];
      let closedHead;
      try {
        await opened.assets.recover();
        for (let index = 0; index < expired; index += 1) {
          expiries.push((await opened.assets.issue({
            kind: "asset-upload",
            scope,
            surfacePrincipal: "surface-one",
            requestId: `upload-${index}`,
            assets: [{ digest: `sha256:${index.toString(16).padStart(64, "0")}` as Digest, bytes: 17 }],
            payloadDigest: `sha256:${"b".repeat(64)}` as Digest,
          })).expiry);
        }
        // 空闲维护已追平并落盘；此刻都还没到期，过期任务一个都没有被做掉
        await opened.assets.maintainLedgerIndex();
        expect(await opened.sources.assetLifecycle().lifecycle.nextGrantExpiry()).toBe(expiries.sort()[0]);
        closedHead = await opened.sources.authority.checkpoint();
      } finally {
        await opened.close();
      }
      // 远超签发时限之后冷重开：全部 grant 已越过有效到期边界
      clock.offset = 120 * MINUTE;
      expect(Date.parse(clock.now())).toBeGreaterThan(Date.parse(expiries.at(-1)!));
      const readTail = vi.spyOn(FileAuthorityCommitLog.prototype, "readTail");
      const reopened = await openHome(home, secrets, clock.now);
      const get = vi.spyOn(FileDurableProjectionIndex.prototype, "get");
      const scan = vi.spyOn(FileDurableProjectionIndex.prototype, "scan");
      const lifecycleReads = () => [get, scan].reduce((total, spy) => total +
        spy.mock.contexts.filter((index) => (index as FileDurableProjectionIndex).projectionId === "artifact-lifecycle").length, 0);
      try {
        await reopened.assets.recover();
        recoverWork[expired] = lifecycleReads();
        // 打开与恢复只读上一会话落盘之后追加的尾部（恢复自己写的时间前沿），没有遗留源尾
        expect(readTail.mock.calls.every(([checkpoint]) => checkpoint.lsn >= closedHead!.lsn)).toBe(true);
        // 过期任务留在恢复之后，由后台排空：它的工作量随积压增长
        get.mockClear();
        scan.mockClear();
        await reopened.sources.assetLifecycle().lifecycle.synchronize();
        drainWork[expired] = lifecycleReads();
      } finally {
        readTail.mockRestore();
        get.mockRestore();
        scan.mockRestore();
        await reopened.close();
      }
    }
    expect(recoverWork[32]).toBe(recoverWork[8]);
    expect(drainWork[32]).toBeGreaterThan(drainWork[8]!);
    console.log("asset-lifecycle-startup expired", JSON.stringify({ recoverWork, drainWork }));
  }, TIMEOUT_MS);

  it("rejects expired grants at the time frontier exactly as a full drain would", async () => {
    const home = await createTempDir("asset-lifecycle-expiry-frontier");
    const secrets = new MemorySecretStore();
    const clock = shiftedClock();
    const upload = (requestId: string, index: number) => ({
      kind: "asset-upload" as const,
      scope,
      surfacePrincipal: "surface-one",
      requestId,
      assets: [{ digest: `sha256:${index.toString(16).padStart(64, "0")}` as Digest, bytes: 17 }],
      payloadDigest: `sha256:${"b".repeat(64)}` as Digest,
    });
    const opened = await openHome(home, secrets, clock.now);
    const grants = [];
    try {
      await opened.assets.recover();
      for (let index = 0; index < 4; index += 1) grants.push(await opened.assets.issue(upload(`old-${index}`, index)));
      clock.offset = 50 * MINUTE;
      grants.push(await opened.assets.issue(upload("late", 9)));
      await opened.assets.maintainLedgerIndex();
    } finally {
      await opened.close();
    }
    // 前四个已过一小时时限，最后一个仍有效
    clock.offset = 80 * MINUTE;
    const reopenedAt = Date.parse(clock.now());
    expect(grants.slice(0, 4).every((grant) => Date.parse(grant.expiry) < reopenedAt)).toBe(true);
    expect(Date.parse(grants[4]!.expiry)).toBeGreaterThan(reopenedAt);
    const reopened = await openHome(home, secrets, clock.now);
    try {
      await reopened.assets.recover();
      const lifecycle = reopened.sources.assetLifecycle().lifecycle;
      const observe = async () => ({
        active: await Promise.all(grants.map(async (grant) => (await lifecycle.activeGrant(grant.grantId))?.grantId ?? null)),
        next: await lifecycle.nextGrantExpiry(),
      });
      const caughtUp = await observe();
      expect(caughtUp).toEqual({ active: [null, null, null, null, grants[4]!.grantId], next: grants[4]!.expiry });
      // 后台排空过期任务之后逐个相同
      await lifecycle.synchronize();
      expect(await observe()).toEqual(caughtUp);
    } finally {
      await reopened.close();
    }
  }, TIMEOUT_MS);

  it("lets two lifecycle writers on one home publish concurrently without conflicting generations", async () => {
    const home = await createTempDir("asset-lifecycle-two-writers");
    const secrets = new MemorySecretStore();
    const opened = await openHome(home, secrets, () => T0);
    // 另一个进程在同一 home 上打开的索引：同一组源日志，独立的内存状态
    const other = createHomeAssetLifecycle({
      distributedRoot: path.join(home, "distributed-runtime"),
      authority: opened.sources.authority,
      executor: opened.sources.executor,
      artifacts: opened.sources.artifacts,
    });
    const readTail = vi.spyOn(FileAuthorityCommitLog.prototype, "readTail");
    try {
      const host = opened.sources.assetLifecycle().lifecycle;
      // 先有一段历史，两个实例都已覆盖它：此后从 lsn 0 读才意味着重放历史
      for (let index = 0; index < 10; index += 1) {
        await opened.sources.authority.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: T0 } }]);
      }
      await host.catchUp();
      await other.lifecycle.catchUp();
      readTail.mockClear();
      for (let round = 0; round < 4; round += 1) {
        for (let index = 0; index < 70; index += 1) {
          await opened.sources.authority.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: T0 } }]);
        }
        await Promise.all([host.maintainIdle(), other.lifecycle.maintainIdle()]);
      }
      // 没有任何一方因同代冲突或失配而从源头重建
      expect(readTail.mock.calls.filter(([checkpoint]) => checkpoint.lsn === 0)).toHaveLength(0);
      const head = await opened.sources.authority.checkpoint();
      for (const lifecycle of [host, other.lifecycle]) {
        expect((await lifecycle.checkpointRetentionSnapshot()).sourceHeads[head.logId]).toEqual(head);
      }
    } finally {
      readTail.mockRestore();
      await other.close();
      await opened.close();
    }
  }, TIMEOUT_MS);

  it("keeps the shared lifecycle within the source tail budget under continuous writes without reads", async () => {
    const home = await createTempDir("asset-lifecycle-tail-budget");
    const secrets = new MemorySecretStore();
    const registered = vi.spyOn(FileAuthorityCommitLog.prototype, "registerTailConsumer");
    const opened = await openHome(home, secrets, () => T0);
    try {
      const consumer = registered.mock.calls[0]![0];
      registered.mockRestore();
      let worst = 0;
      for (let index = 0; index < AUTHORITY_RECOVERY_BUDGET.hardFrames * 2; index += 1) {
        await opened.sources.authority.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: T0 } }]);
        const head = await opened.sources.authority.checkpoint();
        worst = Math.max(worst, head.lsn - consumer.coveredThrough(head.logId)!.lsn);
      }
      expect(worst).toBeLessThanOrEqual(AUTHORITY_RECOVERY_BUDGET.hardFrames);
    } finally {
      registered.mockRestore();
      await opened.close();
    }
  }, TIMEOUT_MS);
});

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> { this.values.set(key(ref), value); }
  async get(ref: SecretRef): Promise<string | null> { return this.values.get(key(ref)) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const storageKey = key(ref);
    const existing = this.values.get(storageKey);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(storageKey, value);
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
