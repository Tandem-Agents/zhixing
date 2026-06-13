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
  opts: { toolUses?: number; durationMs?: number; subId?: string } = {},
): string {
  const parts = [`tokens: ${tokens}`];
  if (opts.toolUses !== undefined) parts.push(`tool_uses: ${opts.toolUses}`);
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

  it("失败 / 中止状态由真实 Task formatter 文本推断，防止协议漂移", () => {
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

  it("非 Task / 孤儿结果 / 损坏 usage 均 best-effort 跳过", () => {
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
