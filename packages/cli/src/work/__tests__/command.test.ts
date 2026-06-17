import { describe, expect, it } from "vitest";
import type { WorkflowInstance } from "@zhixing/core";
import { makeFakeHostLink } from "../../runtime/__tests__/fake-host-link.js";
import { runWorkCommand } from "../command.js";

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
        { nodeId: "direction_gate", kind: "gate", executor: { executorId: "workflow.gate" } },
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

describe("runWorkCommand", () => {
  it("starts seed work through detached workflow RPC", async () => {
    const host = makeFakeHostLink();
    const output: string[] = [];
    host.setResponder((method) => {
      expect(method).toBe("workflow.start");
      return instance({ instanceId: "wf-started" });
    });

    const code = await runWorkCommand(
      { kind: "start", goal: "审查并实现 CLI 入口" },
      { link: host.link, write: (text) => output.push(text) },
    );

    expect(code).toBe(0);
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]).toMatchObject({
      method: "workflow.start",
      params: {
        goal: "审查并实现 CLI 入口",
        definitionId: "zhixing.workflow.coding-quality",
        detach: true,
      },
    });
    expect(output.join("\n")).toContain("复杂任务已启动");
    expect(output.join("\n")).toContain("wf-started");
  });

  it("resolves the only pending decision before submitting detached decision RPC", async () => {
    const host = makeFakeHostLink();
    const output: string[] = [];
    host.setResponder((method) => {
      if (method === "workflow.get") {
        return instance({
          status: "waiting_decision",
          decisions: [
            {
              decisionId: "dec-1",
              nodeRunId: "run-1",
              nodeId: "direction_gate",
              question: "继续吗？",
              options: [{ optionId: "approve", label: "继续" }],
              createdAt: "2026-06-17T00:00:01.000Z",
            },
          ],
        });
      }
      if (method === "workflow.decide") {
        return instance({ status: "running" });
      }
      throw new Error(`unexpected method ${method}`);
    });

    const code = await runWorkCommand(
      { kind: "decide", instanceId: "wf-1", optionId: "approve" },
      { link: host.link, write: (text) => output.push(text) },
    );

    expect(code).toBe(0);
    expect(host.requests).toEqual([
      { method: "workflow.get", params: { instanceId: "wf-1" } },
      {
        method: "workflow.decide",
        params: {
          instanceId: "wf-1",
          decisionId: "dec-1",
          resultOptionId: "approve",
          actor: "human",
          detach: true,
        },
      },
    ]);
    expect(output.join("\n")).toContain("裁决已提交");
  });

  it("prints a status snapshot without owning workflow state", async () => {
    const host = makeFakeHostLink();
    const output: string[] = [];
    host.setResponder((method) => {
      expect(method).toBe("workflow.get");
      return instance({ status: "running" });
    });

    const code = await runWorkCommand(
      { kind: "status", instanceId: "wf-1" },
      { link: host.link, write: (text) => output.push(text) },
    );

    expect(code).toBe(0);
    expect(host.requests).toEqual([
      { method: "workflow.get", params: { instanceId: "wf-1" } },
    ]);
    expect(output.join("\n")).toContain("复杂任务");
    expect(output.join("\n")).toContain("状态: 进行中");
  });

  it("resumes work through detached workflow RPC", async () => {
    const host = makeFakeHostLink();
    const output: string[] = [];
    host.setResponder((method) => {
      expect(method).toBe("workflow.resume");
      return instance({ status: "running" });
    });

    const code = await runWorkCommand(
      { kind: "resume", instanceId: "wf-1" },
      { link: host.link, write: (text) => output.push(text) },
    );

    expect(code).toBe(0);
    expect(host.requests).toEqual([
      {
        method: "workflow.resume",
        params: { instanceId: "wf-1", detach: true },
      },
    ]);
    expect(output.join("\n")).toContain("复杂任务已恢复");
    expect(output.join("\n")).toContain("状态: 进行中");
  });

  it("cancels work through workflow RPC without owning state", async () => {
    const host = makeFakeHostLink();
    const output: string[] = [];
    host.setResponder((method) => {
      expect(method).toBe("workflow.cancel");
      return { canceled: true };
    });

    const code = await runWorkCommand(
      { kind: "cancel", instanceId: "wf-1", reason: "用户停止" },
      { link: host.link, write: (text) => output.push(text) },
    );

    expect(code).toBe(0);
    expect(host.requests).toEqual([
      {
        method: "workflow.cancel",
        params: { instanceId: "wf-1", reason: "用户停止" },
      },
    ]);
    expect(output.join("\n")).toContain("复杂任务已取消: wf-1");
  });
});
