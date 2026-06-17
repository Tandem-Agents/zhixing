import { describe, expect, it } from "vitest";
import {
  DefaultNodeExecutorRegistry,
  DefinitionValidator,
  type NodeExecutor,
  type WorkflowDefinition,
} from "@zhixing/core";
import type { ServerContext } from "../../../context.js";
import type { HandlerContext } from "../../handlers.js";
import { RPC_ERROR_CODES } from "../../protocol.js";
import {
  InMemoryWorkflowStore,
  WorkflowManager,
} from "../../../workflow/index.js";
import {
  buildWorkflowCancelMethod,
  buildWorkflowDecideMethod,
  buildWorkflowGetMethod,
  buildWorkflowResumeMethod,
  buildWorkflowStartMethod,
} from "../workflow.js";

function ctx(workflow?: WorkflowManager): HandlerContext {
  return {
    connection: { authenticated: true } as never,
    server: {
      config: { port: 18900, host: "127.0.0.1", shutdownTimeoutMs: 30_000 },
      version: "test",
      token: "token",
      startedAt: Date.now(),
      workflow,
    } as ServerContext,
  };
}

function manager(): WorkflowManager {
  const executor: NodeExecutor = {
    executorId: "gate",
    async run() {
      return {
        status: "waiting_decision",
        decision: {
          question: "Continue?",
          options: [{ optionId: "yes", label: "Yes" }],
        },
      };
    },
  };
  const registry = new DefaultNodeExecutorRegistry();
  registry.register(executor);
  return new WorkflowManager({
    store: new InMemoryWorkflowStore(),
    executors: registry,
    validator: new DefinitionValidator({ allowedExecutors: ["gate"] }),
  });
}

function workflowDefinition(): WorkflowDefinition {
  return {
    id: "wf.rpc",
    name: "RPC workflow",
    nodes: [
      {
        nodeId: "gate",
        kind: "gate",
        executor: { executorId: "gate" },
      },
    ],
    edges: [],
  };
}

describe("workflow.* RPC methods", () => {
  it("starts, reads, and resolves a workflow through the manager", async () => {
    const workflow = manager();
    const started = await buildWorkflowStartMethod().handler(
      {
        conversationId: "conv-1",
        goal: "decide",
        definition: workflowDefinition(),
      },
      ctx(workflow),
    ) as Awaited<ReturnType<WorkflowManager["start"]>>;

    expect(started.status).toBe("waiting_decision");

    const read = await buildWorkflowGetMethod().handler(
      { instanceId: started.instanceId },
      ctx(workflow),
    );
    expect(read).toMatchObject({ instanceId: started.instanceId });

    const decided = await buildWorkflowDecideMethod().handler(
      {
        instanceId: started.instanceId,
        decisionId: started.decisions[0]!.decisionId,
        resultOptionId: "yes",
        actor: "human",
      },
      ctx(workflow),
    ) as Awaited<ReturnType<WorkflowManager["decide"]>>;

    expect(decided.status).toBe("succeeded");
  });

  it("returns invalid params for invalid definitions", async () => {
    await expect(
      buildWorkflowStartMethod().handler(
        {
          conversationId: "conv-1",
          goal: "bad",
          definition: { id: "bad", name: "Bad", nodes: [], edges: [] },
        },
        ctx(manager()),
      ),
    ).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INVALID_PARAMS,
    });
  });

  it("requires WorkflowManager to be configured", async () => {
    await expect(
      buildWorkflowStartMethod().handler(
        {
          conversationId: "conv-1",
          goal: "missing manager",
          definition: workflowDefinition(),
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
    });
  });

  it("supports detached start without waiting for long-running nodes", async () => {
    const executor: NodeExecutor = {
      executorId: "slow",
      async run() {
        return new Promise(() => {});
      },
    };
    const registry = new DefaultNodeExecutorRegistry();
    registry.register(executor);
    const workflow = new WorkflowManager({
      store: new InMemoryWorkflowStore(),
      executors: registry,
      validator: new DefinitionValidator({ allowedExecutors: ["slow"] }),
    });

    const started = await buildWorkflowStartMethod().handler(
      {
        conversationId: "conv-1",
        goal: "slow work",
        definition: {
          id: "wf.slow",
          name: "Slow workflow",
          nodes: [
            {
              nodeId: "slow",
              kind: "agent",
              executor: { executorId: "slow" },
            },
          ],
          edges: [],
        },
        detach: true,
      },
      ctx(workflow),
    ) as Awaited<ReturnType<WorkflowManager["startDetached"]>>;

    expect(started.status).toBe("created");
    expect(started.nodeRuns).toHaveLength(0);
  });

  it("supports detached decisions so access surfaces do not own advancement", async () => {
    const workflow = manager();
    const started = await buildWorkflowStartMethod().handler(
      {
        conversationId: "conv-1",
        goal: "decide",
        definition: workflowDefinition(),
      },
      ctx(workflow),
    ) as Awaited<ReturnType<WorkflowManager["start"]>>;

    const decided = await buildWorkflowDecideMethod().handler(
      {
        instanceId: started.instanceId,
        decisionId: started.decisions[0]!.decisionId,
        resultOptionId: "yes",
        actor: "human",
        detach: true,
      },
      ctx(workflow),
    ) as Awaited<ReturnType<WorkflowManager["decideDetached"]>>;

    expect(decided.status).toBe("running");
    expect(decided.decisions[0]?.resolvedAt).toBeDefined();
  });

  it("routes detached resume through the manager", async () => {
    const calls: string[] = [];
    const workflow = {
      resumeDetached: async (instanceId: string) => {
        calls.push(instanceId);
        return {
          instanceId,
          status: "running",
        };
      },
    } as unknown as WorkflowManager;

    const resumed = await buildWorkflowResumeMethod().handler(
      { instanceId: "wf-1", detach: true },
      ctx(workflow),
    );

    expect(calls).toEqual(["wf-1"]);
    expect(resumed).toMatchObject({ instanceId: "wf-1", status: "running" });
  });

  it("routes cancel through the manager with a user reason", async () => {
    const calls: Array<{ instanceId: string; reason: string }> = [];
    const workflow = {
      cancel: async (instanceId: string, reason: string) => {
        calls.push({ instanceId, reason });
      },
    } as unknown as WorkflowManager;

    const result = await buildWorkflowCancelMethod().handler(
      { instanceId: "wf-1", reason: "用户停止" },
      ctx(workflow),
    );

    expect(calls).toEqual([{ instanceId: "wf-1", reason: "用户停止" }]);
    expect(result).toEqual({ canceled: true });
  });
});
