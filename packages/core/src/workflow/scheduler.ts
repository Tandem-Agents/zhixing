import type {
  NormalizedWorkflowDefinition,
  WorkflowBlockedNode,
  WorkflowNode,
  WorkflowNodeId,
  WorkflowNodeRun,
  WorkflowNodeRunStatus,
  WorkflowScheduleEntry,
  WorkflowSchedulePlan,
  WorkflowSchedulerInput,
} from "./types.js";
import {
  collectLoopPolicyTargetIds,
  isConditionActive,
  isFeedbackEdgeActive,
} from "./graph.js";

const ACTIVE_STATUSES = new Set<WorkflowNodeRunStatus>([
  "ready",
  "running",
  "waiting_decision",
]);

const TERMINAL_STATUSES = new Set<WorkflowNodeRunStatus>([
  "succeeded",
  "failed",
  "canceled",
  "skipped",
]);

export class WorkflowScheduler {
  plan(input: WorkflowSchedulerInput): WorkflowSchedulePlan {
    const definition = input.validated.definition;
    const activeConditions = new Set(input.activeConditionIds ?? []);
    const ready: WorkflowScheduleEntry[] = [];
    const blocked: WorkflowBlockedNode[] = [];

    for (const node of definition.nodes) {
      const candidates = this.getCandidateIterations(
        node,
        definition,
        input.nodeRuns,
        activeConditions,
      );

      for (const candidate of candidates) {
        const existing = input.nodeRuns.filter(
          (run) =>
            run.nodeId === node.nodeId && run.iteration === candidate.iteration,
        );
        const latest = latestAttempt(existing);
        if (latest && ACTIVE_STATUSES.has(latest.status)) {
          blocked.push({
            nodeId: node.nodeId,
            iteration: candidate.iteration,
            reason:
              latest.status === "waiting_decision"
                ? "waiting_decision"
                : "active_run_exists",
          });
          continue;
        }

        if (latest?.status === "succeeded") {
          blocked.push({
            nodeId: node.nodeId,
            iteration: candidate.iteration,
            reason: "already_succeeded",
          });
          continue;
        }

        if (latest?.status === "canceled" || latest?.status === "skipped") {
          blocked.push({
            nodeId: node.nodeId,
            iteration: candidate.iteration,
            reason: "terminal_run_exists",
          });
          continue;
        }

        if (latest?.status === "failed") {
          const maxAttempts = this.maxAttemptsFor(node, definition);
          const nextAttempt = latest.attempt + 1;
          if (nextAttempt >= maxAttempts) {
            blocked.push({
              nodeId: node.nodeId,
              iteration: candidate.iteration,
              reason: "max_attempts_reached",
            });
            continue;
          }
          ready.push({
            nodeId: node.nodeId,
            iteration: candidate.iteration,
            attempt: nextAttempt,
            triggeredByEdgeId: latest.triggeredByEdgeId,
            reason: "retry",
          });
          continue;
        }

        if (
          this.dependenciesSatisfied(
            node.nodeId,
            candidate.iteration,
            definition,
            input.nodeRuns,
            activeConditions,
          )
        ) {
          ready.push({
            nodeId: node.nodeId,
            iteration: candidate.iteration,
            attempt: 0,
            triggeredByEdgeId: candidate.triggeredByEdgeId,
            reason: candidate.reason,
          });
        } else {
          blocked.push({
            nodeId: node.nodeId,
            iteration: candidate.iteration,
            reason: "waiting_dependencies",
          });
        }
      }
    }

    return this.applyConcurrencyLimit(definition, input.nodeRuns, ready, blocked);
  }

  private getCandidateIterations(
    node: WorkflowNode,
    definition: NormalizedWorkflowDefinition,
    runs: readonly WorkflowNodeRun[],
    activeConditions: ReadonlySet<string>,
  ): WorkflowScheduleEntry[] {
    const incoming = definition.edges.filter((edge) => edge.to === node.nodeId);
    const nonFeedbackIncoming = incoming.filter((edge) => edge.kind !== "feedback");
    const feedbackEdges = definition.edges.filter((edge) => edge.kind === "feedback");
    const loopPolicyTargetIds = collectLoopPolicyTargetIds(definition);
    const candidates = new Map<number, WorkflowScheduleEntry>();

    if (
      nonFeedbackIncoming.length === 0 &&
      !loopPolicyTargetIds.has(node.nodeId)
    ) {
      candidates.set(0, {
        nodeId: node.nodeId,
        iteration: 0,
        attempt: 0,
        reason: "start",
      });
    }

    for (const edge of nonFeedbackIncoming) {
      if (!isConditionActive(edge.condition, activeConditions)) continue;
      for (const run of successfulRuns(runs, edge.from)) {
        candidates.set(run.iteration, {
          nodeId: node.nodeId,
          iteration: run.iteration,
          attempt: 0,
          triggeredByEdgeId: edge.edgeId,
          reason: "start",
        });
      }
    }

    for (const edge of feedbackEdges) {
      if (!isFeedbackEdgeActive(edge, activeConditions)) continue;
      for (const run of successfulRuns(runs, edge.from)) {
        const nextIteration = run.iteration + 1;
        const maxIterations = this.maxFeedbackIterationsFor(edge, definition);
        if (edge.loopPolicy && nextIteration > maxIterations) {
          if (edge.loopPolicy.failureExitNodeId === node.nodeId) {
            candidates.set(run.iteration, {
              nodeId: node.nodeId,
              iteration: run.iteration,
              attempt: 0,
              triggeredByEdgeId: edge.edgeId,
              reason: "loop_exit",
            });
          }
          continue;
        }
        if (edge.to !== node.nodeId) continue;
        candidates.set(nextIteration, {
          nodeId: node.nodeId,
          iteration: nextIteration,
          attempt: 0,
          triggeredByEdgeId: edge.edgeId,
          reason: "feedback",
        });
      }
    }

    return [...candidates.values()].sort((a, b) => a.iteration - b.iteration);
  }

  private dependenciesSatisfied(
    nodeId: WorkflowNodeId,
    iteration: number,
    definition: NormalizedWorkflowDefinition,
    runs: readonly WorkflowNodeRun[],
    activeConditions: ReadonlySet<string>,
  ): boolean {
    const incoming = definition.edges.filter(
      (edge) =>
        edge.to === nodeId &&
        edge.kind !== "feedback" &&
        isConditionActive(edge.condition, activeConditions),
    );
    return incoming.every((edge) =>
      runs.some(
        (run) =>
          run.nodeId === edge.from &&
          run.iteration === iteration &&
          run.status === "succeeded",
      ),
    );
  }

  private maxAttemptsFor(
    node: WorkflowNode,
    definition: NormalizedWorkflowDefinition,
  ): number {
    return node.retryPolicy?.maxAttempts ?? definition.policies?.retry?.maxAttempts ?? 1;
  }

  private maxFeedbackIterationsFor(
    edge: NormalizedWorkflowDefinition["edges"][number],
    definition: NormalizedWorkflowDefinition,
  ): number {
    const edgeLimit = edge.loopPolicy?.maxIterations ?? 0;
    const globalLimit = definition.policies?.feedback?.maxIterations;
    return globalLimit ? Math.min(edgeLimit, globalLimit) : edgeLimit;
  }

  private applyConcurrencyLimit(
    definition: NormalizedWorkflowDefinition,
    runs: readonly WorkflowNodeRun[],
    ready: WorkflowScheduleEntry[],
    blocked: WorkflowBlockedNode[],
  ): WorkflowSchedulePlan {
    const maxParallelNodes = definition.policies?.concurrency?.maxParallelNodes;
    if (!maxParallelNodes) return { ready, blocked };

    const activeCount = runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length;
    const availableSlots = Math.max(0, maxParallelNodes - activeCount);
    const allowedReady = ready.slice(0, availableSlots);
    const concurrencyBlocked = ready.slice(availableSlots).map((entry) => ({
      nodeId: entry.nodeId,
      iteration: entry.iteration,
      reason: "concurrency_limit_reached" as const,
    }));

    return {
      ready: allowedReady,
      blocked: [...blocked, ...concurrencyBlocked],
    };
  }
}

function successfulRuns(
  runs: readonly WorkflowNodeRun[],
  nodeId: WorkflowNodeId,
): WorkflowNodeRun[] {
  return runs.filter((run) => run.nodeId === nodeId && run.status === "succeeded");
}

function latestAttempt(runs: readonly WorkflowNodeRun[]): WorkflowNodeRun | null {
  if (runs.length === 0) return null;
  return [...runs].sort((a, b) => b.attempt - a.attempt)[0] ?? null;
}

export { ACTIVE_STATUSES as WORKFLOW_ACTIVE_NODE_RUN_STATUSES };
export { TERMINAL_STATUSES as WORKFLOW_TERMINAL_NODE_RUN_STATUSES };
