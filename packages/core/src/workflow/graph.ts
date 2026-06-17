import type {
  NormalizedWorkflowDefinition,
  NormalizedWorkflowEdge,
  WorkflowConditionId,
  WorkflowNodeId,
} from "./types.js";

export function isControlDependencyEdge(
  edge: NormalizedWorkflowEdge,
): boolean {
  return edge.kind !== "feedback";
}

export function isConditionActive(
  condition: WorkflowConditionId | undefined,
  activeConditions: ReadonlySet<WorkflowConditionId>,
): boolean {
  if (!condition) return true;
  return activeConditions.has(condition);
}

export function isFeedbackEdgeActive(
  edge: NormalizedWorkflowEdge,
  activeConditions: ReadonlySet<WorkflowConditionId>,
): boolean {
  if (edge.kind !== "feedback" || !edge.loopPolicy) return false;
  if (activeConditions.has(edge.loopPolicy.stopCondition)) return false;
  return isConditionActive(edge.condition, activeConditions);
}

export function collectLoopPolicyTargetIds(
  definition: NormalizedWorkflowDefinition,
): ReadonlySet<WorkflowNodeId> {
  const targetIds = new Set<WorkflowNodeId>();
  for (const edge of definition.edges) {
    if (!edge.loopPolicy) continue;
    targetIds.add(edge.loopPolicy.failureExitNodeId);
    if (edge.loopPolicy.decisionNodeId) {
      targetIds.add(edge.loopPolicy.decisionNodeId);
    }
  }
  return targetIds;
}
