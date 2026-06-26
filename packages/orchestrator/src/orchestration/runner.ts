import { randomUUID } from "node:crypto";
import {
  createEventBus,
  emptyUsage,
  mergeUsage,
  type AgentEventMap,
  type EventBus,
  type NormalizedOrchestrationNodeV1,
  type OrchestrationContextSnapshotV1,
  type OrchestrationErrorV1,
  type OrchestrationExecutableV1,
  type OrchestrationNodeOutputV1,
  type OrchestrationNodeRunResultV1,
  type OrchestrationRunResultV1,
  type OrchestrationValidationIssueV1,
  type TokenUsage,
} from "@zhixing/core";
import {
  validateNodeOutputV1,
  validateRunInputV1,
} from "./contracts.js";
import type {
  AgentNodeExecutorV1,
  OrchestrationRunnerOptionsV1,
  RunOrchestrationOptionsV1,
} from "./types.js";

type NodeRuntimeStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "skipped";

interface RunningNode {
  readonly nodeId: string;
  readonly controller: AbortController;
  readonly promise: Promise<OrchestrationNodeRunResultV1>;
}

interface RunnerClock {
  readonly now: () => number;
  readonly createRunId: () => string;
}

export class OrchestrationRunnerV1 {
  private readonly bus: EventBus<AgentEventMap>;
  private readonly nodeExecutor: AgentNodeExecutorV1;
  private readonly parentLineage?: string;
  private readonly clock: RunnerClock;

  constructor(options: OrchestrationRunnerOptionsV1) {
    this.bus = options.bus;
    this.nodeExecutor = options.nodeExecutor;
    this.parentLineage = options.parentLineage;
    this.clock = {
      now: options.now ?? (() => Date.now()),
      createRunId: options.createRunId ?? (() => randomUUID()),
    };
  }

  async run(options: RunOrchestrationOptionsV1): Promise<OrchestrationRunResultV1> {
    const runId = this.clock.createRunId();
    const startedAt = this.clock.now();
    const runtime = createRuntime(options.executable);
    const runBus = createEventBus<AgentEventMap>({
      parent: this.bus,
      lineage: this.deriveRunLineage(runId),
    });

    const validationIssues = validateRunStart(options);
    if (validationIssues.length > 0) {
      await runBus.emit("orchestration:validation_failed", {
        runId,
        definitionId: options.executable.definition.id,
        issues: validationIssues,
      });
      return buildRunResult({
        runId,
        executable: options.executable,
        status: "failed",
        startedAt,
        endedAt: this.clock.now(),
        runtime,
        runError: {
          type: "validation_failed",
          message: validationIssues.map((issue) => issue.message).join("; "),
          origin: "validation",
        },
      });
    }

    const runController = new AbortController();
    let parentAborted = Boolean(options.abortSignal?.aborted);
    let runTimedOut = false;
    const onParentAbort = (): void => {
      parentAborted = true;
      runController.abort();
    };
    options.abortSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (parentAborted) runController.abort();

    const runTimer = setTimeout(() => {
      runTimedOut = true;
      runController.abort();
    }, options.executable.definition.policy.maxRunMs);

    await runBus.emit("orchestration:run_start", {
      runId,
      definitionId: options.executable.definition.id,
      nodeCount: options.executable.definition.nodeIds.length,
      maxParallel: options.executable.definition.policy.maxParallel,
    });

    try {
      const runStatus = await this.runSchedule({
        runId,
        executable: options.executable,
        runInput: options.runInput,
        contextSnapshot: options.contextSnapshot,
        runController,
        getParentAborted: () => parentAborted,
        getRunTimedOut: () => runTimedOut,
        runBus,
        runtime,
      });

      const runError =
        runStatus === "aborted"
          ? { type: "parent_abort", message: "parent run aborted orchestration.", origin: "abort" as const }
          : runStatus === "failed" && runTimedOut
            ? { type: "run_timeout", message: "orchestration run exceeded maxRunMs.", origin: "system" as const }
            : firstNodeError(runtime.nodeResults);
      const result = buildRunResult({
        runId,
        executable: options.executable,
        status: runStatus,
        startedAt,
        endedAt: this.clock.now(),
        runtime,
        runError,
      });

      await runBus.emit("orchestration:run_end", {
        runId,
        definitionId: options.executable.definition.id,
        status: result.status,
        durationMs: result.durationMs,
        usage: result.usage,
        error: result.errors.run?.message,
        errorType: result.errors.run?.type,
      });

      return result;
    } finally {
      clearTimeout(runTimer);
      options.abortSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  private async runSchedule(args: {
    readonly runId: string;
    readonly executable: OrchestrationExecutableV1;
    readonly runInput?: unknown;
    readonly contextSnapshot?: OrchestrationContextSnapshotV1;
    readonly runController: AbortController;
    readonly getParentAborted: () => boolean;
    readonly getRunTimedOut: () => boolean;
    readonly runBus: EventBus<AgentEventMap>;
    readonly runtime: RuntimeState;
  }): Promise<"completed" | "failed" | "aborted"> {
    const running = new Map<string, RunningNode>();
    const { definition } = args.executable;

    while (true) {
      if (args.getParentAborted()) {
        args.runController.abort();
        abortRunning(running);
        await markPendingSkipped(args.runBus, args.executable, args.runId, args.runtime, definition.nodeIds);
        await drainRunning(running, args.runBus, args.executable, args.runId, args.runtime);
        return "aborted";
      }
      if (args.getRunTimedOut()) {
        args.runController.abort();
        abortRunning(running);
        await markPendingSkipped(args.runBus, args.executable, args.runId, args.runtime, definition.nodeIds);
        await drainRunning(running, args.runBus, args.executable, args.runId, args.runtime);
        return "failed";
      }

      this.startReadyNodes({
        ...args,
        running,
      });

      if (allNodesSettled(args.runtime, definition.nodeIds)) {
        return hasFailedNode(args.runtime) ? "failed" : "completed";
      }

      if (running.size === 0) {
        await markPendingSkipped(args.runBus, args.executable, args.runId, args.runtime, definition.nodeIds);
        return "failed";
      }

      const settled = await Promise.race([...running.values()].map((item) => item.promise));
      running.delete(settled.nodeId);
      await applyNodeResult(args.runBus, args.executable, args.runId, args.runtime, settled);

      if (settled.status !== "completed" && definition.policy.failureMode === "fail_fast") {
        abortRunning(running);
        await markPendingSkipped(args.runBus, args.executable, args.runId, args.runtime, definition.nodeIds);
        await drainRunning(running, args.runBus, args.executable, args.runId, args.runtime);
        return args.getParentAborted() ? "aborted" : "failed";
      }
    }
  }

  private startReadyNodes(args: {
    readonly runId: string;
    readonly executable: OrchestrationExecutableV1;
    readonly runInput?: unknown;
    readonly contextSnapshot?: OrchestrationContextSnapshotV1;
    readonly runController: AbortController;
    readonly getParentAborted: () => boolean;
    readonly getRunTimedOut: () => boolean;
    readonly runBus: EventBus<AgentEventMap>;
    readonly runtime: RuntimeState;
    readonly running: Map<string, RunningNode>;
  }): void {
    const { definition, plan } = args.executable;
    const availableSlots = definition.policy.maxParallel - args.running.size;
    if (availableSlots <= 0) return;

    const ready = plan.topologicalOrder.filter((nodeId) => {
      if (args.runtime.statusByNodeId[nodeId] !== "pending") return false;
      return (plan.dependencies[nodeId] ?? []).every(
        (dependency) => args.runtime.statusByNodeId[dependency] === "completed",
      );
    });

    for (const nodeId of ready.slice(0, availableSlots)) {
      const node = definition.nodesById[nodeId]!;
      const controller = new AbortController();
      args.runtime.statusByNodeId[nodeId] = "running";
      const promise = this.runNode({
        ...args,
        node,
        controller,
      });
      args.running.set(nodeId, { nodeId, controller, promise });
    }
  }

  private async runNode(args: {
    readonly runId: string;
    readonly executable: OrchestrationExecutableV1;
    readonly runInput?: unknown;
    readonly contextSnapshot?: OrchestrationContextSnapshotV1;
    readonly runController: AbortController;
    readonly getParentAborted: () => boolean;
    readonly getRunTimedOut: () => boolean;
    readonly runBus: EventBus<AgentEventMap>;
    readonly runtime: RuntimeState;
    readonly node: NormalizedOrchestrationNodeV1;
    readonly controller: AbortController;
  }): Promise<OrchestrationNodeRunResultV1> {
    const startedAt = this.clock.now();
    const signal = AbortSignal.any([
      args.runController.signal,
      args.controller.signal,
    ]);
    let nodeTimedOut = false;
    const timer = setTimeout(() => {
      nodeTimedOut = true;
      args.controller.abort();
    }, args.node.policy.timeoutMs);

    await args.runBus.emit("orchestration:node_start", {
      runId: args.runId,
      definitionId: args.executable.definition.id,
      nodeId: args.node.id,
      nodeKind: args.node.kind,
    });

    const executorPromise = runExecutorSafely({
      node: args.node,
      startedAt,
      now: this.clock.now,
      run: () =>
        this.nodeExecutor.runAgentNode(args.node, {
        runId: args.runId,
        definitionId: args.executable.definition.id,
        runInput: args.node.context.includeRunInput ? args.runInput : undefined,
        contextSnapshot: args.node.context.includeContextSnapshot
          ? args.contextSnapshot
          : undefined,
        dependencyOutputs: selectDependencyOutputs(args),
        abortSignal: signal,
        bus: args.runBus,
        lineage: `${this.deriveRunLineage(args.runId)}/node-${args.node.id}`,
      }),
    });

    try {
      return await Promise.race([
        executorPromise,
        new Promise<OrchestrationNodeRunResultV1>((resolve) => {
          if (signal.aborted) {
            resolve(
              buildAbortedNodeResult(args.node.id, this.clock.now() - startedAt, {
                nodeTimedOut,
                runTimedOut: args.getRunTimedOut(),
                parentAborted: args.getParentAborted(),
              }),
            );
            return;
          }
          signal.addEventListener(
            "abort",
            () =>
              resolve(
                buildAbortedNodeResult(args.node.id, this.clock.now() - startedAt, {
                  nodeTimedOut,
                  runTimedOut: args.getRunTimedOut(),
                  parentAborted: args.getParentAborted(),
                }),
              ),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private deriveRunLineage(runId: string): string {
    const parentLineage = this.parentLineage ?? this.bus.lineage;
    return parentLineage ? `${parentLineage}/orch-${runId}` : `orch-${runId}`;
  }
}

async function runExecutorSafely(args: {
  readonly node: NormalizedOrchestrationNodeV1;
  readonly startedAt: number;
  readonly now: () => number;
  readonly run: () => Promise<OrchestrationNodeRunResultV1>;
}): Promise<OrchestrationNodeRunResultV1> {
  try {
    return await args.run();
  } catch (error) {
    return {
      nodeId: args.node.id,
      status: "failed",
      error: {
        type: "node_executor_error",
        message: error instanceof Error ? error.message : String(error),
        origin: "node",
        nodeId: args.node.id,
      },
      durationMs: args.now() - args.startedAt,
    };
  }
}

interface RuntimeState {
  readonly statusByNodeId: Record<string, NodeRuntimeStatus>;
  readonly nodeResults: Record<string, OrchestrationNodeRunResultV1>;
  readonly outputs: Record<string, OrchestrationNodeOutputV1>;
}

function createRuntime(executable: OrchestrationExecutableV1): RuntimeState {
  const statusByNodeId: Record<string, NodeRuntimeStatus> = {};
  for (const nodeId of executable.definition.nodeIds) {
    statusByNodeId[nodeId] = "pending";
  }
  return { statusByNodeId, nodeResults: {}, outputs: {} };
}

function validateRunStart(
  options: RunOrchestrationOptionsV1,
): readonly OrchestrationValidationIssueV1[] {
  const issues = [
    ...validateRunInputV1(options.executable.definition.input, options.runInput),
    ...validateSnapshot(options.executable, options.contextSnapshot),
  ];
  return issues;
}

function validateSnapshot(
  executable: OrchestrationExecutableV1,
  snapshot: OrchestrationContextSnapshotV1 | undefined,
): readonly OrchestrationValidationIssueV1[] {
  const requiresSnapshot = executable.definition.nodeIds.some(
    (nodeId) => executable.definition.nodesById[nodeId]!.context.includeContextSnapshot,
  );
  if (!requiresSnapshot) return [];

  const policy = executable.definition.policy.contextSnapshot;
  if (!snapshot) {
    return [
      {
        path: "$.contextSnapshot",
        code: "missing_required",
        message: "context snapshot is required by at least one node.",
      },
    ];
  }
  if (!policy) {
    return [
      {
        path: "$.policy.contextSnapshot",
        code: "missing_context_snapshot_policy",
        message: "context snapshot policy is required.",
      },
    ];
  }
  const issues: OrchestrationValidationIssueV1[] = [];
  if (snapshot.source !== "attention_window") {
    issues.push({
      path: "$.contextSnapshot.source",
      code: "invalid_literal",
      message: "context snapshot source must be attention_window.",
    });
  }
  if (snapshot.strategy !== policy.strategy) {
    issues.push({
      path: "$.contextSnapshot.strategy",
      code: "invalid_literal",
      message: "context snapshot strategy does not match definition policy.",
    });
  }
  if (snapshot.estimatedTokens > policy.maxTokens) {
    issues.push({
      path: "$.contextSnapshot.estimatedTokens",
      code: "too_large",
      message: "context snapshot exceeds definition snapshot token budget.",
    });
  }
  if (snapshot.estimatedTokens > executable.caps.maxContextSnapshotTokens) {
    issues.push({
      path: "$.contextSnapshot.estimatedTokens",
      code: "too_large",
      message: "context snapshot exceeds system snapshot token budget.",
    });
  }
  return issues;
}

function selectDependencyOutputs(args: {
  readonly node: NormalizedOrchestrationNodeV1;
  readonly runtime: RuntimeState;
}): Readonly<Record<string, OrchestrationNodeOutputV1>> {
  const requested =
    args.node.context.includeNodeOutputs === "dependencies"
      ? args.node.dependsOn
      : args.node.context.includeNodeOutputs;
  const outputs: Record<string, OrchestrationNodeOutputV1> = {};
  for (const nodeId of requested) {
    const output = args.runtime.outputs[nodeId];
    if (output) outputs[nodeId] = output;
  }
  return outputs;
}

function buildAbortedNodeResult(
  nodeId: string,
  durationMs: number,
  flags: {
    readonly nodeTimedOut: boolean;
    readonly runTimedOut: boolean;
    readonly parentAborted: boolean;
  },
): OrchestrationNodeRunResultV1 {
  if (flags.nodeTimedOut) {
    return {
      nodeId,
      status: "failed",
      durationMs,
      error: {
        type: "node_timeout",
        message: "orchestration node exceeded timeoutMs.",
        origin: "system",
        nodeId,
      },
    };
  }
  if (flags.runTimedOut) {
    return {
      nodeId,
      status: "aborted",
      durationMs,
      error: {
        type: "run_timeout",
        message: "orchestration run timeout aborted node.",
        origin: "system",
        nodeId,
      },
    };
  }
  return {
    nodeId,
    status: "aborted",
    durationMs,
    error: {
      type: flags.parentAborted ? "parent_abort" : "fail_fast_abort",
      message: flags.parentAborted
        ? "parent run aborted orchestration node."
        : "fail-fast aborted orchestration node.",
      origin: "abort",
      nodeId,
    },
  };
}

async function applyNodeResult(
  bus: EventBus<AgentEventMap>,
  executable: OrchestrationExecutableV1,
  runId: string,
  runtime: RuntimeState,
  result: OrchestrationNodeRunResultV1,
): Promise<void> {
  const node = executable.definition.nodesById[result.nodeId]!;
  const contractError =
    result.status === "completed"
      ? validateNodeOutputV1(result.nodeId, result.output, node.output)
      : undefined;
  const finalResult: OrchestrationNodeRunResultV1 = contractError
    ? {
        nodeId: result.nodeId,
        status: "failed",
        error: contractError,
        usage: result.usage,
        durationMs: result.durationMs,
      }
    : result;

  runtime.statusByNodeId[finalResult.nodeId] = finalResult.status;
  runtime.nodeResults[finalResult.nodeId] = finalResult;
  if (finalResult.status === "completed" && finalResult.output) {
    runtime.outputs[finalResult.nodeId] = finalResult.output;
  }

  await bus.emit("orchestration:node_end", {
    runId,
    definitionId: executable.definition.id,
    nodeId: finalResult.nodeId,
    status: finalResult.status,
    durationMs: finalResult.durationMs,
    usage: finalResult.usage,
    error: finalResult.error?.message,
    errorType: finalResult.error?.type,
  });
}

function abortRunning(running: Map<string, RunningNode>): void {
  for (const item of running.values()) {
    item.controller.abort();
  }
}

async function drainRunning(
  running: Map<string, RunningNode>,
  bus: EventBus<AgentEventMap>,
  executable: OrchestrationExecutableV1,
  runId: string,
  runtime: RuntimeState,
): Promise<void> {
  const results = await Promise.all([...running.values()].map((item) => item.promise));
  running.clear();
  for (const result of results) {
    await applyNodeResult(bus, executable, runId, runtime, result);
  }
}

async function markPendingSkipped(
  bus: EventBus<AgentEventMap>,
  executable: OrchestrationExecutableV1,
  runId: string,
  runtime: RuntimeState,
  nodeIds: readonly string[],
): Promise<void> {
  for (const nodeId of nodeIds) {
    if (runtime.statusByNodeId[nodeId] === "pending") {
      const result: OrchestrationNodeRunResultV1 = {
        nodeId,
        status: "skipped",
        durationMs: 0,
      };
      runtime.statusByNodeId[nodeId] = "skipped";
      runtime.nodeResults[nodeId] = result;
      await bus.emit("orchestration:node_end", {
        runId,
        definitionId: executable.definition.id,
        nodeId,
        status: "skipped",
        durationMs: 0,
      });
    }
  }
}

function allNodesSettled(
  runtime: RuntimeState,
  nodeIds: readonly string[],
): boolean {
  return nodeIds.every((nodeId) => {
    const status = runtime.statusByNodeId[nodeId];
    return (
      status === "completed" ||
      status === "failed" ||
      status === "aborted" ||
      status === "skipped"
    );
  });
}

function hasFailedNode(runtime: RuntimeState): boolean {
  return Object.values(runtime.nodeResults).some(
    (result) => result.status === "failed" || result.status === "aborted",
  );
}

function firstNodeError(
  nodeResults: Readonly<Record<string, OrchestrationNodeRunResultV1>>,
): OrchestrationErrorV1 | undefined {
  return Object.values(nodeResults).find((result) => result.error)?.error;
}

function buildRunResult(args: {
  readonly runId: string;
  readonly executable: OrchestrationExecutableV1;
  readonly status: "completed" | "failed" | "aborted";
  readonly startedAt: number;
  readonly endedAt: number;
  readonly runtime: RuntimeState;
  readonly runError?: OrchestrationErrorV1;
}): OrchestrationRunResultV1 {
  const nodeErrors: Record<string, OrchestrationErrorV1> = {};
  let usage: TokenUsage = emptyUsage();
  for (const result of Object.values(args.runtime.nodeResults)) {
    if (result.error) nodeErrors[result.nodeId] = result.error;
    if (result.usage) usage = mergeUsage(usage, result.usage);
  }

  return deepFreeze({
    runId: args.runId,
    definitionId: args.executable.definition.id,
    status: args.status,
    outputs: { ...args.runtime.outputs },
    nodeResults: { ...args.runtime.nodeResults },
    errors: {
      run: args.runError,
      nodes: nodeErrors,
    },
    usage,
    durationMs: Math.max(0, args.endedAt - args.startedAt),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepFreeze(item);
  }
  return value;
}
