import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
  type ArtifactStore,
} from "@zhixing/core/authority";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import {
  PlannedAnchorCandidateJournal,
  PlannedAnchorTransferJournal,
  type PlannedAnchorCandidateJournalPort,
  type PlannedAnchorPrivateJournalPort,
  type PlannedAnchorStagingArtifacts,
  type PlannedAnchorStagingReceiver,
  type PlannedAnchorTargetStaging,
  type PlannedAnchorTransferStagingArea,
  type PlannedAnchorTransferStagingSession,
} from "./planned-anchor-transfer.js";

const MAX_PLANNED_ANCHOR_TRANSFER_ARTIFACT_BYTES = 512 * 1024 * 1024 * 1024;
const PLANNED_ANCHOR_TRANSFER_CHUNK_BYTES = 512 * 1024;
const TRANSFER_ID = /^xfer-[0-9A-HJKMNP-TV-Z]{26}$/u;

interface Closeable {
  close(): Promise<void>;
}

/** The sole physical composition of the P12 planned-anchor staging family. */
export function createPlannedAnchorTransferStagingInfrastructure(options: Readonly<{
  zhixingHome: string;
  storageMaintenance?: StorageMaintenanceGovernorPort;
}>): PlannedAnchorTransferStagingArea {
  const root = path.resolve(
    options.zhixingHome,
    "distributed-runtime",
    "anchor-transfer-staging",
  );
  const openResources = new Set<Closeable>();
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error("Planned-anchor transfer staging is closed");
  };

  const createSession = (input: Readonly<{
    transferId: string;
    artifacts: ArtifactStore;
    verifier: ProtocolSignatureVerifier;
    onCleanup?: (session: PlannedAnchorTransferStagingSession) => void;
  }>): PlannedAnchorTransferStagingSession => {
    assertOpen();
    const transferRoot = transferPath(root, "transfers", input.transferId);
    const journalRoot = transferPath(root, "journals", input.transferId);
    const privateArtifacts = new FileArtifactStore(path.join(transferRoot, "artifacts"));
    const destinationArtifacts = requireFileArtifactStore(input.artifacts);
    const journalLog = new FileAuthorityCommitLog(
      journalRoot,
      privateArtifacts,
      { storageMaintenance: options.storageMaintenance },
    );
    const journal = new PlannedAnchorTransferJournal(journalLog, input.verifier);
    const receiver = new FileResumableArtifactReceiver(
      privateArtifacts,
      path.join(transferRoot, "partials"),
      {
        maxArtifactBytes: MAX_PLANNED_ANCHOR_TRANSFER_ARTIFACT_BYTES,
        maxChunkBytes: PLANNED_ANCHOR_TRANSFER_CHUNK_BYTES,
      },
    );
    const promotion = new FileResumableArtifactReceiver(
      destinationArtifacts,
      path.join(transferRoot, "promotion-partials"),
      {
        maxArtifactBytes: MAX_PLANNED_ANCHOR_TRANSFER_ARTIFACT_BYTES,
        maxChunkBytes: PLANNED_ANCHOR_TRANSFER_CHUNK_BYTES,
      },
    );
    let closing: Promise<void> | undefined;
    let session!: PlannedAnchorTransferStagingSession;
    const resource: Closeable = {
      close: () => {
        closing ??= journal.stopStorageMaintenance().finally(() => {
          openResources.delete(resource);
          input.onCleanup?.(session);
        });
        return closing;
      },
    };
    session = Object.freeze({
      journal: projectJournal(journal),
      artifacts: projectArtifacts(privateArtifacts),
      receiver: projectReceiver(receiver),
      promotion: projectReceiver(promotion),
      exists: () => pathExists(transferRoot),
      cleanupTransfer: () => rm(transferRoot, { recursive: true, force: true }),
      cleanupTransferAndJournal: async () => {
        await resource.close();
        await rm(transferRoot, { recursive: true, force: true });
        await rm(journalRoot, { recursive: true, force: true });
      },
      close: resource.close,
    });
    openResources.add(resource);
    return session;
  };

  return Object.freeze({
    openTarget(input: Readonly<{
      artifacts: ArtifactStore;
      verifier: ProtocolSignatureVerifier;
    }>): PlannedAnchorTargetStaging {
      assertOpen();
      const artifacts = requireFileArtifactStore(input.artifacts);
      const candidateLog = new FileAuthorityCommitLog(
        path.join(root, "candidate-claims"),
        artifacts,
        { storageMaintenance: options.storageMaintenance },
      );
      const candidateJournal = new PlannedAnchorCandidateJournal(
        candidateLog,
        input.verifier,
        false,
      );
      const contexts = new Map<string, PlannedAnchorTransferStagingSession>();
      let closing: Promise<void> | undefined;
      const resource: Closeable = {
        close: () => {
          closing ??= Promise.allSettled([
            candidateJournal.stopStorageMaintenance(),
            ...[...contexts.values()].map((context) => context.close()),
          ]).then((results) => {
            const failures = results
              .filter((result): result is PromiseRejectedResult => result.status === "rejected")
              .map((result) => result.reason);
            contexts.clear();
            openResources.delete(resource);
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
              throw new AggregateError(failures, "Planned-anchor staging close failed");
            }
          });
          return closing;
        },
      };
      const target = Object.freeze({
        candidates: projectCandidates(candidateJournal),
        recoverableTransferIds: () => recoverableTransferIds(root),
        forTransfer(transferId: string): PlannedAnchorTransferStagingSession {
          assertOpen();
          const current = contexts.get(transferId);
          if (current) return current;
          const session = createSession({
            transferId,
            artifacts,
            verifier: input.verifier,
            onCleanup: (closedSession) => {
              if (contexts.get(transferId) === closedSession) contexts.delete(transferId);
            },
          });
          contexts.set(transferId, session);
          return session;
        },
        close: resource.close,
      }) satisfies PlannedAnchorTargetStaging;
      openResources.add(resource);
      return target;
    },
    openTransfer(input: Readonly<{
      transferId: string;
      artifacts: ArtifactStore;
      verifier: ProtocolSignatureVerifier;
    }>): PlannedAnchorTransferStagingSession {
      return createSession(input);
    },
    cleanupPostInstall(transferId: string): Promise<void> {
      return rm(transferPath(root, "transfers", transferId), {
        recursive: true,
        force: true,
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled(
        [...openResources].map((resource) => resource.close()),
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      openResources.clear();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Planned-anchor staging shutdown failed");
      }
    },
  });
}

function projectCandidates(
  journal: PlannedAnchorCandidateJournal,
): PlannedAnchorCandidateJournalPort {
  return Object.freeze({
    state: journal.state.bind(journal),
    states: journal.states.bind(journal),
    claimCandidate: journal.claimCandidate.bind(journal),
    recordReady: journal.recordReady.bind(journal),
    markPrepared: journal.markPrepared.bind(journal),
    decideRemoteAbort: journal.decideRemoteAbort.bind(journal),
    terminal: journal.terminal.bind(journal),
    releaseUnprepared: journal.releaseUnprepared.bind(journal),
  });
}

function projectJournal(journal: PlannedAnchorTransferJournal): PlannedAnchorPrivateJournalPort {
  return Object.freeze({
    state: journal.state.bind(journal),
    append: journal.append.bind(journal),
    readyReservation: journal.readyReservation.bind(journal),
    reserveReady: journal.reserveReady.bind(journal),
  });
}

function projectArtifacts(store: FileArtifactStore): PlannedAnchorStagingArtifacts {
  return Object.freeze({
    get: store.get.bind(store),
    readRange: store.readRange.bind(store),
    has: store.has.bind(store),
  });
}

function projectReceiver(receiver: FileResumableArtifactReceiver): PlannedAnchorStagingReceiver {
  return Object.freeze({
    progress: receiver.progress.bind(receiver),
    append: receiver.append.bind(receiver),
  });
}

async function recoverableTransferIds(root: string): Promise<readonly string[]> {
  const journalsRoot = path.join(root, "journals");
  let entries: Dirent[];
  try {
    entries = await readdir(journalsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return Object.freeze([]);
    throw error;
  }
  return Object.freeze(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      assertTransferId(entry.name);
      return entry.name;
    })
    .sort());
}

function transferPath(root: string, family: "journals" | "transfers", transferId: string): string {
  assertTransferId(transferId);
  const familyRoot = path.join(root, family);
  const target = path.resolve(familyRoot, transferId);
  if (path.dirname(target) !== familyRoot) {
    throw new TypeError("Planned-anchor transfer staging path escapes its root");
  }
  return target;
}

function assertTransferId(transferId: string): void {
  if (!TRANSFER_ID.test(transferId)) {
    throw new TypeError("Migration transfer id is not safe for private storage");
  }
}

function requireFileArtifactStore(artifacts: ArtifactStore): FileArtifactStore {
  if (!(artifacts instanceof FileArtifactStore)) {
    throw new TypeError("Planned-anchor staging requires the installed File artifact store");
  }
  return artifacts;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
