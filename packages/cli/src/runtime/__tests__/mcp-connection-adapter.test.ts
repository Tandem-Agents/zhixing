import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpSetupCandidate } from "@zhixing/core/mcp-management";
import { createMcpConnectionAdapter } from "../mcp-connection-adapter.js";

const state = vi.hoisted(() => ({
  servers: {} as Record<string, unknown>, generation: "g1", revision: "r1", credentialIds: [] as string[],
  secrets: { demo: { TOKEN: "fixture-token", OTHER: "unrelated-fixture" } },
  read: vi.fn(), commit: vi.fn(),
}));
vi.mock("@zhixing/providers", () => ({
  getGlobalConfigPath: () => "fixture-config",
  loadConfig: () => ({ mcp: { servers: state.servers } }),
  mcpConfigurationRevision: () => state.revision,
  readCredentialBindingState: async () => ({ generation: state.generation, mcpIds: state.credentialIds }),
  addMcpServerConfiguration: async (id: string, entry: unknown) => { state.commit(); state.servers[id] = entry; return "added"; },
}));
const candidate: McpSetupCandidate = { serverId: "demo", source: "inferred", entry: { type: "stdio", command: "node", args: ["server.js"] }, secretFields: [] };
const requiringSecret: McpSetupCandidate = { ...candidate, secretFields: [{ key: "TOKEN", label: "令牌", hint: "安全输入", example: "" }] };
function fixture(configured = false) {
  let active = false;
  const add = vi.fn(async () => { active = true; });
  const app = createMcpConnectionAdapter({
    configPath: "fixture-config", deviceId: "device", credentialGeneration: "g1", secretStore: {} as never,
    configuredServers: configured ? { demo: candidate.entry } : {}, credentials: { mcp: state.secrets },
    runtime: { lifecycle: { add, connect: vi.fn(), close: vi.fn() }, tools: { snapshot: vi.fn() }, status: { snapshot: () => active ? [{ serverId: "demo", status: "connected", transport: "stdio", toolCount: 1 }] : [] } },
  });
  return { app, add };
}
beforeEach(() => { state.servers = {}; state.generation = "g1"; state.revision = "r1"; state.credentialIds = []; vi.clearAllMocks(); });
describe("controlled MCP connection infrastructure", () => {
  it("does not reuse orphan credentials when a new public server takes an old ID", async () => {
    const { app, add } = fixture();
    expect((await app.connect(candidate)).status).toBe("active");
    expect(add).toHaveBeenCalledWith({ serverId: "demo", transport: "stdio", command: "node", args: ["server.js"], url: undefined, credentials: {} });
    expect(state.read).not.toHaveBeenCalled();
  });
  it("waits for an explicitly configured credential binding instead of reusing orphan secrets", async () => {
    const { app, add } = fixture(true);
    expect((await app.connect(requiringSecret)).status).toBe("needs-credentials");
    expect(state.read).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    state.servers.demo = candidate.entry;
    expect((await app.connect(requiringSecret)).status).toBe("active");
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ credentials: { TOKEN: "fixture-token" } }));
    expect(JSON.stringify(add.mock.calls)).not.toContain("unrelated-fixture");
  });
  it("rejects an orphan credential binding even for a public candidate so a later restart cannot send it", async () => {
    state.credentialIds = ["demo"];
    const { app, add } = fixture();
    expect((await app.connect(candidate)).status).toBe("failed");
    expect(state.commit).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
  it("rejects changed endpoints, stale proposals and another device before effects", async () => {
    const { app, add } = fixture();
    expect((await app.connect(candidate, undefined, undefined, { deviceId: "other", configurationRevision: "r1" })).status).toBe("failed");
    expect((await app.connect(candidate, undefined, undefined, { deviceId: "device", configurationRevision: "old" })).status).toBe("failed");
    state.servers.demo = { command: "different" };
    expect((await app.connect(requiringSecret)).status).toBe("failed");
    expect(state.read).not.toHaveBeenCalled();
    expect(state.commit).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
  it("does not mix credentials from a later host generation", async () => {
    const { app, add } = fixture();
    state.servers.demo = candidate.entry;
    state.generation = "g2";
    const result = await app.connect(requiringSecret);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("fixture-token");
    expect(add).not.toHaveBeenCalled();
  });
  it("does not reconnect an already activated committed request", async () => {
    const { app, add } = fixture();
    await app.connect(candidate);
    await app.connect(candidate);
    expect(add).toHaveBeenCalledTimes(1);
    expect(state.commit).toHaveBeenCalledTimes(1);
  });
  it("does not mistake an old runtime connection for a newly edited public configuration", async () => {
    state.servers.demo = candidate.entry;
    const { app, add } = fixture(true);
    await app.connect(candidate);
    const changed = { ...candidate, entry: { ...candidate.entry, args: ["different.js"] } };
    state.servers.demo = changed.entry;
    expect((await app.connect(changed)).status).toBe("failed");
    expect(add).toHaveBeenCalledTimes(1);
  });
});
