import type { Dir } from "node:fs";
import { lstat, opendir, rm, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
  type ArtifactStore,
} from "@zhixing/core/authority";
import {
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import { protocolDigest } from "@zhixing/core/protocol";
import { DisasterRecoveryCandidateJournal } from "./disaster-recovery-candidate.js";
import {
  DisasterRecoveryTransferJournal,
  disasterVerifiers,
  loadStoredTargetIssuer,
} from "./disaster-recovery-target.js";
import type {
  DisasterRecoveryCandidateJournalPort,
  DisasterRecoveryPrivateJournalPort,
  DisasterRecoveryStagingArea,
  DisasterRecoveryStagingReceiver,
  DisasterRecoveryTargetStaging,
  DisasterRecoveryTransferStagingSession,
} from "./disaster-recovery-staging.js";

const MAX_DISASTER_RECOVERY_ARTIFACT_BYTES = 512 * 1024 * 1024 * 1024;
const DISASTER_RECOVERY_CHUNK_BYTES = 1024 * 1024;
const TRANSFER_ID = /^xfer-[0-9A-HJKMNP-TV-Z]{26}$/u;

interface Closeable {
  close(): Promise<void>;
}

/** The sole physical composition of the P12 disaster-recovery staging family. */
export function createDisasterRecoveryStagingInfrastructure(options: Readonly<{
  zhixingHome: string;
  storageMaintenance?: StorageMaintenanceGovernorPort;
}>): DisasterRecoveryStagingArea {
  const root = path.resolve(
    options.zhixingHome,
    "distributed-runtime",
    "disaster-recovery-staging",
  );
  const openResources = new Set<Closeable>();
  const openTransfers = new Map<string, Set<DisasterRecoveryTransferStagingSession>>();
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error("Disaster-recovery staging is closed");
  };

  const createTransfer = async (input: Parameters<DisasterRecoveryTargetStaging["forTransfer"]>[0] & {
    readonly sharedArtifacts: FileArtifactStore;
  }):
    Promise<DisasterRecoveryTransferStagingSession> => {
    assertOpen();
    const transferRoot = transferPath(root, "transfers", input.transferId);
    const journalRoot = transferPath(root, "journals", input.transferId);
    const artifacts = new FileArtifactStore(path.join(transferRoot, "artifacts"));
    const log = new FileAuthorityCommitLog(journalRoot, artifacts, {
      storageMaintenance: options.storageMaintenance,
    });
    let closing: Promise<void> | undefined;
    let session: DisasterRecoveryTransferStagingSession | undefined;
    const resource: Closeable = {
      close: () => {
        closing ??= log.stopStorageMaintenance().finally(() => {
          openResources.delete(resource);
          const sessions = openTransfers.get(input.transferId);
          if (session) sessions?.delete(session);
          if (sessions?.size === 0) openTransfers.delete(input.transferId);
        });
        return closing;
      },
    };
    openResources.add(resource);
    try {
      const issuerKey = input.issuerKey ?? await loadStoredTargetIssuer(log);
      const journal = new DisasterRecoveryTransferJournal(
        log,
        disasterVerifiers(input.rootPublicKey, input.identity, issuerKey),
        input.now ?? Date.now,
      );
      const privateImport = new FileResumableArtifactReceiver(
        artifacts,
        path.join(transferRoot, "partials"),
        {
          maxArtifactBytes: MAX_DISASTER_RECOVERY_ARTIFACT_BYTES,
          maxChunkBytes: DISASTER_RECOVERY_CHUNK_BYTES,
        },
      );
      const promotion = new FileResumableArtifactReceiver(
        input.sharedArtifacts,
        path.join(transferRoot, "promotion-partials"),
        {
          maxArtifactBytes: MAX_DISASTER_RECOVERY_ARTIFACT_BYTES,
          maxChunkBytes: DISASTER_RECOVERY_CHUNK_BYTES,
        },
      );
      session = Object.freeze({
        transferId: input.transferId,
        artifacts: projectArtifacts(artifacts),
        journal: projectJournal(journal),
        privateImport: projectReceiver(privateImport),
        promotion: projectReceiver(promotion),
        exists: () => pathExists(transferRoot),
        cleanupTransfer: async () => {
          await closeTransferSessions(input.transferId, openTransfers);
          await rm(transferRoot, { recursive: true, force: true });
        },
        close: resource.close,
      });
      const sessions = openTransfers.get(input.transferId) ?? new Set();
      sessions.add(session);
      openTransfers.set(input.transferId, sessions);
      return session;
    } catch (error) {
      try {
        await resource.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Disaster-recovery transfer staging setup and cleanup failed",
        );
      }
      throw error;
    }
  };

  return Object.freeze({
    openTarget(input: Readonly<{ sharedArtifacts: ArtifactStore }>): DisasterRecoveryTargetStaging {
      assertOpen();
      const sharedArtifacts = requireFileArtifactStore(input.sharedArtifacts);
      const candidates = new Map<string, DisasterRecoveryCandidateJournal>();
      const sessions = new Set<Promise<DisasterRecoveryTransferStagingSession>>();
      let closing: Promise<void> | undefined;
      const resource: Closeable = {
        close: () => {
          closing ??= Promise.allSettled([
            ...[...candidates.values()].map((candidate) => candidate.stopStorageMaintenance()),
            ...[...sessions].map(async (session) => (await session).close()),
          ]).then((results) => {
            const failures = results
              .filter((result): result is PromiseRejectedResult => result.status === "rejected")
              .map((result) => result.reason);
            candidates.clear();
            sessions.clear();
            openResources.delete(resource);
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
              throw new AggregateError(failures, "Disaster-recovery target staging close failed");
            }
          });
          return closing;
        },
      };
      const target = Object.freeze({
        candidateFor(rootPublicKey: string): DisasterRecoveryCandidateJournalPort {
          assertOpen();
          const current = candidates.get(rootPublicKey);
          if (current) return current;
          const journal = new DisasterRecoveryCandidateJournal(
            new FileAuthorityCommitLog(
              path.join(root, "candidate-claims"),
              sharedArtifacts,
              { storageMaintenance: options.storageMaintenance },
            ),
            rootPublicKey,
          );
          candidates.set(rootPublicKey, journal);
          return journal;
        },
        forTransfer(
          input: Parameters<DisasterRecoveryTargetStaging["forTransfer"]>[0],
        ) {
          assertOpen();
          const created = createTransfer({ ...input, sharedArtifacts });
          sessions.add(created);
          void created.catch(() => sessions.delete(created));
          return created;
        },
        close: resource.close,
      }) satisfies DisasterRecoveryTargetStaging;
      openResources.add(resource);
      return target;
    },
    async cleanupPostInstall(transferId: string): Promise<void> {
      await closeTransferSessions(transferId, openTransfers);
      await rm(transferPath(root, "transfers", transferId), {
        recursive: true,
        force: true,
      });
    },
    async cleanupCurrentDevice(signal?: AbortSignal): Promise<void> {
      await closeAll(openResources, "Disaster-recovery staging cleanup failed");
      const walker = new BoundedRemovalWalker(root);
      let batchIndex = 0;
      try {
        while (true) {
          signal?.throwIfAborted();
          const result = await runStorageMaintenanceStep(
            options.storageMaintenance,
            storageMaintenanceRequest(
              "device-lifecycle-cleanup",
              root,
              protocolDigest("ExecutorRemovalCleanupPathBatch", 1, {
                home: path.resolve(options.zhixingHome),
                entry: root,
                batchIndex,
              }),
              { obligation: "pre-commit", maxWaitMs: 5_000 },
            ),
            () => walker.step(128),
          );
          if (result.done) break;
          batchIndex += 1;
        }
      } finally {
        await walker.close();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeAll(openResources, "Disaster-recovery staging shutdown failed");
    },
  });
}

function projectArtifacts(store: FileArtifactStore): ArtifactStore {
  return Object.freeze({
    put: store.put.bind(store),
    putVerifiedStream: store.putVerifiedStream.bind(store),
    get: store.get.bind(store),
    readRange: store.readRange.bind(store),
    has: store.has.bind(store),
  });
}

function projectJournal(
  journal: DisasterRecoveryTransferJournal,
): DisasterRecoveryPrivateJournalPort {
  return Object.freeze({
    state: journal.state.bind(journal),
    states: journal.states.bind(journal),
    append: journal.append.bind(journal),
  });
}

function projectReceiver(
  receiver: FileResumableArtifactReceiver,
): DisasterRecoveryStagingReceiver {
  return Object.freeze({
    progress: receiver.progress.bind(receiver),
    append: receiver.append.bind(receiver),
  });
}

function requireFileArtifactStore(artifacts: ArtifactStore): FileArtifactStore {
  if (!(artifacts instanceof FileArtifactStore)) {
    throw new TypeError("Disaster-recovery staging requires the installed File artifact store");
  }
  return artifacts;
}

async function closeTransferSessions(
  transferId: string,
  openTransfers: ReadonlyMap<string, ReadonlySet<DisasterRecoveryTransferStagingSession>>,
): Promise<void> {
  const sessions = openTransfers.get(transferId);
  if (!sessions) return;
  const results = await Promise.allSettled([...sessions].map((session) => session.close()));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

async function closeAll(resources: Set<Closeable>, message: string): Promise<void> {
  const results = await Promise.allSettled([...resources].map((resource) => resource.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  resources.clear();
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function transferPath(root: string, family: "journals" | "transfers", transferId: string): string {
  assertTransferId(transferId);
  const familyRoot = path.join(root, family);
  const target = path.resolve(familyRoot, transferId);
  if (path.dirname(target) !== familyRoot) {
    throw new TypeError("Disaster-recovery staging path escapes its root");
  }
  return target;
}

function assertTransferId(transferId: string): void {
  if (!TRANSFER_ID.test(transferId)) {
    throw new TypeError("Disaster-recovery transfer id is not safe for private storage");
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

interface RemovalFrame {
  readonly path: string;
  readonly directory: Dir;
  pendingChild?: string;
}

class BoundedRemovalWalker {
  readonly #stack: RemovalFrame[] = [];
  #initialized = false;
  #fileRoot = false;
  #done = false;

  constructor(private readonly root: string) {}

  async step(limit: number): Promise<{ readonly done: boolean }> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("Removal batch limit must be a positive safe integer");
    }
    let operations = 0;
    if (!this.#initialized) {
      this.#initialized = true;
      let metadata;
      try {
        metadata = await lstat(this.root);
      } catch (error) {
        if (isMissingPath(error)) {
          this.#done = true;
          return { done: true };
        }
        throw error;
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        this.#fileRoot = true;
      } else {
        this.#stack.push({ path: this.root, directory: await opendir(this.root) });
      }
    }
    if (this.#done) return { done: true };
    if (this.#fileRoot) {
      await unlink(this.root).catch(ignoreMissingPath);
      this.#done = true;
      return { done: true };
    }
    while (operations < limit && this.#stack.length > 0) {
      const frame = this.#stack.at(-1)!;
      if (frame.pendingChild) {
        await rmdir(frame.pendingChild).catch(ignoreMissingPath);
        frame.pendingChild = undefined;
        operations += 1;
        continue;
      }
      const entry = await frame.directory.read();
      if (!entry) {
        await frame.directory.close();
        this.#stack.pop();
        if (this.#stack.length === 0) {
          await rmdir(frame.path).catch(ignoreMissingPath);
          this.#done = true;
          return { done: true };
        }
        this.#stack.at(-1)!.pendingChild = frame.path;
        continue;
      }
      const child = path.join(frame.path, entry.name);
      const metadata = await lstat(child).catch((error) => {
        if (isMissingPath(error)) return undefined;
        throw error;
      });
      if (!metadata) continue;
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        this.#stack.push({ path: child, directory: await opendir(child) });
        continue;
      }
      await unlink(child).catch(ignoreMissingPath);
      operations += 1;
    }
    return { done: this.#done };
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const frame of this.#stack.splice(0).reverse()) {
      await frame.directory.close().catch((error) => failures.push(error));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Removal cursor close failed");
  }
}

function ignoreMissingPath(error: unknown): void {
  if (!isMissingPath(error)) throw error;
}
