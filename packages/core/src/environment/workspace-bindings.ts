import { randomUUID } from "node:crypto";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AuthorityCommitLog,
  ProjectionCursor,
} from "../authority/index.js";
import { AuthorityStorageError } from "../authority/index.js";
import type {
  CapabilityDescriptor,
  EnvironmentPort,
  ExecutorVersionInventory,
  ImmediateRootResourceLease,
  LocalEnvironmentControlContext,
  LocalWorkspaceBinding,
  LogicalRecord,
  WorkspaceBindingAdminPort,
  WorkspaceBindingMigrationPort,
  WorkspaceBindingPatch,
} from "../contracts/index.js";
import {
  ensureDurableDirectory,
  SerialTaskQueue,
  syncDirectory,
} from "../persistence/index.js";
import {
  assertResourceLeaseActiveAt,
  protocolDigest,
  validateReservableResourceLease,
  type ProtocolSignatureVerifier,
} from "../protocol/index.js";
import {
  claimDeviceCapacity,
  deviceCapacityAdmissionId,
  DeviceCapacityAdmissionError,
  runWithDeviceCapacity,
  storageMaintenanceObligation,
  withDeviceCapacityStep,
  type DeviceCapacityArbiterPort,
  type DeviceCapacityBudget,
  type StorageMaintenanceTaskRunner,
} from "../resources/index.js";

const DIRECTORY_STREAM = "executor:workspace-bindings";
const ADMIN_STEP_BUDGET: DeviceCapacityBudget = {
  occupancy: {
    memoryReservationBytes: 64 * 1024,
    temporaryBytes: 0,
    slots: 1,
  },
  quantum: { readBytes: 64 * 1024, writeBytes: 64 * 1024, ioOperations: 8 },
};
const MIGRATION_STEP_BUDGET: DeviceCapacityBudget = {
  occupancy: {
    memoryReservationBytes: 128 * 1024,
    temporaryBytes: 0,
    slots: 1,
  },
  quantum: { readBytes: 128 * 1024, writeBytes: 128 * 1024, ioOperations: 12 },
};

type WorkspaceBindingRecord =
  | {
      t: "directory-established";
      deviceId: string;
    }
  | {
      t: "catalog-reset";
      previousCatalogGeneration: string;
      catalogGeneration: string;
      confirmationDigest: string;
    }
  | {
      t: "binding-created";
      requestId: string;
      requestDigest: string;
      binding: LocalWorkspaceBinding;
    }
  | {
      t: "binding-updated";
      requestId: string;
      requestDigest: string;
      binding: LocalWorkspaceBinding;
    }
  | {
      t: "binding-removed";
      requestId: string;
      requestDigest: string;
      bindingRef: string;
      previousRevision: number;
    }
  | {
      t: "binding-request-recorded";
      requestId: string;
      requestDigest: string;
      binding: LocalWorkspaceBinding;
    }
  | {
      t: "legacy-binding-staged";
      requestId: string;
      requestDigest: string;
      migrationId: string;
      sourceSnapshotToken: string;
      binding: LocalWorkspaceBinding;
    }
  | {
      t: "legacy-migration-activated" | "legacy-migration-abandoned";
      requestId: string;
      requestDigest: string;
      migrationId: string;
      sourceSnapshotToken: string;
      reason?: string;
    };

interface RequestOutcome {
  readonly digest: string;
  readonly binding?: LocalWorkspaceBinding;
  readonly removed?: {
    readonly bindingRef: string;
    readonly previousRevision: number;
  };
}

interface WorkspaceBindingProjection {
  established: boolean;
  deviceId?: string;
  readonly bindings: Map<string, LocalWorkspaceBinding>;
  readonly displayNames: Map<string, string>;
  readonly usedBindingRefs: Set<string>;
  readonly requests: Map<string, RequestOutcome>;
  readonly stagedLegacy: Map<
    string,
    {
      readonly migrationId: string;
      readonly sourceSnapshotToken: string;
      readonly binding: LocalWorkspaceBinding;
    }
  >;
  readonly legacyOwners: Map<
    string,
    { readonly migrationId: string; readonly sourceSnapshotToken: string }
  >;
  readonly migrationTerminals: Map<string, "activated" | "abandoned">;
}

export interface WorkspaceBindingServiceOptions {
  readonly rootDir: string;
  readonly deviceId: string;
  readonly executorId: string;
  readonly log: AuthorityCommitLog;
  readonly verifier: ProtocolSignatureVerifier;
  readonly capacity: DeviceCapacityArbiterPort;
  readonly migrationRunner: StorageMaintenanceTaskRunner;
  readonly capabilitySnapshot: (
    workspaces: CapabilityDescriptor["workspaces"],
  ) => Promise<CapabilityDescriptor>;
  readonly versionInventory: () => Promise<ExecutorVersionInventory>;
  readonly clock?: () => string;
  readonly bindingRefFactory?: () => string;
  readonly resetGenesis?: {
    readonly previousCatalogGeneration: string;
    readonly catalogGeneration: string;
    readonly confirmationDigest: string;
  };
}

/**
 * The device-local owner for workspace identities and raw paths.
 *
 * Every public view is derived from the append-only fact log. Raw paths never
 * leave this object except through `resolveWorkspace`, which is an in-process
 * executor port.
 */
export class WorkspaceBindingService
  implements
    EnvironmentPort,
    WorkspaceBindingAdminPort,
    WorkspaceBindingMigrationPort
{
  readonly #rootDir: string;
  readonly #markerPath: string;
  readonly #deviceId: string;
  readonly #executorId: string;
  readonly #log: AuthorityCommitLog;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #capacity: DeviceCapacityArbiterPort;
  readonly #migrationRunner: StorageMaintenanceTaskRunner;
  readonly #capabilitySnapshotFactory: WorkspaceBindingServiceOptions["capabilitySnapshot"];
  readonly #versionInventoryFactory: WorkspaceBindingServiceOptions["versionInventory"];
  readonly #clock: () => string;
  readonly #bindingRefFactory: () => string;
  readonly #resetGenesis: WorkspaceBindingServiceOptions["resetGenesis"];
  readonly #operations = new SerialTaskQueue();
  #projection: WorkspaceBindingProjection | undefined;
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: WorkspaceBindingServiceOptions) {
    this.#rootDir = path.resolve(options.rootDir);
    this.#markerPath = path.join(this.#rootDir, "directory-established");
    this.#deviceId = requireIdentifier(options.deviceId, "Workspace deviceId");
    this.#executorId = requireIdentifier(
      options.executorId,
      "Workspace executorId",
    );
    this.#log = options.log;
    this.#verifier = options.verifier;
    this.#capacity = options.capacity;
    this.#migrationRunner = options.migrationRunner;
    this.#capabilitySnapshotFactory = options.capabilitySnapshot;
    this.#versionInventoryFactory = options.versionInventory;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#bindingRefFactory =
      options.bindingRefFactory ?? (() => `wsp-${randomUUID()}`);
    this.#resetGenesis = options.resetGenesis;
  }

  /** Opens and validates the authority log without publishing capabilities. */
  async initialize(): Promise<void> {
    await this.#ensureOpen();
  }

  async list(
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding[]> {
    this.#validateControl(control);
    await this.#ensureOpen();
    return [...this.#state().bindings.values()]
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.bindingRef.localeCompare(right.bindingRef)
      )
      .map(cloneBinding);
  }

  async create(
    input: { displayName: string; absolutePath: string },
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding> {
    this.#validateControl(control);
    const displayName = normalizeWorkspaceDisplayName(input.displayName);
    const absolutePath = normalizeWorkspacePath(input.absolutePath);
    await this.#ensureOpen();
    const result = await this.#runAdminStep(control.abort, async () => {
      const requestDigest = protocolDigest("WorkspaceBindingCreate", 1, {
        displayName,
        absolutePath,
      });
      return this.#transact(control.requestId, requestDigest, (state) => {
        const duplicate = state.displayNames.get(displayNameKey(displayName));
        if (duplicate) {
          const existing = state.bindings.get(duplicate)!;
          if (existing.absolutePath === absolutePath) {
            return {
              value: cloneBinding(existing),
              record: {
                t: "binding-request-recorded",
                requestId: control.requestId,
                requestDigest,
                binding: cloneBinding(existing),
              },
            };
          }
          throw new WorkspaceBindingConflictError(
            "Workspace display name is already in use",
          );
        }
        const candidateRef = this.#nextBindingRef();
        const binding: LocalWorkspaceBinding = {
          bindingRef: candidateRef,
          revision: 1,
          displayName,
          absolutePath,
          workspaceBindingRevision: 1,
        };
        return {
          value: binding,
          record: {
            t: "binding-created",
            requestId: control.requestId,
            requestDigest,
            binding,
          },
        };
      });
    });
    await this.capabilitySnapshot();
    return result;
  }

  async update(
    bindingRef: string,
    patch: WorkspaceBindingPatch,
    expectedRevision: number,
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding> {
    this.#validateControl(control);
    requireIdentifier(bindingRef, "Workspace bindingRef");
    requirePositiveRevision(expectedRevision, "Workspace expected revision");
    const normalized = normalizePatch(patch);
    await this.#ensureOpen();
    const result = await this.#runAdminStep(control.abort, async () => {
      const requestDigest = protocolDigest("WorkspaceBindingUpdate", 1, {
        bindingRef,
        expectedRevision,
        patch: normalized,
      });
      return this.#transact(control.requestId, requestDigest, (state) => {
        const current = state.bindings.get(bindingRef);
        if (!current) throw new WorkspaceBindingNotFoundError(bindingRef);
        if (current.revision !== expectedRevision) {
          throw new WorkspaceBindingRevisionError(
            bindingRef,
            expectedRevision,
            current.revision,
          );
        }
        const displayName = normalized.displayName ?? current.displayName;
        const absolutePath = normalized.absolutePath ?? current.absolutePath;
        const conflictingRef = state.displayNames.get(
          displayNameKey(displayName),
        );
        if (conflictingRef && conflictingRef !== bindingRef) {
          throw new WorkspaceBindingConflictError(
            "Workspace display name is already in use",
          );
        }
        if (
          displayName === current.displayName &&
          absolutePath === current.absolutePath
        ) {
          return {
            value: cloneBinding(current),
            record: {
              t: "binding-request-recorded",
              requestId: control.requestId,
              requestDigest,
              binding: cloneBinding(current),
            },
          };
        }
        const binding: LocalWorkspaceBinding = {
          ...current,
          revision: current.revision + 1,
          displayName,
          absolutePath,
          workspaceBindingRevision:
            absolutePath === current.absolutePath
              ? current.workspaceBindingRevision
              : current.workspaceBindingRevision + 1,
        };
        return {
          value: binding,
          record: {
            t: "binding-updated",
            requestId: control.requestId,
            requestDigest,
            binding,
          },
        };
      });
    });
    await this.capabilitySnapshot();
    return result;
  }

  async remove(
    bindingRef: string,
    expectedRevision: number,
    control: LocalEnvironmentControlContext,
  ): Promise<void> {
    this.#validateControl(control);
    requireIdentifier(bindingRef, "Workspace bindingRef");
    requirePositiveRevision(expectedRevision, "Workspace expected revision");
    await this.#ensureOpen();
    await this.#runAdminStep(control.abort, async () => {
      const requestDigest = protocolDigest("WorkspaceBindingRemove", 1, {
        bindingRef,
        expectedRevision,
      });
      await this.#transact(control.requestId, requestDigest, (state) => {
        const current = state.bindings.get(bindingRef);
        if (!current) throw new WorkspaceBindingNotFoundError(bindingRef);
        if (current.revision !== expectedRevision) {
          throw new WorkspaceBindingRevisionError(
            bindingRef,
            expectedRevision,
            current.revision,
          );
        }
        return {
          value: undefined,
          record: {
            t: "binding-removed",
            requestId: control.requestId,
            requestDigest,
            bindingRef,
            previousRevision: current.revision,
          },
        };
      });
    });
    await this.capabilitySnapshot();
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
    requireIdentifier(input.migrationId, "Workspace migrationId");
    requireIdentifier(
      input.sourceSnapshotToken,
      "Workspace source snapshot token",
    );
    const displayName = normalizeWorkspaceDisplayName(input.displayName);
    const absolutePath = normalizeWorkspacePath(input.absolutePath);
    await this.#ensureOpen();
    const requestDigest = protocolDigest("WorkspaceBindingLegacyImport", 1, {
      migrationId: input.migrationId,
      sourceSnapshotToken: input.sourceSnapshotToken,
      displayName,
      absolutePath,
    });
    const requestId =
      `migration:${input.migrationId}:${input.sourceSnapshotToken}:${requestDigest}`;
    const result = await this.#migrationRunner.run(
      storageMaintenanceObligation(
        "workspace-migration",
        this.#deviceId,
        {
          migrationId: input.migrationId,
          sourceSnapshotToken: input.sourceSnapshotToken,
        },
        {
          owner: "workspace-binding-migrator",
          obligation: "committed",
        },
      ),
      abort,
      (taskAbort) =>
        this.#operations.run(async () => {
          const admission = await this.#capacity.acquire(
            {
              admissionId: deviceCapacityAdmissionId("workspace-migration"),
              serviceClass: "storage-recovery",
              atomic: MIGRATION_STEP_BUDGET,
              preferred: MIGRATION_STEP_BUDGET,
              maxWaitMs: 0,
            },
            taskAbort,
          );
          if (admission.kind !== "granted") {
            throw new DeviceCapacityAdmissionError(admission);
          }
          try {
              const terminal = this.#state().migrationTerminals.get(
                migrationKey(input.migrationId, input.sourceSnapshotToken),
              );
              if (terminal === "abandoned") {
                throw new WorkspaceBindingConflictError(
                  "Abandoned workspace migration cannot be revived",
                );
              }
              return await withDeviceCapacityStep(
              admission.permit,
              MIGRATION_STEP_BUDGET,
              async () => {
              claimDeviceCapacity("writeBytes", 4 * 1024);
              claimDeviceCapacity("ioOperations", 2);
              return this.#transact(requestId, requestDigest, (state) => {
                const samePath = [
                  ...state.bindings.values(),
                  ...[...state.stagedLegacy.values()]
                    .filter(
                      (entry) =>
                        entry.migrationId === input.migrationId &&
                        entry.sourceSnapshotToken ===
                          input.sourceSnapshotToken,
                    )
                    .map((entry) => entry.binding),
                ].find((binding) => binding.absolutePath === absolutePath);
                if (samePath) {
                  return {
                    value: cloneBinding(samePath),
                    record: {
                      t: "binding-request-recorded",
                      requestId,
                      requestDigest,
                      binding: cloneBinding(samePath),
                    },
                  };
                }
                const nameKey = displayNameKey(displayName);
                const stagedNameConflict = [...state.stagedLegacy.values()].some(
                  (entry) =>
                    displayNameKey(entry.binding.displayName) === nameKey,
                );
                if (
                  state.displayNames.has(nameKey) ||
                  stagedNameConflict
                ) {
                  throw new WorkspaceBindingConflictError(
                    "Legacy workspace display name conflicts with another path",
                  );
                }
                const candidateRef = this.#nextBindingRef();
                const binding: LocalWorkspaceBinding = {
                  bindingRef: candidateRef,
                  revision: 1,
                  displayName,
                  absolutePath,
                  workspaceBindingRevision: 1,
                };
                return {
                  value: binding,
                  record: {
                    t: "legacy-binding-staged",
                    requestId,
                    requestDigest,
                    migrationId: input.migrationId,
                    sourceSnapshotToken: input.sourceSnapshotToken,
                    binding,
                  },
                };
              });
              },
            );
          } finally {
            admission.permit.release();
          }
        }),
    );
    return result;
  }

  async activateLegacy(
    input: { migrationId: string; sourceSnapshotToken: string },
    abort: AbortSignal,
  ): Promise<void> {
    await this.#finishLegacyMigration(input, "activated", undefined, abort);
    await this.capabilitySnapshot();
  }

  async abandonLegacy(
    input: {
      migrationId: string;
      sourceSnapshotToken: string;
      reason: string;
    },
    abort: AbortSignal,
  ): Promise<void> {
    await this.#finishLegacyMigration(
      input,
      "abandoned",
      requireIdentifier(input.reason, "Workspace migration abandonment reason"),
      abort,
    );
    await this.capabilitySnapshot();
  }

  async #finishLegacyMigration(
    input: { migrationId: string; sourceSnapshotToken: string },
    status: "activated" | "abandoned",
    reason: string | undefined,
    abort: AbortSignal,
  ): Promise<void> {
    requireIdentifier(input.migrationId, "Workspace migrationId");
    requireIdentifier(
      input.sourceSnapshotToken,
      "Workspace source snapshot token",
    );
    await this.#ensureOpen();
    const requestDigest = protocolDigest(
      status === "activated"
        ? "WorkspaceBindingLegacyActivation"
        : "WorkspaceBindingLegacyAbandonment",
      1,
      { ...input, ...(reason ? { reason } : {}) },
    );
    const requestId = `migration:${status}:${input.migrationId}:${input.sourceSnapshotToken}`;
    await this.#migrationRunner.run(
      storageMaintenanceObligation(
        "workspace-migration",
        this.#deviceId,
        {
          migrationId: input.migrationId,
          sourceSnapshotToken: input.sourceSnapshotToken,
        },
        { owner: "workspace-binding-migrator", obligation: "committed" },
      ),
      abort,
      (taskAbort) =>
        this.#operations.run(async () => {
          const admission = await this.#capacity.acquire(
            {
              admissionId: deviceCapacityAdmissionId("workspace-migration"),
              serviceClass: "storage-recovery",
              atomic: MIGRATION_STEP_BUDGET,
              preferred: MIGRATION_STEP_BUDGET,
              maxWaitMs: 0,
            },
            taskAbort,
          );
          if (admission.kind !== "granted") {
            throw new DeviceCapacityAdmissionError(admission);
          }
          try {
            await withDeviceCapacityStep(
              admission.permit,
              MIGRATION_STEP_BUDGET,
              async () => {
              claimDeviceCapacity("writeBytes", 4 * 1024);
              claimDeviceCapacity("ioOperations", 2);
              await this.#transact(requestId, requestDigest, () => ({
                value: undefined,
                record: {
                  t:
                    status === "activated"
                      ? "legacy-migration-activated"
                      : "legacy-migration-abandoned",
                  requestId,
                  requestDigest,
                  migrationId: input.migrationId,
                  sourceSnapshotToken: input.sourceSnapshotToken,
                  ...(reason ? { reason } : {}),
                },
              }));
              },
            );
          } finally {
            admission.permit.release();
          }
        }),
    );
  }

  async resolveWorkspace(
    bindingRef: string,
  ): Promise<{ absolutePath: string; workspaceBindingRevision: number }> {
    requireIdentifier(bindingRef, "Workspace bindingRef");
    await this.#ensureOpen();
    const binding = this.#state().bindings.get(bindingRef);
    if (!binding) throw new WorkspaceBindingNotFoundError(bindingRef);
    return {
      absolutePath: binding.absolutePath,
      workspaceBindingRevision: binding.workspaceBindingRevision,
    };
  }

  async probePath(
    absolutePath: string,
  ): Promise<
    "directory" | "missing" | "non_directory" | "inaccessible" | "error"
  > {
    const normalized = normalizeWorkspacePath(absolutePath);
    try {
      const metadata = await stat(normalized);
      if (!metadata.isDirectory()) return "non_directory";
      try {
        await access(normalized);
        return "directory";
      } catch {
        return "inaccessible";
      }
    } catch (error) {
      return isNodeError(error, "ENOENT") ? "missing" : "error";
    }
  }

  async capabilitySnapshot(): Promise<CapabilityDescriptor> {
    await this.#ensureOpen();
    const workspaces = [...this.#state().bindings.values()]
      .sort((left, right) => left.bindingRef.localeCompare(right.bindingRef))
      .map(({ bindingRef, workspaceBindingRevision, displayName }) => ({
        bindingRef,
        workspaceBindingRevision,
        displayName,
      }));
    return this.#capabilitySnapshotFactory(workspaces);
  }

  versionInventory(): Promise<ExecutorVersionInventory> {
    return this.#versionInventoryFactory();
  }

  async #transact<T>(
    requestId: string,
    requestDigest: string,
    decide: (
      state: WorkspaceBindingProjection,
    ) => { value: T; record?: WorkspaceBindingRecord },
  ): Promise<T> {
    const current = this.#state();
    const transaction = await this.#log.transactProjection(
      current,
      reduceWorkspaceBindingProjection,
      (state) => {
        const previous = state.requests.get(requestId);
        if (previous) {
          if (previous.digest !== requestDigest) {
            throw new WorkspaceBindingConflictError(
              "Workspace requestId was reused with different inputs",
            );
          }
          if (previous.binding) {
            return {
              kind: "return",
              value: cloneBinding(previous.binding) as T,
            };
          }
          return { kind: "return", value: undefined as T };
        }
        const decision = decide(state);
        if (!decision.record) {
          return { kind: "return", value: decision.value };
        }
        return {
          kind: "append",
          entries: [
            {
              stream: DIRECTORY_STREAM,
              body: decision.record,
            } satisfies LogicalRecord<WorkspaceBindingRecord>,
          ],
          value: decision.value,
        };
      },
      { cursor: this.#cursor, stream: DIRECTORY_STREAM },
    );
    this.#projection = transaction.state;
    this.#cursor = transaction.cursor;
    return transaction.value;
  }

  async #runAdminStep<T>(
    abort: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#operations.run(() =>
      runWithDeviceCapacity(
        this.#capacity,
        {
          serviceClass: "workload-interactive",
          atomic: ADMIN_STEP_BUDGET,
          preferred: ADMIN_STEP_BUDGET,
          maxWaitMs: 0,
        },
        abort,
        async () => {
          claimDeviceCapacity("writeBytes", 4 * 1024);
          claimDeviceCapacity("ioOperations", 2);
          return operation();
        },
      ),
    );
  }

  #validateControl(control: LocalEnvironmentControlContext): void {
    validateLocalEnvironmentControl(control, {
      deviceId: this.#deviceId,
      executorId: this.#executorId,
      verifier: this.#verifier,
      clock: this.#clock,
    });
  }

  #nextBindingRef(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = requireIdentifier(
        this.#bindingRefFactory(),
        "Workspace bindingRef",
      );
      if (!this.#state().usedBindingRefs.has(candidate)) return candidate;
    }
    throw new WorkspaceBindingConflictError(
      "Workspace binding identity source repeatedly collided",
    );
  }

  #state(): WorkspaceBindingProjection {
    if (!this.#projection) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Workspace binding directory has not been opened",
      );
    }
    return this.#projection;
  }

  async #ensureOpen(): Promise<void> {
    this.#opening ??= this.#open();
    return this.#opening;
  }

  async #open(): Promise<void> {
    await ensureDurableDirectory(this.#rootDir);
    const markerExists = await exists(this.#markerPath);
    const logPath = "logPath" in this.#log
      ? String((this.#log as AuthorityCommitLog & { logPath: string }).logPath)
      : undefined;
    const logExists = logPath === undefined ? true : await exists(logPath);
    if (markerExists && !logExists) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Established workspace binding log is missing",
      );
    }
    const snapshot = await this.#log.readSnapshot<WorkspaceBindingRecord>();
    let state = emptyWorkspaceBindingProjection();
    for (const commit of snapshot.commits) {
      for (const entry of commit.entries) {
        if (entry.stream !== DIRECTORY_STREAM) continue;
        state = reduceWorkspaceBindingProjection(state, entry);
      }
    }
    this.#cursor = snapshot.cursor;
    if (!state.established) {
      const bindingEntriesExist = snapshot.commits.some((commit) =>
        commit.entries.some((entry) => entry.stream === DIRECTORY_STREAM),
      );
      if (markerExists || bindingEntriesExist) {
        throw new AuthorityStorageError(
          "artifact-corrupt",
          "Workspace binding directory lacks its establishment fact",
        );
      }
      const commit = await this.#log.append<WorkspaceBindingRecord>([
        {
          stream: DIRECTORY_STREAM,
          body: { t: "directory-established", deviceId: this.#deviceId },
        },
        ...(this.#resetGenesis
          ? [
              {
                stream: DIRECTORY_STREAM,
                body: {
                  t: "catalog-reset" as const,
                  ...this.#resetGenesis,
                },
              },
            ]
          : []),
      ]);
      state = reduceWorkspaceBindingProjection(
        state,
        commit.entries[0] as LogicalRecord<WorkspaceBindingRecord>,
      );
      const refreshed =
        await this.#log.readSnapshot<WorkspaceBindingRecord>();
      this.#cursor = refreshed.cursor;
    }
    this.#projection = state;
    if (state.deviceId !== this.#deviceId) {
      throw new AuthorityStorageError(
        "invalid-authority-record",
        "Workspace binding directory belongs to another device",
      );
    }
    if (!markerExists) await writeEstablishmentMarker(this.#markerPath);
  }
}

export function localEnvironmentControlSubject(
  deviceId: string,
  requestNonce: string,
): string {
  return `environment-admin:${requireIdentifier(
    deviceId,
    "Workspace deviceId",
  )}:${requestNonce}`;
}

export function validateLocalEnvironmentControl(
  control: LocalEnvironmentControlContext,
  options: {
    readonly deviceId: string;
    readonly executorId: string;
    readonly verifier: ProtocolSignatureVerifier;
    readonly clock?: () => string;
  },
): ImmediateRootResourceLease {
  requireIdentifier(control.requestId, "Environment control requestId");
  if (control.abort.aborted) {
    throw new WorkspaceBindingCancelledError();
  }
  const lease = validateReservableResourceLease(
    control.lease,
    options.verifier,
  ) as ImmediateRootResourceLease;
  assertResourceLeaseActiveAt(
    lease,
    (options.clock ?? (() => new Date().toISOString()))(),
  );
  if (
    lease.parentId !== undefined ||
    lease.admissionClass !== "interactive" ||
    lease.workload.kind !== "control" ||
    lease.workload.id !== control.requestId ||
    lease.scopeBinding.kind !== "control" ||
    lease.scopeBinding.subject !== control.requestId ||
    !control.requestId.startsWith(
      `${localEnvironmentControlSubject(options.deviceId, "")}`,
    ) ||
    lease.audience.executorId !== options.executorId
  ) {
    throw new TypeError(
      "Resource lease does not authorize local environment control",
    );
  }
  return lease;
}

export function normalizeWorkspaceDisplayName(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("Workspace display name must be a string");
  }
  const value = input.normalize("NFC").trim();
  if (value.length === 0 || value.length > 160) {
    throw new TypeError("Workspace display name is outside its bounded range");
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Workspace display name contains control characters");
  }
  return value;
}

export function normalizeWorkspacePath(input: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new TypeError("Workspace path must be a non-empty string");
  }
  const value = path.normalize(input.trim());
  if (!path.isAbsolute(value)) {
    throw new TypeError("Workspace path must be absolute");
  }
  return value;
}

function normalizePatch(
  patch: WorkspaceBindingPatch,
): { displayName?: string; absolutePath?: string } {
  if (
    patch === null ||
    typeof patch !== "object" ||
    Array.isArray(patch)
  ) {
    throw new TypeError("Workspace binding patch must be an object");
  }
  const keys = Object.keys(patch).sort();
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "absolutePath" && key !== "displayName")
  ) {
    throw new TypeError("Workspace binding patch fields are invalid");
  }
  return {
    ...(typeof patch.displayName === "string"
      ? { displayName: normalizeWorkspaceDisplayName(patch.displayName) }
      : {}),
    ...(typeof patch.absolutePath === "string"
      ? { absolutePath: normalizeWorkspacePath(patch.absolutePath) }
      : {}),
  };
}

function reduceWorkspaceBindingProjection(
  previous: WorkspaceBindingProjection,
  entry: LogicalRecord<WorkspaceBindingRecord>,
): WorkspaceBindingProjection {
  const state = cloneProjection(previous);
  const record = validateRecord(entry.body);
  switch (record.t) {
    case "directory-established":
      if (state.established) {
        throw corruptDirectory("Workspace directory was established twice");
      }
      state.established = true;
      state.deviceId = record.deviceId;
      break;
    case "catalog-reset":
      if (!state.established || state.bindings.size !== 0) {
        throw corruptDirectory(
          "Workspace catalog reset genesis is not the first catalog fact",
        );
      }
      break;
    case "binding-created":
      if (
        state.usedBindingRefs.has(record.binding.bindingRef) ||
        state.displayNames.has(displayNameKey(record.binding.displayName))
      ) {
        throw corruptDirectory("Workspace binding identity was reused");
      }
      state.bindings.set(
        record.binding.bindingRef,
        cloneBinding(record.binding),
      );
      state.displayNames.set(
        displayNameKey(record.binding.displayName),
        record.binding.bindingRef,
      );
      state.usedBindingRefs.add(record.binding.bindingRef);
      state.requests.set(record.requestId, {
        digest: record.requestDigest,
        binding: cloneBinding(record.binding),
      });
      break;
    case "binding-request-recorded":
      if (state.requests.has(record.requestId)) {
        throw corruptDirectory("Workspace request identity was reused");
      }
      state.requests.set(record.requestId, {
        digest: record.requestDigest,
        binding: cloneBinding(record.binding),
      });
      break;
    case "legacy-binding-staged":
      if (state.usedBindingRefs.has(record.binding.bindingRef)) {
        throw corruptDirectory("Workspace binding identity was reused");
      }
      if (
        [...state.stagedLegacy.values()].some(
          (entry) =>
            displayNameKey(entry.binding.displayName) ===
            displayNameKey(record.binding.displayName),
        ) ||
        state.displayNames.has(displayNameKey(record.binding.displayName))
      ) {
        throw corruptDirectory("Staged workspace display name is duplicated");
      }
      state.usedBindingRefs.add(record.binding.bindingRef);
      state.stagedLegacy.set(record.binding.bindingRef, {
        migrationId: record.migrationId,
        sourceSnapshotToken: record.sourceSnapshotToken,
        binding: cloneBinding(record.binding),
      });
      state.requests.set(record.requestId, {
        digest: record.requestDigest,
        binding: cloneBinding(record.binding),
      });
      break;
    case "binding-updated": {
      const current = state.bindings.get(record.binding.bindingRef);
      if (!current || record.binding.revision !== current.revision + 1) {
        throw corruptDirectory("Workspace binding update is not continuous");
      }
      state.displayNames.delete(displayNameKey(current.displayName));
      const owner = state.displayNames.get(
        displayNameKey(record.binding.displayName),
      );
      if (owner && owner !== record.binding.bindingRef) {
        throw corruptDirectory("Workspace binding display name is duplicated");
      }
      state.bindings.set(
        record.binding.bindingRef,
        cloneBinding(record.binding),
      );
      state.displayNames.set(
        displayNameKey(record.binding.displayName),
        record.binding.bindingRef,
      );
      state.requests.set(record.requestId, {
        digest: record.requestDigest,
        binding: cloneBinding(record.binding),
      });
      break;
    }
    case "binding-removed": {
      const current = state.bindings.get(record.bindingRef);
      if (!current || current.revision !== record.previousRevision) {
        throw corruptDirectory("Workspace binding tombstone is inconsistent");
      }
      state.bindings.delete(record.bindingRef);
      state.displayNames.delete(displayNameKey(current.displayName));
      state.requests.set(record.requestId, {
        digest: record.requestDigest,
        removed: {
          bindingRef: record.bindingRef,
          previousRevision: record.previousRevision,
        },
      });
      break;
    }
    case "legacy-migration-activated": {
      const terminalKey = migrationKey(
        record.migrationId,
        record.sourceSnapshotToken,
      );
      const previousTerminal = state.migrationTerminals.get(terminalKey);
      if (previousTerminal && previousTerminal !== "activated") {
        throw corruptDirectory("Abandoned workspace migration was reactivated");
      }
      const staged = [...state.stagedLegacy].filter(
        ([, value]) =>
          value.migrationId === record.migrationId &&
          value.sourceSnapshotToken === record.sourceSnapshotToken,
      );
      for (const [bindingRef, value] of staged) {
        const nameKey = displayNameKey(value.binding.displayName);
        if (
          state.bindings.has(bindingRef) ||
          state.displayNames.has(nameKey)
        ) {
          throw corruptDirectory(
            "Legacy workspace activation conflicts with active state",
          );
        }
        state.bindings.set(bindingRef, cloneBinding(value.binding));
        state.displayNames.set(nameKey, bindingRef);
        state.legacyOwners.set(bindingRef, {
          migrationId: record.migrationId,
          sourceSnapshotToken: record.sourceSnapshotToken,
        });
        state.stagedLegacy.delete(bindingRef);
      }
      state.migrationTerminals.set(terminalKey, "activated");
      state.requests.set(record.requestId, { digest: record.requestDigest });
      break;
    }
    case "legacy-migration-abandoned": {
      const terminalKey = migrationKey(
        record.migrationId,
        record.sourceSnapshotToken,
      );
      for (const [bindingRef, value] of [...state.stagedLegacy]) {
        if (
          value.migrationId === record.migrationId &&
          value.sourceSnapshotToken === record.sourceSnapshotToken
        ) {
          state.stagedLegacy.delete(bindingRef);
        }
      }
      for (const [bindingRef, owner] of [...state.legacyOwners]) {
        if (
          owner.migrationId !== record.migrationId ||
          owner.sourceSnapshotToken !== record.sourceSnapshotToken
        ) {
          continue;
        }
        const binding = state.bindings.get(bindingRef);
        if (binding) {
          state.bindings.delete(bindingRef);
          state.displayNames.delete(displayNameKey(binding.displayName));
        }
        state.legacyOwners.delete(bindingRef);
      }
      state.migrationTerminals.set(terminalKey, "abandoned");
      state.requests.set(record.requestId, { digest: record.requestDigest });
      break;
    }
  }
  return state;
}

function validateRecord(input: WorkspaceBindingRecord): WorkspaceBindingRecord {
  if (!input || typeof input !== "object") {
    throw corruptDirectory("Workspace binding record is malformed");
  }
  if (input.t === "directory-established") {
    requireIdentifier(input.deviceId, "Workspace directory deviceId");
    return input;
  }
  if (input.t === "catalog-reset") {
    requireIdentifier(
      input.previousCatalogGeneration,
      "Previous workspace catalog generation",
    );
    requireIdentifier(
      input.catalogGeneration,
      "Workspace catalog generation",
    );
    if (
      typeof input.confirmationDigest !== "string" ||
      !input.confirmationDigest.startsWith("sha256:")
    ) {
      throw corruptDirectory(
        "Workspace catalog reset confirmation digest is invalid",
      );
    }
    return input;
  }
  requireIdentifier(input.requestId, "Workspace binding requestId");
  if (
    typeof input.requestDigest !== "string" ||
    !input.requestDigest.startsWith("sha256:")
  ) {
    throw corruptDirectory("Workspace binding request digest is invalid");
  }
  if (input.t === "binding-removed") {
    requireIdentifier(input.bindingRef, "Workspace bindingRef");
    requirePositiveRevision(
      input.previousRevision,
      "Workspace previous revision",
    );
    return input;
  }
  if (
    input.t === "legacy-migration-activated" ||
    input.t === "legacy-migration-abandoned"
  ) {
    requireIdentifier(input.migrationId, "Workspace migrationId");
    requireIdentifier(
      input.sourceSnapshotToken,
      "Workspace source snapshot token",
    );
    if (input.t === "legacy-migration-abandoned") {
      requireIdentifier(input.reason, "Workspace migration abandonment reason");
    }
    return input;
  }
  if (!("binding" in input)) {
    throw corruptDirectory("Workspace binding record has no binding");
  }
  validateBinding(input.binding);
  if (input.t === "legacy-binding-staged") {
    requireIdentifier(input.migrationId, "Workspace migrationId");
    requireIdentifier(
      input.sourceSnapshotToken,
      "Workspace source snapshot token",
    );
  }
  return input;
}

function validateBinding(binding: LocalWorkspaceBinding): void {
  requireIdentifier(binding.bindingRef, "Workspace bindingRef");
  requirePositiveRevision(binding.revision, "Workspace binding revision");
  normalizeWorkspaceDisplayName(binding.displayName);
  normalizeWorkspacePath(binding.absolutePath);
  requirePositiveRevision(
    binding.workspaceBindingRevision,
    "Workspace execution revision",
  );
}

function emptyWorkspaceBindingProjection(): WorkspaceBindingProjection {
  return {
    established: false,
    deviceId: undefined,
    bindings: new Map(),
    displayNames: new Map(),
    usedBindingRefs: new Set(),
    requests: new Map(),
    stagedLegacy: new Map(),
    legacyOwners: new Map(),
    migrationTerminals: new Map(),
  };
}

function cloneProjection(
  source: WorkspaceBindingProjection,
): WorkspaceBindingProjection {
  return {
    established: source.established,
    deviceId: source.deviceId,
    bindings: new Map(
      [...source.bindings].map(([key, value]) => [key, cloneBinding(value)]),
    ),
    displayNames: new Map(source.displayNames),
    usedBindingRefs: new Set(source.usedBindingRefs),
    requests: new Map(
      [...source.requests].map(([key, value]) => [
        key,
        {
          digest: value.digest,
          ...(value.binding ? { binding: cloneBinding(value.binding) } : {}),
          ...(value.removed ? { removed: { ...value.removed } } : {}),
        },
      ]),
    ),
    stagedLegacy: new Map(
      [...source.stagedLegacy].map(([key, value]) => [
        key,
        {
          migrationId: value.migrationId,
          sourceSnapshotToken: value.sourceSnapshotToken,
          binding: cloneBinding(value.binding),
        },
      ]),
    ),
    legacyOwners: new Map(
      [...source.legacyOwners].map(([key, value]) => [key, { ...value }]),
    ),
    migrationTerminals: new Map(source.migrationTerminals),
  };
}

function cloneBinding(binding: LocalWorkspaceBinding): LocalWorkspaceBinding {
  return { ...binding };
}

function displayNameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en-US");
}

function migrationKey(migrationId: string, sourceSnapshotToken: string): string {
  return `${migrationId}\u0000${sourceSnapshotToken}`;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 480 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function requirePositiveRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

async function writeEstablishmentMarker(markerPath: string): Promise<void> {
  const handle = await open(markerPath, "wx", 0o600).catch(
    async (error: unknown) => {
      if (isNodeError(error, "EEXIST")) return undefined;
      throw error;
    },
  );
  if (!handle) return;
  try {
    await handle.writeFile("workspace-binding-directory-v1\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(markerPath));
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    },
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function corruptDirectory(message: string): AuthorityStorageError {
  return new AuthorityStorageError("artifact-corrupt", message);
}

export class WorkspaceBindingNotFoundError extends Error {
  constructor(readonly bindingRef: string) {
    super(`Workspace binding does not exist: ${bindingRef}`);
    this.name = "WorkspaceBindingNotFoundError";
  }
}

export class WorkspaceBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBindingConflictError";
  }
}

export class WorkspaceBindingRevisionError extends Error {
  constructor(
    readonly bindingRef: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Workspace binding revision conflict for ${bindingRef}: expected ${expected}, actual ${actual}`,
    );
    this.name = "WorkspaceBindingRevisionError";
  }
}

export class WorkspaceBindingCancelledError extends Error {
  constructor() {
    super("Workspace binding operation was cancelled");
    this.name = "WorkspaceBindingCancelledError";
  }
}
