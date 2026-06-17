import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationBroker,
  createEventBus,
  PermissionStore,
  SecurityPipeline,
  type AgentEventMap,
  type LLMProvider,
  type LLMRole,
  type LLMRoles,
  type NodeExecutionContext,
  type ToolDefinition,
  type WorkflowNode,
  type WorkflowNodeRun,
} from "@zhixing/core";
import {
  AgentNodeExecutor,
  type RunWorkflowChildAgent,
} from "../agent-node-executor.js";

function node(config: Record<string, unknown>): WorkflowNode {
  return {
    nodeId: "review",
    kind: "agent",
    executor: {
      executorId: "workflow.agent",
      config,
    },
    outputContract: {
      schema: {
        type: "object",
        required: ["summary"],
      },
    },
  } as WorkflowNode;
}

function nodeRun(overrides: Partial<WorkflowNodeRun> = {}): WorkflowNodeRun {
  return {
    nodeRunId: "run-1",
    nodeId: "review",
    iteration: 0,
    attempt: 0,
    status: "running",
    ...overrides,
  };
}

function context(
  overrides: Partial<NodeExecutionContext> = {},
): NodeExecutionContext {
  return {
    node: node({ prompt: "Review the implementation" }),
    nodeRun: nodeRun(),
    input: {
      instance: { goal: "ship workflow" },
      nodes: {},
      constants: [],
    },
    ...overrides,
  } as NodeExecutionContext;
}

function makeExecutor(runner: RunWorkflowChildAgent): AgentNodeExecutor {
  const provider = makeProvider();
  return new AgentNodeExecutor({
    provider,
    model: "mock-model",
    llmRoles: makeRoles(provider),
    securityPipeline: new SecurityPipeline({
      trustContext: { kind: "workspace", dir: process.cwd() },
      permissionStore: new PermissionStore({ rootDir: null }),
      sessionType: "ci",
    }),
    workspace: process.cwd(),
    parentBus: createEventBus<AgentEventMap>({ lineage: "main" }),
    parentBroker: new ConfirmationBroker({ id: "parent-broker" }),
    parentTools: [makeTool("read")],
    riskMaxTokens: 1_000_000,
    runChildAgent: runner,
  });
}

function makeProvider(): LLMProvider {
  return {
    id: "mock",
    models: [],
    chat: async function* () {
      return;
    },
  };
}

function makeRoles(provider: LLMProvider): LLMRoles {
  const role: LLMRole = {
    provider,
    model: "mock-model",
    chat: (request) => provider.chat({ ...request, model: "mock-model" }),
  };
  return { main: role, light: role, power: role };
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    needsPermission: false,
    call: async () => ({ content: "ok" }),
  };
}

describe("AgentNodeExecutor", () => {
  it("成功时调用 runChildAgent 并返回结构化节点输出", async () => {
    const signal = new AbortController().signal;
    const runner = vi.fn<RunWorkflowChildAgent>(async () => ({
      status: "completed",
      subAgentId: "sub-1",
      finalAssistantText: "review complete",
      usage: { inputTokens: 10, outputTokens: 5, totalInputTokens: 12 },
      toolUses: 2,
      durationMs: 42,
    }));
    const executor = makeExecutor(runner);

    const result = await executor.run(context({ signal }));

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output).toEqual({
      finalText: "review complete",
      subAgentId: "sub-1",
      usage: { inputTokens: 10, outputTokens: 5, totalInputTokens: 12 },
      toolUses: 2,
      durationMs: 42,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    const call = runner.mock.calls[0]![0];
    expect(call.parentSignal).toBe(signal);
    expect(call.parentLineage).toBe("main/workflow-run-1");
    expect(call.task).toContain("Workflow node: review");
    expect(call.task).toContain("Review the implementation");
    expect(call.task).toContain('"goal": "ship workflow"');
    expect(call.task).toContain("Expected output contract:");
  });

  it("配置无 prompt 时失败且不启动子 agent", async () => {
    const runner = vi.fn<RunWorkflowChildAgent>();
    const executor = makeExecutor(runner);

    const result = await executor.run(
      context({ node: node({ includeInput: true }) }),
    );

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "workflow.agent_config_invalid",
        message: "Agent node executor requires non-empty prompt",
        recoverable: false,
      },
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("子 agent 失败时保留结构化错误类型", async () => {
    const runner = vi.fn<RunWorkflowChildAgent>(async () => ({
      status: "failed",
      subAgentId: "sub-err",
      finalAssistantText: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      toolUses: 0,
      durationMs: 1,
      error: { type: "provider_error", message: "provider refused" },
    }));
    const executor = makeExecutor(runner);

    const result = await executor.run(context());

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "workflow.agent.provider_error",
        message: "provider refused",
        recoverable: true,
      },
    });
  });

  it("节点 signal 已取消时直接返回 canceled", async () => {
    const controller = new AbortController();
    controller.abort("workflow canceled");
    const runner = vi.fn<RunWorkflowChildAgent>();
    const executor = makeExecutor(runner);

    const result = await executor.run(context({ signal: controller.signal }));

    expect(result).toEqual({
      status: "canceled",
      reason: "workflow canceled",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("子 agent aborted 映射为 workflow canceled", async () => {
    const runner = vi.fn<RunWorkflowChildAgent>(async () => ({
      status: "aborted",
      subAgentId: "sub-abort",
      finalAssistantText: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      toolUses: 0,
      durationMs: 1,
    }));
    const executor = makeExecutor(runner);

    const result = await executor.run(context());

    expect(result).toEqual({
      status: "canceled",
      reason: "Agent node aborted",
    });
  });
});
