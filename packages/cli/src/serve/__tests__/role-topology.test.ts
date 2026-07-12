import { describe, expect, it, vi } from "vitest";
import {
  UnsupportedServeRoleConfigurationError,
  planServeTopology,
  runConfiguredServeTopology,
  type ExecutorRoleModule,
} from "../role-topology.js";
import { runServeCommand } from "../topology-command.js";

function createLoaders() {
  const executor = {
    createExecutorRole: vi.fn(),
    createInProcessRuntimeFactory: vi.fn(),
  } as unknown as ExecutorRoleModule;
  const run = vi.fn(async () => {});
  const anchor = vi.fn(async () => ({ run }));
  const loadExecutor = vi.fn(async () => executor);
  return {
    loaders: { anchor, executor: loadExecutor },
    anchor,
    loadExecutor,
    run,
    executor,
  };
}

describe("serve role topology", () => {
  it("loads both role modules before starting the single-process topology", async () => {
    const harness = createLoaders();
    const options = { marker: "options" };

    await runConfiguredServeTopology(
      { roles: ["anchor", "executor"] },
      harness.loaders,
      options,
    );

    expect(harness.anchor).toHaveBeenCalledOnce();
    expect(harness.loadExecutor).toHaveBeenCalledOnce();
    expect(harness.run).toHaveBeenCalledWith(options, harness.executor);
  });

  it.each([
    { roles: [] as const },
    { roles: ["surface"] as const },
  ])("loads no service role for $roles", async (configuration) => {
    const harness = createLoaders();

    await runConfiguredServeTopology(configuration, harness.loaders, {});

    expect(harness.anchor).not.toHaveBeenCalled();
    expect(harness.loadExecutor).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });

  it.each([
    { roles: ["anchor"] as const },
    { roles: ["executor"] as const },
    { roles: ["anchor", "anchor"] as const },
    { roles: ["unknown"] as never },
  ])("rejects unsupported $roles before loading any role", async (configuration) => {
    const harness = createLoaders();

    await expect(
      runConfiguredServeTopology(configuration, harness.loaders, {}),
    ).rejects.toBeInstanceOf(UnsupportedServeRoleConfigurationError);

    expect(harness.anchor).not.toHaveBeenCalled();
    expect(harness.loadExecutor).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  });

  it("derives topology from the role set without a second mode flag", () => {
    expect(planServeTopology({ roles: [] })).toBe("disabled");
    expect(planServeTopology({ roles: ["surface"] })).toBe("disabled");
    expect(planServeTopology({ roles: ["anchor", "executor"] })).toBe(
      "single-process",
    );
    expect(planServeTopology({ roles: ["executor", "anchor"] })).toBe(
      "single-process",
    );
  });

  it("the production command leaves no listening socket for a surface-only device", async () => {
    const before = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "TCPServerWrap").length;

    await expect(
      runServeCommand({}, { roles: ["surface"] }),
    ).resolves.toBeUndefined();

    const after = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "TCPServerWrap").length;
    expect(after).toBe(before);
  });
});
