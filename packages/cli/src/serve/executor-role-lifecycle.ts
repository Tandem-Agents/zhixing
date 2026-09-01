import {
  StartupRollback,
  type StartupCleanupHandle,
} from "./startup-rollback.js";

/**
 * The existing Executor-only non-Server cleanup order.
 *
 * This is deliberately not derived from acquisition order: local accepted
 * work and evidence admission close before the job/Mesh pair, while the data
 * plane, Authority maintenance and MCP remain available until their current
 * consumers have settled.
 */
export const EXECUTOR_ROLE_LIFECYCLE_DESCRIPTORS = [
  { owner: "executor-role", id: "localConversationOwner.close" },
  { owner: "executor-role", id: "evidenceHandler.stopAccepting" },
  { owner: "executor-role", id: "localWorkspaceHost.close" },
  { owner: "executor-role", id: "executorJobOwnerLifecycle.close" },
  { owner: "executor-role", id: "executorDataPlane.close" },
  { owner: "executor-role", id: "authorityRuntime.stopStorageMaintenance" },
  { owner: "executor-role", id: "mcpRuntime.close" },
] as const;

export type ExecutorRoleLifecycleIdentity =
  (typeof EXECUTOR_ROLE_LIFECYCLE_DESCRIPTORS)[number]["id"];

type DirectExecutorRoleLifecycleIdentity = Exclude<
  ExecutorRoleLifecycleIdentity,
  "authorityRuntime.stopStorageMaintenance"
>;

interface StoredCleanup {
  readonly handle: StartupCleanupHandle;
}

/**
 * Owns the finite non-Server lifetime of the Executor-only role.
 *
 * Resources contribute one idempotent handle at their first safe ownership
 * point. Partial startup and normal role termination call the same handles;
 * the Server/state/timer lifecycle remains outside this owner.
 */
export class ExecutorRoleLifecycle {
  readonly #entries = new Map<ExecutorRoleLifecycleIdentity, StoredCleanup>();
  readonly #authorityRollback = new StartupRollback();
  #authorityRollbackClaimed = false;
  #authorityAdopted = false;
  #sealed = false;
  #closing: Promise<void> | undefined;

  acquire(
    identity: DirectExecutorRoleLifecycleIdentity,
    cleanup: () => void | Promise<void>,
  ): StartupCleanupHandle {
    this.#assertCanContribute(identity);
    const handle = createIdempotentCleanupHandle(identity, cleanup);
    this.#entries.set(identity, { handle });
    return handle;
  }

  authorityStartupRollback(): StartupRollback {
    this.#assertCanContribute("authorityRuntime.stopStorageMaintenance");
    if (this.#authorityRollbackClaimed) {
      throw new Error("Executor Authority startup rollback was already claimed");
    }
    this.#authorityRollbackClaimed = true;
    return this.#authorityRollback;
  }

  adoptAuthority(handle: StartupCleanupHandle): StartupCleanupHandle {
    const identity = "authorityRuntime.stopStorageMaintenance";
    this.#assertCanContribute(identity);
    if (handle.name !== identity) {
      throw new Error(
        `Executor role lifecycle handle identity mismatch: expected ${identity}, got ${handle.name}`,
      );
    }
    if (
      !this.#authorityRollbackClaimed ||
      !this.#authorityRollback.owns(handle)
    ) {
      throw new Error(
        "Executor Authority cleanup handle does not belong to this role lifecycle",
      );
    }
    this.#entries.set(identity, { handle });
    this.#authorityAdopted = true;
    this.#authorityRollback.commit();
    return handle;
  }

  seal(): void {
    if (this.#closing) {
      throw new Error("Executor role lifecycle is already closing");
    }
    if (this.#sealed) {
      throw new Error("Executor role lifecycle is already sealed");
    }
    const missing = EXECUTOR_ROLE_LIFECYCLE_DESCRIPTORS
      .filter(({ id }) => !this.#entries.has(id))
      .map(({ id }) => id);
    if (missing.length > 0) {
      throw new Error(
        `Executor role lifecycle contributions are incomplete: ${missing.join(", ")}`,
      );
    }
    this.#sealed = true;
  }

  close(): Promise<void> {
    this.#closing ??= this.#closeOnce();
    return this.#closing;
  }

  async #closeOnce(): Promise<void> {
    const failures: unknown[] = [];
    for (const { id } of EXECUTOR_ROLE_LIFECYCLE_DESCRIPTORS) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      try {
        await entry.handle.run();
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.#authorityRollbackClaimed && !this.#authorityAdopted) {
      try {
        await this.#authorityRollback.rollback();
      } catch (error) {
        if (error instanceof AggregateError) failures.push(...error.errors);
        else failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Executor role lifecycle cleanup failed",
      );
    }
  }

  #assertCanContribute(identity: ExecutorRoleLifecycleIdentity): void {
    if (this.#closing) {
      throw new Error("Executor role lifecycle is already closing");
    }
    if (this.#sealed) {
      throw new Error("Executor role lifecycle is already sealed");
    }
    if (this.#entries.has(identity)) {
      throw new Error(`Executor role lifecycle contribution already exists: ${identity}`);
    }
  }
}

export function throwExecutorRoleFailures(
  roleFailure: unknown,
  cleanupFailures: readonly unknown[],
): void {
  if (roleFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [roleFailure, ...cleanupFailures],
        "Executor role and cleanup both failed",
      );
    }
    throw roleFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Executor role cleanup failed",
    );
  }
}

function createIdempotentCleanupHandle(
  name: ExecutorRoleLifecycleIdentity,
  cleanup: () => void | Promise<void>,
): StartupCleanupHandle {
  let result: Promise<void> | undefined;
  return Object.freeze({
    name,
    run() {
      result ??= Promise.resolve().then(cleanup);
      return result;
    },
  });
}
