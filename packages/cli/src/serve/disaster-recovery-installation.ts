import type {
  ArtifactRef,
  AuthorityCatalog,
  HomeTrustEvent,
  HomeTrustRecord,
  LogicalRecord,
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
const DISASTER_POST_INSTALL_STREAM = "transfer:anchor-disaster-post-install";

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

export interface DisasterRecoveryPostInstallReceipt {
  readonly v: 1;
  readonly t: "disaster-post-install-completed";
  readonly transferId: string;
  readonly generationDigest: string;
  readonly participantsDigest: string;
  readonly readBackDigest: string;
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

export async function recordDisasterRecoveryPostInstallReceipt(input: {
  readonly log: FileAuthorityCommitLog;
  readonly generation: DisasterInstalledAuthorityGeneration;
  readonly participants: readonly string[];
  readonly readBack: readonly {
    readonly kind: AuthorityCatalog["pendingObligations"][number]["kind"];
    readonly id: string;
    readonly disposition: "current-owner" | "terminal";
  }[];
}): Promise<DisasterRecoveryPostInstallReceipt> {
  const receipt = createPostInstallReceipt(input);
  return (await input.log.transactProjection<
    ReadonlyMap<string, DisasterRecoveryPostInstallReceipt>,
    DisasterRecoveryPostInstallReceipt,
    DisasterRecoveryPostInstallReceipt
  >(
    new Map(),
    reducePostInstallReceipts,
    (current) => {
      const existing = current.get(receipt.transferId);
      if (existing) {
        if (canonicalize(existing) !== canonicalize(receipt)) {
          throw new Error("Disaster recovery post-install receipt conflicts with replay");
        }
        return { kind: "return", value: existing };
      }
      return {
        kind: "append",
        entries: [{ stream: DISASTER_POST_INSTALL_STREAM, body: receipt }],
        value: receipt,
      };
    },
    { stream: DISASTER_POST_INSTALL_STREAM },
  )).value;
}

export async function loadDisasterRecoveryPostInstallReceipt(input: {
  readonly log: FileAuthorityCommitLog;
  readonly generation: DisasterInstalledAuthorityGeneration;
}): Promise<DisasterRecoveryPostInstallReceipt | undefined> {
  const receipts = await input.log.rebuildProjection(
    new Map<string, DisasterRecoveryPostInstallReceipt>(),
    reducePostInstallReceipts,
    { stream: DISASTER_POST_INSTALL_STREAM },
  );
  const receipt = receipts.get(input.generation.transferId);
  if (!receipt) return undefined;
  const generationDigest = installedGenerationDigest(input.generation);
  if (receipt.generationDigest !== generationDigest) {
    throw new Error("Disaster recovery post-install receipt belongs to another generation");
  }
  return receipt;
}

export async function waitForDisasterRecoveryPostInstallReceipt(input: {
  readonly log: FileAuthorityCommitLog;
  readonly generation: DisasterInstalledAuthorityGeneration;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<DisasterRecoveryPostInstallReceipt> {
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    if (input.signal?.aborted) throw input.signal.reason;
    const receipt = await loadDisasterRecoveryPostInstallReceipt(input);
    if (receipt) return receipt;
    if (Date.now() >= deadline) {
      throw new Error("Current duty runtime has not completed disaster recovery adoption");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, Math.min(100, Math.max(1, deadline - Date.now())));
      const onAbort = () => finish(input.signal?.reason);
      function finish(error?: unknown): void {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error);
        else resolve();
      }
      input.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
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

function createPostInstallReceipt(input: {
  readonly generation: DisasterInstalledAuthorityGeneration;
  readonly participants: readonly string[];
  readonly readBack: readonly {
    readonly kind: AuthorityCatalog["pendingObligations"][number]["kind"];
    readonly id: string;
    readonly disposition: "current-owner" | "terminal";
  }[];
}): DisasterRecoveryPostInstallReceipt {
  return Object.freeze({
    v: 1,
    t: "disaster-post-install-completed",
    transferId: input.generation.transferId,
    generationDigest: installedGenerationDigest(input.generation),
    participantsDigest: protocolDigest("DisasterPostInstallParticipants", 1, input.participants),
    readBackDigest: protocolDigest("DisasterPostInstallReadBack", 1, input.readBack),
  });
}

function installedGenerationDigest(generation: DisasterInstalledAuthorityGeneration): string {
  return protocolDigest("DisasterInstalledAuthorityGeneration", 1, generation);
}

function reducePostInstallReceipts(
  current: ReadonlyMap<string, DisasterRecoveryPostInstallReceipt>,
  entry: LogicalRecord<unknown>,
): ReadonlyMap<string, DisasterRecoveryPostInstallReceipt> {
  if (entry.stream !== DISASTER_POST_INSTALL_STREAM) return current;
  const receipt = validatePostInstallReceipt(entry.body);
  const existing = current.get(receipt.transferId);
  if (existing) {
    if (canonicalize(existing) !== canonicalize(receipt)) {
      throw new Error("Disaster recovery has conflicting post-install receipts");
    }
    return current;
  }
  const next = new Map(current);
  next.set(receipt.transferId, receipt);
  return next;
}

function validatePostInstallReceipt(value: unknown): DisasterRecoveryPostInstallReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Disaster recovery post-install receipt is invalid");
  }
  const receipt = value as Partial<DisasterRecoveryPostInstallReceipt> & Record<string, unknown>;
  if (
    receipt.v !== 1 || receipt.t !== "disaster-post-install-completed" ||
    typeof receipt.transferId !== "string" || receipt.transferId.length === 0 ||
    typeof receipt.generationDigest !== "string" ||
    typeof receipt.participantsDigest !== "string" ||
    typeof receipt.readBackDigest !== "string" ||
    canonicalize(Object.keys(receipt).sort()) !== canonicalize([
      "generationDigest", "participantsDigest", "readBackDigest", "t", "transferId", "v",
    ])
  ) throw new TypeError("Disaster recovery post-install receipt is invalid");
  return Object.freeze({
    v: 1,
    t: receipt.t,
    transferId: receipt.transferId,
    generationDigest: receipt.generationDigest,
    participantsDigest: receipt.participantsDigest,
    readBackDigest: receipt.readBackDigest,
  });
}
