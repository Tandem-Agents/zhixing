import { describe, expect, it } from "vitest";
import type { WorkflowInstance } from "@zhixing/core";
import { formatWorkSnapshot } from "../format.js";

function instance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    instanceId: "wf-1",
    conversationId: "work-1",
    goal: "实现复杂任务入口",
    input: { goal: "实现复杂任务入口" },
    definition: {
      id: "seed",
      name: "Seed",
      nodes: [
        { nodeId: "goal_understanding", kind: "agent", executor: { executorId: "workflow.agent" } },
        { nodeId: "direction_gate", kind: "gate", executor: { executorId: "workflow.gate" } },
        { nodeId: "delivery_summary", kind: "agent", executor: { executorId: "workflow.agent" } },
      ],
      edges: [],
    },
    status: "created",
    nodeRuns: [],
    decisions: [],
    artifacts: [],
    errors: [],
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatWorkSnapshot", () => {
  it("renders pending decisions as a product-level prompt", () => {
    const rendered = formatWorkSnapshot(
      instance({
        status: "waiting_decision",
        nodeRuns: [
          {
            nodeRunId: "run-gate",
            nodeId: "direction_gate",
            iteration: 0,
            attempt: 0,
            status: "waiting_decision",
            createdAt: "2026-06-17T00:00:01.000Z",
            updatedAt: "2026-06-17T00:00:01.000Z",
          },
        ],
        decisions: [
          {
            decisionId: "dec-1",
            nodeRunId: "run-gate",
            nodeId: "direction_gate",
            question: "是否接受实施方向？",
            options: [
              { optionId: "approve", label: "接受" },
              { optionId: "redesign", label: "重新设计" },
            ],
            recommendedOptionId: "approve",
            rationale: "方向保持架构边界。",
            createdAt: "2026-06-17T00:00:02.000Z",
          },
        ],
      }),
    );

    expect(rendered).toContain("状态: 等待裁决");
    expect(rendered).toContain("阶段: 确认实施方向");
    expect(rendered).toContain("需要你决定");
    expect(rendered).toContain("approve: 接受（推荐）");
    expect(rendered).not.toContain("NodeRun");
    expect(rendered).not.toContain("executor");
  });

  it("renders the final delivery summary when available", () => {
    const rendered = formatWorkSnapshot(
      instance({
        status: "succeeded",
        nodeRuns: [
          {
            nodeRunId: "run-delivery",
            nodeId: "delivery_summary",
            iteration: 0,
            attempt: 0,
            status: "succeeded",
            outputArtifactRefs: ["artifact-final"],
            createdAt: "2026-06-17T00:00:01.000Z",
            updatedAt: "2026-06-17T00:00:02.000Z",
          },
        ],
        artifacts: [
          {
            artifactId: "artifact-final",
            nodeRunId: "run-delivery",
            key: "output",
            value: { finalText: "已完成实现与验证。" },
            createdAt: "2026-06-17T00:00:02.000Z",
          },
        ],
      }),
    );

    expect(rendered).toContain("状态: 已完成");
    expect(rendered).toContain("交付摘要");
    expect(rendered).toContain("已完成实现与验证。");
  });
});
