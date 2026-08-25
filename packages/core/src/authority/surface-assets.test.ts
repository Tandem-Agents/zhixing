import { Buffer } from "node:buffer";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  runInMaintenanceContext,
  StorageMaintenanceAdmissionError,
} from "../resources/index.js";
import type {
  ControlRecord,
  Digest,
  SurfaceAssetGrant,
  SurfaceAssetScope,
} from "../contracts/index.js";
import {
  byteDigest,
  canonicalize,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "../protocol/index.js";
import {
  DEFAULT_ARTIFACT_CHUNK_BYTES,
  FileResumableArtifactReceiver,
} from "./assignment-artifacts.js";
import { FileArtifactStore } from "./artifact-store.js";
import {
  SurfaceAssetCoordinator,
  surfaceAssetRequestKey,
  type SurfaceAssetCoordinatorOptions,
  type SurfaceAssetGrantLedger,
  type SurfaceAssetGrantIssueRequest,
} from "./surface-assets.js";

const payloadDigest = `sha256:${"a".repeat(64)}` as Digest;
// 重 IO 组级预算:本机上单条耐久用例真实耗时可达 20-30 秒,30 秒档会被临界
// 抖动随机击穿;对齐 runbook 已验证的 120 秒档,断言失败仍立即终止。
const DURABLE_IO_TEST_TIMEOUT_MS = 120_000;
const scope: SurfaceAssetScope = {
  domain: "conversation",
  conversationId: "conversation-1",
  ownerEpoch: 1,
};

const signer: ProtocolSigner = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "owner-key",
      sig: protocolDigest("TestSignature", 1, {
        schemaId,
        version,
        payload,
      }),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

class MemoryLedger implements SurfaceAssetGrantLedger {
  readonly records: Array<
    Extract<
      ControlRecord,
      {
        t:
          | "asset-grant-issued"
          | "asset-grant-revoked"
          | "authority-time-frontier";
      }
    >
  > = [];
  failAfterAppendOnce = false;
  failSynchronizeOnce = false;
  synchronizeCalls = 0;
  readonly #temporary = new Map<
    string,
    {
      readonly ref: ReturnType<typeof ref>;
      latestExpiry: string;
      readonly scopes: Set<string>;
    }
  >();
  readonly #temporaryCleanup = new Map<string, ReturnType<typeof ref>>();
  readonly #clock: () => string;
  readonly #authorize: (scope: SurfaceAssetScope) => boolean;
  readonly #isAdopted: (digest: string) => boolean;

  constructor(
    clock: () => string,
    authorize: (scope: SurfaceAssetScope) => boolean,
    isAdopted: (digest: string) => boolean = () => false,
  ) {
    this.#clock = clock;
    this.#authorize = authorize;
    this.#isAdopted = isAdopted;
  }

  async load() {
    let durableTime: string | undefined;
    for (const record of this.records) {
      if (record.t === "authority-time-frontier") {
        durableTime = later(durableTime, record.frontier);
      }
    }
    return {
      records: structuredClone(this.records),
      ...(durableTime ? { durableTime } : {}),
    };
  }

  async synchronize() {
    this.synchronizeCalls += 1;
    if (!this.failSynchronizeOnce) return;
    this.failSynchronizeOnce = false;
    throw new Error("simulated recovery synchronization failure");
  }

  async append(
    record: Extract<
      this["records"][number],
      { t: "asset-grant-revoked" | "authority-time-frontier" }
    >,
  ) {
    this.records.push(structuredClone(record));
    return {
      durableTime: record.t === "authority-time-frontier"
        ? later(this.#clock(), record.frontier)
        : this.#clock(),
    };
  }

  async appendIssued(
    record: Extract<this["records"][number], { t: "asset-grant-issued" }>,
  ) {
    if (!this.#authorize(record.grant.scope)) {
      return { accepted: false, durableTime: this.#clock() };
    }
    this.records.push(structuredClone(record));
    if (this.failAfterAppendOnce) {
      this.failAfterAppendOnce = false;
      throw new Error("simulated lost append response");
    }
    return {
      accepted: true,
      durableTime: later(this.#clock(), record.grant.issuedAt),
    };
  }

  async findIssuedByRequestKey(requestKey: string) {
    let matched: SurfaceAssetGrant | undefined;
    for (const record of this.records) {
      if (record.t !== "asset-grant-issued") continue;
      const grant = record.grant;
      if (
        surfaceAssetRequestKey(
          grant.scope,
          grant.surfacePrincipal,
          grant.requestId,
        ) !== requestKey
      ) {
        continue;
      }
      if (matched && canonicalize(matched) !== canonicalize(grant)) {
        throw new Error("Surface grant request has conflicting durable grants");
      }
      matched = structuredClone(grant);
    }
    return matched;
  }

  async findActiveGrant(
    grantId: string,
    expected?: SurfaceAssetGrant,
  ) {
    const grant = this.#activeGrants().find(
      (candidate) => candidate.grantId === grantId,
    );
    if (
      grant !== undefined &&
      expected !== undefined &&
      canonicalize(grant) !== canonicalize(expected)
    ) {
      throw new Error("Active grant does not match its expected grant");
    }
    return grant;
  }

  async listActiveConversationGrants(
    conversationId: string,
    limit: number,
  ) {
    return this.#activeGrants()
      .filter((grant) =>
        grant.scope.domain === "conversation" &&
        grant.scope.conversationId === conversationId
      )
      .slice(0, limit);
  }

  async listActiveSurfaceGrants(
    surfacePrincipal: string,
    limit: number,
  ) {
    return this.#activeGrants()
      .filter((grant) => grant.surfacePrincipal === surfacePrincipal)
      .slice(0, limit);
  }

  async nextActiveGrantExpiry() {
    return this.#activeGrants()
      .map(({ expiry }) => expiry)
      .sort()[0];
  }

  async quotaSnapshot(
    requestedScope: SurfaceAssetScope,
    refs: readonly ReturnType<typeof ref>[],
  ) {
    const scopeKey = canonicalize(requestedScope);
    const scopeRefs = new Map<string, ReturnType<typeof ref>>();
    const deviceRefs = new Map<string, ReturnType<typeof ref>>();
    for (const grant of this.#activeGrants()) {
      if (grant.kind !== "asset-upload") continue;
      for (const reference of grant.assets) {
        if (this.#isAdopted(reference.digest)) continue;
        const existingDevice = deviceRefs.get(reference.digest);
        if (
          existingDevice &&
          existingDevice.bytes !== reference.bytes
        ) {
          throw new TypeError(
            "The same surface asset digest cannot declare different byte counts",
          );
        }
        deviceRefs.set(reference.digest, reference);
        if (canonicalize(grant.scope) === scopeKey) {
          const existingScope = scopeRefs.get(reference.digest);
          if (existingScope && existingScope.bytes !== reference.bytes) {
            throw new TypeError(
              "The same surface asset digest cannot declare different byte counts",
            );
          }
          scopeRefs.set(reference.digest, reference);
        }
      }
    }
    for (const temporary of this.#temporary.values()) {
      if (this.#isAdopted(temporary.ref.digest)) continue;
      const existingDevice = deviceRefs.get(temporary.ref.digest);
      if (
        existingDevice &&
        existingDevice.bytes !== temporary.ref.bytes
      ) {
        throw new TypeError(
          "The same surface asset digest cannot declare different byte counts",
        );
      }
      deviceRefs.set(temporary.ref.digest, temporary.ref);
      if (temporary.scopes.has(scopeKey)) {
        const existingScope = scopeRefs.get(temporary.ref.digest);
        if (
          existingScope &&
          existingScope.bytes !== temporary.ref.bytes
        ) {
          throw new TypeError(
            "The same surface asset digest cannot declare different byte counts",
          );
        }
        scopeRefs.set(temporary.ref.digest, temporary.ref);
      }
    }
    for (const reference of refs) {
      const existing = deviceRefs.get(reference.digest);
      if (existing && existing.bytes !== reference.bytes) {
        throw new TypeError(
          "The same surface asset digest cannot declare different byte counts",
        );
      }
    }
    return {
      scopeBytes: [...scopeRefs.values()].reduce(
        (sum, reference) => sum + reference.bytes,
        0,
      ),
      deviceBytes: [...deviceRefs.values()].reduce(
        (sum, reference) => sum + reference.bytes,
        0,
      ),
      memberships: refs.map((reference) => ({
        digest: reference.digest,
        scopeCounted: scopeRefs.has(reference.digest),
        deviceCounted: deviceRefs.has(reference.digest),
        retained: this.#isAdopted(reference.digest),
      })),
    };
  }

  async isRetainedReference(reference: ReturnType<typeof ref>) {
    return this.#isAdopted(reference.digest);
  }

  async recordTemporaryPresence(
    reference: ReturnType<typeof ref>,
    scopeIdentity: string,
  ) {
    if (
      !this.#uploadGrants(reference).some((grant) =>
        canonicalize(grant.scope) === scopeIdentity
      )
    ) {
      throw new Error("Temporary surface asset has no durable upload grant");
    }
  }

  async settleTemporaryPresence(
    reference: ReturnType<typeof ref>,
    scopeIdentity: string,
    landed: boolean,
  ) {
    if (!landed) return;
    const grants = this.#uploadGrants(reference).filter((grant) =>
      canonicalize(grant.scope) === scopeIdentity
    );
    if (grants.length === 0) {
      throw new Error("Temporary surface asset has no durable upload grant");
    }
    const current = this.#temporary.get(reference.digest);
    if (current && current.ref.bytes !== reference.bytes) {
      throw new TypeError(
        "The same surface asset digest cannot declare different byte counts",
      );
    }
    const scopes = current?.scopes ?? new Set<string>();
    for (const grant of grants) scopes.add(canonicalize(grant.scope));
    // 接管是耐久单向跳变(真实 reducer 把 temporary 记录一次性转成 cleanup 记录,
    // 释放不会把它变回"过期临时"):落地时已接管的直接进 cleanup,不进 temporary。
    if (this.#isAdopted(reference.digest)) {
      this.#temporaryCleanup.set(reference.digest, reference);
      return;
    }
    this.#temporary.set(reference.digest, {
      ref: reference,
      latestExpiry: later(
        current?.latestExpiry,
        grants.map(({ expiry }) => expiry).sort().at(-1)!,
      ),
      scopes,
    });
  }

  /** 接管的耐久跳变:temporary → cleanup,一次性、不随所有权回撤复原。 */
  recordAdoption(reference: ReturnType<typeof ref>) {
    if (!this.#temporary.has(reference.digest)) return;
    this.#temporary.delete(reference.digest);
    this.#temporaryCleanup.set(reference.digest, reference);
  }

  async temporaryBefore(before: string, limit: number) {
    return [...this.#temporary.values()]
      .filter(({ ref, latestExpiry }) =>
        !this.#isAdopted(ref.digest) && latestExpiry <= before
      )
      .sort((left, right) =>
        left.latestExpiry.localeCompare(right.latestExpiry) ||
        left.ref.digest.localeCompare(right.ref.digest)
      )
      .slice(0, limit)
      .map(({ ref, latestExpiry }) => ({
        ref,
        eligibleAt: latestExpiry,
      }));
  }

  async adoptedTemporary(limit: number) {
    for (const { ref: reference } of this.#temporary.values()) {
      if (this.#isAdopted(reference.digest)) {
        // 与 recordAdoption 同一跳变:移动而非复制,释放后不得退回过期临时。
        this.#temporary.delete(reference.digest);
        this.#temporaryCleanup.set(reference.digest, reference);
      }
    }
    return [...this.#temporaryCleanup.values()]
      .sort((left, right) => left.digest.localeCompare(right.digest))
      .slice(0, limit);
  }

  seedTemporary(reference: ReturnType<typeof ref>) {
    this.#temporary.set(reference.digest, {
      ref: reference,
      latestExpiry: this.#clock(),
      scopes: new Set([canonicalize(scope)]),
    });
  }

  async markTemporaryRemoved(reference: ReturnType<typeof ref>) {
    this.#temporary.delete(reference.digest);
    this.#temporaryCleanup.delete(reference.digest);
    return true;
  }

  #uploadGrants(reference: ReturnType<typeof ref>): SurfaceAssetGrant[] {
    return this.records
      .filter((record): record is Extract<
        this["records"][number],
        { t: "asset-grant-issued" }
      > => record.t === "asset-grant-issued")
      .map(({ grant }) => grant)
      .filter((grant) =>
        grant.kind === "asset-upload" &&
        grant.assets.some(({ digest, bytes }) =>
          digest === reference.digest && bytes === reference.bytes
        )
      );
  }

  #activeGrants(): SurfaceAssetGrant[] {
    const revoked = new Set(
      this.records
        .filter((record) => record.t === "asset-grant-revoked")
        .map((record) => record.grantId),
    );
    const frontier = this.records.reduce<string | undefined>(
      (latest, record) =>
        record.t === "authority-time-frontier"
          ? later(latest, record.frontier)
          : record.t === "asset-grant-issued"
          ? later(latest, record.grant.issuedAt)
          : latest,
      undefined,
    );
    return this.records
      .filter((record): record is Extract<
        this["records"][number],
        { t: "asset-grant-issued" }
      > => record.t === "asset-grant-issued")
      .map(({ grant }) => structuredClone(grant))
      .filter((grant) =>
        !revoked.has(grant.grantId) &&
        (!frontier || Date.parse(grant.expiry) > Date.parse(frontier))
      );
  }
}

async function fixture(options: {
  readonly scopeQuotaBytes?: number;
  readonly deviceQuotaBytes?: number;
  readonly unadoptedRetentionMs?: number;
  readonly grantTtlMs?: number;
  readonly authorizeScope?: (candidate: SurfaceAssetScope) => boolean;
  readonly deleteUnreferencedArtifacts?:
    SurfaceAssetCoordinatorOptions["deleteUnreferencedArtifacts"];
  readonly storageMaintenance?:
    SurfaceAssetCoordinatorOptions["storageMaintenance"];
  /** 在 ledger 上包一层,用来把故障精确注入到恢复真正会触发准入的那一步。 */
  readonly ledgerDecorator?: (
    ledger: SurfaceAssetCoordinatorOptions["ledger"],
  ) => SurfaceAssetCoordinatorOptions["ledger"];
} = {}) {
  const root = await createTempDir("surface-assets");
  const artifactsRoot = path.join(root, "artifacts");
  const temporaryRoot = path.join(root, "temporary-artifacts");
  const partialsRoot = path.join(root, "partials");
  const adopted = new Map<string, ReturnType<typeof ref>>();
  const releasedLeaves: Array<{
    readonly ref: ReturnType<typeof ref>;
    readonly releasedAt: string;
    readonly releaseId: Digest;
  }> = [];
  const deletionBatches: ReturnType<typeof ref>[][] = [];
  let now = "2026-07-24T00:00:00.000Z";
  let monotonicNow = 0;
  let id = 0;
  const authorizeScope = options.authorizeScope ?? (() => true);
  const ledger = new MemoryLedger(
    () => now,
    authorizeScope,
    (digest) => adopted.has(digest),
  );
  const recordRelease = (reference: ReturnType<typeof ref>) => {
    if (releasedLeaves.some(({ ref }) => ref.digest === reference.digest)) return;
    releasedLeaves.push({
      ref: reference,
      releasedAt: now,
      releaseId: protocolDigest("ArtifactRelease", 1, {
        ref: reference,
        releasedAt: now,
        ordinal: releasedLeaves.length,
      }),
    });
  };
  const createCoordinator = () => {
    const artifacts = new FileArtifactStore(artifactsRoot);
    const temporaryArtifacts = new FileArtifactStore(temporaryRoot);
    const receiver = new FileResumableArtifactReceiver(
      temporaryArtifacts,
      partialsRoot,
      { maxArtifactBytes: 1024 },
    );
    const coordinator = SurfaceAssetCoordinator.forStore({
      artifacts,
      temporaryArtifacts,
      receiver,
      ledger: options.ledgerDecorator ? options.ledgerDecorator(ledger) : ledger,
      signer,
      verifier,
      createGrantId: () =>
        `grt-01J${String(++id).padStart(23, "0")}`,
      canDownload: async (_scope, refs) =>
        (await Promise.all(refs.map((ref) => artifacts.has(ref)))).every(Boolean),
      authorizeScope,
      listReleasedArtifacts: async (before, limit) =>
        releasedLeaves
          .filter((release) => release.releasedAt <= before)
          .slice(0, limit),
      markReleasedArtifactsReclaimed: async (reclaimed) => {
        const ids = new Set(reclaimed.map(({ releaseId }) => releaseId));
        for (let index = releasedLeaves.length - 1; index >= 0; index -= 1) {
          if (ids.has(releasedLeaves[index]!.releaseId)) {
            releasedLeaves.splice(index, 1);
          }
        }
      },
      deleteUnreferencedArtifacts: async (references) => {
        deletionBatches.push([...references]);
        return Promise.all(
          references.map(async (reference) => ({
            ref: reference,
            disposition: await artifacts.delete(reference)
              ? "deleted" as const
              : "missing" as const,
          })),
        );
      },
      clock: () => now,
      monotonicClock: () => monotonicNow,
      ...options,
    });
    return { artifacts, temporaryArtifacts, receiver, coordinator };
  };
  const initial = createCoordinator();
  return {
    ...initial,
    ledger,
    deletionBatches,
    idCalls() {
      return id;
    },
    restart() {
      return createCoordinator();
    },
    adopt(reference: ReturnType<typeof ref>) {
      adopted.set(reference.digest, reference);
      // 接管的耐久事实落账:临时记录随即转入 cleanup 集合,与真实 reducer 的
      // 单向跳变同形,释放不会把它变回过期临时。
      ledger.recordAdoption(reference);
    },
    unadopt(reference: ReturnType<typeof ref>) {
      adopted.delete(reference.digest);
      recordRelease(reference);
    },
    releaseLeaf(reference: ReturnType<typeof ref>) {
      recordRelease(reference);
    },
    setNow(value: string) {
      now = value;
    },
    advanceMonotonic(milliseconds: number) {
      monotonicNow += milliseconds;
    },
  };
}

function ref(bytes: Uint8Array) {
  return { digest: byteDigest(bytes), bytes: bytes.byteLength };
}

function later(left: string | undefined, right: string): string {
  if (left === undefined) return right;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

describe("surface asset coordinator", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("rebinds the stable store coordinator to one new authority generation", async () => {
    const current = await fixture({ authorizeScope: () => false });
    expect(await current.coordinator.ownsScope(scope)).toBe(false);

    const nextLedger = new MemoryLedger(
      () => "2026-07-24T00:00:00.000Z",
      () => true,
    );
    await current.coordinator.rebindAuthority({
      ledger: nextLedger,
      signer,
      verifier,
      createGrantId: () => "grt-01J00000000000000000000000",
      canDownload: () => true,
      authorizeScope: () => true,
      deleteUnreferencedArtifacts: async (refs) =>
        refs.map((reference) => ({ ref: reference, disposition: "missing" as const })),
      listReleasedArtifacts: async () => [],
      markReleasedArtifactsReclaimed: async () => undefined,
    });

    expect(await current.coordinator.ownsScope(scope)).toBe(true);
    expect(nextLedger.synchronizeCalls).toBe(1);
  });

  it("persists before return and replays only an identical durable request", async () => {
    const { coordinator, ledger } = await fixture();
    const asset = ref(Buffer.from("asset"));
    const request = {
      kind: "asset-upload" as const,
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-1",
      assets: [asset],
      payloadDigest,
    };

    const first = await coordinator.issue(request);
    expect(ledger.records).toEqual([
      { t: "asset-grant-issued", grant: first },
    ]);
    expect(await coordinator.issue(request)).toEqual(first);
    expect(ledger.records).toHaveLength(1);
    await coordinator.append(
      first,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      asset,
      0,
      Buffer.from("asset"),
    );
    await expect(
      coordinator.assertUploadAdoption({
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-1",
        assets: [asset],
        payloadDigest,
      }),
    ).resolves.toBeUndefined();
    await expect(
      coordinator.assertUploadAdoption({
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-1",
        assets: [asset],
        payloadDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).rejects.toThrow("does not bind");
    await expect(
      coordinator.issue({
        ...request,
        assets: [ref(Buffer.from("changed"))],
      }),
    ).rejects.toThrow("idempotency-conflict");
  });

  it("replays the durable grant before consulting mutable issuance dependencies", async () => {
    let authorized = true;
    const state = await fixture({
      authorizeScope: () => authorized,
    });
    const request = {
      kind: "asset-upload" as const,
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-replay-before-fresh",
      assets: [ref(Buffer.from("asset"))],
      payloadDigest,
    };
    const first = await state.coordinator.issue(request);
    authorized = false;
    state.setNow("not-a-time");

    await expect(state.coordinator.issue(request)).resolves.toEqual(first);
    expect(state.idCalls()).toBe(1);
    expect(state.ledger.records).toHaveLength(1);
    await expect(state.restart().coordinator.issue(request)).resolves.toEqual(
      first,
    );
    expect(state.idCalls()).toBe(1);
    expect(state.ledger.records).toHaveLength(1);
    await expect(
      state.coordinator.issue({
        ...request,
        assets: [ref(Buffer.from("different"))],
      }),
    ).rejects.toThrow("idempotency-conflict");
  });

  it("requires the scope fence to remain current at the issued fsync", async () => {
    let authorizationChecks = 0;
    const { coordinator, ledger } = await fixture({
      authorizeScope: () => {
        authorizationChecks += 1;
        return authorizationChecks === 1;
      },
    });

    await expect(
      coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-owner-transfer",
        assets: [ref(Buffer.from("asset"))],
        payloadDigest,
      }),
    ).rejects.toThrow("not owned");
    expect(ledger.records).toEqual([]);
  });

  it("makes an observed expiry survive wall-clock rollback and restart", async () => {
    const state = await fixture({ grantTtlMs: 10 });
    const asset = ref(Buffer.from("asset"));
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-time-frontier",
      assets: [asset],
      payloadDigest,
    });
    const use = {
      scope,
      surfacePrincipal: "surface-1",
      kind: "asset-upload" as const,
      payloadDigest,
    };
    state.setNow("2026-07-24T00:00:00.020Z");
    await expect(state.coordinator.probe(grant, use, asset)).rejects.toThrow(
      "not active",
    );
    expect(state.ledger.records.at(-1)).toEqual({
      t: "authority-time-frontier",
      frontier: "2026-07-24T00:00:00.020Z",
    });

    state.setNow("2026-07-24T00:00:00.000Z");
    // 同进程回拨:grant 已从热集退休,统一按未知/吊销拒绝,不复活。
    await expect(state.coordinator.probe(grant, use, asset)).rejects.toThrow(
      "unknown or revoked",
    );
    const restarted = state.restart();
    // 重启 + 回拨:耐久前沿使过期粘滞,过滤装载后同样不进入热集。
    await expect(restarted.coordinator.probe(grant, use, asset)).rejects.toThrow(
      "unknown or revoked",
    );
  });

  it("uses monotonic elapsed time so a mid-TTL wall rollback cannot extend a grant", async () => {
    const state = await fixture({ grantTtlMs: 10 });
    const asset = ref(Buffer.from("asset"));
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-monotonic-expiry",
      assets: [asset],
      payloadDigest,
    });
    state.setNow("2026-07-23T23:59:00.000Z");
    state.advanceMonotonic(11);

    await expect(
      state.coordinator.probe(
        grant,
        {
          scope,
          surfacePrincipal: "surface-1",
          kind: "asset-upload",
          payloadDigest,
        },
        asset,
      ),
    ).rejects.toThrow("not active");
  });

  it("preserves monotonic elapsed time across projection recovery", async () => {
    const state = await fixture({ grantTtlMs: 100 });
    const asset = ref(Buffer.from("asset"));
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-recovery-monotonic-expiry",
      assets: [asset],
      payloadDigest,
    });
    const use = {
      scope,
      surfacePrincipal: "surface-1",
      kind: "asset-upload" as const,
      payloadDigest,
    };
    state.setNow("2026-07-24T00:00:00.060Z");
    state.advanceMonotonic(60);
    await expect(state.coordinator.probe(grant, use, asset)).resolves.toEqual({
      receivedBytes: 0,
      complete: false,
    });

    state.setNow("2026-07-24T00:00:00.000Z");
    const downloadRef = await state.artifacts.put(Buffer.from("download"));
    state.ledger.failAfterAppendOnce = true;
    await expect(
      state.coordinator.issue({
        kind: "asset-download",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-recovery-monotonic-trigger",
        assets: [downloadRef],
      }),
    ).rejects.toThrow("simulated lost append response");
    await state.coordinator.recover();

    state.advanceMonotonic(41);
    await expect(state.coordinator.probe(grant, use, asset)).rejects.toThrow(
      "not active",
    );
  });

  it("publishes recovered state only after ledger synchronization completes", async () => {
    const state = await fixture();
    state.ledger.failSynchronizeOnce = true;

    await expect(state.coordinator.recover()).rejects.toThrow(
      "simulated recovery synchronization failure",
    );
    await expect(state.coordinator.recover()).resolves.toBeUndefined();
    expect(state.ledger.synchronizeCalls).toBe(2);
    await expect(state.coordinator.recover()).resolves.toBeUndefined();
    expect(state.ledger.synchronizeCalls).toBe(2);
  });

  it("leaves adopted cleanup to the GC owner during recovery", async () => {
    const state = await fixture();
    const adopted = Array.from(
      { length: 65 },
      (_, index) => ref(Buffer.from(`recovery-adopted-${index}`)),
    );
    for (const reference of adopted) {
      state.adopt(reference);
      state.ledger.seedTemporary(reference);
    }
    const markTemporaryRemoved = vi.spyOn(
      state.ledger,
      "markTemporaryRemoved",
    );

    await state.coordinator.recover();

    expect(markTemporaryRemoved).not.toHaveBeenCalled();
    await expect(state.ledger.adoptedTemporary(66)).resolves.toHaveLength(65);

    await state.coordinator.collectExpiredTemporaryAssets();

    expect(markTemporaryRemoved).toHaveBeenCalledTimes(64);
    await expect(state.ledger.adoptedTemporary(2)).resolves.toHaveLength(1);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("routes online adopted cleanup through one GC-owner page", async () => {
    const state = await fixture();
    await state.coordinator.recover();
    const adopted = Array.from(
      { length: 65 },
      (_, index) => ref(Buffer.from(`online-adopted-${index}`)),
    );
    for (const reference of adopted) {
      state.adopt(reference);
      state.ledger.seedTemporary(reference);
    }
    const markTemporaryRemoved = vi.spyOn(
      state.ledger,
      "markTemporaryRemoved",
    );

    await state.coordinator.markAdopted([adopted[0]!]);

    expect(markTemporaryRemoved).not.toHaveBeenCalled();
    await expect(state.ledger.adoptedTemporary(66)).resolves.toHaveLength(65);

    await state.coordinator.collectExpiredTemporaryAssets();

    expect(markTemporaryRemoved).toHaveBeenCalledTimes(64);
    await expect(state.ledger.adoptedTemporary(2)).resolves.toHaveLength(1);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("does not count durable append latency twice", async () => {
    const state = await fixture({ grantTtlMs: 100 });
    const appendIssued = state.ledger.appendIssued.bind(state.ledger);
    state.ledger.appendIssued = async (record) => {
      state.setNow("2026-07-24T00:00:00.040Z");
      state.advanceMonotonic(40);
      return appendIssued(record);
    };
    const asset = ref(Buffer.from("asset"));
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-durable-time-reanchor",
      assets: [asset],
      payloadDigest,
    });

    state.setNow("2026-07-24T00:00:00.060Z");
    state.advanceMonotonic(20);
    await expect(
      state.coordinator.probe(
        grant,
        {
          scope,
          surfacePrincipal: "surface-1",
          kind: "asset-upload",
          payloadDigest,
        },
        asset,
      ),
    ).resolves.toEqual({ receivedBytes: 0, complete: false });
  });

  it("invalidates its projection when a durable append result is uncertain", async () => {
    const { coordinator, ledger } = await fixture();
    const request = {
      kind: "asset-upload" as const,
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-uncertain",
      assets: [ref(Buffer.from("asset"))],
      payloadDigest,
    };
    ledger.failAfterAppendOnce = true;

    await expect(coordinator.issue(request)).rejects.toThrow(
      "simulated lost append response",
    );
    const replayed = await coordinator.issue(request);

    expect(replayed).toEqual(
      (ledger.records[0] as Extract<ControlRecord, { t: "asset-grant-issued" }>)
        .grant,
    );
    expect(ledger.records).toHaveLength(1);
  });

  it("recovers inside the next serialized operation after an uncertain append", async () => {
    const { coordinator, ledger } = await fixture();
    const request = {
      kind: "asset-upload" as const,
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-concurrent-uncertain",
      assets: [ref(Buffer.from("asset"))],
      payloadDigest,
    };
    ledger.failAfterAppendOnce = true;

    const [first, second] = await Promise.allSettled([
      coordinator.issue(request),
      coordinator.issue(request),
    ]);

    expect(first).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "simulated lost append response",
      }),
    });
    expect(second).toEqual({
      status: "fulfilled",
      value: (
        ledger.records[0] as Extract<
          ControlRecord,
          { t: "asset-grant-issued" }
        >
      ).grant,
    });
    expect(ledger.records).toHaveLength(1);
  });

  it("rejects conflicting byte counts for one digest across grants", async () => {
    const { coordinator } = await fixture();
    const asset = ref(Buffer.from("asset"));
    await coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-bytes-1",
      assets: [asset],
      payloadDigest,
    });

    await expect(
      coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-bytes-2",
        assets: [{ ...asset, bytes: asset.bytes + 1 }],
        payloadDigest,
      }),
    ).rejects.toThrow("different byte counts");
  });

  it("rejects a scope epoch not owned by the signing authority", async () => {
    const { coordinator } = await fixture({
      authorizeScope: (candidate) =>
        candidate.domain === "conversation" && candidate.ownerEpoch === 1,
    });
    await expect(
      coordinator.issue({
        kind: "asset-upload",
        scope: { ...scope, ownerEpoch: 2 },
        surfacePrincipal: "surface-1",
        requestId: "request-stale-epoch",
        assets: [ref(Buffer.from("asset"))],
        payloadDigest,
      }),
    ).rejects.toThrow(/not owned/);
  });

  it("enforces the same download request shape and range budget locally", async () => {
    const { artifacts, coordinator } = await fixture();
    const bytes = Buffer.from("download");
    const asset = await artifacts.put(bytes);
    const request = {
      kind: "asset-download",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-download",
      assets: [asset],
    } as const;

    await expect(
      coordinator.issue({
        ...request,
        payloadDigest,
      } as unknown as SurfaceAssetGrantIssueRequest),
    ).rejects.toThrow("incomplete or unknown");
    await expect(
      coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-noncanonical",
        assets: [
          { digest: `sha256:${"f".repeat(64)}`, bytes: 1 },
          { digest: `sha256:${"0".repeat(64)}`, bytes: 1 },
        ],
        payloadDigest,
      }),
    ).rejects.toThrow("canonical order");
    const grant = await coordinator.issue(request);
    await expect(
      coordinator.read(
        grant,
        {
          scope,
          surfacePrincipal: "surface-1",
          kind: "asset-download",
        },
        asset,
        0,
        DEFAULT_ARTIFACT_CHUNK_BYTES + 1,
      ),
    ).rejects.toThrow("outside its bound");
  });

  it("revokes grants by conversation and surface lifecycle", async () => {
    const { coordinator, ledger } = await fixture();
    const asset = ref(Buffer.from("asset"));
    const otherScope: SurfaceAssetScope = {
      domain: "conversation",
      conversationId: "conversation-2",
      ownerEpoch: 1,
    };
    const first = await coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-conversation-1",
      assets: [asset],
      payloadDigest,
    });
    const second = await coordinator.issue({
      kind: "asset-upload",
      scope: otherScope,
      surfacePrincipal: "surface-1",
      requestId: "request-conversation-2",
      assets: [asset],
      payloadDigest,
    });
    await coordinator.append(
      second,
      {
        scope: otherScope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      asset,
      0,
      Buffer.from("asset"),
    );

    await coordinator.revokeConversation(scope.conversationId);
    await expect(
      coordinator.assertUploadAdoption({
        scope,
        surfacePrincipal: "surface-1",
        requestId: first.requestId,
        assets: [asset],
        payloadDigest,
      }),
    ).rejects.toThrow("unknown or revoked");
    await expect(
      coordinator.assertUploadAdoption({
        scope: otherScope,
        surfacePrincipal: "surface-1",
        requestId: second.requestId,
        assets: [asset],
        payloadDigest,
      }),
    ).resolves.toBeUndefined();

    await coordinator.revokeSurface("surface-1");
    await expect(
      coordinator.assertUploadAdoption({
        scope: otherScope,
        surfacePrincipal: "surface-1",
        requestId: second.requestId,
        assets: [asset],
        payloadDigest,
      }),
    ).rejects.toThrow("unknown or revoked");
    expect(ledger.records.slice(-2)).toEqual([
      {
        t: "asset-grant-revoked",
        grantId: first.grantId,
        reason: "session-deleted",
      },
      {
        t: "asset-grant-revoked",
        grantId: second.grantId,
        reason: "surface-revoked",
      },
    ]);
  });

  it("releases only unlanded reservations when revoked", async () => {
    const first = await fixture({ scopeQuotaBytes: 10, deviceQuotaBytes: 20 });
    const sixA = Buffer.from("aaaaaa");
    const sixB = Buffer.from("bbbbbb");
    const request = (requestId: string, bytes: Uint8Array) => ({
      kind: "asset-upload" as const,
      scope,
      surfacePrincipal: "surface-1",
      requestId,
      assets: [ref(bytes)],
      payloadDigest,
    });
    const unlanded = await first.coordinator.issue(request("request-a", sixA));
    await expect(
      first.coordinator.issue(request("request-b", sixB)),
    ).rejects.toThrow("scope quota");
    await first.coordinator.revoke(unlanded.grantId, "superseded");
    await expect(
      first.coordinator.issue(request("request-b", sixB)),
    ).resolves.toBeDefined();

    const second = await fixture({ scopeQuotaBytes: 10, deviceQuotaBytes: 20 });
    const landed = await second.coordinator.issue(request("request-c", sixA));
    await second.coordinator.append(
      landed,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      ref(sixA),
      0,
      sixA,
    );
    await second.coordinator.revoke(landed.grantId, "superseded");
    await expect(
      second.coordinator.issue(request("request-d", sixB)),
    ).rejects.toThrow("scope quota");
  });

  it("guards transfer bindings and deletes only expired unadopted bytes", async () => {
    const { artifacts, coordinator, setNow, temporaryArtifacts } = await fixture({
      unadoptedRetentionMs: 10,
      grantTtlMs: 1,
    });
    const bytes = Buffer.from("temporary");
    const asset = ref(bytes);
    const grant = await coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-gc",
      assets: [asset],
      payloadDigest,
    });
    await expect(
      coordinator.append(
        grant,
        {
          scope,
          surfacePrincipal: "surface-other",
          kind: "asset-upload",
          payloadDigest,
        },
        asset,
        0,
        bytes,
      ),
    ).rejects.toThrow("does not bind");
    await coordinator.append(
      grant,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      asset,
      0,
      bytes,
    );
    expect(await artifacts.has(asset)).toBe(false);
    expect(await temporaryArtifacts.has(asset)).toBe(true);
    setNow("2026-07-24T00:00:00.012Z");
    await expect(
      coordinator.probe(
        grant,
        {
          scope,
          surfacePrincipal: "surface-1",
          kind: "asset-upload",
          payloadDigest,
        },
        asset,
      ),
    ).rejects.toThrow("not active");
    expect(await coordinator.collectExpiredTemporaryAssets()).toEqual({
      processed: 1,
      removed: 1,
      hasMore: false,
    });
    expect(await artifacts.has(asset)).toBe(false);
    expect(await temporaryArtifacts.has(asset)).toBe(false);
  });

  it("refreshes durable adoption before garbage collection", async () => {
    const {
      adopt,
      artifacts,
      coordinator,
      setNow,
      temporaryArtifacts,
    } = await fixture({
      unadoptedRetentionMs: 10,
      grantTtlMs: 1,
    });
    const bytes = Buffer.from("adopted");
    const asset = ref(bytes);
    const grant = await coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-adopted",
      assets: [asset],
      payloadDigest,
    });
    await coordinator.append(
      grant,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      asset,
      0,
      bytes,
    );
    await coordinator.assertUploadAdoption({
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-adopted",
      assets: [asset],
      payloadDigest,
    });
    adopt(asset);
    setNow("2026-07-24T00:00:00.012Z");

    // 已接管资产只清理临时副本，不进入主存储删除候选。
    expect(await coordinator.collectExpiredTemporaryAssets()).toEqual({
      processed: 1,
      removed: 1,
      hasMore: false,
    });
    expect(await artifacts.has(asset)).toBe(true);
    expect(await temporaryArtifacts.has(asset)).toBe(false);
  });

  it("removes adopted uploads from quota without re-reading primary content", async () => {
    const state = await fixture({
      scopeQuotaBytes: 10,
      deviceQuotaBytes: 20,
    });
    const adoptedBytes = Buffer.from("aaaaaa");
    const adoptedRef = ref(adoptedBytes);
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-adoption-quota",
      assets: [adoptedRef],
      payloadDigest,
    });
    await state.coordinator.append(
      grant,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      adoptedRef,
      0,
      adoptedBytes,
    );
    await state.coordinator.assertUploadAdoption({
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-adoption-quota",
      assets: [adoptedRef],
      payloadDigest,
    });
    state.adopt(adoptedRef);
    const primaryHas = vi.spyOn(state.artifacts, "has");
    await state.coordinator.markAdopted([adoptedRef]);
    expect(primaryHas).not.toHaveBeenCalled();

    const restarted = state.restart();
    const restartedPrimaryHas = vi.spyOn(restarted.artifacts, "has");
    await restarted.coordinator.recover();
    expect(restartedPrimaryHas).not.toHaveBeenCalled();
    await restarted.coordinator.revoke(grant.grantId, "superseded");
    const temporaryDiscard = vi.spyOn(
      restarted.temporaryArtifacts,
      "discard",
    );
    const nextAssets = [adoptedRef, ref(Buffer.from("bbbbbb"))].sort(
      (left, right) => left.digest.localeCompare(right.digest),
    );
    await expect(
      restarted.coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-after-adoption",
        assets: nextAssets,
        payloadDigest,
      }),
    ).resolves.toBeDefined();
    expect(temporaryDiscard).not.toHaveBeenCalled();
  });

  it("restores active quota reservations when an adopted asset loses visibility", async () => {
    const state = await fixture({
      scopeQuotaBytes: 10,
      deviceQuotaBytes: 20,
    });
    const firstBytes = Buffer.from("aaaaaa");
    const firstRef = ref(firstBytes);
    const first = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-adoption-release",
      assets: [firstRef],
      payloadDigest,
    });
    await state.coordinator.append(
      first,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      firstRef,
      0,
      firstBytes,
    );
    await state.coordinator.assertUploadAdoption({
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-adoption-release",
      assets: [firstRef],
      payloadDigest,
    });
    state.adopt(firstRef);
    await state.coordinator.markAdopted([firstRef]);
    state.unadopt(firstRef);

    await expect(
      state.coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-after-release",
        assets: [ref(Buffer.from("bbbbbb"))],
        payloadDigest,
      }),
    ).rejects.toThrow("scope quota");
  });

  it("defers adopted cleanup until a linearized upload releases its pin", async () => {
    const state = await fixture();
    const bytes = Buffer.from("adopted-during-upload");
    const asset = ref(bytes);
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-adopted-in-flight",
      assets: [asset],
      payloadDigest,
    });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = state.receiver.append.bind(state.receiver);
    state.receiver.append = async (...args) => {
      started();
      await releasePromise;
      return append(...args);
    };
    const inFlight = state.coordinator.append(
      grant,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      asset,
      0,
      bytes,
    );
    await startedPromise;
    await state.artifacts.put(bytes);
    state.adopt(asset);
    await state.coordinator.markAdopted([asset]);
    release();

    await expect(inFlight).resolves.toEqual({
      receivedBytes: bytes.byteLength,
      complete: true,
    });
    await expect(state.artifacts.has(asset)).resolves.toBe(true);
    await expect(state.temporaryArtifacts.has(asset)).resolves.toBe(true);

    await state.coordinator.collectExpiredTemporaryAssets();

    await expect(state.temporaryArtifacts.has(asset)).resolves.toBe(false);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("batches eligible candidates once and retires them from later GC cycles", async () => {
    const state = await fixture({
      unadoptedRetentionMs: 1,
      grantTtlMs: 1,
    });
    for (const [requestId, bytes] of [
      ["request-batch-a", Buffer.from("asset-a")],
      ["request-batch-b", Buffer.from("asset-b")],
    ] as const) {
      const asset = ref(bytes);
      const grant = await state.coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId,
        assets: [asset],
        payloadDigest,
      });
      await state.coordinator.append(
        grant,
        {
          scope,
          surfacePrincipal: "surface-1",
          kind: "asset-upload",
          payloadDigest,
        },
        asset,
        0,
        bytes,
      );
    }
    state.setNow("2026-07-24T00:00:00.010Z");

    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 2, removed: 2, hasMore: false });
    expect(state.deletionBatches).toHaveLength(1);
    expect(state.deletionBatches[0]).toHaveLength(2);
    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 0, removed: 0, hasMore: false });
    expect(state.deletionBatches).toHaveLength(1);
  });

  it("keeps a candidate eligible when physical deletion fails", async () => {
    const state = await fixture({
      unadoptedRetentionMs: 1,
      grantTtlMs: 1,
    });
    const bytes = Buffer.from("retry-collection");
    const asset = ref(bytes);
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-retry-collection",
      assets: [asset],
      payloadDigest,
    });
    await state.coordinator.append(
      grant,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      asset,
      0,
      bytes,
    );
    state.setNow("2026-07-24T00:00:00.010Z");
    const remove = state.artifacts.delete.bind(state.artifacts);
    vi.spyOn(state.artifacts, "delete")
      .mockRejectedValueOnce(new Error("simulated deletion failure"))
      .mockImplementation(remove);

    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).rejects.toThrow("simulated deletion failure");
    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 1, removed: 1, hasMore: false });
  });

  it("bounds each collection pass by candidate count and drains the remainder", async () => {
    const state = await fixture({
      unadoptedRetentionMs: 1,
      grantTtlMs: 1,
    });
    for (let index = 0; index < 65; index += 1) {
      const bytes = Buffer.from([index, 255 - index]);
      const asset = ref(bytes);
      const grant = await state.coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId: `request-bounded-batch-${index}`,
        assets: [asset],
        payloadDigest,
      });
      await state.coordinator.append(
        grant,
        {
          scope,
          surfacePrincipal: "surface-1",
          kind: "asset-upload",
          payloadDigest,
        },
        asset,
        0,
        bytes,
      );
    }
    state.setNow("2026-07-24T00:00:00.010Z");

    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 64, removed: 64, hasMore: true });
    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 1, removed: 1, hasMore: false });
    expect(state.deletionBatches.map((batch) => batch.length)).toEqual([64, 1]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("keeps collection pending while a candidate has scope pages to remove", async () => {
    const state = await fixture({
      unadoptedRetentionMs: 1,
      grantTtlMs: 1,
    });
    const bytes = Buffer.from("paged-temporary-cleanup");
    const asset = ref(bytes);
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-paged-temporary-cleanup",
      assets: [asset],
      payloadDigest,
    });
    await state.coordinator.append(
      grant,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      asset,
      0,
      bytes,
    );
    state.setNow("2026-07-24T00:00:00.010Z");
    vi.spyOn(state.ledger, "markTemporaryRemoved").mockResolvedValueOnce(false);

    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 1, removed: 1, hasMore: true });
    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 1, removed: 0, hasMore: false });
  });

  it("keeps a linearized upload pinned across revoke, quota and GC", async () => {
    const state = await fixture({
      scopeQuotaBytes: 10,
      deviceQuotaBytes: 20,
      unadoptedRetentionMs: 1,
    });
    const firstBytes = Buffer.from("aaaaaa");
    const secondBytes = Buffer.from("bbbbbb");
    const firstRef = ref(firstBytes);
    const first = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-pinned-a",
      assets: [firstRef],
      payloadDigest,
    });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = state.receiver.append.bind(state.receiver);
    state.receiver.append = async (...args) => {
      started();
      await releasePromise;
      return append(...args);
    };
    const inFlight = state.coordinator.append(
      first,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      firstRef,
      0,
      firstBytes,
    );
    await startedPromise;
    await state.coordinator.revoke(first.grantId, "superseded");
    state.setNow("2026-07-24T02:00:00.000Z");
    await expect(
      state.coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-pinned-b",
        assets: [ref(secondBytes)],
        payloadDigest,
      }),
    ).rejects.toThrow("scope quota");
    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 0, removed: 0, hasMore: false });

    release();
    await expect(inFlight).resolves.toEqual({
      receivedBytes: firstBytes.byteLength,
      complete: true,
    });
    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 1, removed: 1, hasMore: false });
    await expect(
      state.coordinator.issue({
        kind: "asset-upload",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-pinned-b",
        assets: [ref(secondBytes)],
        payloadDigest,
      }),
    ).resolves.toBeDefined();
  });

  it("preserves a live upload pin while recovering an uncertain ledger append", async () => {
    const state = await fixture({
      unadoptedRetentionMs: 1,
    });
    const uploadBytes = Buffer.from("in-flight-upload");
    const uploadRef = ref(uploadBytes);
    const upload = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-recovery-pin-upload",
      assets: [uploadRef],
      payloadDigest,
    });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = state.receiver.append.bind(state.receiver);
    state.receiver.append = async (...args) => {
      started();
      await releasePromise;
      return append(...args);
    };
    const inFlight = state.coordinator.append(
      upload,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      uploadRef,
      0,
      uploadBytes,
    );
    await startedPromise;

    const downloadRef = await state.artifacts.put(Buffer.from("download"));
    state.ledger.failAfterAppendOnce = true;
    await expect(
      state.coordinator.issue({
        kind: "asset-download",
        scope,
        surfacePrincipal: "surface-1",
        requestId: "request-recovery-pin-download",
        assets: [downloadRef],
      }),
    ).rejects.toThrow("simulated lost append response");
    await state.coordinator.recover();
    await state.coordinator.revoke(upload.grantId, "superseded");
    state.setNow("2026-07-24T02:00:00.000Z");

    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 0, removed: 0, hasMore: false });
    release();
    await expect(inFlight).resolves.toEqual({
      receivedBytes: uploadBytes.byteLength,
      complete: true,
    });
    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 1, removed: 1, hasMore: false });
    await expect(state.temporaryArtifacts.has(uploadRef)).resolves.toBe(false);
  });

  it("keeps a completed zero-byte upload collectable after expiry", async () => {
    const state = await fixture({ grantTtlMs: 5, unadoptedRetentionMs: 5 });
    const empty = new Uint8Array(0);
    const asset = ref(empty);
    const use = {
      scope,
      surfacePrincipal: "surface-1",
      kind: "asset-upload" as const,
      payloadDigest,
    };
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-zero-byte",
      assets: [asset],
      payloadDigest,
    });
    // 零字节是合法长度:空分段即终验完成,落盘判定不得依赖正字节数。
    await expect(
      state.coordinator.append(grant, use, asset, 0, empty),
    ).resolves.toEqual({ receivedBytes: 0, complete: true });
    await expect(state.temporaryArtifacts.has(asset)).resolves.toBe(true);

    state.setNow("2026-07-24T00:00:00.020Z");
    const collected = await state.coordinator.collectExpiredTemporaryAssets();
    expect(collected.removed).toBe(1);
    await expect(state.temporaryArtifacts.has(asset)).resolves.toBe(false);
  });

  it("defers mixed primary and temporary cleanup without advancing lifecycle state", async () => {
    let currentArtifacts: FileArtifactStore | undefined;
    let deletionAttempt = 0;
    const state = await fixture({
      grantTtlMs: 5,
      unadoptedRetentionMs: 5,
      deleteUnreferencedArtifacts: async (references) => {
        if (deletionAttempt++ === 0) {
          return references.map((reference) => ({
            ref: reference,
            disposition: "deferred" as const,
          }));
        }
        if (!currentArtifacts) throw new Error("Primary store is unavailable");
        return Promise.all(
          references.map(async (reference) => ({
            ref: reference,
            disposition: await currentArtifacts.delete(reference)
              ? "deleted" as const
              : "missing" as const,
          })),
        );
      },
    });
    currentArtifacts = state.artifacts;
    const temporaryBytes = Buffer.from("temporary-only");
    const temporaryRef = ref(temporaryBytes);
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-deferred-cleanup",
      assets: [temporaryRef],
      payloadDigest,
    });
    await state.coordinator.append(
      grant,
      {
        scope,
        surfacePrincipal: "surface-1",
        kind: "asset-upload",
        payloadDigest,
      },
      temporaryRef,
      0,
      temporaryBytes,
    );
    const releasedRef = await state.artifacts.put(
      Buffer.from("released-primary"),
    );
    state.releaseLeaf(releasedRef);
    state.setNow("2026-07-24T00:00:00.020Z");

    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 0, removed: 0, hasMore: true });
    await expect(state.temporaryArtifacts.has(temporaryRef)).resolves.toBe(true);
    await expect(state.artifacts.has(releasedRef)).resolves.toBe(true);

    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 2, removed: 2, hasMore: false });
    await expect(state.temporaryArtifacts.has(temporaryRef)).resolves.toBe(false);
    await expect(state.artifacts.has(releasedRef)).resolves.toBe(false);
  });

  it("replays a retired request key from the durable ledger without hot state", async () => {
    const state = await fixture({ grantTtlMs: 5 });
    const asset = ref(Buffer.from("cold-replay"));
    const request = {
      kind: "asset-upload" as const,
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-cold",
      assets: [asset],
      payloadDigest,
    };
    const grant = await state.coordinator.issue(request);
    state.setNow("2026-07-24T00:00:00.010Z");
    await state.coordinator.collectExpiredTemporaryAssets();

    const findSpy = vi.spyOn(state.ledger, "findIssuedByRequestKey");
    // 过期退休后同键重试:热集未命中,由耐久日志冷路径精确回放原 grant。
    await expect(state.coordinator.issue(request)).resolves.toEqual(grant);
    expect(findSpy).toHaveBeenCalledTimes(1);
    // 异载荷仍稳定冲突,不得静默改写。
    await expect(
      state.coordinator.issue({
        ...request,
        payloadDigest: `sha256:${"b".repeat(64)}` as Digest,
      }),
    ).rejects.toThrow("idempotency-conflict");
    // 全新键先做一次耐久定点查重；不存在才进入 fresh 签发。
    findSpy.mockClear();
    await expect(
      state.coordinator.issue({ ...request, requestId: "request-fresh" }),
    ).resolves.toBeDefined();
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it("reclaims an adopted asset after it loses all conversation ownership", async () => {
    const state = await fixture({ grantTtlMs: 5, unadoptedRetentionMs: 5 });
    const bytes = Buffer.from("owned-content");
    const asset = ref(bytes);
    const use = {
      scope,
      surfacePrincipal: "surface-1",
      kind: "asset-upload" as const,
      payloadDigest,
    };
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-owned",
      assets: [asset],
      payloadDigest,
    });
    await state.coordinator.append(grant, use, asset, 0, bytes);
    await state.coordinator.assertUploadAdoption({
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-owned",
      assets: [asset],
      payloadDigest,
    });
    state.adopt(asset);
    await state.coordinator.markAdopted([asset]);
    await expect(state.artifacts.has(asset)).resolves.toBe(true);

    // 会话删除使资产失去全部所有权:进入回收候选并从释放时刻起算保留窗。
    // 接管时不再顺带清扫(物理清理唯一 owner 是锚点 GC),临时副本留到本轮 GC
    // 才清:processed/removed 记的是临时副本的清扫,正式字节仍在保留窗内。
    state.setNow("2026-07-24T00:00:00.010Z");
    state.unadopt(asset);
    await expect(
      state.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 1, removed: 1, hasMore: false });
    await expect(state.artifacts.has(asset)).resolves.toBe(true);

    state.setNow("2026-07-24T00:00:00.020Z");
    const collected = await state.coordinator.collectExpiredTemporaryAssets();
    expect(collected.removed).toBe(1);
    await expect(state.artifacts.has(asset)).resolves.toBe(false);
    expect(
      state.deletionBatches.some((batch) =>
        batch.some((reference) => reference.digest === asset.digest)
      ),
    ).toBe(true);
  });

  it("rebuilds reclaim candidates for released leaves after a restart", async () => {
    const state = await fixture({ grantTtlMs: 5, unadoptedRetentionMs: 5 });
    const bytes = Buffer.from("released-then-crashed");
    const asset = ref(bytes);
    const use = {
      scope,
      surfacePrincipal: "surface-1",
      kind: "asset-upload" as const,
      payloadDigest,
    };
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-released-crash",
      assets: [asset],
      payloadDigest,
    });
    await state.coordinator.append(grant, use, asset, 0, bytes);
    await state.coordinator.assertUploadAdoption({
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-released-crash",
      assets: [asset],
      payloadDigest,
    });
    state.adopt(asset);
    await state.coordinator.markAdopted([asset]);
    await expect(state.artifacts.has(asset)).resolves.toBe(true);

    // 会话删除后进程崩溃:释放事件未被消费,恢复必须从权威投影的
    // 已死叶集合重建回收候选,资产不得永久滞留。
    state.unadopt(asset);
    state.releaseLeaf(asset);
    const restarted = state.restart();
    state.setNow("2026-07-24T00:00:00.030Z");
    // 稳定释放时刻早已越过保留窗，重启不得重置期限。本轮同时完成两件事:
    // 清扫接管遗留的临时副本(cleanup 集合跨重启耐久),回收越过保留窗的正式字节。
    await expect(
      restarted.coordinator.collectExpiredTemporaryAssets(),
    ).resolves.toEqual({ processed: 2, removed: 2, hasMore: false });
    await expect(restarted.artifacts.has(asset)).resolves.toBe(false);
  });
});

describe("surface asset collection capacity", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  function singleSlotGovernor() {
    const classWeights = {
      "workload-interactive": 1,
      "workload-advancement": 1,
      "workload-scheduler": 1,
      "workload-orchestration": 1,
      "storage-foreground": 1,
      "storage-recovery": 1,
      "storage-background": 1,
    } as const;
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: {
        version: 1,
        // 单槽:任何嵌套准入都会立刻自锁,是这条修复最尖锐的形态。
        occupancy: {
          memoryReservationBytes: 1024 * 1024 * 1024,
          temporaryBytes: 1024 * 1024 * 1024,
          slots: 1,
          memorySafetyReserveBytes: 0,
          temporarySafetyReserveBytes: 0,
        },
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
        pressure: { maxCpuBusyRatio: 1, minimumAvailableMemoryBytes: 0 },
        retryAfterMs: 1,
        classWeights,
      },
      probe: () => ({
        cpuBusyRatio: 0,
        availableMemoryBytes: 1024 * 1024 * 1024,
        processRssBytes: 0,
        temporaryBytesAvailable: 1024 * 1024 * 1024,
      }),
    });
    const governor = new DefaultStorageMaintenanceGovernor({ capacity: arbiter });
    const acquired: string[] = [];
    const requests: Parameters<typeof governor.acquire>[0][] = [];
    const wrapped = {
      acquire: (request: Parameters<typeof governor.acquire>[0], abort: AbortSignal) => {
        acquired.push(request.kind);
        requests.push(request);
        return governor.acquire(request, abort);
      },
      snapshot: () => governor.snapshot(),
    };
    return { governor: wrapped, acquired, requests };
  }

  async function expiredTemporaryAsset(storageMaintenance: {
    acquire: (...args: never[]) => unknown;
  }) {
    const state = await fixture({
      unadoptedRetentionMs: 10,
      grantTtlMs: 1,
      storageMaintenance:
        storageMaintenance as unknown as SurfaceAssetCoordinatorOptions["storageMaintenance"],
    });
    const bytes = Buffer.from("temporary");
    const asset = ref(bytes);
    const grant = await state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-1",
      requestId: "request-capacity-gc",
      assets: [asset],
      payloadDigest,
    });
    await state.coordinator.append(
      grant,
      { scope, surfacePrincipal: "surface-1", kind: "asset-upload", payloadDigest },
      asset,
      0,
      bytes,
    );
    state.setNow("2026-07-24T00:00:00.012Z");
    return { ...state, asset };
  }

  it("completes a collection cycle on a single-slot device", async () => {
    const { governor } = singleSlotGovernor();
    const { coordinator, temporaryArtifacts, asset } =
      await expiredTemporaryAsset(governor);

    // 外层若持整批次 permit,内层生命周期准入就再也拿不到唯一那个槽位,
    // 这次调用会永远挂起。它必须正常收敛。
    await expect(coordinator.collectExpiredTemporaryAssets()).resolves.toEqual({
      processed: 1,
      removed: 1,
      hasMore: false,
    });
    await expect(temporaryArtifacts.has(asset)).resolves.toBe(false);
  });

  it("routes adopted cleanup permits through the collection owner", async () => {
    const { governor, acquired } = singleSlotGovernor();
    const state = await fixture({
      storageMaintenance:
        governor as unknown as SurfaceAssetCoordinatorOptions[
          "storageMaintenance"
        ],
    });
    const adopted = ref(Buffer.from("adopted-governed"));
    state.adopt(adopted);
    state.ledger.seedTemporary(adopted);
    acquired.length = 0;

    await state.coordinator.markAdopted([adopted]);

    expect(acquired.filter((kind) => kind === "asset-gc")).toHaveLength(0);
    await expect(state.ledger.adoptedTemporary(1)).resolves.toHaveLength(1);

    await state.coordinator.collectExpiredTemporaryAssets();

    // partial 与完整临时件是两个独立物理步骤，各自在设施串行区内准入。
    expect(acquired.filter((kind) => kind === "asset-gc")).toHaveLength(2);
    await expect(state.ledger.adoptedTemporary(1)).resolves.toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("counts a discarded temporary even if the ledger update is backpressured", async () => {
    const { governor } = singleSlotGovernor();
    // 用真实上传造出真实临时件:没有文件就删不掉,出账自然是 0,那样的用例
    // 证明不了记账与物理副作用是否同步。
    const state = await expiredTemporaryAsset(governor);
    state.adopt(state.asset);
    state.ledger.seedTemporary(state.asset);
    // 权威状态更新经生命周期索引自取容量,在串行段内零等待,确实会背压——
    // 而它的插点恰好在物理删除之后。
    state.ledger.markTemporaryRemoved = async () => {
      throw new StorageMaintenanceAdmissionError({
        kind: "backpressured",
        blockedBy: "slots",
        retryAfterMs: 1,
      });
    };

    const result = await state.coordinator.collectExpiredTemporaryAssets();

    // 报告值必须跟得上真实物理效果:文件已经删了,出账就不能说没删。
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.hasMore).toBe(true);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("does not make adoption wait on cleanup capacity", async () => {
    const { governor } = backpressureGovernor(Number.MAX_SAFE_INTEGER);
    const state = await fixture({
      storageMaintenance:
        governor as unknown as SurfaceAssetCoordinatorOptions[
          "storageMaintenance"
        ],
    });
    const adopted = ref(Buffer.from("adopted-backpressured"));
    state.adopt(adopted);
    state.ledger.seedTemporary(adopted);

    // 接管只确认耐久归属，不进入容量治理或执行物理回收。
    await expect(state.coordinator.markAdopted([adopted])).resolves
      .toBeUndefined();
    // 候选来自耐久集合，由下一轮 GC owner 消费，义务不丢。
    await expect(state.ledger.adoptedTemporary(1)).resolves.toHaveLength(1);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  /** 一律背压的 governor:用来验证拿不到容量时的真实行为,而不是只验请求参数。 */
  function backpressureGovernor(grantAfter: number) {
    let acquires = 0;
    const governor = {
      acquire: async () => {
        acquires += 1;
        return acquires > grantAfter
          ? {
            kind: "granted" as const,
            permit: {
              granted: {
                memoryReservationBytes: 0,
                temporaryBytes: 0,
                slots: 0,
                readBytes: Number.MAX_SAFE_INTEGER,
                writeBytes: Number.MAX_SAFE_INTEGER,
                ioOperations: Number.MAX_SAFE_INTEGER,
              },
              tryBegin: () => ({ claim: () => undefined, complete: () => undefined }),
              release: () => undefined,
            },
          }
          : {
            kind: "backpressured" as const,
            blockedBy: "slots" as const,
            retryAfterMs: 1,
          };
      },
      snapshot: () => ({ queued: {}, inFlight: {} }),
    };
    return { governor, acquires: () => acquires };
  }

  it("degrades a backpressured collection to a no-progress round", async () => {
    const { governor, acquires } = backpressureGovernor(Number.MAX_SAFE_INTEGER);
    const { coordinator } = await expiredTemporaryAsset(governor);

    // 段内准入零等待,拿不到就立刻背压。回收整体幂等,本轮不做进展即可,
    // 不能把背压升级成维护失败,也不能让零进展触发立即续跑。
    const result = await runInMaintenanceContext("background", () =>
      coordinator.collectExpiredTemporaryAssets());
    expect(result).toEqual({ processed: 0, removed: 0, hasMore: true });
    // 调度端的续跑门槛是 `hasMore && processed > 0`,零进展因此不会立即续跑。
    expect(result.hasMore && result.processed > 0).toBe(false);
    expect(acquires()).toBeGreaterThan(0);
  });

  it("never degrades a capacity gap into a quiet no-progress round", async () => {
    // 降级只对"现在没份额"成立。设备根本装不下是不可自愈的故障,吞掉它会让
    // 回收每小时空转一次却永不报错——判据必须窄到只认 backpressured。
    const gapGovernor = {
      acquire: async () => ({
        kind: "capacity-gap" as const,
        blockedBy: "temporaryBytes" as const,
        required: 1024,
        available: 0,
      }),
      snapshot: () => ({ queued: {}, inFlight: {} }),
    };
    const { coordinator } = await expiredTemporaryAsset(gapGovernor);

    await expect(
      runInMaintenanceContext("background", () =>
        coordinator.collectExpiredTemporaryAssets()),
    ).rejects.toThrow(/capacity-gap/);
  });

  it("never retries recovery on a capacity gap", async () => {
    // 段外重试同理:只有背压值得重试,容量缺口必须立刻 fail-closed。
    let synchronizes = 0;
    const state = await fixture({
      ledgerDecorator: (ledger) =>
        new Proxy(ledger, {
          get(target, property, _receiver) {
            if (property === "synchronize") {
              return async () => {
                synchronizes += 1;
                throw new StorageMaintenanceAdmissionError({
                  kind: "capacity-gap",
                  blockedBy: "temporaryBytes",
                  required: 1024,
                  available: 0,
                });
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });

    await expect(
      runInMaintenanceContext("recovery", () => state.coordinator.recover()),
    ).rejects.toThrow(/capacity-gap/);
    // 一次就该结束:进了重试循环就会看到不止一次。
    expect(synchronizes).toBe(1);
  });

  it("retries recovery after backpressure instead of failing startup", async () => {
    // 段内准入零等待,容量紧张时立刻拿到背压。背压不是恢复失败:必须重试到收敛。
    // 重试发生在串行段之外这一点由实现结构保证(重试循环在 `#queue.run` 之外),
    // 公开 API 上观测不到位置差异,依据与重开条件见 X23-17。
    let synchronizes = 0;
    const state = await fixture({
      ledgerDecorator: (ledger) =>
        new Proxy(ledger, {
          get(target, property, _receiver) {
            if (property === "synchronize") {
              return async () => {
                synchronizes += 1;
                if (synchronizes === 1) {
                  throw new StorageMaintenanceAdmissionError({
                    kind: "backpressured",
                    blockedBy: "slots",
                    retryAfterMs: 1,
                  });
                }
                return target.synchronize();
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });

    await expect(
      runInMaintenanceContext("recovery", () => state.coordinator.recover()),
    ).resolves.toBeUndefined();
    // 第一次被背压打断,第二次才完成。
    expect(synchronizes).toBe(2);
  });

  it("retries request-blocking recovery outside the coordinator serial section", async () => {
    let synchronizes = 0;
    const state = await fixture({
      ledgerDecorator: (ledger) =>
        new Proxy(ledger, {
          get(target, property, _receiver) {
            if (property === "synchronize") {
              return async () => {
                synchronizes += 1;
                if (synchronizes === 1) {
                  throw new StorageMaintenanceAdmissionError({
                    kind: "backpressured",
                    blockedBy: "slots",
                    retryAfterMs: 1,
                  });
                }
                return target.synchronize();
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });

    await expect(state.coordinator.issue({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface-recovery-retry",
      requestId: "request-recovery-retry",
      assets: [ref(Buffer.from("request recovery retry"))],
      payloadDigest,
    })).resolves.toMatchObject({ requestId: "request-recovery-retry" });
    expect(synchronizes).toBe(2);
  });

  it("issues zero-wait admissions from the coordinator serial section", async () => {
    const { governor, requests } = singleSlotGovernor();
    const { coordinator } = await expiredTemporaryAsset(governor);

    await runInMaintenanceContext("background", () =>
      coordinator.collectExpiredTemporaryAssets());

    // 回收整体在协调器串行段内跑,段内等待容量会把前台请求一并堵在队列后面。
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.map((request) => request.maxWaitMs)).toEqual(
      requests.map(() => 0),
    );
    // 紧急度由调度器这个顶层所有者给出,叶级不自报。
    expect(requests.map((request) => request.urgency)).toEqual(
      requests.map(() => "background"),
    );
  });

  it("keeps the recovery urgency declared by the startup owner", async () => {
    const { governor, requests } = singleSlotGovernor();
    const { coordinator } = await expiredTemporaryAsset(governor);
    requests.length = 0;

    await runInMaintenanceContext("recovery", () => coordinator.recover());
    await runInMaintenanceContext("recovery", async () => {
      // 恢复已完成时不再产生维护请求,用一次回收驱动出真实准入即可。
      await coordinator.collectExpiredTemporaryAssets();
    });

    // 恢复档必须能真正到达准入点:`recover()` 不得自报前台,也不得被降成后台。
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.map((request) => request.urgency)).toEqual(
      requests.map(() => "recovery"),
    );
  });

  it("takes an asset-gc permit for the physical deletion steps", async () => {
    const { governor, acquired } = singleSlotGovernor();
    const { coordinator } = await expiredTemporaryAsset(governor);

    await coordinator.collectExpiredTemporaryAssets();

    // 叶级零旁路:物理删除必须真的过治理,而不是只有调度器象征性取一次。
    expect(acquired.filter((kind) => kind === "asset-gc").length)
      .toBeGreaterThan(0);
  });

  it("coalesces concurrent collections of the same frontier into one pass", async () => {
    const { governor } = singleSlotGovernor();
    const state = await expiredTemporaryAsset(governor);
    state.deletionBatches.length = 0;

    const [first, second] = await Promise.all([
      state.coordinator.collectExpiredTemporaryAssets(),
      state.coordinator.collectExpiredTemporaryAssets(),
    ]);

    // 同一淘汰时间前沿的两个触发是同一份工作:合流为一轮,而不是各跑一轮。
    expect(first).toEqual(second);
    expect(state.deletionBatches).toHaveLength(1);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("holds no capacity permit while a discard waits for the store lock", async () => {
    const classWeights = {
      "workload-interactive": 1,
      "workload-advancement": 1,
      "workload-scheduler": 1,
      "workload-orchestration": 1,
      "storage-foreground": 1,
      "storage-recovery": 1,
      "storage-background": 1,
    } as const;
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: {
        version: 1,
        occupancy: {
          memoryReservationBytes: 1024 * 1024 * 1024,
          temporaryBytes: 1024 * 1024 * 1024,
          slots: 2,
          memorySafetyReserveBytes: 0,
          temporarySafetyReserveBytes: 0,
        },
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
        pressure: { maxCpuBusyRatio: 1, minimumAvailableMemoryBytes: 0 },
        retryAfterMs: 1,
        classWeights,
      },
      probe: () => ({
        cpuBusyRatio: 0,
        availableMemoryBytes: 1024 * 1024 * 1024,
        processRssBytes: 0,
        temporaryBytesAvailable: 1024 * 1024 * 1024,
      }),
    });
    const governor = new DefaultStorageMaintenanceGovernor({
      capacity: arbiter,
    });
    const { coordinator, temporaryArtifacts } = await expiredTemporaryAsset(
      governor as unknown as Parameters<typeof expiredTemporaryAsset>[0],
    );
    // 占住临时存储的排他段:回收的删除批次必然堵在这把锁上。
    const heldRef = await temporaryArtifacts.put(
      Buffer.from("lock-holder", "utf8"),
    );
    let releaseHeld!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const order: string[] = [];
    const held = temporaryArtifacts.withPresentReferences(
      [heldRef],
      async () => {
        order.push("exclusive-held");
        await gate;
      },
    );
    await vi.waitFor(() => expect(order).toEqual(["exclusive-held"]));

    const collection = coordinator.collectExpiredTemporaryAssets();
    // 回收堵在设施锁上期间,设备上不得有任何未释放的回收容量——整段持
    // permit 等锁就是这里漏出来的(单槽即自锁)。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
    releaseHeld();
    await held;
    const result = await collection;
    expect(result.removed).toBeGreaterThanOrEqual(1);
  }, DURABLE_IO_TEST_TIMEOUT_MS);
});
