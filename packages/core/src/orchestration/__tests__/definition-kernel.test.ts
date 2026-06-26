import { describe, expect, it } from "vitest";
import {
  instantiateTrustedOrchestrationTemplateV1,
  loadOrchestrationDefinitionV1,
  type OrchestrationDefinitionV1,
  type OrchestrationExecutableV1,
  type OrchestrationLoadResultV1,
  type OrchestrationSystemCapsV1,
  type OrchestrationTemplateParamsV1,
  type OrchestrationValidationIssueCodeV1,
} from "../index.js";

const caps: OrchestrationSystemCapsV1 = {
  maxNodes: 6,
  maxParallel: 3,
  maxRunMs: 60_000,
  maxNodeTimeoutMs: 30_000,
  maxNodeTurns: 20,
  maxNodeTokens: 50_000,
  maxContextSnapshotTokens: 12_000,
  maxInstructionChars: 800,
  maxInputChars: 5_000,
  maxOutputChars: 1_000,
  allowedNodeKinds: ["agent"],
  allowedTools: ["Read", "Grep"],
};

describe("orchestration definition kernel", () => {
  it("loads, validates, normalizes, and plans a trusted definition", () => {
    const executable = expectLoadSuccess(
      loadOrchestrationDefinitionV1(createDefinition(), caps),
    );

    expect(executable.sourceMode).toBe("trusted");
    expect(executable.definition.policy.failureMode).toBe("fail_fast");
    expect(executable.definition.policy.defaultMaxTokens).toBe(
      caps.maxNodeTokens,
    );
    expect(executable.definition.policy.contextSnapshot?.maxTokens).toBe(8_000);
    expect(executable.definition.nodeIds).toEqual([
      "discover",
      "critic",
      "summary",
    ]);
    expect(executable.definition.nodesById["discover"]!.context).toEqual({
      includeRunInput: true,
      includeContextSnapshot: true,
      includeNodeOutputs: "dependencies",
    });
    expect(executable.definition.nodesById["discover"]!.output.maxChars).toBe(
      caps.maxOutputChars,
    );
    expect(executable.definition.input?.maxChars).toBe(4_000);
    expect(executable.definition.nodesById["critic"]!.policy.timeoutMs).toBe(
      30_000,
    );
    expect(executable.definition.nodesById["critic"]!.policy.maxTokens).toBe(
      caps.maxNodeTokens,
    );
    expect(executable.plan.rootNodeIds).toEqual(["discover"]);
    expect(executable.plan.topologicalOrder).toEqual([
      "discover",
      "critic",
      "summary",
    ]);
    expect(executable.plan.dependencies["summary"]).toEqual([
      "discover",
      "critic",
    ]);
    expect(Object.isFrozen(executable.definition)).toBe(true);
  });

  it("accepts JSONC comments and trailing commas", () => {
    const result = loadOrchestrationDefinitionV1(
      `{
        // trusted definition owned by the application
        "version": 1,
        "id": "jsonc-plan",
        "title": "JSONC plan",
        "policy": {
          "maxParallel": 1,
          "maxRunMs": 1000,
          "defaultNodeTimeoutMs": 1000,
          "defaultMaxTurns": 1,
          "allowedTools": [],
        },
        "nodes": [
          {
            "id": "answer",
            "kind": "agent",
            "instruction": "Answer.",
            "output": { "required": true, "format": "text" },
          },
        ],
      }`,
      caps,
    );

    const executable = expectLoadSuccess(result);
    expect(executable.definition.id).toBe("jsonc-plan");
    expect(executable.plan.topologicalOrder).toEqual(["answer"]);
  });

  it("instantiates trusted templates before validation", () => {
    const definition = createDefinition();
    const firstNode = definition.nodes[0]!;
    const template = {
      ...definition,
      nodes: [
        {
          ...firstNode,
          instruction: "Inspect {{subject}} from {{angle}}.",
        },
      ],
    };

    const executable = expectLoadSuccess(
      instantiateTrustedOrchestrationTemplateV1(
        template,
        { subject: "state handling", angle: "safety" },
        caps,
      ),
    );

    expect(executable.definition.nodesById["discover"]!.instruction).toBe(
      "Inspect state handling from safety.",
    );
  });

  it("rejects non-string template params", () => {
    const result = instantiateTrustedOrchestrationTemplateV1(
      createDefinition(),
      { subject: 3 } as unknown as OrchestrationTemplateParamsV1,
      caps,
    );

    expect(issueCodes(result)).toContain("template_param_invalid");
  });

  it("rejects malformed JSONC block comments", () => {
    const result = loadOrchestrationDefinitionV1(
      `${JSON.stringify(createDefinition())} /*`,
      caps,
    );

    expect(issueCodes(result)).toContain("parse_error");
  });

  it("rejects unsafe policy and context requests", () => {
    const result = loadOrchestrationDefinitionV1(
      {
        version: 1,
        id: "unsafe",
        title: "Unsafe",
        policy: {
          maxParallel: 4,
          maxRunMs: 60_000,
          defaultNodeTimeoutMs: 30_000,
          defaultMaxTurns: 1,
          allowedTools: ["Read", "Bash"],
        },
        nodes: [
          {
            id: "node",
            kind: "agent",
            instruction: "Try it.",
            context: { includeContextSnapshot: true },
            output: { required: true, format: "text" },
          },
        ],
      },
      caps,
    );

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "too_large",
        "invalid_reference",
        "missing_context_snapshot_policy",
      ]),
    );
  });

  it("normalizes default input limit and rejects input limits over caps", () => {
    const withoutInputMax = {
      ...createDefinition(),
      input: {
        required: true,
        format: "text",
      },
    };
    const executable = expectLoadSuccess(
      loadOrchestrationDefinitionV1(withoutInputMax, caps),
    );
    expect(executable.definition.input).toEqual({
      required: true,
      format: "text",
      maxChars: caps.maxInputChars,
    });

    const overLimit = loadOrchestrationDefinitionV1(
      {
        ...createDefinition(),
        input: {
          required: true,
          format: "text",
          maxChars: caps.maxInputChars + 1,
        },
      },
      caps,
    );
    expect(issueCodes(overLimit)).toContain("too_large");
  });

  it("rejects run input context without an input contract", () => {
    const definition = createDefinition();
    const withoutInput = { ...definition } as Record<string, unknown>;
    delete withoutInput.input;

    const result = loadOrchestrationDefinitionV1(withoutInput, caps);

    expect(issueCodes(result)).toContain("missing_input_contract");
  });

  it("rejects unsupported version and failure mode", () => {
    const definition = createDefinition();
    const result = loadOrchestrationDefinitionV1(
      {
        ...definition,
        version: 2,
        policy: {
          ...definition.policy,
          failureMode: "continue_on_error",
        },
      },
      caps,
    );

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["invalid_literal"]),
    );
  });

  it("rejects unknown dependencies", () => {
    const definition = createDefinition();
    const result = loadOrchestrationDefinitionV1(
      {
        ...definition,
        nodes: [
          {
            ...definition.nodes[0]!,
            dependsOn: ["missing-node"],
          },
        ],
      },
      caps,
    );

    expect(issueCodes(result)).toContain("unknown_reference");
  });

  it("rejects too many nodes before traversing node bodies", () => {
    const explosiveNode = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("node body should not be inspected");
        },
      },
    );

    const result = loadOrchestrationDefinitionV1(
      {
        ...createDefinition(),
        nodes: Array.from({ length: caps.maxNodes + 1 }, (_item, index) =>
          index === 0 ? explosiveNode : {},
        ),
      },
      caps,
    );

    expect(issueCodes(result)).toEqual(["too_large"]);
  });

  it("rejects oversized instructions and snapshot budgets", () => {
    const definition = createDefinition();
    const result = loadOrchestrationDefinitionV1(
      {
        ...definition,
        policy: {
          ...definition.policy,
          contextSnapshot: {
            strategy: "tail",
            maxTokens: caps.maxContextSnapshotTokens + 1,
          },
        },
        nodes: [
          {
            ...definition.nodes[0]!,
            instruction: "x".repeat(caps.maxInstructionChars + 1),
          },
        ],
      },
      caps,
    );

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["too_large"]),
    );
  });

  it("rejects turn and token budgets over system caps", () => {
    const definition = createDefinition();
    const result = loadOrchestrationDefinitionV1(
      {
        ...definition,
        policy: {
          ...definition.policy,
          defaultMaxTurns: caps.maxNodeTurns + 1,
          defaultMaxTokens: caps.maxNodeTokens + 1,
        },
        nodes: [
          {
            ...definition.nodes[0]!,
            policy: {
              maxTurns: caps.maxNodeTurns + 1,
              maxTokens: caps.maxNodeTokens + 1,
            },
          },
        ],
      },
      caps,
    );

    expect(issuePaths(result)).toEqual(
      expect.arrayContaining([
        "$.policy.defaultMaxTurns",
        "$.policy.defaultMaxTokens",
        "$.nodes[0].policy.maxTurns",
        "$.nodes[0].policy.maxTokens",
      ]),
    );
  });

  it("rejects missing output contracts", () => {
    const node = { ...createDefinition().nodes[0] } as Record<string, unknown>;
    delete node.output;

    const result = loadOrchestrationDefinitionV1(
      {
        ...createDefinition(),
        nodes: [node],
      },
      caps,
    );

    expect(issueCodes(result)).toContain("type_mismatch");
  });

  it("rejects duplicate and invalid ids", () => {
    const definition = createDefinition();
    const result = loadOrchestrationDefinitionV1(
      {
        ...definition,
        nodes: [
          { ...definition.nodes[0]!, id: "Bad_Id" },
          { ...definition.nodes[1]!, id: "Bad_Id", dependsOn: [] },
        ],
      },
      caps,
    );

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["invalid_id", "duplicate_id"]),
    );
  });

  it("rejects dependency cycles", () => {
    const definition = createDefinition();
    const result = loadOrchestrationDefinitionV1(
      {
        ...definition,
        nodes: [
          { ...definition.nodes[0]!, id: "a", dependsOn: ["b"] },
          { ...definition.nodes[1]!, id: "b", dependsOn: ["a"] },
        ],
      },
      caps,
    );

    expect(issueCodes(result)).toContain("cycle_dependency");
  });

  it("rejects node output references outside direct dependencies", () => {
    const definition = createDefinition();
    const result = loadOrchestrationDefinitionV1(
      {
        ...definition,
        nodes: [
          definition.nodes[0]!,
          {
            ...definition.nodes[1]!,
            context: {
              includeNodeOutputs: ["summary"],
            },
          },
          definition.nodes[2]!,
        ],
      },
      caps,
    );

    expect(issueCodes(result)).toContain("invalid_reference");
  });
});

function createDefinition(): OrchestrationDefinitionV1 {
  return {
    version: 1,
    id: "multi-perspective",
    title: "Multi perspective",
    policy: {
      maxParallel: 2,
      maxRunMs: 60_000,
      defaultNodeTimeoutMs: 30_000,
      defaultMaxTurns: 2,
      contextSnapshot: {
        strategy: "tail",
        maxTokens: 8_000,
      },
      allowedTools: ["Read", "Grep"],
    },
    input: {
      required: true,
      format: "text",
      maxChars: 4_000,
    },
    nodes: [
      {
        id: "discover",
        kind: "agent",
        instruction: "Map the problem.",
        context: {
          includeRunInput: true,
          includeContextSnapshot: true,
        },
        output: {
          required: true,
          format: "text",
        },
        policy: {
          tools: ["Read", "Grep"],
        },
      },
      {
        id: "critic",
        kind: "agent",
        dependsOn: ["discover"],
        instruction: "Review the first result.",
        context: {
          includeNodeOutputs: ["discover"],
        },
        output: {
          required: true,
          format: "text",
        },
      },
      {
        id: "summary",
        kind: "agent",
        dependsOn: ["discover", "critic"],
        instruction: "Summarize the useful result.",
        output: {
          required: true,
          format: "text",
        },
      },
    ],
  };
}

function expectLoadSuccess(
  result: OrchestrationLoadResultV1,
): OrchestrationExecutableV1 {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("\n"));
  }
  return result.executable;
}

function issueCodes(
  result: OrchestrationLoadResultV1,
): readonly OrchestrationValidationIssueCodeV1[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected load failure");
  return result.issues.map((issue) => issue.code);
}

function issuePaths(result: OrchestrationLoadResultV1): readonly string[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected load failure");
  return result.issues.map((issue) => issue.path);
}
