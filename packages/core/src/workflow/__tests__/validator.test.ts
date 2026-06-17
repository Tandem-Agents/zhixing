import { describe, expect, it } from "vitest";
import {
  DefinitionValidator,
  type DefinitionValidatorOptions,
} from "../validator.js";
import {
  WorkflowValidationError,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "../types.js";

function node(
  nodeId: string,
  overrides: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    nodeId,
    kind: "agent",
    executor: { executorId: "agent.default" },
    ...overrides,
  };
}

function definition(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: "wf.review",
    name: "Review workflow",
    nodes,
    edges,
    ...overrides,
  };
}

function expectIssue(
  fn: () => unknown,
  code: string,
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect((error as WorkflowValidationError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
    return;
  }
  throw new Error(`Expected validation issue ${code}`);
}

const ALLOWED_EXECUTORS = ["agent.default"] as const;

function validator(
  overrides: Partial<DefinitionValidatorOptions> = {},
): DefinitionValidator {
  return new DefinitionValidator({
    allowedExecutors: ALLOWED_EXECUTORS,
    ...overrides,
  });
}

describe("DefinitionValidator", () => {
  it("normalizes edges and derives dependencies from non-feedback control flow", () => {
    const validated = validator().validate(
      definition(
        [
          node("draft"),
          node("review", {
            kind: "gate",
            inputFrom: [{ kind: "node", nodeId: "draft" }],
          }),
        ],
        [{ from: "draft", to: "review", kind: "normal" }],
      ),
    );

    expect(validated.definition.edges[0]?.edgeId).toBe(
      "draft->review:normal:0",
    );
    expect(validated.entryNodeIds).toEqual(["draft"]);
    expect(validated.dependencies).toEqual([
      { nodeId: "draft", upstreamNodeIds: [] },
      { nodeId: "review", upstreamNodeIds: ["draft"] },
    ]);
  });

  it("rejects duplicated node ids", () => {
    expectIssue(
      () =>
        validator().validate(
          definition([node("draft"), node("draft")], []),
        ),
      "node.id.duplicate",
    );
  });

  it("rejects edges pointing to unknown nodes", () => {
    expectIssue(
      () =>
        validator().validate(
          definition([node("draft")], [
            { from: "draft", to: "missing", kind: "normal" },
          ]),
        ),
      "edge.to.unknown",
    );
  });

  it("rejects uncontrolled cycles in non-feedback edges", () => {
    expectIssue(
      () =>
        validator().validate(
          definition(
            [node("draft"), node("review")],
            [
              { from: "draft", to: "review", kind: "normal" },
              { from: "review", to: "draft", kind: "normal" },
            ],
          ),
        ),
      "edge.cycle.uncontrolled",
    );
  });

  it("accepts explicit feedback loops and keeps feedback out of dependencies", () => {
    const validated = validator().validate(
      definition(
        [node("draft"), node("review", { kind: "gate" }), node("done")],
        [
          { from: "draft", to: "review", kind: "normal" },
          {
            from: "review",
            to: "draft",
            kind: "feedback",
            condition: "needs_changes",
            loopPolicy: {
              maxIterations: 2,
              stopCondition: "accepted",
              failureExitNodeId: "done",
            },
          },
          { from: "review", to: "done", kind: "conditional", condition: "accepted" },
        ],
      ),
    );

    expect(validated.entryNodeIds).toEqual(["draft"]);
    expect(
      validated.dependencies.find((dep) => dep.nodeId === "draft"),
    ).toEqual({ nodeId: "draft", upstreamNodeIds: [] });
  });

  it("does not treat loop policy target nodes as workflow entries", () => {
    const validated = validator().validate(
      definition(
        [
          node("draft"),
          node("review", { kind: "gate" }),
          node("failed", { kind: "notify" }),
          node("decide", { kind: "gate" }),
        ],
        [
          { from: "draft", to: "review", kind: "normal" },
          {
            from: "review",
            to: "draft",
            kind: "feedback",
            condition: "needs_changes",
            loopPolicy: {
              maxIterations: 2,
              stopCondition: "accepted",
              failureExitNodeId: "failed",
              decisionNodeId: "decide",
            },
          },
        ],
      ),
    );

    expect(validated.entryNodeIds).toEqual(["draft"]);
  });

  it("requires loopPolicy only on feedback edges", () => {
    expectIssue(
      () =>
        validator().validate(
          definition([node("a"), node("b")], [
            { from: "a", to: "b", kind: "feedback" },
          ]),
        ),
      "edge.feedback.loopPolicy.required",
    );

    expectIssue(
      () =>
        validator().validate(
          definition([node("a"), node("b")], [
            {
              from: "a",
              to: "b",
              kind: "normal",
              loopPolicy: {
                maxIterations: 1,
                stopCondition: "done",
                failureExitNodeId: "b",
              },
            },
          ]),
        ),
      "edge.loopPolicy.invalid",
    );
  });

  it("rejects node input sources that are not upstream", () => {
    expectIssue(
      () =>
        validator().validate(
          definition(
            [
              node("source"),
              node("consumer", {
                inputFrom: [{ kind: "node", nodeId: "source" }],
              }),
            ],
            [],
          ),
        ),
      "node.inputFrom.notUpstream",
    );
  });

  it("rejects input sources that are only reachable through feedback edges", () => {
    expectIssue(
      () =>
        validator().validate(
          definition(
            [
              node("draft", {
                inputFrom: [{ kind: "node", nodeId: "review" }],
              }),
              node("review", { kind: "gate" }),
              node("failed", { kind: "notify" }),
            ],
            [
              { from: "draft", to: "review", kind: "normal" },
              {
                from: "review",
                to: "draft",
                kind: "feedback",
                condition: "needs_changes",
                loopPolicy: {
                  maxIterations: 1,
                  stopCondition: "accepted",
                  failureExitNodeId: "failed",
                },
              },
            ],
          ),
        ),
      "node.inputFrom.notUpstream",
    );
  });

  it("requires previous-iteration inputs to be explicitly optional", () => {
    expectIssue(
      () =>
        validator().validate(
          definition(
            [
              node("draft", {
                inputFrom: [
                  { kind: "node", nodeId: "review", iteration: "previous" },
                ],
              }),
              node("review", { kind: "gate" }),
              node("failed", { kind: "notify" }),
            ],
            [
              { from: "draft", to: "review", kind: "normal" },
              {
                from: "review",
                to: "draft",
                kind: "feedback",
                condition: "needs_changes",
                loopPolicy: {
                  maxIterations: 1,
                  stopCondition: "accepted",
                  failureExitNodeId: "failed",
                },
              },
            ],
          ),
        ),
      "node.inputFrom.previous.optionalRequired",
    );
  });

  it("accepts optional previous-iteration inputs from direct feedback sources", () => {
    const validated = validator().validate(
      definition(
        [
          node("draft", {
            inputFrom: [
              {
                kind: "node",
                nodeId: "review",
                iteration: "previous",
                optional: true,
              },
            ],
          }),
          node("review", { kind: "gate" }),
          node("failed", { kind: "notify" }),
        ],
        [
          { from: "draft", to: "review", kind: "normal" },
          {
            from: "review",
            to: "draft",
            kind: "feedback",
            condition: "needs_changes",
            loopPolicy: {
              maxIterations: 1,
              stopCondition: "accepted",
              failureExitNodeId: "failed",
            },
          },
        ],
      ),
    );

    expect(validated.entryNodeIds).toEqual(["draft"]);
  });

  it("allows loop policy targets to read the feedback source output", () => {
    const validated = validator().validate(
      definition(
        [
          node("draft"),
          node("review", { kind: "gate" }),
          node("failed", {
            kind: "notify",
            inputFrom: [{ kind: "node", nodeId: "review" }],
          }),
        ],
        [
          { from: "draft", to: "review", kind: "normal" },
          {
            from: "review",
            to: "draft",
            kind: "feedback",
            condition: "needs_changes",
            loopPolicy: {
              maxIterations: 1,
              stopCondition: "accepted",
              failureExitNodeId: "failed",
            },
          },
        ],
      ),
    );

    expect(validated.entryNodeIds).toEqual(["draft"]);
  });

  it("rejects malformed node input source selectors", () => {
    expectIssue(
      () =>
        validator().validate(
          definition(
            [
              node("source"),
              node("consumer", {
                inputFrom: [
                  {
                    kind: "node",
                    nodeId: "source",
                    iteration: "latest",
                  } as never,
                ],
              }),
            ],
            [{ from: "source", to: "consumer", kind: "normal" }],
          ),
        ),
      "node.inputFrom.iteration.invalid",
    );

    expectIssue(
      () =>
        validator().validate(
          definition(
            [
              node("source"),
              node("consumer", {
                inputFrom: [
                  { kind: "node", nodeId: "source", artifactKey: "" },
                ],
              }),
            ],
            [{ from: "source", to: "consumer", kind: "normal" }],
          ),
        ),
      "node.inputFrom.artifactKey.invalid",
    );

    expectIssue(
      () =>
        validator().validate(
          definition(
            [
              node("source"),
              node("consumer", {
                inputFrom: [
                  {
                    kind: "node",
                    nodeId: "source",
                    optional: "yes",
                  } as never,
                ],
              }),
            ],
            [{ from: "source", to: "consumer", kind: "normal" }],
          ),
        ),
      "node.inputFrom.optional.invalid",
    );
  });

  it("treats policies.feedback.maxIterations as a hard upper bound", () => {
    expectIssue(
      () =>
        validator().validate(
          definition(
            [node("draft"), node("review", { kind: "gate" }), node("failed")],
            [
              { from: "draft", to: "review", kind: "normal" },
              {
                from: "review",
                to: "draft",
                kind: "feedback",
                loopPolicy: {
                  maxIterations: 3,
                  stopCondition: "accepted",
                  failureExitNodeId: "failed",
                },
              },
            ],
            { policies: { feedback: { maxIterations: 2 } } },
          ),
        ),
      "edge.feedback.maxIterations.exceedsPolicy",
    );
  });

  it("can restrict executor ids at the validation boundary", () => {
    expectIssue(
      () =>
        new DefinitionValidator({ allowedExecutors: ["agent.safe"] }).validate(
          definition([node("draft")], []),
        ),
      "node.executor.invalid",
    );
  });

  it("requires an explicit executor allowlist", () => {
    expect(() => new DefinitionValidator(undefined as never)).toThrow(
      "DefinitionValidator requires a non-empty executor allowlist",
    );
    expect(() => new DefinitionValidator({ allowedExecutors: [] })).toThrow(
      "DefinitionValidator requires a non-empty executor allowlist",
    );
  });

  it("rejects executable values in declarative configuration", () => {
    expectIssue(
      () =>
        validator().validate(
          definition(
            [
              node("draft", {
                executor: {
                  executorId: "agent.default",
                  config: { run: () => "not declarative" } as never,
                },
              }),
            ],
            [],
          ),
        ),
      "json.invalid",
    );
  });

  it("rejects invalid runtime policy enum values", () => {
    expectIssue(
      () =>
        validator().validate(
          definition(
            [
              node("draft", {
                riskPolicy: { riskLevel: "bad" } as never,
              }),
            ],
            [],
            {
              policies: {
                risk: { riskLevel: "impossible" },
                notification: { target: "everyone" },
              } as never,
            },
          ),
        ),
      "risk.level.invalid",
    );

    expectIssue(
      () =>
        validator().validate(
          definition([node("draft")], [], {
            policies: { notification: { target: "everyone" } } as never,
          }),
        ),
      "notification.target.invalid",
    );
  });

  it("rejects malformed definition shapes as validation errors", () => {
    expectIssue(
      () =>
        validator().validate({
          id: "bad-nodes",
          name: "Bad nodes",
          nodes: {},
          edges: [],
        } as never),
      "definition.nodes.required",
    );

    expectIssue(
      () =>
        validator().validate({
          id: "bad-edges",
          name: "Bad edges",
          nodes: [node("draft")],
          edges: {},
        } as never),
      "definition.edges.required",
    );

    expectIssue(
      () =>
        validator().validate(
          definition([null as never], []),
        ),
      "node.invalid",
    );

    expectIssue(
      () =>
        validator().validate(
          definition([node("draft")], [null as never]),
        ),
      "edge.invalid",
    );

    expectIssue(
      () =>
        validator().validate(
          definition([node("draft")], [], { policies: null as never }),
        ),
      "policies.invalid",
    );
  });
});
