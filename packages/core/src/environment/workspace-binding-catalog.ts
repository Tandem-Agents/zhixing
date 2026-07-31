import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  AuthorityStorageError,
  type AuthorityCommitLog,
} from "../authority/index.js";
import type {
  CapabilityDescriptor,
  EnvironmentPort,
  ExecutorVersionInventory,
  LocalEnvironmentControlContext,
  LocalEnvironmentRecoveryContext,
  LocalWorkspaceBinding,
  WorkspaceBindingAdminPort,
  WorkspaceBindingMigrationPort,
  WorkspaceBindingPatch,
  WorkspaceBindingRecoveryPort,
  WorkspaceBindingResetReceipt,
  WorkspaceBindingRootManifest,
} from "../contracts/index.js";
import { defineDurableRuntimeContract } from "../contracts/durable-contract.js";
import {
  acquireFileLock,
  ensureDurableDirectory,
  SerialTaskQueue,
  syncDirectory,
} from "../persistence/index.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";
import {
  claimDeviceCapacity,
  maintenanceRetryDelayMs,
  runInMaintenanceContext,
  runStorageMaintenanceStep,
  runWithDeviceCapacity,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  waitForMaintenanceRetry,
  type DeviceCapacityBudget,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceTaskRunner,
} from "../resources/index.js";
import {
  validateLocalEnvironmentControl,
  WorkspaceBindingService,
  type WorkspaceCapabilityPublication,
  type WorkspaceBindingServiceOptions,
} from "./workspace-bindings.js";

const MANIFEST_VERSION = 1;
const CONFIRMATION_MAX_AGE_MS = 5 * 60_000;
const RESET_RESERVATION_BUDGET: DeviceCapacityBudget = {
  occupancy: {
    memoryReservationBytes: 64 * 1024,
    temporaryBytes: 4 * 1024,
    slots: 1,
  },
  quantum: {
    readBytes: 16 * 1024,
    writeBytes: 16 * 1024,
    ioOperations: 4,
  },
};

interface PersistedRootManifest extends WorkspaceBindingRootManifest {
  readonly version: typeof MANIFEST_VERSION;
}

export interface WorkspaceBindingCatalogOptions {
  readonly rootDir: string;
  readonly initialLog: AuthorityCommitLog;
  readonly createGenerationLog: (
    catalogGeneration: string,
  ) => AuthorityCommitLog;
  readonly service: Omit<
    WorkspaceBindingServiceOptions,
    | "catalogGeneration"
    | "log"
    | "rootDir"
    | "resetGenesis"
    | "storageMaintenance"
  >;
  readonly recoveryRunner: StorageMaintenanceTaskRunner;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly clock?: () => string;
}

/**
 * Generation-rooted owner for the device-local workspace binding catalog.
 *
 * A corrupt generation is never edited in place. Reset first reserves one
 * deterministic successor in the root manifest, then a committed maintenance
 * owner prepares an empty generation and atomically switches the manifest.
 */
export class WorkspaceBindingCatalog
  implements
    EnvironmentPort,
    WorkspaceBindingAdminPort,
    WorkspaceBindingMigrationPort,
    WorkspaceBindingRecoveryPort
{
  readonly #rootDir: string;
  readonly #manifestPath: string;
  readonly #initialLog: AuthorityCommitLog;
  readonly #createGenerationLog: WorkspaceBindingCatalogOptions["createGenerationLog"];
  readonly #serviceOptions: WorkspaceBindingCatalogOptions["service"];
  readonly #recoveryRunner: StorageMaintenanceTaskRunner;
  readonly #storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly #clock: () => string;
  readonly #manifestQueue = new SerialTaskQueue();
  readonly #generationLogs = new Map<string, AuthorityCommitLog>();
  #manifest: PersistedRootManifest | undefined;
  #active: WorkspaceBindingService | undefined;
  #opening: Promise<void> | undefined;
  #recoveryOwner: Promise<void> | undefined;
  #recoveryFailure: string | undefined;
  readonly #recoveryAbort = new AbortController();

  constructor(options: WorkspaceBindingCatalogOptions) {
    this.#rootDir = path.resolve(options.rootDir);
    this.#manifestPath = path.join(this.#rootDir, "root-manifest.json");
    this.#initialLog = options.initialLog;
    this.#createGenerationLog = options.createGenerationLog;
    this.#serviceOptions = options.service;
    this.#recoveryRunner = options.recoveryRunner;
    this.#storageMaintenance = options.storageMaintenance;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<void> {
    await this.#ensureOpen();
    await this.#refreshRootFromDisk();
    if (this.#manifest?.pendingReset) {
      try {
        await this.#ensureRecoveryOwner();
      } catch {
        // A corrupt or unverifiable reserved target leaves the catalog in its
        // durable degraded state. Local status/diagnostics must remain
        // available; mutating and capability-producing methods stay closed.
      }
      return;
    }
    await this.capabilitySnapshot();
  }

  async status(): Promise<{
    state: "healthy" | "degraded";
    catalogGeneration: string;
    reason?: string;
  }> {
    await this.#ensureOpen();
    await this.#refreshRootFromDisk();
    const manifest = this.#requireManifest();
    const reason = this.#recoveryFailure ?? manifest.degradedReason;
    return {
      state: manifest.state,
      catalogGeneration: manifest.catalogGeneration,
      ...(reason ? { reason } : {}),
    };
  }

  async beginReset(
    input: { expectedCatalogGeneration: string },
    control: LocalEnvironmentRecoveryContext,
  ): Promise<NonNullable<WorkspaceBindingRootManifest["pendingReset"]>> {
    validateLocalEnvironmentControl(control, this.#serviceOptions);
    await this.#ensureOpen();
    await this.#refreshRootFromDisk();
    const confirmationDigest = resetConfirmationDigest(control);
    const replay = await this.#findResetReceipt(control.requestId);
    if (replay) {
      if (
        replay.confirmationDigest !== confirmationDigest ||
        replay.previousCatalogGeneration !==
          control.confirmation.catalogGeneration
      ) {
        throw new WorkspaceBindingCatalogConflictError(
          "Workspace catalog reset request was reused with another confirmation",
        );
      }
      return reservationFromReceipt(replay);
    }
    const existing = this.#requireManifest().pendingReset;
    if (existing?.requestId === control.requestId) {
      if (
        existing.confirmationDigest !== confirmationDigest ||
        existing.previousCatalogGeneration !==
          control.confirmation.catalogGeneration
      ) {
        throw new WorkspaceBindingCatalogConflictError(
          "Workspace catalog reset request was reused with another confirmation",
        );
      }
      this.#startRecoveryOwner();
      return structuredClone(existing);
    }
    validateFreshResetConfirmation(control.confirmation, this.#clock());
    const reservation = await this.#manifestQueue.run(async () => {
      const current = this.#requireManifest();
      if (
        input.expectedCatalogGeneration !== current.catalogGeneration ||
        control.confirmation.catalogGeneration !== current.catalogGeneration
      ) {
        throw new WorkspaceBindingCatalogConflictError(
          "Workspace catalog generation changed before reset",
        );
      }
      if (current.state !== "degraded") {
        throw new WorkspaceBindingCatalogConflictError(
          "A healthy workspace catalog cannot be reset",
        );
      }
      const catalogGeneration = resetGeneration(
        current.catalogGeneration,
        confirmationDigest,
      );
      if (current.pendingReset) {
        if (
          current.pendingReset.requestId !== control.requestId ||
          current.pendingReset.confirmationDigest !== confirmationDigest ||
          current.pendingReset.catalogGeneration !== catalogGeneration
        ) {
          throw new WorkspaceBindingCatalogConflictError(
            "Another workspace catalog reset is already reserved",
          );
        }
        return current.pendingReset;
      }
      const pendingReset = {
        requestId: control.requestId,
        confirmationDigest,
        previousCatalogGeneration: current.catalogGeneration,
        catalogGeneration,
        preparedAt: this.#clock(),
      };
      const next = { ...current, pendingReset };
      await this.#writeManifest(next, current, {
        kind: "interactive",
        abort: control.abort,
      });
      this.#manifest = next;
      return pendingReset;
    });
    this.#startRecoveryOwner();
    return reservation;
  }

  async completeReset(
    requestId: string,
    abort: AbortSignal,
  ): Promise<WorkspaceBindingResetReceipt> {
    await this.#ensureOpen();
    await this.#refreshRootFromDisk();
    const manifest = this.#requireManifest();
    if (!manifest.pendingReset) {
      const replay = await this.#findResetReceipt(requestId);
      if (replay) return replay;
      throw new WorkspaceBindingCatalogConflictError(
        "Workspace catalog reset is not reserved",
      );
    }
    if (manifest.pendingReset.requestId !== requestId) {
      throw new WorkspaceBindingCatalogConflictError(
        "Workspace catalog reset belongs to another request",
      );
    }
    const owner = this.#ensureRecoveryOwner();
    let rejectAbort: (() => void) | undefined;
    const onAbort = new Promise<never>((_, reject) => {
      rejectAbort = () =>
        reject(
          new WorkspaceBindingCatalogConflictError(
            "Workspace catalog reset waiter was cancelled",
          ),
        );
      if (abort.aborted) rejectAbort();
      else abort.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      await Promise.race([owner, onAbort]);
    } finally {
      if (rejectAbort) abort.removeEventListener("abort", rejectAbort);
    }
    const replay = await this.#findResetReceipt(requestId);
    if (!replay) {
      throw new WorkspaceBindingCatalogConflictError(
        "Workspace catalog reset completed without its receipt",
      );
    }
    return replay;
  }

  async recover(): Promise<void> {
    await this.#ensureOpen();
    await this.#refreshRootFromDisk();
    await this.#ensureRecoveryOwner();
  }

  async list(
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding[]> {
    return this.#withHealthy((service) => service.list(control));
  }

  async create(
    input: { displayName: string; absolutePath: string },
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding> {
    return this.#withHealthy((service) => service.create(input, control));
  }

  async update(
    bindingRef: string,
    patch: WorkspaceBindingPatch,
    expectedRevision: number,
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding> {
    return this.#withHealthy((service) =>
      service.update(bindingRef, patch, expectedRevision, control),
    );
  }

  async remove(
    bindingRef: string,
    expectedRevision: number,
    control: LocalEnvironmentControlContext,
  ): Promise<void> {
    return this.#withHealthy((service) =>
      service.remove(bindingRef, expectedRevision, control),
    );
  }

  async importLegacy(
    input: {
      migrationId: string;
      sourceSnapshotToken: string;
      displayName: string;
      absolutePath: string;
    },
    abort: AbortSignal,
  ): Promise<LocalWorkspaceBinding> {
    return this.#withHealthy((service) => service.importLegacy(input, abort));
  }

  async activateLegacy(
    input: { migrationId: string; sourceSnapshotToken: string },
    abort: AbortSignal,
  ): Promise<void> {
    return this.#withHealthy((service) => service.activateLegacy(input, abort));
  }

  async abandonLegacy(
    input: {
      migrationId: string;
      sourceSnapshotToken: string;
      reason: string;
    },
    abort: AbortSignal,
  ): Promise<void> {
    return this.#withHealthy((service) => service.abandonLegacy(input, abort));
  }

  async resolveWorkspace(
    bindingRef: string,
  ): Promise<{ absolutePath: string; workspaceBindingRevision: number }> {
    return this.#withHealthy((service) => service.resolveWorkspace(bindingRef));
  }

  async probePath(
    target: string,
  ): Promise<
    "directory" | "missing" | "non_directory" | "inaccessible" | "error"
  > {
    return this.#withHealthy((service) => service.probePath(target));
  }

  async capabilitySnapshot(): Promise<CapabilityDescriptor> {
    await this.#ensureOpen();
    await this.#refreshRootFromDisk();
    const manifest = this.#requireManifest();
    if (manifest.state === "degraded") {
      return this.#publishCatalogState({
        catalogGeneration: manifest.catalogGeneration,
        state: "degraded",
        workspaces: [],
      });
    }
    return this.#withHealthy((service) => service.capabilitySnapshot());
  }

  versionInventory(): Promise<ExecutorVersionInventory> {
    return this.#serviceOptions.versionInventory();
  }

  async stop(): Promise<void> {
    this.#recoveryAbort.abort();
    this.#recoveryRunner.stop();
    await this.#recoveryOwner;
    for (const log of this.#generationLogs.values()) {
      (
        log as AuthorityCommitLog & {
          stopStorageMaintenance?: () => void;
        }
      ).stopStorageMaintenance?.();
    }
    this.#generationLogs.clear();
  }

  #startRecoveryOwner(): void {
    const owner = this.#ensureRecoveryOwner();
    void owner.catch(() => undefined);
  }

  #ensureRecoveryOwner(): Promise<void> {
    if (!this.#requireManifest().pendingReset) {
      return Promise.resolve();
    }
    if (this.#recoveryOwner) return this.#recoveryOwner;
    this.#recoveryFailure = undefined;
    this.#recoveryOwner = runInMaintenanceContext("foreground", async () => {
      while (!this.#recoveryAbort.signal.aborted) {
        const pending = this.#requireManifest().pendingReset;
        if (!pending) return;
        try {
          await this.#runReservedReset(pending, this.#recoveryAbort.signal);
          return;
        } catch (error) {
          if (this.#recoveryAbort.signal.aborted) return;
          const delay = maintenanceRetryDelayMs(error);
          if (delay === undefined) {
            throw error;
          }
          await waitForMaintenanceRetry(Math.max(1, delay));
        }
      }
      return;
    })
      .catch((error: unknown) => {
        this.#recoveryFailure = `workspace-reset:${errorCode(error)}`;
        throw error;
      })
      .finally(() => {
        this.#recoveryOwner = undefined;
      });
    return this.#recoveryOwner;
  }

  async #runReservedReset(
    reservation: NonNullable<WorkspaceBindingRootManifest["pendingReset"]>,
    waiterAbort: AbortSignal,
  ): Promise<WorkspaceBindingResetReceipt> {
    const request = storageMaintenanceObligation(
      "workspace-catalog-reset",
      this.#rootDir,
      {
        previousCatalogGeneration: reservation.previousCatalogGeneration,
        catalogGeneration: reservation.catalogGeneration,
      },
      {
        owner: "workspace-binding-recovery-owner",
        obligation: "committed",
      },
    );
    return this.#recoveryRunner.run(request, waiterAbort, () =>
      this.#manifestQueue
        .run(async () => {
          const current = await this.#readManifest();
          if (!current.pendingReset) {
            if (current.catalogGeneration !== reservation.catalogGeneration) {
              throw new WorkspaceBindingCatalogConflictError(
                "Workspace catalog reset completed with another generation",
              );
            }
            const replay = await this.#findResetReceipt(reservation.requestId);
            if (!replay) {
              throw new WorkspaceBindingCatalogConflictError(
                "Workspace catalog reset receipt is missing from its generation",
              );
            }
            assertReceiptMatchesReservation(replay, reservation);
            return replay;
          }
          assertSameReservation(current.pendingReset, reservation);
          const log = this.#logForGeneration(reservation.catalogGeneration);
          const preparedCheckpoint = await log.checkpoint();
          const preparedReceipt: WorkspaceBindingResetReceipt = {
            requestId: reservation.requestId,
            confirmationDigest: reservation.confirmationDigest,
            previousCatalogGeneration: reservation.previousCatalogGeneration,
            catalogGeneration: reservation.catalogGeneration,
            logId: preparedCheckpoint.logId,
            capabilityRevision: current.capabilityRevision + 1,
            preparedAt: reservation.preparedAt,
          };
          const service = this.#makeService(
            reservation.catalogGeneration,
            log,
            preparedReceipt,
          );
          await service.initialize();
          const durableReceipt = await service.resetReceipt();
          if (!durableReceipt) {
            throw new WorkspaceBindingCatalogConflictError(
              "Workspace catalog reset target lacks its durable receipt",
            );
          }
          assertReceiptMatchesReservation(durableReceipt, reservation);
          if (canonicalize(durableReceipt) !== canonicalize(preparedReceipt)) {
            throw new WorkspaceBindingCatalogConflictError(
              "Workspace catalog reset target receipt changed",
            );
          }
          const checkpoint = await log.checkpoint();
          if (checkpoint.logId !== preparedReceipt.logId) {
            throw new WorkspaceBindingCatalogConflictError(
              "Workspace catalog reset target log identity changed",
            );
          }
          const committed: PersistedRootManifest = {
            version: MANIFEST_VERSION,
            state: "healthy",
            catalogGeneration: reservation.catalogGeneration,
            logId: preparedReceipt.logId,
            capabilityRevision: preparedReceipt.capabilityRevision,
          };
          await this.#writeManifest(committed, current, {
            kind: "maintenance",
            identity: {
              previousCatalogGeneration: reservation.previousCatalogGeneration,
              catalogGeneration: reservation.catalogGeneration,
              phase: "root-commit",
            },
          });
          this.#manifest = committed;
          this.#active = service;
          return preparedReceipt;
        })
        .then(async (receipt) => {
          await this.#active?.capabilitySnapshot();
          return receipt;
        }),
    );
  }

  async #findResetReceipt(
    requestId: string,
  ): Promise<WorkspaceBindingResetReceipt | undefined> {
    let generation = this.#requireManifest().catalogGeneration;
    const visited = new Set<string>();
    while (generation !== "catalog-initial") {
      if (visited.has(generation)) {
        throw new WorkspaceBindingCatalogConflictError(
          "Workspace catalog generation chain contains a cycle",
        );
      }
      visited.add(generation);
      let service: WorkspaceBindingService;
      let log: AuthorityCommitLog;
      if (generation === this.#manifest?.catalogGeneration && this.#active) {
        service = this.#active;
        log = this.#logForGeneration(generation);
      } else {
        log = this.#logForGeneration(generation);
        service = this.#makeService(generation, log);
        await service.initialize();
      }
      const receipt = await service.resetReceipt();
      if (!receipt || receipt.catalogGeneration !== generation) {
        throw new WorkspaceBindingCatalogConflictError(
          "Workspace catalog generation chain is incomplete",
        );
      }
      validateResetReceipt(receipt);
      const checkpoint = await log.checkpoint();
      if (checkpoint.logId !== receipt.logId) {
        throw new WorkspaceBindingCatalogConflictError(
          "Workspace catalog generation log identity is inconsistent",
        );
      }
      if (receipt.requestId === requestId) {
        return structuredClone(receipt);
      }
      generation = receipt.previousCatalogGeneration;
    }
    return undefined;
  }

  #logForGeneration(generation: string): AuthorityCommitLog {
    if (generation === "catalog-initial") return this.#initialLog;
    const existing = this.#generationLogs.get(generation);
    if (existing) return existing;
    const created = this.#createGenerationLog(generation);
    this.#generationLogs.set(generation, created);
    return created;
  }

  async #healthy(): Promise<WorkspaceBindingService> {
    await this.#ensureOpen();
    await this.#refreshRootFromDisk();
    const manifest = this.#requireManifest();
    if (manifest.state !== "healthy" || !this.#active) {
      throw new WorkspaceBindingCatalogDegradedError(
        manifest.degradedReason ??
          "Workspace catalog is degraded and requires local recovery",
      );
    }
    return this.#active;
  }

  async #withHealthy<T>(
    operation: (service: WorkspaceBindingService) => Promise<T>,
  ): Promise<T> {
    const service = await this.#healthy();
    try {
      return await operation(service);
    } catch (error) {
      if (error instanceof AuthorityStorageError) {
        await this.#degrade(error);
      }
      throw error;
    }
  }

  async #degrade(error: AuthorityStorageError): Promise<void> {
    await this.#manifestQueue.run(async () => {
      const current = this.#requireManifest();
      if (current.state === "degraded") return;
      const degraded: PersistedRootManifest = {
        ...current,
        state: "degraded",
        degradedReason: error.code,
      };
      await this.#writeManifest(degraded, current);
      this.#manifest = degraded;
      this.#active = undefined;
    });
    const manifest = this.#requireManifest();
    await this.#publishCatalogState({
      catalogGeneration: manifest.catalogGeneration,
      state: "degraded",
      workspaces: [],
    });
  }

  async #ensureOpen(): Promise<void> {
    this.#opening ??= this.#open();
    return this.#opening;
  }

  async #open(): Promise<void> {
    await ensureDurableDirectory(this.#rootDir);
    const persisted = await this.#readManifest().catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!persisted) {
      const generation = "catalog-initial";
      const service = this.#makeService(generation, this.#initialLog);
      try {
        await service.initialize();
        const checkpoint = await this.#initialLog.checkpoint();
        const manifest: PersistedRootManifest = {
          version: MANIFEST_VERSION,
          state: "healthy",
          catalogGeneration: generation,
          logId: checkpoint.logId,
          capabilityRevision: 1,
        };
        await this.#writeManifest(manifest, undefined);
        this.#manifest = manifest;
        this.#active = service;
        return;
      } catch (error) {
        const manifest: PersistedRootManifest = {
          version: MANIFEST_VERSION,
          state: "degraded",
          degradedReason: errorCode(error),
          catalogGeneration: generation,
          logId: "unavailable",
          capabilityRevision: 1,
        };
        await this.#writeManifest(manifest, undefined);
        this.#manifest = manifest;
        await this.#publishCatalogState({
          catalogGeneration: manifest.catalogGeneration,
          state: "degraded",
          workspaces: [],
        });
        return;
      }
    }
    this.#manifest = persisted;
    if (persisted.state === "degraded") {
      await this.#publishCatalogState({
        catalogGeneration: persisted.catalogGeneration,
        state: "degraded",
        workspaces: [],
      });
      return;
    }
    const log = this.#logForGeneration(persisted.catalogGeneration);
    const service = this.#makeService(persisted.catalogGeneration, log);
    try {
      await service.initialize();
      const checkpoint = await log.checkpoint();
      if (checkpoint.logId !== persisted.logId) {
        throw new Error("Workspace catalog root log identity changed");
      }
      this.#active = service;
    } catch (error) {
      const degraded: PersistedRootManifest = {
        ...persisted,
        state: "degraded",
        degradedReason: errorCode(error),
      };
      await this.#writeManifest(degraded, persisted);
      this.#manifest = degraded;
      await this.#publishCatalogState({
        catalogGeneration: degraded.catalogGeneration,
        state: "degraded",
        workspaces: [],
      });
    }
  }

  #makeService(
    generation: string,
    log: AuthorityCommitLog,
    resetGenesis?: WorkspaceBindingServiceOptions["resetGenesis"],
  ): WorkspaceBindingService {
    return new WorkspaceBindingService({
      ...this.#serviceOptions,
      catalogGeneration: generation,
      capabilitySnapshot: (publication) =>
        this.#publishCatalogState(publication),
      rootDir: path.join(
        this.#rootDir,
        "generations",
        workspaceCatalogGenerationStorageKey(generation),
      ),
      log,
      storageMaintenance: this.#storageMaintenance,
      ...(resetGenesis ? { resetGenesis } : {}),
    });
  }

  async #publishCatalogState(
    publication: WorkspaceCapabilityPublication,
  ): Promise<CapabilityDescriptor> {
    return this.#manifestQueue.run(async () => {
      if (!this.#manifest) {
        return this.#serviceOptions.capabilitySnapshot(publication);
      }
      const current = this.#requireManifest();
      if (current.catalogGeneration !== publication.catalogGeneration) {
        throw new WorkspaceBindingCatalogConflictError(
          "A superseded workspace catalog attempted to publish capabilities",
        );
      }
      const descriptor =
        await this.#serviceOptions.capabilitySnapshot(publication);
      if (current.capabilityRevision === descriptor.revision) {
        return descriptor;
      }
      if (descriptor.revision < current.capabilityRevision) {
        throw new WorkspaceBindingCatalogConflictError(
          "Workspace capability revision moved backwards",
        );
      }
      const next: PersistedRootManifest = {
        ...current,
        capabilityRevision: descriptor.revision,
      };
      await this.#writeManifest(next, current);
      this.#manifest = next;
      return descriptor;
    });
  }

  #requireManifest(): PersistedRootManifest {
    if (!this.#manifest) {
      throw new Error("Workspace catalog root manifest is unavailable");
    }
    return this.#manifest;
  }

  async #readManifest(): Promise<PersistedRootManifest> {
    const parsed = JSON.parse(
      await readFile(this.#manifestPath, "utf8"),
    ) as unknown;
    return validateManifest(parsed);
  }

  async #refreshRootFromDisk(): Promise<void> {
    const current = this.#requireManifest();
    const persisted = await this.#readManifest();
    if (canonicalize(current) === canonicalize(persisted)) return;

    await this.#manifestQueue.run(async () => {
      const previous = this.#requireManifest();
      const latest = await this.#readManifest();
      if (canonicalize(previous) === canonicalize(latest)) return;

      let active = this.#active;
      if (
        latest.state !== "healthy" ||
        latest.catalogGeneration !== previous.catalogGeneration ||
        active === undefined
      ) {
        active = undefined;
        if (latest.state === "healthy") {
          const log = this.#logForGeneration(latest.catalogGeneration);
          const service = this.#makeService(latest.catalogGeneration, log);
          await service.initialize();
          const checkpoint = await log.checkpoint();
          if (checkpoint.logId !== latest.logId) {
            throw new WorkspaceBindingCatalogConflictError(
              "Workspace catalog root points to another log",
            );
          }
          active = service;
        }
      }
      this.#manifest = latest;
      this.#active = active;
    });
    if (this.#requireManifest().pendingReset) {
      this.#startRecoveryOwner();
    }
  }

  async #writeManifest(
    manifest: PersistedRootManifest,
    expected: PersistedRootManifest | undefined,
    admission?:
      | { readonly kind: "interactive"; readonly abort: AbortSignal }
      | {
          readonly kind: "maintenance";
          readonly identity: unknown;
        },
  ): Promise<void> {
    await ensureDurableDirectory(this.#rootDir);
    const release = await acquireFileLock(`${this.#manifestPath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Workspace catalog root manifest",
    });
    try {
      const current = await this.#readManifest().catch((error) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (canonicalize(current ?? null) !== canonicalize(expected ?? null)) {
        throw new WorkspaceBindingCatalogConflictError(
          "Workspace catalog root manifest changed concurrently",
        );
      }
      const commit = async () => {
        claimDeviceCapacity("readBytes", 4 * 1024);
        claimDeviceCapacity("writeBytes", 4 * 1024);
        claimDeviceCapacity("ioOperations", 2);
        const temp = `${this.#manifestPath}.tmp-${process.pid}-${randomUUID()}`;
        const handle = await open(temp, "w", 0o600);
        try {
          await handle.writeFile(canonicalize(manifest), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, this.#manifestPath);
        await syncDirectory(this.#rootDir);
      };
      if (admission?.kind === "interactive") {
        await runWithDeviceCapacity(
          this.#serviceOptions.capacity,
          {
            serviceClass: "workload-interactive",
            atomic: RESET_RESERVATION_BUDGET,
            preferred: RESET_RESERVATION_BUDGET,
            maxWaitMs: 0,
          },
          admission.abort,
          commit,
        );
      } else if (admission?.kind === "maintenance") {
        await runStorageMaintenanceStep(
          this.#storageMaintenance,
          storageMaintenanceRequest(
            "workspace-catalog-reset",
            this.#rootDir,
            admission.identity,
            { obligation: "committed", maxWaitMs: 0 },
          ),
          commit,
        );
      } else {
        await commit();
      }
    } finally {
      await release();
    }
  }
}

export class WorkspaceBindingCatalogDegradedError extends Error {
  readonly code = "WORKSPACE_CATALOG_DEGRADED";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBindingCatalogDegradedError";
  }
}

export class WorkspaceBindingCatalogConflictError extends Error {
  readonly code = "WORKSPACE_CATALOG_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBindingCatalogConflictError";
  }
}

export const WORKSPACE_BINDING_ROOT_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "workspace-binding-root",
  producer: "WorkspaceBindingCatalog",
  recoveryOwner: "workspace-binding-recovery-owner",
  resourceIdentity: "workspace-catalog-reset:<device-root>",
  recoveryClass: "committed-forward-recovery",
  cases: [
    ...["healthy", "degraded", "pending-reset"].map((key) => ({ kind: "variant" as const, key, reasonCode: `WORKSPACE_ROOT_${key.replaceAll("-", "_").toUpperCase()}` })),
    ...["healthy-reset", "confirmation-mismatch", "generation-conflict", "reservation-conflict"].map((key) => ({ kind: "rejection" as const, key, reasonCode: `WORKSPACE_ROOT_${key.replaceAll("-", "_").toUpperCase()}` })),
    ...["malformed-manifest", "missing-active-log", "invalid-reset-genesis", "broken-generation-link"].map((key) => ({ kind: "corruption" as const, key, reasonCode: `WORKSPACE_ROOT_${key.replaceAll("-", "_").toUpperCase()}` })),
  ],
} as const);

function resetConfirmationDigest(
  control: LocalEnvironmentRecoveryContext,
): string {
  const confirmation = control.confirmation;
  if (
    confirmation.kind !== "workspace-binding-reset" ||
    confirmation.requestId !== control.requestId ||
    typeof confirmation.token !== "string" ||
    confirmation.token.length < 32 ||
    typeof confirmation.catalogGeneration !== "string" ||
    confirmation.catalogGeneration.length === 0
  ) {
    throw new WorkspaceBindingCatalogConflictError(
      "Workspace catalog reset confirmation is invalid",
    );
  }
  return protocolDigest("WorkspaceBindingResetConfirmation", 1, {
    kind: confirmation.kind,
    token: confirmation.token,
    requestId: confirmation.requestId,
    catalogGeneration: confirmation.catalogGeneration,
    issuedAt: confirmation.issuedAt,
  });
}

function validateFreshResetConfirmation(
  confirmation: LocalEnvironmentRecoveryContext["confirmation"],
  now: string,
): void {
  const issuedAt = Date.parse(confirmation.issuedAt);
  const current = Date.parse(now);
  if (
    !Number.isFinite(issuedAt) ||
    new Date(issuedAt).toISOString() !== confirmation.issuedAt ||
    issuedAt > current ||
    current - issuedAt > CONFIRMATION_MAX_AGE_MS
  ) {
    throw new WorkspaceBindingCatalogConflictError(
      "Workspace catalog reset confirmation has expired",
    );
  }
}

function resetGeneration(
  previousCatalogGeneration: string,
  confirmationDigest: string,
): string {
  return protocolDigest("WorkspaceBindingCatalogGeneration", 1, {
    previousCatalogGeneration,
    confirmationDigest,
  });
}

function validateManifest(value: unknown): PersistedRootManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace catalog root manifest is malformed");
  }
  const manifest = value as Record<string, unknown>;
  const allowed = new Set([
    "capabilityRevision",
    "catalogGeneration",
    "degradedReason",
    "logId",
    "pendingReset",
    "state",
    "version",
  ]);
  if (
    Object.keys(manifest).some((key) => !allowed.has(key)) ||
    manifest.version !== MANIFEST_VERSION ||
    (manifest.state !== "healthy" && manifest.state !== "degraded") ||
    typeof manifest.catalogGeneration !== "string" ||
    typeof manifest.logId !== "string" ||
    !Number.isSafeInteger(manifest.capabilityRevision) ||
    (manifest.capabilityRevision as number) < 1 ||
    (manifest.degradedReason !== undefined &&
      typeof manifest.degradedReason !== "string")
  ) {
    throw new Error("Workspace catalog root manifest is malformed");
  }
  workspaceCatalogGenerationStorageKey(manifest.catalogGeneration as string);
  if (
    (manifest.state === "healthy" &&
      (manifest.degradedReason !== undefined ||
        manifest.pendingReset !== undefined)) ||
    (manifest.state === "degraded" &&
      (typeof manifest.degradedReason !== "string" ||
        manifest.degradedReason.length === 0))
  ) {
    throw new Error("Workspace catalog root manifest state is contradictory");
  }
  if (manifest.pendingReset !== undefined) {
    validateReservation(manifest.pendingReset);
    if (
      manifest.state !== "degraded" ||
      manifest.pendingReset.previousCatalogGeneration !==
        manifest.catalogGeneration ||
      manifest.pendingReset.catalogGeneration === manifest.catalogGeneration
    ) {
      throw new Error(
        "Workspace catalog reset reservation contradicts its root",
      );
    }
  }
  return structuredClone(value) as PersistedRootManifest;
}

function validateResetReceipt(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace catalog reset receipt is malformed");
  }
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(",") !==
      "capabilityRevision,catalogGeneration,confirmationDigest,logId,preparedAt,previousCatalogGeneration,requestId" ||
    typeof receipt.requestId !== "string" ||
    typeof receipt.confirmationDigest !== "string" ||
    typeof receipt.previousCatalogGeneration !== "string" ||
    typeof receipt.catalogGeneration !== "string" ||
    typeof receipt.logId !== "string" ||
    !Number.isSafeInteger(receipt.capabilityRevision) ||
    (receipt.capabilityRevision as number) < 1 ||
    typeof receipt.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.preparedAt)) ||
    new Date(Date.parse(receipt.preparedAt)).toISOString() !==
      receipt.preparedAt
  ) {
    throw new Error("Workspace catalog reset receipt is malformed");
  }
  workspaceCatalogGenerationStorageKey(
    receipt.previousCatalogGeneration as string,
  );
  workspaceCatalogGenerationStorageKey(receipt.catalogGeneration as string);
  if (!/^sha256:[0-9a-f]{64}$/u.test(receipt.confirmationDigest as string)) {
    throw new Error("Workspace catalog reset receipt digest is malformed");
  }
  if (
    receipt.catalogGeneration !==
    resetGeneration(
      receipt.previousCatalogGeneration as string,
      receipt.confirmationDigest as string,
    )
  ) {
    throw new Error("Workspace catalog reset receipt generation is invalid");
  }
}

function validateReservation(
  value: unknown,
): asserts value is NonNullable<WorkspaceBindingRootManifest["pendingReset"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace catalog reset reservation is malformed");
  }
  const reservation = value as Record<string, unknown>;
  if (
    Object.keys(reservation).sort().join(",") !==
      "catalogGeneration,confirmationDigest,preparedAt,previousCatalogGeneration,requestId" ||
    Object.values(reservation).some(
      (entry) => typeof entry !== "string" || entry.length === 0,
    ) ||
    !Number.isFinite(Date.parse(reservation.preparedAt as string)) ||
    new Date(Date.parse(reservation.preparedAt as string)).toISOString() !==
      reservation.preparedAt ||
    reservation.catalogGeneration !==
      resetGeneration(
        reservation.previousCatalogGeneration as string,
        reservation.confirmationDigest as string,
      )
  ) {
    throw new Error("Workspace catalog reset reservation is malformed");
  }
  workspaceCatalogGenerationStorageKey(
    reservation.previousCatalogGeneration as string,
  );
  workspaceCatalogGenerationStorageKey(reservation.catalogGeneration as string);
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(reservation.confirmationDigest as string)
  ) {
    throw new Error("Workspace catalog reset reservation digest is malformed");
  }
}

function assertSameReservation(
  current: NonNullable<WorkspaceBindingRootManifest["pendingReset"]>,
  expected: NonNullable<WorkspaceBindingRootManifest["pendingReset"]>,
): void {
  if (canonicalize(current) !== canonicalize(expected)) {
    throw new WorkspaceBindingCatalogConflictError(
      "Workspace catalog reset reservation changed",
    );
  }
}

function reservationFromReceipt(
  receipt: WorkspaceBindingResetReceipt,
): NonNullable<WorkspaceBindingRootManifest["pendingReset"]> {
  return {
    requestId: receipt.requestId,
    confirmationDigest: receipt.confirmationDigest,
    previousCatalogGeneration: receipt.previousCatalogGeneration,
    catalogGeneration: receipt.catalogGeneration,
    preparedAt: receipt.preparedAt,
  };
}

function assertReceiptMatchesReservation(
  receipt: WorkspaceBindingResetReceipt,
  reservation: NonNullable<WorkspaceBindingRootManifest["pendingReset"]>,
): void {
  if (
    receipt.requestId !== reservation.requestId ||
    receipt.confirmationDigest !== reservation.confirmationDigest ||
    receipt.previousCatalogGeneration !==
      reservation.previousCatalogGeneration ||
    receipt.catalogGeneration !== reservation.catalogGeneration ||
    receipt.preparedAt !== reservation.preparedAt
  ) {
    throw new WorkspaceBindingCatalogConflictError(
      "Workspace catalog reset receipt does not bind its reservation",
    );
  }
}

export function workspaceCatalogGenerationStorageKey(
  generation: string,
): string {
  if (/^sha256:[0-9a-f]{64}$/u.test(generation)) {
    return `sha256-${generation.slice("sha256:".length)}`;
  }
  if (!/^[a-z0-9-]{1,80}$/u.test(generation)) {
    throw new Error("Workspace catalog generation is invalid");
  }
  return generation;
}

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as Error & { code: unknown }).code === "string"
  ) {
    return (error as Error & { code: string }).code;
  }
  return error instanceof Error ? error.name : "unknown";
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
