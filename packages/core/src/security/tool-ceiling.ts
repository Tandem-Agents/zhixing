import type { ToolDefinition } from "../types/tools.js";

/** An immutable, non-escalatable ceiling issued by trusted runtime assembly. */
export interface ToolExecutionCeiling {
  permits(tool: ToolDefinition): boolean;
}
export function restrictToolExecution(
  tools: readonly ToolDefinition[],
  parent?: ToolExecutionCeiling,
): ToolExecutionCeiling {
  const allowed = new Set(tools);
  return Object.freeze({
    permits: (tool: ToolDefinition) =>
      allowed.has(tool) && (parent?.permits(tool) ?? true),
  });
}
