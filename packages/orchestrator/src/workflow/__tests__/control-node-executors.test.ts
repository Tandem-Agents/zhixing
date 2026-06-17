import { describe, expect, it } from "vitest";
import type {
  NodeExecutionContext,
  WorkflowNode,
  WorkflowNodeRun,
} from "@zhixing/core";
import { GateNodeExecutor } from "../gate-node-executor.js";
import { JoinNodeExecutor } from "../join-node-executor.js";
import { TransformNodeExecutor } from "../transform-node-executor.js";

function node(
  kind: WorkflowNode["kind"],
  executorId: string,
  config: Record<string, unknown>,
): WorkflowNode {
  return {
    nodeId: kind,
    kind,
    executor: {
      executorId,
      config,
    },
  } as WorkflowNode;
}

function nodeRun(nodeId: string): WorkflowNodeRun {
  return {
    nodeRunId: `${nodeId}-run`,
    nodeId,
    iteration: 0,
    attempt: 0,
    status: "running",
  };
}

function context(
  workflowNode: WorkflowNode,
  overrides: Partial<NodeExecutionContext> = {},
): NodeExecutionContext {
  return {
    node: workflowNode,
    nodeRun: nodeRun(workflowNode.nodeId),
    input: {
      instance: { goal: "ship workflow" },
      nodes: { review: { findings: ["real issue"] } },
      constants: [],
    },
    ...overrides,
  } as NodeExecutionContext;
}

describe("control workflow node executors", () => {
  it("gate executor returns a decision request with optional input evidence", async () => {
    const executor = new GateNodeExecutor();

    const result = await executor.run(
      context(
        node("gate", "workflow.gate", {
          question: "Continue?",
          recommendedOptionId: "yes",
          includeInputInRationale: true,
          rationale: "Evidence matters.",
          options: [
            { optionId: "yes", label: "Yes" },
            { optionId: "no", label: "No" },
          ],
        }),
      ),
    );

    expect(result.status).toBe("waiting_decision");
    if (result.status !== "waiting_decision") return;
    expect(result.decision.question).toBe("Continue?");
    expect(result.decision.recommendedOptionId).toBe("yes");
    expect(result.decision.rationale).toContain("Evidence matters.");
    expect(result.decision.rationale).toContain('"goal": "ship workflow"');
  });

  it("gate executor rejects malformed options before pausing", async () => {
    const executor = new GateNodeExecutor();

    const result = await executor.run(
      context(
        node("gate", "workflow.gate", {
          question: "Continue?",
          options: [],
        }),
      ),
    );

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "workflow.gate_config_invalid",
        message: "Gate node executor requires at least one option",
        recoverable: false,
      },
    });

    const duplicateResult = await executor.run(
      context(
        node("gate", "workflow.gate", {
          question: "Continue?",
          options: [
            { optionId: " yes ", label: "Yes" },
            { optionId: "yes", label: "Still yes" },
          ],
        }),
      ),
    );

    expect(duplicateResult).toEqual({
      status: "failed",
      error: {
        code: "workflow.gate_config_invalid",
        message: 'Gate node executor option "yes" is duplicated',
        recoverable: false,
      },
    });
  });

  it("join executor snapshots resolved node input as a deterministic artifact", async () => {
    const executor = new JoinNodeExecutor();

    const result = await executor.run(
      context(
        node("join", "workflow.join", {
          label: "reviews",
          metadata: { stage: "review" },
        }),
      ),
    );

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output).toMatchObject({
      kind: "join",
      label: "reviews",
      metadata: { stage: "review" },
      input: {
        nodes: { review: { findings: ["real issue"] } },
      },
    });
  });

  it("transform executor builds JSON output from safe JSON pointers", async () => {
    const executor = new TransformNodeExecutor();

    const result = await executor.run(
      context(
        node("transform", "workflow.transform", {
          output: { kind: "delivery" },
          inputPointers: {
            goal: "/instance/goal",
            findings: "/nodes/review/findings",
          },
        }),
      ),
    );

    expect(result).toEqual({
      status: "succeeded",
      output: {
        kind: "delivery",
        goal: "ship workflow",
        findings: ["real issue"],
      },
    });
  });

  it("control executors honor an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort("workflow canceled");

    const result = await new JoinNodeExecutor().run(
      context(node("join", "workflow.join", {}), { signal: controller.signal }),
    );

    expect(result).toEqual({
      status: "canceled",
      reason: "workflow canceled",
    });
  });
});
