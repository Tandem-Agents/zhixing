import type { ConversationTaskListToolApplication } from "@zhixing/core/conversation/application";
import { describe, expect, it } from "vitest";
import { createTaskListTool } from "../task-list.js";

function createObservedApplication(
  implementation?: ConversationTaskListToolApplication["replace"],
) {
  const calls: Parameters<ConversationTaskListToolApplication["replace"]>[0][] = [];
  const application: ConversationTaskListToolApplication = {
    async replace(input) {
      calls.push(input);
      if (implementation) return implementation(input);
      return {
        operationId: `task-list:${input.toolCallId}`,
        taskList: {
          items: input.items.map((item, index) => ({
            id: item.id ?? `returned-${index}`,
            content: item.content,
            status: item.status,
          })),
        },
      };
    },
  };
  return { application, calls };
}

describe("task_list tool ephemeral boundary", () => {
  it("rejects a run without a conversation before invoking the application", async () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => undefined, observed.application);

    const result = await tool.call(
      { items: [{ content: "blocked", status: "pending" }] },
      { workingDirectory: "/tmp" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no conversation");
    expect(observed.calls).toEqual([]);
  });

  it("does not add an application invocation after the context becomes ephemeral", async () => {
    const observed = createObservedApplication();
    let conversationId: string | undefined = "conv-1";
    const tool = createTaskListTool(() => conversationId, observed.application);
    const input = { items: [{ content: "task", status: "pending" }] };

    await tool.call(input, { workingDirectory: "/tmp", toolCallId: "durable" });
    conversationId = undefined;
    await tool.call(input, { workingDirectory: "/tmp", toolCallId: "ephemeral" });

    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]?.toolCallId).toBe("durable");
  });
});

describe("task_list tool assignment boundary", () => {
  it("invokes one replacement and reports that commit is deferred", async () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => "conv-1", observed.application);

    const result = await tool.call(
      { items: [{ content: "finish work", status: "in_progress" }] },
      { workingDirectory: "/tmp", toolCallId: "call-1" },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("current turn completes successfully");
    expect(observed.calls).toEqual([
      {
        conversationId: "conv-1",
        toolCallId: "call-1",
        items: [{ content: "finish work", status: "in_progress" }],
      },
    ]);
  });

  it("replays the same durable tool call with an identical application request", async () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => "conv-1", observed.application);
    const input = { items: [{ content: "stable", status: "pending" }] };

    await tool.call(input, { workingDirectory: "/tmp", toolCallId: "stable-call" });
    await tool.call(input, { workingDirectory: "/tmp", toolCallId: "stable-call" });

    expect(observed.calls[1]).toEqual(observed.calls[0]);
  });

  it("surfaces durable-assignment rejection after exactly one application call", async () => {
    const observed = createObservedApplication(async () => {
      throw new Error("Task list updates require an active durable turn.");
    });
    const tool = createTaskListTool(() => "conv-1", observed.application);

    const result = await tool.call(
      { items: [{ content: "blocked", status: "pending" }] },
      { workingDirectory: "/tmp", toolCallId: "call-blocked" },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("active durable turn");
    expect(observed.calls).toEqual([
      {
        conversationId: "conv-1",
        toolCallId: "call-blocked",
        items: [{ content: "blocked", status: "pending" }],
      },
    ]);
  });
});

describe("task_list tool input validation", () => {
  it("rejects a non-array items value before invoking the application", async () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => "conv-1", observed.application);

    const result = await tool.call({ items: "nope" }, { workingDirectory: "/tmp" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("items");
    expect(observed.calls).toEqual([]);
  });

  it("rejects an item without content before invoking the application", async () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => "conv-1", observed.application);

    const result = await tool.call(
      { items: [{ status: "pending" }] },
      { workingDirectory: "/tmp" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("content");
    expect(observed.calls).toEqual([]);
  });

  it("rejects an invalid status before invoking the application", async () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => "conv-1", observed.application);

    const result = await tool.call(
      { items: [{ content: "task", status: "bogus" }] },
      { workingDirectory: "/tmp" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("status");
    expect(observed.calls).toEqual([]);
  });
});

describe("task_list tool application binding", () => {
  it("passes missing and explicit task ids to the application unchanged", async () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => "conv-1", observed.application);

    await tool.call(
      {
        items: [
          { content: "auto", status: "pending" },
          { id: "stable", content: "explicit", status: "pending" },
        ],
      },
      { workingDirectory: "/tmp", toolCallId: "stable-call" },
    );

    expect(observed.calls[0]?.items).toEqual([
      { content: "auto", status: "pending" },
      { id: "stable", content: "explicit", status: "pending" },
    ]);
  });

  it("surfaces application failure after exactly one parameter-preserving call", async () => {
    const observed = createObservedApplication(async () => {
      throw new Error("stage failed");
    });
    const tool = createTaskListTool(() => "conv-1", observed.application);

    const result = await tool.call(
      { items: [{ content: "blocked", status: "pending" }] },
      { workingDirectory: "/tmp", toolCallId: "blocked" },
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("stage failed");
    expect(observed.calls).toEqual([
      {
        conversationId: "conv-1",
        toolCallId: "blocked",
        items: [{ content: "blocked", status: "pending" }],
      },
    ]);
  });
});

describe("task_list tool definition", () => {
  it("keeps its public name and effect flags", () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => "conv-1", observed.application);

    expect(tool.name).toBe("task_list");
    expect(tool.needsPermission).toBe(false);
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isParallelSafe).toBe(false);
  });

  it("documents that ephemeral runs are unsupported", () => {
    const observed = createObservedApplication();
    const tool = createTaskListTool(() => "conv-1", observed.application);

    expect(tool.description).toContain("persistent conversation");
    expect(tool.description.toLowerCase()).toMatch(/unavailable|one-shot|scheduled/u);
  });
});
