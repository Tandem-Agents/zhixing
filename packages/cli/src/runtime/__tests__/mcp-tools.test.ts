import { describe, expect, it, vi } from "vitest";
import { createEventBus, type AgentEventMap } from "@zhixing/core";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { createMcpManagementTools } from "../../serve/mcp-tools.js";
import { buildDisplayBody, buildConfirmationOptions } from "@zhixing/core/confirmation";

const candidate = { serverId: "demo", source: "inferred", entry: { type: "stdio", command: "npx", args: ["-y", "fixture-server"] }, secretFields: [] };
const handoff = { goal: "整理资料", constraints: ["不发布"], completed: ["已确认来源"], remaining: ["读取资料并总结"] };
function fixture(canConnect = true) {
  const discovery = { search: vi.fn(async () => []), readSource: vi.fn(async () => ({ kind: "not-found" as const })), snapshot: vi.fn(async () => [{ serverId: "demo", status: "connecting" as const, transport: "stdio" as const, toolCount: 0, error: "fixture-private-error" }]) };
  const tools = createMcpManagementTools(discovery, { deviceId: "device", revision: () => "public-revision", canConnect });
  return { discovery, tools };
}
describe("MCP model binding", () => {
  it("requires an explicit one-time decision showing the actual executable", () => {
    const tool = fixture().tools[1]!;
    expect(tool.requiresExplicitConfirmation).toBe(true);
    expect(tool.isReadOnly).toBe(false);
    expect(JSON.stringify(buildDisplayBody(tool.name, { candidate }))).toContain("fixture-server");
    expect(JSON.stringify(buildDisplayBody(tool.name, { candidate }, tool.confirmationDisplayContext))).toContain("执行设备：device");
    expect(buildConfirmationOptions(tool.name, { candidate }, { kind: "main" } as never, "main" as never, tool).map(({ kind }) => kind)).toEqual(["allow-once", "deny-with-reason"]);
  });
  it("only records a public proposal bound to a durable conversation and the actual device", async () => {
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    const intents: unknown[] = [];
    bus.on("post_turn_control:requested", (intent) => intents.push(intent));
    const result = await runContextStorage.run({ bus, lineage: "main", conversationId: "main-1", assignmentMutations: { execution: "conversation" } as never }, () => fixture().tools[1]!.call({ candidate, handoff }, {} as never));
    expect(result.isError).not.toBe(true);
    expect(intents).toEqual([{ kind: "connect_mcp", candidate, handoff, scope: { deviceId: "device", configurationRevision: "public-revision" } }]);
    expect(result.content).toContain("尚未安装或生效");
  });
  it("does not make false continuation promises outside a durable run", async () => {
    expect((await fixture().tools[1]!.call({ candidate, handoff }, {} as never)).isError).toBe(true);
  });
  it("does not let a child borrow its parent's continuation authority", async () => {
    const bus = createEventBus<AgentEventMap>({ lineage: "main/sub-child" });
    const intent = vi.fn();
    bus.on("post_turn_control:requested", intent);
    const result = await runContextStorage.run({ bus, lineage: "main/sub-child", conversationId: "main-1", assignmentMutations: { execution: "conversation" } as never }, () => fixture().tools[1]!.call({ candidate, handoff }, {} as never));
    expect(result.isError).toBe(true);
    expect(intent).not.toHaveBeenCalled();
  });
  it("keeps raw transport errors out of model-visible status", async () => {
    const result = await fixture().tools[0]!.call({ action: "status" }, {} as never);
    expect(result.content).not.toContain("fixture-private-error");
    expect(result.content).toContain("connecting");
  });
  it("does not advertise a connection tool on a discovery-only device", () => {
    expect(fixture(false).tools.map(({ name }) => name)).toEqual(["mcp_discover", "mcp_delegate"]);
    expect(fixture(false).tools[1]!.description).toContain("主设备的独立对话");
  });
  it("delegates only public plans from durable conversations, never background or child runs", async () => {
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    const intents: unknown[] = [];
    bus.on("post_turn_control:requested", (intent) => intents.push(intent));
    const tool = fixture(false).tools[1]!;
    for (const execution of ["conversation", "job"] as const) {
      const result = await runContextStorage.run({ bus, lineage: "main", conversationId: "remote-main", assignmentMutations: { execution } as never }, () => tool.call({ candidate, handoff }, {} as never));
      expect(result.isError === true).toBe(execution === "job");
    }
    expect(intents).toEqual([{ kind: "delegate_mcp", candidate, handoff }]);
    expect(tool.confirmationDisplayContext).toBeUndefined();
  });
});
