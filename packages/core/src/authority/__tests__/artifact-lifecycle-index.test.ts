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
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  runInMaintenanceContext,
  StorageMaintenanceTaskRunner,
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

// 重 IO 组级预算:本机(低资源 Windows)上单条耐久用例真实耗时可达 20-30 秒,
// 30 秒档会被临界抖动随机击穿;对齐 runbook 已验证的 120 秒档,断言失败仍立即终止。
const DURABLE_IO_TEST_TIMEOUT_MS = 120_000;

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
      } as unknown as FileAuthorityCommitLog;
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });

      await expect(lifecycle.synchronize()).resolves.toBeUndefined();
      expect(readTail.mock.calls.map(([cursor]) => cursor.lsn)).toEqual([
        0, 64, 128, 192, 256,
      ]);
      expect(readTail.mock.calls.map(([, limit]) => limit)).toEqual([
        64, 64, 64, 64, 1,
      ]);
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
      const createIndex = () =>
        new ArtifactLifecycleIndex({
          rootDir: derivedRoot,
          logs: [log],
          artifacts,
          temporaryArtifacts,
          temporaryPresence: temporaryPresence(root),
          receiver,
        });
      await expect(createIndex().activeGrant(first.grantId)).resolves.toEqual(
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
        await expect(check.inspect(createIndex())).resolves.toEqual(
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
        createIndex().activeGrant(first.grantId, first),
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
          artifacts,
          temporaryArtifacts,
          temporaryPresence: temporaryPresence(root),
          receiver,
        });
      const scopeIdentity = canonicalize(grant.scope);
      const lifecycle = createIndex();
      await lifecycle.recordTemporaryPresence(ref, scopeIdentity);
      await lifecycle.settleTemporaryPresence(ref, scopeIdentity, true);
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
        createIndex().temporaryBefore("2026-07-25T02:00:00.000Z", 8),
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
      await expect(createIndex().synchronize()).resolves.toBeUndefined();

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
      await expect(createIndex().synchronize()).resolves.toBeUndefined();
      const cleanupKey = `temporary/cleanup/${hex}`;
      await replaceLifecycleProjectionValue(
        derivedRoot,
        log,
        cleanupKey,
        { key: cleanupKey, digest: wrongDigest },
      );
      await expect(createIndex().adoptedTemporary(8)).resolves.toEqual([ref]);

      current = "2026-07-25T00:30:00.000Z";
      await log.append([
        {
          stream: "run:conversation-secondary",
          body: { t: "session-lifecycle", mutation: "delete" },
        },
      ]);
      const [release] = await createIndex().releasedBefore(
        "2026-07-25T02:00:00.000Z",
        8,
      );
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
        createIndex().releasedBefore("2026-07-25T02:00:00.000Z", 8),
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
      const lifecycle = new ArtifactLifecycleIndex({
        rootDir: path.join(root, "derived"),
        logs: [log],
        artifacts,
        temporaryArtifacts,
        temporaryPresence: temporaryPresence(root),
        receiver,
      });
      await lifecycle.synchronize();
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
          policy: {
            ...basePolicy,
            quantum: {
              readBytes: 1024 * 1024 * 1024,
              writeBytes: 1024 * 1024 * 1024,
              ioOperations: 1_000_000,
            },
            quantumRefillPerSecond: {
              readBytes: 1024 * 1024 * 1024,
              writeBytes: 1024 * 1024 * 1024,
              ioOperations: 1_000_000,
            },
          },
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
});
