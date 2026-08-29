import {
  acquireLock,
  bindServer,
  buildBuiltinRegistry,
  CleanupRegistry,
  createServerContext,
  DEFAULT_SERVER_CONFIG,
  readLock,
  releaseLock,
  runServer,
  ServerStateFile,
  type BoundZhixingServer,
  type PidFileContents,
  type ServerStateFile as ServerStateFileType,
  type ZhixingServerInstance,
} from "@zhixing/server";
import { createTempDir } from "@zhixing/test-utils";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANCHOR_HOST_SHELL_RESOURCE_DESCRIPTORS,
  AnchorHostShellLifecycle,
  mapAnchorHostStopReason,
} from "../anchor-host-shell-lifecycle.js";
import { StartupRollback } from "../startup-rollback.js";

describe("AnchorHostShellLifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("freezes the seven Host shell resource identities", () => {
    expect(ANCHOR_HOST_SHELL_RESOURCE_DESCRIPTORS).toEqual([
      { owner: "anchor-host", id: "serverLogLifecycle.stop" },
      { owner: "anchor-host", id: "endpoint.close" },
      { owner: "anchor-host", id: "authorityCheckpointOwner.stop" },
      { owner: "anchor-host", id: "serverState.lifecycle" },
      { owner: "anchor-host", id: "heartbeatTimer.clear" },
      { owner: "anchor-host", id: "idleTimer.clearAndSettle" },
      { owner: "anchor-host", id: "processDiscovery.release" },
    ]);
  });

  it("rejects duplicate, foreign, missing and late ownership", () => {
    const { lifecycle, binding: acquiredBinding, registry } = fixture();
    lifecycle.acquireBinding(acquiredBinding);
    expect(() => lifecycle.acquireBinding(acquiredBinding)).toThrow("already has an owner");
    lifecycle.acquireStateFile(stateFile([]));
    expect(() => lifecycle.acquireStateFile(stateFile([]))).toThrow("already owns Server state");
    const foreignBinding = binding([]);
    expect(() => lifecycle.transferPreparedServer(serverFor(foreignBinding, []), registry))
      .toThrow("does not own the acquired endpoint");

    const server = serverFor(acquiredBinding, []);
    lifecycle.transferPreparedServer(server, registry);
    expect(() => lifecycle.acquireServerLog({ stop() {} })).toThrow("after Host shell transfer");
    expect(() => lifecycle.assertActivationOwnership({
      serverLog: false,
      checkpointOwner: true,
    })).toThrow("checkpoint exact-set mismatch");
    expect(() => lifecycle.transferPreparedServer(server, registry))
      .toThrow("unavailable for transfer");
  });

  it("uses one idempotent handle for startup rollback and normal close", async () => {
    const order: string[] = [];
    const rollback = new StartupRollback();
    const { lifecycle, binding, registry } = fixture({ rollback, order });
    lifecycle.acquireServerLog({ stop: () => order.push("log.stop") });
    lifecycle.acquireBinding(binding);
    lifecycle.acquireStateFile(stateFile(order));
    lifecycle.acquireCheckpointOwner({
      stop: async () => {
        order.push("checkpoint.stop");
      },
    });
    lifecycle.transferPreparedServer(serverFor(binding, order), registry);
    lifecycle.assertActivationOwnership({ serverLog: true, checkpointOwner: true });

    await registry.runAll("SIGTERM");
    await rollback.rollback();
    await lifecycle.stop();

    expect(order).toEqual([
      "state.markStopping:signal",
      "server.close",
      "state.markStopped",
      "state.cleanup",
      "checkpoint.stop",
      "log.stop",
    ]);
  });

  it("settles an in-flight idle check before state and endpoint termination", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const { lifecycle, binding, registry } = fixture({ order });
    lifecycle.acquireBinding(binding);
    lifecycle.acquireStateFile(stateFile(order));
    const server = serverFor(binding, order);
    lifecycle.transferPreparedServer(server, registry);
    await lifecycle.publishDiscovery(server);
    await lifecycle.markReady({ pid: 1, startedAt: "t", host: binding.host, port: binding.port });
    await lifecycle.markRunning();
    lifecycle.startHeartbeat(10);
    const idle = deferred();
    lifecycle.startIdleReaper(async () => {
      order.push("idle.check");
      await idle.promise;
      order.push("idle.settled");
    }, vi.fn(), 10);

    await vi.advanceTimersByTimeAsync(10);
    const stopping = lifecycle.stop();
    await Promise.resolve();
    expect(order).not.toContain("state.markStopping:graceful");
    idle.resolve();
    await stopping;

    expect(order).toEqual([
      "state.markReady",
      "state.markRunning",
      "state.heartbeat",
      "idle.check",
      "idle.settled",
      "state.markStopping:error",
      "server.close",
      "state.markStopped",
      "state.cleanup",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores owned discovery without externalizing stopped after endpoint failure", async () => {
    const order: string[] = [];
    const read = vi.fn(async () => ownLock());
    const release = vi.fn(async () => {
      order.push("discovery.release");
    });
    const { lifecycle, binding, registry, acquireLock: acquire } = fixture({
      order,
      endpointFailure: new Error("endpoint failed"),
      readLock: read,
      releaseLock: release,
    });
    lifecycle.acquireServerLog({ stop: () => order.push("log.stop") });
    lifecycle.acquireBinding(binding);
    lifecycle.acquireStateFile(stateFile(order));
    lifecycle.acquireCheckpointOwner({
      stop: async () => {
        order.push("checkpoint.stop");
      },
    });
    const server = serverFor(binding, order, new Error("endpoint failed"));
    lifecycle.transferPreparedServer(server, registry);
    await lifecycle.publishDiscovery(server);

    const error = await lifecycle.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "endpoint failed" }),
    ]);
    expect(order).toEqual([
      "state.markStopping:error",
      "discovery.release",
      "server.close",
      "checkpoint.stop",
      "log.stop",
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("continues safe terminal cleanup and preserves every failure", async () => {
    const order: string[] = [];
    const release = vi.fn(async () => {
      order.push("discovery.release");
      throw new Error("release failed");
    });
    const { lifecycle, binding, registry } = fixture({
      order,
      readLock: vi.fn(async () => ownLock()),
      releaseLock: release,
    });
    lifecycle.acquireServerLog({
      stop: () => {
        order.push("log.stop");
        throw new Error("log failed");
      },
    });
    lifecycle.acquireBinding(binding);
    lifecycle.acquireStateFile(stateFile(order, { markStopping: new Error("stopping failed") }));
    lifecycle.acquireCheckpointOwner({
      stop: async () => {
        order.push("checkpoint.stop");
        throw new Error("checkpoint failed");
      },
    });
    const server = serverFor(binding, order);
    lifecycle.transferPreparedServer(server, registry);
    await lifecycle.publishDiscovery(server);

    const error = await lifecycle.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "stopping failed" }),
      expect.objectContaining({ message: "release failed" }),
      expect.objectContaining({ message: "checkpoint failed" }),
      expect.objectContaining({ message: "log failed" }),
    ]);
    expect(order).toEqual([
      "state.markStopping:error",
      "discovery.release",
      "server.close",
      "state.markStopped",
      "state.cleanup",
      "checkpoint.stop",
      "log.stop",
    ]);
  });

  it("does not delete a foreign generation when discovery publication fails partially", async () => {
    const release = vi.fn(async () => undefined);
    const { lifecycle, binding, registry, acquireLock: acquire } = fixture({
      acquireLock: async () => {
        throw new Error("port publication failed");
      },
      readLock: async () => ({ ...ownLock(), startedAt: "foreign-generation" }),
      releaseLock: release,
    });
    lifecycle.acquireBinding(binding);
    lifecycle.acquireStateFile(stateFile([]));
    const server = serverFor(binding, []);
    lifecycle.transferPreparedServer(server, registry);

    await expect(lifecycle.publishDiscovery(server)).rejects.toThrow("port publication failed");
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    await lifecycle.stop();
    expect(release).not.toHaveBeenCalled();
  });

  it("publishes and releases only the same process discovery generation", async () => {
    const order: string[] = [];
    const read = vi.fn(async () => ownLock());
    const release = vi.fn(async () => {
      order.push("discovery.release");
    });
    const { lifecycle, binding, registry } = fixture({
      order,
      readLock: read,
      releaseLock: release,
    });
    lifecycle.acquireBinding(binding);
    lifecycle.acquireStateFile(stateFile(order));
    const server = serverFor(binding, order);
    lifecycle.transferPreparedServer(server, registry);
    await expect(lifecycle.markReady({ pid: 1, startedAt: "t" }))
      .rejects.toThrow("before discovery");
    await lifecycle.publishDiscovery(server);
    await lifecycle.markReady({ pid: 1, startedAt: "t" });
    await lifecycle.markRunning();
    await lifecycle.stop();
    expect(release).toHaveBeenCalledTimes(1);

    const successor = fixture({
      order: [],
      readLock: vi.fn(async () => ({ ...ownLock(), startedAt: "successor" })),
      releaseLock: vi.fn(async () => undefined),
    });
    successor.lifecycle.acquireBinding(successor.binding);
    successor.lifecycle.acquireStateFile(stateFile([]));
    const successorServer = serverFor(successor.binding, []);
    successor.lifecycle.transferPreparedServer(successorServer, successor.registry);
    await successor.lifecycle.publishDiscovery(successorServer);
    await successor.lifecycle.stop();
    expect(successor.releaseLock).not.toHaveBeenCalled();
  });

  it("keeps the old endpoint bound across generation check and discovery deletion", async () => {
    const root = await createTempDir("anchor-discovery-successor-race");
    const lockPaths = {
      pidPath: join(root, "server.pid"),
      portPath: join(root, "server.port"),
    };
    const releaseWindow = deferred();
    const checkedGeneration = deferred();
    const startedAt = "old-generation";
    const bound = await bindServer({ config: { host: "127.0.0.1", port: 0 } });
    const lifecycle = new AnchorHostShellLifecycle({
      startupRollback: new StartupRollback(),
      lockPaths,
      processInfo: { startTime: null, startedAt },
      dependencies: {
        acquireLock,
        readLock: async (paths) => {
          const current = await readLock(paths);
          checkedGeneration.resolve();
          return current;
        },
        releaseLock: async (paths) => {
          await releaseWindow.promise;
          await releaseLock(paths);
        },
      },
    });
    const registry = new CleanupRegistry({
      activeOwners: ["anchor-host"],
      logger: { error() {} },
    });
    lifecycle.acquireBinding(bound);
    lifecycle.acquireStateFile(stateFile([]));
    const server = {
      ...serverFor(bound, []),
      close: () => bound.close(),
    };
    lifecycle.transferPreparedServer(server, registry);
    await lifecycle.publishDiscovery(server);

    const stopping = lifecycle.stop();
    await checkedGeneration.promise;
    let contender: BoundZhixingServer | undefined;
    let contenderError: unknown;
    try {
      contender = await bindServer({ config: { host: bound.host, port: bound.port } });
      await acquireLock(contender.port, {
        ...lockPaths,
        host: contender.host,
        startTime: null,
        startedAt: "successor-in-window",
      });
    } catch (error) {
      contenderError = error;
    } finally {
      releaseWindow.resolve();
    }
    await stopping;
    await contender?.close();
    expect(contenderError).toMatchObject({ code: "EADDRINUSE" });

    const successor = await bindServer({ config: { host: bound.host, port: bound.port } });
    try {
      await acquireLock(successor.port, {
        ...lockPaths,
        host: successor.host,
        startTime: null,
        startedAt: "successor-after-terminal",
      });
      expect(await readLock(lockPaths)).toMatchObject({
        port: successor.port,
        startedAt: "successor-after-terminal",
      });
    } finally {
      await successor.close();
      await releaseLock(lockPaths);
    }
  });

  it("keeps one real endpoint inactive, publishes after discovery and leaves zero shell residue", async () => {
    const root = await createTempDir("anchor-host-shell");
    const pidPath = join(root, "server.pid");
    const portPath = join(root, "server.port");
    const statePath = join(root, "server.state");
    const readyMarkerPath = join(root, "server.ready");
    const rollback = new StartupRollback();
    const lifecycle = new AnchorHostShellLifecycle({
      startupRollback: rollback,
      lockPaths: { pidPath, portPath },
      processInfo: { startTime: null, startedAt: "2026-08-29T00:00:00.000Z" },
    });
    const context = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, host: "127.0.0.1", port: 0 },
      version: "test",
      token: "test-token",
    });
    const binding = await bindServer({ config: context.config });
    lifecycle.acquireBinding(binding);
    lifecycle.acquireStateFile(new ServerStateFile({
      statePath,
      readyMarkerPath,
      publishReadyMarker: true,
    }));
    const registry = new CleanupRegistry({
      activeOwners: ["anchor-host"],
      logger: { error() {} },
    });
    let runner: Awaited<ReturnType<typeof runServer>> | undefined;
    try {
      expect((await fetch(`http://${binding.host}:${binding.port}/api/health`)).status).toBe(503);
      runner = await runServer({
        context,
        boundServer: binding,
        registry: buildBuiltinRegistry(),
        cleanupRegistry: registry,
        lifecycleOwner: lifecycle,
        skipSignalHandlers: true,
        logger: { info() {}, warn() {}, error() {} },
        beforeActivate: async () => {
          lifecycle.assertActivationOwnership({ serverLog: false, checkpointOwner: false });
          rollback.commit();
        },
        beforePublish: async (server) => {
          lifecycle.assertActiveEndpoint(server);
          expect((await fetch(`http://${server.host}:${server.port}/api/health`)).status).toBe(200);
          expect(await readLock({ pidPath, portPath })).toBeNull();
        },
        publishReady: async (openingRunner) => {
          expect((await readLock({ pidPath, portPath }))?.port).toBe(binding.port);
          await lifecycle.markReady({
            pid: process.pid,
            startedAt: "2026-08-29T00:00:00.000Z",
            host: openingRunner.server.host,
            port: openingRunner.server.port,
          });
          await lifecycle.markRunning();
          lifecycle.startHeartbeat(60_000);
        },
      });
      expect(runner.server.httpServer).toBe(binding.httpServer);
      expect((await fetch(`http://${binding.host}:${binding.port}/api/health`)).status).toBe(200);
      await runner.shutdown("test");
      await expect(fetch(`http://${binding.host}:${binding.port}/api/health`)).rejects.toThrow();
      for (const path of [pidPath, portPath, statePath, readyMarkerPath]) {
        await expect(stat(path)).rejects.toHaveProperty("code", "ENOENT");
      }
    } finally {
      await runner?.shutdown("test-finally").catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  });

  it("uses the same shell handle when the activation gate fails", async () => {
    const rollback = new StartupRollback();
    const lifecycle = new AnchorHostShellLifecycle({
      startupRollback: rollback,
      processInfo: { startTime: null, startedAt: "activation-failure" },
    });
    const activationCleanup = vi.spyOn(lifecycle, "cleanupActivationFailure");
    const bound = await bindServer({ config: { port: 0, host: "127.0.0.1" } });
    const port = bound.port;
    const order: string[] = [];
    lifecycle.acquireBinding(bound);
    lifecycle.acquireStateFile(stateFile(order));
    const registry = new CleanupRegistry({
      activeOwners: ["anchor-host"],
      logger: { error() {} },
    });
    const context = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port, host: bound.host },
      version: "test",
      token: "test-token",
    });

    await expect(runServer({
      context,
      boundServer: bound,
      config: { port, host: bound.host },
      registry: buildBuiltinRegistry(),
      cleanupRegistry: registry,
      lifecycleOwner: lifecycle,
      skipSignalHandlers: true,
      logger: { info() {}, warn() {}, error() {} },
      beforeActivate: async () => {
        throw new Error("gate failed");
      },
    })).rejects.toThrow("gate failed");

    expect(bound.httpServer.listening).toBe(false);
    await expect(fetch(`http://${bound.host}:${port}/api/health`)).rejects.toThrow();
    expect(order).toEqual([
      "state.markStopping:error",
      "state.markStopped",
      "state.cleanup",
    ]);
    expect(activationCleanup).toHaveBeenCalledTimes(1);
    await rollback.rollback();
    expect(order).toHaveLength(3);
  });

  it("maps shutdown reasons without changing ServerStateFile semantics", () => {
    expect(mapAnchorHostStopReason("SIGTERM")).toBe("signal");
    expect(mapAnchorHostStopReason("uncaughtException")).toBe("crash");
    expect(mapAnchorHostStopReason("startup-error")).toBe("error");
    expect(mapAnchorHostStopReason("rpc.server.shutdown")).toBe("graceful");
  });
});

function fixture(options: {
  readonly rollback?: StartupRollback;
  readonly order?: string[];
  readonly endpointFailure?: Error;
  readonly acquireLock?: () => Promise<void>;
  readonly readLock?: () => Promise<PidFileContents | null>;
  readonly releaseLock?: () => Promise<void>;
} = {}) {
  const order = options.order ?? [];
  const close = vi.fn(async () => {
    order.push("binding.close");
    if (options.endpointFailure) throw options.endpointFailure;
  });
  const bound = binding(order, close);
  const acquire = vi.fn(options.acquireLock ?? (async () => undefined));
  const read = vi.fn(options.readLock ?? (async () => null));
  const release = vi.fn(options.releaseLock ?? (async () => undefined));
  const lifecycle = new AnchorHostShellLifecycle({
    startupRollback: options.rollback ?? new StartupRollback(),
    processInfo: { startTime: null, startedAt: "t" },
    dependencies: { acquireLock: acquire, readLock: read, releaseLock: release },
  });
  const registry = new CleanupRegistry({
    activeOwners: ["anchor-host"],
    logger: { error() {} },
  });
  return { lifecycle, binding: bound, registry, acquireLock: acquire, readLock: read, releaseLock: release };
}

function binding(
  _order: string[],
  close = vi.fn(async () => undefined),
): Pick<BoundZhixingServer, "close" | "host" | "httpServer" | "port"> {
  return {
    close,
    host: "127.0.0.1",
    port: 3210,
    httpServer: { listening: true } as BoundZhixingServer["httpServer"],
  };
}

function serverFor(
  bound: Pick<BoundZhixingServer, "host" | "httpServer" | "port">,
  order: string[],
  failure?: Error,
): ZhixingServerInstance {
  return {
    host: bound.host,
    port: bound.port,
    httpServer: bound.httpServer,
    context: {} as ZhixingServerInstance["context"],
    registry: buildBuiltinRegistry(),
    connections: new Set(),
    close: vi.fn(async () => {
      order.push("server.close");
      if (failure) throw failure;
    }),
  };
}

function stateFile(
  order: string[],
  failures: { readonly markStopping?: Error } = {},
): Pick<
  ServerStateFileType,
  "cleanup" | "heartbeat" | "markReady" | "markRunning" | "markStopped" | "markStopping"
> {
  return {
    cleanup: vi.fn(async () => {
      order.push("state.cleanup");
    }),
    heartbeat: vi.fn(async () => {
      order.push("state.heartbeat");
    }),
    markReady: vi.fn(async () => {
      order.push("state.markReady");
    }),
    markRunning: vi.fn(async () => {
      order.push("state.markRunning");
    }),
    markStopped: vi.fn(async () => {
      order.push("state.markStopped");
    }),
    markStopping: vi.fn(async (reason) => {
      order.push(`state.markStopping:${reason}`);
      if (failures.markStopping) throw failures.markStopping;
    }),
  };
}

function ownLock(): PidFileContents {
  return {
    pidFileVersion: 2,
    pid: process.pid,
    port: 3210,
    startTime: null,
    startedAt: "t",
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
