import type {
  ArtifactRef,
  AuthorityCatalog,
  HomeTrustEvent,
  HomeTrustRecord,
} from "@zhixing/core/contracts";
import type {
  DurableLogCheckpoint,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import {
  anchorTransferCommitDigest,
  canonicalize,
  protocolDigest,
} from "@zhixing/core/protocol";
import type { AnchorTransferCommit } from "@zhixing/core/contracts";

type DisasterCommit = Extract<AnchorTransferCommit, { mode: "disaster-recovery" }>;

export interface DisasterRecoveryInstallation {
  readonly v: 1;
  readonly t: "disaster-anchor-installed";
  readonly transferId: string;
  readonly recoveryRootPublicKey: string;
  readonly commit: DisasterCommit;
  readonly transition: HomeTrustEvent;
  readonly revoke: HomeTrustEvent;
  readonly trustRecord: HomeTrustRecord;
  readonly authorityRecords: ArtifactRef;
  readonly catalog: ArtifactRef;
  readonly sourceHead: DurableLogCheckpoint;
  readonly baseDigest: string;
}

export interface DisasterInstalledAuthorityGeneration {
  readonly mode: "disaster-recovery";
  readonly transferId: string;
  readonly commitDigest: string;
  readonly baseDigest: string;
  readonly sourceHead: DurableLogCheckpoint;
  readonly targetLogId: string;
  readonly installLsn: number;
  readonly anchorEpoch: number;
  readonly trustEpoch: number;
  readonly trustChainHead: HomeTrustRecord["chainHead"];
}

export function createDisasterRecoveryInstallation(input: {
  readonly commit: DisasterCommit;
  readonly recoveryRootPublicKey: string;
  readonly transition: HomeTrustEvent;
  readonly revoke: HomeTrustEvent;
  readonly trustRecord: HomeTrustRecord;
  readonly authorityRecords: ArtifactRef;
  readonly catalog: ArtifactRef;
  readonly sourceHead: DurableLogCheckpoint;
}): DisasterRecoveryInstallation {
  return Object.freeze({
    v: 1,
    t: "disaster-anchor-installed",
    transferId: input.commit.transferId,
    recoveryRootPublicKey: input.recoveryRootPublicKey,
    commit: input.commit,
    transition: input.transition,
    revoke: input.revoke,
    trustRecord: input.trustRecord,
    authorityRecords: input.authorityRecords,
    catalog: input.catalog,
    sourceHead: { ...input.sourceHead },
    baseDigest: protocolDigest("DisasterRecoveryAuthorityBase", 1, {
      authorityRecords: input.authorityRecords,
      catalog: input.catalog,
      recoveryRootPublicKey: input.recoveryRootPublicKey,
      sourceHead: input.sourceHead,
    }),
  });
}

export function isDisasterRecoveryInstallation(
  value: unknown,
): value is DisasterRecoveryInstallation {
  return typeof value === "object" && value !== null &&
    (value as { v?: unknown }).v === 1 &&
    (value as { t?: unknown }).t === "disaster-anchor-installed" &&
    typeof (value as { transferId?: unknown }).transferId === "string";
}

export async function loadCurrentDisasterRecoveryInstallation(
  log: FileAuthorityCommitLog,
): Promise<{
  readonly installation: DisasterRecoveryInstallation;
  readonly installLsn: number;
  readonly generation: DisasterInstalledAuthorityGeneration;
} | undefined> {
  const all = await log.readStream<unknown>("transfer:anchor-current");
  const currentRecord = all.at(-1);
  if (!currentRecord || !isDisasterRecoveryInstallation(currentRecord.body)) return undefined;
  const current = { ...currentRecord, body: currentRecord.body };
  const records = all.filter((record): record is typeof record & {
    readonly body: DisasterRecoveryInstallation;
  } => isDisasterRecoveryInstallation(record.body));
  if (records.filter((record) => record.body.transferId === current.body.transferId).length !== 1) {
    throw new Error("Current disaster recovery installation is ambiguous");
  }
  const installation = current.body;
  const expectedBase = protocolDigest("DisasterRecoveryAuthorityBase", 1, {
    authorityRecords: installation.authorityRecords,
    catalog: installation.catalog,
    recoveryRootPublicKey: installation.recoveryRootPublicKey,
    sourceHead: installation.sourceHead,
  });
  if (installation.baseDigest !== expectedBase) {
    throw new Error("Disaster recovery authority base digest is invalid");
  }
  if (
    installation.commit.transferId !== installation.transferId ||
    canonicalize(installation.trustRecord.chainHead) !== canonicalize({
      seq: installation.revoke.seq,
      eventDigest: protocolDigest("HomeTrustEvent", 1, unsignedEvent(installation.revoke)),
    })
  ) {
    throw new Error("Disaster recovery installation trust tuple is invalid");
  }
  return Object.freeze({
    installation,
    installLsn: current.lsn,
    generation: Object.freeze({
      mode: "disaster-recovery",
      transferId: installation.transferId,
      commitDigest: anchorTransferCommitDigest(installation.commit),
      baseDigest: installation.baseDigest,
      sourceHead: Object.freeze({ ...installation.sourceHead }),
      targetLogId: (await log.originCheckpoint()).logId,
      installLsn: current.lsn,
      anchorEpoch: installation.commit.nextAnchorEpoch,
      trustEpoch: installation.trustRecord.trustEpoch,
      trustChainHead: Object.freeze({ ...installation.trustRecord.chainHead }),
    }),
  });
}

export function parseInstalledAuthorityCatalog(
  bytes: Uint8Array,
  installation: DisasterRecoveryInstallation,
  parse: (bytes: Uint8Array) => AuthorityCatalog,
): AuthorityCatalog {
  const catalog = parse(bytes);
  if (
    catalog.transferId !== installation.transferId ||
    canonicalize(catalog.source) !== canonicalize(installation.sourceHead)
  ) {
    throw new Error("Disaster recovery catalog does not match its installed authority base");
  }
  return catalog;
}

function unsignedEvent(event: HomeTrustEvent): Omit<HomeTrustEvent, "signature"> {
  const { signature: _, ...unsigned } = event;
  return unsigned;
}
