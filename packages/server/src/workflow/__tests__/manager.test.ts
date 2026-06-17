import { describe, expect, it } from "vitest";
import {
  DefaultNodeExecutorRegistry,
  DefinitionValidator,
  type NodeExecutor,
  type WorkflowDefinition,
  type WorkflowInstance,
  type WorkflowNode,
} from "@zhixing/core";
import {
  InMemoryWorkflowStore,
  WorkflowManager,
  type WorkflowIdFactory,
} from "../index.js";

function node(
  nodeId: string,
  executorId = nodeId,
  overrides: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    nodeId,
    kind: "agent",
    executor: { executorId },
    ...overrides,
  };
}

function definition(
  nodes: readonly WorkflowNode[],
  edges: WorkflowDefinition["edges"],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: "wf.test",
    name: "Test workflow",
    nodes,
    edges,
    ...overrides,
  };
}

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

function managerWith(
  executors: readonly NodeExecutor[],
  store = new InMemoryWorkflowStore(),
): WorkflowManager {
  const registry = new DefaultNodeExecutorRegistry();
  for (const executor of executors) registry.register(executor);
  return new WorkflowManager({
    store,
    executors: registry,
    validator: new DefinitionValidator({
      allowedExecutors: executors.map((executor) => executor.executorId),
    }),
    idFactory: idFactory(),
    clock: () => new Date("2026-06-17T00:00:00.000Z"),
  });
}

function outputExecutor(executorId: string): NodeExecutor {
  return {
    executorId,
    async run(ctx) {
      return {
        status: "succeeded",
        output: `${ctx.node.nodeId}:${ctx.nodeRun.iteration}:${ctx.nodeRun.attempt}`,
      };
    },
  };
}

async function start(
  manager: WorkflowManager,
  workflow: WorkflowDefinition,
): Promise<WorkflowInstance> {
  return manager.start({
    conversationId: "conv-1",
    goal: "ship it",
    input: { prompt: "go" },
    definition: workflow,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error(message);
}

describe("WorkflowManager", () => {
  it("creates an instance and drives a successful dependency chain", async () => {
    const manager = managerWith([
      outputExecutor("draft"),
      outputExecutor("review"),
    ]);

    const instance = await start(
      manager,
      definition(
        [node("draft"), node("review")],
        [{ from: "draft", to: "review", kind: "normal" }],
      ),
    );

    expect(instance.status).toBe("succeeded");
    expect(instance.definition.edges[0]?.edgeId).toBe("draft->review:normal:0");
    expect(instance.nodeRuns.map((run) => run.nodeId)).toEqual([
      "draft",
      "review",
    ]);
    expect(instance.nodeRuns.every((run) => run.status === "succeeded")).toBe(true);
    expect(instance.artifacts.map((artifact) => artifact.key)).toEqual([
      "output",
      "output",
    ]);
  });

  it("pauses on a decision and resumes from the resolved branch", async () => {
    const manager = managerWith([
      outputExecutor("draft"),
      {
        executorId: "review",
        async run() {
          return {
            status: "waiting_decision",
            decision: {
              question: "Accept?",
              options: [
                { optionId: "accepted", label: "Accept" },
                { optionId: "needs_changes", label: "Revise" },
              ],
              recommendedOptionId: "accepted",
            },
          };
        },
      },
      outputExecutor("done"),
    ]);

    const paused = await start(
      manager,
      definition(
        [
          node("draft"),
          node("review", "review", { kind: "gate" }),
          node("done"),
        ],
        [
          { from: "draft", to: "review", kind: "normal" },
          {
            from: "review",
            to: "done",
            kind: "conditional",
            condition: "accepted",
          },
        ],
      ),
    );

    expect(paused.status).toBe("waiting_decision");
    expect(paused.decisions).toHaveLength(1);
    expect(paused.nodeRuns.at(-1)?.status).toBe("waiting_decision");

    const resumed = await manager.decide({
      instanceId: paused.instanceId,
      decisionId: paused.decisions[0]!.decisionId,
      resultOptionId: "accepted",
      actor: "human",
      rationale: "Good enough",
    });

    expect(resumed.status).toBe("succeeded");
    expect(resumed.decisions[0]).toMatchObject({
      resultOptionId: "accepted",
      actor: "human",
      rationale: "Good enough",
    });
    expect(
      resumed.artifacts.find((artifact) => artifact.key === "decision")?.value,
    ).toEqual({
      optionId: "accepted",
      actor: "human",
      question: "Accept?",
      options: [
        { optionId: "accepted", label: "Accept" },
        { optionId: "needs_changes", label: "Revise" },
      ],
      recommendedOptionId: "accepted",
      resolutionRationale: "Good enough",
      resolvedAt: "2026-06-17T00:00:00.000Z",
    });
    expect(resumed.nodeRuns.map((run) => `${run.nodeId}:${run.status}`)).toEqual([
      "draft:succeeded",
      "review:succeeded",
      "done:succeeded",
    ]);
  });

  it("retries a failed node within its retry policy", async () => {
    let calls = 0;
    const manager = managerWith([
      {
        executorId: "flaky",
        async run() {
          calls += 1;
          if (calls === 1) {
            return {
              status: "failed",
              error: { code: "boom", message: "try again", recoverable: true },
            };
          }
          return { status: "succeeded", output: "ok" };
        },
      },
    ]);

    const instance = await start(
      manager,
      definition([
        node("work", "flaky", { retryPolicy: { maxAttempts: 2 } }),
      ], []),
    );

    expect(instance.status).toBe("succeeded");
    expect(instance.nodeRuns.map((run) => run.attempt)).toEqual([0, 1]);
    expect(instance.nodeRuns.map((run) => run.status)).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  it("recovers interrupted running node runs from the store and retries them", async () => {
    const store = new InMemoryWorkflowStore();
    const manager = managerWith([outputExecutor("work")], store);
    const workflow = definition([
      node("work", "work", { retryPolicy: { maxAttempts: 2 } }),
    ], []);
    const validated = new DefinitionValidator({
      allowedExecutors: ["work"],
    }).validate(workflow);

    await store.create({
      instanceId: "wf-recover",
      conversationId: "conv-1",
      goal: "recover",
      input: {},
      definition: validated.definition,
      definitionId: validated.definition.id,
      status: "running",
      nodeRuns: [
        {
          nodeRunId: "run-interrupted",
          nodeId: "work",
          iteration: 0,
          attempt: 0,
          status: "running",
        },
      ],
      decisions: [],
      artifacts: [],
      errors: [],
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
    });

    const recovered = await manager.recoverUnfinished();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe("succeeded");
    expect(recovered[0]!.nodeRuns.map((run) => run.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(recovered[0]!.nodeRuns[1]!.attempt).toBe(1);
  });

  it("scopes decision conditions during feedback loops", async () => {
    const manager = managerWith([
      outputExecutor("draft"),
      {
        executorId: "review",
        async run() {
          return {
            status: "waiting_decision",
            decision: {
              question: "Review result?",
              options: [
                { optionId: "needs_changes", label: "Needs changes" },
                { optionId: "accepted", label: "Accepted" },
              ],
            },
          };
        },
      },
      outputExecutor("done"),
    ]);

    const paused0 = await start(
      manager,
      definition(
        [
          node("draft"),
          node("review", "review", { kind: "gate" }),
          node("done"),
        ],
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
          {
            from: "review",
            to: "done",
            kind: "conditional",
            condition: "accepted",
          },
        ],
      ),
    );

    const paused1 = await manager.decide({
      instanceId: paused0.instanceId,
      decisionId: paused0.decisions[0]!.decisionId,
      resultOptionId: "needs_changes",
      actor: "human",
    });
    expect(paused1.status).toBe("waiting_decision");
    expect(
      paused1.nodeRuns.filter((run) => run.nodeId === "draft").map((run) => run.iteration),
    ).toEqual([0, 1]);

    const done = await manager.decide({
      instanceId: paused1.instanceId,
      decisionId: paused1.decisions[1]!.decisionId,
      resultOptionId: "accepted",
      actor: "human",
    });

    expect(done.status).toBe("succeeded");
    expect(
      done.nodeRuns.filter((run) => run.nodeId === "done").map((run) => run.iteration),
    ).toEqual([1]);
  });

  it("resolves initial node inputs during feedback iterations", async () => {
    const draftInputs: unknown[] = [];
    const manager = managerWith([
      {
        executorId: "plan",
        async run() {
          return {
            status: "waiting_decision",
            decision: {
              question: "Approve plan?",
              options: [
                { optionId: "plan_approved", label: "Approve plan" },
                { optionId: "plan_blocked", label: "Block plan" },
              ],
            },
          };
        },
      },
      {
        executorId: "draft",
        async run(ctx) {
          draftInputs.push(ctx.input);
          return { status: "succeeded", output: `draft-${ctx.nodeRun.iteration}` };
        },
      },
      {
        executorId: "review",
        async run() {
          return {
            status: "waiting_decision",
            decision: {
              question: "Review result?",
              options: [
                { optionId: "needs_changes", label: "Needs changes" },
                { optionId: "accepted", label: "Accepted" },
              ],
            },
          };
        },
      },
      outputExecutor("done"),
    ]);

    const directionPaused = await start(
      manager,
      definition(
        [
          node("plan", "plan"),
          node("draft", "draft", {
            inputFrom: [
              {
                kind: "node",
                nodeId: "plan",
                artifactKey: "decision",
                iteration: "initial",
              },
              {
                kind: "node",
                nodeId: "review",
                artifactKey: "decision",
                iteration: "previous",
                optional: true,
              },
            ],
          }),
          node("review", "review", { kind: "gate" }),
          node("done", "done"),
        ],
        [
          {
            from: "plan",
            to: "draft",
            kind: "conditional",
            condition: "plan_approved",
          },
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
          {
            from: "review",
            to: "done",
            kind: "conditional",
            condition: "accepted",
          },
        ],
      ),
    );

    const paused0 = await manager.decide({
      instanceId: directionPaused.instanceId,
      decisionId: directionPaused.decisions[0]!.decisionId,
      resultOptionId: "plan_approved",
      actor: "human",
    });
    const reviewDecision0 = paused0.decisions.find(
      (decision) => !decision.resolvedAt,
    );

    const paused1 = await manager.decide({
      instanceId: paused0.instanceId,
      decisionId: reviewDecision0!.decisionId,
      resultOptionId: "needs_changes",
      actor: "human",
    });

    expect(paused1.status).toBe("waiting_decision");
    expect(draftInputs).toHaveLength(2);
    expect(draftInputs[1]).toMatchObject({
      nodes: {
        plan: { optionId: "plan_approved" },
        review: { optionId: "needs_changes" },
      },
    });
  });

  it("cancels active waiting decisions without resolving them", async () => {
    const manager = managerWith([
      {
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
      },
    ]);

    const paused = await start(
      manager,
      definition([node("gate", "gate", { kind: "gate" })], []),
    );

    await manager.cancel(paused.instanceId, "user canceled");
    const canceled = await manager.get(paused.instanceId);

    expect(canceled?.status).toBe("canceled");
    expect(canceled?.nodeRuns[0]?.status).toBe("canceled");
    expect(canceled?.decisions[0]?.resolvedAt).toBeUndefined();
  });

  it("executes independent ready node runs concurrently within the concurrency policy", async () => {
    const started: string[] = [];
    let releaseAll!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    let markBothStarted!: (value: boolean) => void;
    const bothStarted = new Promise<boolean>((resolve) => {
      markBothStarted = resolve;
    });
    const blockingExecutor = (executorId: string): NodeExecutor => ({
      executorId,
      async run() {
        started.push(executorId);
        if (started.length === 2) markBothStarted(true);
        await release;
        return { status: "succeeded", output: executorId };
      },
    });
    const manager = managerWith([
      blockingExecutor("left"),
      blockingExecutor("right"),
    ]);

    const instancePromise = start(
      manager,
      definition(
        [node("left"), node("right")],
        [],
        { policies: { concurrency: { maxParallelNodes: 2 } } },
      ),
    );

    const concurrent = await Promise.race([
      bothStarted,
      sleep(100).then(() => false),
    ]);
    releaseAll();
    const instance = await instancePromise;

    expect(concurrent).toBe(true);
    expect(started).toEqual(["left", "right"]);
    expect(instance.status).toBe("succeeded");
  });

  it("aborts running node runs and ignores late executor success after cancellation", async () => {
    let releaseExecutor!: () => void;
    let signal: AbortSignal | undefined;
    const manager = managerWith([
      {
        executorId: "slow",
        async run(ctx) {
          signal = ctx.signal;
          await new Promise<void>((resolve) => {
            releaseExecutor = resolve;
          });
          return { status: "succeeded", output: "late-success" };
        },
      },
    ]);

    const instancePromise = start(manager, definition([node("slow")], []));
    await waitUntil(
      () => signal !== undefined,
      "Expected slow executor to receive an abort signal",
    );
    const running = (await manager.listByConversation("conv-1"))[0];
    expect(running?.status).toBe("running");
    expect(signal?.aborted).toBe(false);

    await manager.cancel(running!.instanceId, "user canceled");

    expect(signal?.aborted).toBe(true);
    releaseExecutor();
    const returned = await instancePromise;
    const canceled = await manager.get(running!.instanceId);

    expect(returned.status).toBe("canceled");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.nodeRuns[0]?.status).toBe("canceled");
    expect(canceled?.nodeRuns[0]?.outputArtifactRefs).toBeUndefined();
    expect(canceled?.artifacts).toHaveLength(0);
  });
});
