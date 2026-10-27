import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactRef,
  CommitEnvelope,
  Digest,
  JsonValue,
  SurfaceAssetGrant,
  SurfaceAssetScope,
} from "../../contracts/index.js";
import {
  byteDigest,
  canonicalize,
  createJobCommitFence,
  createJobSealedBundle,
  jobDeliveryPlanDigest,
  protocolDigest,
  sealedBundleArtifact,
} from "../../protocol/index.js";
import {
  createDefaultDeviceCapacityPolicy,
  currentDeviceCapacityStep,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  runInMaintenanceContext,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceTaskRunner,
  type DeviceCapacityAdmission,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceKind,
  type StorageMaintenanceRequest,
} from "../../resources/index.js";
import { ArtifactLifecycleIndex } from "../artifact-lifecycle-index.js";
import { FileArtifactStore } from "../artifact-store.js";
import {
  type ArtifactTemporaryPresenceStore,
  FileArtifactTemporaryPresenceStore,
  type FileArtifactTemporaryPresenceStoreOptions,
} from "../artifact-temporary-presence.js";
import { FileResumableArtifactReceiver } from "../assignment-artifacts.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import {
  bindDurableProjectionMutations,
  FileDurableProjectionIndex,
} from "../durable-projection-index.js";
import type { DurableLogCheckpoint } from "../interfaces.js";
import { maximumAuthorityRecoveryTailBytes } from "../recovery-work.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";
import { SerialTaskQueue } from "../../persistence/serial-task-queue.js";

// 重 IO 组级预算:本机(低资源 Windows)上单条耐久用例真实耗时可达 20-30 秒,
// 30 秒档会被临界抖动随机击穿;对齐 runbook 已验证的 120 秒档,断言失败仍立即终止。
const DURABLE_IO_TEST_TIMEOUT_MS = 240_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function temporaryPresence(
  root: string,
  options: FileArtifactTemporaryPresenceStoreOptions = {},
): FileArtifactTemporaryPresenceStore {
  return new FileArtifactTemporaryPresenceStore(
    path.join(root, "temporary", ".presence"),
    options,
  );
}

function temporaryPresenceStagingPath(
  presence: FileArtifactTemporaryPresenceStore,
  ref: ArtifactRef,
  scopeIdentity: string,
): string {
  const scopeKey = protocolDigest("ArtifactTemporaryPresenceScope", 1, {
    scopeIdentity,
  }).slice("sha256:".length);
  return path.join(
    presence.rootDir,
    ref.digest.slice("sha256:".length),
    `.${scopeKey}.json.tmp`,
  );
}

async function corruptProjectionSegmentContaining(
  rootDir: string,
  key: string,
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, "manifest.json"), "utf8"),
  ) as {
    readonly deltaSegments: readonly {
      readonly dataFile: string;
      readonly minKey: string;
      readonly maxKey: string;
    }[];
  };
  const segment = manifest.deltaSegments.find(({ minKey, maxKey }) =>
    key >= minKey && key <= maxKey
  );
  if (!segment) throw new Error("Projection key has no delta segment");
  await writeFile(path.join(rootDir, segment.dataFile), Buffer.alloc(0));
}

async function replaceLifecycleProjectionValue(
  rootDir: string,
  log: FileAuthorityCommitLog,
  key: string,
  value: JsonValue,
): Promise<void> {
  const index = new FileDurableProjectionIndex({
    rootDir: path.join(rootDir, "artifact-lifecycle"),
    projectionId: "artifact-lifecycle",
    reducerVersion: 3,
  });
  const origin = await log.originCheckpoint();
  await index.initialize({ [origin.logId]: origin });
  const prepared = await index.prepare(
    bindDurableProjectionMutations([
      { kind: "put", key, value },
    ]),
  );
  index.publish(prepared, index.checkpoints());
  await index.flush();
  await index.stopStorageMaintenance();
}

class MemoryTemporaryPresenceStore
implements ArtifactTemporaryPresenceStore {
  readonly scopes = new Map<
    string,
    { ref: ArtifactRef; values: Set<string> }
  >();
  readonly removedBatches: string[][] = [];
  readonly migrations = new Set<string>();
  failOnMark: number | undefined;
  markCalls = 0;

  async mark(ref: ArtifactRef, scopeIdentity: string) {
    this.markCalls += 1;
    if (this.markCalls === this.failOnMark) {
      throw new Error("injected presence write failure");
    }
    const current = this.scopes.get(ref.digest) ?? {
      ref,
      values: new Set<string>(),
    };
    current.values.add(scopeIdentity);
    this.scopes.set(ref.digest, current);
  }

  async has(ref: ArtifactRef) {
    return (this.scopes.get(ref.digest)?.values.size ?? 0) > 0;
  }

  async visitReferences(
    visitor: (ref: ArtifactRef) => void | Promise<void>,
  ) {
    for (const { ref } of this.scopes.values()) await visitor(ref);
  }

  async visitScopes(
    ref: ArtifactRef,
    visitor: (scopeIdentity: string) => void | Promise<void>,
  ) {
    for (const scope of this.scopes.get(ref.digest)?.values ?? []) {
      await visitor(scope);
    }
  }

  async removeScopes(
    ref: ArtifactRef,
    scopeIdentities: readonly string[],
  ) {
    this.removedBatches.push([...scopeIdentities]);
    const current = this.scopes.get(ref.digest);
    if (!current) return;
    for (const scope of scopeIdentities) current.values.delete(scope);
    if (current.values.size === 0) this.scopes.delete(ref.digest);
  }

  async remove(
    ref: ArtifactRef,
    scopeIdentity?: string,
  ) {
    if (scopeIdentity === undefined) {
      this.scopes.delete(ref.digest);
      return;
    }
    await this.removeScopes(ref, [scopeIdentity]);
  }

  async removeStagingFiles() {
    return 0;
  }

  openReconciliationCursor() {
    const entries = [...this.scopes.values()].flatMap(({ ref, values }) =>
      [...values].map((scopeIdentity) => ({ ref, scopeIdentity }))
    );
    let offset = 0;
    return {
      next: async (limit: number) => {
        const page = entries.slice(offset, offset + limit);
        offset += page.length;
        return { entries: page, done: offset >= entries.length };
      },
      close: async () => undefined,
    };
  }

  async hasLegacyMigration(ref: ArtifactRef) {
    return this.migrations.has(ref.digest);
  }

  async beginLegacyMigration(ref: ArtifactRef) {
    this.migrations.add(ref.digest);
  }

  async finishLegacyMigration(ref: ArtifactRef) {
    this.migrations.delete(ref.digest);
  }
}

describe("ArtifactLifecycleIndex", () => {
  it(
    "bounds source catch-up per synchronization attempt and resumes durably",
    async () => {
      const root = await createTempDir("artifact-lifecycle-bounded-tail");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const commits = Array.from(
        { length: 257 },
        (_, index): CommitEnvelope<JsonValue> => ({
          lsn: index + 1,
          at: "2026-07-25T00:00:00.000Z",
          entries: [],
          envelopeDigest: `sha256:${(index + 1)
            .toString(16)
            .padStart(64, "0")}` as Digest,
        }),
      );
      const checkpoint = (lsn: number): DurableLogCheckpoint => ({
        logId: "bounded-tail-log",
        lsn,
        frameEndOffset: lsn,
        prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}` as Digest,
      });
      const readTail = vi.fn(
        async (current: DurableLogCheckpoint, limit: number) => {
          const page = commits.slice(current.lsn, current.lsn + limit);
          const nextLsn = page.at(-1)?.lsn ?? current.lsn;
          return {
            commits: page,
            checkpoint: checkpoint(nextLsn),
            hasMore: nextLsn < commits.length,
          };
        },
      );
      const log = {
        originCheckpoint: async () => checkpoint(0),
        checkpoint: async () => checkpoint(commits.length),
        readTail,
        stopStorageMaintenance: async () => {},
      } as unknown as FileAuthorityCommitLog;
      const createLifecycle = () => new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });

      const lifecycle = createLifecycle();
      await expect(lifecycle.synchronize()).resolves.toBeUndefined();
      expect(readTail.mock.calls.map(([cursor]) => cursor.lsn)).toEqual([
        0, 64, 128, 192, 256,
      ]);
      expect(readTail.mock.calls.map(([, limit]) => limit)).toEqual([
        64, 64, 64, 64, 1,
      ]);
      commits.push({ ...commits.at(-1)!, lsn: 258, envelopeDigest: `sha256:${(258).toString(16).padStart(64, "0")}` });
      await lifecycle.synchronize();
      await lifecycle.stopStorageMaintenance();
      readTail.mockClear();
      const reopened = createLifecycle();
      try {
        await reopened.synchronize();
        // A crash may lose only the one coalesced tail record. Full source
        // pages remain durably checkpointed, with no repeated old work.
        expect(readTail.mock.calls.map(([cursor]) => cursor.lsn)).toEqual([257]);
      } finally { await reopened.stopStorageMaintenance(); }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps release identity stable across restarts and only changes it for a new fact",
    async () => {
      const root = await createTempDir("artifact-lifecycle");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      let current = "2026-07-25T00:00:00.000Z";
      const owner = new FileAuthorityCommitLog(
        path.join(root, "owner"),
        artifacts,
        { clock: () => current },
      );
      const executor = new FileAuthorityCommitLog(
        path.join(root, "executor"),
        artifacts,
        { clock: () => current },
      );
      const ref = await artifacts.put(Buffer.from("owned leaf", "utf8"));
      const attachment = { ...ref, kind: "file" };
      await owner.append([
        {
          stream: "run:conv-a",
          body: { t: "admitted", attachments: [attachment] },
        },
      ]);
      await executor.append([
        {
          stream: "run:conv-a",
          body: { t: "admitted", attachments: [attachment] },
        },
      ]);

      current = "2026-07-25T01:00:00.000Z";
      await owner.append([
        {
          stream: "run:conv-a",
          body: { t: "session-lifecycle", mutation: "delete" },
        },
      ]);
      const firstIndex = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [executor, owner],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      const [first] = await firstIndex.releasedBefore(
        "2026-07-25T02:00:00.000Z",
        8,
      );
      expect(first).toMatchObject({
        ref,
        releasedAt: current,
      });

      const reopened = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [owner, executor],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await expect(
        reopened.releasedBefore("2026-07-25T02:00:00.000Z", 8),
      ).resolves.toEqual([first]);
      await reopened.markReclaimed([first!]);

      const afterReclaim = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [executor, owner],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await expect(
        afterReclaim.releasedBefore("2026-07-25T02:00:00.000Z", 8),
      ).resolves.toEqual([]);

      current = "2026-07-25T01:30:00.000Z";
      await executor.append([
        {
          stream: "run:conv-a",
          body: { t: "admitted", attachments: [attachment] },
        },
      ]);
      const [second] = await afterReclaim.releasedBefore(
        "2026-07-25T02:00:00.000Z",
        8,
      );
      expect(second?.releasedAt).toBe("2026-07-25T01:00:00.000Z");
      expect(second?.releaseId).not.toBe(first?.releaseId);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "reconciles temporary storage only while rebuilding the durable index",
    async () => {
      const root = await createTempDir("artifact-lifecycle-reconciliation");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const log = new FileAuthorityCommitLog(
        path.join(root, "log"),
        artifacts,
        { clock: () => "2026-07-25T00:00:00.000Z" },
      );
      const ref = await temporaryArtifacts.put(Buffer.alloc(17, 1));
      const scope: SurfaceAssetScope = {
        domain: "conversation",
        conversationId: "conversation-reconciliation",
        ownerEpoch: 1,
      };
      const grant: SurfaceAssetGrant = {
        v: 1,
        grantId: "grt-01J00000000000000000000003",
        scope,
        surfacePrincipal: "surface-reconciliation",
        requestId: "request-reconciliation",
        kind: "asset-upload",
        payloadDigest: `sha256:${"c".repeat(64)}` as Digest,
        assets: [ref],
        issuedAt: "2026-07-25T00:00:00.000Z",
        expiry: "2026-07-25T01:00:00.000Z",
        signature: { alg: "test", keyId: "owner", sig: "test" },
      };
      await log.append([
        { stream: "control", body: { t: "asset-grant-issued", grant } },
      ]);
      const openReferenceCursor = vi.spyOn(
        temporaryArtifacts,
        "openReferenceCursor",
      );
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await expect(lifecycle.quotaSnapshot(scope, [ref])).resolves.toEqual({
        scopeBytes: 17,
        deviceBytes: 17,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: true,
            deviceCounted: true,
            retained: false,
          },
        ],
      });
      expect(openReferenceCursor).toHaveBeenCalledTimes(1);

      openReferenceCursor.mockClear();
      const reopened = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await expect(reopened.activeGrant(grant.grantId)).resolves.toEqual(
        grant,
      );
      expect(openReferenceCursor).not.toHaveBeenCalled();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds exact, prefix, and ordered grant records whose business identity is misbound",
    async () => {
      const root = await createTempDir("artifact-lifecycle-key-binding");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => "2026-07-25T00:30:00.000Z",
      });
      const makeGrant = (
        suffix: string,
        conversationId: string,
        surfacePrincipal: string,
        expiry: string,
      ): SurfaceAssetGrant => ({
        v: 1,
        grantId: `grt-01J0000000000000000000000${suffix}`,
        scope: { domain: "conversation", conversationId, ownerEpoch: 1 },
        surfacePrincipal,
        requestId: `request-${suffix}`,
        kind: "asset-download",
        assets: [{
          digest: `sha256:${suffix.repeat(64)}` as Digest,
          bytes: 1,
        }],
        issuedAt: "2026-07-25T00:00:00.000Z",
        expiry,
        signature: { alg: "test", keyId: "owner", sig: `signature-${suffix}` },
      });
      const first = makeGrant(
        "1",
        "conversation-one",
        "surface-one",
        "2026-07-25T01:00:00.000Z",
      );
      const second = makeGrant(
        "2",
        "conversation-two",
        "surface-two",
        "2026-07-25T02:00:00.000Z",
      );
      await log.append([
        { stream: "control", body: { t: "asset-grant-issued", grant: first } },
        { stream: "control", body: { t: "asset-grant-issued", grant: second } },
      ]);
      const derivedRoot = path.join(root, "derived");
      // 每个实例用完即停：下面的改写是绕过索引写者锁的裸投影写入，不能与上一个实例仍在后台
      // 进行的退休清理并发写同一份清单。
      const inspectWith = async <T>(inspect: (index: ArtifactLifecycleIndex) => Promise<T>): Promise<T> => {
        const index = new ArtifactLifecycleIndex({
          rootDir: derivedRoot,
          logs: [log],
          artifacts,
          temporaryArtifacts,
          temporaryPresence: temporaryPresence(root),
          receiver,
          ownsSourceLogs: false,
        });
        try {
          return await inspect(index);
        } finally {
          await index.stopStorageMaintenance();
        }
      };
      await expect(inspectWith((index) => index.activeGrant(first.grantId))).resolves.toEqual(
        first,
      );
      const encode = (value: string) =>
        Buffer.from(value, "utf8").toString("base64url");
      const checks: Array<{
        readonly key: string;
        readonly inspect: (index: ArtifactLifecycleIndex) => Promise<unknown>;
        readonly expected: unknown;
      }> = [
        {
          key: `grant/active/${encode(first.grantId)}`,
          inspect: (index) => index.activeGrant(first.grantId),
          expected: first,
        },
        {
          key: `grant/conversation/${encode("conversation-one")}/${
            encode(first.grantId)
          }`,
          inspect: (index) =>
            index.activeConversationGrants("conversation-one", 8),
          expected: [first],
        },
        {
          key: `grant/surface/${encode("surface-one")}/${
            encode(first.grantId)
          }`,
          inspect: (index) => index.activeSurfaceGrants("surface-one", 8),
          expected: [first],
        },
        {
          key: `grant/expiry/${first.expiry}/${encode(first.grantId)}`,
          inspect: (index) => index.nextGrantExpiry(),
          expected: first.expiry,
        },
      ];
      for (const check of checks) {
        await replaceLifecycleProjectionValue(
          derivedRoot,
          log,
          check.key,
          {
            key: check.key,
            grantId: second.grantId,
          },
        );
        await expect(inspectWith(check.inspect)).resolves.toEqual(
          check.expected,
        );
      }
      await replaceLifecycleProjectionValue(
        derivedRoot,
        log,
        `grant/history/${encode(first.grantId)}`,
        JSON.parse(canonicalize({
          ...second,
          grantId: first.grantId,
        })) as JsonValue,
      );
      await expect(
        inspectWith((index) => index.activeGrant(first.grantId, first)),
      ).resolves.toEqual(first);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "accounts reconciliation scan reads inside the page permit",
    async () => {
      // 对账页里的目录扫描与 marker 读取都调用 claimDeviceCapacity,而那个记账
      // 在没有容量语境时是静默空操作:只给写删叶补 permit,读的这一半就从有覆盖
      // 退成没覆盖,而且不会有任何出口暴露出来。
      const root = await createTempDir("artifact-lifecycle-scan-accounting");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => "2026-07-25T00:00:00.000Z",
      });
      const claims: string[] = [];
      const storageMaintenance: StorageMaintenanceGovernorPort = {
        acquire: async () => ({
          kind: "granted",
          permit: {
            granted: {
              memoryReservationBytes: 0,
              temporaryBytes: 0,
              slots: 0,
              readBytes: Number.MAX_SAFE_INTEGER,
              writeBytes: Number.MAX_SAFE_INTEGER,
              ioOperations: Number.MAX_SAFE_INTEGER,
            },
            tryBegin: () => ({
              claim: (dimension: string) => {
                claims.push(dimension);
              },
              complete: () => undefined,
            }),
            release: () => undefined,
          },
        }),
        snapshot: () => ({ queued: {}, inFlight: {} }),
      };
      const presence = temporaryPresence(root, { storageMaintenance });
      const bytes = Buffer.from("scan accounting", "utf8");
      const ref = { digest: byteDigest(bytes), bytes: bytes.byteLength };
      await presence.mark(ref, "scope-scan-accounting");
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: presence,
        receiver,
        storageMaintenance,
      });
      claims.length = 0;

      await lifecycle.synchronize();

      // marker 读取只发生在对账扫描里:读的字节记进了账,才说明这一页确实在
      // 容量语境内执行。
      expect(claims).toContain("readBytes");
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "admits the internal projection flush of a lifecycle mutation",
    async () => {
      // 内部投影不注入 governor 时,公开变更方法的 prepare/publish/flush 全部落在
      // 任何 permit 之外:读代码看得见叶里的记账调用,但那次记账没有语境可落。
      const root = await createTempDir("artifact-lifecycle-governed-flush");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => "2026-07-25T00:00:00.000Z",
      });
      const bytes = Buffer.from("governed flush", "utf8");
      const ref = await temporaryArtifacts.put(bytes);
      const grant: SurfaceAssetGrant = {
        v: 1,
        grantId: "grt-01J0000000000000000000000F",
        scope: {
          domain: "conversation",
          conversationId: "conversation-governed-flush",
          ownerEpoch: 1,
        },
        surfacePrincipal: "surface-governed-flush",
        requestId: "request-governed-flush",
        kind: "asset-upload",
        payloadDigest: byteDigest(Buffer.from("governed flush payload")),
        assets: [ref],
        issuedAt: "2026-07-25T00:00:00.000Z",
        expiry: "2026-07-25T01:00:00.000Z",
        signature: { alg: "test", keyId: "owner", sig: "test" },
      };
      await log.append([
        { stream: "control", body: { t: "asset-grant-issued", grant } },
      ]);
      const admissions: StorageMaintenanceKind[] = [];
      let activeSteps = 0;
      const storageMaintenance: StorageMaintenanceGovernorPort = {
        acquire: async (request) => {
          expect(activeSteps).toBe(0);
          admissions.push(request.kind);
          return {
            kind: "granted",
            permit: {
              granted: {
                occupancy: {
                  memoryReservationBytes: 0,
                  temporaryBytes: 0,
                  slots: 1,
                },
                quantum: {
                  readBytes: Number.MAX_SAFE_INTEGER,
                  writeBytes: Number.MAX_SAFE_INTEGER,
                  ioOperations: Number.MAX_SAFE_INTEGER,
                },
              },
              tryBegin: () => {
                activeSteps += 1;
                return {
                  claim: () => undefined,
                  complete: () => {
                    activeSteps -= 1;
                  },
                };
              },
              release: () => undefined,
            },
          };
        },
        snapshot: () => ({ queued: {}, inFlight: {} }),
      };
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root, { storageMaintenance }),
        receiver,
        storageMaintenance,
      });

      await lifecycle.recordTemporaryPresence(ref, canonicalize(grant.scope));

      // 两个叶都必须自取容量:投影提交与 presence 物理写。
      expect(admissions).toContain("projection-flush");
      expect(admissions).toContain("lifecycle-reconcile");
      expect(activeSteps).toBe(0);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it("reopens and compacts lifecycle projections without nested single-slot admission", async () => {
    const root = await createTempDir("lifecycle-single-slot-projection");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const temporaryArtifacts = new FileArtifactStore(path.join(root, "temporary"));
    const receiver = new FileResumableArtifactReceiver(temporaryArtifacts, path.join(root, "partials"), { maxArtifactBytes: 1024 });
    const policy = createDefaultDeviceCapacityPolicy();
    const capacity = new DefaultDeviceCapacityArbiter({ policy: { ...policy, occupancy: { ...policy.occupancy, slots: 1 } },
      probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 32 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
    const delegate = new DefaultStorageMaintenanceGovernor({ capacity });
    const admissions: StorageMaintenanceKind[] = [];
    let nested = 0;
    const storageMaintenance: StorageMaintenanceGovernorPort = {
      acquire: async (...args) => { if (currentDeviceCapacityStep()?.kind === "physical") nested += 1; admissions.push(args[0].kind); return delegate.acquire(...args); },
      snapshot: () => delegate.snapshot(),
    };
    const createLog = () => new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { clock: () => "2026-07-25T00:00:00.000Z" });
    const createLifecycle = (log: FileAuthorityCommitLog) => new ArtifactLifecycleIndex({ rootDir: path.join(root, "derived"), logs: [log], artifacts, temporaryArtifacts,
      temporaryPresence: temporaryPresence(root, { storageMaintenance }), receiver, storageMaintenance });
    const log = createLog();
    const lifecycle = createLifecycle(log);
    let reopened: ArtifactLifecycleIndex | undefined;
    try {
      const ref = await temporaryArtifacts.put(Buffer.from("single slot"));
      for (let i = 0; i < 8; i += 1) {
        const grant: SurfaceAssetGrant = { v: 1, grantId: "grt-" + String(i).padStart(26, "0"),
          scope: { domain: "conversation", conversationId: "single-slot", ownerEpoch: 1 }, surfacePrincipal: "single-slot",
          requestId: "request-" + i, kind: "asset-upload", payloadDigest: byteDigest(Buffer.from("payload-" + i)), assets: [ref],
          issuedAt: "2026-07-25T00:00:00.000Z", expiry: "2026-07-25T01:00:00.000Z", signature: { alg: "test", keyId: "owner", sig: "test" } };
        await log.append([{ stream: "control", body: { t: "asset-grant-issued", grant } }]);
        await runInMaintenanceContext("foreground", () => lifecycle.synchronize());
        // An actual temporary-presence mutation remains durable and drives
        // compaction even though pure source replay now coalesces short tails.
        await runInMaintenanceContext("foreground", () => lifecycle.recordTemporaryPresence(ref, canonicalize(grant.scope)));
      }
      expect(admissions).toContain("projection-compaction");
      await lifecycle.stopStorageMaintenance();
      reopened = createLifecycle(createLog());
      expect(await runInMaintenanceContext("foreground", () => reopened!.activeConversationGrants("single-slot", 16))).toHaveLength(8);
      expect(nested).toBe(0);
      expect(capacity.snapshot().occupancyInUse.slots).toBe(0);
    } finally { await reopened?.stopStorageMaintenance(); await lifecycle.stopStorageMaintenance(); }
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("idle maintenance catches up and completes pending compaction without nested single-slot admission", async () => {
    const root = await createTempDir("lifecycle-idle-maintenance");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const temporaryArtifacts = new FileArtifactStore(path.join(root, "temporary"));
    const receiver = new FileResumableArtifactReceiver(temporaryArtifacts, path.join(root, "partials"), { maxArtifactBytes: 1024 });
    const policy = createDefaultDeviceCapacityPolicy();
    const capacity = new DefaultDeviceCapacityArbiter({ policy: { ...policy, occupancy: { ...policy.occupancy, slots: 1 } },
      probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 32 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
    const delegate = new DefaultStorageMaintenanceGovernor({ capacity });
    const admissions: StorageMaintenanceKind[] = [];
    let nested = 0;
    const storageMaintenance: StorageMaintenanceGovernorPort = {
      acquire: async (...args) => { if (currentDeviceCapacityStep()?.kind === "physical") nested += 1; admissions.push(args[0].kind); return delegate.acquire(...args); },
      snapshot: () => delegate.snapshot(),
    };
    const createLog = () => new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { clock: () => "2026-07-25T00:00:00.000Z" });
    const createLifecycle = (log: FileAuthorityCommitLog) => new ArtifactLifecycleIndex({ rootDir: path.join(root, "derived"), logs: [log], artifacts, temporaryArtifacts,
      temporaryPresence: temporaryPresence(root, { storageMaintenance }), receiver, storageMaintenance });
    const log = createLog();
    const lifecycle = createLifecycle(log);
    let reopened: ArtifactLifecycleIndex | undefined;
    try {
      const ref = await temporaryArtifacts.put(Buffer.from("idle maintenance"));
      for (let i = 0; i < 6; i += 1) {
        const grant: SurfaceAssetGrant = { v: 1, grantId: "grt-" + String(i).padStart(26, "0"),
          scope: { domain: "conversation", conversationId: "idle", ownerEpoch: 1 }, surfacePrincipal: "idle",
          requestId: "request-" + i, kind: "asset-upload", payloadDigest: byteDigest(Buffer.from("payload-" + i)), assets: [ref],
          issuedAt: "2026-07-25T00:00:00.000Z", expiry: "2026-07-25T01:00:00.000Z", signature: { alg: "test", keyId: "owner", sig: "test" } };
        await log.append([{ stream: "control", body: { t: "asset-grant-issued", grant } }]);
        await runInMaintenanceContext("background", () => lifecycle.maintainIdle());
      }
      // 每轮空闲维护都把追平结果落盘；增量段超过上界时在这里完成合并，而不是留给下一次启动或请求。
      expect(admissions).toContain("projection-flush");
      expect(admissions).toContain("projection-compaction");
      await lifecycle.stopStorageMaintenance();
      reopened = createLifecycle(createLog());
      expect(await runInMaintenanceContext("foreground", () => reopened!.activeConversationGrants("idle", 16))).toHaveLength(6);
      expect(nested).toBe(0);
      expect(capacity.snapshot().occupancyInUse.slots).toBe(0);
    } finally { await reopened?.stopStorageMaintenance(); await lifecycle.stopStorageMaintenance(); }
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it(
    "redrives lifecycle backpressure outside its queue without waiting under a caller exclusion",
    async () => {
      const root = await createTempDir("artifact-lifecycle-backpressure-redrive");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => "2026-07-25T00:00:00.000Z",
      });
      let lifecycleAttempts = 0;
      let keepBackpressured = false;
      const storageMaintenance: StorageMaintenanceGovernorPort = {
        acquire: async (request): Promise<DeviceCapacityAdmission> => {
          if (request.kind === "lifecycle-reconcile") {
            lifecycleAttempts += 1;
            if (lifecycleAttempts === 1 || keepBackpressured) {
              return {
                kind: "backpressured",
                blockedBy: "ioOperations",
                retryAfterMs: 1,
              };
            }
          }
          return {
            kind: "granted",
            permit: {
              granted: request.preferred,
              tryBegin: () => ({
                claim: () => undefined,
                complete: () => undefined,
              }),
              release: () => undefined,
            },
          };
        },
        snapshot: () => ({ queued: {}, inFlight: {} }),
      };
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root, { storageMaintenance }),
        receiver,
        storageMaintenance,
      });

      try {
        await expect(lifecycle.synchronize()).resolves.toBeUndefined();
        expect(lifecycleAttempts).toBeGreaterThan(1);

        lifecycleAttempts = 0;
        keepBackpressured = true;
        const callerQueue = new SerialTaskQueue();
        await expect(
          callerQueue.run(() => lifecycle.synchronize()),
        ).rejects.toThrow(/backpressured/);
        expect(lifecycleAttempts).toBe(1);
      } finally {
        await lifecycle.stopStorageMaintenance();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds release, temporary, and maintenance records before side effects",
    async () => {
      const root = await createTempDir("artifact-lifecycle-secondary-binding");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      let current = "2026-07-25T00:00:00.000Z";
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => current,
      });
      const bytes = Buffer.from("secondary binding", "utf8");
      const ref = await temporaryArtifacts.put(bytes);
      await expect(artifacts.put(bytes)).resolves.toEqual(ref);
      const grant: SurfaceAssetGrant = {
        v: 1,
        grantId: "grt-01J00000000000000000000009",
        scope: {
          domain: "conversation",
          conversationId: "conversation-secondary",
          ownerEpoch: 1,
        },
        surfacePrincipal: "surface-secondary",
        requestId: "request-secondary",
        kind: "asset-upload",
        payloadDigest: byteDigest(Buffer.from("secondary payload")),
        assets: [ref],
        issuedAt: current,
        expiry: "2026-07-25T01:00:00.000Z",
        signature: { alg: "test", keyId: "owner", sig: "test" },
      };
      const otherGrant: SurfaceAssetGrant = {
        ...grant,
        grantId: "grt-01J00000000000000000000008",
        requestId: "request-secondary-other",
        signature: { alg: "test", keyId: "owner", sig: "test-other" },
      };
      await log.append([
        { stream: "control", body: { t: "asset-grant-issued", grant } },
        { stream: "control", body: { t: "asset-grant-issued", grant: otherGrant } },
      ]);
      const derivedRoot = path.join(root, "derived");
      const createIndex = () =>
        new ArtifactLifecycleIndex({
          rootDir: derivedRoot,
          logs: [log],
          ownsSourceLogs: false,
          artifacts,
          temporaryArtifacts,
          temporaryPresence: temporaryPresence(root),
          receiver,
        });
      const withIndex = async <T>(operation: (index: ArtifactLifecycleIndex) => Promise<T>) => {
        const index = createIndex();
        try { return await operation(index); }
        finally { await index.stopStorageMaintenance(); }
      };
      const scopeIdentity = canonicalize(grant.scope);
      const lifecycle = createIndex();
      await lifecycle.recordTemporaryPresence(ref, scopeIdentity);
      await lifecycle.settleTemporaryPresence(ref, scopeIdentity, true);
      await lifecycle.stopStorageMaintenance();
      const hex = ref.digest.slice("sha256:".length);
      const wrongDigest = `sha256:${"f".repeat(64)}` as Digest;
      const dueKey = `temporary/due/${grant.expiry}/${hex}`;
      await replaceLifecycleProjectionValue(
        derivedRoot,
        log,
        dueKey,
        { key: dueKey, digest: wrongDigest },
      );
      await expect(
        withIndex(index => index.temporaryBefore("2026-07-25T02:00:00.000Z", 8)),
      ).resolves.toEqual([{ ref, eligibleAt: grant.expiry }]);

      const adoptionKey = `adoption-pending/${hex}`;
      await replaceLifecycleProjectionValue(
        derivedRoot,
        log,
        adoptionKey,
        {
          key: adoptionKey,
          digest: ref.digest,
          adopted: true,
        },
      );
      await expect(withIndex(index => index.synchronize())).resolves.toBeUndefined();

      await log.append([
        {
          stream: "run:conversation-secondary",
          body: {
            t: "admitted",
            attachments: [{ ...ref, kind: "file" }],
          },
        },
      ]);
      const uploadKey = `grant/upload/${hex}/${
        Buffer.from(grant.grantId, "utf8").toString("base64url")
      }`;
      await replaceLifecycleProjectionValue(
        derivedRoot,
        log,
        uploadKey,
        { key: uploadKey, grantId: otherGrant.grantId },
      );
      await expect(withIndex(index => index.synchronize())).resolves.toBeUndefined();
      const cleanupKey = `temporary/cleanup/${hex}`;
      await replaceLifecycleProjectionValue(
        derivedRoot,
        log,
        cleanupKey,
        { key: cleanupKey, digest: wrongDigest },
      );
      await expect(withIndex(index => index.adoptedTemporary(8))).resolves.toEqual([ref]);

      current = "2026-07-25T00:30:00.000Z";
      await log.append([
        {
          stream: "run:conversation-secondary",
          body: { t: "session-lifecycle", mutation: "delete" },
        },
      ]);
      const [release] = await withIndex(index => index.releasedBefore(
        "2026-07-25T02:00:00.000Z",
        8,
      ));
      expect(release).toBeDefined();
      const releaseKey = `release/${release!.releasedAt}/${hex}/${
        release!.releaseId.slice("sha256:".length)
      }`;
      await replaceLifecycleProjectionValue(
        derivedRoot,
        log,
        releaseKey,
        { key: releaseKey, digest: wrongDigest },
      );
      await expect(
        withIndex(index => index.releasedBefore("2026-07-25T02:00:00.000Z", 8)),
      ).resolves.toEqual([release]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps adopted cleanup drainable after the leaf is released",
    async () => {
      // 接管后、GC 清扫前会话即删除:叶子进入"已释放 + cleanup 未清"。这是合法
      // 中间态——临时副本的物理清理与正式字节的保留窗无关。若 cleanup 反绑要求
      // 主状态仍被保留,这个组合会抛投影损坏,重建重放得到同一状态再抛,GC 停摆。
      const root = await createTempDir("artifact-lifecycle-released-cleanup");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      let current = "2026-07-25T00:00:00.000Z";
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => current,
      });
      const bytes = Buffer.from("released cleanup", "utf8");
      const ref = await temporaryArtifacts.put(bytes);
      await expect(artifacts.put(bytes)).resolves.toEqual(ref);
      const grant: SurfaceAssetGrant = {
        v: 1,
        grantId: "grt-01J00000000000000000000019",
        scope: {
          domain: "conversation",
          conversationId: "conversation-released-cleanup",
          ownerEpoch: 1,
        },
        surfacePrincipal: "surface-released-cleanup",
        requestId: "request-released-cleanup",
        kind: "asset-upload",
        payloadDigest: byteDigest(Buffer.from("released cleanup payload")),
        assets: [ref],
        issuedAt: current,
        expiry: "2026-07-25T01:00:00.000Z",
        signature: { alg: "test", keyId: "owner", sig: "test" },
      };
      await log.append([
        { stream: "control", body: { t: "asset-grant-issued", grant } },
      ]);
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      const scopeIdentity = canonicalize(grant.scope);
      await lifecycle.recordTemporaryPresence(ref, scopeIdentity);
      await lifecycle.settleTemporaryPresence(ref, scopeIdentity, true);
      await log.append([
        {
          stream: "run:conversation-released-cleanup",
          body: { t: "admitted", attachments: [{ ...ref, kind: "file" }] },
        },
      ]);
      await lifecycle.synchronize();
      await expect(lifecycle.adoptedTemporary(8)).resolves.toEqual([ref]);

      current = "2026-07-25T00:30:00.000Z";
      await log.append([
        {
          stream: "run:conversation-released-cleanup",
          body: { t: "session-lifecycle", mutation: "delete" },
        },
      ]);
      await lifecycle.synchronize();
      // 释放事实成立(可回收候选存在)……
      await expect(
        lifecycle.releasedBefore("2026-07-25T02:00:00.000Z", 8),
      ).resolves.toMatchObject([{ ref }]);
      // ……同时 cleanup 仍可枚举、可清扫,不得抛投影损坏。
      await expect(lifecycle.adoptedTemporary(8)).resolves.toEqual([ref]);
      await expect(lifecycle.markTemporaryRemoved(ref)).resolves.toBe(true);
      await expect(lifecycle.adoptedTemporary(8)).resolves.toEqual([]);
      // 临时记录不得在释放后退回"过期临时"。
      await expect(
        lifecycle.temporaryBefore("2026-07-25T09:00:00.000Z", 8),
      ).resolves.toEqual([]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "retains conservatively when a source advances after synchronization",
    async () => {
      const root = await createTempDir("artifact-lifecycle-fence");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts);
      const ref = await artifacts.put(Buffer.from("fenced leaf", "utf8"));
      const checkpoint = vi.spyOn(log, "checkpoint");
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await lifecycle.synchronize();
      const firstHead = await checkpoint.mock.results.at(-1)!.value;
      await lifecycle.synchronize();
      expect(checkpoint.mock.calls.at(-1)?.[0]).toBe(firstHead);
      expect(await checkpoint.mock.results.at(-1)!.value).toBe(firstHead);
      await log.append([
        {
          stream: "publish",
          body: { t: "asset", ref },
        },
      ]);

      await expect(lifecycle.retainedAtCurrentHead([ref])).resolves.toEqual({
        status: "deferred",
      });
      await lifecycle.synchronize();
      await expect(lifecycle.retainedAtCurrentHead([ref])).resolves.toEqual({
        status: "current",
        retained: [ref],
      });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds a damaged retention snapshot before the next delete fence",
    async () => {
      const root = await createTempDir("artifact-lifecycle-fence-rebuild");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts);
      const ref = await artifacts.put(Buffer.from("retained leaf", "utf8"));
      await log.append([
        {
          stream: "publish",
          body: { t: "asset", ref },
        },
      ]);
      const derivedRoot = path.join(root, "derived");
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: derivedRoot,
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await lifecycle.synchronize();
      await corruptProjectionSegmentContaining(
        path.join(derivedRoot, "artifact-lifecycle"),
        `state/${ref.digest.slice("sha256:".length)}`,
      );

      await expect(lifecycle.retainedAtCurrentHead([ref])).resolves.toEqual({
        status: "deferred",
      });
      await lifecycle.synchronize();
      await expect(lifecycle.retainedAtCurrentHead([ref])).resolves.toEqual({
        status: "current",
        retained: [ref],
      });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "projects external control leaves and job sealed roots from both authority domains",
    async () => {
      const root = await createTempDir("artifact-lifecycle-registered-roots");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const authorityLog = new FileAuthorityCommitLog(
        path.join(root, "authority-log"),
        artifacts,
      );
      const executorLog = new FileAuthorityCommitLog(
        path.join(root, "executor-log"),
        artifacts,
      );
      const controlLeaf = await artifacts.put(
        Buffer.from("external control leaf"),
      );
      const controlBody = {
        t: "input" as const,
        conversationId: "conversation-external",
        ingress: {
          ingressId: "ingress-external",
          source: "first-party" as const,
        },
        input: { parts: [{ type: "text" as const, text: "inspect" }] },
        attachments: [{ ...controlLeaf, kind: "file" as const }],
        invocation: { kind: "agent" as const, source: "interactive" as const },
        ownerEpoch: 1,
      };
      const controlDependencies: ArtifactRef[] = [];
      const controlEnvelope = {
        v: 1 as const,
        requestId: "request-external",
        principal: {
          surfacePrincipal: "surface:user-external",
          deviceId: "device-external",
          connectionId: "connection-external",
        },
        at: "2026-07-24T00:00:00.000Z",
        dependencyArtifacts: controlDependencies,
        body: controlBody,
        payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
          body: controlBody,
          dependencyArtifacts: controlDependencies,
        }),
      };
      const controlEnvelopeRef = await artifacts.put(
        Buffer.from(canonicalize(controlEnvelope)),
      );

      const jobLeaf = await artifacts.put(Buffer.from("job content leaf"));
      const bundle = createJobSealedBundle({
        assignmentId: "assignment-job",
        executorId: "executor-job",
        streamFinal: {
          finalSeq: 1,
          streamDigest: `sha256:${"1".repeat(64)}`,
        },
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
        usageFinal: {
          reportDigest: `sha256:${"1".repeat(64)}`,
          upToUsageSeq: 0,
        },
        dependencyArtifacts: [],
        body: {
          t: "job",
          taskId: "task-job",
          jobRunId: "job-run-1",
          fence: createJobCommitFence({
            taskId: "task-job",
            jobRunId: "job-run-1",
            scheduledFor: "2026-07-24T00:00:00.000Z",
            taskRevision: 1,
            deliveryPlanDigest: jobDeliveryPlanDigest({ kind: "none" }),
            anchorEpoch: 1,
            assignmentId: "assignment-job",
            executorId: "executor-job",
          }),
          outcome: { status: "completed", summary: "done" },
          contentAssets: [{ ...jobLeaf, kind: "file" }],
        },
      });
      const bundleArtifact = sealedBundleArtifact(bundle);
      await artifacts.put(bundleArtifact.bytes);

      await authorityLog.append([
        {
          stream: "control",
          body: {
            t: "received",
            requestId: controlEnvelope.requestId,
            envelope: { ref: controlEnvelopeRef },
          },
        },
        {
          stream: "job:task-job",
          body: {
            t: "committed",
            assignmentId: bundle.assignmentId,
            bundle: { ref: bundleArtifact.ref },
          },
        },
      ]);
      await executorLog.append([
        {
          stream: `assignment:${bundle.assignmentId}`,
          body: {
            body: {
              t: "bundle_sealed",
              bundle: { ref: bundleArtifact.ref },
            },
          },
        },
      ]);

      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [authorityLog, executorLog],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await lifecycle.synchronize();
      await expect(
        lifecycle.retainedAtCurrentHead([
          controlLeaf,
          controlEnvelopeRef,
          jobLeaf,
          bundleArtifact.ref,
        ]),
      ).resolves.toEqual({
        status: "current",
        retained: [
          controlLeaf,
          controlEnvelopeRef,
          jobLeaf,
          bundleArtifact.ref,
        ],
      });

      await authorityLog.append([
        {
          stream: "run:conversation-external",
          body: { t: "session-lifecycle", mutation: "delete" },
        },
      ]);
      await lifecycle.synchronize();
      await expect(
        lifecycle.retainedAtCurrentHead([
          controlLeaf,
          controlEnvelopeRef,
          jobLeaf,
          bundleArtifact.ref,
        ]),
      ).resolves.toEqual({
        status: "current",
        retained: [
          controlEnvelopeRef,
          jobLeaf,
          bundleArtifact.ref,
        ],
      });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "resolves a crash-before-write intent without creating phantom occupancy",
    async () => {
      const root = await createTempDir("artifact-lifecycle-write-intent");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      let current = "2026-07-25T00:00:00.000Z";
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => current,
      });
      const ref = {
        digest: `sha256:${"d".repeat(64)}` as Digest,
        bytes: 17,
      };
      const scope: SurfaceAssetScope = {
        domain: "conversation",
        conversationId: "conversation-intent",
        ownerEpoch: 1,
      };
      const grant: SurfaceAssetGrant = {
        v: 1,
        grantId: "grt-01J00000000000000000000004",
        scope,
        surfacePrincipal: "surface-intent",
        requestId: "request-intent",
        kind: "asset-upload",
        payloadDigest: `sha256:${"e".repeat(64)}` as Digest,
        assets: [ref],
        issuedAt: current,
        expiry: "2026-07-25T01:00:00.000Z",
        signature: { alg: "test", keyId: "owner", sig: "test" },
      };
      await log.append([
        { stream: "control", body: { t: "asset-grant-issued", grant } },
      ]);
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await lifecycle.recordTemporaryPresence(ref, canonicalize(scope));

      current = "2026-07-25T02:00:00.000Z";
      await log.append([
        {
          stream: "control",
          body: { t: "authority-time-frontier", frontier: current },
        },
      ]);
      const reopened = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await expect(reopened.quotaSnapshot(scope, [ref])).resolves.toEqual({
        scopeBytes: 0,
        deviceBytes: 0,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: false,
            deviceCounted: false,
            retained: false,
          },
        ],
      });
      await expect(
        reopened.temporaryBefore(current, 8),
      ).resolves.toEqual([]);
      await expect(temporaryPresence(root).has(ref)).resolves.toBe(false);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds temporary quota from exact durable scope presence",
    async () => {
      const root = await createTempDir("artifact-lifecycle-scope-rebuild");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      let current = "2026-07-25T00:00:00.000Z";
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => current,
      });
      const bytes = Buffer.alloc(17, 2);
      const ref = { digest: byteDigest(bytes), bytes: bytes.byteLength };
      const firstScope: SurfaceAssetScope = {
        domain: "conversation",
        conversationId: "conversation-presence-a",
        ownerEpoch: 1,
      };
      const secondScope: SurfaceAssetScope = {
        domain: "conversation",
        conversationId: "conversation-presence-b",
        ownerEpoch: 1,
      };
      const grant = (
        grantId: string,
        requestId: string,
        scope: SurfaceAssetScope,
      ): SurfaceAssetGrant => ({
        v: 1,
        grantId,
        scope,
        surfacePrincipal: "surface-presence",
        requestId,
        kind: "asset-upload",
        payloadDigest: `sha256:${"f".repeat(64)}` as Digest,
        assets: [ref],
        issuedAt: current,
        expiry: "2026-07-25T01:00:00.000Z",
        signature: { alg: "test", keyId: "owner", sig: "test" },
      });
      await log.append([
        {
          stream: "control",
          body: {
            t: "asset-grant-issued",
            grant: grant(
              "grt-01J00000000000000000000005",
              "request-presence-a",
              firstScope,
            ),
          },
        },
        {
          stream: "control",
          body: {
            t: "asset-grant-issued",
            grant: grant(
              "grt-01J00000000000000000000006",
              "request-presence-b",
              secondScope,
            ),
          },
        },
      ]);
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      const firstScopeIdentity = canonicalize(firstScope);
      await lifecycle.recordTemporaryPresence(ref, firstScopeIdentity);
      await temporaryArtifacts.put(bytes);
      await lifecycle.settleTemporaryPresence(ref, firstScopeIdentity, true);
      const persistedScopes: string[] = [];
      await temporaryPresence(root).visitScopes(ref, (scopeIdentity) => {
        persistedScopes.push(scopeIdentity);
      });
      expect(persistedScopes).toEqual([firstScopeIdentity]);

      current = "2026-07-25T02:00:00.000Z";
      await log.append([
        {
          stream: "control",
          body: { t: "authority-time-frontier", frontier: current },
        },
      ]);
      await rm(path.join(root, "derived", "artifact-lifecycle"), {
        recursive: true,
        force: true,
      });
      await expect(temporaryPresence(root).has(ref)).resolves.toBe(true);
      const reopened = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });

      await expect(
        reopened.activeGrant("grt-01J00000000000000000000005"),
      ).resolves.toBeUndefined();
      await expect(
        reopened.activeGrant("grt-01J00000000000000000000006"),
      ).resolves.toBeUndefined();
      await expect(reopened.quotaSnapshot(firstScope, [ref])).resolves.toEqual({
        scopeBytes: 17,
        deviceBytes: 17,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: true,
            deviceCounted: true,
            retained: false,
          },
        ],
      });
      await expect(reopened.quotaSnapshot(secondScope, [ref])).resolves.toEqual({
        scopeBytes: 0,
        deviceBytes: 17,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: false,
            deviceCounted: true,
            retained: false,
          },
        ],
      });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps active grants and distinct-digest quota in bounded durable indexes",
    async () => {
      const root = await createTempDir("artifact-grant-lifecycle");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      let current = "2026-07-25T00:00:00.000Z";
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => current,
      });
      const ref = await artifacts.put(Buffer.alloc(17, 1));
      const scope: SurfaceAssetScope = {
        domain: "conversation",
        conversationId: "conversation-quota",
        ownerEpoch: 1,
      };
      const grant = (grantId: string, requestId: string): SurfaceAssetGrant => ({
        v: 1,
        grantId,
        scope,
        surfacePrincipal: "surface-quota",
        requestId,
        kind: "asset-upload",
        payloadDigest: `sha256:${"b".repeat(64)}` as Digest,
        assets: [ref],
        issuedAt: "2026-07-25T00:00:00.000Z",
        expiry: "2026-07-25T01:00:00.000Z",
        signature: { alg: "test", keyId: "owner", sig: "test" },
      });
      const first = grant("grt-01J00000000000000000000001", "request-1");
      const second = grant("grt-01J00000000000000000000002", "request-2");
      await log.append([
        { stream: "control", body: { t: "asset-grant-issued", grant: first } },
        { stream: "control", body: { t: "asset-grant-issued", grant: second } },
      ]);
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });

      await expect(lifecycle.activeGrant(first.grantId)).resolves.toEqual(first);
      await expect(
        lifecycle.activeConversationGrants("conversation-quota", 8),
      ).resolves.toHaveLength(2);
      await expect(lifecycle.quotaSnapshot(scope, [ref])).resolves.toEqual({
        scopeBytes: 17,
        deviceBytes: 17,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: true,
            deviceCounted: true,
            retained: false,
          },
        ],
      });

      await log.append([
        {
          stream: "run:conversation-quota",
          body: {
            t: "admitted",
            attachments: [{ ...ref, kind: "file" }],
          },
        },
      ]);
      await expect(lifecycle.quotaSnapshot(scope, [ref])).resolves.toEqual({
        scopeBytes: 0,
        deviceBytes: 0,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: false,
            deviceCounted: false,
            retained: true,
          },
        ],
      });

      current = "2026-07-25T00:30:00.000Z";
      await log.append([
        {
          stream: "run:conversation-quota",
          body: { t: "session-lifecycle", mutation: "delete" },
        },
      ]);
      await expect(lifecycle.quotaSnapshot(scope, [ref])).resolves.toEqual({
        scopeBytes: 17,
        deviceBytes: 17,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: true,
            deviceCounted: true,
            retained: false,
          },
        ],
      });

      current = "2026-07-25T01:00:00.000Z";
      await log.append([
        {
          stream: "control",
          body: { t: "authority-time-frontier", frontier: current },
        },
      ]);
      await expect(lifecycle.nextGrantExpiry()).resolves.toBeUndefined();
      await expect(lifecycle.quotaSnapshot(scope, [ref])).resolves.toEqual({
        scopeBytes: 0,
        deviceBytes: 0,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: false,
            deviceCounted: false,
            retained: false,
          },
        ],
      });
      await lifecycle.recordTemporaryPresence(ref, canonicalize(scope));
      await lifecycle.settleTemporaryPresence(ref, canonicalize(scope), true);
      await expect(
        lifecycle.temporaryBefore("2026-07-25T01:00:00.000Z", 8),
      ).resolves.toEqual([
        {
          ref,
          eligibleAt: "2026-07-25T01:00:00.000Z",
        },
      ]);
      await expect(lifecycle.quotaSnapshot(scope, [ref])).resolves.toEqual({
        scopeBytes: 17,
        deviceBytes: 17,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: true,
            deviceCounted: true,
            retained: false,
          },
        ],
      });
      await lifecycle.markTemporaryRemoved(ref);
      await expect(lifecycle.quotaSnapshot(scope, [ref])).resolves.toEqual({
        scopeBytes: 0,
        deviceBytes: 0,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: false,
            deviceCounted: false,
            retained: false,
          },
        ],
      });
      await expect(
        lifecycle.temporaryBefore("2026-07-25T01:00:00.000Z", 8),
      ).resolves.toEqual([]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "removes selected presence markers idempotently",
    async () => {
      const root = await createTempDir("artifact-temporary-marker-removal");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const ref = await artifacts.put(Buffer.from("marker-removal"));
      const presence = temporaryPresence(root);
      await presence.mark(ref, "scope-a");
      await presence.mark(ref, "scope-a");
      await presence.mark(ref, "scope-b");
      const retryStaging = temporaryPresenceStagingPath(
        presence,
        ref,
        "scope-c",
      );
      await writeFile(retryStaging, "stale");
      await presence.mark(ref, "scope-c");
      await expect(access(retryStaging)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const recoveryStaging = temporaryPresenceStagingPath(
        presence,
        ref,
        "scope-d",
      );
      await writeFile(recoveryStaging, "stale");
      await presence.removeScopes(ref, ["scope-d"]);
      await expect(access(recoveryStaging)).rejects.toMatchObject({
        code: "ENOENT",
      });

      await presence.removeScopes(ref, ["scope-a"]);
      await presence.removeScopes(ref, ["scope-a"]);
      const remaining: string[] = [];
      await presence.visitScopes(ref, (scopeIdentity) => {
        remaining.push(scopeIdentity);
      });
      expect(remaining.sort()).toEqual(["scope-b", "scope-c"]);

      await presence.removeScopes(ref, ["scope-b", "scope-c"]);
      await presence.removeScopes(ref, ["scope-b"]);
      await expect(presence.has(ref)).resolves.toBe(false);

      await presence.mark(ref, "scope-c");
      await presence.remove(ref);
      await presence.remove(ref);
      await expect(presence.has(ref)).resolves.toBe(false);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "removes staging-only files while rebuilding without derived intent",
    async () => {
      const root = await createTempDir("artifact-staging-rebuild");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const presence = temporaryPresence(root);
      const ref = { digest: byteDigest(Buffer.alloc(0)), bytes: 0 };
      const staging = temporaryPresenceStagingPath(
        presence,
        ref,
        "scope-without-intent",
      );
      await mkdir(path.dirname(staging), { recursive: true });
      await writeFile(staging, "orphaned staging");
      const interruptedRef = {
        digest: byteDigest(Buffer.from("interrupted-staging")),
        bytes: Buffer.byteLength("interrupted-staging"),
      };
      const interruptedStaging = temporaryPresenceStagingPath(
        presence,
        interruptedRef,
        "scope-interrupted-after-unlink",
      );
      const interruptedDirectory = path.dirname(interruptedStaging);
      await mkdir(interruptedDirectory, { recursive: true });
      await writeFile(interruptedStaging, "already unlinked");
      await rm(interruptedStaging);
      const log = new FileAuthorityCommitLog(
        path.join(root, "log"),
        artifacts,
      );
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: presence,
        receiver,
      });

      await expect(lifecycle.synchronize()).resolves.toBeUndefined();
      await expect(access(staging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(interruptedDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "reacquires governed capacity between bounded physical reconciliation pages",
    async () => {
      const root = await createTempDir("artifact-bounded-reconciliation");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const basePolicy = createDefaultDeviceCapacityPolicy();
      const delegate = new DefaultStorageMaintenanceGovernor({
        capacity: new DefaultDeviceCapacityArbiter({
          policy: basePolicy,
          probe: () => ({
            cpuBusyRatio: 0,
            availableMemoryBytes: 1024 * 1024 * 1024,
            processRssBytes: 0,
            temporaryBytesAvailable: 8 * 1024 * 1024 * 1024,
          }),
        }),
      });
      const admissions: StorageMaintenanceKind[] = [];
      const storageMaintenance = {
        acquire: async (
          ...args: Parameters<typeof delegate.acquire>
        ) => {
          admissions.push(args[0].kind);
          return delegate.acquire(...args);
        },
        snapshot: () => delegate.snapshot(),
      };
      // 容量由真正做物理删除的 presence 叶步骤自取,对账区段不再整段持有 permit。
      const presence = temporaryPresence(root, { storageMaintenance });
      for (let index = 0; index < 66; index += 1) {
        const bytes = Buffer.from(`staging-${index}`);
        const ref = { digest: byteDigest(bytes), bytes: bytes.byteLength };
        const staging = temporaryPresenceStagingPath(
          presence,
          ref,
          `scope-${index}`,
        );
        await mkdir(path.dirname(staging), { recursive: true });
        await writeFile(staging, bytes);
      }
      const log = new FileAuthorityCommitLog(
        path.join(root, "log"),
        artifacts,
      );
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: presence,
        receiver,
        storageMaintenance,
      });

      await lifecycle.synchronize();

      expect(
        admissions.filter((kind) => kind === "lifecycle-reconcile").length,
      ).toBeGreaterThan(3);
      await expect(readdir(presence.rootDir)).resolves.toEqual([]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "resumes legacy scope migration after a page failure and index rebuild",
    async () => {
      const root = await createTempDir("artifact-legacy-scope-migration");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const presence = new MemoryTemporaryPresenceStore();
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => "2026-07-25T00:00:00.000Z",
      });
      const ref = await temporaryArtifacts.put(Buffer.from([1]));
      const scopes = Array.from(
        { length: 65 },
        (_, index): SurfaceAssetScope => ({
          domain: "conversation",
          conversationId: `conversation-legacy-${index}`,
          ownerEpoch: 1,
        }),
      );
      await log.append(scopes.map((scope, index) => ({
        stream: "control",
        body: {
          t: "asset-grant-issued" as const,
          grant: {
            v: 1,
            grantId: `grt-01K${index.toString().padStart(23, "0")}`,
            scope,
            surfacePrincipal: "surface-legacy",
            requestId: `request-legacy-${index}`,
            kind: "asset-upload" as const,
            payloadDigest: byteDigest(Buffer.from(`legacy-${index}`)),
            assets: [ref],
            issuedAt: "2026-07-25T00:00:00.000Z",
            expiry: "2026-07-25T01:00:00.000Z",
            signature: { alg: "test", keyId: "owner", sig: "test" },
          },
        },
      })));
      presence.failOnMark = 65;
      const derivedRoot = path.join(root, "derived");
      const first = new ArtifactLifecycleIndex({
        rootDir: derivedRoot,
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: presence,
        receiver,
      });
      await expect(first.synchronize()).rejects.toThrow(
        "injected presence write failure",
      );
      expect(presence.scopes.get(ref.digest)?.values.size).toBe(64);

      presence.failOnMark = undefined;
      presence.markCalls = 0;
      await rm(path.join(derivedRoot, "artifact-lifecycle"), {
        recursive: true,
        force: true,
      });
      const reopened = new ArtifactLifecycleIndex({
        rootDir: derivedRoot,
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: presence,
        receiver,
      });
      await expect(reopened.synchronize()).resolves.toBeUndefined();
      expect(presence.scopes.get(ref.digest)?.values.size).toBe(65);
      await expect(
        reopened.quotaSnapshot(scopes[64]!, [ref]),
      ).resolves.toMatchObject({ scopeBytes: 1, deviceBytes: 1 });
      expect(presence.migrations).toEqual(new Set());
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it.each([64, 65])(
    "round-trips exclusive adoption cursors across %i upload scopes",
    async (scopeCount) => {
      const root = await createTempDir(
        `artifact-adoption-exclusive-${scopeCount}`,
      );
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const presence = new MemoryTemporaryPresenceStore();
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => "2026-07-25T00:00:00.000Z",
      });
      const bytes = Buffer.from("adoption-pagination");
      const ref = await temporaryArtifacts.put(bytes);
      const scopes = Array.from(
        { length: scopeCount },
        (_, index): SurfaceAssetScope => ({
          domain: "conversation",
          conversationId: `conversation-adoption-${scopeCount}-${index}`,
          ownerEpoch: 1,
        }),
      );
      await log.append(scopes.map((scope, index) => ({
        stream: "control",
        body: {
          t: "asset-grant-issued" as const,
          grant: {
            v: 1,
            grantId: `grt-01K${index.toString().padStart(23, "0")}`,
            scope,
            surfacePrincipal: "surface-adoption",
            requestId: `request-adoption-${scopeCount}-${index}`,
            kind: "asset-upload" as const,
            payloadDigest: byteDigest(
              Buffer.from(`adoption-${scopeCount}-${index}`),
            ),
            assets: [ref],
            issuedAt: "2026-07-25T00:00:00.000Z",
            expiry: "2026-07-25T01:00:00.000Z",
            signature: { alg: "test", keyId: "owner", sig: "test" },
          },
        },
      })));
      const derivedRoot = path.join(root, "derived");
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: derivedRoot,
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: presence,
        receiver,
      });
      await lifecycle.synchronize();
      expect(presence.scopes.get(ref.digest)?.values.size).toBe(scopeCount);

      await artifacts.put(bytes);
      await log.append([
        {
          stream: "run:conversation-adopter",
          body: {
            t: "admitted",
            attachments: [{ ...ref, kind: "file" }],
          },
        },
      ]);
      await expect(lifecycle.synchronize()).resolves.toBeUndefined();
      await expect(presence.has(ref)).resolves.toBe(true);
      await expect(lifecycle.adoptedTemporary(8)).resolves.toEqual([ref]);
      await expect(
        lifecycle.quotaSnapshot(scopes.at(-1)!, [ref]),
      ).resolves.toEqual({
        scopeBytes: 0,
        deviceBytes: 0,
        memberships: [
          {
            digest: ref.digest,
            scopeCounted: false,
            deviceCounted: false,
            retained: true,
          },
        ],
      });

      const reopened = new ArtifactLifecycleIndex({
        rootDir: derivedRoot,
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: presence,
        receiver,
      });
      await expect(
        reopened.quotaSnapshot(scopes[0]!, [ref]),
      ).resolves.toMatchObject({
        scopeBytes: 0,
        deviceBytes: 0,
      });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "removes temporary scope accounting in fixed pages",
    async () => {
      const root = await createTempDir("artifact-temporary-removal-pages");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const presence = new MemoryTemporaryPresenceStore();
      let current = "2026-07-25T00:00:00.000Z";
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
        clock: () => current,
      });
      const ref = await artifacts.put(Buffer.from([1]));
      const scopes = Array.from(
        { length: 65 },
        (_, index): SurfaceAssetScope => ({
          domain: "conversation",
          conversationId: `conversation-page-${index}`,
          ownerEpoch: 1,
        }),
      );
      const grants = scopes.map(
        (scope, index): SurfaceAssetGrant => ({
          v: 1,
          grantId: `grt-01J${index.toString().padStart(23, "0")}`,
          scope,
          surfacePrincipal: "surface-page",
          requestId: `request-page-${index}`,
          kind: "asset-upload",
          payloadDigest: byteDigest(Buffer.from(`payload-${index}`)),
          assets: [ref],
          issuedAt: current,
          expiry: "2026-07-25T01:00:00.000Z",
          signature: { alg: "test", keyId: "owner", sig: "test" },
        }),
      );
      await log.append(
        grants.map((grant) => ({
          stream: "control",
          body: { t: "asset-grant-issued" as const, grant },
        })),
      );
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: presence,
        receiver,
      });
      for (const scope of scopes) {
        const scopeIdentity = canonicalize(scope);
        await presence.mark(ref, scopeIdentity);
        await lifecycle.settleTemporaryPresence(ref, scopeIdentity, true);
      }
      current = "2026-07-25T01:00:00.000Z";
      await log.append([
        {
          stream: "control",
          body: { t: "authority-time-frontier", frontier: current },
        },
      ]);

      await expect(lifecycle.markTemporaryRemoved(ref)).resolves.toBe(false);
      expect(presence.removedBatches.at(-1)).toHaveLength(64);
      await expect(presence.has(ref)).resolves.toBe(true);
      await expect(lifecycle.markTemporaryRemoved(ref)).resolves.toBe(true);
      expect(presence.removedBatches.at(-1)).toHaveLength(1);
      await expect(presence.has(ref)).resolves.toBe(false);
      await expect(
        lifecycle.temporaryBefore("2026-07-25T02:00:00.000Z", 8),
      ).resolves.toEqual([]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the same reconcile identity after the first source page advances",
    async () => {
      const root = await createTempDir("lifecycle-progress-coalesce");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(
        path.join(root, "temporary"),
      );
      const receiver = new FileResumableArtifactReceiver(
        temporaryArtifacts,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const commits = Array.from(
        { length: 65 },
        (_, index): CommitEnvelope<JsonValue> => ({
          lsn: index + 1,
          at: "2026-07-25T00:00:00.000Z",
          entries: [],
          envelopeDigest: `sha256:${(index + 1)
            .toString(16)
            .padStart(64, "0")}` as Digest,
        }),
      );
      const checkpoint = (lsn: number): DurableLogCheckpoint => ({
        logId: "lifecycle-progress-log",
        lsn,
        frameEndOffset: lsn,
        prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}` as Digest,
      });
      const releaseSecondPage = deferred<void>();
      let reads = 0;
      const readTail = vi.fn(
        async (current: DurableLogCheckpoint, limit: number) => {
          const page = commits.slice(current.lsn, current.lsn + limit);
          const nextLsn = page.at(-1)?.lsn ?? current.lsn;
          reads += 1;
          if (reads === 2) await releaseSecondPage.promise;
          return {
            commits: page,
            checkpoint: checkpoint(nextLsn),
            hasMore: nextLsn < commits.length,
          };
        },
      );
      const log = {
        originCheckpoint: async () => checkpoint(0),
        checkpoint: async () => checkpoint(commits.length),
        readTail,
        stopStorageMaintenance: () => undefined,
      } as unknown as FileAuthorityCommitLog;
      const requests: StorageMaintenanceRequest[] = [];
      const storageMaintenance: StorageMaintenanceGovernorPort = {
        acquire: async (request) => {
          requests.push(request);
          return {
            kind: "granted",
            permit: {
              granted: {
                occupancy: {
                  memoryReservationBytes: 0,
                  temporaryBytes: 0,
                  slots: 1,
                },
                quantum: {
                  readBytes: Number.MAX_SAFE_INTEGER,
                  writeBytes: Number.MAX_SAFE_INTEGER,
                  ioOperations: Number.MAX_SAFE_INTEGER,
                },
              },
              tryBegin: () => ({
                claim: () => undefined,
                complete: () => undefined,
              }),
              release: () => undefined,
            },
          };
        },
        snapshot: () => ({ queued: {}, inFlight: {} }),
      };
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root, { storageMaintenance }),
        receiver,
        storageMaintenance,
        maintenanceResourceId: artifacts.rootDir,
      });
      const runTask = vi.spyOn(StorageMaintenanceTaskRunner.prototype, "run");
      const background = runInMaintenanceContext("background", () =>
        lifecycle.synchronize()
      );
      await vi.waitFor(() => expect(reads).toBe(2), { timeout: 10_000 });
      const firstRequestAfterRelease = requests.length;
      const foreground = runInMaintenanceContext("foreground", () =>
        lifecycle.synchronize()
      );
      await vi.waitFor(
        () =>
          expect(
            runTask.mock.calls.filter(
              ([request]) => request.kind === "lifecycle-reconcile",
            ),
          ).toHaveLength(2),
        { timeout: 10_000 },
      );
      releaseSecondPage.resolve();
      await Promise.all([background, foreground]);
      runTask.mockRestore();

      // 第二次触发发生在派生 checkpoint 已推进之后，但源日志头未变：它必须
      // 加入原义务并把后续叶步骤提级，而不是用变化中的派生游标裂出新任务。
      expect(requests.length).toBeGreaterThan(firstRequestAfterRelease);
      expect(
        requests
          .slice(firstRequestAfterRelease)
          .every((request) => request.urgency === "foreground"),
      ).toBe(true);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "catches up the source tail without draining a retirement backlog",
    async () => {
      const work: Record<number, { readonly catchUp: number; readonly drain: number }> = {};
      for (const owners of [4, 16]) {
        const root = await createTempDir(`artifact-lifecycle-catch-up-${owners}`);
        const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
        const temporaryArtifacts = new FileArtifactStore(path.join(root, "temporary"));
        const receiver = new FileResumableArtifactReceiver(
          temporaryArtifacts,
          path.join(root, "partials"),
          { maxArtifactBytes: 1_024 },
        );
        const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
          clock: () => "2026-07-25T00:00:00.000Z",
        });
        const createIndex = () => new ArtifactLifecycleIndex({
          rootDir: path.join(root, "derived"),
          logs: [log],
          artifacts,
          temporaryArtifacts,
          temporaryPresence: temporaryPresence(root),
          receiver,
          ownsSourceLogs: false,
        });
        for (let index = 0; index < owners; index += 1) {
          const ref = await artifacts.put(Buffer.from(`owned leaf ${index}`, "utf8"));
          await log.append([{ stream: `run:conv-${index}`, body: { t: "admitted", attachments: [{ ...ref, kind: "file" }] } }]);
        }
        for (let index = 0; index < owners; index += 1) {
          await log.append([{ stream: `run:conv-${index}`, body: { t: "session-lifecycle", mutation: "delete" } }]);
        }
        // 第一个实例追平到 head 并只写检查点：死亡会话已登记为退休任务，尚未排空
        const first = createIndex();
        await first.catchUp();
        await first.checkpoint();
        await first.stopStorageMaintenance();
        const second = createIndex();
        const readTail = vi.spyOn(FileAuthorityCommitLog.prototype, "readTail");
        const get = vi.spyOn(FileDurableProjectionIndex.prototype, "get");
        const scan = vi.spyOn(FileDurableProjectionIndex.prototype, "scan");
        const reads = () => [get, scan].reduce((total, spy) => total +
          spy.mock.contexts.filter((index) => (index as FileDurableProjectionIndex).projectionId === "artifact-lifecycle").length, 0);
        try {
          await second.catchUp();
          // 前提：冷开时源尾为空，只剩退休积压
          expect(readTail).not.toHaveBeenCalled();
          const catchUp = reads();
          get.mockClear();
          scan.mockClear();
          await second.synchronize();
          work[owners] = { catchUp, drain: reads() };
          // 排空之后这些叶子都已释放
          expect(await second.releasedBefore("2026-07-25T01:00:00.000Z", 64)).toHaveLength(owners);
        } finally {
          readTail.mockRestore();
          get.mockRestore();
          scan.mockRestore();
          await second.stopStorageMaintenance();
          await log.stopStorageMaintenance();
        }
      }
      expect(work[16]!.catchUp).toBe(work[4]!.catchUp);
      expect(work[16]!.drain).toBeGreaterThan(work[4]!.drain);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds onto an installed prefix without blocking new writes",
    async () => {
      const clock = { clock: () => "2026-07-25T00:00:00.000Z" };
      const root = await createTempDir("artifact-lifecycle-installed-prefix");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(path.join(root, "temporary"));
      const receiver = new FileResumableArtifactReceiver(temporaryArtifacts, path.join(root, "partials"), { maxArtifactBytes: 1_024 });
      const source = new FileAuthorityCommitLog(path.join(root, "source"), artifacts, clock);
      await source.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T00:00:00.000Z" } }]);
      const sourceHead = await source.checkpoint();
      const records = await source.readAll();
      const target = new FileAuthorityCommitLog(path.join(root, "target"), artifacts, clock);
      for (let index = 0; index < 300; index += 1) {
        await target.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T00:00:00.000Z" } }]);
      }
      const createIndex = () => new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [target],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
        ownsSourceLogs: false,
      });
      const index = createIndex();
      const registered = vi.spyOn(FileAuthorityCommitLog.prototype, "registerTailConsumer");
      const unregister = index.registerTailAdmission();
      const consumer = registered.mock.calls[0]![0];
      registered.mockRestore();
      try {
        await index.catchUp();
        await index.checkpoint();
        expect(consumer.rebuilding?.()).toBe(false);
        // 迁居装入新前缀：logId 不变、内容整段替换，旧检查点（lsn 300）超出新 head
        await target.installPlannedAnchorPrefix({
          source: (async function* () { yield* records; })(),
          sourceHead,
          installationEntries: [{ stream: "job:installation", body: { installed: true } }],
          candidateReferences: [],
        });
        expect((await target.checkpoint()).lsn).toBeLessThan(300);
        // 安装即通知：未追尾前就处于重建，新写入不按硬界等它，重建由刷新在后台推进
        expect(consumer.rebuilding?.()).toBe(true);
        // 重建期间新写入不被挡
        for (let write = 0; write < 5; write += 1) {
          await target.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T00:00:00.000Z" } }]);
        }
        const head = await target.checkpoint();
        await index.catchUp();
        expect((await index.checkpointRetentionSnapshot()).sourceHeads[head.logId]).toEqual(head);
        expect(consumer.rebuilding?.()).toBe(false);
      } finally {
        unregister();
        await index.stopStorageMaintenance();
        await target.stopStorageMaintenance();
        await source.stopStorageMaintenance();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds from a stale manifest whose checkpoint lies beyond an installed shorter prefix",
    async () => {
      const clock = { clock: () => "2026-07-25T00:00:00.000Z" };
      const root = await createTempDir("artifact-lifecycle-stale-ahead");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(path.join(root, "temporary"));
      const receiver = new FileResumableArtifactReceiver(temporaryArtifacts, path.join(root, "partials"), { maxArtifactBytes: 1_024 });
      const source = new FileAuthorityCommitLog(path.join(root, "source"), artifacts, clock);
      await source.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T00:00:00.000Z" } }]);
      const sourceHead = await source.checkpoint();
      const records = await source.readAll();
      const target = new FileAuthorityCommitLog(path.join(root, "target"), artifacts, clock);
      for (let index = 0; index < 80; index += 1) {
        await target.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T00:00:00.000Z" } }]);
      }
      const createIndex = () => new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [target],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
        ownsSourceLogs: false,
      });
      try {
        // 没有登记为尾部消费者的实例：只把旧位置（lsn 80）落盘，收不到安装通知
        const first = createIndex();
        await first.catchUp();
        await first.checkpoint();
        await first.stopStorageMaintenance();
        await target.installPlannedAnchorPrefix({
          source: (async function* () { yield* records; })(),
          sourceHead,
          installationEntries: [{ stream: "job:installation", body: { installed: true } }],
          candidateReferences: [],
        });
        const head = await target.checkpoint();
        expect(head.lsn).toBeLessThan(80);
        // 打开时只看到旧清单：覆盖位置超出新 head，按派生损坏整段重建，而不是当成已追平跳过
        const second = createIndex();
        try {
          await second.catchUp();
          expect((await second.checkpointRetentionSnapshot()).sourceHeads[head.logId]).toEqual(head);
        } finally {
          await second.stopStorageMaintenance();
        }
      } finally {
        await target.stopStorageMaintenance();
        await source.stopStorageMaintenance();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "bounds the cold replay by publishing coverage before a legal large frame is admitted",
    async () => {
      const fixture = await durableTailFixture("artifact-lifecycle-durable-tail");
      const { log, index, consumer } = fixture;
      let coldLog: FileAuthorityCommitLog | undefined;
      let cold: ArtifactLifecycleIndex | undefined;
      try {
        await index.catchUp();
        for (let n = 0; n < 3; n += 1) {
          const before = await log.checkpoint();
          await log.append(largeFrame(n));
          // 内存已追平、尚未发布的上一帧：大帧只在它落盘发布之后接纳
          expect(consumer.coveredThrough(before.logId)).toEqual(before);
          await index.catchUp();
        }
        const head = await log.checkpoint();
        const maximum = maximumAuthorityRecoveryTailBytes();
        expect(head.frameEndOffset - consumer.coveredThrough(head.logId)!.frameEndOffset).toBeLessThanOrEqual(maximum);
        await fixture.close();
        // 冷重开实际回放的字节就是耐久欠账，不能因为上次运行已在内存追平就少算
        coldLog = fixture.createLog();
        cold = fixture.createIndex(coldLog);
        let replayed = 0;
        const readTail = coldLog.readTail.bind(coldLog);
        vi.spyOn(coldLog, "readTail").mockImplementation((async (from: DurableLogCheckpoint, ...rest: never[]) => {
          const page = await readTail(from, ...rest);
          replayed += page.checkpoint.frameEndOffset - from.frameEndOffset;
          return page;
        }) as never);
        await cold.catchUp();
        expect(replayed).toBeGreaterThan(0);
        expect(replayed).toBeLessThanOrEqual(maximum);
      } finally {
        await fixture.close();
        await cold?.stopStorageMaintenance();
        await coldLog?.stopStorageMaintenance();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "publishes coverage in the background once the durable tail passes the refresh threshold",
    async () => {
      const fixture = await durableTailFixture("artifact-lifecycle-refresh-publish");
      const { log, index, consumer } = fixture;
      fixture.enableRefresh();
      try {
        await index.catchUp();
        // 一帧即越过主动刷新阈值、未到硬界：提交不等它，随后由后台追平并落盘发布
        await log.append(largeFrame(0));
        const head = await log.checkpoint();
        await vi.waitFor(() => expect(consumer.coveredThrough(head.logId)).toEqual(head), { timeout: 30_000 });
      } finally {
        await fixture.close();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "refuses an over-budget append with backpressure while the lifecycle cannot publish its coverage",
    async () => {
      const fixture = await durableTailFixture("artifact-lifecycle-publish-failure");
      const { log, index, consumer } = fixture;
      const derivedRoot = fixture.derivedRoot;
      const flush = FileDurableProjectionIndex.prototype.flush;
      let failing = false;
      const injected = vi.spyOn(FileDurableProjectionIndex.prototype, "flush").mockImplementation(
        async function (this: FileDurableProjectionIndex, ...args: Parameters<typeof flush>) {
          if (failing && this.rootDir.startsWith(derivedRoot)) throw new Error("injected lifecycle publish failure");
          return flush.apply(this, args);
        },
      );
      try {
        await index.catchUp();
        await log.append(largeFrame(0));
        await index.catchUp();
        const head = await log.checkpoint();
        failing = true;
        const refused = log.append(largeFrame(1));
        await expect(refused).rejects.toBeInstanceOf(StorageMaintenanceAdmissionError);
        await expect(refused).rejects.toMatchObject({
          admission: { kind: "backpressured" },
          cause: { message: "injected lifecycle publish failure" },
        });
        // 追加没有提交，未发布的欠账也没有被当成已覆盖
        expect(await log.checkpoint()).toEqual(head);
        expect(consumer.coveredThrough(head.logId)!.lsn).toBeLessThan(head.lsn);
        failing = false;
        await expect(log.append(largeFrame(1))).resolves.toBeDefined();
        expect(consumer.coveredThrough(head.logId)).toEqual(head);
      } finally {
        injected.mockRestore();
        await fixture.close();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a peer's direct write and never regresses the published source vector when an unpublished catch-up meets it",
    async () => {
      const root = await createTempDir("artifact-lifecycle-interleaved-direct-write");
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const temporaryArtifacts = new FileArtifactStore(path.join(root, "temporary"));
      const receiver = new FileResumableArtifactReceiver(temporaryArtifacts, path.join(root, "partials"), { maxArtifactBytes: 1_024 });
      const current = "2026-07-25T00:00:00.000Z";
      const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { clock: () => current });
      const ref = await temporaryArtifacts.put(Buffer.from("interleaved upload", "utf8"));
      const grant: SurfaceAssetGrant = {
        v: 1,
        grantId: "grt-01J00000000000000000000007",
        scope: { domain: "conversation", conversationId: "conversation-interleaved", ownerEpoch: 1 },
        surfacePrincipal: "surface-interleaved",
        requestId: "request-interleaved",
        kind: "asset-upload",
        payloadDigest: byteDigest(Buffer.from("interleaved payload")),
        assets: [ref],
        issuedAt: current,
        expiry: "2026-07-25T01:00:00.000Z",
        signature: { alg: "test", keyId: "owner", sig: "test" },
      };
      await log.append([{ stream: "control", body: { t: "asset-grant-issued", grant } }]);
      const createIndex = () => new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
        ownsSourceLogs: false,
      });
      const frontier = () => log.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: current } }]);
      const local = createIndex();
      const registered = vi.spyOn(FileAuthorityCommitLog.prototype, "registerTailConsumer");
      const unregister = local.registerTailAdmission();
      const consumer = registered.mock.calls[0]![0];
      registered.mockRestore();
      const peer = createIndex();
      try {
        await consumer.publishCoverage();
        const logId = (await log.checkpoint()).logId;
        const published = [consumer.coveredThrough(logId)!];
        // 本实例把新尾部追到内存、未发布
        for (let n = 0; n < 8; n += 1) await frontier();
        await local.catchUp();
        const localMemory = await log.checkpoint();
        expect(consumer.coveredThrough(logId)).toEqual(published[0]);
        // 对方在写者锁内发布一条直写（上传在场意图）
        await peer.recordTemporaryPresence(ref, canonicalize(grant.scope));
        for (let n = 0; n < 8; n += 1) await frontier();
        // 本实例接着追尾并发布：采纳对方的新一代时作废自己未落盘的覆盖层，再从对方发布的位置追
        await consumer.publishCoverage();
        published.push(consumer.coveredThrough(logId)!);
        await consumer.publishCoverage();
        published.push(consumer.coveredThrough(logId)!);
        for (let n = 1; n < published.length; n += 1) {
          expect(published[n]!.lsn).toBeGreaterThanOrEqual(published[n - 1]!.lsn);
        }
        expect(published[1]!.lsn).toBeGreaterThanOrEqual(localMemory.lsn);
        expect(published.at(-1)).toEqual(await log.checkpoint());
        // 对方的直写没有被覆盖：意图排空后记为临时制品，在场标记与之一致地保留
        const reader = createIndex();
        try {
          await expect(reader.temporaryBefore("2026-07-25T02:00:00.000Z", 8))
            .resolves.toEqual([{ ref, eligibleAt: grant.expiry }]);
        } finally {
          await reader.stopStorageMaintenance();
        }
        await expect(temporaryPresence(root).has(ref)).resolves.toBe(true);
      } finally {
        unregister();
        await peer.stopStorageMaintenance();
        await local.stopStorageMaintenance();
        await log.stopStorageMaintenance();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "answers the first read from the adopted coverage when a peer publication discards a replayed page before its flush",
    async () => {
      const fixture = await peerInterleavingFixture("artifact-lifecycle-peer-read");
      const { log, local, peer, grantFor, gate } = fixture;
      const grant = grantFor(1, "2026-07-25T01:00:00.000Z");
      let pendingLocal: Promise<SurfaceAssetGrant | undefined> | undefined;
      let pendingPeer: Promise<void> | undefined;
      try {
        await log.append([{ stream: "control", body: { t: "asset-grant-issued", grant } }]);
        await local.maintainIdle();
        await peer.maintainIdle();
        // 对方已在旧源位置决定直写、持写者锁，停在发布前
        pendingPeer = gate.holdPeer(() => peer.recordTemporaryPresence(fixture.ref, canonicalize(grant.scope)));
        await gate.peerHeld();
        await expect(access(fixture.lockPath)).resolves.toBeUndefined();
        // 时间前沿越过到期：本实例把这页归约完，在本页落盘前停住（64 帧即触发按页落盘）
        fixture.setNow("2026-07-25T02:00:00.000Z");
        for (let n = 0; n < 64; n += 1) {
          await log.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T02:00:00.000Z", n } }]);
        }
        pendingLocal = gate.holdLocalAfterPrepare(() => local.activeGrant(grant.grantId, grant));
        await gate.localPrepared();
        // 对方发布旧源位置加直写；本实例落盘时采纳它、丢弃自己未落盘的这页
        gate.releasePeer();
        await pendingPeer;
        expect((await fixture.publishedCheckpoint()).lsn).toBe(1);
        gate.releaseLocal();
        // 第一次查询就按采纳后重新追平的状态作答，不靠下一次调用自愈
        await expect(pendingLocal).resolves.toBeUndefined();
        // 耐久向量从对方发布的位置单调推进到 head
        await local.maintainIdle();
        expect(await fixture.publishedCheckpoint()).toEqual(await log.checkpoint());
      } finally {
        gate.releaseAll();
        await Promise.allSettled([pendingLocal, pendingPeer]);
        await fixture.close();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "answers from the covered state when a peer publication is adopted between catch-up and the read",
    async () => {
      const fixture = await peerInterleavingFixture("artifact-lifecycle-peer-between");
      const { log, local, peer, grantFor, gate } = fixture;
      const grant = grantFor(1, "2026-07-25T01:00:00.000Z");
      let pendingPeer: Promise<void> | undefined;
      const catchUp = local.catchUp.bind(local);
      let adoptedBetween = false;
      const advanced = vi.spyOn(local, "catchUp").mockImplementation(async () => {
        await catchUp();
        if (adoptedBetween) return;
        adoptedBetween = true;
        // 追平之后、读取之前：对方发布旧源位置，本实例的检查点落盘随即采纳它、丢掉刚追平的未落盘页
        gate.releasePeer();
        await pendingPeer;
        await local.checkpoint();
        expect((await fixture.publishedCheckpoint()).lsn).toBe(1);
      });
      try {
        await log.append([{ stream: "control", body: { t: "asset-grant-issued", grant } }]);
        await local.maintainIdle();
        await peer.maintainIdle();
        pendingPeer = gate.holdPeer(() => peer.recordTemporaryPresence(fixture.ref, canonicalize(grant.scope)));
        await gate.peerHeld();
        // 不到一页的时间前沿越过到期：追平只进覆盖层、不落盘
        fixture.setNow("2026-07-25T02:00:00.000Z");
        for (let n = 0; n < 10; n += 1) {
          await log.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T02:00:00.000Z", n } }]);
        }
        await expect(local.activeGrant(grant.grantId, grant)).resolves.toBeUndefined();
        expect(adoptedBetween).toBe(true);
        expect(advanced.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        advanced.mockRestore();
        gate.releaseAll();
        await Promise.allSettled([pendingPeer]);
        await fixture.close();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "finishes publishing coverage at the head when a peer publication discards the page being flushed",
    async () => {
      const fixture = await peerInterleavingFixture("artifact-lifecycle-peer-publish");
      const { log, local, peer, grantFor, gate } = fixture;
      const grant = grantFor(1, "2026-07-26T00:00:00.000Z");
      const registered = vi.spyOn(FileAuthorityCommitLog.prototype, "registerTailConsumer");
      const unregister = local.registerTailAdmission();
      const consumer = registered.mock.calls[0]![0];
      registered.mockRestore();
      // 只看这一次调用自己的完成判定，不让提交后的后台刷新代为追平
      consumer.refresh = () => undefined;
      let pendingLocal: Promise<void> | undefined;
      let pendingPeer: Promise<void> | undefined;
      try {
        await log.append([{ stream: "control", body: { t: "asset-grant-issued", grant } }]);
        await local.maintainIdle();
        await peer.maintainIdle();
        pendingPeer = gate.holdPeer(() => peer.recordTemporaryPresence(fixture.ref, canonicalize(grant.scope)));
        await gate.peerHeld();
        for (let n = 0; n < 64; n += 1) {
          await log.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T00:00:00.000Z", n } }]);
        }
        pendingLocal = gate.holdLocalAfterPrepare(() => consumer.publishCoverage());
        await gate.localPrepared();
        gate.releasePeer();
        await pendingPeer;
        expect((await fixture.publishedCheckpoint()).lsn).toBe(1);
        gate.releaseLocal();
        await pendingLocal;
        const head = await log.checkpoint();
        expect(consumer.coveredThrough(head.logId)).toEqual(head);
      } finally {
        unregister();
        gate.releaseAll();
        await Promise.allSettled([pendingLocal, pendingPeer]);
        await fixture.close();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "restarts temporary reconciliation when a peer publication discards one of its records",
    async () => {
      const fixture = await peerInterleavingFixture("artifact-lifecycle-peer-reconcile");
      const { log, local, peer, grantFor, receiver } = fixture;
      const second = await fixture.temporaryArtifacts.put(Buffer.from("second reconciled upload", "utf8"));
      const grants = [grantFor(1, "2026-07-26T00:00:00.000Z"), { ...grantFor(2, "2026-07-26T00:00:00.000Z"), assets: [second] }];
      const progress = receiver.progress.bind(receiver);
      const secondEntered = deferred<void>();
      const secondRelease = deferred<void>();
      let reconciled = 0;
      const probed = vi.spyOn(receiver, "progress").mockImplementation(async (...args: Parameters<typeof progress>) => {
        reconciled += 1;
        if (reconciled === 2) {
          secondEntered.resolve();
          await secondRelease.promise;
        }
        return progress(...args);
      });
      let pendingLocal: Promise<void> | undefined;
      try {
        await log.append(grants.map((grant) => ({ stream: "control", body: { t: "asset-grant-issued", grant } })));
        // 上一版本留下的在场标记：首次同步要逐条对账，记成临时件
        await fixture.presence.mark(fixture.ref, canonicalize(grants[0]!.scope));
        await fixture.presence.mark(second, canonicalize(grants[1]!.scope));
        await peer.catchUp();
        // 本实例对账到第二条时停住；第一条已随提交落盘
        pendingLocal = local.synchronize();
        await secondEntered.promise;
        // 对方采纳本实例已发布的一代，再追平新尾部并发布：它不做对账，发布的一代里没有第二条
        await peer.checkpoint();
        await log.append([{ stream: "control", body: { t: "authority-time-frontier", frontier: "2026-07-25T00:00:00.000Z" } }]);
        await peer.catchUp();
        await peer.checkpoint();
        expect(await fixture.publishedCheckpoint()).toEqual(await log.checkpoint());
        // 第二条的提交在落盘时采纳对方这一代、随覆盖层被丢弃：对账必须重来，不能越过它
        secondRelease.resolve();
        await pendingLocal;
        const due = await local.temporaryBefore("2026-07-27T00:00:00.000Z", 8);
        expect(due.map(({ ref }) => ref.digest).sort()).toEqual([fixture.ref.digest, second.digest].sort());
      } finally {
        probed.mockRestore();
        secondRelease.resolve();
        await Promise.allSettled([pendingLocal]);
        await fixture.close();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "never publishes a replayed page decided on a base that a peer publication replaced while preparing it",
    async () => {
      const fixture = await peerInterleavingFixture("artifact-lifecycle-peer-base");
      const { log, local, peer, grantFor, gate } = fixture;
      const revoked = grantFor(1, "2026-07-26T00:00:00.000Z");
      let pendingPeer: Promise<void> | undefined;
      try {
        await log.append([{ stream: "control", body: { t: "asset-grant-issued", grant: revoked } }]);
        await local.maintainIdle();
        await peer.maintainIdle();
        pendingPeer = gate.holdPeer(() => peer.recordTemporaryPresence(fixture.ref, canonicalize(revoked.scope)));
        await gate.peerHeld();
        await expect(access(fixture.lockPath)).resolves.toBeUndefined();
        // 本实例把撤销归约进未落盘的覆盖层
        await log.append([{ stream: "control", body: { t: "asset-grant-revoked", grantId: revoked.grantId, reason: "surface-revoked" } }]);
        await expect(local.activeGrant(revoked.grantId, revoked)).resolves.toBeUndefined();
        expect((await fixture.publishedCheckpoint()).lsn).toBe(1);
        // 对方发布旧源位置加直写
        gate.releasePeer();
        await pendingPeer;
        // 下一页的增量超过覆盖层条数上限：准备时先落盘，落盘里采纳对方的新一代
        const fillers = Array.from({ length: 120 }, (_, index) => grantFor(index + 2, "2026-07-26T00:00:00.000Z"));
        await log.append(fillers.map((grant) => ({ stream: "control", body: { t: "asset-grant-issued", grant } })));
        await expect(local.activeGrant(revoked.grantId, revoked)).resolves.toBeUndefined();
        await expect(local.activeGrant(fillers[0]!.grantId, fillers[0])).resolves.toEqual(fillers[0]);
        // 落盘后冷开的实例同样看不到被撤销的 grant
        await local.maintainIdle();
        const cold = fixture.createIndex();
        try {
          await expect(cold.activeGrant(revoked.grantId, revoked)).resolves.toBeUndefined();
        } finally {
          await cold.stopStorageMaintenance();
        }
      } finally {
        gate.releaseAll();
        await Promise.allSettled([pendingPeer]);
        await fixture.close();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});

/**
 * 两个 lifecycle 实例共用一个源日志与派生目录，用真实文件锁与耐久文件；DPI 的 prepare 上设两个闸门，
 * 控制“对方持锁停在发布前”与“本实例准备好本页、停在发布前”的交错。只控制顺序，不改产品实现或已提交事实。
 */
async function peerInterleavingFixture(name: string) {
  const root = await createTempDir(name);
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const temporaryArtifacts = new FileArtifactStore(path.join(root, "temporary"));
  const receiver = new FileResumableArtifactReceiver(temporaryArtifacts, path.join(root, "partials"), { maxArtifactBytes: 1_024 });
  let now = "2026-07-25T00:00:00.000Z";
  const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
    clock: () => now,
    integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 73)),
  });
  const ref = await temporaryArtifacts.put(Buffer.from("peer interleaving upload", "utf8"));
  const derivedRoot = path.join(root, "derived");
  const createIndex = () => new ArtifactLifecycleIndex({
    rootDir: derivedRoot,
    logs: [log],
    artifacts,
    temporaryArtifacts,
    temporaryPresence: temporaryPresence(root),
    receiver,
    ownsSourceLogs: false,
  });
  const grantFor = (n: number, expiry: string): SurfaceAssetGrant => ({
    v: 1,
    grantId: `grt-01J${String(n).padStart(23, "0")}`,
    scope: { domain: "conversation", conversationId: `peer-${n}`, ownerEpoch: 1 },
    surfacePrincipal: "surface-peer",
    requestId: `request-${n}`,
    kind: "asset-upload",
    payloadDigest: byteDigest(Buffer.from(`payload-${n}`)),
    assets: [ref],
    issuedAt: now,
    expiry,
    signature: { alg: "test", keyId: "owner", sig: `sig-${n}` },
  });
  const local = createIndex();
  const peer = createIndex();
  const peerEntered = deferred<void>();
  const peerRelease = deferred<void>();
  const localPrepared = deferred<void>();
  const localRelease = deferred<void>();
  let role: "none" | "peer" | "local" = "none";
  let peerHeld = false;
  let localHeld = false;
  const prepare = FileDurableProjectionIndex.prototype.prepare;
  const spy = vi.spyOn(FileDurableProjectionIndex.prototype, "prepare").mockImplementation(
    async function (this: FileDurableProjectionIndex, ...args: Parameters<typeof prepare>) {
      const current = role;
      if (this.projectionId === "artifact-lifecycle" && current === "peer" && !peerHeld) {
        peerHeld = true;
        peerEntered.resolve();
        await peerRelease.promise;
      }
      const prepared = await prepare.apply(this, args);
      if (this.projectionId === "artifact-lifecycle" && current === "local" && !localHeld) {
        localHeld = true;
        localPrepared.resolve();
        await localRelease.promise;
      }
      return prepared;
    },
  );
  const gate = {
    holdPeer<T>(operation: () => Promise<T>): Promise<T> {
      role = "peer";
      return operation();
    },
    peerHeld: () => peerEntered.promise,
    releasePeer() {
      role = "none";
      peerRelease.resolve();
    },
    holdLocalAfterPrepare<T>(operation: () => Promise<T>): Promise<T> {
      role = "local";
      return operation();
    },
    localPrepared: () => localPrepared.promise,
    releaseLocal() {
      role = "none";
      localRelease.resolve();
    },
    releaseAll() {
      role = "none";
      peerRelease.resolve();
      localRelease.resolve();
    },
  };
  return {
    log,
    local,
    peer,
    ref,
    temporaryArtifacts,
    receiver,
    presence: temporaryPresence(root),
    gate,
    grantFor,
    createIndex,
    lockPath: path.join(derivedRoot, "artifact-lifecycle.lock"),
    setNow(next: string) {
      now = next;
    },
    async publishedCheckpoint(): Promise<DurableLogCheckpoint> {
      const manifest = JSON.parse(
        await readFile(path.join(derivedRoot, "artifact-lifecycle", "manifest.json"), "utf8"),
      ) as { readonly checkpoints: Readonly<Record<string, DurableLogCheckpoint>> };
      const head = await log.checkpoint();
      return manifest.checkpoints[head.logId]!;
    },
    async close() {
      spy.mockRestore();
      await peer.stopStorageMaintenance();
      await local.stopStorageMaintenance();
      await log.stopStorageMaintenance();
    },
  };
}

/** 每帧合法、单帧低于格式上限，但都超过硬界字节：只在先前欠账全部发布后接纳。 */
function largeFrame(n: number) {
  const padding = "x".repeat(24 * 1_024);
  return Array.from({ length: 400 }, (_, entry) => ({
    stream: "control",
    body: { t: "authority-time-frontier", frontier: "2026-10-26T00:00:00.000Z", padding, n, entry },
  }));
}

/**
 * 认证日志与登记了尾部准入的 lifecycle。默认停掉提交后的后台刷新，只留追加前的硬界准入，免得刷新
 * 碰巧先发布而掩盖准入缺陷；锁外准备次数有上限，准入不收敛时立即失败而不是空转到超时。
 */
async function durableTailFixture(name: string) {
  const root = await createTempDir(name);
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const temporaryArtifacts = new FileArtifactStore(path.join(root, "temporary"));
  const receiver = new FileResumableArtifactReceiver(temporaryArtifacts, path.join(root, "partials"), { maxArtifactBytes: 1_024 });
  const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 71));
  const derivedRoot = path.join(root, "derived");
  const createLog = () => new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { integrity });
  const createIndex = (log: FileAuthorityCommitLog) => new ArtifactLifecycleIndex({
    rootDir: derivedRoot,
    logs: [log],
    artifacts,
    temporaryArtifacts,
    temporaryPresence: temporaryPresence(root),
    receiver,
    ownsSourceLogs: false,
  });
  const log = createLog();
  const index = createIndex(log);
  const registered = vi.spyOn(FileAuthorityCommitLog.prototype, "registerTailConsumer");
  const unregister = index.registerTailAdmission();
  const consumer = registered.mock.calls[0]![0];
  registered.mockRestore();
  const publish = consumer.publishCoverage;
  let preparations = 0;
  consumer.publishCoverage = () => {
    preparations += 1;
    if (preparations > 8) return Promise.reject(new Error("Tail admission did not converge"));
    return publish();
  };
  const refresh = consumer.refresh;
  consumer.refresh = () => undefined;
  let closed = false;
  return {
    log,
    index,
    consumer,
    derivedRoot,
    createLog,
    createIndex,
    enableRefresh() {
      consumer.refresh = refresh;
    },
    async close() {
      if (closed) return;
      closed = true;
      unregister();
      await index.stopStorageMaintenance();
      await log.stopStorageMaintenance();
    },
  };
}
