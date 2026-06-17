import {
  deriveDependencies,
  type DefinitionValidator,
  type JsonValue,
  type NodeExecutorRegistry,
  type NormalizedWorkflowDefinition,
  type NormalizedWorkflowEdge,
  type ValidatedWorkflowDefinition,
  type WorkflowActiveCondition,
  type WorkflowArtifact,
  type WorkflowDecisionActor,
  type WorkflowDecisionRecord,
  type WorkflowDefinition,
  type WorkflowError,
  type WorkflowInstance,
  type WorkflowInstanceStatus,
  type WorkflowNode,
  type WorkflowNodeInputIteration,
  type WorkflowNodeRun,
  type WorkflowScheduleEntry,
  WorkflowScheduler,
} from "@zhixing/core";
import type { WorkflowStore } from "./store.js";

export interface StartWorkflowInput {
  readonly conversationId: string;
  readonly goal: string;
  readonly input: JsonValue;
  readonly definition: WorkflowDefinition;
  readonly definitionId?: string;
  readonly origin?: JsonValue;
}

export interface ResolveWorkflowDecisionInput {
  readonly instanceId: string;
  readonly decisionId: string;
  readonly resultOptionId: string;
  readonly actor: WorkflowDecisionActor;
  readonly rationale?: string;
}

export interface WorkflowManagerOptions {
  readonly store: WorkflowStore;
  readonly validator: DefinitionValidator;
  readonly executors: NodeExecutorRegistry;
  readonly scheduler?: WorkflowScheduler;
  readonly clock?: () => Date;
  readonly idFactory?: WorkflowIdFactory;
  readonly maxAdvanceSteps?: number;
}

export interface WorkflowIdFactory {
  instance(): string;
  nodeRun(input: {
    instanceId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
  }): string;
  decision(input: { instanceId: string; nodeRunId: string }): string;
  artifact(input: {
    instanceId: string;
    nodeRunId: string;
    key: string;
  }): string;
}

export type WorkflowManagerErrorCode =
  | "not_found"
  | "invalid_input"
  | "invalid_state"
  | "executor_missing";

export class WorkflowManagerError extends Error {
  constructor(
    readonly code: WorkflowManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowManagerError";
  }
}

export class WorkflowManager {
  private readonly store: WorkflowStore;
  private readonly validator: DefinitionValidator;
  private readonly executors: NodeExecutorRegistry;
  private readonly scheduler: WorkflowScheduler;
  private readonly clock: () => Date;
  private readonly idFactory: WorkflowIdFactory;
  private readonly maxAdvanceSteps: number;
  private readonly advanceLocks = new Map<string, Promise<WorkflowInstance>>();
  private readonly activeExecutions = new Map<
    string,
    Map<string, AbortController>
  >();

  constructor(options: WorkflowManagerOptions) {
    this.store = options.store;
    this.validator = options.validator;
    this.executors = options.executors;
    this.scheduler = options.scheduler ?? new WorkflowScheduler();
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? createDefaultIdFactory();
    this.maxAdvanceSteps = options.maxAdvanceSteps ?? 1_000;
  }

  async start(input: StartWorkflowInput): Promise<WorkflowInstance> {
    const instance = await this.createInstance(input);
    return this.advance(instance.instanceId);
  }

  async startDetached(input: StartWorkflowInput): Promise<WorkflowInstance> {
    const instance = await this.createInstance(input);
    this.advanceDetached(instance.instanceId);
    return instance;
  }

  private async createInstance(
    input: StartWorkflowInput,
  ): Promise<WorkflowInstance> {
    this.assertStartInput(input);
    const validated = this.validator.validate(input.definition);
    const now = this.now();
    const instanceId = this.idFactory.instance();
    const instance: WorkflowInstance = {
      instanceId,
      conversationId: input.conversationId,
      origin: input.origin,
      goal: input.goal,
      input: input.input,
      definition: validated.definition,
      definitionId: input.definitionId ?? validated.definition.id,
      status: "created",
      nodeRuns: [],
      decisions: [],
      artifacts: [],
      errors: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.store.create(instance);
    return instance;
  }

  get(instanceId: string): Promise<WorkflowInstance | null> {
    return this.store.get(instanceId);
  }

  listByConversation(conversationId: string): Promise<WorkflowInstance[]> {
    return this.store.listByConversation(conversationId);
  }

  async decide(input: ResolveWorkflowDecisionInput): Promise<WorkflowInstance> {
    await this.resolveDecision(input);
    return this.advance(input.instanceId);
  }

  async decideDetached(
    input: ResolveWorkflowDecisionInput,
  ): Promise<WorkflowInstance> {
    const instance = await this.resolveDecision(input);
    this.advanceDetached(input.instanceId);
    return instance;
  }

  private async resolveDecision(
    input: ResolveWorkflowDecisionInput,
  ): Promise<WorkflowInstance> {
    this.assertDecisionInput(input);
    await this.requireInstance(input.instanceId);
    return this.store.update(input.instanceId, (instance) => {
      const decision = instance.decisions.find(
        (entry) => entry.decisionId === input.decisionId,
      );
      if (!decision) {
        throw new WorkflowManagerError(
          "not_found",
          `Workflow decision not found: ${input.decisionId}`,
        );
      }
      if (decision.resolvedAt) {
        throw new WorkflowManagerError(
          "invalid_state",
          `Workflow decision already resolved: ${input.decisionId}`,
        );
      }
      if (
        !decision.options.some(
          (option) => option.optionId === input.resultOptionId,
        )
      ) {
        throw new WorkflowManagerError(
          "invalid_input",
          `Decision option not found: ${input.resultOptionId}`,
        );
      }

      const nodeRun = instance.nodeRuns.find(
        (run) => run.nodeRunId === decision.nodeRunId,
      );
      if (!nodeRun || nodeRun.status !== "waiting_decision") {
        throw new WorkflowManagerError(
          "invalid_state",
          "Decision node run is not waiting for a decision",
        );
      }

      const now = this.now();
      const artifact = this.createArtifact(
        instance.instanceId,
        nodeRun.nodeRunId,
        "decision",
        decisionArtifactValue(decision, input, now),
      );
      return {
        ...instance,
        status: "running",
        decisions: instance.decisions.map((entry) =>
          entry.decisionId === input.decisionId
            ? {
                ...entry,
                actor: input.actor,
                resultOptionId: input.resultOptionId,
                rationale: input.rationale ?? entry.rationale,
                resolvedAt: now,
              }
            : entry,
        ),
        artifacts: [...instance.artifacts, artifact],
        nodeRuns: instance.nodeRuns.map((run) =>
          run.nodeRunId === nodeRun.nodeRunId
            ? {
                ...run,
                status: "succeeded",
                outputArtifactRefs: [
                  ...(run.outputArtifactRefs ?? []),
                  artifact.artifactId,
                ],
                updatedAt: now,
              }
            : run,
        ),
        updatedAt: now,
      };
    });
  }

  async cancel(instanceId: string, reason: string): Promise<void> {
    await this.requireInstance(instanceId);
    await this.store.update(instanceId, (instance) => {
      if (isTerminalInstance(instance.status)) return instance;
      const now = this.now();
      const error: WorkflowError = {
        code: "workflow.canceled",
        message: reason,
        recoverable: false,
      };
      return {
        ...instance,
        status: "canceled",
        nodeRuns: instance.nodeRuns.map((run) =>
          isActiveNodeRun(run)
            ? { ...run, status: "canceled", error, updatedAt: now }
            : run,
        ),
        errors: [...instance.errors, error],
        updatedAt: now,
      };
    });
    this.abortActiveExecutions(instanceId);
  }

  resume(instanceId: string): Promise<WorkflowInstance> {
    return this.advance(instanceId);
  }

  async resumeDetached(instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.requireInstance(instanceId);
    this.advanceDetached(instanceId);
    return instance;
  }

  async recoverUnfinished(): Promise<WorkflowInstance[]> {
    const unfinished = await this.store.listUnfinished();
    const recovered: WorkflowInstance[] = [];
    for (const instance of unfinished) {
      await this.markInterruptedRunsFailed(instance.instanceId);
      recovered.push(await this.advance(instance.instanceId));
    }
    return recovered;
  }

  private async advance(instanceId: string): Promise<WorkflowInstance> {
    return this.withAdvanceLock(instanceId, async () => {
      let steps = 0;
      for (;;) {
        const instance = await this.requireInstance(instanceId);
        if (isTerminalInstance(instance.status)) return instance;

        const unresolvedDecision = instance.decisions.some(
          (decision) => !decision.resolvedAt,
        );
        if (unresolvedDecision) {
          return this.setStatus(instanceId, "waiting_decision");
        }

        const validated = validatedFromSnapshot(instance.definition);
        const plan = this.scheduler.plan({
          validated,
          nodeRuns: instance.nodeRuns,
          activeConditions: activeConditionsFromDecisions(instance),
        });

        if (plan.ready.length === 0) {
          return this.setStatus(instanceId, settleStatus(instance));
        }

        const batch: WorkflowScheduleEntry[] = [];
        for (const entry of plan.ready) {
          steps += 1;
          if (steps > this.maxAdvanceSteps) {
            return this.failInstance(instanceId, {
              code: "workflow.advance_limit",
              message: "Workflow advance limit reached",
              recoverable: false,
            });
          }
          batch.push(entry);
        }

        const runningInstance = await this.setStatus(instanceId, "running");
        if (isTerminalInstance(runningInstance.status)) return runningInstance;
        const runs = (
          await Promise.all(
            batch.map((entry) => this.createRunningNodeRun(instanceId, entry)),
          )
        ).filter((run): run is WorkflowNodeRun => run !== null);
        if (runs.length === 0) continue;
        await Promise.all(
          runs.map((run) => this.executeNodeRun(instanceId, run)),
        );
      }
    });
  }

  private advanceDetached(instanceId: string): void {
    void this.advance(instanceId).catch((error) => {
      void this.failInstance(instanceId, {
        code: "workflow.detached_advance_failed",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      }).catch(() => {});
    });
  }

  private async executeNodeRun(
    instanceId: string,
    nodeRun: WorkflowNodeRun,
  ): Promise<void> {
    const instance = await this.requireInstance(instanceId);
    if (isTerminalInstance(instance.status)) return;
    const storedRun = instance.nodeRuns.find(
      (run) => run.nodeRunId === nodeRun.nodeRunId,
    );
    if (storedRun?.status !== "running") return;

    const node = instance.definition.nodes.find(
      (entry) => entry.nodeId === nodeRun.nodeId,
    );
    if (!node) {
      await this.failNodeRun(instanceId, nodeRun.nodeRunId, {
        code: "workflow.node_missing",
        message: `Workflow node not found: ${nodeRun.nodeId}`,
        recoverable: false,
      });
      return;
    }

    const executor = this.executors.get(node.executor.executorId);
    if (!executor) {
      await this.failNodeRun(instanceId, nodeRun.nodeRunId, {
        code: "workflow.executor_missing",
        message: `Node executor not registered: ${node.executor.executorId}`,
        recoverable: true,
      });
      return;
    }

    const controller = this.registerActiveExecution(instanceId, nodeRun.nodeRunId);
    try {
      if (!(await this.isNodeRunRunning(instanceId, nodeRun.nodeRunId))) {
        controller.abort();
        return;
      }
      const input = resolveNodeInput(instance, node, nodeRun);
      const result = await executor.run({
        node,
        nodeRun,
        input,
        signal: controller.signal,
      });
      if (result.status === "succeeded") {
        await this.succeedNodeRun(
          instanceId,
          nodeRun.nodeRunId,
          result.output,
          result.artifacts ?? [],
        );
        return;
      }
      if (result.status === "waiting_decision") {
        await this.waitForDecision(instanceId, nodeRun, result.decision);
        return;
      }
      if (result.status === "failed") {
        await this.failNodeRun(instanceId, nodeRun.nodeRunId, result.error);
        return;
      }
      await this.cancelNodeRun(instanceId, nodeRun.nodeRunId, result.reason);
    } catch (error) {
      await this.failNodeRun(instanceId, nodeRun.nodeRunId, {
        code: "workflow.executor_error",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
    } finally {
      this.unregisterActiveExecution(instanceId, nodeRun.nodeRunId);
    }
  }

  private createRunningNodeRun(
    instanceId: string,
    entry: WorkflowScheduleEntry,
  ): Promise<WorkflowNodeRun | null> {
    let created: WorkflowNodeRun | null = null;
    return this.store.update(instanceId, (instance) => {
      if (isTerminalInstance(instance.status)) return instance;
      const now = this.now();
      created = {
        nodeRunId: this.idFactory.nodeRun({ instanceId, ...entry }),
        nodeId: entry.nodeId,
        iteration: entry.iteration,
        attempt: entry.attempt,
        triggeredByEdgeId: entry.triggeredByEdgeId,
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...instance,
        status: "running",
        nodeRuns: [...instance.nodeRuns, created],
        updatedAt: now,
      };
    }).then(() => {
      return created;
    });
  }

  private succeedNodeRun(
    instanceId: string,
    nodeRunId: string,
    output: JsonValue,
    extraArtifacts: readonly WorkflowArtifact[],
  ): Promise<WorkflowInstance> {
    return this.store.update(instanceId, (instance) => {
      if (!isWritableRunningNodeRun(instance, nodeRunId)) return instance;
      const now = this.now();
      const outputArtifact = this.createArtifact(
        instance.instanceId,
        nodeRunId,
        "output",
        output,
      );
      const artifacts = [
        outputArtifact,
        ...extraArtifacts.map((artifact) => ({
          ...artifact,
          nodeRunId,
          createdAt: artifact.createdAt || now,
        })),
      ];
      return {
        ...instance,
        artifacts: [...instance.artifacts, ...artifacts],
        nodeRuns: instance.nodeRuns.map((run) =>
          run.nodeRunId === nodeRunId
            ? {
                ...run,
                status: "succeeded",
                outputArtifactRefs: [
                  ...(run.outputArtifactRefs ?? []),
                  ...artifacts.map((artifact) => artifact.artifactId),
                ],
                updatedAt: now,
              }
            : run,
        ),
        updatedAt: now,
      };
    });
  }

  private waitForDecision(
    instanceId: string,
    nodeRun: WorkflowNodeRun,
    decision: {
      readonly question: string;
      readonly options: readonly WorkflowDecisionRecord["options"][number][];
      readonly recommendedOptionId?: string;
      readonly rationale?: string;
    },
  ): Promise<WorkflowInstance> {
    return this.store.update(instanceId, (instance) => {
      if (!isWritableRunningNodeRun(instance, nodeRun.nodeRunId)) return instance;
      const now = this.now();
      const record: WorkflowDecisionRecord = {
        decisionId: this.idFactory.decision({
          instanceId,
          nodeRunId: nodeRun.nodeRunId,
        }),
        nodeRunId: nodeRun.nodeRunId,
        nodeId: nodeRun.nodeId,
        question: decision.question,
        options: decision.options,
        recommendedOptionId: decision.recommendedOptionId,
        rationale: decision.rationale,
        createdAt: now,
      };
      return {
        ...instance,
        status: "waiting_decision",
        decisions: [...instance.decisions, record],
        nodeRuns: instance.nodeRuns.map((run) =>
          run.nodeRunId === nodeRun.nodeRunId
            ? { ...run, status: "waiting_decision", updatedAt: now }
            : run,
        ),
        updatedAt: now,
      };
    });
  }

  private failNodeRun(
    instanceId: string,
    nodeRunId: string,
    error: WorkflowError,
  ): Promise<WorkflowInstance> {
    return this.store.update(instanceId, (instance) => {
      if (!isWritableRunningNodeRun(instance, nodeRunId)) return instance;
      const now = this.now();
      return {
        ...instance,
        nodeRuns: instance.nodeRuns.map((run) =>
          run.nodeRunId === nodeRunId
            ? { ...run, status: "failed", error, updatedAt: now }
            : run,
        ),
        errors: [...instance.errors, error],
        updatedAt: now,
      };
    });
  }

  private cancelNodeRun(
    instanceId: string,
    nodeRunId: string,
    reason = "Node execution canceled",
  ): Promise<WorkflowInstance> {
    const error: WorkflowError = {
      code: "workflow.node_canceled",
      message: reason,
      recoverable: false,
    };
    return this.store.update(instanceId, (instance) => {
      if (!isWritableRunningNodeRun(instance, nodeRunId)) return instance;
      const now = this.now();
      return {
        ...instance,
        status: "canceled",
        nodeRuns: instance.nodeRuns.map((run) =>
          run.nodeRunId === nodeRunId
            ? { ...run, status: "canceled", error, updatedAt: now }
            : run,
        ),
        errors: [...instance.errors, error],
        updatedAt: now,
      };
    });
  }

  private async markInterruptedRunsFailed(instanceId: string): Promise<void> {
    await this.store.update(instanceId, (instance) => {
      const interrupted = instance.nodeRuns.filter(
        (run) => run.status === "running" || run.status === "ready",
      );
      if (interrupted.length === 0) return instance;
      const now = this.now();
      const error: WorkflowError = {
        code: "workflow.recovered_interrupted_node",
        message: "Workflow node run was interrupted by host restart",
        recoverable: true,
      };
      return {
        ...instance,
        status: "running",
        nodeRuns: instance.nodeRuns.map((run) =>
          run.status === "running" || run.status === "ready"
            ? { ...run, status: "failed", error, updatedAt: now }
            : run,
        ),
        errors: [...instance.errors, error],
        updatedAt: now,
      };
    });
  }

  private setStatus(
    instanceId: string,
    status: WorkflowInstanceStatus,
  ): Promise<WorkflowInstance> {
    return this.store.update(instanceId, (instance) => {
      if (instance.status === status || isTerminalInstance(instance.status)) {
        return instance;
      }
      return {
        ...instance,
        status,
        updatedAt: this.now(),
      };
    });
  }

  private failInstance(
    instanceId: string,
    error: WorkflowError,
  ): Promise<WorkflowInstance> {
    return this.store.update(instanceId, (instance) => {
      if (isTerminalInstance(instance.status)) return instance;
      return {
        ...instance,
        status: "failed",
        errors: [...instance.errors, error],
        updatedAt: this.now(),
      };
    });
  }

  private async requireInstance(instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.store.get(instanceId);
    if (!instance) {
      throw new WorkflowManagerError(
        "not_found",
        `Workflow instance not found: ${instanceId}`,
      );
    }
    return instance;
  }

  private withAdvanceLock(
    instanceId: string,
    fn: () => Promise<WorkflowInstance>,
  ): Promise<WorkflowInstance> {
    const previous = this.advanceLocks.get(instanceId) ?? Promise.resolve(null);
    const next = previous.then(fn, fn);
    this.advanceLocks.set(instanceId, next);
    void next.finally(() => {
      if (this.advanceLocks.get(instanceId) === next) {
        this.advanceLocks.delete(instanceId);
      }
    });
    return next;
  }

  private registerActiveExecution(
    instanceId: string,
    nodeRunId: string,
  ): AbortController {
    const controller = new AbortController();
    const executions = this.activeExecutions.get(instanceId) ?? new Map();
    executions.set(nodeRunId, controller);
    this.activeExecutions.set(instanceId, executions);
    return controller;
  }

  private unregisterActiveExecution(
    instanceId: string,
    nodeRunId: string,
  ): void {
    const executions = this.activeExecutions.get(instanceId);
    if (!executions) return;
    executions.delete(nodeRunId);
    if (executions.size === 0) this.activeExecutions.delete(instanceId);
  }

  private abortActiveExecutions(instanceId: string): void {
    const executions = this.activeExecutions.get(instanceId);
    if (!executions) return;
    for (const controller of executions.values()) {
      controller.abort();
    }
  }

  private async isNodeRunRunning(
    instanceId: string,
    nodeRunId: string,
  ): Promise<boolean> {
    const instance = await this.requireInstance(instanceId);
    if (isTerminalInstance(instance.status)) return false;
    return instance.nodeRuns.some(
      (run) => run.nodeRunId === nodeRunId && run.status === "running",
    );
  }

  private createArtifact(
    instanceId: string,
    nodeRunId: string,
    key: string,
    value: JsonValue,
  ): WorkflowArtifact {
    return {
      artifactId: this.idFactory.artifact({ instanceId, nodeRunId, key }),
      nodeRunId,
      key,
      value,
      createdAt: this.now(),
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private assertStartInput(input: StartWorkflowInput): void {
    if (!isNonEmptyString(input.conversationId)) {
      throw new WorkflowManagerError(
        "invalid_input",
        "Workflow start requires conversationId",
      );
    }
    if (!isNonEmptyString(input.goal)) {
      throw new WorkflowManagerError("invalid_input", "Workflow start requires goal");
    }
    if (!isJsonValue(input.input)) {
      throw new WorkflowManagerError(
        "invalid_input",
        "Workflow input must be JSON-serializable",
      );
    }
    if (input.origin !== undefined && !isJsonValue(input.origin)) {
      throw new WorkflowManagerError(
        "invalid_input",
        "Workflow origin must be JSON-serializable",
      );
    }
  }

  private assertDecisionInput(input: ResolveWorkflowDecisionInput): void {
    if (!isNonEmptyString(input.instanceId)) {
      throw new WorkflowManagerError(
        "invalid_input",
        "Workflow decision requires instanceId",
      );
    }
    if (!isNonEmptyString(input.decisionId)) {
      throw new WorkflowManagerError(
        "invalid_input",
        "Workflow decision requires decisionId",
      );
    }
    if (!isNonEmptyString(input.resultOptionId)) {
      throw new WorkflowManagerError(
        "invalid_input",
        "Workflow decision requires resultOptionId",
      );
    }
  }
}

export type ResolvedWorkflowNodeInput = {
  readonly [key: string]: JsonValue;
  readonly instance: { readonly [key: string]: JsonValue };
  readonly nodes: { readonly [nodeId: string]: JsonValue };
  readonly constants: JsonValue[];
};

function resolveNodeInput(
  instance: WorkflowInstance,
  node: WorkflowNode,
  nodeRun: WorkflowNodeRun,
): ResolvedWorkflowNodeInput {
  const resolvedInstance: Record<string, JsonValue> = {};
  const nodes: Record<string, JsonValue> = {};
  const constants: JsonValue[] = [];

  for (const source of node.inputFrom ?? []) {
    if (source.kind === "instance") {
      resolvedInstance[source.key] = readInstanceInput(instance.input, source.key);
      continue;
    }
    if (source.kind === "constant") {
      constants.push(source.value);
      continue;
    }
    const iteration = resolveInputSourceIteration(source.iteration, nodeRun);
    if (iteration < 0) {
      if (source.optional) continue;
      throw new WorkflowManagerError(
        "invalid_state",
        `Missing previous iteration input from node: ${source.nodeId}`,
      );
    }
    const value = readNodeOutput(instance, source.nodeId, iteration, source.artifactKey);
    if (value === undefined) {
      if (source.optional) continue;
      throw new WorkflowManagerError(
        "invalid_state",
        `Missing input artifact from node: ${source.nodeId}`,
      );
    }
    nodes[source.nodeId] = value;
  }

  return { instance: resolvedInstance, nodes, constants };
}

function readInstanceInput(input: JsonValue, key: string): JsonValue {
  if (isRecord(input) && key in input) return input[key] ?? null;
  return null;
}

function resolveInputSourceIteration(
  iteration: WorkflowNodeInputIteration | undefined,
  nodeRun: WorkflowNodeRun,
): number {
  if (iteration === "previous") return nodeRun.iteration - 1;
  if (iteration === "initial") return 0;
  return nodeRun.iteration;
}

function readNodeOutput(
  instance: WorkflowInstance,
  nodeId: string,
  iteration: number,
  artifactKey?: string,
): JsonValue | undefined {
  const run = [...instance.nodeRuns]
    .filter(
      (entry) =>
        entry.nodeId === nodeId &&
        entry.iteration === iteration &&
        entry.status === "succeeded",
    )
    .sort((a, b) => b.attempt - a.attempt)[0];
  if (!run) return undefined;

  const artifacts = instance.artifacts.filter(
    (artifact) =>
      artifact.nodeRunId === run.nodeRunId &&
      (!artifactKey || artifact.key === artifactKey),
  );
  if (artifacts.length === 0) return undefined;
  if (artifactKey) return artifacts[0]?.value;
  if (artifacts.length === 1) return artifacts[0]?.value;
  return Object.fromEntries(
    artifacts.map((artifact) => [artifact.key, artifact.value]),
  ) as JsonValue;
}

function activeConditionsFromDecisions(
  instance: WorkflowInstance,
): WorkflowActiveCondition[] {
  const runsById = new Map(
    instance.nodeRuns.map((run) => [run.nodeRunId, run] as const),
  );
  return instance.decisions.flatMap((decision) => {
    if (!decision.resultOptionId) return [];
    const run = runsById.get(decision.nodeRunId);
    return [
      {
        conditionId: decision.resultOptionId,
        nodeId: decision.nodeId,
        nodeRunId: decision.nodeRunId,
        iteration: run?.iteration,
      },
    ];
  });
}

function decisionArtifactValue(
  decision: WorkflowDecisionRecord,
  input: ResolveWorkflowDecisionInput,
  resolvedAt: string,
): JsonValue {
  const value: Record<string, JsonValue> = {
    optionId: input.resultOptionId,
    actor: input.actor,
    question: decision.question,
    options: decision.options.map((option) => {
      const output: Record<string, JsonValue> = {
        optionId: option.optionId,
        label: option.label,
      };
      if (option.description) output["description"] = option.description;
      return output;
    }),
    resolvedAt,
  };
  if (decision.recommendedOptionId) {
    value["recommendedOptionId"] = decision.recommendedOptionId;
  }
  if (decision.rationale) {
    value["requestRationale"] = decision.rationale;
  }
  if (input.rationale) {
    value["resolutionRationale"] = input.rationale;
  }
  return value;
}

function validatedFromSnapshot(
  definition: NormalizedWorkflowDefinition,
): ValidatedWorkflowDefinition {
  const dependencies = deriveDependencies(
    definition.nodes,
    definition.edges as readonly NormalizedWorkflowEdge[],
  );
  const loopTargets = new Set<string>();
  for (const edge of definition.edges) {
    if (!edge.loopPolicy) continue;
    loopTargets.add(edge.loopPolicy.failureExitNodeId);
    if (edge.loopPolicy.decisionNodeId) {
      loopTargets.add(edge.loopPolicy.decisionNodeId);
    }
  }
  return {
    definition,
    dependencies,
    entryNodeIds: dependencies
      .filter(
        (dependency) =>
          dependency.upstreamNodeIds.length === 0 &&
          !loopTargets.has(dependency.nodeId),
      )
      .map((dependency) => dependency.nodeId),
  };
}

function settleStatus(instance: WorkflowInstance): WorkflowInstanceStatus {
  const latestRuns = latestRunsByOccurrence(instance.nodeRuns);
  if (latestRuns.some((run) => run.status === "waiting_decision")) {
    return "waiting_decision";
  }
  if (latestRuns.some((run) => run.status === "running" || run.status === "ready")) {
    return "running";
  }
  if (latestRuns.some((run) => run.status === "failed")) {
    return "failed";
  }
  if (latestRuns.some((run) => run.status === "canceled")) {
    return "canceled";
  }
  return "succeeded";
}

function latestRunsByOccurrence(
  runs: readonly WorkflowNodeRun[],
): WorkflowNodeRun[] {
  const latest = new Map<string, WorkflowNodeRun>();
  for (const run of runs) {
    const key = `${run.nodeId}:${run.iteration}`;
    const existing = latest.get(key);
    if (!existing || run.attempt > existing.attempt) {
      latest.set(key, run);
    }
  }
  return [...latest.values()];
}

function isTerminalInstance(status: WorkflowInstanceStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function isWritableRunningNodeRun(
  instance: WorkflowInstance,
  nodeRunId: string,
): boolean {
  if (isTerminalInstance(instance.status)) return false;
  return instance.nodeRuns.some(
    (run) => run.nodeRunId === nodeRunId && run.status === "running",
  );
}

function isActiveNodeRun(run: WorkflowNodeRun): boolean {
  return (
    run.status === "ready" ||
    run.status === "running" ||
    run.status === "waiting_decision"
  );
}

function createDefaultIdFactory(): WorkflowIdFactory {
  let sequence = 0;
  const next = (prefix: string) => {
    sequence += 1;
    return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`;
  };
  return {
    instance: () => next("wf"),
    nodeRun: ({ nodeId, iteration, attempt }) =>
      `${next("wfr")}_${nodeId}_${iteration}_${attempt}`,
    decision: () => next("wfd"),
    artifact: ({ key }) => `${next("wfa")}_${key}`,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((entry) => isJsonValue(entry, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).every((entry) => isJsonValue(entry, seen));
  }
  return false;
}
