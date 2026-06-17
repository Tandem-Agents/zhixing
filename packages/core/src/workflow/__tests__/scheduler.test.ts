import { describe, expect, it } from "vitest";
import { WorkflowScheduler } from "../scheduler.js";
import { DefinitionValidator } from "../validator.js";
import type {
  ValidatedWorkflowDefinition,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowNodeRunStatus,
} from "../types.js";

function node(
  nodeId: string,
  overrides: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    nodeId,
    kind: "agent",
    executor: { executorId: "agent.default" },
    ...overrides,
  };
}

function validated(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  overrides: Partial<WorkflowDefinition> = {},
): ValidatedWorkflowDefinition {
  return new DefinitionValidator({ allowedExecutors: ["agent.default"] }).validate({
    id: "wf.review",
    name: "Review workflow",
    nodes,
    edges,
    ...overrides,
  });
}

function run(
  nodeId: string,
  status: WorkflowNodeRunStatus,
  overrides: Partial<WorkflowNodeRun> = {},
): WorkflowNodeRun {
  const iteration = overrides.iteration ?? 0;
  const attempt = overrides.attempt ?? 0;
  return {
    nodeRunId: `${nodeId}-${iteration}-${attempt}-${status}`,
    nodeId,
    iteration,
    attempt,
    status,
    ...overrides,
  };
}

describe("WorkflowScheduler", () => {
  it("schedules entry nodes first and waits for upstream success before downstream nodes", () => {
    const wf = validated(
      [node("draft"), node("review", { kind: "gate" })],
      [{ from: "draft", to: "review", kind: "normal" }],
    );
    const scheduler = new WorkflowScheduler();

    expect(
      scheduler.plan({ validated: wf, nodeRuns: [] }).ready,
    ).toEqual([
      {
        nodeId: "draft",
        iteration: 0,
        attempt: 0,
        reason: "start",
      },
    ]);

    const afterDraft = scheduler.plan({
      validated: wf,
      nodeRuns: [run("draft", "succeeded")],
    });
    expect(afterDraft.ready).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "review",
          iteration: 0,
          attempt: 0,
          reason: "start",
        }),
      ]),
    );
  });

  it("does not create duplicate work while a node run is active or already succeeded", () => {
    const wf = validated([node("draft")], []);
    const scheduler = new WorkflowScheduler();

    expect(
      scheduler.plan({
        validated: wf,
        nodeRuns: [run("draft", "running")],
      }).blocked,
    ).toEqual([
      { nodeId: "draft", iteration: 0, reason: "active_run_exists" },
    ]);

    expect(
      scheduler.plan({
        validated: wf,
        nodeRuns: [run("draft", "succeeded")],
      }).blocked,
    ).toEqual([
      { nodeId: "draft", iteration: 0, reason: "already_succeeded" },
    ]);
  });

  it("does not restart canceled or skipped terminal node runs", () => {
    const wf = validated([node("draft")], []);
    const scheduler = new WorkflowScheduler();

    expect(
      scheduler.plan({
        validated: wf,
        nodeRuns: [run("draft", "canceled")],
      }).blocked,
    ).toEqual([
      { nodeId: "draft", iteration: 0, reason: "terminal_run_exists" },
    ]);

    expect(
      scheduler.plan({
        validated: wf,
        nodeRuns: [run("draft", "skipped")],
      }).blocked,
    ).toEqual([
      { nodeId: "draft", iteration: 0, reason: "terminal_run_exists" },
    ]);
  });

  it("limits new ready entries by maxParallelNodes", () => {
    const wf = validated(
      [node("design"), node("review")],
      [],
      { policies: { concurrency: { maxParallelNodes: 1 } } },
    );
    const scheduler = new WorkflowScheduler();

    const plan = scheduler.plan({ validated: wf, nodeRuns: [] });

    expect(plan.ready).toEqual([
      {
        nodeId: "design",
        iteration: 0,
        attempt: 0,
        reason: "start",
      },
    ]);
    expect(plan.blocked).toEqual([
      { nodeId: "review", iteration: 0, reason: "concurrency_limit_reached" },
    ]);
  });

  it("counts active node runs against the concurrency limit", () => {
    const wf = validated(
      [node("design"), node("review")],
      [],
      { policies: { concurrency: { maxParallelNodes: 1 } } },
    );
    const scheduler = new WorkflowScheduler();

    const plan = scheduler.plan({
      validated: wf,
      nodeRuns: [run("design", "running")],
    });

    expect(plan.ready).toEqual([]);
    expect(plan.blocked).toEqual([
      { nodeId: "design", iteration: 0, reason: "active_run_exists" },
      { nodeId: "review", iteration: 0, reason: "concurrency_limit_reached" },
    ]);
  });

  it("keeps waiting-decision node runs active until a decision resolves them", () => {
    const wf = validated([node("approval", { kind: "gate" })], []);
    const scheduler = new WorkflowScheduler();

    expect(
      scheduler.plan({
        validated: wf,
        nodeRuns: [run("approval", "waiting_decision")],
      }).blocked,
    ).toEqual([
      { nodeId: "approval", iteration: 0, reason: "waiting_decision" },
    ]);
  });

  it("retries failed node runs within the configured attempt budget", () => {
    const wf = validated(
      [node("draft", { retryPolicy: { maxAttempts: 2 } })],
      [],
    );
    const scheduler = new WorkflowScheduler();

    expect(
      scheduler.plan({
        validated: wf,
        nodeRuns: [run("draft", "failed", { attempt: 0 })],
      }).ready,
    ).toEqual([
      {
        nodeId: "draft",
        iteration: 0,
        attempt: 1,
        reason: "retry",
      },
    ]);

    expect(
      scheduler.plan({
        validated: wf,
        nodeRuns: [run("draft", "failed", { attempt: 1 })],
      }).blocked,
    ).toEqual([
      { nodeId: "draft", iteration: 0, reason: "max_attempts_reached" },
    ]);
  });

  it("uses feedback edges to schedule another occurrence of the same node", () => {
    const wf = validated(
      [node("draft"), node("review", { kind: "gate" }), node("done")],
      [
        { from: "draft", to: "review", kind: "normal" },
        {
          from: "review",
          to: "draft",
          kind: "feedback",
          condition: "needs_changes",
          loopPolicy: {
            maxIterations: 2,
            stopCondition: "accepted",
            failureExitNodeId: "done",
          },
        },
        { from: "review", to: "done", kind: "conditional", condition: "accepted" },
      ],
    );
    const scheduler = new WorkflowScheduler();

    const plan = scheduler.plan({
      validated: wf,
      activeConditionIds: ["needs_changes"],
      nodeRuns: [
        run("draft", "succeeded"),
        run("review", "succeeded"),
      ],
    });

    expect(plan.ready).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "draft",
          iteration: 1,
          attempt: 0,
          reason: "feedback",
        }),
      ]),
    );
  });

  it("does not follow conditional or feedback edges unless their condition is active", () => {
    const wf = validated(
      [node("draft"), node("review", { kind: "gate" }), node("done")],
      [
        { from: "draft", to: "review", kind: "normal" },
        {
          from: "review",
          to: "draft",
          kind: "feedback",
          condition: "needs_changes",
          loopPolicy: {
            maxIterations: 2,
            stopCondition: "accepted",
            failureExitNodeId: "done",
          },
        },
        { from: "review", to: "done", kind: "conditional", condition: "accepted" },
      ],
    );
    const scheduler = new WorkflowScheduler();

    const plan = scheduler.plan({
      validated: wf,
      nodeRuns: [
        run("draft", "succeeded"),
        run("review", "succeeded"),
      ],
    });

    expect(plan.ready).toEqual([]);
  });

  it("does not follow feedback edges after their stop condition is active", () => {
    const wf = validated(
      [node("draft"), node("review", { kind: "gate" }), node("done")],
      [
        { from: "draft", to: "review", kind: "normal" },
        {
          from: "review",
          to: "draft",
          kind: "feedback",
          loopPolicy: {
            maxIterations: 2,
            stopCondition: "accepted",
            failureExitNodeId: "done",
          },
        },
        { from: "review", to: "done", kind: "conditional", condition: "accepted" },
      ],
    );
    const scheduler = new WorkflowScheduler();

    const plan = scheduler.plan({
      validated: wf,
      activeConditionIds: ["accepted"],
      nodeRuns: [
        run("draft", "succeeded"),
        run("review", "succeeded"),
      ],
    });

    expect(plan.ready).toEqual([
      {
        nodeId: "done",
        iteration: 0,
        attempt: 0,
        triggeredByEdgeId: "review->done:conditional:2",
        reason: "start",
      },
    ]);
  });

  it("routes feedback beyond the loop limit to the failure exit node", () => {
    const wf = validated(
      [node("draft"), node("review", { kind: "gate" }), node("done")],
      [
        { from: "draft", to: "review", kind: "normal" },
        {
          from: "review",
          to: "draft",
          kind: "feedback",
          condition: "needs_changes",
          loopPolicy: {
            maxIterations: 1,
            stopCondition: "accepted",
            failureExitNodeId: "done",
          },
        },
        { from: "review", to: "done", kind: "conditional", condition: "accepted" },
      ],
    );
    const scheduler = new WorkflowScheduler();

    const plan = scheduler.plan({
      validated: wf,
      activeConditionIds: ["needs_changes"],
      nodeRuns: [
        run("draft", "succeeded"),
        run("review", "succeeded"),
        run("draft", "succeeded", { iteration: 1 }),
        run("review", "succeeded", { iteration: 1 }),
      ],
    });

    expect(plan.ready).toEqual([
      {
        nodeId: "done",
        iteration: 1,
        attempt: 0,
        triggeredByEdgeId: "review->draft:feedback:1",
        reason: "loop_exit",
      },
    ]);
  });

  it("applies the global feedback limit as a scheduler hard cap", () => {
    const wf = validated(
      [node("draft"), node("review", { kind: "gate" }), node("done")],
      [
        { from: "draft", to: "review", kind: "normal" },
        {
          from: "review",
          to: "draft",
          kind: "feedback",
          condition: "needs_changes",
          loopPolicy: {
            maxIterations: 2,
            stopCondition: "accepted",
            failureExitNodeId: "done",
          },
        },
      ],
    );
    const capped: ValidatedWorkflowDefinition = {
      ...wf,
      definition: {
        ...wf.definition,
        policies: { feedback: { maxIterations: 1 } },
      },
    };
    const scheduler = new WorkflowScheduler();

    const plan = scheduler.plan({
      validated: capped,
      activeConditionIds: ["needs_changes"],
      nodeRuns: [
        run("draft", "succeeded"),
        run("review", "succeeded"),
        run("draft", "succeeded", { iteration: 1 }),
        run("review", "succeeded", { iteration: 1 }),
      ],
    });

    expect(plan.ready).toEqual([
      {
        nodeId: "done",
        iteration: 1,
        attempt: 0,
        triggeredByEdgeId: "review->draft:feedback:1",
        reason: "loop_exit",
      },
    ]);
  });

  it("scopes decision conditions to the node run iteration that produced them", () => {
    const wf = validated(
      [node("draft"), node("review", { kind: "gate" }), node("done")],
      [
        { from: "draft", to: "review", kind: "normal" },
        {
          from: "review",
          to: "draft",
          kind: "feedback",
          condition: "needs_changes",
          loopPolicy: {
            maxIterations: 2,
            stopCondition: "accepted",
            failureExitNodeId: "done",
          },
        },
        { from: "review", to: "done", kind: "conditional", condition: "accepted" },
      ],
    );
    const scheduler = new WorkflowScheduler();

    const plan = scheduler.plan({
      validated: wf,
      activeConditions: [
        { conditionId: "needs_changes", nodeId: "review", iteration: 0 },
        { conditionId: "accepted", nodeId: "review", iteration: 1 },
      ],
      nodeRuns: [
        run("draft", "succeeded", { iteration: 0 }),
        run("review", "succeeded", { iteration: 0 }),
        run("draft", "succeeded", { iteration: 1 }),
        run("review", "succeeded", { iteration: 1 }),
      ],
    });

    expect(plan.ready).toEqual([
      {
        nodeId: "done",
        iteration: 1,
        attempt: 0,
        triggeredByEdgeId: "review->done:conditional:2",
        reason: "start",
      },
    ]);
  });
});
