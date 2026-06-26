import { describe, expect, it } from "vitest";
import {
  createEventBus,
  emptyUsage,
  loadOrchestrationDefinitionV1,
  type AgentEventMap,
  type EventMeta,
  type NormalizedOrchestrationNodeV1,
  type OrchestrationContextSnapshotV1,
  type OrchestrationDefinitionV1,
  type OrchestrationExecutableV1,
  type OrchestrationNodeOutputV1,
  type OrchestrationNodeRunResultV1,
  type OrchestrationSystemCapsV1,
} from "@zhixing/core";
import { OrchestrationRunnerV1 } from "../runner.js";
import type {
  AgentNodeExecutorV1,
  OrchestrationNodeExecutionContextV1,
} from "../types.js";

const caps: OrchestrationSystemCapsV1 = {
  maxNodes: 10,
  maxParallel: 4,
  maxRunMs: 10_000,
  maxNodeTimeoutMs: 2_000,
  maxNodeTurns: 8,
  maxNodeTokens: 1_000,
  maxContextSnapshotTokens: 1_000,
  maxInstructionChars: 500,
  maxInputChars: 500,
  maxOutputChars: 500,
  allowedNodeKinds: ["agent"],
  allowedTools: ["read", "grep"],
};

describe("OrchestrationRunnerV1", () => {
  it("runs independent nodes concurrently within maxParallel", async () => {
    let active = 0;
    let maxActive = 0;
    const executor = executorFrom(async (node) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      active -= 1;
      return completed(node.id, textOutput(node.id, `${node.id}-done`));
    });

    const result = await createRunner(executor).run({
      executable: loadDefinition(
        createDefinition({
          policy: createPolicy({ maxParallel: 2 }),
          nodes: [
            createNode("alpha"),
            createNode("beta"),
          ],
        }),
      ),
    });

    expect(result.status).toBe("completed");
    expect(maxActive).toBe(2);
    expect(Object.keys(result.outputs).sort()).toEqual(["alpha", "beta"]);
  });

  it("serializes ready roots when maxParallel is one", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const executor = executorFrom(async (node) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${node.id}`);
      await sleep(5);
      order.push(`end:${node.id}`);
      active -= 1;
      return completed(node.id, textOutput(node.id, `${node.id}-done`));
    });

    const result = await createRunner(executor).run({
      executable: loadDefinition(
        createDefinition({
          policy: createPolicy({ maxParallel: 1 }),
          nodes: [
            createNode("first"),
            createNode("second"),
          ],
        }),
      ),
    });

    expect(result.status).toBe("completed");
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("waits for dependencies and passes dependency outputs to dependents", async () => {
    const seenContexts = new Map<string, OrchestrationNodeExecutionContextV1>();
    const executor = executorFrom(async (node, context) => {
      seenContexts.set(node.id, context);
      return completed(node.id, textOutput(node.id, `${node.id}-done`));
    });

    const result = await createRunner(executor).run({
      executable: loadDefinition(
        createDefinition({
          nodes: [
            createNode("research"),
            createNode("summary", { dependsOn: ["research"] }),
          ],
        }),
      ),
    });

    expect(result.status).toBe("completed");
    expect(seenContexts.get("summary")?.dependencyOutputs).toEqual({
      research: textOutput("research", "research-done"),
    });
  });

  it("passes the same context snapshot instance to parallel nodes that request it", async () => {
    const snapshot = createSnapshot();
    const seenSnapshots: OrchestrationContextSnapshotV1[] = [];
    const executor = executorFrom(async (node, context) => {
      if (context.contextSnapshot) seenSnapshots.push(context.contextSnapshot);
      await sleep(5);
      return completed(node.id, textOutput(node.id, `${node.id}-done`));
    });

    const result = await createRunner(executor).run({
      executable: loadDefinition(
        createDefinition({
          policy: createPolicy({
            maxParallel: 2,
            contextSnapshot: { strategy: "tail", maxTokens: 100 },
          }),
          nodes: [
            createNode("left", {
              context: {
                includeRunInput: false,
                includeContextSnapshot: true,
                includeNodeOutputs: "dependencies",
              },
            }),
            createNode("right", {
              context: {
                includeRunInput: false,
                includeContextSnapshot: true,
                includeNodeOutputs: "dependencies",
              },
            }),
          ],
        }),
      ),
      contextSnapshot: snapshot,
    });

    expect(result.status).toBe("completed");
    expect(seenSnapshots).toEqual([snapshot, snapshot]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("fail-fast aborts running nodes and skips pending dependents without aborting the parent signal", async () => {
    const parent = new AbortController();
    const executor = executorFrom(async (node, context) => {
      if (node.id === "failed") {
        return failed(node.id, "boom");
      }
      if (node.id === "slow") {
        await waitForAbort(context.abortSignal);
        return aborted(node.id, "slow node observed abort");
      }
      return completed(node.id, textOutput(node.id, `${node.id}-done`));
    });

    const result = await createRunner(executor).run({
      executable: loadDefinition(
        createDefinition({
          policy: createPolicy({ maxParallel: 2 }),
          nodes: [
            createNode("failed"),
            createNode("slow"),
            createNode("dependent", { dependsOn: ["failed"] }),
          ],
        }),
      ),
      abortSignal: parent.signal,
    });

    expect(result.status).toBe("failed");
    expect(result.nodeResults["failed"]?.status).toBe("failed");
    expect(result.nodeResults["slow"]?.status).toBe("aborted");
    expect(result.nodeResults["dependent"]?.status).toBe("skipped");
    expect(parent.signal.aborted).toBe(false);
  });

  it("propagates parent abort into running nodes and returns an aborted run", async () => {
    const parent = new AbortController();
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    bus.on("orchestration:node_start", () => parent.abort());
    const executor = executorFrom(async (node, context) => {
      await waitForAbort(context.abortSignal);
      return aborted(node.id, "parent cancelled");
    });

    const result = await createRunner(executor, bus).run({
      executable: loadDefinition(createDefinition({ nodes: [createNode("slow")] })),
      abortSignal: parent.signal,
    });

    expect(result.status).toBe("aborted");
    expect(result.errors.run?.type).toBe("parent_abort");
    expect(result.nodeResults["slow"]?.status).toBe("aborted");
  });

  it("fails a completed node when JSON output violates its schema", async () => {
    const executor = executorFrom(async (node) =>
      completed(node.id, jsonOutput(node.id, { wrong: true })),
    );

    const result = await createRunner(executor).run({
      executable: loadDefinition(
        createDefinition({
          nodes: [
            createNode("json-node", {
              output: {
                required: true,
                format: "json",
                schema: {
                  type: "object",
                  required: ["ok"],
                  properties: { ok: { type: "boolean" } },
                  additionalProperties: false,
                },
              },
            }),
          ],
        }),
      ),
    });

    expect(result.status).toBe("failed");
    expect(result.nodeResults["json-node"]?.status).toBe("failed");
    expect(result.errors.nodes["json-node"]?.type).toBe("output_contract_failed");
    expect(result.outputs["json-node"]).toBeUndefined();
  });

  it("converts synchronous executor throws into structured node failure", async () => {
    const executor: AgentNodeExecutorV1 = {
      runAgentNode: () => {
        throw new Error("sync boom");
      },
    };

    const result = await createRunner(executor).run({
      executable: loadDefinition(createDefinition({ nodes: [createNode("throws")] })),
    });

    expect(result.status).toBe("failed");
    expect(result.nodeResults["throws"]?.status).toBe("failed");
    expect(result.errors.nodes["throws"]?.type).toBe("node_executor_error");
    expect(result.errors.nodes["throws"]?.message).toBe("sync boom");
  });

  it("emits orchestration events through AgentEventMap with run lineage", async () => {
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    const events: Array<{ name: string; lineage: string | undefined }> = [];
    bus.onAny((name, _payload, meta?: EventMeta) => {
      if (name.startsWith("orchestration:")) {
        events.push({ name, lineage: meta?.lineage });
      }
    });
    const executor = executorFrom(async (node) =>
      completed(node.id, textOutput(node.id, "done")),
    );

    const result = await createRunner(executor, bus).run({
      executable: loadDefinition(createDefinition({ nodes: [createNode("only")] })),
    });

    expect(result.status).toBe("completed");
    expect(events.map((event) => event.name)).toEqual([
      "orchestration:run_start",
      "orchestration:node_start",
      "orchestration:node_end",
      "orchestration:run_end",
    ]);
    expect(events.every((event) => event.lineage === "main/orch-run-test")).toBe(true);
  });

  it("rejects missing required snapshots before executing nodes", async () => {
    let calls = 0;
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    const events: Array<{ name: string; runId?: string }> = [];
    bus.onAny((name, payload) => {
      if (name.startsWith("orchestration:")) {
        events.push({
          name,
          runId: "runId" in payload ? payload.runId : undefined,
        });
      }
    });
    const executor = executorFrom(async (node) => {
      calls += 1;
      return completed(node.id, textOutput(node.id, "unreachable"));
    });

    const result = await createRunner(executor, bus).run({
      executable: loadDefinition(
        createDefinition({
          policy: createPolicy({
            contextSnapshot: { strategy: "full_or_fail", maxTokens: 100 },
          }),
          nodes: [
            createNode("needs-snapshot", {
              context: {
                includeRunInput: false,
                includeContextSnapshot: true,
                includeNodeOutputs: "dependencies",
              },
            }),
          ],
        }),
      ),
    });

    expect(result.status).toBe("failed");
    expect(result.errors.run?.type).toBe("validation_failed");
    expect(calls).toBe(0);
    expect(events).toEqual([
      { name: "orchestration:validation_failed", runId: "run-test" },
    ]);
  });
});

function createRunner(
  nodeExecutor: AgentNodeExecutorV1,
  bus = createEventBus<AgentEventMap>({ lineage: "main" }),
): OrchestrationRunnerV1 {
  return new OrchestrationRunnerV1({
    bus,
    nodeExecutor,
    createRunId: () => "run-test",
  });
}

function executorFrom(
  run: (
    node: NormalizedOrchestrationNodeV1,
    context: OrchestrationNodeExecutionContextV1,
  ) => Promise<OrchestrationNodeRunResultV1>,
): AgentNodeExecutorV1 {
  return {
    runAgentNode: run,
  };
}

function loadDefinition(definition: OrchestrationDefinitionV1): OrchestrationExecutableV1 {
  const result = loadOrchestrationDefinitionV1(definition, caps);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.executable;
}

function createDefinition(
  overrides: Partial<OrchestrationDefinitionV1> & {
    readonly nodes?: OrchestrationDefinitionV1["nodes"];
  } = {},
): OrchestrationDefinitionV1 {
  return {
    version: 1,
    id: "runner-test",
    title: "Runner test",
    policy: createPolicy(),
    input: { required: false, format: "text", maxChars: 100 },
    nodes: [createNode("default")],
    ...overrides,
  };
}

function createPolicy(
  overrides: Partial<OrchestrationDefinitionV1["policy"]> = {},
): OrchestrationDefinitionV1["policy"] {
  return {
    maxParallel: 2,
    maxRunMs: 1_000,
    defaultNodeTimeoutMs: 500,
    defaultMaxTurns: 4,
    defaultMaxTokens: 500,
    allowedTools: [],
    failureMode: "fail_fast",
    ...overrides,
  };
}

function createNode(
  id: string,
  overrides: Partial<OrchestrationDefinitionV1["nodes"][number]> = {},
): OrchestrationDefinitionV1["nodes"][number] {
  return {
    id,
    kind: "agent",
    dependsOn: [],
    instruction: `Run ${id}`,
    context: {
      includeRunInput: false,
      includeContextSnapshot: false,
      includeNodeOutputs: "dependencies",
    },
    output: { required: true, format: "text", maxChars: 100 },
    policy: { timeoutMs: 500, maxTurns: 4, maxTokens: 500, tools: [] },
    ...overrides,
  };
}

function completed(
  nodeId: string,
  output: OrchestrationNodeOutputV1,
): OrchestrationNodeRunResultV1 {
  return {
    nodeId,
    status: "completed",
    output,
    usage: emptyUsage(),
    durationMs: 1,
  };
}

function failed(nodeId: string, message: string): OrchestrationNodeRunResultV1 {
  return {
    nodeId,
    status: "failed",
    error: { type: "test_failure", message, origin: "node", nodeId },
    durationMs: 1,
  };
}

function aborted(nodeId: string, message: string): OrchestrationNodeRunResultV1 {
  return {
    nodeId,
    status: "aborted",
    error: { type: "test_abort", message, origin: "abort", nodeId },
    durationMs: 1,
  };
}

function textOutput(nodeId: string, content: string): OrchestrationNodeOutputV1 {
  return { nodeId, format: "text", content };
}

function jsonOutput(nodeId: string, value: unknown): OrchestrationNodeOutputV1 {
  return { nodeId, format: "json", content: JSON.stringify(value) };
}

function createSnapshot(): OrchestrationContextSnapshotV1 {
  return deepFreeze({
    source: "attention_window",
    strategy: "tail",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "shared context" }],
      },
    ],
    estimatedTokens: 3,
    capturedAt: "2026-06-26T00:00:00.000Z",
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
