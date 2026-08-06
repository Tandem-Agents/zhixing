import { describe, expect, it, vi } from "vitest";
import {
  UnsupportedServeRoleConfigurationError,
  planServeTopology,
  runConfiguredServeTopology,
} from "../role-topology.js";

function createLoaders() {
  const run = vi.fn(async () => {});
  const anchorHost = vi.fn(async () => ({ run }));
  const executorHost = vi.fn(async () => ({ run }));
  const executorModule = {
    ConversationAssignmentLedger: vi.fn(),
    ExecutorResourceGovernor: vi.fn(),
    InProcessAssignmentSubmission: vi.fn(),
    createExecutorRole: vi.fn(),
    createInProcessRuntimeFactory: vi.fn(),
  } as never;
  const executor = vi.fn(async () => executorModule);
  return {
    loaders: { anchorHost, executorHost, executor },
    anchorHost,
    executorHost,
    executor,
    executorModule,
    run,
  };
}

describe("serve role topology", () => {
  const bootstrap = {} as never;
  it("loads the service host once for the local role topology", async () => {
    const harness = createLoaders();
    const options = { marker: "options" };

    await runConfiguredServeTopology(
      { roles: ["anchor", "executor"] },
      harness.loaders,
      options,
      bootstrap,
    );

    expect(harness.anchorHost).toHaveBeenCalledOnce();
    expect(harness.executorHost).not.toHaveBeenCalled();
    expect(harness.executor).toHaveBeenCalledOnce();
    expect(harness.run).toHaveBeenCalledWith(
      options,
      bootstrap,
      harness.executorModule,
      planServeTopology({ roles: ["anchor", "executor"] }),
    );
  });

  it.each([
    { roles: [] as const },
    { roles: ["surface"] as const },
  ])("loads no service role for $roles", async (configuration) => {
    const harness = createLoaders();

    await runConfiguredServeTopology(configuration, harness.loaders, {}, bootstrap);

    expect(harness.anchorHost).not.toHaveBeenCalled();
    expect(harness.executorHost).not.toHaveBeenCalled();
    expect(harness.executor).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });

  it.each([
    { roles: ["anchor", "anchor"] as const },
    { roles: ["unknown"] as never },
  ])("rejects unsupported $roles before loading any role", async (configuration) => {
    const harness = createLoaders();

    await expect(
      runConfiguredServeTopology(configuration, harness.loaders, {}, bootstrap),
    ).rejects.toBeInstanceOf(UnsupportedServeRoleConfigurationError);

    expect(harness.anchorHost).not.toHaveBeenCalled();
    expect(harness.executorHost).not.toHaveBeenCalled();
    expect(harness.executor).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });

  it("does not load the executor role for an anchor-only device", async () => {
    const harness = createLoaders();

    await runConfiguredServeTopology(
      { roles: ["anchor"] },
      harness.loaders,
      {},
      bootstrap,
    );

    expect(harness.anchorHost).toHaveBeenCalledOnce();
    expect(harness.executorHost).not.toHaveBeenCalled();
    expect(harness.executor).not.toHaveBeenCalled();
    expect(harness.run).toHaveBeenCalledWith(
      {},
      bootstrap,
      undefined,
      planServeTopology({ roles: ["anchor"] }),
    );
  });

  it("loads only the executor host for an executor-only device", async () => {
    const harness = createLoaders();

    await runConfiguredServeTopology(
      { roles: ["executor"] },
      harness.loaders,
      {},
      bootstrap,
    );

    expect(harness.anchorHost).not.toHaveBeenCalled();
    expect(harness.executorHost).toHaveBeenCalledOnce();
    expect(harness.executor).toHaveBeenCalledOnce();
    expect(harness.run).toHaveBeenCalledWith(
      {},
      bootstrap,
      harness.executorModule,
      planServeTopology({ roles: ["executor"] }),
    );
  });

  it("evaluates the anchor entry without evaluating the executor package", async () => {
    vi.doMock("@zhixing/executor", () => {
      throw new Error("executor package was evaluated");
    });

    await expect(import("../anchor-role.js")).resolves.toMatchObject({
      run: expect.any(Function),
    });
    vi.doUnmock("@zhixing/executor");
  });

  it("evaluates the executor entry without evaluating the owner runtime package", async () => {
    vi.doMock("@zhixing/owner-kernel", () => {
      throw new Error("owner runtime package was evaluated");
    });

    await expect(import("../executor-role.js")).resolves.toMatchObject({
      run: expect.any(Function),
    });
    vi.doUnmock("@zhixing/owner-kernel");
  });

  it("derives topology from the role set without a second mode flag", () => {
    expect(planServeTopology({ roles: [] })).toEqual({
      host: "disabled",
      loadExecutor: false,
      activeCleanupOwners: [],
    });
    expect(planServeTopology({ roles: ["surface"] })).toEqual({
      host: "disabled",
      loadExecutor: false,
      activeCleanupOwners: [],
    });
    expect(planServeTopology({ roles: ["anchor", "executor"] })).toEqual({
      host: "anchor-host",
      loadExecutor: true,
      activeCleanupOwners: ["anchor-host", "anchor-local-executor"],
    });
    expect(planServeTopology({ roles: ["executor", "anchor"] })).toEqual({
      host: "anchor-host",
      loadExecutor: true,
      activeCleanupOwners: ["anchor-host", "anchor-local-executor"],
    });
    expect(planServeTopology({ roles: ["anchor"] })).toEqual({
      host: "anchor-host",
      loadExecutor: false,
      activeCleanupOwners: ["anchor-host"],
    });
    expect(planServeTopology({ roles: ["executor"] })).toEqual({
      host: "executor-host",
      loadExecutor: true,
      activeCleanupOwners: [],
    });
  });
});
