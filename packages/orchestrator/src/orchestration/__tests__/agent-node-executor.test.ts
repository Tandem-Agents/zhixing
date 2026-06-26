import { describe, expect, it } from "vitest";
import {
  ConfirmationBroker,
  createEventBus,
  emptyUsage,
  MockLLMProvider,
  PermissionStore,
  SecurityPipeline,
  type AgentEventMap,
  type LLMRole,
  type LLMRoles,
  type Message,
  type NormalizedOrchestrationNodeV1,
  type OrchestrationContextSnapshotV1,
  type ToolDefinition,
} from "@zhixing/core";
import { createReadTool } from "@zhixing/tools-builtin";
import {
  createAgentNodeExecutorV1,
  type RunChildAgentForOrchestrationV1,
} from "../agent-node-executor.js";
import type { ChildAgentResult, RunChildAgentOptions } from "../../subagent/factory.js";
import type { OrchestrationNodeExecutionContextV1 } from "../types.js";

describe("ChildAgentNodeExecutorV1", () => {
  it("builds a child-agent task and injects context snapshot through background messages", async () => {
    let captured: RunChildAgentOptions | undefined;
    const snapshot = createSnapshot();
    const runChildAgent: RunChildAgentForOrchestrationV1 = async (options) => {
      captured = options;
      return childResult({ status: "completed", finalAssistantText: "{\"ok\":true}" });
    };
    const executor = createAgentNodeExecutorV1({
      ...createExecutorOptions(),
      runChildAgent,
    });

    const node = createNode({
      output: {
        required: true,
        format: "json",
        schema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
          additionalProperties: false,
        },
        maxChars: 200,
      },
    });
    const context = createContext({ contextSnapshot: snapshot });

    const result = await executor.runAgentNode(node, context);

    expect(result).toMatchObject({
      nodeId: "review",
      status: "completed",
      output: {
        nodeId: "review",
        format: "json",
        content: "{\"ok\":true}",
      },
    });
    expect(captured?.parentBus).toBe(context.bus);
    expect(captured?.parentLineage).toBe(context.lineage);
    expect(captured?.parentSignal).toBe(context.abortSignal);
    expect(captured?.backgroundMessages).toBe(snapshot.messages);
    expect(captured?.budget).toMatchObject({
      maxTurns: 3,
      maxTokens: 123,
      wallClockTimeoutMs: 456,
    });
    expect(captured?.parentTools.map((tool) => tool.name)).toEqual(["read"]);
    expect(captured?.task).toContain("<instruction>\nReview the implementation.\n</instruction>");
    expect(captured?.task).toContain("<run_input>");
    expect(captured?.task).toContain('"ticket": "ZX-1"');
    expect(captured?.task).toContain("<dependency_outputs>");
    expect(captured?.task).toContain("dependency result");
    expect(captured?.task).toContain("Return only valid JSON");
    expect(captured?.task).toContain('"ok"');
    expect(captured?.task).not.toContain("background fact");
  });

  it("maps failed and aborted child-agent results into structured node results with partial output", async () => {
    const failedExecutor = createAgentNodeExecutorV1({
      ...createExecutorOptions(),
      runChildAgent: async () =>
        childResult({
          status: "failed",
          finalAssistantText: "partial analysis",
          error: { type: "provider_error", message: "upstream failed" },
          partial: "partial analysis",
        }),
    });

    const failed = await failedExecutor.runAgentNode(createNode(), createContext());
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({
      type: "provider_error",
      message: "upstream failed",
      origin: "node",
      nodeId: "review",
    });
    expect(failed.partial).toBe("partial analysis");

    const abortedExecutor = createAgentNodeExecutorV1({
      ...createExecutorOptions(),
      runChildAgent: async () =>
        childResult({
          status: "aborted",
          finalAssistantText: "stopped midway",
          abortReason: { kind: "user-cancel" },
        }),
    });

    const aborted = await abortedExecutor.runAgentNode(createNode(), createContext());
    expect(aborted.status).toBe("aborted");
    expect(aborted.error).toMatchObject({
      type: "agent_node_aborted",
      origin: "abort",
      nodeId: "review",
    });
    expect(aborted.error?.message).toContain("user cancelled");
    expect(aborted.partial).toBe("stopped midway");
  });

  it("fails loudly when declared node tools are not available in the parent tool set", async () => {
    let called = false;
    const executor = createAgentNodeExecutorV1({
      ...createExecutorOptions(),
      runChildAgent: async () => {
        called = true;
        return childResult({ status: "completed", finalAssistantText: "unreachable" });
      },
    });

    const result = await executor.runAgentNode(
      createNode({ policy: { timeoutMs: 456, maxTurns: 3, maxTokens: 123, tools: ["Read"] } }),
      createContext(),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      type: "agent_node_tools_unavailable",
      origin: "system",
      nodeId: "review",
    });
    expect(result.error?.message).toContain("Read");
    expect(called).toBe(false);
  });

  it("runs through the real child-agent path with real lowercase builtin tools", async () => {
    const provider = new MockLLMProvider([
      {
        toolCalls: [
          {
            id: "read-1",
            name: "read",
            input: { path: "package.json", limit: 1 },
          },
        ],
      },
      { text: "read completed" },
    ]);
    const executor = createAgentNodeExecutorV1({
      ...createExecutorOptions(provider),
      parentTools: [createReadTool()],
    });

    const result = await executor.runAgentNode(
      createNode({
        policy: { timeoutMs: 456, maxTurns: 3, maxTokens: 1_000, tools: ["read"] },
      }),
      createContext(),
    );

    expect(result.status).toBe("completed");
    expect(result.output?.content).toBe("read completed");
    expect(provider.calls[0]?.tools?.map((tool) => tool.name)).toContain("read");
  });
});

function createExecutorOptions(
  provider = new MockLLMProvider([{ text: "unused" }]),
): Parameters<typeof createAgentNodeExecutorV1>[0] {
  const role: LLMRole = {
    provider,
    model: "mock-model",
    chat: (request) => provider.chat(request),
  };
  const roles: LLMRoles = { main: role, light: role, power: role };
  return {
    provider,
    model: "mock-model",
    llmRoles: roles,
    securityPipeline: new SecurityPipeline({
      trustContext: { kind: "workspace", dir: process.cwd() },
      sessionType: "ci",
      permissionStore: new PermissionStore({ rootDir: null }),
    }),
    workspace: process.cwd(),
    workspaceSource: "cwd-fallback",
    parentBroker: new ConfirmationBroker({ id: "orchestration-parent-test" }),
    parentTools: [createTool("read"), createTool("write")],
    riskMaxTokens: 10_000,
  };
}

function createNode(
  overrides: Partial<NormalizedOrchestrationNodeV1> = {},
): NormalizedOrchestrationNodeV1 {
  return {
    id: "review",
    kind: "agent",
    dependsOn: ["discover"],
    instruction: "Review the implementation.",
    context: {
      includeRunInput: true,
      includeContextSnapshot: true,
      includeNodeOutputs: "dependencies",
    },
    output: { required: true, format: "text", maxChars: 200 },
    policy: {
      timeoutMs: 456,
      maxTurns: 3,
      maxTokens: 123,
      tools: ["read"],
    },
    ...overrides,
  };
}

function createTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" } as never,
    needsPermission: false,
    call: async () => ({ content: `${name} ok`, isError: false }),
  };
}

function createContext(
  overrides: Partial<OrchestrationNodeExecutionContextV1> = {},
): OrchestrationNodeExecutionContextV1 {
  return {
    runId: "run-1",
    definitionId: "definition-1",
    runInput: { ticket: "ZX-1" },
    contextSnapshot: createSnapshot(),
    dependencyOutputs: {
      discover: {
        nodeId: "discover",
        format: "text",
        content: "dependency result",
      },
    },
    abortSignal: new AbortController().signal,
    bus: createEventBus<AgentEventMap>({ lineage: "main/orch-run-1" }),
    lineage: "main/orch-run-1/node-review",
    ...overrides,
  };
}

function createSnapshot(): OrchestrationContextSnapshotV1 {
  const messages: readonly Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "background fact" }],
    },
  ];
  return {
    source: "attention_window",
    strategy: "full_or_fail",
    messages,
    estimatedTokens: 3,
    capturedAt: "2026-06-26T00:00:00.000Z",
  };
}

function childResult(
  overrides: Partial<ChildAgentResult>,
): ChildAgentResult {
  return {
    status: "completed",
    subAgentId: "sub-1",
    finalAssistantText: "done",
    usage: emptyUsage(),
    toolUses: 0,
    durationMs: 7,
    ...overrides,
  } as ChildAgentResult;
}
