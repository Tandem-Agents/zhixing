import type {
  IConfirmationBroker,
  LLMProvider,
  LLMRoles,
  NormalizedOrchestrationNodeV1,
  OrchestrationNodeOutputV1,
  OrchestrationNodeRunResultV1,
  ResolvedRoleThinking,
  SecurityPipeline,
  ThinkingConfig,
  ToolDefinition,
} from "@zhixing/core";
import {
  runChildAgent,
  type ChildAgentResult,
  type RunChildAgentOptions,
} from "../subagent/factory.js";
import { formatAbortReasonForLLM } from "../subagent/abort-format.js";
import type {
  AgentNodeExecutorV1,
  OrchestrationNodeExecutionContextV1,
} from "./types.js";

export type RunChildAgentForOrchestrationV1 = (
  options: RunChildAgentOptions,
) => Promise<ChildAgentResult>;

export interface AgentNodeExecutorOptionsV1 {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly loopThinking?: ThinkingConfig;
  readonly roleThinking?: ResolvedRoleThinking;
  readonly llmRoles: LLMRoles;
  readonly securityPipeline: SecurityPipeline;
  readonly workspace: string | null;
  readonly workspaceSource?: string;
  readonly globalConfigPath?: string;
  readonly parentBroker: IConfirmationBroker;
  readonly parentTools: readonly ToolDefinition[];
  readonly riskMaxTokens: number;
  readonly userIntent?: string;
  readonly runChildAgent?: RunChildAgentForOrchestrationV1;
}

export function createAgentNodeExecutorV1(
  options: AgentNodeExecutorOptionsV1,
): AgentNodeExecutorV1 {
  return new ChildAgentNodeExecutorV1(options);
}

export class ChildAgentNodeExecutorV1 implements AgentNodeExecutorV1 {
  private readonly runChildAgent: RunChildAgentForOrchestrationV1;

  constructor(private readonly options: AgentNodeExecutorOptionsV1) {
    this.runChildAgent = options.runChildAgent ?? runChildAgent;
  }

  async runAgentNode(
    node: NormalizedOrchestrationNodeV1,
    context: OrchestrationNodeExecutionContextV1,
  ): Promise<OrchestrationNodeRunResultV1> {
    const selectedTools = selectNodeTools(this.options.parentTools, node);
    if (!selectedTools.ok) {
      return {
        nodeId: node.id,
        status: "failed",
        error: {
          type: "agent_node_tools_unavailable",
          message: `orchestration node declared unavailable tools: ${selectedTools.missing.join(", ")}.`,
          origin: "system",
          nodeId: node.id,
        },
        durationMs: 0,
      };
    }

    const result = await this.runChildAgent({
      provider: this.options.provider,
      model: this.options.model,
      loopThinking: this.options.loopThinking,
      roleThinking: this.options.roleThinking,
      llmRoles: this.options.llmRoles,
      securityPipeline: this.options.securityPipeline,
      workspace: this.options.workspace,
      workspaceSource: this.options.workspaceSource,
      globalConfigPath: this.options.globalConfigPath,
      parentBus: context.bus,
      parentLineage: context.lineage,
      parentBroker: this.options.parentBroker,
      parentTools: selectedTools.tools,
      parentSignal: context.abortSignal,
      task: buildAgentNodeTask(node, context),
      backgroundMessages: node.context.includeContextSnapshot
        ? context.contextSnapshot?.messages
        : undefined,
      userIntent: this.options.userIntent,
      riskMaxTokens: this.options.riskMaxTokens,
      budget: {
        maxTurns: node.policy.maxTurns,
        maxTokens: node.policy.maxTokens,
        wallClockTimeoutMs: node.policy.timeoutMs,
      },
    });

    return convertChildResult(node, result);
  }
}

function selectNodeTools(
  parentTools: readonly ToolDefinition[],
  node: NormalizedOrchestrationNodeV1,
):
  | { readonly ok: true; readonly tools: readonly ToolDefinition[] }
  | { readonly ok: false; readonly missing: readonly string[] } {
  const allowed = new Set(node.policy.tools);
  const tools = parentTools.filter((tool) => allowed.has(tool.name));
  const available = new Set(parentTools.map((tool) => tool.name));
  const missing = node.policy.tools.filter((tool) => !available.has(tool));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, tools };
}

function buildAgentNodeTask(
  node: NormalizedOrchestrationNodeV1,
  context: OrchestrationNodeExecutionContextV1,
): string {
  const sections = [
    `You are executing orchestration node "${node.id}".`,
    block("instruction", node.instruction),
  ];

  if (node.context.includeContextSnapshot && context.contextSnapshot) {
    sections.push(
      block(
        "context_snapshot",
        [
          "Read-only background messages were injected before the start signal.",
          `source: ${context.contextSnapshot.source}`,
          `strategy: ${context.contextSnapshot.strategy}`,
          `estimatedTokens: ${context.contextSnapshot.estimatedTokens}`,
        ].join("\n"),
      ),
    );
  }

  if (node.context.includeRunInput && context.runInput !== undefined) {
    sections.push(block("run_input", stringifyForTask(context.runInput)));
  }

  const dependencyOutputText = formatDependencyOutputs(context.dependencyOutputs);
  if (dependencyOutputText) {
    sections.push(block("dependency_outputs", dependencyOutputText));
  }

  sections.push(block("output_contract", formatOutputContract(node)));
  return sections.join("\n\n");
}

function formatDependencyOutputs(
  outputs: Readonly<Record<string, OrchestrationNodeOutputV1>>,
): string {
  return Object.values(outputs)
    .map((output) =>
      [
        `<node_output id="${escapeAttribute(output.nodeId)}" format="${output.format}">`,
        output.content,
        "</node_output>",
      ].join("\n"),
    )
    .join("\n\n");
}

function formatOutputContract(node: NormalizedOrchestrationNodeV1): string {
  const lines =
    node.output.format === "json"
      ? [
          "Return only valid JSON in the final answer.",
          "Do not wrap JSON in markdown fences and do not add prose outside JSON.",
        ]
      : ["Return plain text in the final answer."];

  lines.push(`maxChars: ${node.output.maxChars}`);
  if (node.output.schema) {
    lines.push("schema:");
    lines.push(JSON.stringify(node.output.schema, null, 2));
  }
  return lines.join("\n");
}

function convertChildResult(
  node: NormalizedOrchestrationNodeV1,
  result: ChildAgentResult,
): OrchestrationNodeRunResultV1 {
  const partial = result.partial || result.finalAssistantText || undefined;
  if (result.status === "completed") {
    return {
      nodeId: node.id,
      status: "completed",
      output: {
        nodeId: node.id,
        format: node.output.format,
        content: result.finalAssistantText,
      },
      usage: result.usage,
      durationMs: result.durationMs,
    };
  }

  if (result.status === "aborted") {
    return {
      nodeId: node.id,
      status: "aborted",
      error: {
        type: "agent_node_aborted",
        message: result.abortReason
          ? formatAbortReasonForLLM(result.abortReason)
          : "sub-agent aborted.",
        origin: "abort",
        nodeId: node.id,
      },
      partial,
      usage: result.usage,
      durationMs: result.durationMs,
    };
  }

  return {
    nodeId: node.id,
    status: "failed",
    error: {
      type: result.error?.type ?? "agent_node_failed",
      message: result.error?.message ?? "sub-agent failed.",
      origin: "node",
      nodeId: node.id,
    },
    partial,
    usage: result.usage,
    durationMs: result.durationMs,
  };
}

function block(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}

function stringifyForTask(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
