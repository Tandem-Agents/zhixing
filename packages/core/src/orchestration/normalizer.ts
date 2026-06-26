import { cloneData, deepFreeze } from "./internal.js";
import type {
  NormalizedOrchestrationDefinitionV1,
  NormalizedOrchestrationNodeV1,
  OrchestrationDefinitionV1,
  OrchestrationSystemCapsV1,
} from "./types.js";

export function normalizeOrchestrationDefinitionV1(
  definition: OrchestrationDefinitionV1,
  caps: OrchestrationSystemCapsV1,
): NormalizedOrchestrationDefinitionV1 {
  const policy = definition.policy;
  const normalizedPolicy = {
    maxParallel: policy.maxParallel,
    maxRunMs: policy.maxRunMs,
    defaultNodeTimeoutMs: policy.defaultNodeTimeoutMs,
    defaultMaxTurns: policy.defaultMaxTurns,
    defaultMaxTokens: policy.defaultMaxTokens ?? caps.maxNodeTokens,
    ...(policy.contextSnapshot === undefined
      ? {}
      : {
          contextSnapshot: {
            strategy: policy.contextSnapshot.strategy,
            maxTokens:
              policy.contextSnapshot.maxTokens ??
              caps.maxContextSnapshotTokens,
          },
        }),
    allowedTools: [...policy.allowedTools],
    failureMode: policy.failureMode ?? "fail_fast",
  };

  const nodeIds: string[] = [];
  const nodesById: Record<string, NormalizedOrchestrationNodeV1> = {};

  for (const node of definition.nodes) {
    nodeIds.push(node.id);
    const context = node.context ?? {};
    const nodePolicy = node.policy ?? {};
    nodesById[node.id] = {
      id: node.id,
      kind: node.kind,
      ...(node.title === undefined ? {} : { title: node.title }),
      dependsOn: [...(node.dependsOn ?? [])],
      instruction: node.instruction,
      context: {
        includeRunInput: context.includeRunInput ?? false,
        includeContextSnapshot: context.includeContextSnapshot ?? false,
        includeNodeOutputs: Array.isArray(context.includeNodeOutputs)
          ? [...context.includeNodeOutputs]
          : context.includeNodeOutputs ?? "dependencies",
      },
      output: {
        ...cloneData(node.output),
        maxChars: node.output.maxChars ?? caps.maxOutputChars,
      },
      policy: {
        timeoutMs: nodePolicy.timeoutMs ?? policy.defaultNodeTimeoutMs,
        maxTurns: nodePolicy.maxTurns ?? policy.defaultMaxTurns,
        maxTokens:
          nodePolicy.maxTokens ??
          policy.defaultMaxTokens ??
          caps.maxNodeTokens,
        tools: [...(nodePolicy.tools ?? [])],
      },
    };
  }

  const normalized = {
    version: 1 as const,
    id: definition.id,
    title: definition.title,
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
    policy: normalizedPolicy,
    ...(definition.input === undefined
      ? {}
      : {
          input: {
            ...cloneData(definition.input),
            required: definition.input.required ?? false,
            maxChars: definition.input.maxChars ?? caps.maxInputChars,
          },
        }),
    nodeIds,
    nodesById,
  };

  return deepFreeze(normalized);
}
