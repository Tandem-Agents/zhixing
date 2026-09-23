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
import { handleConfigCommand } from "../config-command.js";

describe("REPL config command home binding", () => {
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
