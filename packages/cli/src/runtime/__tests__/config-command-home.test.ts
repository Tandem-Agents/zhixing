import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  load: vi.fn(),
  write: vi.fn(async () => undefined),
  store: vi.fn(() => ({ marker: "selected-store" })),
  snapshot: vi.fn(async () => ({ config: {}, credentials: {} })),
  writeCredentials: vi.fn(async () => undefined),
  editor: vi.fn(),
  reconcile: vi.fn(async () => undefined),
}));
vi.mock("@zhixing/providers/configuration", async (original) => ({
  ...await original<typeof import("@zhixing/providers/configuration")>(),
  loadConfig: calls.load,
  editConfiguration: calls.write,
  loadConfigurationSnapshot: calls.snapshot,
}));
vi.mock("@zhixing/secrets", () => ({ createPlatformSecretStore: calls.store }));
vi.mock("../../serve/managed-service-runtime.js", () => ({
  reconcileCurrentManagedService: calls.reconcile,
}));
// These cases exercise the real MCP application save/activation owner. Discovery
// and probe infrastructure are outside this boundary and must not turn its
// ordering assertions into a cold module-loading deadline.
vi.mock("../mcp-management-adapter.js", () => ({
  createMcpManagementAdapter: (options: { readStatusWire(): Promise<unknown> }) => ({
    snapshot: options.readStatusWire,
    isServerIdValid: () => true,
    probe: vi.fn(), search: vi.fn(), readSource: vi.fn(),
  }),
}));
import { editRuntimeConfiguration, prepareMcpConfiguration, type ConfigurationApplicationDeps } from "../configuration-application.js";
import { ChannelConfiguration } from "../extensions/channel-configuration.js";

const edit = (deps: ConfigurationApplicationDeps) =>
  editRuntimeConfiguration(deps, { kind: "config", edit: calls.editor });
const makeDeps = () => ({
  zhixingHome: path.resolve("synthetic-config-home"),
  configPath: path.resolve("synthetic-config-home/config.jsonc"),
  state: { activeTurnPromise: null as Promise<unknown> | null },
  requestHostReload: vi.fn(async () => undefined),
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("Node configuration application home and commit boundaries", () => {
  it.each(["cancelled", "save-failed", "unchanged"])("%s does not request turnover", async scenario => {
    calls.snapshot.mockResolvedValue({ config: {}, credentials: {} });
    calls.write.mockImplementation(async () => { if (scenario === "save-failed") throw Error("fenced edit rejected"); });
    calls.editor.mockImplementation(async session => {
      if (scenario === "cancelled") return { kind: "cancelled" };
      const result = { kind: "completed", config: {}, credentials: {} };
      await session.writers.save(result); return result;
    });
    const deps = makeDeps();
    if (scenario === "save-failed") await expect(edit(deps)).rejects.toThrow("fenced edit rejected");
    else await expect(edit(deps)).resolves.toMatchObject({ kind: scenario === "cancelled" ? "cancelled" : "local-applied" });
    expect(deps.requestHostReload).not.toHaveBeenCalled();
  });

  it.each([false, true])("MCP saves once, waits for the current turn and reports activation failure=%s", async failed => {
    const deps = makeDeps(), turn = Promise.withResolvers<void>(), saved = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const catchTurn = turn.promise.catch.bind(turn.promise);
    const subscription = vi.spyOn(turn.promise, "catch").mockImplementation(handler => {
      const pending = catchTurn(handler); waiting.resolve(); return pending;
    });
    deps.state.activeTurnPromise = turn.promise;
    deps.requestHostReload.mockImplementation(async () => { if (failed) throw Error("activation failed"); });
    calls.load.mockReturnValue({});
    calls.snapshot.mockResolvedValue({ config: {}, credentials: {} });
    calls.write.mockImplementation(async () => { saved.resolve(); });
    calls.editor.mockImplementation(async session => {
      const result = { kind: "completed", config: { mcp: { servers: {} } }, credentials: { mcp: {} } };
      await session.writers.save(result); return result;
    });
    const management = await prepareMcpConfiguration({
      configPath: deps.configPath, readMcpStatusWire: async () => [],
      llmComplete: vi.fn(async () => { throw Error("no model"); }),
    });
    const run = editRuntimeConfiguration(deps, { kind: "mcp", edit: calls.editor, mcpApplication: management.mcpApplication });
    let result: Awaited<typeof run> | undefined;
    try {
      await Promise.race([saved.promise, run.then(() => { throw Error("completed without saving"); })]);
      await Promise.race([waiting.promise, run.then(() => { throw Error("completed without waiting for active turn"); })]);
      expect(calls.write).toHaveBeenCalledOnce();
      expect(subscription).toHaveBeenCalledOnce();
      expect(deps.requestHostReload).not.toHaveBeenCalled();
    } finally { turn.resolve(); result = await run.finally(() => subscription.mockRestore()); }
    expect(calls.write.mock.calls[0]?.[2]).toMatchObject({ scope: "mcp", configPath: deps.configPath });
    expect(deps.requestHostReload).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: "mcp", result: { status: failed ? "saved" : "active" } });
  });

  it.each([false, true])("Channel failure preserves model and launch changes; reload failure=%s is independent", async reloadFails => {
    const deps = makeDeps(), turn = Promise.withResolvers<void>();
    deps.state.activeTurnPromise = turn.promise;
    deps.requestHostReload.mockImplementation(async () => { if (reloadFails) throw Error("reload unavailable"); });
    const apply = vi.fn(async () => { throw Error("channel response lost"); });
    calls.snapshot.mockResolvedValue({ config: {}, credentials: {} });
    calls.write.mockImplementation(async () => undefined);
    calls.editor.mockImplementation(async session => {
      const result = { kind: "completed", config: {
        llm: { main: { provider: "synthetic", model: "synthetic-model" } },
        mesh: { enabledRoles: ["executor"], executorAutoStart: true },
        messaging: { synthetic: { enabled: true } },
      }, credentials: {} };
      await session.writers.save(result); return result;
    });
    const run = edit({ ...deps, applyExtensionConfiguration: apply });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(["synthetic"]));
    expect(deps.requestHostReload).not.toHaveBeenCalled();
    turn.resolve(); const result = await run;
    expect(deps.requestHostReload).toHaveBeenCalledExactlyOnceWith({ launchSelectionChanged: true });
    expect(calls.reconcile).toHaveBeenCalledExactlyOnceWith("local-role-config-committed", undefined, deps.zhixingHome);
    expect(result).toMatchObject({ kind: "reloaded", pendingChannels: true,
      effects: { reload: { status: reloadFails ? "failed" : "succeeded" }, reconcile: { status: "succeeded" } } });
  });

  it("reopening unchanged pending Channel configuration retries the publication without turnover", async () => {
    const deps = makeDeps(), config = { messaging: { synthetic: { enabled: true } } };
    calls.snapshot.mockResolvedValue({ config, credentials: {} });
    calls.write.mockImplementation(async () => undefined);
    calls.editor.mockImplementation(async session => {
      const result = { kind: "completed", config: session.initialConfig, credentials: session.initialCredentials };
      await session.writers.save(result); return result;
    });
    const pending = vi.spyOn(ChannelConfiguration.prototype, "pending").mockResolvedValue(true);
    const snapshot = { instances: [], operations: [] } as never;
    const apply = vi.fn().mockRejectedValueOnce(Error("channel response lost")).mockResolvedValueOnce(snapshot);
    try {
      const input = { ...deps, readExtensions: async () => snapshot, applyExtensionConfiguration: apply };
      await expect(edit(input)).resolves.toEqual({ kind: "saved-pending", stage: "channels" });
      await expect(edit(input)).resolves.toEqual({ kind: "local-applied" });
      expect(apply.mock.calls).toEqual([[["synthetic"]], [["synthetic"]]]);
      expect(deps.requestHostReload).not.toHaveBeenCalled();
    } finally { pending.mockRestore(); }
  });

  it("rereads and writes the selected config while credentials and turnover retain the original data root", async () => {
    const home = path.resolve("config-data-a"), configPath = path.resolve("config-files-b/custom.jsonc");
    const current = { mesh: { enabledRoles: ["executor"], executorAutoStart: false } };
    const updated = { mesh: { enabledRoles: ["executor"], executorAutoStart: true } };
    calls.snapshot.mockResolvedValue({ config: current, credentials: {} });
    calls.write.mockImplementation(async () => undefined);
    calls.editor.mockImplementation(async session => {
      expect(session.initialConfig).toBe(current);
      vi.stubEnv("ZHIXING_HOME", path.resolve("unrelated-data"));
      vi.stubEnv("ZHIXING_CONFIG_PATH", path.resolve("unrelated.jsonc"));
      const result = { kind: "completed", config: updated, credentials: {} };
      await session.writers.save(result); return result;
    });
    const reload = vi.fn(async () => undefined);
    await edit({ zhixingHome: home, configPath, state: { activeTurnPromise: null }, requestHostReload: reload });
    expect(calls.snapshot).toHaveBeenCalledWith({ configPath, store: { marker: "selected-store" } });
    expect(calls.write).toHaveBeenCalledWith({ config: current, credentials: {} },
      { kind: "completed", config: updated, credentials: {} }, { configPath, store: { marker: "selected-store" }, prepare: undefined });
    expect(calls.store).toHaveBeenCalledWith({ homeDir: home });
    expect(reload).toHaveBeenCalledOnce();
    expect(calls.reconcile).toHaveBeenCalledWith("local-role-config-committed", undefined, home);
  });
});
