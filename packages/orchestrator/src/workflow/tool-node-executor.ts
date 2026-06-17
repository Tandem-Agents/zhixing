import {
  ConfirmationBroker,
  type AgentEventMap,
  type ConfirmationFallbackStrategy,
  type IConfirmationBroker,
  type IEventBus,
  type JsonValue,
  type LLMRoles,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
  type ResolvedRoleThinking,
  type SecurityPipeline,
  type SessionType,
  type ToolDefinition,
  type TurnContext,
  type WorkflowExecutorId,
} from "@zhixing/core";
import {
  SecurityBlockError,
  createSecureExecuteTool,
} from "../security/index.js";
import {
  asMutableToolInput,
  parseToolNodeExecutorConfig,
  resolvePointer,
} from "./config.js";
import {
  canceledResult,
  failedResult,
  isAbortError,
} from "./result.js";

export const DEFAULT_TOOL_NODE_EXECUTOR_ID = "workflow.tool";

export interface ToolNodeExecutorOptions {
  readonly tools: readonly ToolDefinition[];
  readonly securityPipeline: SecurityPipeline;
  readonly workingDirectory: string;
  readonly executorId?: WorkflowExecutorId;
  readonly confirmationBroker?: IConfirmationBroker;
  readonly eventBus?: IEventBus<AgentEventMap>;
  readonly sessionType?: SessionType;
  readonly confirmationFallback?: ConfirmationFallbackStrategy;
  readonly turnContext?: TurnContext;
  readonly llmRoles?: LLMRoles;
  readonly roleThinking?: ResolvedRoleThinking;
}

export interface ToolNodeExecutionOutput {
  readonly toolName: string;
  readonly content: string;
  readonly committedToUser: boolean;
}

export class ToolNodeExecutor implements NodeExecutor<JsonValue, JsonValue> {
  readonly executorId: WorkflowExecutorId;
  private readonly tools: Map<string, ToolDefinition>;
  private readonly options: Omit<ToolNodeExecutorOptions, "executorId" | "tools">;

  constructor(options: ToolNodeExecutorOptions) {
    this.executorId = options.executorId ?? DEFAULT_TOOL_NODE_EXECUTOR_ID;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.options = options;
  }

  async run(
    context: NodeExecutionContext<JsonValue>,
  ): Promise<NodeExecutionResult<JsonValue>> {
    if (context.signal?.aborted) {
      return canceledResult(context.signal.reason);
    }

    let toolName: string;
    let toolInput: Record<string, unknown>;
    try {
      const config = parseToolNodeExecutorConfig(context.node.executor.config);
      toolName = config.toolName;
      toolInput = asMutableToolInput(config.input);
      for (const [targetKey, pointer] of Object.entries(config.inputPointers)) {
        toolInput[targetKey] = resolvePointer(context.input, pointer);
      }
    } catch (error) {
      return failedResult("workflow.tool_config_invalid", error, false);
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      return failedResult(
        "workflow.tool_missing",
        `Workflow tool not registered: ${toolName}`,
        true,
      );
    }

    const broker =
      this.options.confirmationBroker ??
      new ConfirmationBroker();
    const executeTool = createSecureExecuteTool({
      pipeline: this.options.securityPipeline,
      broker,
      eventBus: this.options.eventBus,
      sessionType: this.options.sessionType,
      confirmationFallback: this.options.confirmationFallback,
      turnContext: this.options.turnContext,
      originalExecute: (definition, input, toolContext) =>
        definition.call(input, toolContext),
    });

    try {
      const result = await executeTool(tool, toolInput, {
        workingDirectory: this.options.workingDirectory,
        abortSignal: context.signal,
        llm: this.options.llmRoles,
        roleThinking: this.options.roleThinking,
      });

      if (result.isError) {
        return {
          status: "failed",
          error: {
            code: "workflow.tool_error",
            message: result.content,
            recoverable: true,
          },
        };
      }

      return {
        status: "succeeded",
        output: {
          toolName,
          content: result.content,
          committedToUser: result.committedToUser ?? false,
        },
      };
    } catch (error) {
      if (context.signal?.aborted || isAbortError(error)) {
        return canceledResult(context.signal?.reason ?? error);
      }
      if (error instanceof SecurityBlockError) {
        return failedResult("workflow.tool_blocked", error, false);
      }
      return failedResult("workflow.tool_execution_error", error, true);
    }
  }
}
