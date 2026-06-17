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
  buildWorkflowDecideMethod,
  buildWorkflowGetMethod,
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
});
