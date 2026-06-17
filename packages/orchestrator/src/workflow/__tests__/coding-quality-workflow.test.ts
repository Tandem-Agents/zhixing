import { describe, expect, it } from "vitest";
import {
  BoundaryRegistry,
  ConfirmationBroker,
  DefaultNodeExecutorRegistry,
  DefinitionValidator,
  PermissionStore,
  SecurityPipeline,
  createEventBus,
  type AgentEventMap,
  type LLMProvider,
  type LLMRole,
  type LLMRoles,
  type ToolDefinition,
} from "@zhixing/core";
import {
  InMemoryWorkflowStore,
  WorkflowManager,
  type WorkflowIdFactory,
} from "../../../../server/src/workflow/index.js";
import {
  AgentNodeExecutor,
  CODING_QUALITY_WORKFLOW_EXECUTOR_IDS,
  DEFAULT_AGENT_NODE_EXECUTOR_ID,
  DEFAULT_GATE_NODE_EXECUTOR_ID,
  DEFAULT_JOIN_NODE_EXECUTOR_ID,
  DEFAULT_TOOL_NODE_EXECUTOR_ID,
  GateNodeExecutor,
  JoinNodeExecutor,
  ToolNodeExecutor,
  createCodingQualityWorkflowDefinition,
  type RunWorkflowChildAgent,
} from "../index.js";

function idFactory(): WorkflowIdFactory {
  let seq = 0;
  const next = (prefix: string) => `${prefix}_${++seq}`;
  return {
    instance: () => next("wf"),
    nodeRun: ({ nodeId, iteration, attempt }) =>
      `${next("run")}_${nodeId}_${iteration}_${attempt}`,
    decision: () => next("decision"),
    artifact: ({ key }) => `${next("artifact")}_${key}`,
  };
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

function makeEvidenceTool(): ToolDefinition {
  return {
    name: "workflow_evidence",
    description: "Return workflow evidence",
    inputSchema: { type: "object" },
    isReadOnly: true,
    needsPermission: false,
    boundaries: [
      { boundaryType: "app-state", access: "read", dynamic: false },
    ],
    call: async (input) => ({
      content: `evidence:${JSON.stringify(input)}`,
    }),
  };
}

function makeManager(calls: string[]): WorkflowManager {
  const provider = makeProvider();
  const evidenceTool = makeEvidenceTool();
  const securityPipeline = new SecurityPipeline({
    trustContext: { kind: "workspace", dir: process.cwd() },
    permissionStore: new PermissionStore({ rootDir: null }),
    toolBoundaryRegistry: BoundaryRegistry.fromTools([evidenceTool]),
    sessionType: "ci",
  });
  const runner: RunWorkflowChildAgent = async (options) => {
    calls.push(options.task);
    const nodeId = options.task.match(/Workflow node: ([^\n]+)/)?.[1] ?? "unknown";
    return {
      status: "completed",
      subAgentId: `sub-${calls.length}`,
      finalAssistantText: `${nodeId} completed`,
      usage: { inputTokens: 1, outputTokens: 1 },
      toolUses: 0,
      durationMs: 1,
    };
  };

  const registry = new DefaultNodeExecutorRegistry();
  registry.register(
    new AgentNodeExecutor({
      provider,
      model: "mock-model",
      llmRoles: makeRoles(provider),
      securityPipeline,
      workspace: process.cwd(),
      parentBus: createEventBus<AgentEventMap>({ lineage: "test" }),
      parentBroker: new ConfirmationBroker({ id: "workflow-parent" }),
      parentTools: [],
      riskMaxTokens: 1_000_000,
      runChildAgent: runner,
    }),
  );
  registry.register(
    new ToolNodeExecutor({
      tools: [evidenceTool],
      securityPipeline,
      workingDirectory: process.cwd(),
      confirmationBroker: new ConfirmationBroker({ id: "workflow-tool" }),
    }),
  );
  registry.register(new GateNodeExecutor());
  registry.register(new JoinNodeExecutor());

  return new WorkflowManager({
    store: new InMemoryWorkflowStore(),
    validator: new DefinitionValidator({
      allowedExecutors: [
        DEFAULT_AGENT_NODE_EXECUTOR_ID,
        DEFAULT_TOOL_NODE_EXECUTOR_ID,
        DEFAULT_GATE_NODE_EXECUTOR_ID,
        DEFAULT_JOIN_NODE_EXECUTOR_ID,
      ],
    }),
    executors: registry,
    idFactory: idFactory(),
    clock: () => new Date("2026-06-17T00:00:00.000Z"),
  });
}

describe("coding quality seed workflow", () => {
  it("is a declarative preset accepted by the core validator", () => {
    const definition = createCodingQualityWorkflowDefinition({
      evidenceToolName: "workflow_evidence",
      evidenceToolInput: { command: "status" },
    });

    const validated = new DefinitionValidator({
      allowedExecutors: CODING_QUALITY_WORKFLOW_EXECUTOR_IDS,
    }).validate(definition);

    expect(validated.entryNodeIds).toEqual(["goal_understanding"]);
    expect(validated.definition.nodes.map((node) => node.nodeId)).toEqual(
      expect.arrayContaining([
        "architecture_design",
        "product_design",
        "risk_design",
        "direction_gate",
        "implement_or_fix",
        "evidence_snapshot",
        "quality_gate",
        "delivery_summary",
      ]),
    );
    expect(validated.definition.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "quality_gate",
          to: "implement_or_fix",
          kind: "feedback",
          condition: "needs_fixes",
        }),
      ]),
    );
  });

  it("runs through manager, executors, decisions, repair feedback, and delivery", async () => {
    const agentCalls: string[] = [];
    const manager = makeManager(agentCalls);
    const definition = createCodingQualityWorkflowDefinition({
      evidenceToolName: "workflow_evidence",
      evidenceToolInput: { command: "status" },
      maxRepairIterations: 2,
    });

    const directionPaused = await manager.start({
      conversationId: "conv-1",
      goal: "ship the workflow unit",
      input: {
        goal: "ship the workflow unit",
        constraints: ["preserve architecture"],
        context: { module: "Workflow" },
      },
      definition,
    });

    expect(directionPaused.status).toBe("waiting_decision");
    expect(unresolvedDecision(directionPaused)?.nodeId).toBe("direction_gate");

    const qualityPaused0 = await manager.decide({
      instanceId: directionPaused.instanceId,
      decisionId: unresolvedDecision(directionPaused)!.decisionId,
      resultOptionId: "direction_approved",
      actor: "human",
      rationale: "Direction is sound.",
    });

    expect(qualityPaused0.status, summarizeInstance(qualityPaused0)).toBe(
      "waiting_decision",
    );
    expect(unresolvedDecision(qualityPaused0)?.nodeId).toBe("quality_gate");
    expect(
      qualityPaused0.nodeRuns
        .filter((run) =>
          [
            "correctness_review",
            "integration_review",
            "coverage_product_review",
          ].includes(run.nodeId),
        )
        .map((run) => `${run.nodeId}:${run.iteration}:${run.status}`),
    ).toEqual([
      "correctness_review:0:succeeded",
      "integration_review:0:succeeded",
      "coverage_product_review:0:succeeded",
    ]);

    const qualityPaused1 = await manager.decide({
      instanceId: qualityPaused0.instanceId,
      decisionId: unresolvedDecision(qualityPaused0)!.decisionId,
      resultOptionId: "needs_fixes",
      actor: "human",
      rationale: "One verified issue remains.",
    });

    expect(qualityPaused1.status).toBe("waiting_decision");
    expect(unresolvedDecision(qualityPaused1)?.nodeId).toBe("quality_gate");
    expect(
      qualityPaused1.nodeRuns
        .filter((run) => run.nodeId === "implement_or_fix")
        .map((run) => run.iteration),
    ).toEqual([0, 1]);
    expect(agentCalls.some((task) => task.includes('"optionId": "needs_fixes"'))).toBe(
      true,
    );
    expect(
      agentCalls.some((task) => task.includes("Input evidence JSON")),
    ).toBe(true);
    const implementTasks = agentCalls.filter((task) =>
      task.includes("Workflow node: implement_or_fix"),
    );
    expect(implementTasks[1]).toContain("design_convergence completed");
    expect(implementTasks[1]).toContain('"optionId": "direction_approved"');

    const completed = await manager.decide({
      instanceId: qualityPaused1.instanceId,
      decisionId: unresolvedDecision(qualityPaused1)!.decisionId,
      resultOptionId: "quality_accepted",
      actor: "human",
      rationale: "Verified clean.",
    });

    expect(completed.status).toBe("succeeded");
    expect(
      completed.nodeRuns.some(
        (run) => run.nodeId === "delivery_summary" && run.status === "succeeded",
      ),
    ).toBe(true);
    expect(
      completed.artifacts.some(
        (artifact) =>
          artifact.key === "output" &&
          JSON.stringify(artifact.value).includes("delivery_summary completed"),
      ),
    ).toBe(true);
    const deliveryTasks = agentCalls.filter((task) =>
      task.includes("Workflow node: delivery_summary"),
    );
    expect(deliveryTasks[0]).toContain("goal_understanding completed");
    expect(deliveryTasks[0]).toContain("design_convergence completed");
    expect(deliveryTasks[0]).toContain('"optionId": "direction_approved"');
    expect(deliveryTasks[0]).toContain('"optionId": "quality_accepted"');
  });
});

function unresolvedDecision(instance: {
  readonly decisions: readonly { readonly resolvedAt?: string; readonly decisionId: string; readonly nodeId: string }[];
}): { readonly decisionId: string; readonly nodeId: string } | undefined {
  return instance.decisions.find((decision) => !decision.resolvedAt);
}

function summarizeInstance(instance: {
  readonly status: string;
  readonly errors: readonly unknown[];
  readonly nodeRuns: readonly {
    readonly nodeId: string;
    readonly iteration: number;
    readonly attempt: number;
    readonly status: string;
    readonly error?: unknown;
  }[];
}): string {
  return JSON.stringify(
    {
      status: instance.status,
      errors: instance.errors,
      nodeRuns: instance.nodeRuns.map((run) => ({
        nodeId: run.nodeId,
        iteration: run.iteration,
        attempt: run.attempt,
        status: run.status,
        error: run.error,
      })),
    },
    null,
    2,
  );
}
