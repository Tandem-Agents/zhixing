import {
  formatAbortReasonForLLM,
  runChildAgent,
  type ChildAgentResult,
  type RunChildAgentOptions,
} from "../subagent/index.js";
import type {
  JsonValue,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
  WorkflowExecutorId,
} from "@zhixing/core";
import {
  parseAgentNodeExecutorConfig,
} from "./config.js";
import {
  canceledResult,
  failedResult,
  usageToJson,
} from "./result.js";

export const DEFAULT_AGENT_NODE_EXECUTOR_ID = "workflow.agent";

export type RunWorkflowChildAgent = (
  options: RunChildAgentOptions,
) => Promise<ChildAgentResult>;

export interface AgentNodeExecutorOptions
  extends Omit<
    RunChildAgentOptions,
    "task" | "parentLineage" | "parentSignal"
  > {
  readonly executorId?: WorkflowExecutorId;
  readonly parentLineage?: string;
  readonly runChildAgent?: RunWorkflowChildAgent;
}

export interface AgentNodeExecutionOutput {
  readonly finalText: string;
  readonly subAgentId: string;
  readonly usage: JsonValue;
  readonly toolUses: number;
  readonly durationMs: number;
  readonly partial?: string;
}

export class AgentNodeExecutor implements NodeExecutor<JsonValue, JsonValue> {
  readonly executorId: WorkflowExecutorId;
  private readonly options: Omit<AgentNodeExecutorOptions, "executorId">;
  private readonly runner: RunWorkflowChildAgent;

  constructor(options: AgentNodeExecutorOptions) {
    this.executorId = options.executorId ?? DEFAULT_AGENT_NODE_EXECUTOR_ID;
    this.runner = options.runChildAgent ?? runChildAgent;
    this.options = options;
  }

  async run(
    context: NodeExecutionContext<JsonValue>,
  ): Promise<NodeExecutionResult<JsonValue>> {
    if (context.signal?.aborted) {
      return canceledResult(context.signal.reason);
    }

    let task: string;
    try {
      const config = parseAgentNodeExecutorConfig(context.node.executor.config);
      task = buildAgentTask({
        nodeId: context.node.nodeId,
        prompt: config.prompt,
        input: config.includeInput ? context.input : undefined,
        outputContract: context.node.outputContract?.schema,
      });
    } catch (error) {
      return failedResult("workflow.agent_config_invalid", error, false);
    }

    const result = await this.runner({
      provider: this.options.provider,
      model: this.options.model,
      loopThinking: this.options.loopThinking,
      roleThinking: this.options.roleThinking,
      llmRoles: this.options.llmRoles,
      securityPipeline: this.options.securityPipeline,
      workspace: this.options.workspace,
      workspaceSource: this.options.workspaceSource,
      globalConfigPath: this.options.globalConfigPath,
      parentBus: this.options.parentBus,
      parentLineage: deriveWorkflowLineage(
        this.options.parentLineage ?? this.options.parentBus.lineage ?? "workflow",
        context.nodeRun.nodeRunId,
      ),
      parentBroker: this.options.parentBroker,
      parentTools: this.options.parentTools,
      parentSignal: context.signal ?? new AbortController().signal,
      task,
      userIntent: this.options.userIntent,
      budget: this.options.budget,
      riskMaxTokens: this.options.riskMaxTokens,
    });

    switch (result.status) {
      case "completed":
        return {
          status: "succeeded",
          output: agentOutput(result),
        };
      case "failed":
        return {
          status: "failed",
          error: {
            code: result.error?.type
              ? `workflow.agent.${result.error.type}`
              : "workflow.agent_failed",
            message: result.error?.message ?? "Agent node failed",
            recoverable: true,
          },
        };
      case "aborted":
        return canceledResult(
          result.abortReason
            ? formatAbortReasonForLLM(result.abortReason)
            : "Agent node aborted",
        );
    }
  }
}

function buildAgentTask(input: {
  readonly nodeId: string;
  readonly prompt: string;
  readonly input?: JsonValue;
  readonly outputContract?: JsonValue;
}): string {
  const sections = [
    `Workflow node: ${input.nodeId}`,
    "",
    "Task:",
    input.prompt,
  ];

  if (input.input !== undefined) {
    sections.push("", "Input JSON:", stringifyJson(input.input));
  }
  if (input.outputContract !== undefined) {
    sections.push("", "Expected output contract:", stringifyJson(input.outputContract));
  }

  sections.push(
    "",
    "Return your final answer as the node result. Do not send messages to the user.",
  );
  return sections.join("\n");
}

function agentOutput(result: ChildAgentResult): JsonValue {
  const output: Record<string, JsonValue> = {
    finalText: result.finalAssistantText,
    subAgentId: result.subAgentId,
    usage: usageToJson(result.usage),
    toolUses: result.toolUses,
    durationMs: result.durationMs,
  };
  if (result.partial !== undefined) output["partial"] = result.partial;
  return output;
}

function deriveWorkflowLineage(parentLineage: string, nodeRunId: string): string {
  const safeNodeRunId = nodeRunId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `${parentLineage}/workflow-${safeNodeRunId}`;
}

function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}
