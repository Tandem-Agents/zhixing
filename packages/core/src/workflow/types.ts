export type WorkflowId = string;
export type WorkflowInstanceId = string;
export type WorkflowNodeId = string;
export type WorkflowEdgeId = string;
export type WorkflowNodeRunId = string;
export type WorkflowDecisionId = string;
export type WorkflowArtifactId = string;
export type WorkflowExecutorId = string;
export type WorkflowConditionId = string;

export type WorkflowNodeKind =
  | "agent"
  | "tool"
  | "gate"
  | "join"
  | "transform"
  | "notify";

export type WorkflowEdgeKind = "normal" | "conditional" | "feedback";

export type WorkflowInstanceStatus =
  | "created"
  | "running"
  | "waiting_decision"
  | "succeeded"
  | "failed"
  | "canceled";

export type WorkflowNodeRunStatus =
  | "ready"
  | "running"
  | "waiting_decision"
  | "succeeded"
  | "failed"
  | "canceled"
  | "skipped";

export type WorkflowDecisionActor = "human" | "agent" | "rule";

export type WorkflowNodeInputIteration = "same" | "previous";

export interface WorkflowActiveCondition {
  readonly conditionId: WorkflowConditionId;
  readonly nodeId?: WorkflowNodeId;
  readonly iteration?: number;
  readonly nodeRunId?: WorkflowNodeRunId;
}

export type WorkflowInputSource =
  | { kind: "instance"; key: string }
  | {
      kind: "node";
      nodeId: WorkflowNodeId;
      artifactKey?: string;
      iteration?: WorkflowNodeInputIteration;
      optional?: boolean;
    }
  | { kind: "constant"; value: JsonValue };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface WorkflowDataContract {
  readonly schema?: JsonValue;
  readonly requiredKeys?: readonly string[];
}

export interface WorkflowExecutorRef {
  readonly executorId: WorkflowExecutorId;
  readonly config?: JsonValue;
}

export interface WorkflowRetryPolicy {
  readonly maxAttempts: number;
}

export interface WorkflowRiskPolicy {
  readonly requiresDecision?: boolean;
  readonly riskLevel?: "low" | "medium" | "high" | "critical";
}

export interface WorkflowNotificationPolicy {
  readonly target?: "origin" | "explicit" | "none";
}

export interface WorkflowLoopPolicy {
  readonly maxIterations: number;
  readonly stopCondition: WorkflowConditionId;
  readonly failureExitNodeId: WorkflowNodeId;
  readonly decisionNodeId?: WorkflowNodeId;
}

export interface WorkflowPolicies {
  readonly concurrency?: {
    readonly maxParallelNodes?: number;
  };
  readonly retry?: WorkflowRetryPolicy;
  readonly risk?: WorkflowRiskPolicy;
  readonly notification?: WorkflowNotificationPolicy;
  readonly feedback?: {
    readonly maxIterations?: number;
  };
}

export interface WorkflowNode {
  readonly nodeId: WorkflowNodeId;
  readonly kind: WorkflowNodeKind;
  readonly executor: WorkflowExecutorRef;
  readonly inputFrom?: readonly WorkflowInputSource[];
  readonly inputContract?: WorkflowDataContract;
  readonly outputContract?: WorkflowDataContract;
  readonly retryPolicy?: WorkflowRetryPolicy;
  readonly riskPolicy?: WorkflowRiskPolicy;
}

export interface WorkflowEdge {
  readonly edgeId?: WorkflowEdgeId;
  readonly from: WorkflowNodeId;
  readonly to: WorkflowNodeId;
  readonly kind: WorkflowEdgeKind;
  readonly condition?: WorkflowConditionId;
  readonly loopPolicy?: WorkflowLoopPolicy;
}

export interface NormalizedWorkflowEdge extends WorkflowEdge {
  readonly edgeId: WorkflowEdgeId;
}

export interface WorkflowDefinition {
  readonly id: WorkflowId;
  readonly name: string;
  readonly description?: string;
  readonly inputContract?: WorkflowDataContract;
  readonly outputContract?: WorkflowDataContract;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly policies?: WorkflowPolicies;
}

export interface NormalizedWorkflowDefinition
  extends Omit<WorkflowDefinition, "edges"> {
  readonly edges: readonly NormalizedWorkflowEdge[];
}

export interface WorkflowNodeDependency {
  readonly nodeId: WorkflowNodeId;
  readonly upstreamNodeIds: readonly WorkflowNodeId[];
}

export interface ValidatedWorkflowDefinition {
  readonly definition: NormalizedWorkflowDefinition;
  readonly dependencies: readonly WorkflowNodeDependency[];
  readonly entryNodeIds: readonly WorkflowNodeId[];
}

export interface WorkflowArtifact {
  readonly artifactId: WorkflowArtifactId;
  readonly nodeRunId: WorkflowNodeRunId;
  readonly key: string;
  readonly value: JsonValue;
  readonly createdAt: string;
}

export interface WorkflowError {
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
}

export interface WorkflowNodeRun {
  readonly nodeRunId: WorkflowNodeRunId;
  readonly nodeId: WorkflowNodeId;
  readonly iteration: number;
  readonly attempt: number;
  readonly triggeredByEdgeId?: WorkflowEdgeId;
  readonly status: WorkflowNodeRunStatus;
  readonly inputArtifactRefs?: readonly WorkflowArtifactId[];
  readonly outputArtifactRefs?: readonly WorkflowArtifactId[];
  readonly error?: WorkflowError;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface WorkflowDecisionOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export interface WorkflowDecisionRecord {
  readonly decisionId: WorkflowDecisionId;
  readonly nodeRunId: WorkflowNodeRunId;
  readonly nodeId: WorkflowNodeId;
  readonly question: string;
  readonly options: readonly WorkflowDecisionOption[];
  readonly recommendedOptionId?: string;
  readonly actor?: WorkflowDecisionActor;
  readonly resultOptionId?: string;
  readonly rationale?: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

export interface WorkflowInstance {
  readonly instanceId: WorkflowInstanceId;
  readonly conversationId: string;
  readonly origin?: JsonValue;
  readonly goal: string;
  readonly input: JsonValue;
  readonly definition: NormalizedWorkflowDefinition;
  readonly definitionId?: WorkflowId;
  readonly status: WorkflowInstanceStatus;
  readonly nodeRuns: readonly WorkflowNodeRun[];
  readonly decisions: readonly WorkflowDecisionRecord[];
  readonly artifacts: readonly WorkflowArtifact[];
  readonly errors: readonly WorkflowError[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export class WorkflowValidationError extends Error {
  readonly issues: readonly WorkflowValidationIssue[];

  constructor(issues: readonly WorkflowValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export interface WorkflowScheduleEntry {
  readonly nodeId: WorkflowNodeId;
  readonly iteration: number;
  readonly attempt: number;
  readonly triggeredByEdgeId?: WorkflowEdgeId;
  readonly reason: "start" | "retry" | "feedback" | "loop_exit";
}

export interface WorkflowBlockedNode {
  readonly nodeId: WorkflowNodeId;
  readonly iteration: number;
  readonly reason:
    | "waiting_dependencies"
    | "active_run_exists"
    | "already_succeeded"
    | "terminal_run_exists"
    | "waiting_decision"
    | "max_attempts_reached"
    | "loop_limit_reached"
    | "concurrency_limit_reached";
}

export interface WorkflowSchedulePlan {
  readonly ready: readonly WorkflowScheduleEntry[];
  readonly blocked: readonly WorkflowBlockedNode[];
}

export interface WorkflowSchedulerInput {
  readonly validated: ValidatedWorkflowDefinition;
  readonly nodeRuns: readonly WorkflowNodeRun[];
  readonly activeConditionIds?: readonly WorkflowConditionId[];
  readonly activeConditions?: readonly WorkflowActiveCondition[];
}
