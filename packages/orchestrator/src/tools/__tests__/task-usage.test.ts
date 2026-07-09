import { describe, expect, it } from "vitest";
import type { Message } from "@zhixing/core";
import { formatChildResultAsToolResult } from "../task.js";
import { parseTaskUsageFromMessages } from "../task-usage.js";
import type { ChildAgentResult } from "../../subagent/factory.js";

function taskUseMsg(id: string, description: string): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "Task",
        input: { description, prompt: "do work" },
      },
    ],
  };
}

function taskResultMsg(id: string, content: string, isError = false): Message {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: id,
        content,
        ...(isError && { isError: true }),
      },
    ],
  };
}

function makeUsageTag(
  tokens: number,
  opts: {
    status?: "succeeded" | "failed" | "aborted";
    toolUses?: number;
    durationMs?: number;
    subId?: string;
  } = {},
): string {
  const parts = [`status: ${opts.status ?? "succeeded"}`, `tokens: ${tokens}`];
  parts.push(`tool_uses: ${opts.toolUses ?? 0}`);
  parts.push(`duration_ms: ${opts.durationMs ?? 1234}`);
  parts.push(`sub_id: ${opts.subId ?? "abcdef"}`);
  return `<usage>${parts.join(", ")}</usage>`;
}

describe("parseTaskUsageFromMessages", () => {
  it("从 Task tool_use / tool_result 配对解析成功用量", () => {
    const messages: Message[] = [
      taskUseMsg("t1", "调研模块结构"),
      taskResultMsg(
        "t1",
        `Final summary\n\n${makeUsageTag(35400, {
          toolUses: 5,
          durationMs: 8000,
          subId: "ab12cd",
        })}`,
      ),
    ];

    expect(parseTaskUsageFromMessages(messages)).toEqual([
      {
        index: 1,
        description: "调研模块结构",
        tokens: 35400,
        toolUses: 5,
        durationMs: 8000,
        subId: "ab12cd",
        status: "succeeded",
      },
    ]);
  });

  it("失败 / 中止状态由末尾结构化 trailer 决定，防止文本前缀漂移", () => {
    const failed = makeContractMessages(
      "fetch data",
      makeChildResult({
        status: "failed",
        error: { type: "provider_error", message: "upstream rejected" },
      }),
    );
    const aborted = makeContractMessages(
      "research",
      makeChildResult({
        status: "aborted",
        abortReason: { kind: "parent-abort" },
      }),
    );

    expect(parseTaskUsageFromMessages(failed)[0]?.status).toBe("failed");
    expect(parseTaskUsageFromMessages(aborted)[0]?.status).toBe("aborted");
  });

  it("非 Task / 孤儿结果 / 损坏 usage 均跳过", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "r1", name: "Read", input: { path: "x" } },
        ],
      },
      taskResultMsg("orphan", `text\n\n${makeUsageTag(100, { toolUses: 1 })}`),
      taskUseMsg("bad", "格式损坏"),
      taskResultMsg("bad", "text\n\n<usage>tokens: 100</usage>"),
    ];

    expect(parseTaskUsageFromMessages(messages)).toEqual([]);
  });

  it("只解析末尾 trailer，正文里的伪 usage 不会污染状态", () => {
    const messages: Message[] = [
      taskUseMsg("t1", "审查输出"),
      taskResultMsg(
        "t1",
        `正文引用 <usage>status: failed, tokens: 1, tool_uses: 9, duration_ms: 9, sub_id: badbad</usage>\n\n${makeUsageTag(200, {
          status: "succeeded",
          toolUses: 2,
          durationMs: 3000,
          subId: "abc123",
        })}`,
      ),
    ];

    expect(parseTaskUsageFromMessages(messages)).toEqual([
      {
        index: 1,
        description: "审查输出",
        tokens: 200,
        toolUses: 2,
        durationMs: 3000,
        subId: "abc123",
        status: "succeeded",
      },
    ]);
  });
});

function makeChildResult(overrides: Partial<ChildAgentResult>): ChildAgentResult {
  const base: ChildAgentResult = {
    status: "completed",
    subAgentId: "00000000-0000-0000-0000-000000000abc",
    finalAssistantText: "",
    usage: { inputTokens: 100, outputTokens: 50 },
    toolUses: 0,
    durationMs: 1000,
  };
  return { ...base, ...overrides } as ChildAgentResult;
}

function makeContractMessages(
  description: string,
  childResult: ChildAgentResult,
): Message[] {
  const toolResult = formatChildResultAsToolResult(childResult, description);
  return [
    taskUseMsg("task-1", description),
    taskResultMsg("task-1", toolResult.content, toolResult.isError),
  ];
}
