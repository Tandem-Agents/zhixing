import { describe, expect, it, vi } from "vitest";
import {
  McpConnectionApplication,
  McpManagementApplication,
  validateMcpCandidate,
  type McpConnectionInfrastructure,
  type McpSetupCandidate,
} from "./application.js";

const candidate: McpSetupCandidate = {
  serverId: "demo",
  source: "inferred",
  entry: { type: "stdio", command: "node", args: ["server.js"] },
  secretFields: [],
};
function fixture() {
  const port: McpConnectionInfrastructure = {
    inspect: vi.fn(async () => ({
      conflict: false,
      credentialsReady: true,
      configured: false,
      active: false,
    })),
    commit: vi.fn(async () => "added"),
    activate: vi.fn(async () => true),
  };
  return { port, app: new McpConnectionApplication(port) };
}
describe("MCP connection application", () => {
  it("projects actual credential waiting without starting or committing a connection", async () => {
    const { app, port } = fixture();
    vi.mocked(port.inspect).mockResolvedValueOnce({ conflict: false, credentialsReady: false, active: false, configured: false });
    expect(await app.pendingStatus(candidate, { deviceId: "anchor", configurationRevision: "v1" })).toBe("needs-credentials");
    expect(await app.pendingStatus(candidate, { deviceId: "anchor", configurationRevision: "v1" })).toBe("pending");
    expect(port.commit).not.toHaveBeenCalled(); expect(port.activate).not.toHaveBeenCalled();
  });
  it("has no process effect before durable configuration and recovers by normal connection", async () => {
    let saved = false; let starts = 0; let reachedWrite!: () => void;
    const writing = new Promise<void>(resolve => { reachedWrite = resolve; });
    const port: McpConnectionInfrastructure = {
      inspect: async () => ({ conflict: false, credentialsReady: true, configured: saved, active: false }),
      commit: async () => { reachedWrite(); return new Promise<never>(() => {}); },
      activate: async () => { starts++; return true; },
    };
    void new McpConnectionApplication(port).connect(candidate);
    await writing;
    expect(saved).toBe(false); expect(starts).toBe(0);
    const restarted = new McpConnectionApplication({ ...port, commit: async () => { saved = true; return "added"; } });
    expect((await restarted.connect(candidate)).status).toBe("active");
    expect(saved).toBe(true); expect(starts).toBe(1);
  });
  it("commits the approved binding before the first actual connection", async () => {
    const {port,app}=fixture();
    const scope={deviceId:"local",configurationRevision:"revision"};
    expect(await app.connect(candidate,undefined,undefined,scope)).toEqual({status:"active",serverId:"demo"});
    expect(port.commit).toHaveBeenCalledWith(candidate,scope);
    expect(vi.mocked(port.commit).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(port.activate).mock.invocationCallOrder[0]!);
  });
  it.each([
    "conflict",
    "credentials",
    "active",
    "configured",
  ])("respects existing state: %s", async (state) => {
    const { app, port } = fixture();
    vi.mocked(port.inspect).mockResolvedValue({
      conflict: state === "conflict",
      credentialsReady: state !== "credentials",
      active: state === "active",
      configured: state === "configured",
    });
    const result = await app.connect(candidate);
    expect(result.status).toBe(
      state === "conflict" ? "failed" : state === "credentials" ? "needs-credentials" : "active",
    );
    if (state !== "configured") expect(port.commit).not.toHaveBeenCalled();
  });
  it.each([
    "inspect",
    "commit",
    "activate",
  ] as const)("does not expose secret-bearing infrastructure errors from %s", async (stage) => {
    const { app, port } = fixture();
    vi.mocked(port[stage]).mockRejectedValue(new Error("test-secret-token"));
    const result = await app.connect(candidate);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("test-secret-token");
    if (stage === "activate") expect(JSON.stringify(result)).toContain("配置已保存");
  });
  it("does not save or start when the source stops during inspection", async () => {
    const {app,port}=fixture(); let current=true;
    vi.mocked(port.inspect).mockImplementation(async()=>{current=false;return {conflict:false,credentialsReady:true,configured:false,active:false};});
    expect((await app.connect(candidate,undefined,async()=>current)).status).toBe("failed");
    expect(port.commit).not.toHaveBeenCalled();expect(port.activate).not.toHaveBeenCalled();
  });
  it("reads back an uncertain commit before activation without replaying it", async()=>{
    const {app,port}=fixture();let configured=false;
    vi.mocked(port.inspect).mockImplementation(async()=>({conflict:false,credentialsReady:true,configured,active:false}));
    vi.mocked(port.commit).mockImplementation(async()=>{configured=true;throw new Error("lost response");});
    expect((await app.connect(candidate)).status).toBe("active");
    expect(port.commit).toHaveBeenCalledTimes(1);expect(port.inspect).toHaveBeenCalledTimes(2);expect(port.activate).toHaveBeenCalledTimes(1);
  });
  it("does not activate after conflicting concurrent configuration or a stopped source", async () => {
    for (const conflict of [true, false]) {
      const { app, port } = fixture();
      let current = true;
      vi.mocked(port.commit).mockImplementation(async () => {
        current = false;
        return conflict ? "conflict" : "added";
      });
      expect((await app.connect(candidate, undefined, async () => current)).status).toBe("failed");
      expect(port.activate).not.toHaveBeenCalled();
    }
  });
  it("serializes concurrent connection requests and preserves caller input", async () => {
    const { app, port } = fixture();
    let active = false;
    vi.mocked(port.inspect).mockImplementation(async () => ({
      active,
      configured: active,
      conflict: false,
      credentialsReady: true,
    }));
    vi.mocked(port.activate).mockImplementation(async () => {
      active = true;
      return true;
    });
    await Promise.all([app.connect(candidate), app.connect(candidate)]);
    expect(port.commit).toHaveBeenCalledTimes(1);
    expect(candidate.entry.args).toEqual(["server.js"]);
  });
  it("rejects an aborted request before infrastructure work", async () => {
    const { app, port } = fixture();
    await expect(app.connect(candidate, AbortSignal.abort())).rejects.toThrow();
    expect(port.inspect).not.toHaveBeenCalled();
  });
});

describe("MCP user management application", () => {
  it.each([
    "active",
    "missing",
    "stale",
    "activation-error",
  ])("reports actual activation, not just a saved configuration: %s", async (outcome) => {
    const save = vi.fn();
    const activate = vi.fn(async () => {
      if (outcome === "activation-error") throw new Error("private transport detail");
    });
    const status = {
      serverId: "demo",
      transport: "stdio",
      status: "connected",
      toolCount: 1,
    };
    const app = new McpManagementApplication({
      discovery: {
        snapshot: async () =>
          outcome === "missing"
            ? []
            : outcome === "stale"
              ? [status, { ...status, serverId: "removed" }]
              : [status],
      } as never,
      editor: { save, activate },
    });
    const result = await app.edit({
      servers: { demo: candidate.entry },
      credentials: {},
    });
    expect(result.status).toBe(outcome === "active" ? "active" : "saved");
    expect(JSON.stringify(result)).not.toContain("private transport detail");
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(activate.mock.invocationCallOrder[0]!);
  });
});
describe("public MCP candidate boundary", () => {
  it.each([
    { ...candidate, credentials: { token: "value" } },
    { ...candidate, entry: { command: "node", env: { TOKEN: "value" } } },
    {
      ...candidate,
      entry: { type: "http", url: "https://user:pass@example.org/mcp" },
    },
    {
      ...candidate,
      entry: { type: "http", url: "https://example.org/mcp?token=value" },
    },
    { ...candidate, entry: { command: "node", args: "secret" } },
    { ...candidate, serverId: "../escape" },
  ])("rejects unsafe or malformed public proposals", (value) =>
    expect(() => validateMcpCandidate(value)).toThrow());
  it("accepts reference anchors and secret field descriptions, never values", () => {
    expect(() =>
      validateMcpCandidate({
        ...candidate,
        homepage: "https://example.org/docs#auth",
        secretFields: [
          {
            key: "Authorization",
            label: "令牌",
            hint: "在安全面板输入",
            example: "",
            template: "Bearer {value}",
          },
        ],
      }),
    ).not.toThrow();
  });
});
