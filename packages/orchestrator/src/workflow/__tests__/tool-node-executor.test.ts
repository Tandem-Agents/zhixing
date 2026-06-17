import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationBroker,
  PermissionStore,
  SecurityPipeline,
  type NodeExecutionContext,
  type ToolDefinition,
  type ToolExecutionContext,
  type WorkflowNode,
  type WorkflowNodeRun,
} from "@zhixing/core";
import { ToolNodeExecutor } from "../tool-node-executor.js";

function node(config: Record<string, unknown>): WorkflowNode {
  return {
    nodeId: "call-tool",
    kind: "tool",
    executor: {
      executorId: "workflow.tool",
      config,
    },
  } as WorkflowNode;
}

function nodeRun(): WorkflowNodeRun {
  return {
    nodeRunId: "run-1",
    nodeId: "call-tool",
    iteration: 0,
    attempt: 0,
    status: "running",
  };
}

function context(
  config: Record<string, unknown>,
  overrides: Partial<NodeExecutionContext> = {},
): NodeExecutionContext {
  return {
    node: node(config),
    nodeRun: nodeRun(),
    input: {
      instance: { path: "/tmp/workflow.txt" },
      nodes: {
        previous: { summary: "from upstream" },
      },
      constants: [],
    },
    ...overrides,
  } as NodeExecutionContext;
}

function makePipeline(): {
  readonly pipeline: SecurityPipeline;
  readonly store: PermissionStore;
} {
  const store = new PermissionStore({ rootDir: null });
  const pipeline = new SecurityPipeline({
    trustContext: { kind: "workspace", dir: process.cwd() },
    permissionStore: store,
    sessionType: "ci",
  });
  return { pipeline, store };
}

function makeExecutor(
  tools: readonly ToolDefinition[],
  options: Partial<ConstructorParameters<typeof ToolNodeExecutor>[0]> = {},
): ToolNodeExecutor {
  const { pipeline } = makePipeline();
  return new ToolNodeExecutor({
    tools,
    securityPipeline: pipeline,
    workingDirectory: process.cwd(),
    ...options,
  });
}

function tool(
  name: string,
  call: ToolDefinition["call"],
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    needsPermission: false,
    call,
    ...overrides,
  };
}

describe("ToolNodeExecutor", () => {
  it("成功时通过安全执行器调用工具并映射 JSON Pointer 输入", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    let capturedContext: ToolExecutionContext | undefined;
    const controller = new AbortController();
    const read = tool("read", async (input, toolContext) => {
      capturedInput = input;
      capturedContext = toolContext;
      return {
        content: "file content",
        committedToUser: true,
      };
    });
    const executor = makeExecutor([read]);

    const result = await executor.run(
      context(
        {
          toolName: "read",
          input: { encoding: "utf8" },
          inputPointers: {
            path: "/instance/path",
            summary: "/nodes/previous/summary",
          },
        },
        { signal: controller.signal },
      ),
    );

    expect(result).toEqual({
      status: "succeeded",
      output: {
        toolName: "read",
        content: "file content",
        committedToUser: true,
      },
    });
    expect(capturedInput).toEqual({
      encoding: "utf8",
      path: "/tmp/workflow.txt",
      summary: "from upstream",
    });
    expect(capturedContext?.abortSignal).toBeDefined();
    expect(capturedContext?.abortSignal?.aborted).toBe(false);
    expect(capturedContext?.workingDirectory).toBe(process.cwd());
  });

  it("工具返回 isError 时映射为 failed", async () => {
    const read = tool("read", async () => ({
      content: "read failed",
      isError: true,
    }));
    const executor = makeExecutor([read]);

    const result = await executor.run(
      context({ toolName: "read", input: { path: "/tmp/a" } }),
    );

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "workflow.tool_error",
        message: "read failed",
        recoverable: true,
      },
    });
  });

  it("缺省确认 broker 不自动放行需要确认的工具", async () => {
    const bashCall = vi.fn(async () => ({ content: "executed" }));
    const bash = tool("bash", bashCall, {
      needsPermission: true,
      permissionArgumentKey: "command",
    });
    const executor = makeExecutor([bash]);

    const result = await executor.run(
      context({ toolName: "bash", input: { command: "curl https://example.com" } }),
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("workflow.tool_blocked");
    expect(result.error.recoverable).toBe(false);
    expect(bashCall).not.toHaveBeenCalled();
  });

  it("显式安全 deny 规则会阻断工具执行", async () => {
    const bashCall = vi.fn(async () => ({ content: "executed" }));
    const bash = tool("bash", bashCall, {
      needsPermission: true,
      permissionArgumentKey: "command",
    });
    const { pipeline, store } = makePipeline();
    store.create(
      { kind: "main" },
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "dangerous *" },
        decision: "deny",
        scope: "global",
      }),
    );
    const executor = makeExecutor([bash], { securityPipeline: pipeline });

    const result = await executor.run(
      context({ toolName: "bash", input: { command: "dangerous attack" } }),
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error.code).toBe("workflow.tool_blocked");
    expect(result.error.recoverable).toBe(false);
    expect(bashCall).not.toHaveBeenCalled();
  });

  it("注入可交互 broker 放行后才执行需确认工具", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest((request) => {
      queueMicrotask(() => broker.resolve(request.id, { kind: "allow-once" }));
    });
    const bashCall = vi.fn(async () => ({ content: "executed" }));
    const bash = tool("bash", bashCall, {
      needsPermission: true,
      permissionArgumentKey: "command",
    });
    const executor = makeExecutor([bash], { confirmationBroker: broker });

    const result = await executor.run(
      context({ toolName: "bash", input: { command: "curl https://example.com" } }),
    );

    expect(result).toEqual({
      status: "succeeded",
      output: {
        toolName: "bash",
        content: "executed",
        committedToUser: false,
      },
    });
    expect(bashCall).toHaveBeenCalledTimes(1);
  });

  it("节点 signal 已取消时不调用工具", async () => {
    const controller = new AbortController();
    controller.abort("workflow canceled");
    const readCall = vi.fn(async () => ({ content: "ok" }));
    const executor = makeExecutor([tool("read", readCall)]);

    const result = await executor.run(
      context(
        { toolName: "read", input: { path: "/tmp/a" } },
        { signal: controller.signal },
      ),
    );

    expect(result).toEqual({
      status: "canceled",
      reason: "workflow canceled",
    });
    expect(readCall).not.toHaveBeenCalled();
  });

  it("确认等待期间节点取消会取消 broker 请求并返回 canceled", async () => {
    const controller = new AbortController();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {
      queueMicrotask(() => controller.abort("workflow canceled"));
    });
    const bashCall = vi.fn(async () => ({ content: "executed" }));
    const bash = tool("bash", bashCall, {
      needsPermission: true,
      permissionArgumentKey: "command",
    });
    const executor = makeExecutor([bash], { confirmationBroker: broker });

    const result = await executor.run(
      context(
        { toolName: "bash", input: { command: "curl https://example.com" } },
        { signal: controller.signal },
      ),
    );

    expect(result).toEqual({
      status: "canceled",
      reason: "workflow canceled",
    });
    expect(broker.listPending()).toHaveLength(0);
    expect(bashCall).not.toHaveBeenCalled();
  });

  it("工具抛出 AbortError 时映射为 canceled", async () => {
    const error = new Error("operation aborted");
    error.name = "AbortError";
    const read = tool("read", async () => {
      throw error;
    });
    const executor = makeExecutor([read]);

    const result = await executor.run(
      context({ toolName: "read", input: { path: "/tmp/a" } }),
    );

    expect(result).toEqual({
      status: "canceled",
      reason: "operation aborted",
    });
  });

  it("未注册工具返回可恢复失败", async () => {
    const executor = makeExecutor([]);

    const result = await executor.run(
      context({ toolName: "missing", input: {} }),
    );

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "workflow.tool_missing",
        message: "Workflow tool not registered: missing",
        recoverable: true,
      },
    });
  });
});
