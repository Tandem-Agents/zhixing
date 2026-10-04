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
vi.mock("@zhixing/providers", async (original) => ({
  ...await original<typeof import("@zhixing/providers")>(),
  loadConfig: calls.load,
  editConfiguration: calls.write,
  loadConfigurationSnapshot: calls.snapshot,
}));
vi.mock("@zhixing/secrets", () => ({ createPlatformSecretStore: calls.store }));
vi.mock("../../commands/command-visibility.js", () => ({ requireChrome: () => true }));
vi.mock("../../config-editor/index.js", () => ({
  BASE_CONFIG_SECTION_IDS: [],
  runConfigEditor: calls.editor,
}));
vi.mock("../../serve/managed-service-runtime.js", () => ({
  reconcileCurrentManagedService: calls.reconcile,
}));
import { handleConfigCommand, handleMcpCommand } from "../config-command.js";
import { ChannelConfiguration } from "../extensions/channel-configuration.js";

describe("REPL config command home binding", () => {
  const makeDeps = () => ({
    zhixingHome: path.resolve("synthetic-config-home"), configPath: path.resolve("synthetic-config-home/config.jsonc"),
    rl: { pause: vi.fn(), resume: vi.fn() } as never,
    renderer: { stop: vi.fn() }, writer: { line: vi.fn(), appendInline: vi.fn(), notify: vi.fn(), ensureSegmentBreak: vi.fn() },
    screen: { reassertCursorHidden: vi.fn() } as never,
    state: { activeTurnPromise: null as Promise<unknown> | null }, requestHostReload: vi.fn(async () => undefined),
  });

  it.each(["cancelled", "save-failed", "unchanged"])("旧配置适配器的 %s 不请求换代且恢复输入", async scenario => {
    calls.snapshot.mockResolvedValue({ config: {}, credentials: {} });
    calls.write.mockImplementation(async () => { if (scenario === "save-failed") throw new Error("fenced edit rejected"); });
    calls.editor.mockImplementation(async input => {
      if (scenario === "cancelled") return { kind: "cancelled" };
      const result = { kind: "completed", config: {}, credentials: {} };
      await input.writers.save(result);
      return result;
    });
    const deps = makeDeps();
    await handleConfigCommand(deps);
    expect(deps.requestHostReload).not.toHaveBeenCalled();
    expect(deps.rl.resume).toHaveBeenCalledOnce();
    expect(deps.screen.reassertCursorHidden).toHaveBeenCalledOnce();
    if (scenario === "save-failed") {
      expect(deps.writer.line.mock.calls.flat().join("\n")).toContain("fenced edit rejected");
      expect(deps.writer.line.mock.calls.flat().join("\n")).not.toContain("已保存");
    }
  });

  it.each([false, true])("MCP owner 保存一次，等待当前轮再激活，激活失败=%s 保留已保存反馈", async failed => {
    const deps = makeDeps();
    const turn = Promise.withResolvers<void>();
    deps.state.activeTurnPromise = turn.promise;
    deps.requestHostReload.mockImplementation(async () => { if (failed) throw new Error("activation failed"); });
    calls.load.mockReturnValue({});
    calls.snapshot.mockResolvedValue({ config: {}, credentials: {} });
    calls.write.mockImplementation(async () => undefined);
    calls.editor.mockImplementation(async input => {
      const result = { kind: "completed", config: { mcp: { servers: {} } }, credentials: { mcp: {} } };
      await input.writers.save(result);
      return result;
    });
    const run = handleMcpCommand({ ...deps, readMcpStatusWire: async () => [], llmComplete: vi.fn(async () => { throw new Error("no model"); }) });
    await vi.waitFor(() => expect(calls.write).toHaveBeenCalledOnce());
    expect(deps.requestHostReload).not.toHaveBeenCalled();
    turn.resolve(); await run;
    expect(calls.write.mock.calls[0]?.[2]).toMatchObject({ scope: "mcp", configPath: deps.configPath });
    expect(deps.requestHostReload).toHaveBeenCalledOnce();
    expect(deps.writer.line.mock.calls.flat().join("\n")).toContain(failed ? "尚未确认生效" : "已保存并生效");
    expect(deps.rl.resume).toHaveBeenCalledOnce();
  });
  it.each([false, true])("通道应用失败不跳过同次模型与启动项变更，重载失败=%s 分别反馈", async reloadFails => {
    const deps = makeDeps(), turn = Promise.withResolvers<void>();
    deps.state.activeTurnPromise = turn.promise;
    deps.requestHostReload.mockImplementation(async () => { if (reloadFails) throw Error("reload unavailable"); });
    const apply = vi.fn(async () => { throw Error("channel response lost"); });
    calls.snapshot.mockResolvedValue({ config: {}, credentials: {} });
    calls.write.mockImplementation(async () => undefined);
    calls.editor.mockImplementation(async input => {
      const result = { kind: "completed", config: {
        llm: { main: { provider: "synthetic", model: "synthetic-model" } },
        mesh: { enabledRoles: ["executor"], executorAutoStart: true },
        messaging: { synthetic: { enabled: true } },
      }, credentials: {} };
      await input.writers.save(result); return result;
    });
    const run = handleConfigCommand({ ...deps, applyExtensionConfiguration: apply });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(["synthetic"]));
    expect(deps.requestHostReload).not.toHaveBeenCalled();
    turn.resolve(); await run;
    expect(deps.requestHostReload).toHaveBeenCalledExactlyOnceWith({ launchSelectionChanged: true });
    expect(calls.reconcile).toHaveBeenCalledExactlyOnceWith("local-role-config-committed", undefined, deps.zhixingHome);
    const lines = deps.writer.line.mock.calls.flat().join("\n");
    expect(lines).toContain("消息通道尚未确认应用");
    expect(lines).toContain(reloadFails ? "核心宿主重载未确认" : "核心宿主已按新配置重启");
    expect(deps.rl.resume).toHaveBeenCalledOnce();
  });

  it("只有通道的应用失败保持待应用，重开未改配置仍重试原发布且不换代", async () => {
    const deps = makeDeps();
    const config = { messaging: { synthetic: { enabled: true } } };
    calls.snapshot.mockResolvedValue({ config, credentials: {} });
    calls.write.mockImplementation(async () => undefined);
    calls.editor.mockImplementation(async input => {
      const result = { kind: "completed", config: input.initialConfig, credentials: input.initialCredentials };
      await input.writers.save(result); return result;
    });
    const pending = vi.spyOn(ChannelConfiguration.prototype, "pending").mockResolvedValue(true);
    const snapshot = { instances: [], operations: [] } as never;
    const apply = vi.fn().mockRejectedValueOnce(Error("channel response lost")).mockResolvedValueOnce(snapshot);
    try {
      const input = { ...deps, readExtensions: async () => snapshot, applyExtensionConfiguration: apply };
      await handleConfigCommand(input);
      expect(deps.writer.line.mock.calls.flat().join("\n")).toContain("消息通道尚未确认应用");
      await handleConfigCommand(input);
      expect(apply.mock.calls).toEqual([[["synthetic"]], [["synthetic"]]]);
      expect(deps.requestHostReload).not.toHaveBeenCalled();
      expect(deps.writer.line.mock.calls.flat().join("\n")).toContain("连接按需局部刷新");
      expect(deps.rl.resume).toHaveBeenCalledTimes(2);
    } finally { pending.mockRestore(); }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it("rereads and writes the chosen file while credentials and turnover retain the data root", async () => {
    const home = path.resolve("config-data-a");
    const configPath = path.resolve("config-files-b/custom.jsonc");
    const current = { mesh: { enabledRoles: ["executor"], executorAutoStart: false } };
    const updated = { mesh: { enabledRoles: ["executor"], executorAutoStart: true } };
    calls.snapshot.mockResolvedValue({ config: current, credentials: {} });
    calls.editor.mockImplementation(async (input) => {
      expect(input.initialConfig).toBe(current);
      expect(input.header.configPath).toBe(configPath);
      vi.stubEnv("ZHIXING_HOME", path.resolve("unrelated-data"));
      vi.stubEnv("ZHIXING_CONFIG_PATH", path.resolve("unrelated.jsonc"));
      await input.writers.save({ kind: "completed", config: updated, credentials: {} });
      return { kind: "completed", config: updated, credentials: {} };
    });
    const reload = vi.fn(async () => undefined);
    const writer = { line: vi.fn(), appendInline: vi.fn(), notify: vi.fn(), ensureSegmentBreak: vi.fn() };
    await handleConfigCommand({
      zhixingHome: home,
      configPath,
      rl: { pause: vi.fn(), resume: vi.fn() } as never,
      renderer: { stop: vi.fn() },
      writer,
      screen: { reassertCursorHidden: vi.fn() } as never,
      state: { activeTurnPromise: null },
      requestHostReload: reload,
    });
    expect(calls.snapshot).toHaveBeenCalledWith({ configPath, store: { marker: "selected-store" } });
    expect(calls.write).toHaveBeenCalledWith({ config: current, credentials: {} }, { kind: "completed", config: updated, credentials: {} },
      { configPath, store: { marker: "selected-store" }, prepare: undefined });
    expect(calls.store).toHaveBeenCalledWith({ homeDir: home });
    expect(reload).toHaveBeenCalledOnce();
    expect(calls.reconcile).toHaveBeenCalledWith("local-role-config-committed", undefined, home);
  });
});
