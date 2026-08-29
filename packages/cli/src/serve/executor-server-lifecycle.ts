import type {
  BoundZhixingServer,
  RunningServer,
  ServerStateFile,
  ServerStateSnapshot,
} from "@zhixing/server";

export const EXECUTOR_SERVER_LIFECYCLE_DESCRIPTORS = [
  { owner: "executor-server", id: "inactiveBinding.close" },
  { owner: "executor-server", id: "runningServer.shutdown" },
  { owner: "executor-server", id: "serverState.lifecycle" },
  { owner: "executor-server", id: "heartbeatTimer.clear" },
  { owner: "executor-server", id: "idleTimer.clearAndSettle" },
] as const;

type BoundEndpoint = Pick<BoundZhixingServer, "close" | "host" | "httpServer" | "port">;
type ServerStateLifecycle = Pick<
  ServerStateFile,
  "cleanup" | "heartbeat" | "markReady" | "markRunning" | "markStopped" | "markStopping"
>;

type EndpointOwnership =
  | { readonly kind: "none" }
  | { readonly kind: "binding"; readonly binding: BoundEndpoint }
  | { readonly kind: "server"; readonly server: RunningServer }
  | { readonly kind: "terminal" };

/**
 * Owns the finite Executor-only Server/state/timer boundary without copying
 * the Server package's CleanupRegistry. The inactive binding stays here until
 * runServer's activation gate proves that the same endpoint has acquired its
 * internal Server owner; afterwards this owner only drives that RunningServer.
 */
export class ExecutorServerLifecycle {
  #endpoint: EndpointOwnership = { kind: "none" };
  #stateFile: ServerStateLifecycle | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #idleCheck: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stateCleanupPromise: Promise<void> | undefined;

  acquireBinding(binding: BoundEndpoint): void {
    if (this.#endpoint.kind !== "none") {
      throw new Error("Executor Server endpoint already has a lifecycle owner");
    }
    this.#endpoint = { kind: "binding", binding };
  }

  acquireStateFile(stateFile: ServerStateLifecycle): void {
    if (this.#stateFile) {
      throw new Error("Executor Server state already has a lifecycle owner");
    }
    if (this.#stopPromise) {
      throw new Error("Executor Server lifecycle is already stopping");
    }
    this.#stateFile = stateFile;
  }

  /** Called only from runServer.beforeActivate after its registry owns server.close. */
  transferToRunningServer(server: RunningServer): void {
    const current = this.#endpoint;
    if (current.kind !== "binding") {
      throw new Error("Executor Server binding is not available for transfer");
    }
    if (
      server.server.httpServer !== current.binding.httpServer ||
      server.server.port !== current.binding.port ||
      server.server.host !== current.binding.host
    ) {
      throw new Error("Executor RunningServer does not own the acquired endpoint");
    }
    this.#endpoint = { kind: "server", server };
  }

  assertRunningServer(server: RunningServer): void {
    if (this.#endpoint.kind !== "server" || this.#endpoint.server !== server) {
      throw new Error("Executor runServer returned outside its lifecycle transfer");
    }
  }

  markReady(base: Omit<ServerStateSnapshot, "phase" | "lastHeartbeat">): Promise<void> {
    return this.#requireStateFile().markReady(base);
  }

  markRunning(): Promise<void> {
    return this.#requireStateFile().markRunning();
  }

  startHeartbeat(intervalMs = 60_000): void {
    this.#assertRuntimeTimerAvailable("heartbeat");
    if (this.#heartbeatTimer) {
      throw new Error("Executor Server heartbeat timer is already active");
    }
    const stateFile = this.#requireStateFile();
    this.#heartbeatTimer = setInterval(() => {
      void stateFile.heartbeat();
    }, intervalMs);
    this.#heartbeatTimer.unref();
  }

  startIdleTimer(
    checkIdle: () => Promise<void>,
    onError: (error: unknown) => void,
    intervalMs = 60_000,
  ): void {
    this.#assertRuntimeTimerAvailable("idle");
    if (this.#idleTimer) {
      throw new Error("Executor Server idle timer is already active");
    }
    this.#idleTimer = setInterval(() => {
      if (this.#idleCheck) return;
      const check = checkIdle();
      this.#idleCheck = check;
      void check.catch(onError).finally(() => {
        if (this.#idleCheck === check) this.#idleCheck = undefined;
      });
    }, intervalMs);
    this.#idleTimer.unref();
  }

  stop(reason = "executor-role-stop"): Promise<void> {
    this.#stopPromise ??= this.#stopOnce(reason);
    return this.#stopPromise;
  }

  cleanupState(): Promise<void> {
    if (!this.#stopPromise) {
      return Promise.reject(new Error("Executor Server state cleanup requires a stop attempt"));
    }
    this.#stateCleanupPromise ??= (async () => {
      await this.#stopPromise!.catch(() => undefined);
      await this.#stateFile?.cleanup();
    })();
    return this.#stateCleanupPromise;
  }

  async #stopOnce(reason: string): Promise<void> {
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

    await attempt(() => this.#stateFile?.markStopping("graceful"), failures);
    const endpoint = this.#endpoint;
    this.#endpoint = { kind: "terminal" };
    let endpointTerminal = endpoint.kind === "none" || endpoint.kind === "terminal";
    if (endpoint.kind === "binding") {
      endpointTerminal = await attempt(() => endpoint.binding.close(), failures);
    } else if (endpoint.kind === "server") {
      endpointTerminal = await attempt(() => endpoint.server.shutdown(reason), failures);
    }
    if (endpointTerminal) {
      await attempt(() => this.#stateFile?.markStopped(), failures);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "Executor Server lifecycle cleanup failed");
    }
  }

  #requireStateFile(): ServerStateLifecycle {
    if (!this.#stateFile) throw new Error("Executor Server state has no lifecycle owner");
    return this.#stateFile;
  }

  #assertRuntimeTimerAvailable(kind: string): void {
    if (this.#stopPromise) {
      throw new Error(`Executor Server ${kind} timer cannot start during shutdown`);
    }
    if (this.#endpoint.kind !== "server") {
      throw new Error(`Executor Server ${kind} timer requires a running endpoint`);
    }
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
