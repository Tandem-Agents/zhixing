import {
  WorkflowValidationError,
  type JsonValue,
  type NormalizedWorkflowDefinition,
  type NormalizedWorkflowEdge,
  type ValidatedWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeDependency,
  type WorkflowNodeId,
  type WorkflowValidationIssue,
} from "./types.js";
import {
  collectLoopPolicyTargetIds,
  isControlDependencyEdge,
} from "./graph.js";

const DEFAULT_NODE_KINDS = [
  "agent",
  "tool",
  "gate",
  "join",
  "transform",
  "notify",
] as const;

const DEFAULT_EDGE_KINDS = ["normal", "conditional", "feedback"] as const;

const DEFAULT_POLICY_KEYS = [
  "concurrency",
  "retry",
  "risk",
  "notification",
  "feedback",
] as const;

const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
const NOTIFICATION_TARGETS = ["origin", "explicit", "none"] as const;
const NODE_INPUT_ITERATIONS = ["same", "previous"] as const;

type UnknownRecord = Record<string, unknown>;

export interface DefinitionValidatorOptions {
  readonly allowedNodeKinds?: readonly string[];
  readonly allowedEdgeKinds?: readonly string[];
  readonly allowedExecutors: readonly string[];
  readonly allowedPolicyKeys?: readonly string[];
}

export class DefinitionValidator {
  private readonly allowedNodeKinds: ReadonlySet<string>;
  private readonly allowedEdgeKinds: ReadonlySet<string>;
  private readonly allowedExecutors: ReadonlySet<string>;
  private readonly allowedPolicyKeys: ReadonlySet<string>;

  constructor(options: DefinitionValidatorOptions) {
    if (
      !Array.isArray(options?.allowedExecutors) ||
      options.allowedExecutors.length === 0 ||
      options.allowedExecutors.some((executorId) => !isNonEmptyString(executorId))
    ) {
      throw new Error("DefinitionValidator requires a non-empty executor allowlist");
    }
    this.allowedNodeKinds = new Set(
      options.allowedNodeKinds ?? DEFAULT_NODE_KINDS,
    );
    this.allowedEdgeKinds = new Set(
      options.allowedEdgeKinds ?? DEFAULT_EDGE_KINDS,
    );
    this.allowedExecutors = new Set(options.allowedExecutors);
    this.allowedPolicyKeys = new Set(
      options.allowedPolicyKeys ?? DEFAULT_POLICY_KEYS,
    );
  }

  validate(definition: WorkflowDefinition): ValidatedWorkflowDefinition {
    const issues: WorkflowValidationIssue[] = [];

    if (!isRecord(definition)) {
      throw new WorkflowValidationError([
        issue(
          "definition.invalid",
          "Workflow definition must be an object",
          "definition",
        ),
      ]);
    }

    if (!isNonEmptyString(definition.id)) {
      issues.push(issue("definition.id.required", "Workflow id is required", "id"));
    }
    if (!isNonEmptyString(definition.name)) {
      issues.push(
        issue("definition.name.required", "Workflow name is required", "name"),
      );
    }
    if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) {
      issues.push(
        issue("definition.nodes.required", "Workflow must contain nodes", "nodes"),
      );
    }
    if (!Array.isArray(definition.edges)) {
      issues.push(
        issue("definition.edges.required", "Workflow edges must be an array", "edges"),
      );
    }

    const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
    const edges = Array.isArray(definition.edges) ? definition.edges : [];

    this.validateContract(definition.inputContract, "inputContract", issues);
    this.validateContract(definition.outputContract, "outputContract", issues);
    this.validatePolicies(definition.policies, issues);

    const nodeIds = this.validateNodes(nodes, issues);
    const normalizedEdges = this.validateEdges(
      edges,
      nodeIds,
      issues,
      globalFeedbackMaxIterations(definition.policies),
    );

    if (issues.length === 0) {
      this.validateInputSources(nodes, normalizedEdges, issues);
      this.validateAcyclicControlledGraph(normalizedEdges, issues);
    }

    if (issues.length > 0) throw new WorkflowValidationError(issues);

    const normalized: NormalizedWorkflowDefinition = {
      ...definition,
      edges: normalizedEdges,
    };

    const dependencies = deriveDependencies(nodes, normalizedEdges);
    const loopPolicyTargetIds = collectLoopPolicyTargetIds(normalized);

    return {
      definition: normalized,
      dependencies,
      entryNodeIds: dependencies
        .filter(
          (dep) =>
            dep.upstreamNodeIds.length === 0 &&
            !loopPolicyTargetIds.has(dep.nodeId),
        )
        .map((dep) => dep.nodeId),
    };
  }

  private validateContract(
    contract: unknown,
    path: string,
    issues: WorkflowValidationIssue[],
  ): void {
    if (contract === undefined) return;
    if (!isRecord(contract)) {
      issues.push(issue("contract.invalid", `${path} must be an object`, path));
      return;
    }

    assertJsonValue(contract.schema, `${path}.schema`, issues);
    const requiredKeys = contract.requiredKeys;
    if (
      requiredKeys !== undefined &&
      (!Array.isArray(requiredKeys) ||
        requiredKeys.some((key) => !isNonEmptyString(key)))
    ) {
      issues.push(
        issue(
          "contract.requiredKeys.invalid",
          `${path}.requiredKeys must be an array of non-empty strings`,
          `${path}.requiredKeys`,
        ),
      );
    }
  }

  private validatePolicies(
    policies: unknown,
    issues: WorkflowValidationIssue[],
  ): void {
    if (policies === undefined) return;
    if (!isRecord(policies)) {
      issues.push(issue("policies.invalid", "policies must be an object", "policies"));
      return;
    }

    for (const key of Object.keys(policies)) {
      if (!this.allowedPolicyKeys.has(key)) {
        issues.push(
          issue(
            "policy.unknown",
            `Policy "${key}" is not allowed`,
            `policies.${key}`,
          ),
        );
      }
    }

    const concurrency = policies.concurrency;
    if (concurrency !== undefined && !isRecord(concurrency)) {
      issues.push(
        issue(
          "policy.concurrency.invalid",
          "concurrency must be an object",
          "policies.concurrency",
        ),
      );
    }
    const maxParallel = isRecord(concurrency)
      ? concurrency.maxParallelNodes
      : undefined;
    if (maxParallel !== undefined && !isPositiveInteger(maxParallel)) {
      issues.push(
        issue(
          "policy.concurrency.invalid",
          "concurrency.maxParallelNodes must be a positive integer",
          "policies.concurrency.maxParallelNodes",
        ),
      );
    }

    const retry = policies.retry;
    if (retry !== undefined && !isRecord(retry)) {
      issues.push(
        issue("policy.retry.invalid", "retry must be an object", "policies.retry"),
      );
    }
    const maxAttempts = isRecord(retry) ? retry.maxAttempts : undefined;
    if (maxAttempts !== undefined && !isPositiveInteger(maxAttempts)) {
      issues.push(
        issue(
          "policy.retry.invalid",
          "retry.maxAttempts must be a positive integer",
          "policies.retry.maxAttempts",
        ),
      );
    }

    const feedback = policies.feedback;
    if (feedback !== undefined && !isRecord(feedback)) {
      issues.push(
        issue(
          "policy.feedback.invalid",
          "feedback must be an object",
          "policies.feedback",
        ),
      );
    }
    const maxIterations = isRecord(feedback) ? feedback.maxIterations : undefined;
    if (maxIterations !== undefined && !isPositiveInteger(maxIterations)) {
      issues.push(
        issue(
          "policy.feedback.invalid",
          "feedback.maxIterations must be a positive integer",
          "policies.feedback.maxIterations",
        ),
      );
    }

    this.validateRiskPolicy(policies.risk, "policies.risk", issues);
    this.validateNotificationPolicy(
      policies.notification,
      "policies.notification",
      issues,
    );
  }

  private validateNodes(
    nodes: readonly unknown[],
    issues: WorkflowValidationIssue[],
  ): Set<WorkflowNodeId> {
    const nodeIds = new Set<WorkflowNodeId>();

    nodes.forEach((entry, index) => {
      const path = `nodes.${index}`;
      if (!isRecord(entry)) {
        issues.push(issue("node.invalid", "Node must be an object", path));
        return;
      }
      const node = entry;
      if (!isNonEmptyString(node.nodeId)) {
        issues.push(
          issue("node.id.required", "Node id is required", `${path}.nodeId`),
        );
      } else if (nodeIds.has(node.nodeId)) {
        issues.push(
          issue(
            "node.id.duplicate",
            `Node id "${node.nodeId}" is duplicated`,
            `${path}.nodeId`,
          ),
        );
      } else {
        nodeIds.add(node.nodeId);
      }

      if (
        !isNonEmptyString(node.kind) ||
        !this.allowedNodeKinds.has(node.kind)
      ) {
        issues.push(
          issue(
            "node.kind.invalid",
            `Node kind "${node.kind}" is not allowed`,
            `${path}.kind`,
          ),
        );
      }

      const executor = node.executor;
      if (!isRecord(executor)) {
        issues.push(
          issue(
            "node.executor.required",
            "Node executor must be an object",
            `${path}.executor`,
          ),
        );
      } else if (!isNonEmptyString(executor.executorId)) {
        issues.push(
          issue(
            "node.executor.required",
            "Node executorId is required",
            `${path}.executor.executorId`,
          ),
        );
      } else if (!this.allowedExecutors.has(executor.executorId)) {
        issues.push(
          issue(
            "node.executor.invalid",
            `Executor "${executor.executorId}" is not allowed`,
            `${path}.executor.executorId`,
          ),
        );
      }

      if (isRecord(executor)) {
        assertJsonValue(executor.config, `${path}.executor.config`, issues);
      }
      this.validateContract(node.inputContract, `${path}.inputContract`, issues);
      this.validateContract(node.outputContract, `${path}.outputContract`, issues);
      this.validateInputFromShape(node.inputFrom, path, issues);
      this.validateNodePolicies(node, path, issues);
    });

    return nodeIds;
  }

  private validateNodePolicies(
    node: UnknownRecord,
    path: string,
    issues: WorkflowValidationIssue[],
  ): void {
    const retryPolicy = node.retryPolicy;
    if (retryPolicy !== undefined && !isRecord(retryPolicy)) {
      issues.push(
        issue(
          "node.retry.invalid",
          "retryPolicy must be an object",
          `${path}.retryPolicy`,
        ),
      );
    }
    const maxAttempts = isRecord(retryPolicy)
      ? retryPolicy.maxAttempts
      : undefined;
    if (maxAttempts !== undefined && !isPositiveInteger(maxAttempts)) {
      issues.push(
        issue(
          "node.retry.invalid",
          "retryPolicy.maxAttempts must be a positive integer",
          `${path}.retryPolicy.maxAttempts`,
        ),
      );
    }
    this.validateRiskPolicy(node.riskPolicy, `${path}.riskPolicy`, issues);
  }

  private validateRiskPolicy(
    policy: unknown,
    path: string,
    issues: WorkflowValidationIssue[],
  ): void {
    if (policy === undefined) return;
    if (!isRecord(policy)) {
      issues.push(issue("risk.invalid", `${path} must be an object`, path));
      return;
    }
    if (
      policy.requiresDecision !== undefined &&
      typeof policy.requiresDecision !== "boolean"
    ) {
      issues.push(
        issue(
          "risk.requiresDecision.invalid",
          "requiresDecision must be a boolean",
          `${path}.requiresDecision`,
        ),
      );
    }
    if (
      policy.riskLevel !== undefined &&
      !isOneOf(policy.riskLevel, RISK_LEVELS)
    ) {
      issues.push(
        issue(
          "risk.level.invalid",
          `riskLevel "${policy.riskLevel}" is not allowed`,
          `${path}.riskLevel`,
        ),
      );
    }
  }

  private validateNotificationPolicy(
    policy: unknown,
    path: string,
    issues: WorkflowValidationIssue[],
  ): void {
    if (policy === undefined) return;
    if (!isRecord(policy)) {
      issues.push(
        issue("notification.invalid", `${path} must be an object`, path),
      );
      return;
    }
    if (
      policy.target !== undefined &&
      !isOneOf(policy.target, NOTIFICATION_TARGETS)
    ) {
      issues.push(
        issue(
          "notification.target.invalid",
          `notification target "${policy.target}" is not allowed`,
          `${path}.target`,
        ),
      );
    }
  }

  private validateInputFromShape(
    inputFrom: unknown,
    nodePath: string,
    issues: WorkflowValidationIssue[],
  ): void {
    if (inputFrom === undefined) return;
    const path = `${nodePath}.inputFrom`;
    if (!Array.isArray(inputFrom)) {
      issues.push(issue("node.inputFrom.invalid", "inputFrom must be an array", path));
      return;
    }

    inputFrom.forEach((source, index) => {
      const sourcePath = `${path}.${index}`;
      if (!isRecord(source)) {
        issues.push(
          issue("node.inputFrom.invalid", "Input source must be an object", sourcePath),
        );
        return;
      }
      if (!isOneOf(source.kind, ["instance", "node", "constant"] as const)) {
        issues.push(
          issue(
            "node.inputFrom.kind.invalid",
            `Input source kind "${String(source.kind)}" is not allowed`,
            `${sourcePath}.kind`,
          ),
        );
      }
      if (source.kind === "instance" && !isNonEmptyString(source.key)) {
        issues.push(
          issue(
            "node.inputFrom.instanceKey.required",
            "Instance input source key is required",
            `${sourcePath}.key`,
          ),
        );
      }
      if (source.kind === "node" && !isNonEmptyString(source.nodeId)) {
        issues.push(
          issue(
            "node.inputFrom.nodeId.required",
            "Node input source nodeId is required",
            `${sourcePath}.nodeId`,
          ),
        );
      }
      if (
        source.kind === "node" &&
        source.artifactKey !== undefined &&
        !isNonEmptyString(source.artifactKey)
      ) {
        issues.push(
          issue(
            "node.inputFrom.artifactKey.invalid",
            "Node input source artifactKey must be a non-empty string",
            `${sourcePath}.artifactKey`,
          ),
        );
      }
      if (
        source.kind === "node" &&
        source.iteration !== undefined &&
        !isOneOf(source.iteration, NODE_INPUT_ITERATIONS)
      ) {
        issues.push(
          issue(
            "node.inputFrom.iteration.invalid",
            `Node input source iteration "${String(source.iteration)}" is not allowed`,
            `${sourcePath}.iteration`,
          ),
        );
      }
      if (
        source.kind === "node" &&
        source.optional !== undefined &&
        typeof source.optional !== "boolean"
      ) {
        issues.push(
          issue(
            "node.inputFrom.optional.invalid",
            "Node input source optional must be a boolean",
            `${sourcePath}.optional`,
          ),
        );
      }
      if (
        source.kind === "node" &&
        source.iteration === "previous" &&
        source.optional !== true
      ) {
        issues.push(
          issue(
            "node.inputFrom.previous.optionalRequired",
            "Previous-iteration node input source must be explicitly optional",
            `${sourcePath}.optional`,
          ),
        );
      }
      if (source.kind === "constant") {
        assertJsonValue(source.value, `${sourcePath}.value`, issues);
      }
    });
  }

  private validateEdges(
    edges: readonly unknown[],
    nodeIds: ReadonlySet<WorkflowNodeId>,
    issues: WorkflowValidationIssue[],
    globalFeedbackMaxIterations: number | undefined,
  ): NormalizedWorkflowEdge[] {
    const edgeIds = new Set<string>();
    const normalizedEdges: NormalizedWorkflowEdge[] = [];
    edges.forEach((entry, index) => {
      const path = `edges.${index}`;
      if (!isRecord(entry)) {
        issues.push(issue("edge.invalid", "Edge must be an object", path));
        return;
      }
      const edge = entry;
      const edgeId = isNonEmptyString(edge.edgeId)
        ? edge.edgeId
        : `${String(edge.from)}->${String(edge.to)}:${String(edge.kind)}:${index}`;

      if (edge.edgeId !== undefined && !isNonEmptyString(edge.edgeId)) {
        issues.push(issue("edge.id.required", "Edge id is required", `${path}.edgeId`));
      } else if (edgeIds.has(edgeId)) {
        issues.push(
          issue("edge.id.duplicate", `Edge id "${edgeId}" is duplicated`, `${path}.edgeId`),
        );
      } else {
        edgeIds.add(edgeId);
      }

      if (!isNonEmptyString(edge.from) || !nodeIds.has(edge.from)) {
        issues.push(
          issue(
            "edge.from.unknown",
            `Edge source "${edge.from}" does not exist`,
            `${path}.from`,
          ),
        );
      }
      if (!isNonEmptyString(edge.to) || !nodeIds.has(edge.to)) {
        issues.push(
          issue(
            "edge.to.unknown",
            `Edge target "${edge.to}" does not exist`,
            `${path}.to`,
          ),
        );
      }
      if (
        !isNonEmptyString(edge.kind) ||
        !this.allowedEdgeKinds.has(edge.kind)
      ) {
        issues.push(
          issue(
            "edge.kind.invalid",
            `Edge kind "${edge.kind}" is not allowed`,
            `${path}.kind`,
          ),
        );
      }
      if (edge.condition !== undefined && !isNonEmptyString(edge.condition)) {
        issues.push(
          issue(
            "edge.condition.invalid",
            "Edge condition must be a non-empty string",
            `${path}.condition`,
          ),
        );
      }

      if (edge.kind === "feedback") {
        this.validateLoopPolicy(
          edge,
          nodeIds,
          path,
          issues,
          globalFeedbackMaxIterations,
        );
      } else if (edge.loopPolicy !== undefined) {
        issues.push(
          issue(
            "edge.loopPolicy.invalid",
            "loopPolicy is only allowed on feedback edges",
            `${path}.loopPolicy`,
          ),
        );
      }

      normalizedEdges.push({ ...edge, edgeId } as NormalizedWorkflowEdge);
    });
    return normalizedEdges;
  }

  private validateLoopPolicy(
    edge: UnknownRecord,
    nodeIds: ReadonlySet<WorkflowNodeId>,
    path: string,
    issues: WorkflowValidationIssue[],
    globalFeedbackMaxIterations: number | undefined,
  ): void {
    const policy = edge.loopPolicy;
    if (policy === undefined) {
      issues.push(
        issue(
          "edge.feedback.loopPolicy.required",
          "feedback edge requires loopPolicy",
          `${path}.loopPolicy`,
        ),
      );
      return;
    }
    if (!isRecord(policy)) {
      issues.push(
        issue(
          "edge.feedback.loopPolicy.invalid",
          "loopPolicy must be an object",
          `${path}.loopPolicy`,
        ),
      );
      return;
    }

    if (!isPositiveInteger(policy.maxIterations)) {
      issues.push(
        issue(
          "edge.feedback.maxIterations.invalid",
          "loopPolicy.maxIterations must be a positive integer",
          `${path}.loopPolicy.maxIterations`,
        ),
      );
    } else if (
      globalFeedbackMaxIterations !== undefined &&
      policy.maxIterations > globalFeedbackMaxIterations
    ) {
      issues.push(
        issue(
          "edge.feedback.maxIterations.exceedsPolicy",
          "loopPolicy.maxIterations must not exceed policies.feedback.maxIterations",
          `${path}.loopPolicy.maxIterations`,
        ),
      );
    }
    if (!isNonEmptyString(policy.stopCondition)) {
      issues.push(
        issue(
          "edge.feedback.stopCondition.required",
          "loopPolicy.stopCondition is required",
          `${path}.loopPolicy.stopCondition`,
        ),
      );
    }
    if (
      !isNonEmptyString(policy.failureExitNodeId) ||
      !nodeIds.has(policy.failureExitNodeId)
    ) {
      issues.push(
        issue(
          "edge.feedback.failureExit.unknown",
          `failureExitNodeId "${policy.failureExitNodeId}" does not exist`,
          `${path}.loopPolicy.failureExitNodeId`,
        ),
      );
    }
    if (
      policy.decisionNodeId !== undefined &&
      (!isNonEmptyString(policy.decisionNodeId) ||
        !nodeIds.has(policy.decisionNodeId))
    ) {
      issues.push(
        issue(
          "edge.feedback.decision.unknown",
          `decisionNodeId "${policy.decisionNodeId}" does not exist`,
          `${path}.loopPolicy.decisionNodeId`,
        ),
      );
    }
  }

  private validateInputSources(
    nodes: readonly WorkflowNode[],
    edges: readonly NormalizedWorkflowEdge[],
    issues: WorkflowValidationIssue[],
  ): void {
    const nodeIds = new Set(nodes.map((node) => node.nodeId));
    const upstreamClosure = buildUpstreamClosure(nodes, edges);

    nodes.forEach((node, index) => {
      const path = `nodes.${index}.inputFrom`;
      node.inputFrom?.forEach((source, sourceIndex) => {
        const sourcePath = `${path}.${sourceIndex}`;
        if (source.kind === "node") {
          if (!nodeIds.has(source.nodeId)) {
            issues.push(
              issue(
                "node.inputFrom.unknown",
                `Input source node "${source.nodeId}" does not exist`,
                `${sourcePath}.nodeId`,
              ),
            );
            return;
          }
          const iteration = source.iteration ?? "same";
          const sourceAllowed =
            iteration === "previous"
              ? isDirectFeedbackSource(source.nodeId, node.nodeId, edges)
              : upstreamClosure.get(node.nodeId)?.has(source.nodeId) ||
                isLoopPolicyTargetInput(source.nodeId, node.nodeId, edges);

          if (!sourceAllowed) {
            issues.push(
              issue(
                "node.inputFrom.notUpstream",
                `Input source node "${source.nodeId}" is not upstream of "${node.nodeId}"`,
                `${sourcePath}.nodeId`,
              ),
            );
          }
        }
        if (source.kind === "constant") {
          assertJsonValue(source.value, `${sourcePath}.value`, issues);
        }
        if (source.kind === "instance" && !isNonEmptyString(source.key)) {
          issues.push(
            issue(
              "node.inputFrom.instanceKey.required",
              "Instance input source key is required",
              `${sourcePath}.key`,
            ),
          );
        }
      });
    });
  }

  private validateAcyclicControlledGraph(
    edges: readonly NormalizedWorkflowEdge[],
    issues: WorkflowValidationIssue[],
  ): void {
    const normalEdges = edges.filter((edge) => edge.kind !== "feedback");
    const adjacency = new Map<WorkflowNodeId, WorkflowNodeId[]>();
    for (const edge of normalEdges) {
      const next = adjacency.get(edge.from) ?? [];
      next.push(edge.to);
      adjacency.set(edge.from, next);
    }

    const visiting = new Set<WorkflowNodeId>();
    const visited = new Set<WorkflowNodeId>();
    const visit = (nodeId: WorkflowNodeId): boolean => {
      if (visiting.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;
      visiting.add(nodeId);
      for (const next of adjacency.get(nodeId) ?? []) {
        if (visit(next)) return true;
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
      return false;
    };

    for (const nodeId of adjacency.keys()) {
      if (visit(nodeId)) {
        issues.push(
          issue(
            "edge.cycle.uncontrolled",
            "Non-feedback edges must not form cycles",
            "edges",
          ),
        );
        return;
      }
    }
  }
}

export function deriveDependencies(
  nodes: readonly WorkflowNode[],
  edges: readonly NormalizedWorkflowEdge[],
): WorkflowNodeDependency[] {
  return nodes.map((node) => ({
    nodeId: node.nodeId,
    upstreamNodeIds: [
      ...new Set(
        edges
          .filter((edge) => edge.to === node.nodeId && isControlDependencyEdge(edge))
          .map((edge) => edge.from),
      ),
    ],
  }));
}

function buildUpstreamClosure(
  nodes: readonly WorkflowNode[],
  edges: readonly NormalizedWorkflowEdge[],
): Map<WorkflowNodeId, Set<WorkflowNodeId>> {
  const reverse = new Map<WorkflowNodeId, WorkflowNodeId[]>();
  for (const node of nodes) reverse.set(node.nodeId, []);
  for (const edge of edges.filter(isControlDependencyEdge)) {
    reverse.get(edge.to)?.push(edge.from);
  }

  const closure = new Map<WorkflowNodeId, Set<WorkflowNodeId>>();
  const collect = (nodeId: WorkflowNodeId, seen = new Set<WorkflowNodeId>()) => {
    for (const upstream of reverse.get(nodeId) ?? []) {
      if (seen.has(upstream)) continue;
      seen.add(upstream);
      collect(upstream, seen);
    }
    return seen;
  };

  for (const node of nodes) closure.set(node.nodeId, collect(node.nodeId));
  return closure;
}

function isDirectFeedbackSource(
  sourceNodeId: WorkflowNodeId,
  targetNodeId: WorkflowNodeId,
  edges: readonly NormalizedWorkflowEdge[],
): boolean {
  return edges.some(
    (edge) =>
      edge.kind === "feedback" &&
      edge.from === sourceNodeId &&
      edge.to === targetNodeId,
  );
}

function isLoopPolicyTargetInput(
  sourceNodeId: WorkflowNodeId,
  targetNodeId: WorkflowNodeId,
  edges: readonly NormalizedWorkflowEdge[],
): boolean {
  return edges.some(
    (edge) =>
      edge.kind === "feedback" &&
      edge.from === sourceNodeId &&
      (edge.loopPolicy?.failureExitNodeId === targetNodeId ||
        edge.loopPolicy?.decisionNodeId === targetNodeId),
  );
}

function globalFeedbackMaxIterations(policies: unknown): number | undefined {
  if (!isRecord(policies) || !isRecord(policies.feedback)) return undefined;
  const maxIterations = policies.feedback.maxIterations;
  return isPositiveInteger(maxIterations) ? maxIterations : undefined;
}

function assertJsonValue(
  value: unknown,
  path: string,
  issues: WorkflowValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isJsonValue(value, new Set())) {
    issues.push(
      issue("json.invalid", `${path} must be JSON-serializable`, path),
    );
  }
}

function isJsonValue(value: unknown, seen: Set<object>): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((entry) => isJsonValue(entry, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return false;
    seen.add(value as object);
    return Object.values(value as Record<string, unknown>).every((entry) =>
      isJsonValue(entry, seen),
    );
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function issue(
  code: string,
  message: string,
  path?: string,
): WorkflowValidationIssue {
  return { code, message, path };
}
