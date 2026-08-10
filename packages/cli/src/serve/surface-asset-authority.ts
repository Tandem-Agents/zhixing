import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  FileArtifactStore,
  FileArtifactTemporaryPresenceStore,
  FileResumableArtifactReceiver,
  ArtifactLifecycleIndex,
  AuthorityStorageError,
  DurableProjectionStorageError,
  SurfaceAssetCoordinator,
  collectArtifactRefs,
  surfaceAssetRequestKey,
  validateAdmittedControlEnvelope,
  type DurableLogCheckpoint,
  type ArtifactCheckpointRetentionPort,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
  type DurableProjectionSource,
  type FileAuthorityCommitLog,
  type RebuildableDurableProjectionIndex,
  type SurfaceAssetGrantLedger,
  type SurfaceAssetAuthorityBinding,
  type SurfaceAssetCoordinatorOptions,
  type SurfaceAssetGrantLedgerAppendResult,
  type SurfaceAssetGrantLedgerIssuedResult,
  type SurfaceAssetGrantLedgerSnapshot,
} from "@zhixing/core/authority";
import {
  MAX_SURFACE_ASSET_BYTES,
  type ArtifactRef,
  type CommitEnvelope,
  type ControlEnvelope,
  type ControlRecord,
  type ControlResult,
  type Digest,
  type JsonValue,
  type LogicalRecord,
  type SurfaceAssetGrant,
  type SurfaceAssetScope,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SURFACE_ASSET_PROJECTION_ID = "surface-asset-grants";

export interface CreateSurfaceAssetAuthorityOptions {
  readonly authorityRoot: string;
  readonly log: FileAuthorityCommitLog;
  readonly retentionLogs: readonly FileAuthorityCommitLog[];
  readonly artifacts: FileArtifactStore;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly anchorEpoch: number;
  readonly clock?: () => string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

export type SurfaceAssetAuthority = SurfaceAssetCoordinator & {
  readonly checkpointRetention: ArtifactCheckpointRetentionPort;
};

export function createSurfaceAssetAuthority(
  options: CreateSurfaceAssetAuthorityOptions,
): SurfaceAssetAuthority {
  const built = buildSurfaceAssetAuthority(options);
  const coordinator = SurfaceAssetCoordinator.forStore(built.coordinatorOptions);
  return Object.assign(coordinator, { checkpointRetention: built.lifecycle });
}

export async function rebindSurfaceAssetAuthority(
  authority: SurfaceAssetAuthority,
  options: CreateSurfaceAssetAuthorityOptions,
): Promise<SurfaceAssetAuthority> {
  const built = buildSurfaceAssetAuthority(options);
  const source = built.coordinatorOptions;
  const binding: SurfaceAssetAuthorityBinding = {
    ledger: source.ledger,
    signer: source.signer,
    verifier: source.verifier,
    createGrantId: source.createGrantId,
    canDownload: source.canDownload,
    authorizeScope: source.authorizeScope,
    deleteUnreferencedArtifacts: source.deleteUnreferencedArtifacts,
    listReleasedArtifacts: source.listReleasedArtifacts,
    markReleasedArtifactsReclaimed: source.markReleasedArtifactsReclaimed,
  };
  await authority.rebindAuthority(binding);
  return Object.assign(authority, { checkpointRetention: built.lifecycle });
}

function buildSurfaceAssetAuthority(
  options: CreateSurfaceAssetAuthorityOptions,
): {
  readonly coordinatorOptions: SurfaceAssetCoordinatorOptions;
  readonly lifecycle: ArtifactLifecycleIndex;
} {
  const temporaryArtifacts = new FileArtifactStore(
    path.join(options.authorityRoot, "surface-asset-temporary"),
  );
  const receiver = new FileResumableArtifactReceiver(
    temporaryArtifacts,
    path.join(options.authorityRoot, "surface-asset-partials"),
    { maxArtifactBytes: MAX_SURFACE_ASSET_BYTES },
  );
  const temporaryPresence = new FileArtifactTemporaryPresenceStore(
    path.join(temporaryArtifacts.rootDir, ".presence"),
    { storageMaintenance: options.storageMaintenance },
  );
  const lifecycle = new ArtifactLifecycleIndex({
    rootDir: path.join(options.authorityRoot, "derived"),
    logs: [options.log, ...options.retentionLogs],
    artifacts: options.artifacts,
    temporaryArtifacts,
    temporaryPresence,
    receiver,
    storageMaintenance: options.storageMaintenance,
    maintenanceResourceId: options.artifacts.rootDir,
  });
  const projection = new SurfaceAssetProjection(
    options.log,
    options.artifacts,
    options.anchorEpoch,
    lifecycle,
  );
  const coordinatorOptions: SurfaceAssetCoordinatorOptions = {
    artifacts: options.artifacts,
    temporaryArtifacts,
    receiver,
    ledger: projection,
    signer: options.signer,
    verifier: options.verifier,
    createGrantId,
    canDownload: (scope, refs) => projection.canDownload(scope, refs),
    authorizeScope: (scope) => projection.authorize(scope, options.anchorEpoch),
    listReleasedArtifacts: (before, limit) =>
      lifecycle.releasedBefore(before, limit),
    markReleasedArtifactsReclaimed: (candidates) =>
      lifecycle.markReclaimed(candidates),
    deleteUnreferencedArtifacts: (refs, governDeletion) =>
      options.artifacts.deleteIfUnreferencedBatch(
        refs,
        async (candidates) => lifecycle.retainedAtCurrentHead(candidates),
        governDeletion,
      ),
    ...(options.storageMaintenance
      ? {
        storageMaintenance: options.storageMaintenance,
        maintenanceResourceId: `${options.authorityRoot}/artifacts`,
      }
      : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  };
  return { coordinatorOptions, lifecycle };
}

class SurfaceAssetProjection implements SurfaceAssetGrantLedger {
  readonly #grantIndex: RebuildableDurableProjectionIndex;

  constructor(
    private readonly log: FileAuthorityCommitLog,
    private readonly artifacts: FileArtifactStore,
    private readonly anchorEpoch: number,
    private readonly lifecycle: ArtifactLifecycleIndex,
  ) {
    this.#grantIndex = log.durableProjection({
      projectionId: SURFACE_ASSET_PROJECTION_ID,
      reducerVersion: 7,
      reduce: (envelope, current, source) =>
        reduceSurfaceAssetIndex(
          envelope,
          current,
          source,
          this.artifacts,
        ),
    });
  }

  synchronize(): Promise<void> {
    return this.lifecycle.synchronize();
  }

  stopStorageMaintenance(): void {
    this.lifecycle.stopStorageMaintenance();
  }

  async load(): Promise<SurfaceAssetGrantLedgerSnapshot> {
    try {
      return await this.#load();
    } catch (error) {
      if (!(error instanceof SurfaceAssetProjectionValueError)) throw error;
      await this.#grantIndex.rebuild();
      return this.#load();
    }
  }

  async #load(): Promise<SurfaceAssetGrantLedgerSnapshot> {
    const durableTimeValue = await this.#grantIndex.get(
      SURFACE_GRANT_TIME_KEY,
    );
    const durableTime = storedDurableTime(durableTimeValue);
    return { records: [], ...(durableTime ? { durableTime } : {}) };
  }

  async findIssuedByRequestKey(
    requestKey: string,
  ): Promise<SurfaceAssetGrant | undefined> {
    try {
      return await this.#findIssuedByRequestKey(requestKey);
    } catch (error) {
      if (!(error instanceof SurfaceGrantSourceBindingError)) throw error;
      await this.#grantIndex.rebuild();
      return this.#findIssuedByRequestKey(requestKey);
    }
  }

  async #findIssuedByRequestKey(
    requestKey: string,
  ): Promise<SurfaceAssetGrant | undefined> {
    const value = await this.#grantIndex.get(surfaceGrantRequestKey(requestKey));
    if (value === undefined) return undefined;
    const issued = storedSurfaceGrant(value);
    const checkpoint = (await this.#grantIndex.checkpoints()).authority;
    if (
      !checkpoint ||
      issued.source.checkpoint.logId !== checkpoint.logId ||
      issued.source.checkpoint.lsn > checkpoint.lsn
    ) {
      throw corruptGrantSource(
        "Surface grant request index points beyond its source log",
      );
    }
    let envelope: CommitEnvelope<JsonValue>;
    try {
      envelope = await this.log.readEnvelopeAt<JsonValue>(
        issued.source.checkpoint,
      );
    } catch (error) {
      if (!(error instanceof AuthorityStorageError)) throw error;
      throw corruptGrantSource(
        "Surface grant request index source cannot be resolved",
        { cause: error },
      );
    }
    if (
      envelope.envelopeDigest !== issued.source.envelopeDigest ||
      !envelope.entries.some((entry) => {
        if (entry.stream !== "control") return false;
        const body = entry.body as unknown as ControlRecord;
        return (
          body.t === "asset-grant-issued" &&
          canonicalize(body.grant) === canonicalize(issued.grant)
        );
      })
    ) {
      throw corruptGrantSource(
        "Surface grant request index is not bound to its authority envelope",
      );
    }
    if (
      surfaceAssetRequestKey(
        issued.grant.scope,
        issued.grant.surfacePrincipal,
        issued.grant.requestId,
      ) !== requestKey
    ) {
      throw corruptGrantSource(
        "Surface grant request index key is not bound to its grant",
      );
    }
    return issued.grant;
  }

  findActiveGrant(
    grantId: string,
    expected?: SurfaceAssetGrant,
  ): Promise<SurfaceAssetGrant | undefined> {
    return this.lifecycle.activeGrant(grantId, expected);
  }

  listActiveConversationGrants(
    conversationId: string,
    limit: number,
  ): Promise<readonly SurfaceAssetGrant[]> {
    return this.lifecycle.activeConversationGrants(conversationId, limit);
  }

  listActiveSurfaceGrants(
    surfacePrincipal: string,
    limit: number,
  ): Promise<readonly SurfaceAssetGrant[]> {
    return this.lifecycle.activeSurfaceGrants(surfacePrincipal, limit);
  }

  nextActiveGrantExpiry(): Promise<string | undefined> {
    return this.lifecycle.nextGrantExpiry();
  }

  quotaSnapshot(
    scope: SurfaceAssetScope,
    refs: readonly ArtifactRef[],
  ) {
    return this.lifecycle.quotaSnapshot(scope, refs);
  }

  isRetainedReference(ref: ArtifactRef) {
    return this.lifecycle.isRetainedReference(ref);
  }

  recordTemporaryPresence(ref: ArtifactRef, scopeIdentity: string) {
    return this.lifecycle.recordTemporaryPresence(ref, scopeIdentity);
  }

  settleTemporaryPresence(
    ref: ArtifactRef,
    scopeIdentity: string,
    landed: boolean,
  ) {
    return this.lifecycle.settleTemporaryPresence(ref, scopeIdentity, landed);
  }

  temporaryBefore(before: string, limit: number) {
    return this.lifecycle.temporaryBefore(before, limit);
  }

  adoptedTemporary(limit: number) {
    return this.lifecycle.adoptedTemporary(limit);
  }

  markTemporaryRemoved(ref: ArtifactRef) {
    return this.lifecycle.markTemporaryRemoved(ref);
  }

  async append(
    record: Extract<
      ControlRecord,
      { t: "asset-grant-revoked" | "authority-time-frontier" }
    >,
  ): Promise<SurfaceAssetGrantLedgerAppendResult> {
    const commit = await this.log.append<ControlRecord>([
      { stream: "control", body: record },
    ]);
    return {
      durableTime: record.t === "authority-time-frontier"
        ? latestTime(commit.at, record.frontier)
        : commit.at,
    };
  }

  async appendIssued(
    record: Extract<ControlRecord, { t: "asset-grant-issued" }>,
  ): Promise<SurfaceAssetGrantLedgerIssuedResult> {
    try {
      return await this.#appendIssued(record);
    } catch (error) {
      if (!(error instanceof SurfaceAssetProjectionValueError)) throw error;
      await this.#grantIndex.rebuild();
      return this.#appendIssued(record);
    }
  }

  async #appendIssued(
    record: Extract<ControlRecord, { t: "asset-grant-issued" }>,
  ): Promise<SurfaceAssetGrantLedgerIssuedResult> {
    const transaction = await this.log.transactDurableProjection<
      ControlRecord,
      SurfaceAssetGrantLedgerIssuedResult
    >(
      SURFACE_ASSET_PROJECTION_ID,
      async (current, context) => {
        if (
          !(await authorizeSurfaceScope(
            current,
            record.grant.scope,
            this.anchorEpoch,
          ))
        ) {
          return {
            kind: "return",
            value: { accepted: false, durableTime: context.at },
          };
        }
        const durableTime = latestTime(context.at, record.grant.issuedAt);
        const entries: Array<LogicalRecord<ControlRecord>> = [];
        if (Date.parse(record.grant.issuedAt) > Date.parse(context.at)) {
          entries.push({
            stream: "control",
            body: {
              t: "authority-time-frontier",
              frontier: record.grant.issuedAt,
            },
          });
        }
        entries.push({ stream: "control", body: record });
        return {
          kind: "append",
          entries,
          value: { accepted: true, durableTime },
        };
      },
    );
    return transaction.value;
  }

  async canDownload(
    scope: SurfaceAssetScope,
    refs: readonly ArtifactRef[],
  ): Promise<boolean> {
    try {
      return await this.#canDownload(scope, refs);
    } catch (error) {
      if (!(error instanceof SurfaceAssetProjectionValueError)) throw error;
      await this.#grantIndex.rebuild();
      return this.#canDownload(scope, refs);
    }
  }

  async #canDownload(
    scope: SurfaceAssetScope,
    refs: readonly ArtifactRef[],
  ): Promise<boolean> {
    const generation = await surfaceScopeGeneration(
      this.#grantIndex,
      scope,
      this.anchorEpoch,
    );
    if (generation === undefined) return false;
    const scopeKey = visibilityScopeKey(scope);
    for (const ref of refs) {
      const value = await this.#grantIndex.get(
        surfaceVisibleKey(scopeKey, generation, ref.digest),
      );
      if (value === undefined) return false;
      const visible = storedVisibleArtifact(
        value,
        scopeKey,
        generation,
        ref.digest,
      );
      if (visible.digest !== ref.digest || visible.bytes !== ref.bytes) {
        return false;
      }
    }
    return true;
  }

  async authorize(
    scope: SurfaceAssetScope,
    anchorEpoch: number,
  ): Promise<boolean> {
    if (anchorEpoch !== this.anchorEpoch) return false;
    try {
      return await authorizeSurfaceScope(
        this.#grantIndex,
        scope,
        this.anchorEpoch,
      );
    } catch (error) {
      if (!(error instanceof SurfaceAssetProjectionValueError)) throw error;
      await this.#grantIndex.rebuild();
      return authorizeSurfaceScope(
        this.#grantIndex,
        scope,
        this.anchorEpoch,
      );
    }
  }
}

const SURFACE_GRANT_TIME_KEY = "meta/durable-time";
const SURFACE_GRANT_HISTORY_PREFIX = "history/";
const SURFACE_CONVERSATION_PREFIX = "visibility/conversation/";
const SURFACE_RECEIVED_PREFIX = "visibility/received/";
const SURFACE_VISIBLE_PREFIX = "visibility/asset/";

interface SurfaceConversationProjection {
  readonly conversationId: string;
  readonly state: "active" | "deleted";
  readonly generation: string;
}

interface SurfaceReceivedProjection {
  readonly requestId: string;
  readonly envelope: JsonValue;
}

interface SurfaceVisibleProjection {
  /**
   * 可见性 scope 的键形式,与 `surfaceVisibleKey` 的构成完全一致。
   *
   * 这里不存完整 `SurfaceAssetScope`:键只由 domain 与 conversationId 定位,
   * 而 owner/anchor epoch 的资格已由 `surfaceScopeGeneration` 单点 fail-closed。
   * 若值再反绑 epoch,写入端就得为凑齐结构填占位常量,读取端又拿真实 epoch 比对,
   * 非默认 epoch 下必然失配并触发无效重建。
   */
  readonly scopeKey: string;
  readonly generation: string;
  readonly ref: ArtifactRef;
}

async function authorizeSurfaceScope(
  current: DurableProjectionReadContext,
  scope: SurfaceAssetScope,
  anchorEpoch: number,
): Promise<boolean> {
  return (await surfaceScopeGeneration(current, scope, anchorEpoch)) !==
    undefined;
}

async function surfaceScopeGeneration(
  current: DurableProjectionReadContext,
  scope: SurfaceAssetScope,
  anchorEpoch: number,
): Promise<string | undefined> {
  if (scope.domain === "global") {
    return scope.anchorEpoch === anchorEpoch
      ? `global:${scope.anchorEpoch}`
      : undefined;
  }
  if (scope.ownerEpoch !== anchorEpoch) return undefined;
  const value = await current.get(
    `${SURFACE_CONVERSATION_PREFIX}${
      encodeProjectionKey(scope.conversationId)
    }`,
  );
  if (value === undefined) return undefined;
  const conversation = storedConversationProjection(
    value,
    scope.conversationId,
  );
  return conversation.state === "active"
    ? conversation.generation
    : undefined;
}

async function reduceSurfaceAssetIndex(
  envelope: CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
  source: DurableProjectionSource,
  artifacts: FileArtifactStore,
): Promise<readonly DurableProjectionMutation[]> {
  try {
    return await reduceSurfaceAssetIndexUnchecked(
      envelope,
      current,
      source,
      artifacts,
    );
  } catch (error) {
    if (
      !(error instanceof SurfaceAssetProjectionValueError) &&
      !(error instanceof SurfaceGrantSourceBindingError)
    ) {
      throw error;
    }
    throw new DurableProjectionStorageError(
      "Surface asset reducer read invalid derived state",
      { cause: error },
    );
  }
}

async function reduceSurfaceAssetIndexUnchecked(
  envelope: CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
  source: DurableProjectionSource,
  artifacts: FileArtifactStore,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations = new SurfaceGrantMutationBuffer(current);
  await reduceSurfaceGrantEntries(envelope, mutations, source);
  for (const entry of envelope.entries) {
    const body = plainRecord(entry.body);
    if (entry.stream === "control" && body?.t === "received") {
      const requestId = String(body.requestId);
      const control = await loadReceivedControlEnvelope(
        body.envelope,
        requestId,
        artifacts,
      );
      if (control !== undefined) {
        mutations.put(
          surfaceReceivedKey(requestId),
          projectionValue({
            requestId,
            envelope: projectionValue(body.envelope),
          } satisfies SurfaceReceivedProjection),
        );
      }
      continue;
    }
    if (entry.stream === "control" && body?.t === "applied") {
      const requestId = String(body.requestId);
      const receivedKey = surfaceReceivedKey(requestId);
      const received = await mutations.get(receivedKey);
      if (received === undefined) {
        throw corruptProjectionValue(
          "Applied control asset projection has no received request",
        );
      }
      const control = await loadReceivedControlEnvelope(
        storedReceivedProjection(received, requestId).envelope,
        requestId,
        artifacts,
      );
      if (control === undefined) {
        throw corruptProjectionValue(
          "Surface received control projection value is invalid",
        );
      }
      const result = await loadControlResult(body.result, artifacts);
      if (result?.status === "ok") {
        await projectAppliedEnvelope(
          mutations,
          control,
          result,
          source,
        );
      }
      mutations.tombstone(receivedKey);
      continue;
    }
    if (!entry.stream.startsWith("run:")) continue;

    const conversationId = entry.stream.slice("run:".length);
    if (body?.kind === "content-asset-index" && Array.isArray(body.entries)) {
      const conversation = await readConversationProjection(
        mutations,
        conversationId,
      );
      if (conversation?.state === "active") {
        await addVisibleReferences(
          mutations,
          conversationVisibilityScopeKey(conversationId),
          conversation.generation,
          collectArtifactRefs(body.entries),
        );
      }
    } else if (body?.t === "session-lifecycle" && body.mutation === "delete") {
      const existing = await readConversationProjection(
        mutations,
        conversationId,
      );
      mutations.put(
        surfaceConversationKey(conversationId),
        projectionValue({
          conversationId,
          state: "deleted",
          generation: existing?.generation ??
            projectionGeneration(source.checkpoint),
        } satisfies SurfaceConversationProjection),
      );
    }
  }
  return mutations.values();
}

async function reduceSurfaceGrantEntries(
  envelope: CommitEnvelope<JsonValue>,
  mutations: SurfaceGrantMutationBuffer,
  source: DurableProjectionSource,
): Promise<void> {
  const durableTime = await mutations.get(SURFACE_GRANT_TIME_KEY);
  let latest = storedDurableTime(durableTime);
  let hasControlRecord = false;
  for (const entry of envelope.entries) {
    if (entry.stream !== "control") continue;
    hasControlRecord = true;
    const body = entry.body as ControlRecord;
    if (body.t === "asset-grant-issued") {
      const grant = body.grant;
      const requestKey = surfaceGrantRequestKey(
        surfaceAssetRequestKey(
          grant.scope,
          grant.surfacePrincipal,
          grant.requestId,
        ),
      );
      const historyKey = surfaceGrantHistoryKey(grant.grantId);
      const stored = storedGrant(envelope, grant, source);
      const existing = await mutations.get(requestKey);
      if (existing !== undefined) {
        const storedExisting = storedSurfaceGrant(existing);
        assertSurfaceGrantRequestBinding(requestKey, storedExisting.grant);
        if (
          canonicalize(storedExisting.grant) !== canonicalize(grant)
        ) {
          if (mutations.hasMutation(requestKey)) {
            throw new Error(
              "Surface grant request has conflicting durable grants",
            );
          }
          throw corruptProjectionValue(
            "Surface grant request index has a conflicting derived grant",
          );
        }
      }
      const historical = await mutations.get(historyKey);
      if (historical !== undefined) {
        const storedHistorical = await resolveSurfaceGrantHistory(
          mutations,
          historyKey,
          historical,
        );
        if (
          canonicalize(storedHistorical.grant) !== canonicalize(grant)
        ) {
          if (mutations.hasMutation(historyKey)) {
            throw new Error(
              "Surface grant id has conflicting durable payloads",
            );
          }
          throw corruptProjectionValue(
            "Surface grant history index has a conflicting derived grant",
          );
        }
      }
      mutations.put(requestKey, existing ?? stored);
      mutations.put(
        historyKey,
        historical ?? surfaceGrantHistoryValue(historyKey, requestKey),
      );
    } else if (body.t === "authority-time-frontier") {
      latest = latestTime(latest, body.frontier);
    }
  }
  if (hasControlRecord) latest = latestTime(latest, envelope.at);
  if (latest !== undefined && latest !== durableTime) {
    mutations.put(SURFACE_GRANT_TIME_KEY, latest);
  }
}

async function projectAppliedEnvelope(
  projection: SurfaceGrantMutationBuffer,
  envelope: ControlEnvelope,
  result: ControlResult,
  source: DurableProjectionSource,
): Promise<void> {
  if (result.status !== "ok") return;
  if (result.body.t === "session-create") {
    projection.put(
      surfaceConversationKey(result.body.conversationId),
      projectionValue({
        conversationId: result.body.conversationId,
        state: "active",
        generation: projectionGeneration(source.checkpoint),
      } satisfies SurfaceConversationProjection),
    );
  }
  if (envelope.body.t === "input") {
    const conversation = await readConversationProjection(
      projection,
      envelope.body.conversationId,
    );
    if (conversation?.state !== "active") {
      throw corruptProjectionValue(
        "Applied conversation input has no active conversation projection",
      );
    }
    await addVisibleReferences(
      projection,
      conversationVisibilityScopeKey(envelope.body.conversationId),
      conversation.generation,
      [...(envelope.body.attachments ?? []), ...envelope.dependencyArtifacts],
    );
  } else if (envelope.body.t === "global-write") {
    const scope: SurfaceAssetScope = {
      domain: "global",
      anchorEpoch: envelope.body.anchorEpoch,
    };
    await addVisibleReferences(
      projection,
      visibilityScopeKey(scope),
      // 全局域的 epoch 由 generation 承载,与 `surfaceScopeGeneration` 一致。
      `global:${scope.anchorEpoch}`,
      collectArtifactRefs([
        envelope.body.mutation,
        envelope.dependencyArtifacts,
      ]),
    );
  }
}

async function addVisibleReferences(
  projection: SurfaceGrantMutationBuffer,
  scopeKey: string,
  generation: string,
  refs: readonly ArtifactRef[],
): Promise<void> {
  for (const ref of refs) {
    const key = surfaceVisibleKey(scopeKey, generation, ref.digest);
    const existing = await projection.get(key);
    if (existing !== undefined) {
      const stored = storedVisibleArtifact(
        existing,
        scopeKey,
        generation,
        ref.digest,
      );
      if (stored.digest !== ref.digest || stored.bytes !== ref.bytes) {
        throw corruptProjectionValue(
          `Visible asset ${ref.digest} has conflicting byte counts`,
        );
      }
      continue;
    }
    projection.put(
      key,
      projectionValue(
        { scopeKey, generation, ref } satisfies SurfaceVisibleProjection,
      ),
    );
  }
}

async function readConversationProjection(
  projection: DurableProjectionReadContext,
  conversationId: string,
): Promise<SurfaceConversationProjection | undefined> {
  const value = await projection.get(surfaceConversationKey(conversationId));
  return value === undefined
    ? undefined
    : storedConversationProjection(value, conversationId);
}

function surfaceConversationKey(conversationId: string): string {
  return `${SURFACE_CONVERSATION_PREFIX}${encodeProjectionKey(conversationId)}`;
}

function surfaceReceivedKey(requestId: string): string {
  return `${SURFACE_RECEIVED_PREFIX}${encodeProjectionKey(requestId)}`;
}

function surfaceVisibleKey(
  scopeKey: string,
  generation: string,
  digest: Digest,
): string {
  return `${SURFACE_VISIBLE_PREFIX}${encodeProjectionKey(scopeKey)}/${
    encodeProjectionKey(generation)
  }/${digest}`;
}

function projectionGeneration(checkpoint: DurableLogCheckpoint): string {
  return `${encodeProjectionKey(checkpoint.logId)}-${
    sortableTimestamp(checkpoint.lsn)
  }`;
}

function storedConversationProjection(
  value: JsonValue,
  conversationId: string,
): SurfaceConversationProjection {
  const record = plainRecord(value);
  if (
    record?.conversationId !== conversationId ||
    (record?.state !== "active" && record?.state !== "deleted") ||
    typeof record.generation !== "string" ||
    record.generation.length === 0
  ) {
    throw corruptProjectionValue(
      "Surface conversation projection value is invalid",
    );
  }
  return {
    conversationId,
    state: record.state,
    generation: record.generation,
  };
}

function storedReceivedProjection(
  value: JsonValue,
  requestId: string,
): SurfaceReceivedProjection {
  const record = plainRecord(value);
  if (record?.requestId !== requestId || record.envelope === undefined) {
    throw corruptProjectionValue(
      "Surface received projection is not bound to its request",
    );
  }
  return { requestId, envelope: projectionValue(record.envelope) };
}

function storedVisibleArtifact(
  value: JsonValue,
  scopeKey: string,
  generation: string,
  digest: Digest,
): ArtifactRef {
  const record = plainRecord(value);
  const ref = plainRecord(record?.ref);
  if (
    record?.scopeKey !== scopeKey ||
    record?.generation !== generation ||
    typeof ref?.digest !== "string" ||
    ref.digest !== digest ||
    !/^sha256:[a-f0-9]{64}$/u.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    (ref.bytes as number) < 0
  ) {
    throw corruptProjectionValue(
      "Surface visible asset projection value is invalid",
    );
  }
  return {
    digest: ref.digest as Digest,
    bytes: ref.bytes as number,
  };
}

function corruptProjectionValue(
  message: string,
  options?: ErrorOptions,
): SurfaceAssetProjectionValueError {
  return new SurfaceAssetProjectionValueError(message, options);
}

class SurfaceAssetProjectionValueError extends DurableProjectionStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SurfaceAssetProjectionValueError";
  }
}

interface StoredSurfaceGrant {
  readonly grant: SurfaceAssetGrant;
  readonly source: {
    readonly checkpoint: DurableLogCheckpoint;
    readonly envelopeDigest: Digest;
  };
}

interface StoredSurfaceGrantHistory {
  readonly key: string;
  readonly requestKey: string;
}

function surfaceGrantRequestKey(requestKey: string): string {
  return `request/${encodeProjectionKey(requestKey)}`;
}

function surfaceGrantHistoryKey(grantId: string): string {
  return `${SURFACE_GRANT_HISTORY_PREFIX}${encodeProjectionKey(grantId)}`;
}

function assertSurfaceGrantRequestBinding(
  key: string,
  grant: SurfaceAssetGrant,
): void {
  const expected = surfaceGrantRequestKey(
    surfaceAssetRequestKey(
      grant.scope,
      grant.surfacePrincipal,
      grant.requestId,
    ),
  );
  if (expected !== key) {
    throw corruptGrantSource(
      "Surface grant request index is not bound to its grant",
    );
  }
}

function assertSurfaceGrantHistoryBinding(
  key: string,
  grant: SurfaceAssetGrant,
): void {
  if (surfaceGrantHistoryKey(grant.grantId) !== key) {
    throw corruptGrantSource(
      "Surface grant history index is not bound to its grant",
    );
  }
}

async function resolveSurfaceGrantHistory(
  current: Pick<DurableProjectionReadContext, "get">,
  historyKey: string,
  value: JsonValue,
): Promise<StoredSurfaceGrant> {
  const history = storedSurfaceGrantHistory(value, historyKey);
  const requestValue = await current.get(history.requestKey);
  if (requestValue === undefined) {
    throw corruptGrantSource(
      "Surface grant history index has no canonical request record",
    );
  }
  const issued = storedSurfaceGrant(requestValue);
  assertSurfaceGrantRequestBinding(history.requestKey, issued.grant);
  assertSurfaceGrantHistoryBinding(historyKey, issued.grant);
  return issued;
}

function encodeProjectionKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sortableTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Projection timestamp must be a non-negative safe integer");
  }
  return value.toString(10).padStart(16, "0");
}

function projectionValue(value: unknown): JsonValue {
  return JSON.parse(canonicalize(value)) as JsonValue;
}

function storedDurableTime(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw corruptProjectionValue(
      "Surface durable time projection value is invalid",
    );
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw corruptProjectionValue(
      "Surface durable time projection value is invalid",
    );
  }
  return value;
}

function storedGrant(
  envelope: CommitEnvelope<JsonValue>,
  grant: SurfaceAssetGrant,
  source: DurableProjectionSource,
): JsonValue {
  return projectionValue({
    grant,
    source: {
      checkpoint: source.checkpoint,
      envelopeDigest: envelope.envelopeDigest,
    },
  });
}

function surfaceGrantHistoryValue(
  key: string,
  requestKey: string,
): JsonValue {
  return projectionValue({
    key,
    requestKey,
  } satisfies StoredSurfaceGrantHistory);
}

function storedSurfaceGrantHistory(
  value: JsonValue,
  key: string,
): StoredSurfaceGrantHistory {
  const record = plainRecord(value);
  if (
    record?.key !== key ||
    typeof record.requestKey !== "string" ||
    record.requestKey.length === 0 ||
    Object.keys(record).length !== 2
  ) {
    throw corruptGrantSource(
      "Surface grant history index is not bound to its key",
    );
  }
  return { key, requestKey: record.requestKey };
}

function storedSurfaceGrant(value: JsonValue): StoredSurfaceGrant {
  const record = plainRecord(value);
  const source = plainRecord(record?.source);
  if (
    record?.grant === undefined ||
    source?.checkpoint === undefined ||
    typeof source?.envelopeDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(source.envelopeDigest)
  ) {
    throw corruptGrantSource("Surface grant request index value is invalid");
  }
  return {
    grant: record.grant as unknown as SurfaceAssetGrant,
    source: {
      checkpoint: durableLogCheckpoint(source.checkpoint),
      envelopeDigest: source.envelopeDigest as Digest,
    },
  };
}

function durableLogCheckpoint(value: unknown): DurableLogCheckpoint {
  const record = plainRecord(value);
  if (
    typeof record?.logId !== "string" ||
    record.logId.length === 0 ||
    !Number.isSafeInteger(record.lsn) ||
    (record.lsn as number) <= 0 ||
    !Number.isSafeInteger(record.frameEndOffset) ||
    (record.frameEndOffset as number) <= 0 ||
    typeof record.prefixDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.prefixDigest)
  ) {
    throw corruptGrantSource("Surface grant source checkpoint is invalid");
  }
  return {
    logId: record.logId,
    lsn: record.lsn as number,
    frameEndOffset: record.frameEndOffset as number,
    prefixDigest: record.prefixDigest as Digest,
  };
}

function corruptGrantSource(
  message: string,
  options?: ErrorOptions,
): DurableProjectionStorageError {
  return new SurfaceGrantSourceBindingError(message, options);
}

class SurfaceGrantSourceBindingError extends DurableProjectionStorageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SurfaceGrantSourceBindingError";
  }
}

class SurfaceGrantMutationBuffer implements DurableProjectionReadContext {
  readonly #mutations = new Map<string, DurableProjectionMutation>();

  constructor(private readonly current: DurableProjectionReadContext) {}

  hasMutation(key: string): boolean {
    return this.#mutations.has(key);
  }

  async get(key: string): Promise<JsonValue | undefined> {
    const mutation = this.#mutations.get(key);
    if (mutation) {
      return mutation.kind === "put" ? mutation.value : undefined;
    }
    return this.current.get(key);
  }

  scan(
    range: Parameters<DurableProjectionReadContext["scan"]>[0],
    limit: number,
    continuation?: string,
  ) {
    return this.current.scan(range, limit, continuation);
  }

  put(key: string, value: JsonValue): void {
    this.#mutations.set(key, { kind: "put", key, value });
  }

  tombstone(key: string): void {
    this.#mutations.set(key, { kind: "tombstone", key });
  }

  values(): readonly DurableProjectionMutation[] {
    return [...this.#mutations.values()];
  }
}
async function loadControlEnvelope(
  value: unknown,
  artifacts: FileArtifactStore,
): Promise<ControlEnvelope | undefined> {
  const record = plainRecord(value);
  if (!record) return undefined;
  if (
    Object.keys(record).length === 1 &&
    plainRecord(record.ref) !== undefined
  ) {
    const refs = collectArtifactRefs(record);
    const ref = refs[0];
    if (!ref) return undefined;
    const bytes = await artifacts.get(ref);
    return validateAdmittedControlEnvelope(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
  }
  return validateAdmittedControlEnvelope(value);
}

async function loadReceivedControlEnvelope(
  value: unknown,
  requestId: string,
  artifacts: FileArtifactStore,
): Promise<ControlEnvelope | undefined> {
  try {
    const envelope = await loadControlEnvelope(value, artifacts);
    if (envelope !== undefined && envelope.requestId !== requestId) {
      throw corruptProjectionValue(
        "Surface received projection does not match its control envelope",
      );
    }
    return envelope;
  } catch (error) {
    if (error instanceof SurfaceAssetProjectionValueError) throw error;
    if (
      !(error instanceof TypeError) &&
      !(error instanceof SyntaxError) &&
      !(error instanceof AuthorityStorageError)
    ) {
      throw error;
    }
    throw corruptProjectionValue(
      "Surface received projection contains an invalid control envelope",
      { cause: error },
    );
  }
}

async function loadControlResult(
  value: unknown,
  artifacts: FileArtifactStore,
): Promise<ControlResult | undefined> {
  const record = plainRecord(value);
  if (!record) return undefined;
  if (
    Object.keys(record).length === 1 &&
    plainRecord(record.ref) !== undefined
  ) {
    const ref = collectArtifactRefs(record)[0];
    if (!ref) return undefined;
    const bytes = await artifacts.get(ref);
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as ControlResult;
  }
  return value as ControlResult;
}

function visibilityScopeKey(scope: SurfaceAssetScope): string {
  return scope.domain === "conversation"
    ? conversationVisibilityScopeKey(scope.conversationId)
    : "global";
}

/** 写入端只掌握 conversationId,与读取端共用同一键形式,避免各自拼装。 */
function conversationVisibilityScopeKey(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function plainRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    ? value as Record<string, unknown>
    : undefined;
}

function latestTime(left: string | undefined, right: string): string {
  const rightTime = Date.parse(right);
  if (!Number.isFinite(rightTime) || new Date(rightTime).toISOString() !== right) {
    throw new TypeError("Authority time frontier must be a canonical ISO timestamp");
  }
  if (left === undefined) return right;
  return Date.parse(left) >= rightTime ? left : right;
}

function createGrantId(at: string): string {
  const timestamp = Date.parse(at);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 0xffffffffffff
  ) {
    throw new TypeError("Surface grant timestamp is outside the ULID range");
  }
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  randomBytes(10).copy(bytes, 6);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `grt-${encoded}`;
}
