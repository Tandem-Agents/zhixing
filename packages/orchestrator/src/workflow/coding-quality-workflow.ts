import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "@zhixing/core";
import { DEFAULT_AGENT_NODE_EXECUTOR_ID } from "./agent-node-executor.js";
import { DEFAULT_GATE_NODE_EXECUTOR_ID } from "./gate-node-executor.js";
import { DEFAULT_JOIN_NODE_EXECUTOR_ID } from "./join-node-executor.js";
import { DEFAULT_TOOL_NODE_EXECUTOR_ID } from "./tool-node-executor.js";

export const CODING_QUALITY_WORKFLOW_ID = "zhixing.workflow.coding-quality";

export const CODING_QUALITY_WORKFLOW_EXECUTOR_IDS = [
  DEFAULT_AGENT_NODE_EXECUTOR_ID,
  DEFAULT_TOOL_NODE_EXECUTOR_ID,
  DEFAULT_GATE_NODE_EXECUTOR_ID,
  DEFAULT_JOIN_NODE_EXECUTOR_ID,
] as const;

export interface CodingQualityWorkflowOptions {
  readonly id?: string;
  readonly evidenceToolName?: string;
  readonly evidenceToolInput?: { readonly [key: string]: JsonValue };
  readonly maxRepairIterations?: number;
  readonly maxParallelNodes?: number;
}

export function createCodingQualityWorkflowDefinition(
  options: CodingQualityWorkflowOptions = {},
): WorkflowDefinition {
  const maxRepairIterations = options.maxRepairIterations ?? 2;
  const maxParallelNodes = options.maxParallelNodes ?? 3;
  const evidenceToolName = options.evidenceToolName ?? "bash";
  const evidenceToolInput = options.evidenceToolInput ?? {
    command: "git status --short && git diff --stat",
    timeout: 30_000,
  };

  return {
    id: options.id ?? CODING_QUALITY_WORKFLOW_ID,
    name: "Complex coding quality workflow",
    description:
      "A seed workflow for design, execution, multi-perspective review, evidence checks, repair loops, and delivery.",
    inputContract: {
      requiredKeys: ["goal"],
    },
    outputContract: {
      requiredKeys: ["finalText"],
    },
    policies: {
      concurrency: { maxParallelNodes },
      retry: { maxAttempts: 2 },
      feedback: { maxIterations: maxRepairIterations },
    },
    nodes: codingQualityNodes(evidenceToolName, evidenceToolInput),
    edges: codingQualityEdges(maxRepairIterations),
  };
}

export function listWorkflowSeedDefinitions(
  options: CodingQualityWorkflowOptions = {},
): readonly WorkflowDefinition[] {
  return [createCodingQualityWorkflowDefinition(options)];
}

export function getWorkflowSeedDefinition(
  id: string,
  options: CodingQualityWorkflowOptions = {},
): WorkflowDefinition | undefined {
  return listWorkflowSeedDefinitions(options).find(
    (definition) => definition.id === id,
  );
}

function codingQualityNodes(
  evidenceToolName: string,
  evidenceToolInput: { readonly [key: string]: JsonValue },
): readonly WorkflowNode[] {
  return [
    agentNode("goal_understanding", {
      prompt:
        "Extract the user's goal, constraints, risk boundaries, success criteria, and unknowns. Keep the result structured and testable.",
      inputFrom: [
        { kind: "instance", key: "goal" },
        { kind: "instance", key: "constraints" },
        { kind: "instance", key: "context" },
      ],
      outputContract: { requiredKeys: ["finalText"] },
    }),
    agentNode("architecture_design", {
      prompt:
        "Propose the architecture-first implementation approach. Focus on contracts, ownership, extension points, and failure modes.",
      inputFrom: [{ kind: "node", nodeId: "goal_understanding" }],
    }),
    agentNode("product_design", {
      prompt:
        "Evaluate the product shape. Focus on enduring user value, responsibility boundaries, and what should remain invisible to the user.",
      inputFrom: [{ kind: "node", nodeId: "goal_understanding" }],
    }),
    agentNode("risk_design", {
      prompt:
        "Identify correctness, integration, security, recovery, and testing risks before implementation.",
      inputFrom: [{ kind: "node", nodeId: "goal_understanding" }],
    }),
    joinNode("design_join", "design alternatives", [
      { kind: "node", nodeId: "architecture_design" },
      { kind: "node", nodeId: "product_design" },
      { kind: "node", nodeId: "risk_design" },
    ]),
    agentNode("design_convergence", {
      prompt:
        "Converge the independent designs into one recommended path with explicit tradeoffs and acceptance criteria.",
      inputFrom: [
        { kind: "node", nodeId: "goal_understanding" },
        { kind: "node", nodeId: "design_join" },
      ],
    }),
    gateNode("direction_gate", {
      question: "Is the recommended implementation direction acceptable?",
      recommendedOptionId: "direction_approved",
      rationale:
        "The decision should approve the direction only when it preserves the intended architecture and user value.",
      options: [
        {
          optionId: "direction_approved",
          label: "Approve direction",
          description: "Proceed to implementation.",
        },
        {
          optionId: "direction_blocked",
          label: "Stop for redesign",
          description: "Stop the workflow and deliver the design concern.",
        },
      ],
      inputFrom: [{ kind: "node", nodeId: "design_convergence" }],
    }),
    agentNode("implement_or_fix", {
      prompt:
        "Implement the approved design. On feedback iterations, repair only the verified issues while preserving the accepted design intent.",
      inputFrom: [
        { kind: "instance", key: "goal" },
        { kind: "node", nodeId: "design_convergence", iteration: "initial" },
        { kind: "node", nodeId: "direction_gate", iteration: "initial" },
        {
          kind: "node",
          nodeId: "quality_gate",
          artifactKey: "decision",
          iteration: "previous",
          optional: true,
        },
      ],
      retryPolicy: { maxAttempts: 2 },
    }),
    {
      nodeId: "evidence_snapshot",
      kind: "tool",
      executor: {
        executorId: DEFAULT_TOOL_NODE_EXECUTOR_ID,
        config: {
          toolName: evidenceToolName,
          input: evidenceToolInput,
        },
      },
      inputFrom: [{ kind: "node", nodeId: "implement_or_fix" }],
      retryPolicy: { maxAttempts: 2 },
    },
    agentNode("correctness_review", {
      prompt:
        "Review the implementation for logic correctness, edge cases, uniqueness, and failure semantics. Report only actionable findings.",
      inputFrom: [
        { kind: "node", nodeId: "implement_or_fix" },
        { kind: "node", nodeId: "evidence_snapshot" },
      ],
    }),
    agentNode("integration_review", {
      prompt:
        "Review whether the implementation fits the full system architecture, package boundaries, recovery model, and existing behavior.",
      inputFrom: [
        { kind: "node", nodeId: "implement_or_fix" },
        { kind: "node", nodeId: "evidence_snapshot" },
      ],
    }),
    agentNode("coverage_product_review", {
      prompt:
        "Review test coverage and product quality. Judge whether the outcome can age well as product and architecture.",
      inputFrom: [
        { kind: "node", nodeId: "implement_or_fix" },
        { kind: "node", nodeId: "evidence_snapshot" },
      ],
    }),
    joinNode("review_join", "review findings", [
      { kind: "node", nodeId: "correctness_review" },
      { kind: "node", nodeId: "integration_review" },
      { kind: "node", nodeId: "coverage_product_review" },
    ]),
    agentNode("truth_filter", {
      prompt:
        "Verify which review findings are real. Exclude speculation, duplicates, and out-of-scope issues. Return true issues and required validation.",
      inputFrom: [
        { kind: "node", nodeId: "review_join" },
        { kind: "node", nodeId: "evidence_snapshot" },
      ],
    }),
    gateNode("quality_gate", {
      question: "Do the verified findings require another repair iteration?",
      recommendedOptionId: "quality_accepted",
      rationale:
        "Choose repair only for real, in-scope issues that would create architecture debt, product debt, or broken behavior.",
      includeInputInRationale: true,
      options: [
        {
          optionId: "quality_accepted",
          label: "Accept quality",
          description: "Proceed to delivery.",
        },
        {
          optionId: "needs_fixes",
          label: "Repair verified issues",
          description: "Run another bounded implementation and review iteration.",
        },
      ],
      inputFrom: [{ kind: "node", nodeId: "truth_filter" }],
    }),
    agentNode("delivery_summary", {
      prompt:
        "Create the final delivery artifact. Summarize changes, evidence, decisions, remaining risk, and whether the workflow stopped or completed.",
      inputFrom: [
        { kind: "node", nodeId: "goal_understanding", iteration: "initial" },
        { kind: "node", nodeId: "design_convergence", iteration: "initial" },
        { kind: "node", nodeId: "direction_gate", iteration: "initial" },
        { kind: "node", nodeId: "implement_or_fix", optional: true },
        { kind: "node", nodeId: "evidence_snapshot", optional: true },
        { kind: "node", nodeId: "truth_filter", optional: true },
        { kind: "node", nodeId: "quality_gate", optional: true },
      ],
      outputContract: { requiredKeys: ["finalText"] },
    }),
  ];
}

function codingQualityEdges(maxRepairIterations: number): readonly WorkflowEdge[] {
  return [
    edge("goal_understanding", "architecture_design"),
    edge("goal_understanding", "product_design"),
    edge("goal_understanding", "risk_design"),
    edge("architecture_design", "design_join"),
    edge("product_design", "design_join"),
    edge("risk_design", "design_join"),
    edge("design_join", "design_convergence"),
    edge("design_convergence", "direction_gate"),
    edge("direction_gate", "implement_or_fix", "conditional", "direction_approved"),
    edge("direction_gate", "delivery_summary", "conditional", "direction_blocked"),
    edge("implement_or_fix", "evidence_snapshot"),
    edge("evidence_snapshot", "correctness_review"),
    edge("evidence_snapshot", "integration_review"),
    edge("evidence_snapshot", "coverage_product_review"),
    edge("correctness_review", "review_join"),
    edge("integration_review", "review_join"),
    edge("coverage_product_review", "review_join"),
    edge("review_join", "truth_filter"),
    edge("truth_filter", "quality_gate"),
    edge("quality_gate", "delivery_summary", "conditional", "quality_accepted"),
    {
      from: "quality_gate",
      to: "implement_or_fix",
      kind: "feedback",
      condition: "needs_fixes",
      loopPolicy: {
        maxIterations: maxRepairIterations,
        stopCondition: "quality_accepted",
        failureExitNodeId: "delivery_summary",
      },
    },
  ];
}

function agentNode(
  nodeId: string,
  input: {
    readonly prompt: string;
    readonly inputFrom?: WorkflowNode["inputFrom"];
    readonly outputContract?: WorkflowNode["outputContract"];
    readonly retryPolicy?: WorkflowNode["retryPolicy"];
  },
): WorkflowNode {
  return {
    nodeId,
    kind: "agent",
    executor: {
      executorId: DEFAULT_AGENT_NODE_EXECUTOR_ID,
      config: {
        prompt: input.prompt,
        includeInput: true,
      },
    },
    inputFrom: input.inputFrom,
    outputContract: input.outputContract,
    retryPolicy: input.retryPolicy,
  };
}

function gateNode(
  nodeId: string,
  input: {
    readonly question: string;
    readonly options: readonly JsonValue[];
    readonly recommendedOptionId?: string;
    readonly rationale?: string;
    readonly includeInputInRationale?: boolean;
    readonly inputFrom?: WorkflowNode["inputFrom"];
  },
): WorkflowNode {
  const config: Record<string, JsonValue> = {
    question: input.question,
    options: [...input.options],
    includeInputInRationale: input.includeInputInRationale ?? false,
  };
  if (input.recommendedOptionId) {
    config["recommendedOptionId"] = input.recommendedOptionId;
  }
  if (input.rationale) {
    config["rationale"] = input.rationale;
  }

  return {
    nodeId,
    kind: "gate",
    executor: {
      executorId: DEFAULT_GATE_NODE_EXECUTOR_ID,
      config,
    },
    inputFrom: input.inputFrom,
    riskPolicy: { requiresDecision: true, riskLevel: "medium" },
  };
}

function joinNode(
  nodeId: string,
  label: string,
  inputFrom: WorkflowNode["inputFrom"],
): WorkflowNode {
  return {
    nodeId,
    kind: "join",
    executor: {
      executorId: DEFAULT_JOIN_NODE_EXECUTOR_ID,
      config: { label },
    },
    inputFrom,
  };
}

function edge(
  from: string,
  to: string,
  kind: WorkflowEdge["kind"] = "normal",
  condition?: string,
): WorkflowEdge {
  return {
    from,
    to,
    kind,
    ...(condition ? { condition } : {}),
  };
}
