import { randomUUID } from "node:crypto";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AuthorityCommitLog,
  PhysicalStorageStepRunner,
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
  WorkspaceBindingResetReceipt,
} from "../contracts/index.js";
import { defineDurableRuntimeContract } from "../contracts/durable-contract.js";
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
  runWithDeviceCapacity,
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
  type DeviceCapacityArbiterPort,
  type DeviceCapacityBudget,
  type StorageMaintenanceGovernorPort,
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
type WorkspaceBindingRequestIdentity =
  | {
      kind: "create";
      displayName: string;
      absolutePath: string;
    }
  | {
      kind: "update";
      bindingRef: string;
      expectedRevision: number;
      patch: WorkspaceBindingPatch;
    }
  | {
      kind: "remove";
      bindingRef: string;
      expectedRevision: number;
    }
  | {
      kind: "legacy-import";
      migrationId: string;
      sourceSnapshotToken: string;
      displayName: string;
      absolutePath: string;
    }
  | {
      kind: "legacy-activate";
      migrationId: string;
      sourceSnapshotToken: string;
    }
  | {
      kind: "legacy-abandon";
      migrationId: string;
      sourceSnapshotToken: string;
      reason: string;
    };

type WorkspaceBindingRecord =
  | {
      t: "directory-established";
      deviceId: string;
    }
  | {
      t: "catalog-reset";
      requestId: string;
      previousCatalogGeneration: string;
      catalogGeneration: string;
      confirmationDigest: string;
      logId: string;
      capabilityRevision: number;
      preparedAt: string;
    }
  | {
      t: "binding-created";
      requestId: string;
      requestDigest: string;
      request: WorkspaceBindingRequestIdentity;
      binding: LocalWorkspaceBinding;
    }
  | {
      t: "binding-updated";
      requestId: string;
      requestDigest: string;
      request: WorkspaceBindingRequestIdentity;
      binding: LocalWorkspaceBinding;
    }
  | {
      t: "binding-removed";
      requestId: string;
      requestDigest: string;
      request: WorkspaceBindingRequestIdentity;
      bindingRef: string;
      previousRevision: number;
    }
  | {
      t: "binding-request-recorded";
      requestId: string;
      requestDigest: string;
      request: WorkspaceBindingRequestIdentity;
      binding: LocalWorkspaceBinding;
    }
  | {
      t: "legacy-binding-staged";
      requestId: string;
      requestDigest: string;
      request: WorkspaceBindingRequestIdentity;
      migrationId: string;
      sourceSnapshotToken: string;
      binding: LocalWorkspaceBinding;
    }
  | {
      t: "legacy-migration-activated" | "legacy-migration-abandoned";
      requestId: string;
      requestDigest: string;
      request: WorkspaceBindingRequestIdentity;
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
  resetReceipt?: WorkspaceBindingResetReceipt;
}

export interface WorkspaceBindingServiceOptions {
  readonly rootDir: string;
  readonly catalogGeneration: string;
  readonly deviceId: string;
  readonly executorId: string;
  readonly log: AuthorityCommitLog;
  readonly verifier: ProtocolSignatureVerifier;
  readonly capacity: DeviceCapacityArbiterPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly capabilitySnapshot: (
    publication: WorkspaceCapabilityPublication,
  ) => Promise<CapabilityDescriptor>;
  readonly versionInventory: () => Promise<ExecutorVersionInventory>;
  readonly clock?: () => string;
  readonly bindingRefFactory?: () => string;
  readonly resetGenesis?: {
    readonly requestId: string;
    readonly previousCatalogGeneration: string;
    readonly catalogGeneration: string;
    readonly confirmationDigest: string;
    readonly logId: string;
    readonly capabilityRevision: number;
    readonly preparedAt: string;
  };
}

export interface WorkspaceCapabilityPublication {
  readonly catalogGeneration: string;
  readonly state: "healthy" | "degraded";
  readonly workspaces: CapabilityDescriptor["workspaces"];
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
  readonly #catalogGeneration: string;
  readonly #deviceId: string;
  readonly #executorId: string;
  readonly #log: AuthorityCommitLog;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #capacity: DeviceCapacityArbiterPort;
  readonly #storageMaintenance: StorageMaintenanceGovernorPort | undefined;
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
    this.#catalogGeneration = requireIdentifier(
      options.catalogGeneration,
      "Workspace catalog generation",
    );
    this.#deviceId = requireIdentifier(options.deviceId, "Workspace deviceId");
    this.#executorId = requireIdentifier(
      options.executorId,
      "Workspace executorId",
    );
    this.#log = options.log;
    this.#verifier = options.verifier;
    this.#capacity = options.capacity;
    this.#storageMaintenance = options.storageMaintenance;
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

  async resetReceipt(): Promise<WorkspaceBindingResetReceipt | undefined> {
    await this.#ensureOpen();
    return this.#operations.run(async () => {
      await this.#synchronizeProjection();
      const receipt = this.#state().resetReceipt;
      return receipt ? structuredClone(receipt) : undefined;
    });
  }

  async list(
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding[]> {
    this.#validateControl(control);
    await this.#ensureOpen();
    return this.#operations.run(async () => {
      await this.#synchronizeProjection();
      return [...this.#state().bindings.values()]
        .sort(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) ||
            left.bindingRef.localeCompare(right.bindingRef),
        )
        .map(cloneBinding);
    });
  }

  async create(
    input: { displayName: string; absolutePath: string },
    control: LocalEnvironmentControlContext,
  ): Promise<LocalWorkspaceBinding> {
    this.#validateControl(control);
    const displayName = normalizeWorkspaceDisplayName(input.displayName);
    const absolutePath = normalizeWorkspacePath(input.absolutePath);
    await this.#ensureOpen();
    const result = await this.#runAdminStep(
      control.abort,
      async (runPhysicalStep) => {
        const request: WorkspaceBindingRequestIdentity = {
          kind: "create",
          displayName,
          absolutePath,
        };
        const requestDigest = workspaceBindingRequestDigest(request);
        return this.#transact(
          control.requestId,
          requestDigest,
          (state) => {
            const duplicate = state.displayNames.get(
              displayNameKey(displayName),
            );
            if (duplicate) {
              const existing = state.bindings.get(duplicate)!;
              if (existing.absolutePath === absolutePath) {
                return {
                  value: cloneBinding(existing),
                  record: {
                    t: "binding-request-recorded",
                    requestId: control.requestId,
                    requestDigest,
                    request,
                    binding: cloneBinding(existing),
                  },
                };
              }
              throw new WorkspaceBindingConflictError(
                "Workspace display name is already in use",
              );
            }
            const candidateRef = this.#nextBindingRef(state);
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
                request,
                binding,
              },
            };
          },
          runPhysicalStep,
        );
      },
    );
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
    const result = await this.#runAdminStep(
      control.abort,
      async (runPhysicalStep) => {
        const request: WorkspaceBindingRequestIdentity = {
          kind: "update",
          bindingRef,
          expectedRevision,
          patch: normalized,
        };
        const requestDigest = workspaceBindingRequestDigest(request);
        return this.#transact(
          control.requestId,
          requestDigest,
          (state) => {
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
            const absolutePath =
              normalized.absolutePath ?? current.absolutePath;
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
                  request,
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
                request,
                binding,
              },
            };
          },
          runPhysicalStep,
        );
      },
    );
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
    await this.#runAdminStep(control.abort, async (runPhysicalStep) => {
      const request: WorkspaceBindingRequestIdentity = {
        kind: "remove",
        bindingRef,
        expectedRevision,
      };
      const requestDigest = workspaceBindingRequestDigest(request);
      await this.#transact(
        control.requestId,
        requestDigest,
        (state) => {
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
              request,
              bindingRef,
              previousRevision: current.revision,
            },
          };
        },
        runPhysicalStep,
      );
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
    const request: WorkspaceBindingRequestIdentity = {
      kind: "legacy-import",
      migrationId: input.migrationId,
      sourceSnapshotToken: input.sourceSnapshotToken,
      displayName,
      absolutePath,
    };
    const requestDigest = workspaceBindingRequestDigest(request);
    const requestId = `migration:${input.migrationId}:${input.sourceSnapshotToken}:${requestDigest}`;
    const assertMigrationOpen = (state: WorkspaceBindingProjection) => {
      const terminal = state.migrationTerminals.get(
        migrationKey(input.migrationId, input.sourceSnapshotToken),
      );
      if (terminal) {
        throw new WorkspaceBindingConflictError(
          `Workspace migration ${terminal} cannot be revived`,
        );
      }
    };
    const result = await this.#operations.run(() => {
      abort.throwIfAborted();
      return this.#transact(
        requestId,
        requestDigest,
        (state) => {
          const samePath = [
            ...state.bindings.values(),
            ...[...state.stagedLegacy.values()]
              .filter(
                (entry) =>
                  entry.migrationId === input.migrationId &&
                  entry.sourceSnapshotToken === input.sourceSnapshotToken,
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
                request,
                binding: cloneBinding(samePath),
              },
            };
          }
          const nameKey = displayNameKey(displayName);
          const stagedNameConflict = [...state.stagedLegacy.values()].some(
            (entry) => displayNameKey(entry.binding.displayName) === nameKey,
          );
          if (state.displayNames.has(nameKey) || stagedNameConflict) {
            throw new WorkspaceBindingConflictError(
              "Legacy workspace display name conflicts with another path",
              "legacy-name-conflict",
            );
          }
          const candidateRef = this.#nextBindingRef(state);
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
              request,
              migrationId: input.migrationId,
              sourceSnapshotToken: input.sourceSnapshotToken,
              binding,
            },
          };
        },
        this.#migrationPhysicalStep({
          migrationId: input.migrationId,
          sourceSnapshotToken: input.sourceSnapshotToken,
          operation: "import-binding",
          requestDigest,
        }),
        assertMigrationOpen,
      );
    });
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
    const request: WorkspaceBindingRequestIdentity =
      status === "activated"
        ? { kind: "legacy-activate", ...input }
        : {
            kind: "legacy-abandon",
            ...input,
            reason: reason!,
          };
    const requestDigest = workspaceBindingRequestDigest(request);
    const requestId = `migration:${status}:${input.migrationId}:${input.sourceSnapshotToken}`;
    await this.#operations.run(() => {
      abort.throwIfAborted();
      return this.#transact(
        requestId,
        requestDigest,
        (state) => {
          const terminal = state.migrationTerminals.get(
            migrationKey(input.migrationId, input.sourceSnapshotToken),
          );
          if (terminal && terminal !== status) {
            throw new WorkspaceBindingConflictError(
              `Workspace migration is already ${terminal}`,
            );
          }
          return {
            value: undefined,
            record: {
              t:
                status === "activated"
                  ? "legacy-migration-activated"
                  : "legacy-migration-abandoned",
              requestId,
              requestDigest,
              request,
              migrationId: input.migrationId,
              sourceSnapshotToken: input.sourceSnapshotToken,
              ...(reason ? { reason } : {}),
            },
          };
        },
        this.#migrationPhysicalStep({
          migrationId: input.migrationId,
          sourceSnapshotToken: input.sourceSnapshotToken,
          operation: status,
        }),
      );
    });
  }

  async resolveWorkspace(
    bindingRef: string,
  ): Promise<{ absolutePath: string; workspaceBindingRevision: number }> {
    requireIdentifier(bindingRef, "Workspace bindingRef");
    await this.#ensureOpen();
    return this.#operations.run(async () => {
      await this.#synchronizeProjection();
      const binding = this.#state().bindings.get(bindingRef);
      if (!binding) throw new WorkspaceBindingNotFoundError(bindingRef);
      return {
        absolutePath: binding.absolutePath,
        workspaceBindingRevision: binding.workspaceBindingRevision,
      };
    });
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
    const workspaces = await this.#operations.run(async () => {
      await this.#synchronizeProjection();
      return [...this.#state().bindings.values()]
        .sort((left, right) => left.bindingRef.localeCompare(right.bindingRef))
        .map(({ bindingRef, workspaceBindingRevision, displayName }) => ({
          bindingRef,
          workspaceBindingRevision,
          displayName,
        }));
    });
    return this.#capabilitySnapshotFactory({
      catalogGeneration: this.#catalogGeneration,
      state: "healthy",
      workspaces,
    });
  }

  versionInventory(): Promise<ExecutorVersionInventory> {
    return this.#versionInventoryFactory();
  }

  async #transact<T>(
    requestId: string,
    requestDigest: string,
    decide: (state: WorkspaceBindingProjection) => {
      value: T;
      record?: WorkspaceBindingRecord;
    },
    runPhysicalStep?: PhysicalStorageStepRunner,
    assertReplayAllowed?: (state: WorkspaceBindingProjection) => void,
  ): Promise<T> {
    const current = this.#state();
    const transaction = await this.#log.transactProjection(
      current,
      reduceWorkspaceBindingProjection,
      (state) => {
        assertReplayAllowed?.(state);
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
      {
        cursor: this.#cursor,
        stream: DIRECTORY_STREAM,
        ...(runPhysicalStep ? { runPhysicalStep } : {}),
      },
    );
    this.#projection = transaction.state;
    this.#cursor = transaction.cursor;
    return transaction.value;
  }

  async #runAdminStep<T>(
    abort: AbortSignal,
    operation: (runPhysicalStep: PhysicalStorageStepRunner) => Promise<T>,
  ): Promise<T> {
    return this.#operations.run(() =>
      operation((physicalStep) =>
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
            return physicalStep();
          },
        ),
      ),
    );
  }

  #migrationPhysicalStep(
    identity: Readonly<Record<string, string>>,
  ): PhysicalStorageStepRunner {
    return (operation) =>
      runStorageMaintenanceStep(
        this.#storageMaintenance,
        storageMaintenanceRequest(
          "workspace-migration",
          this.#deviceId,
          identity,
          { obligation: "committed" },
        ),
        async () => {
          claimDeviceCapacity("writeBytes", 4 * 1024);
          claimDeviceCapacity("ioOperations", 2);
          return operation();
        },
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

  #nextBindingRef(state: WorkspaceBindingProjection): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = requireIdentifier(
        this.#bindingRefFactory(),
        "Workspace bindingRef",
      );
      if (!state.usedBindingRefs.has(candidate)) return candidate;
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

  async #synchronizeProjection(): Promise<void> {
    const transaction = await this.#log.transactProjection<
      WorkspaceBindingProjection,
      WorkspaceBindingRecord,
      undefined
    >(
      this.#state(),
      reduceWorkspaceBindingProjection,
      () => ({ kind: "return", value: undefined }),
      { cursor: this.#cursor, stream: DIRECTORY_STREAM },
    );
    this.#projection = transaction.state;
    this.#cursor = transaction.cursor;
  }

  async #open(): Promise<void> {
    await ensureDurableDirectory(this.#rootDir);
    const markerExists = await exists(this.#markerPath);
    const logPath =
      "logPath" in this.#log
        ? String(
            (this.#log as AuthorityCommitLog & { logPath: string }).logPath,
          )
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
      for (const entry of commit.entries) {
        state = reduceWorkspaceBindingProjection(
          state,
          entry as LogicalRecord<WorkspaceBindingRecord>,
        );
      }
      const refreshed = await this.#log.readSnapshot<WorkspaceBindingRecord>();
      state = emptyWorkspaceBindingProjection();
      for (const envelope of refreshed.commits) {
        for (const entry of envelope.entries) {
          if (entry.stream !== DIRECTORY_STREAM) continue;
          state = reduceWorkspaceBindingProjection(state, entry);
        }
      }
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
    throw new WorkspaceBindingControlError(
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

function normalizePatch(patch: WorkspaceBindingPatch): WorkspaceBindingPatch {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Workspace binding patch must be an object");
  }
  const keys = Object.keys(patch).sort();
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "absolutePath" && key !== "displayName")
  ) {
    throw new TypeError("Workspace binding patch fields are invalid");
  }
  const displayName = patch.displayName;
  const absolutePath = patch.absolutePath;
  if (
    ("displayName" in patch && typeof displayName !== "string") ||
    ("absolutePath" in patch && typeof absolutePath !== "string")
  ) {
    throw new TypeError("Workspace binding patch values are invalid");
  }
  if (typeof displayName === "string" && typeof absolutePath === "string") {
    return {
      displayName: normalizeWorkspaceDisplayName(displayName),
      absolutePath: normalizeWorkspacePath(absolutePath),
    };
  }
  if (typeof displayName === "string") {
    return {
      displayName: normalizeWorkspaceDisplayName(displayName),
    };
  }
  if (typeof absolutePath !== "string") {
    throw new TypeError("Workspace binding patch values are invalid");
  }
  return {
    absolutePath: normalizeWorkspacePath(absolutePath),
  };
}

function reduceWorkspaceBindingProjection(
  previous: WorkspaceBindingProjection,
  entry: LogicalRecord<WorkspaceBindingRecord>,
): WorkspaceBindingProjection {
  const state = cloneProjection(previous);
  const record = validateRecord(entry.body);
  if ("requestId" in record && state.requests.has(record.requestId)) {
    throw corruptDirectory("Workspace request identity was reused");
  }
  switch (record.t) {
    case "directory-established":
      if (state.established) {
        throw corruptDirectory("Workspace directory was established twice");
      }
      state.established = true;
      state.deviceId = record.deviceId;
      break;
    case "catalog-reset":
      if (
        !state.established ||
        state.bindings.size !== 0 ||
        state.resetReceipt
      ) {
        throw corruptDirectory(
          "Workspace catalog reset genesis is not the first catalog fact",
        );
      }
      state.resetReceipt = {
        requestId: record.requestId,
        confirmationDigest: record.confirmationDigest,
        previousCatalogGeneration: record.previousCatalogGeneration,
        catalogGeneration: record.catalogGeneration,
        logId: record.logId,
        capabilityRevision: record.capabilityRevision,
        preparedAt: record.preparedAt,
      };
      break;
    case "binding-created":
      if (
        record.binding.revision !== 1 ||
        record.binding.workspaceBindingRevision !== 1 ||
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
      assertRecordedRequestOutcome(state, record);
      state.requests.set(record.requestId, {
        digest: record.requestDigest,
        binding: cloneBinding(record.binding),
      });
      break;
    case "legacy-binding-staged":
      if (
        record.binding.revision !== 1 ||
        record.binding.workspaceBindingRevision !== 1 ||
        state.migrationTerminals.has(
          migrationKey(record.migrationId, record.sourceSnapshotToken),
        ) ||
        state.usedBindingRefs.has(record.binding.bindingRef)
      ) {
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
      const request = record.request;
      if (
        request.kind !== "update" ||
        request.expectedRevision !== current.revision ||
        record.binding.displayName !==
          (request.patch.displayName ?? current.displayName) ||
        record.binding.absolutePath !==
          (request.patch.absolutePath ?? current.absolutePath) ||
        record.binding.workspaceBindingRevision !==
          (record.binding.absolutePath === current.absolutePath
            ? current.workspaceBindingRevision
            : current.workspaceBindingRevision + 1)
      ) {
        throw corruptDirectory(
          "Workspace binding update result contradicts its request",
        );
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
      if (previousTerminal) {
        throw corruptDirectory("Workspace migration terminal was repeated");
      }
      const staged = [...state.stagedLegacy].filter(
        ([, value]) =>
          value.migrationId === record.migrationId &&
          value.sourceSnapshotToken === record.sourceSnapshotToken,
      );
      for (const [bindingRef, value] of staged) {
        const nameKey = displayNameKey(value.binding.displayName);
        if (state.bindings.has(bindingRef) || state.displayNames.has(nameKey)) {
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
      if (state.migrationTerminals.has(terminalKey)) {
        throw corruptDirectory("Workspace migration terminal was repeated");
      }
      for (const [bindingRef, value] of [...state.stagedLegacy]) {
        if (
          value.migrationId === record.migrationId &&
          value.sourceSnapshotToken === record.sourceSnapshotToken
        ) {
          state.stagedLegacy.delete(bindingRef);
        }
      }
      state.migrationTerminals.set(terminalKey, "abandoned");
      state.requests.set(record.requestId, { digest: record.requestDigest });
      break;
    }
  }
  return state;
}

function assertRecordedRequestOutcome(
  state: WorkspaceBindingProjection,
  record: Extract<WorkspaceBindingRecord, { t: "binding-request-recorded" }>,
): void {
  const request = record.request;
  const active = state.bindings.get(record.binding.bindingRef);
  const staged = state.stagedLegacy.get(record.binding.bindingRef)?.binding;
  const existing = active ?? staged;
  if (!existing || !sameBinding(existing, record.binding)) {
    throw corruptDirectory(
      "Workspace replay result is not present in authoritative state",
    );
  }
  if (request.kind === "update") {
    if (
      request.expectedRevision !== existing.revision ||
      (request.patch.displayName !== undefined &&
        request.patch.displayName !== existing.displayName) ||
      (request.patch.absolutePath !== undefined &&
        request.patch.absolutePath !== existing.absolutePath)
    ) {
      throw corruptDirectory(
        "Workspace update replay contradicts its current binding",
      );
    }
  }
  if (request.kind === "legacy-import" && !staged && !active) {
    throw corruptDirectory("Legacy workspace replay has no imported binding");
  }
}

function sameBinding(
  left: LocalWorkspaceBinding,
  right: LocalWorkspaceBinding,
): boolean {
  return (
    left.bindingRef === right.bindingRef &&
    left.revision === right.revision &&
    left.displayName === right.displayName &&
    left.absolutePath === right.absolutePath &&
    left.workspaceBindingRevision === right.workspaceBindingRevision
  );
}

function validateRecord(input: WorkspaceBindingRecord): WorkspaceBindingRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw corruptDirectory("Workspace binding record is malformed");
  }
  switch (input.t) {
    case "directory-established":
      assertRecordKeys(input, ["deviceId", "t"], "Workspace directory genesis");
      requireIdentifier(input.deviceId, "Workspace directory deviceId");
      return input;
    case "catalog-reset":
      assertRecordKeys(
        input,
        [
          "capabilityRevision",
          "catalogGeneration",
          "confirmationDigest",
          "logId",
          "preparedAt",
          "previousCatalogGeneration",
          "requestId",
          "t",
        ],
        "Workspace catalog reset genesis",
      );
      requireIdentifier(
        input.previousCatalogGeneration,
        "Previous workspace catalog generation",
      );
      requireIdentifier(
        input.catalogGeneration,
        "Workspace catalog generation",
      );
      if (
        input.catalogGeneration !==
        protocolDigest("WorkspaceBindingCatalogGeneration", 1, {
          previousCatalogGeneration: input.previousCatalogGeneration,
          confirmationDigest: input.confirmationDigest,
        })
      ) {
        throw corruptDirectory(
          "Workspace catalog reset generation is inconsistent",
        );
      }
      requireIdentifier(input.requestId, "Workspace catalog reset requestId");
      requireIdentifier(input.logId, "Workspace catalog reset logId");
      requireDigest(
        input.confirmationDigest,
        "Workspace catalog reset confirmation digest",
      );
      requirePositiveRevision(
        input.capabilityRevision,
        "Workspace catalog reset capability revision",
      );
      requireCanonicalTime(
        input.preparedAt,
        "Workspace catalog reset preparation time",
      );
      return input;
    case "binding-created":
    case "binding-updated":
    case "binding-request-recorded":
      assertRecordKeys(
        input,
        ["binding", "request", "requestDigest", "requestId", "t"],
        "Workspace binding record",
      );
      break;
    case "binding-removed":
      assertRecordKeys(
        input,
        [
          "bindingRef",
          "previousRevision",
          "request",
          "requestDigest",
          "requestId",
          "t",
        ],
        "Workspace binding removal",
      );
      break;
    case "legacy-binding-staged":
      assertRecordKeys(
        input,
        [
          "binding",
          "migrationId",
          "request",
          "requestDigest",
          "requestId",
          "sourceSnapshotToken",
          "t",
        ],
        "Legacy workspace binding",
      );
      break;
    case "legacy-migration-activated":
      assertRecordKeys(
        input,
        [
          "migrationId",
          "request",
          "requestDigest",
          "requestId",
          "sourceSnapshotToken",
          "t",
        ],
        "Legacy workspace migration activation",
      );
      break;
    case "legacy-migration-abandoned":
      assertRecordKeys(
        input,
        [
          "migrationId",
          "reason",
          "request",
          "requestDigest",
          "requestId",
          "sourceSnapshotToken",
          "t",
        ],
        "Legacy workspace migration abandonment",
      );
      break;
    default:
      throw corruptDirectory("Workspace binding record tag is unknown");
  }
  requireIdentifier(input.requestId, "Workspace binding requestId");
  requireDigest(input.requestDigest, "Workspace binding request digest");
  const request = validateWorkspaceBindingRequest(input.request);
  if (workspaceBindingRequestDigest(request) !== input.requestDigest) {
    throw corruptDirectory("Workspace binding request digest is inconsistent");
  }
  if (input.t === "binding-removed") {
    if (
      request.kind !== "remove" ||
      request.bindingRef !== input.bindingRef ||
      request.expectedRevision !== input.previousRevision
    ) {
      throw corruptDirectory(
        "Workspace binding removal does not bind its request",
      );
    }
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
    const expectedKind =
      input.t === "legacy-migration-activated"
        ? "legacy-activate"
        : "legacy-abandon";
    if (
      request.kind !== expectedKind ||
      request.migrationId !== input.migrationId ||
      request.sourceSnapshotToken !== input.sourceSnapshotToken ||
      (request.kind === "legacy-abandon" && request.reason !== input.reason)
    ) {
      throw corruptDirectory(
        "Workspace migration terminal does not bind its request",
      );
    }
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
    if (
      request.kind !== "legacy-import" ||
      request.migrationId !== input.migrationId ||
      request.sourceSnapshotToken !== input.sourceSnapshotToken ||
      request.displayName !== input.binding.displayName ||
      request.absolutePath !== input.binding.absolutePath
    ) {
      throw corruptDirectory(
        "Legacy workspace binding does not bind its request",
      );
    }
    requireIdentifier(input.migrationId, "Workspace migrationId");
    requireIdentifier(
      input.sourceSnapshotToken,
      "Workspace source snapshot token",
    );
  } else if (input.t === "binding-created") {
    if (
      request.kind !== "create" ||
      request.displayName !== input.binding.displayName ||
      request.absolutePath !== input.binding.absolutePath
    ) {
      throw corruptDirectory(
        "Workspace binding creation does not bind its request",
      );
    }
  } else if (input.t === "binding-updated") {
    if (
      request.kind !== "update" ||
      request.bindingRef !== input.binding.bindingRef
    ) {
      throw corruptDirectory(
        "Workspace binding update does not bind its request",
      );
    }
  } else if (input.t === "binding-request-recorded") {
    if (
      (request.kind === "create" &&
        (request.displayName !== input.binding.displayName ||
          request.absolutePath !== input.binding.absolutePath)) ||
      (request.kind === "update" &&
        request.bindingRef !== input.binding.bindingRef) ||
      (request.kind === "legacy-import" &&
        (request.displayName !== input.binding.displayName ||
          request.absolutePath !== input.binding.absolutePath)) ||
      (request.kind !== "create" &&
        request.kind !== "update" &&
        request.kind !== "legacy-import")
    ) {
      throw corruptDirectory(
        "Workspace replay result does not bind its request",
      );
    }
  }
  return input;
}

function validateWorkspaceBindingRequest(
  value: unknown,
): WorkspaceBindingRequestIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corruptDirectory("Workspace binding request is malformed");
  }
  const request = value as Record<string, unknown>;
  switch (request.kind) {
    case "create": {
      assertRecordKeys(
        request,
        ["absolutePath", "displayName", "kind"],
        "Workspace create request",
      );
      const displayName = normalizeWorkspaceDisplayName(
        request.displayName as string,
      );
      const absolutePath = normalizeWorkspacePath(
        request.absolutePath as string,
      );
      if (
        displayName !== request.displayName ||
        absolutePath !== request.absolutePath
      ) {
        throw corruptDirectory("Workspace create request is not canonical");
      }
      return { kind: "create", displayName, absolutePath };
    }
    case "update": {
      assertRecordKeys(
        request,
        ["bindingRef", "expectedRevision", "kind", "patch"],
        "Workspace update request",
      );
      const bindingRef = requireIdentifier(
        request.bindingRef,
        "Workspace bindingRef",
      );
      const expectedRevision = requirePositiveRevision(
        request.expectedRevision,
        "Workspace expected revision",
      );
      const patch = normalizePatch(request.patch as WorkspaceBindingPatch);
      if (
        Object.keys(patch).sort().join(",") !==
        Object.keys(request.patch as object)
          .sort()
          .join(",")
      ) {
        throw corruptDirectory("Workspace update patch is not canonical");
      }
      return { kind: "update", bindingRef, expectedRevision, patch };
    }
    case "remove":
      assertRecordKeys(
        request,
        ["bindingRef", "expectedRevision", "kind"],
        "Workspace remove request",
      );
      return {
        kind: "remove",
        bindingRef: requireIdentifier(
          request.bindingRef,
          "Workspace bindingRef",
        ),
        expectedRevision: requirePositiveRevision(
          request.expectedRevision,
          "Workspace expected revision",
        ),
      };
    case "legacy-import": {
      assertRecordKeys(
        request,
        [
          "absolutePath",
          "displayName",
          "kind",
          "migrationId",
          "sourceSnapshotToken",
        ],
        "Legacy workspace import request",
      );
      const displayName = normalizeWorkspaceDisplayName(
        request.displayName as string,
      );
      const absolutePath = normalizeWorkspacePath(
        request.absolutePath as string,
      );
      if (
        displayName !== request.displayName ||
        absolutePath !== request.absolutePath
      ) {
        throw corruptDirectory(
          "Legacy workspace import request is not canonical",
        );
      }
      return {
        kind: "legacy-import",
        migrationId: requireIdentifier(
          request.migrationId,
          "Workspace migrationId",
        ),
        sourceSnapshotToken: requireIdentifier(
          request.sourceSnapshotToken,
          "Workspace source snapshot token",
        ),
        displayName,
        absolutePath,
      };
    }
    case "legacy-activate":
      assertRecordKeys(
        request,
        ["kind", "migrationId", "sourceSnapshotToken"],
        "Legacy workspace activation request",
      );
      return {
        kind: "legacy-activate",
        migrationId: requireIdentifier(
          request.migrationId,
          "Workspace migrationId",
        ),
        sourceSnapshotToken: requireIdentifier(
          request.sourceSnapshotToken,
          "Workspace source snapshot token",
        ),
      };
    case "legacy-abandon":
      assertRecordKeys(
        request,
        ["kind", "migrationId", "reason", "sourceSnapshotToken"],
        "Legacy workspace abandonment request",
      );
      return {
        kind: "legacy-abandon",
        migrationId: requireIdentifier(
          request.migrationId,
          "Workspace migrationId",
        ),
        sourceSnapshotToken: requireIdentifier(
          request.sourceSnapshotToken,
          "Workspace source snapshot token",
        ),
        reason: requireIdentifier(
          request.reason,
          "Workspace migration abandonment reason",
        ),
      };
    default:
      throw corruptDirectory("Workspace binding request tag is unknown");
  }
}

function workspaceBindingRequestDigest(
  request: WorkspaceBindingRequestIdentity,
): string {
  switch (request.kind) {
    case "create":
      return protocolDigest("WorkspaceBindingCreate", 1, {
        displayName: request.displayName,
        absolutePath: request.absolutePath,
      });
    case "update":
      return protocolDigest("WorkspaceBindingUpdate", 1, {
        bindingRef: request.bindingRef,
        expectedRevision: request.expectedRevision,
        patch: request.patch,
      });
    case "remove":
      return protocolDigest("WorkspaceBindingRemove", 1, {
        bindingRef: request.bindingRef,
        expectedRevision: request.expectedRevision,
      });
    case "legacy-import":
      return protocolDigest("WorkspaceBindingLegacyImport", 1, {
        migrationId: request.migrationId,
        sourceSnapshotToken: request.sourceSnapshotToken,
        displayName: request.displayName,
        absolutePath: request.absolutePath,
      });
    case "legacy-activate":
      return protocolDigest("WorkspaceBindingLegacyActivation", 1, {
        migrationId: request.migrationId,
        sourceSnapshotToken: request.sourceSnapshotToken,
      });
    case "legacy-abandon":
      return protocolDigest("WorkspaceBindingLegacyAbandonment", 1, {
        migrationId: request.migrationId,
        sourceSnapshotToken: request.sourceSnapshotToken,
        reason: request.reason,
      });
  }
}

function validateBinding(binding: LocalWorkspaceBinding): void {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw corruptDirectory("Workspace binding is malformed");
  }
  assertRecordKeys(
    binding,
    [
      "absolutePath",
      "bindingRef",
      "displayName",
      "revision",
      "workspaceBindingRevision",
    ],
    "Workspace binding",
  );
  requireIdentifier(binding.bindingRef, "Workspace bindingRef");
  requirePositiveRevision(binding.revision, "Workspace binding revision");
  if (
    normalizeWorkspaceDisplayName(binding.displayName) !== binding.displayName
  ) {
    throw corruptDirectory("Workspace binding display name is not canonical");
  }
  if (normalizeWorkspacePath(binding.absolutePath) !== binding.absolutePath) {
    throw corruptDirectory("Workspace binding path is not canonical");
  }
  requirePositiveRevision(
    binding.workspaceBindingRevision,
    "Workspace execution revision",
  );
}

function assertRecordKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw corruptDirectory(`${label} fields are invalid`);
  }
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw corruptDirectory(`${label} is invalid`);
  }
  return value;
}

function requireCanonicalTime(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw corruptDirectory(`${label} is invalid`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw corruptDirectory(`${label} is invalid`);
  }
  return value;
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
    resetReceipt: undefined,
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
    resetReceipt: source.resetReceipt
      ? structuredClone(source.resetReceipt)
      : undefined,
  };
}

function cloneBinding(binding: LocalWorkspaceBinding): LocalWorkspaceBinding {
  return { ...binding };
}

function displayNameKey(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase("en-US");
}

function migrationKey(
  migrationId: string,
  sourceSnapshotToken: string,
): string {
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
  readonly reasonCode = "WORKSPACE_BINDING_NOT_FOUND";

  constructor(readonly bindingRef: string) {
    super(`Workspace binding does not exist: ${bindingRef}`);
    this.name = "WorkspaceBindingNotFoundError";
  }
}

export class WorkspaceBindingConflictError extends Error {
  readonly reasonCode = "WORKSPACE_BINDING_CONFLICT";

  constructor(
    message: string,
    readonly reason: "conflict" | "legacy-name-conflict" = "conflict",
  ) {
    super(message);
    this.name = "WorkspaceBindingConflictError";
  }
}

export class WorkspaceBindingRevisionError extends Error {
  readonly reasonCode = "WORKSPACE_BINDING_REVISION_CONFLICT";

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
  readonly reasonCode = "WORKSPACE_BINDING_CANCELLED";

  constructor() {
    super("Workspace binding operation was cancelled");
    this.name = "WorkspaceBindingCancelledError";
  }
}

export const WORKSPACE_BINDING_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "workspace-binding",
  producer: "WorkspaceBindingService",
  recoveryOwner: "workspace-binding-recovery-owner",
  resourceIdentity: "workspace-binding:<deviceId>",
  recoveryClass: "authority-replay",
  cases: [
    ...["directory-established", "catalog-reset", "binding-created", "binding-updated", "binding-removed", "request-recorded", "legacy-binding-staged", "legacy-migration-activated", "legacy-migration-abandoned"]
      .map((key) => ({ kind: "variant" as const, key })),
    { kind: "rejection", key: "control-lease", reasonCode: "WORKSPACE_BINDING_CONTROL_FORBIDDEN" },
    { kind: "rejection", key: "name-conflict", reasonCode: "WORKSPACE_BINDING_CONFLICT" },
    { kind: "rejection", key: "revision-conflict", reasonCode: "WORKSPACE_BINDING_REVISION_CONFLICT" },
    { kind: "rejection", key: "tombstoned-reference", reasonCode: "WORKSPACE_BINDING_NOT_FOUND" },
    { kind: "corruption", key: "missing-establishment", reasonCode: "AUTHORITY_ARTIFACT_CORRUPT" },
    { kind: "corruption", key: "invalid-record", reasonCode: "AUTHORITY_ARTIFACT_CORRUPT" },
    { kind: "corruption", key: "broken-log-tail", reasonCode: "AUTHORITY_RECORD_INVALID" },
  ],
} as const);

export class WorkspaceBindingControlError extends TypeError {
  readonly reasonCode = "WORKSPACE_BINDING_CONTROL_FORBIDDEN";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBindingControlError";
  }
}
