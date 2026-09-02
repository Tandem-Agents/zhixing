import type {
  ArtifactRef,
  AuthorityCatalog,
  AuthorityCatalogStreamRange,
  CheckpointEnvelope,
  CommitEnvelope,
  DeviceIdentity,
  DisasterRecoveryBaseline,
  FullAuthorityCheckpointPayload,
  HomeTrustEvent,
  RecoveryCheckpointVerification,
} from "@zhixing/core/contracts";
import {
  decodeCommitEnvelope,
  type ArtifactStore,
} from "@zhixing/core/authority";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
} from "@zhixing/core/resources";
import {
  canonicalize,
  prepareAuthorityCatalog,
  protocolDigest,
} from "@zhixing/core/protocol";
import type {
  CheckpointPackage,
} from "@zhixing/mesh/checkpoint";
import {
  createRecoveryCheckpointVerification,
  verifyRecoveryCheckpointVerification,
  verifyStoredFullAuthorityCheckpoint,
} from "@zhixing/mesh/checkpoint";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import {
  homeTrustEventDigest,
  replayTrustChain,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import { PendingObligationTracker } from "./planned-anchor-transfer.js";
import type { DisasterRecoveryStagingReceiver } from "./disaster-recovery-staging.js";

const COVERAGE: AuthorityCatalog["coverage"] = Object.freeze([
  "conversation-authority",
  "conversation-content",
  "execution-assets",
  "global-authority",
  "pending-obligations",
  "trust-and-anchor",
]);

export interface DisasterAuthorityRecordSet {
  readonly v: 1;
  readonly source: FullAuthorityCheckpointPayload["source"];
  readonly pages: readonly {
    readonly seq: number;
    readonly firstLsn: number;
    readonly lastLsn: number;
    readonly recordCount: number;
    readonly ref: ArtifactRef;
  }[];
}

export interface StagedDisasterRecoveryAuthority {
  readonly baseline: DisasterRecoveryBaseline;
  readonly baselineEvents: readonly HomeTrustEvent[];
  readonly trust: TrustProjection;
  readonly onsiteVerification: RecoveryCheckpointVerification;
  readonly payload: FullAuthorityCheckpointPayload;
  readonly authorityRecords: DisasterAuthorityRecordSet;
  readonly authorityRecordsRef: ArtifactRef;
  readonly catalog: AuthorityCatalog;
  readonly catalogRef: ArtifactRef;
}

export async function verifyAndStageDisasterRecoveryAuthority(input: {
  readonly requestId: string;
  readonly transferId: string;
  readonly targetDeviceId: string;
  readonly checkpointTargetId: string;
  readonly checkpoint: CheckpointPackage;
  readonly recoveryRoot: RecoveryRoot;
  readonly trustEvidence: readonly (readonly HomeTrustEvent[])[];
  readonly privateArtifacts: ArtifactStore;
  readonly privateReceiver: DisasterRecoveryStagingReceiver;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly signal?: AbortSignal;
  readonly now?: number;
}): Promise<StagedDisasterRecoveryAuthority> {
  assertIdentity(input.requestId, "Recovery request");
  assertIdentity(input.transferId, "Recovery transfer");
  assertIdentity(input.targetDeviceId, "Recovery target device");
  assertIdentity(input.checkpointTargetId, "Recovery checkpoint target");
  const issuer = checkpointIssuer(input.checkpoint.envelope, input.trustEvidence);
  const staged = await verifyStoredFullAuthorityCheckpoint({
    package: input.checkpoint,
    recoveryRoot: input.recoveryRoot,
    issuer,
    sink: {
      write: async (content, offset, bytes, signal) => {
        if (signal?.aborted) throw signal.reason ?? new Error("Recovery import was cancelled");
        if (await input.privateArtifacts.has(content.ref)) return;
        await input.privateReceiver.append(
          content.ref,
          offset,
          bytes,
          (_identity, operation) => runStorageMaintenanceStep(
            input.storageMaintenance,
            storageMaintenanceRequest(
              "authority-checkpoint",
              input.targetDeviceId,
              {
                transferId: input.transferId,
                checkpointId: input.checkpoint.envelope.checkpointId,
                kind: content.kind,
                index: content.index,
                offset,
                phase: "disaster-private-import",
              },
              { obligation: "pre-commit" },
            ),
            operation,
          ),
        );
      },
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const checkpointEvents = await readCheckpointTrustEvents(
    input.privateArtifacts,
    staged.payload,
  );
  const selected = selectRecoveryBaseline({
    payload: staged.payload,
    recoveryRoot: input.recoveryRoot,
    targetDeviceId: input.targetDeviceId,
    checkpointEvents,
    trustEvidence: input.trustEvidence,
  });
  if (
    staged.payload.issuer.deviceId !== issuer.deviceId ||
    staged.payload.issuer.keyId !== input.checkpoint.envelope.signature.keyId
  ) {
    throw new TypeError("Recovery checkpoint issuer does not match its signed envelope");
  }
  const onsiteVerification = createRecoveryCheckpointVerification({
    envelope: input.checkpoint.envelope,
    targetId: input.checkpointTargetId,
    verificationNonce: staged.verificationNonce,
    verifiedAt: new Date(input.now ?? Date.now()).toISOString(),
    recoveryRoot: input.recoveryRoot,
  });
  verifyRecoveryCheckpointVerification({
    verification: onsiteVerification,
    envelope: input.checkpoint.envelope,
    targetId: input.checkpointTargetId,
    verificationNonce: staged.verificationNonce,
    recoveryRootPublicKey: input.recoveryRoot.rootPublicKey,
  });
  staged.verificationNonce.fill(0);
  const built = await buildDisasterRecoveryCatalog({
    transferId: input.transferId,
    targetDeviceId: input.targetDeviceId,
    baseline: selected.baseline,
    baselineEvents: selected.events,
    trust: selected.trust,
    payload: staged.payload,
    privateArtifacts: input.privateArtifacts,
  });
  return Object.freeze({
    baseline: selected.baseline,
    baselineEvents: selected.events,
    trust: selected.trust,
    onsiteVerification,
    payload: staged.payload,
    ...built,
  });
}

export function selectRecoveryBaseline(input: {
  readonly payload: FullAuthorityCheckpointPayload;
  readonly recoveryRoot: RecoveryRoot;
  readonly targetDeviceId: string;
  readonly checkpointEvents: readonly HomeTrustEvent[];
  readonly trustEvidence: readonly (readonly HomeTrustEvent[])[];
}): {
  readonly baseline: DisasterRecoveryBaseline;
  readonly events: readonly HomeTrustEvent[];
  readonly trust: TrustProjection;
} {
  if (input.trustEvidence.length === 0) {
    throw new TypeError("Recovery requires a durable signed trust chain");
  }
  const candidates = [input.checkpointEvents, ...input.trustEvidence].map((events) => ({
    events: [...events],
    projection: replayTrustChain(events),
  }));
  if (
    input.checkpointEvents.length !== input.payload.trustChainHead.seq + 1 ||
    homeTrustEventDigest(input.checkpointEvents.at(-1)!) !== input.payload.trustChainHead.eventDigest
  ) {
    throw new TypeError("Recovery evidence does not contain the checkpoint trust prefix");
  }
  for (const candidate of candidates) {
    if (candidate.projection.homeId !== input.payload.homeId) {
      throw new TypeError("Recovery trust evidence belongs to another home");
    }
    assertCompatibleChains(input.checkpointEvents, candidate.events);
  }
  const ordered = [...candidates].sort((left, right) => right.events.length - left.events.length);
  const selected = ordered[0]!;
  for (const candidate of ordered.slice(1)) assertCompatibleChains(candidate.events, selected.events);
  const root = input.recoveryRoot.publicIdentity();
  if (
    selected.projection.recoveryRootPublicKey !== root.rootPublicKey ||
    selected.projection.recoveryBackupPublicKey !== root.backupPublicKey
  ) {
    throw new TypeError("Recovery package is not the current recovery root");
  }
  const target = selected.projection.members.find((member) =>
    member.device.deviceId === input.targetDeviceId);
  if (!target || target.state !== "active" || !target.roles.includes("anchor")) {
    throw new TypeError("Recovery target is not an active duty-capable device");
  }
  return Object.freeze({
    events: Object.freeze([...selected.events]),
    trust: selected.projection,
    baseline: Object.freeze({
      homeId: selected.projection.homeId,
      anchorEpoch: anchorEpoch(selected.events),
      trustEpoch: selected.projection.trustEpoch,
      chainHead: { ...selected.projection.chainHead },
      issuer: { ...selected.projection.issuer },
      recoveryRoot: {
        rootKeyId: root.rootKeyId,
        recipientKeyId: root.backupKeyId,
      },
    }),
  });
}

export async function buildDisasterRecoveryCatalog(input: {
  readonly transferId: string;
  readonly targetDeviceId: string;
  readonly baseline: DisasterRecoveryBaseline;
  readonly baselineEvents: readonly HomeTrustEvent[];
  readonly trust: TrustProjection;
  readonly payload: FullAuthorityCheckpointPayload;
  readonly privateArtifacts: ArtifactStore;
}): Promise<{
  readonly authorityRecords: DisasterAuthorityRecordSet;
  readonly authorityRecordsRef: ArtifactRef;
  readonly catalog: AuthorityCatalog;
  readonly catalogRef: ArtifactRef;
}> {
  const streams = new Map<string, AuthorityCatalogStreamRange>();
  const pending = new PendingObligationTracker();
  let expectedLsn = 1;
  let prefixDigest = protocolDigest("AuthorityLogPrefix", 1, { logId: input.payload.source.logId });
  let recordCount = 0;
  const pages: DisasterAuthorityRecordSet["pages"][number][] = [];
  for (const [index, descriptor] of input.payload.records.pages.entries()) {
    const ref = { digest: descriptor.digest, bytes: descriptor.bytes };
    const commits = await readAuthorityPage(input.privateArtifacts, ref);
    if (
      descriptor.seq !== index || commits.length === 0 ||
      commits[0]!.lsn !== descriptor.firstLsn ||
      commits.at(-1)!.lsn !== descriptor.lastLsn
    ) throw new TypeError("Recovery authority page does not match its directory");
    let pageRecords = 0;
    for (const commit of commits) {
      if (commit.lsn !== expectedLsn) throw new TypeError("Recovery authority prefix is not contiguous");
      expectedLsn += 1;
      prefixDigest = protocolDigest("AuthorityLogPrefix", 1, {
        logId: input.payload.source.logId,
        previousDigest: prefixDigest,
        lsn: commit.lsn,
        envelopeDigest: commit.envelopeDigest,
      });
      pending.accept(commit);
      for (const entry of commit.entries) {
        pageRecords += 1;
        recordCount += 1;
        const prior = streams.get(entry.stream);
        streams.set(entry.stream, {
          stream: entry.stream,
          firstLsn: prior?.firstLsn ?? commit.lsn,
          lastLsn: commit.lsn,
          recordCount: (prior?.recordCount ?? 0) + 1,
          digest: protocolDigest("AuthorityCatalogStream", 1, {
            stream: entry.stream,
            ...(prior ? { previousDigest: prior.digest } : {}),
            lsn: commit.lsn,
            body: entry.body,
          }),
        });
      }
    }
    if (pageRecords !== descriptor.recordCount) {
      throw new TypeError("Recovery authority page record count is invalid");
    }
    pages.push({
      seq: descriptor.seq,
      firstLsn: descriptor.firstLsn,
      lastLsn: descriptor.lastLsn,
      recordCount: descriptor.recordCount,
      ref,
    });
  }
  if (
    expectedLsn - 1 !== input.payload.source.lsn ||
    recordCount !== input.payload.records.count ||
    prefixDigest !== input.payload.source.prefixDigest
  ) throw new TypeError("Recovery authority pages do not reproduce their source checkpoint");
  const authorityRecords: DisasterAuthorityRecordSet = Object.freeze({
    v: 1,
    source: { ...input.payload.source },
    pages: Object.freeze(pages),
  });
  const authorityBytes = Buffer.from(canonicalize(authorityRecords), "utf8");
  const authorityRecordsRef = await input.privateArtifacts.put(authorityBytes);
  const prepared = prepareAuthorityCatalog({
    v: 1,
    transferId: input.transferId,
    sourceDeviceId: input.payload.issuer.deviceId,
    targetDeviceId: input.targetDeviceId,
    sourceAnchorEpoch: input.baseline.anchorEpoch,
    source: { ...input.payload.source },
    trust: {
      homeId: input.baseline.homeId,
      trustEpoch: input.baseline.trustEpoch,
      chainHead: { ...input.baseline.chainHead },
      issuerDeviceId: input.baseline.issuer.deviceId,
      issuerKeyId: input.baseline.issuer.issuerKeyId,
    },
    coverage: COVERAGE,
    streams: [...streams.values()].sort((left, right) =>
      left.stream.localeCompare(right.stream, "en-US")),
    authorityRecords: authorityRecordsRef,
    retainedArtifacts: [...input.payload.retainedArtifacts.entries],
    pendingObligations: pending.snapshot(),
  });
  const catalogRef = await input.privateArtifacts.put(prepared.bytes);
  if (canonicalize(catalogRef) !== canonicalize(prepared.ref)) {
    throw new TypeError("Recovery catalog storage changed its canonical identity");
  }
  return Object.freeze({
    authorityRecords,
    authorityRecordsRef,
    catalog: prepared.catalog,
    catalogRef,
  });
}

export async function* disasterAuthorityEnvelopes(
  artifacts: ArtifactStore,
  records: DisasterAuthorityRecordSet,
): AsyncGenerator<CommitEnvelope<unknown>> {
  let expectedLsn = 1;
  for (const page of records.pages) {
    for (const commit of await readAuthorityPage(artifacts, page.ref)) {
      if (commit.lsn !== expectedLsn) throw new TypeError("Recovery authority replay is not contiguous");
      expectedLsn += 1;
      yield commit;
    }
  }
  if (expectedLsn - 1 !== records.source.lsn) {
    throw new TypeError("Recovery authority replay does not reach its source head");
  }
}

export function parseDisasterAuthorityRecordSet(
  input: Uint8Array,
): DisasterAuthorityRecordSet {
  const text = Buffer.from(input).toString("utf8");
  const value = JSON.parse(text) as Partial<DisasterAuthorityRecordSet>;
  if (
    canonicalize(value) !== text || value.v !== 1 || !value.source ||
    !Array.isArray(value.pages) || value.pages.length === 0
  ) {
    throw new TypeError("Disaster recovery authority record set is invalid");
  }
  let expectedLsn = 1;
  for (const [index, page] of value.pages.entries()) {
    if (
      page.seq !== index || page.firstLsn !== expectedLsn ||
      page.lastLsn < page.firstLsn || page.recordCount < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(page.ref.digest) || page.ref.bytes < 1
    ) throw new TypeError("Disaster recovery authority record page is invalid");
    expectedLsn = page.lastLsn + 1;
  }
  if (expectedLsn - 1 !== value.source.lsn) {
    throw new TypeError("Disaster recovery authority records do not reach their source head");
  }
  return Object.freeze({
    v: 1,
    source: Object.freeze({ ...value.source }),
    pages: Object.freeze(value.pages.map((page) => Object.freeze({
      ...page,
      ref: Object.freeze({ ...page.ref }),
    }))),
  });
}

async function readAuthorityPage(
  artifacts: ArtifactStore,
  ref: ArtifactRef,
): Promise<readonly CommitEnvelope<unknown>[]> {
  const bytes = await artifacts.get(ref);
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (!Array.isArray(value) || canonicalize(value) !== text) {
    throw new TypeError("Recovery authority page is not a canonical commit array");
  }
  return value.map((commit) =>
    decodeCommitEnvelope(Buffer.from(canonicalize(commit), "utf8")));
}

async function readCheckpointTrustEvents(
  artifacts: ArtifactStore,
  payload: FullAuthorityCheckpointPayload,
): Promise<readonly HomeTrustEvent[]> {
  const events: HomeTrustEvent[] = [];
  for (const descriptor of payload.records.pages) {
    for (const commit of await readAuthorityPage(artifacts, {
      digest: descriptor.digest,
      bytes: descriptor.bytes,
    })) {
      for (const entry of commit.entries) {
        const body = entry.body as { readonly t?: unknown; readonly event?: unknown };
        if (entry.stream === "trust" && body.t === "home-trust-event") {
          events.push(body.event as HomeTrustEvent);
        }
      }
    }
  }
  replayTrustChain(events);
  return Object.freeze(events);
}

function checkpointIssuer(
  envelope: CheckpointEnvelope,
  evidence: readonly (readonly HomeTrustEvent[])[],
): DeviceIdentity {
  let issuer: DeviceIdentity | undefined;
  for (const events of evidence) {
    const projection = replayTrustChain(events);
    const member = projection.members.find((candidate) =>
      candidate.device.deviceId === envelope.signature.keyId);
    if (!member) continue;
    if (issuer && canonicalize(issuer) !== canonicalize(member.device)) {
      throw new TypeError("Recovery evidence disagrees about the checkpoint issuer");
    }
    issuer = member.device;
  }
  if (!issuer) throw new TypeError("Recovery evidence does not contain the checkpoint issuer");
  return issuer;
}

function assertCompatibleChains(
  left: readonly HomeTrustEvent[],
  right: readonly HomeTrustEvent[],
): void {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    if (canonicalize(left[index]) !== canonicalize(right[index])) {
      throw new TypeError("Recovery trust evidence forks from the checkpoint chain");
    }
  }
}

function anchorEpoch(events: readonly HomeTrustEvent[]): number {
  return 1 + events.filter((event) => event.body.t === "issuer-transition").length;
}

function assertIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u.test(value)) {
    throw new TypeError(`${label} identity is invalid`);
  }
}
