import { deepFreeze } from "./internal.js";
import type {
  NormalizedOrchestrationDefinitionV1,
  OrchestrationPlanV1,
} from "./types.js";

export function planOrchestrationV1(
  definition: NormalizedOrchestrationDefinitionV1,
): OrchestrationPlanV1 {
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};

  for (const nodeId of definition.nodeIds) {
    dependencies[nodeId] = [...definition.nodesById[nodeId]!.dependsOn];
    dependents[nodeId] = [];
  }

  for (const nodeId of definition.nodeIds) {
    for (const dependency of dependencies[nodeId] ?? []) {
      dependents[dependency]!.push(nodeId);
    }
  }

  const completed = new Set<string>();
  const topologicalOrder: string[] = [];

  while (topologicalOrder.length < definition.nodeIds.length) {
    const next = definition.nodeIds.find((nodeId) => {
      if (completed.has(nodeId)) return false;
      const deps = dependencies[nodeId] ?? [];
      return deps.every((dependency) => completed.has(dependency));
    });

    if (next === undefined) {
      throw new Error("Cannot plan orchestration with cyclic dependencies.");
    }

    completed.add(next);
    topologicalOrder.push(next);
  }

  const rootNodeIds = definition.nodeIds.filter(
    (nodeId) => (dependencies[nodeId] ?? []).length === 0,
  );

  return deepFreeze({
    topologicalOrder,
    rootNodeIds,
    dependencies,
    dependents,
  });
}
