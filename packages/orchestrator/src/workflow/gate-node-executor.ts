import type {
  JsonValue,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
  WorkflowExecutorId,
} from "@zhixing/core";
import { parseGateNodeExecutorConfig } from "./config.js";
import { canceledResult, failedResult } from "./result.js";

export const DEFAULT_GATE_NODE_EXECUTOR_ID = "workflow.gate";

export class GateNodeExecutor implements NodeExecutor<JsonValue, JsonValue> {
  readonly executorId: WorkflowExecutorId;

  constructor(executorId: WorkflowExecutorId = DEFAULT_GATE_NODE_EXECUTOR_ID) {
    this.executorId = executorId;
  }

  async run(
    context: NodeExecutionContext<JsonValue>,
  ): Promise<NodeExecutionResult<JsonValue>> {
    if (context.signal?.aborted) {
      return canceledResult(context.signal.reason);
    }

    try {
      const config = parseGateNodeExecutorConfig(context.node.executor.config);
      return {
        status: "waiting_decision",
        decision: {
          question: config.question,
          options: config.options,
          recommendedOptionId: config.recommendedOptionId,
          rationale: buildRationale(config.rationale, {
            includeInput: config.includeInputInRationale,
            input: context.input,
          }),
        },
      };
    } catch (error) {
      return failedResult("workflow.gate_config_invalid", error, false);
    }
  }
}

function buildRationale(
  rationale: string | undefined,
  input: { readonly includeInput: boolean; readonly input: JsonValue },
): string | undefined {
  if (!input.includeInput) return rationale;
  const sections = [];
  if (rationale && rationale.trim().length > 0) sections.push(rationale.trim());
  sections.push("Input evidence JSON:", JSON.stringify(input.input, null, 2));
  return sections.join("\n");
}
