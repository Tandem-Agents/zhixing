import type {
  JsonValue,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
  WorkflowExecutorId,
} from "@zhixing/core";
import { parseJoinNodeExecutorConfig } from "./config.js";
import { canceledResult, failedResult } from "./result.js";

export const DEFAULT_JOIN_NODE_EXECUTOR_ID = "workflow.join";

export class JoinNodeExecutor implements NodeExecutor<JsonValue, JsonValue> {
  readonly executorId: WorkflowExecutorId;

  constructor(executorId: WorkflowExecutorId = DEFAULT_JOIN_NODE_EXECUTOR_ID) {
    this.executorId = executorId;
  }

  async run(
    context: NodeExecutionContext<JsonValue>,
  ): Promise<NodeExecutionResult<JsonValue>> {
    if (context.signal?.aborted) {
      return canceledResult(context.signal.reason);
    }

    try {
      const config = parseJoinNodeExecutorConfig(context.node.executor.config);
      const output: Record<string, JsonValue> = {
        kind: "join",
      };
      if (config.label) output["label"] = config.label;
      if (config.includeInput) output["input"] = context.input;
      if (config.metadata) output["metadata"] = config.metadata;
      return { status: "succeeded", output };
    } catch (error) {
      return failedResult("workflow.join_config_invalid", error, false);
    }
  }
}
