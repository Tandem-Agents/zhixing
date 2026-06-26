import type {
  EventBus,
  AgentEventMap,
  NormalizedOrchestrationNodeV1,
  OrchestrationContextSnapshotV1,
  OrchestrationExecutableV1,
  OrchestrationNodeOutputV1,
  OrchestrationNodeRunResultV1,
} from "@zhixing/core";

export interface OrchestrationNodeExecutionContextV1 {
  readonly runId: string;
  readonly definitionId: string;
  readonly runInput?: unknown;
  readonly contextSnapshot?: OrchestrationContextSnapshotV1;
  readonly dependencyOutputs: Readonly<Record<string, OrchestrationNodeOutputV1>>;
  readonly abortSignal: AbortSignal;
  readonly bus: EventBus<AgentEventMap>;
  readonly lineage: string;
}

export interface AgentNodeExecutorV1 {
  runAgentNode(
    node: NormalizedOrchestrationNodeV1,
    context: OrchestrationNodeExecutionContextV1,
  ): Promise<OrchestrationNodeRunResultV1>;
}

export interface OrchestrationRunnerOptionsV1 {
  readonly bus: EventBus<AgentEventMap>;
  readonly nodeExecutor: AgentNodeExecutorV1;
  readonly parentLineage?: string;
  readonly createRunId?: () => string;
  readonly now?: () => number;
}

export interface RunOrchestrationOptionsV1 {
  readonly executable: OrchestrationExecutableV1;
  readonly runInput?: unknown;
  readonly contextSnapshot?: OrchestrationContextSnapshotV1;
  readonly abortSignal?: AbortSignal;
}
