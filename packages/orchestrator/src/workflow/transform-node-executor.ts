import type {
  JsonValue,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
  WorkflowExecutorId,
} from "@zhixing/core";
import {
  asMutableToolInput,
  parseTransformNodeExecutorConfig,
  resolvePointer,
} from "./config.js";
import { canceledResult, failedResult } from "./result.js";

export const DEFAULT_TRANSFORM_NODE_EXECUTOR_ID = "workflow.transform";

export class TransformNodeExecutor implements NodeExecutor<JsonValue, JsonValue> {
  readonly executorId: WorkflowExecutorId;

  constructor(
    executorId: WorkflowExecutorId = DEFAULT_TRANSFORM_NODE_EXECUTOR_ID,
  ) {
    this.executorId = executorId;
  }

  async run(
    context: NodeExecutionContext<JsonValue>,
  ): Promise<NodeExecutionResult<JsonValue>> {
    if (context.signal?.aborted) {
      return canceledResult(context.signal.reason);
    }

    try {
      const config = parseTransformNodeExecutorConfig(context.node.executor.config);
      const output = asMutableToolInput(config.output) as Record<string, JsonValue>;
      for (const [targetKey, pointer] of Object.entries(config.inputPointers)) {
        output[targetKey] = resolvePointer(context.input, pointer);
      }
      if (config.includeInput) output["input"] = context.input;
      return { status: "succeeded", output };
    } catch (error) {
      return failedResult("workflow.transform_config_invalid", error, false);
    }
  }
}
