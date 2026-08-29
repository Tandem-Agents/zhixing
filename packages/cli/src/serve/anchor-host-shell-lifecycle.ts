import {
  acquireLock,
  readLock,
  registerCleanup,
  releaseLock,
  type AcquireLockOptions,
  type BoundZhixingServer,
  type CleanupRegistry,
  type ExitReason,
  type ProcessLockPaths,
  type ServerLifecycleOwner,
  type ServerStateFile,
  type ServerStateSnapshot,
  type ZhixingServerInstance,
} from "@zhixing/server";
import type { AuthorityCheckpointOwnerPort } from "@zhixing/mesh/checkpoint-owner";
import type { StartupCleanupHandle, StartupRollback } from "./startup-rollback.js";

export const ANCHOR_HOST_SHELL_RESOURCE_DESCRIPTORS = [
  { owner: "anchor-host", id: "serverLogLifecycle.stop" },
  { owner: "anchor-host", id: "endpoint.close" },
  { owner: "anchor-host", id: "authorityCheckpointOwner.stop" },
  { owner: "anchor-host", id: "serverState.lifecycle" },
  { owner: "anchor-host", id: "heartbeatTimer.clear" },
  { owner: "anchor-host", id: "idleTimer.clearAndSettle" },
  { owner: "anchor-host", id: "processDiscovery.release" },
] as const;

const ANCHOR_HOST_SHELL_CLEANUP_DESCRIPTOR = {
  owner: "anchor-host",
  role: "server",
  id: "hostShell.stop",
} as const;

type BoundEndpoint = Pick<
  BoundZhixingServer,
  "close" | "host" | "httpServer" | "port"
>;
type OwnedEndpoint = BoundEndpoint | ZhixingServerInstance;
type StateLifecycle = Pick<
  ServerStateFile,
  "cleanup" | "heartbeat" | "markReady" | "markRunning" | "markStopped" | "markStopping"
>;
type ServerLogLifecycle = Readonly<{ stop(): void }>;
type CheckpointLifecycle = Pick<AuthorityCheckpointOwnerPort, "stop">;

type EndpointOwnership =
  | { readonly kind: "none" }
  | { readonly kind: "binding"; readonly binding: BoundEndpoint }
  | { readonly kind: "server"; readonly server: ZhixingServerInstance }
  | { readonly kind: "terminal" };

interface AnchorHostShellDependencies {
  readonly acquireLock: typeof acquireLock;
  readonly readLock: typeof readLock;
  readonly releaseLock: typeof releaseLock;
}

export interface AnchorHostShellLifecycleOptions {
  readonly startupRollback: StartupRollback;
  readonly lockPaths?: ProcessLockPaths;
  readonly processInfo: Pick<
    AcquireLockOptions,
    "argv" | "kind" | "logPath" | "startTime" | "startedAt" | "version"
  >;
  readonly dependencies?: Partial<AnchorHostShellDependencies>;
}

/**
 * Finite outer owner for the Anchor endpoint, state/discovery projections,
 * runtime timers and remaining non-business infrastructure. One StartupRollback
 * handle is transferred into the Server CleanupRegistry; both paths therefore
 * execute the same idempotent terminal operation rather than parallel fallbacks.
 */
export class AnchorHostShellLifecycle implements ServerLifecycleOwner {
  readonly #handle: StartupCleanupHandle;
  readonly #lockPaths: ProcessLockPaths | undefined;
  readonly #processInfo: AnchorHostShellLifecycleOptions["processInfo"];
  readonly #dependencies: AnchorHostShellDependencies;
  #endpoint: EndpointOwnership = { kind: "none" };
  #stateFile: StateLifecycle | undefined;
  #serverLog: ServerLogLifecycle | undefined;
  #checkpointOwner: CheckpointLifecycle | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #idleCheck: Promise<void> | undefined;
  #normalOwnerTransferred = false;
  #discoveryAttempted = false;
  #discoveryPublished = false;
  #discoveryPort: number | undefined;
  #stopReason = "startup-error";

  constructor(options: AnchorHostShellLifecycleOptions) {
    this.#lockPaths = options.lockPaths;
    this.#processInfo = Object.freeze({ ...options.processInfo });
    this.#dependencies = {
      acquireLock,
      readLock,
      releaseLock,
      ...options.dependencies,
    };
    this.#handle = options.startupRollback.register(
      ANCHOR_HOST_SHELL_CLEANUP_DESCRIPTOR.id,
      () => this.#stopOnce(),
    );
  }

  acquireServerLog(serverLog: ServerLogLifecycle): void {
    this.#assertCanAcquire("Server log");
    if (this.#serverLog) throw new Error("Anchor Host shell already owns the Server log");
    this.#serverLog = serverLog;
  }

  acquireBinding(binding: BoundEndpoint): void {
    this.#assertCanAcquire("Server binding");
    if (this.#endpoint.kind !== "none") {
      throw new Error("Anchor Host shell endpoint already has an owner");
    }
    this.#endpoint = { kind: "binding", binding };
  }

  acquireStateFile(stateFile: StateLifecycle): void {
    this.#assertCanAcquire("Server state");
    if (this.#stateFile) throw new Error("Anchor Host shell already owns Server state");
    this.#stateFile = stateFile;
  }

  acquireCheckpointOwner(checkpointOwner: CheckpointLifecycle): void {
    this.#assertCanAcquire("Checkpoint owner");
    if (this.#checkpointOwner) {
      throw new Error("Anchor Host shell already owns the checkpoint owner");
    }
    this.#checkpointOwner = checkpointOwner;
  }

  transferPreparedServer(
    server: ZhixingServerInstance,
    registry: CleanupRegistry,
  ): void {
    const current = this.#endpoint;
    if (current.kind !== "binding") {
      throw new Error("Anchor Host shell binding is unavailable for transfer");
    }
    this.#assertSameEndpoint(server, current.binding);
    if (this.#normalOwnerTransferred) {
      throw new Error("Anchor Host shell normal owner is already transferred");
    }
    this.#endpoint = { kind: "server", server };
    registerCleanup(registry, ANCHOR_HOST_SHELL_CLEANUP_DESCRIPTOR, (reason) => {
      this.#stopReason = reason;
      return this.#handle.run();
    });
    this.#normalOwnerTransferred = true;
  }

  assertActiveEndpoint(server: ZhixingServerInstance): void {
    if (
      this.#endpoint.kind !== "server" ||
      this.#endpoint.server !== server ||
      !server.httpServer.listening
    ) {
      throw new Error("Anchor Host shell does not own the active endpoint");
    }
  }

  async publishDiscovery(server: ZhixingServerInstance): Promise<void> {
    this.assertActiveEndpoint(server);
    if (this.#discoveryAttempted) {
      throw new Error("Anchor Host shell discovery publication was already attempted");
    }
    this.#discoveryAttempted = true;
    this.#discoveryPort = server.port;
    try {
      await this.#dependencies.acquireLock(server.port, {
        ...this.#lockPaths,
        ...this.#processInfo,
        host: server.host,
      });
      this.#discoveryPublished = true;
    } catch (error) {
      // acquireLock writes PID and port separately. Compensate only an exact
      // partial publication from this generation; a pre-existing/foreign
      // discovery record is not ours to delete.
      try {
        await this.#releaseOwnedDiscovery();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Anchor discovery publication and partial cleanup failed",
        );
      }
      throw error;
    }
  }

  markReady(base: Omit<ServerStateSnapshot, "phase" | "lastHeartbeat">): Promise<void> {
    this.#assertNormalOwner();
    if (!this.#discoveryPublished) {
      return Promise.reject(new Error("Anchor Host shell cannot publish ready before discovery"));
    }
    return this.#requireStateFile().markReady(base);
  }

  markRunning(): Promise<void> {
    this.#assertNormalOwner();
    return this.#requireStateFile().markRunning();
  }

  startHeartbeat(intervalMs = 60_000): void {
    this.#assertTimerAvailable();
    if (this.#heartbeatTimer) {
      throw new Error("Anchor Host shell heartbeat timer is already active");
    }
    const stateFile = this.#requireStateFile();
    this.#heartbeatTimer = setInterval(() => {
      void stateFile.heartbeat();
    }, intervalMs);
    this.#heartbeatTimer.unref();
  }

  startIdleReaper(
    checkIdle: () => Promise<void>,
    onError: (error: unknown) => void,
    intervalMs = 60_000,
  ): void {
    this.#assertTimerAvailable();
    if (this.#idleTimer) {
      throw new Error("Anchor Host shell idle timer is already active");
    }
    this.#idleTimer = setInterval(() => {
      if (this.#idleCheck) return;
      const check = Promise.resolve().then(checkIdle);
      this.#idleCheck = check;
      void check.catch(onError).finally(() => {
        if (this.#idleCheck === check) this.#idleCheck = undefined;
      });
    }, intervalMs);
    this.#idleTimer.unref();
  }

  assertActivationOwnership(input: {
    readonly serverLog: boolean;
    readonly checkpointOwner: boolean;
  }): void {
    this.#assertNormalOwner();
    if (!this.#stateFile) throw new Error("Anchor Host shell state owner is missing");
    if (!!this.#serverLog !== input.serverLog) {
      throw new Error("Anchor Host shell Server log exact-set mismatch");
    }
    if (!!this.#checkpointOwner !== input.checkpointOwner) {
      throw new Error("Anchor Host shell checkpoint exact-set mismatch");
    }
  }

  stop(): Promise<void> {
    return this.#handle.run();
  }

  cleanupActivationFailure(): Promise<void> {
    return this.#handle.run();
  }

  async #stopOnce(): Promise<void> {
    const failures: unknown[] = [];
    if (this.#idleTimer) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    await this.#idleCheck?.catch(() => undefined);
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }

    await attempt(
      () => this.#stateFile?.markStopping(mapAnchorHostStopReason(this.#stopReason)),
      failures,
    );
    const endpoint = this.#endpoint;
    this.#endpoint = { kind: "terminal" };
    const discoveryWasPublished = this.#discoveryPublished;
    // Validate and remove this generation while its endpoint still owns the
    // OS port. A legal successor therefore cannot publish between the
    // generation check and deletion.
    await attempt(() => this.#releaseOwnedDiscovery(), failures);
    let endpointTerminal = endpoint.kind === "none" || endpoint.kind === "terminal";
    if (endpoint.kind === "binding") {
      endpointTerminal = await attempt(() => endpoint.binding.close(), failures);
    } else if (endpoint.kind === "server") {
      endpointTerminal = await attempt(() => endpoint.server.close(), failures);
    }

    if (endpointTerminal) {
      await attempt(() => this.#stateFile?.markStopped(), failures);
      await attempt(() => this.#stateFile?.cleanup(), failures);
    } else if (discoveryWasPublished && endpoint.kind !== "none" && endpoint.kind !== "terminal") {
      // The endpoint is still the OS-arbitrated owner. Restore its discovery
      // after a failed close so callers do not observe a false stopped owner.
      const ownedEndpoint = endpoint.kind === "binding" ? endpoint.binding : endpoint.server;
      await attempt(() => this.#restoreOwnedDiscovery(ownedEndpoint), failures);
    }
    await attempt(() => this.#checkpointOwner?.stop(), failures);
    await attempt(() => this.#serverLog?.stop(), failures);

    if (failures.length > 0) {
      throw new AggregateError(failures, "Anchor Host shell cleanup failed");
    }
  }

  async #releaseOwnedDiscovery(): Promise<void> {
    if (!this.#discoveryAttempted) return;
    const current = await this.#dependencies.readLock(this.#lockPaths);
    if (!current) return;
    if (
      current.pid !== process.pid ||
      current.startedAt !== this.#processInfo.startedAt ||
      current.startTime !== (this.#processInfo.startTime ?? null) ||
      current.port !== this.#discoveryPort
    ) {
      return;
    }
    await this.#dependencies.releaseLock(this.#lockPaths);
    this.#discoveryPublished = false;
  }

  async #restoreOwnedDiscovery(endpoint: OwnedEndpoint): Promise<void> {
    await this.#dependencies.acquireLock(endpoint.port, {
      ...this.#lockPaths,
      ...this.#processInfo,
      host: endpoint.host,
    });
    this.#discoveryPublished = true;
  }

  #assertSameEndpoint(server: ZhixingServerInstance, binding: BoundEndpoint): void {
    if (
      server.httpServer !== binding.httpServer ||
      server.port !== binding.port ||
      server.host !== binding.host
    ) {
      throw new Error("Anchor prepared Server does not own the acquired endpoint");
    }
  }

  #assertCanAcquire(label: string): void {
    if (this.#normalOwnerTransferred) {
      throw new Error(`${label} contribution arrived after Host shell transfer`);
    }
  }

  #assertNormalOwner(): void {
    if (!this.#normalOwnerTransferred || this.#endpoint.kind !== "server") {
      throw new Error("Anchor Host shell normal endpoint owner is not established");
    }
  }

  #assertTimerAvailable(): void {
    this.#assertNormalOwner();
  }

  #requireStateFile(): StateLifecycle {
    if (!this.#stateFile) throw new Error("Anchor Host shell has no Server state owner");
    return this.#stateFile;
  }
}

async function attempt(
  action: () => void | Promise<void> | undefined,
  failures: unknown[],
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    failures.push(error);
    return false;
  }
}

export function mapAnchorHostStopReason(reason: string): ExitReason {
  if (reason.startsWith("SIG")) return "signal";
  if (reason.toLowerCase().includes("uncaught")) return "crash";
  if (reason.toLowerCase().includes("error")) return "error";
  return "graceful";
}
