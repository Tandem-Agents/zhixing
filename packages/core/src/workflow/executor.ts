import type {
  JsonValue,
  WorkflowDecisionOption,
  WorkflowError,
  WorkflowExecutorId,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowArtifact,
} from "./types.js";

export interface NodeExecutionContext<TInput = JsonValue> {
  readonly node: WorkflowNode;
  readonly nodeRun: WorkflowNodeRun;
  readonly input: TInput;
  readonly signal?: AbortSignal;
}

export type NodeExecutionResult<TOutput = JsonValue> =
  | {
      readonly status: "succeeded";
      readonly output: TOutput;
      readonly artifacts?: readonly WorkflowArtifact[];
    }
  | {
      readonly status: "failed";
      readonly error: WorkflowError;
    }
  | {
      readonly status: "canceled";
      readonly reason?: string;
    }
  | {
      readonly status: "waiting_decision";
      readonly decision: NodeExecutionDecisionRequest;
    };

export interface NodeExecutionDecisionRequest {
  readonly question: string;
  readonly options: readonly WorkflowDecisionOption[];
  readonly recommendedOptionId?: string;
  readonly rationale?: string;
}

export interface NodeExecutor<TInput = JsonValue, TOutput = JsonValue> {
  readonly executorId: WorkflowExecutorId;
  run(
    context: NodeExecutionContext<TInput>,
  ): Promise<NodeExecutionResult<TOutput>>;
}

export interface NodeExecutorRegistry {
  register(executor: NodeExecutor): void;
  get(executorId: WorkflowExecutorId): NodeExecutor | undefined;
  has(executorId: WorkflowExecutorId): boolean;
  list(): readonly NodeExecutor[];
}

export class DefaultNodeExecutorRegistry implements NodeExecutorRegistry {
  private readonly executors = new Map<WorkflowExecutorId, NodeExecutor>();

  register(executor: NodeExecutor): void {
    if (this.executors.has(executor.executorId)) {
      throw new Error(`Node executor "${executor.executorId}" is already registered`);
    }
    this.executors.set(executor.executorId, executor);
  }

  get(executorId: WorkflowExecutorId): NodeExecutor | undefined {
    return this.executors.get(executorId);
  }

  has(executorId: WorkflowExecutorId): boolean {
    return this.executors.has(executorId);
  }

  list(): readonly NodeExecutor[] {
    return [...this.executors.values()];
  }
}
