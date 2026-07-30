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
import {
  ensureDurableDirectory,
  SerialTaskQueue,
  syncDirectory,
} from "../persistence/index.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";
import {
  runInMaintenanceContext,
  runStorageMaintenanceStep,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceTaskRunner,
} from "../resources/index.js";
import {
  validateLocalEnvironmentControl,
  WorkspaceBindingService,
  type WorkspaceBindingServiceOptions,
} from "./workspace-bindings.js";

const MANIFEST_VERSION = 1;
const CONFIRMATION_MAX_AGE_MS = 5 * 60_000;

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
    "log" | "rootDir" | "resetGenesis"
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
  readonly #generationLogs = new Set<AuthorityCommitLog>();
  #manifest: PersistedRootManifest | undefined;
  #active: WorkspaceBindingService | undefined;
  #opening: Promise<void> | undefined;

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
    if (this.#manifest?.pendingReset) {
      void this.recover().catch(() => {});
    }
  }

  async status(): Promise<{
    state: "healthy" | "degraded";
    catalogGeneration: string;
    reason?: string;
  }> {
    await this.#ensureOpen();
    const manifest = this.#requireManifest();
    return {
      state: manifest.state,
      catalogGeneration: manifest.catalogGeneration,
      ...(manifest.degradedReason
        ? { reason: manifest.degradedReason }
        : {}),
    };
  }

  async beginReset(
    input: { expectedCatalogGeneration: string },
    control: LocalEnvironmentRecoveryContext,
  ): Promise<NonNullable<WorkspaceBindingRootManifest["pendingReset"]>> {
    validateLocalEnvironmentControl(control, this.#serviceOptions);
    await this.#ensureOpen();
    const confirmationDigest = validateResetConfirmation(
      control,
      this.#clock(),
    );
    return this.#manifestQueue.run(async () => {
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
        control.requestId,
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
      await this.#writeManifest(next);
      this.#manifest = next;
      return pendingReset;
    });
  }

  async completeReset(
    requestId: string,
    abort: AbortSignal,
  ): Promise<WorkspaceBindingResetReceipt> {
    await this.#ensureOpen();
    const manifest = this.#requireManifest();
    if (!manifest.pendingReset) {
      if (manifest.lastReset?.requestId === requestId) {
        return structuredClone(manifest.lastReset);
      }
      throw new WorkspaceBindingCatalogConflictError(
        "Workspace catalog reset is not reserved",
      );
    }
    if (manifest.pendingReset.requestId !== requestId) {
      throw new WorkspaceBindingCatalogConflictError(
        "Workspace catalog reset belongs to another request",
      );
    }
    return this.#runReservedReset(manifest.pendingReset, abort);
  }

  async recover(): Promise<void> {
    await this.#ensureOpen();
    const pending = this.#requireManifest().pendingReset;
    if (!pending) return;
    await runInMaintenanceContext("recovery", () =>
      this.#runReservedReset(
        pending,
        new AbortController().signal,
      ).then(() => undefined),
    );
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
    return this.#withHealthy((service) =>
      service.resolveWorkspace(bindingRef),
    );
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
    if (this.#requireManifest().state === "degraded") {
      return this.#serviceOptions.capabilitySnapshot([]);
    }
    return this.#withHealthy((service) => service.capabilitySnapshot());
  }

  versionInventory(): Promise<ExecutorVersionInventory> {
    return this.#serviceOptions.versionInventory();
  }

  stop(): void {
    this.#recoveryRunner.stop();
    for (const log of this.#generationLogs) {
      (
        log as AuthorityCommitLog & {
          stopStorageMaintenance?: () => void;
        }
      ).stopStorageMaintenance?.();
    }
    this.#generationLogs.clear();
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
    return this.#recoveryRunner.run(request, waiterAbort, async () =>
      runStorageMaintenanceStep(
        this.#storageMaintenance,
        storageMaintenanceRequest(
          "workspace-catalog-reset",
          this.#rootDir,
          {
            previousCatalogGeneration: reservation.previousCatalogGeneration,
            catalogGeneration: reservation.catalogGeneration,
          },
          { obligation: "committed" },
        ),
        async () => {
          const current = await this.#readManifest();
          if (!current.pendingReset) {
            if (current.catalogGeneration !== reservation.catalogGeneration) {
              throw new WorkspaceBindingCatalogConflictError(
                "Workspace catalog reset completed with another generation",
              );
            }
            return resetReceipt(current, reservation);
          }
          assertSameReservation(current.pendingReset, reservation);
          const log = this.#createGenerationLog(reservation.catalogGeneration);
          this.#generationLogs.add(log);
          const service = this.#makeService(
            reservation.catalogGeneration,
            log,
            {
              previousCatalogGeneration:
                reservation.previousCatalogGeneration,
              catalogGeneration: reservation.catalogGeneration,
              confirmationDigest: reservation.confirmationDigest,
            },
          );
          await service.initialize();
          const checkpoint = await log.checkpoint();
          const committed: PersistedRootManifest = {
            version: MANIFEST_VERSION,
            state: "healthy",
            catalogGeneration: reservation.catalogGeneration,
            logId: checkpoint.logId,
            capabilityRevision: current.capabilityRevision + 1,
          };
          const receipt = resetReceipt(committed, reservation);
          const next: PersistedRootManifest = {
            ...committed,
            lastReset: receipt,
          };
          await this.#writeManifest(next);
          this.#manifest = next;
          this.#active = service;
          await service.capabilitySnapshot();
          return receipt;
        },
      ),
    );
  }

  async #healthy(): Promise<WorkspaceBindingService> {
    await this.#ensureOpen();
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
      await this.#writeManifest(degraded);
      this.#manifest = degraded;
      this.#active = undefined;
      await this.#serviceOptions.capabilitySnapshot([]);
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
        await this.#writeManifest(manifest);
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
        await this.#writeManifest(manifest);
        this.#manifest = manifest;
        await this.#serviceOptions.capabilitySnapshot([]);
        return;
      }
    }
    this.#manifest = persisted;
    if (persisted.state === "degraded") {
      await this.#serviceOptions.capabilitySnapshot([]);
      return;
    }
    const log =
      persisted.catalogGeneration === "catalog-initial"
        ? this.#initialLog
        : this.#createGenerationLog(persisted.catalogGeneration);
    if (persisted.catalogGeneration !== "catalog-initial") {
      this.#generationLogs.add(log);
    }
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
      await this.#writeManifest(degraded);
      this.#manifest = degraded;
      await this.#serviceOptions.capabilitySnapshot([]);
    }
  }

  #makeService(
    generation: string,
    log: AuthorityCommitLog,
    resetGenesis?: WorkspaceBindingServiceOptions["resetGenesis"],
  ): WorkspaceBindingService {
    return new WorkspaceBindingService({
      ...this.#serviceOptions,
      rootDir: path.join(this.#rootDir, "generations", safeGeneration(generation)),
      log,
      ...(resetGenesis ? { resetGenesis } : {}),
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

  async #writeManifest(manifest: PersistedRootManifest): Promise<void> {
    await ensureDurableDirectory(this.#rootDir);
    const temp = `${this.#manifestPath}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(canonicalize(manifest), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.#manifestPath);
    await syncDirectory(this.#rootDir);
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

function validateResetConfirmation(
  control: LocalEnvironmentRecoveryContext,
  now: string,
) {
  const confirmation = control.confirmation;
  if (
    confirmation.kind !== "workspace-binding-reset" ||
    confirmation.requestId !== control.requestId ||
    typeof confirmation.token !== "string" ||
    confirmation.token.length < 16
  ) {
    throw new WorkspaceBindingCatalogConflictError(
      "Workspace catalog reset confirmation is invalid",
    );
  }
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
  return protocolDigest("WorkspaceBindingResetConfirmation", 1, {
    kind: confirmation.kind,
    token: confirmation.token,
    requestId: confirmation.requestId,
    catalogGeneration: confirmation.catalogGeneration,
    issuedAt: confirmation.issuedAt,
  });
}

function resetGeneration(
  previousCatalogGeneration: string,
  requestId: string,
  confirmationDigest: string,
): string {
  const digest = protocolDigest("WorkspaceBindingCatalogGeneration", 1, {
    previousCatalogGeneration,
    requestId,
    confirmationDigest,
  });
  return `catalog-${digest.slice("sha256:".length, "sha256:".length + 32)}`;
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
    "lastReset",
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
  if (manifest.pendingReset !== undefined) {
    validateReservation(manifest.pendingReset);
  }
  if (manifest.lastReset !== undefined) {
    validateResetReceipt(manifest.lastReset);
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
}

function validateReservation(value: unknown): void {
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
      reservation.preparedAt
  ) {
    throw new Error("Workspace catalog reset reservation is malformed");
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

function resetReceipt(
  manifest: PersistedRootManifest,
  reservation: NonNullable<WorkspaceBindingRootManifest["pendingReset"]>,
): WorkspaceBindingResetReceipt {
  return {
    requestId: reservation.requestId,
    confirmationDigest: reservation.confirmationDigest,
    previousCatalogGeneration: reservation.previousCatalogGeneration,
    catalogGeneration: manifest.catalogGeneration,
    logId: manifest.logId,
    capabilityRevision: manifest.capabilityRevision,
    preparedAt: reservation.preparedAt,
  };
}

function safeGeneration(generation: string): string {
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
