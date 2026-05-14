/**
 * parseTaskUsageFromMessages 契约级单测
 *
 * 覆盖矩阵:
 *   - 空消息 / 无 Task 调用 → []
 *   - 单 Task succeeded:tool_uses 字段在 + status=succeeded + 1-based index
 *   - 单 Task failed/aborted:无 tool_uses 字段 + status 推断正确 + partial 不影响解析
 *   - 多 Task 顺序保留:1/2/3 index + sort 稳定
 *   - tool_use ↔ tool_result 配对:id 不匹配的 tool_result 被忽略
 *   - 非 Task 工具不收录:其他工具的 tool_result 不进结果集
 *   - usage 标签解析失败(格式异常 / 缺标签)→ 跳过该 entry,不抛异常
 *   - description 缺失(input 无该字段)→ 空串兜底
 *   - tokens 数值解析正确(覆盖大数 / 0)
 */

import { describe, expect, it } from "vitest";
import type { Message } from "@zhixing/core";
import { formatChildResultAsToolResult } from "@zhixing/orchestrator/tools";
import type { ChildAgentResult } from "@zhixing/orchestrator/subagent";
import { parseTaskUsageFromMessages } from "../parse-task-usage.js";

// ─── 测试辅助 ───

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

function taskResultMsg(
  id: string,
  content: string,
  isError = false,
): Message {
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

// ─── 边界:空 / 无 Task ───

describe("parseTaskUsageFromMessages · 边界场景", () => {
  it("空消息列表 → 空数组", () => {
    expect(parseTaskUsageFromMessages([])).toEqual([]);
  });

  it("仅 user/assistant 文本无 Task 调用 → 空数组", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    expect(parseTaskUsageFromMessages(messages)).toEqual([]);
  });

  it("非 Task 工具调用(如 read)不进结果集", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "r1",
            name: "Read",
            input: { path: "/foo" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "r1",
            content: "file content",
          },
        ],
      },
    ];
    expect(parseTaskUsageFromMessages(messages)).toEqual([]);
  });
});

// ─── 单 Task succeeded ───

describe("parseTaskUsageFromMessages · succeeded 路径", () => {
  it("单个 Task 成功 → status=succeeded + tool_uses 在 + 1-based index", () => {
    const usage = makeUsageTag(35400, {
      toolUses: 5,
      durationMs: 8000,
      subId: "ab12cd",
    });
    const messages: Message[] = [
      taskUseMsg("t1", "调研模块结构"),
      taskResultMsg("t1", `Final summary text...\n\n${usage}`),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      index: 1,
      description: "调研模块结构",
      tokens: 35400,
      toolUses: 5,
      durationMs: 8000,
      subId: "ab12cd",
      status: "succeeded",
    });
  });

  it("description 缺失 → 空串兜底,不抛异常", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Task", input: { prompt: "x" } },
        ],
      },
      taskResultMsg("t1", `done\n\n${makeUsageTag(100, { toolUses: 1 })}`),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries[0]?.description).toBe("");
  });
});

// ─── 单 Task failed/aborted ───

describe("parseTaskUsageFromMessages · failed/aborted 路径", () => {
  it("failed Task (旧 format, 无 type tag) → status=failed + 无 tool_uses + partial 段不影响解析", () => {
    const usage = makeUsageTag(8000, { durationMs: 3000, subId: "fa11ed" });
    const content =
      `[Task "查 API" failed: sub-agent reached max tokens budget]\n\n` +
      `Partial output:\nI started analyzing but ran out...\n\n` +
      usage;
    const messages: Message[] = [
      taskUseMsg("t1", "查 API"),
      taskResultMsg("t1", content, true),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries[0]?.status).toBe("failed");
    expect(entries[0]?.tokens).toBe(8000);
    expect(entries[0]?.toolUses).toBeUndefined();
  });

  it("failed Task (新 format, 含 SubAgentErrorType tag) → status 正确推断为 failed", () => {
    // task.ts format 升级后 sub-agent 失败时 ToolResult.content 含 type tag,
    // 如 `[Task "X" failed (provider_error): 400 invalid_request_error: ...]`。
    // 本测试覆盖 regex 同步兼容新 format,锁死跨包文本协议演进。
    const usage = makeUsageTag(2000, { durationMs: 11000, subId: "abc123" });
    const content =
      `[Task "分析项目架构设计" failed (provider_error): 400 invalid_request_error: reasoning_content missing]\n\n` +
      usage;
    const messages: Message[] = [
      taskUseMsg("t1", "分析项目架构设计"),
      taskResultMsg("t1", content, true),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("failed");
    expect(entries[0]?.tokens).toBe(2000);
  });

  it("aborted Task → status=aborted + tokens 解析正确", () => {
    const usage = makeUsageTag(2000, { durationMs: 1500, subId: "abc123" });
    const content = `[Task "总结" aborted: parent agent was aborted]\n\n${usage}`;
    const messages: Message[] = [
      taskUseMsg("t1", "总结"),
      taskResultMsg("t1", content, true),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries[0]?.status).toBe("aborted");
    expect(entries[0]?.tokens).toBe(2000);
  });
});

// ─── 多 Task 顺序 ───

describe("parseTaskUsageFromMessages · 多 Task 顺序保留", () => {
  it("3 个 Task 调用 → 1/2/3 index 按 messages 出现顺序", () => {
    const u1 = makeUsageTag(35400, { toolUses: 5, subId: "111aaa" });
    const u2 = makeUsageTag(12300, { toolUses: 2, subId: "222bbb" });
    const u3 = makeUsageTag(7400, { toolUses: 1, subId: "333ccc" });
    const messages: Message[] = [
      taskUseMsg("a", "调研 ..."),
      taskUseMsg("b", "查 API"),
      taskUseMsg("c", "总结 ..."),
      taskResultMsg("a", `text\n\n${u1}`),
      taskResultMsg("b", `text\n\n${u2}`),
      taskResultMsg("c", `text\n\n${u3}`),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.index).toBe(1);
    expect(entries[0]?.description).toBe("调研 ...");
    expect(entries[1]?.index).toBe(2);
    expect(entries[1]?.description).toBe("查 API");
    expect(entries[2]?.index).toBe(3);
    expect(entries[2]?.description).toBe("总结 ...");
  });

  it("tool_result 顺序乱(配对 by id)→ 仍按 tool_use 出现顺序输出", () => {
    const u1 = makeUsageTag(100, { toolUses: 1, subId: "aaaaaa" });
    const u2 = makeUsageTag(200, { toolUses: 2, subId: "bbbbbb" });
    const messages: Message[] = [
      taskUseMsg("a", "first"),
      taskUseMsg("b", "second"),
      taskResultMsg("b", `text\n\n${u2}`),
      taskResultMsg("a", `text\n\n${u1}`),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries[0]?.description).toBe("first");
    expect(entries[1]?.description).toBe("second");
  });
});

// ─── 容错 ───

describe("parseTaskUsageFromMessages · 容错性", () => {
  it("usage 标签缺失 → 跳过该 entry,不抛异常", () => {
    const messages: Message[] = [
      taskUseMsg("a", "无 usage 的任务"),
      taskResultMsg("a", "Final text without usage trailer"),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries).toEqual([]);
  });

  it("usage 标签格式损坏(缺 sub_id)→ 跳过该 entry", () => {
    const messages: Message[] = [
      taskUseMsg("a", "格式损坏"),
      taskResultMsg("a", "text\n\n<usage>tokens: 100</usage>"),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries).toEqual([]);
  });

  it("孤儿 tool_result(无对应 tool_use)→ 忽略,不污染输出", () => {
    const u = makeUsageTag(100, { toolUses: 1 });
    const messages: Message[] = [
      taskUseMsg("a", "real task"),
      taskResultMsg("orphan-id", `text\n\n${u}`),
      taskResultMsg("a", `text\n\n${u}`),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.description).toBe("real task");
  });

  it("tokens=0 + duration=0 边界数值正确解析(不被截断或视为 falsy)", () => {
    const usage = makeUsageTag(0, { toolUses: 0, durationMs: 0, subId: "000000" });
    const messages: Message[] = [
      taskUseMsg("a", "edge"),
      taskResultMsg("a", `text\n\n${usage}`),
    ];
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries[0]?.tokens).toBe(0);
    expect(entries[0]?.toolUses).toBe(0);
    expect(entries[0]?.durationMs).toBe(0);
  });
});

// ─── Contract: 与 task.ts format 双向绑定 ─────────────────────────────
//
// 跨包文本协议同步守门:本 parser (cli) 反向解析 orchestrator 包 task.ts 输出
// 的 ToolResult.content 字符串。parse-task-usage.ts 顶部注释已 acknowledge
// 这种"任一改动需双向同步,否则解析静默退化"的契约脆弱性。
//
// 本组测试用**真实的** `formatChildResultAsToolResult` 函数生成 ToolResult.content,
// 让 parser 跑一遍 → 断言 status 正确推断。锁死契约的机制:
//   - task.ts format 任何改动 → 这里 status 断言失败 → 强制开发者同步 parse 端 regex
//   - 不再靠人脑同步 / 注释提醒,silent failure 从架构层消除
//
// 不覆盖的内容:format 内详细文本(message / partial 等)由 task.test.ts 守 —— 本组
// 关注 parser 视角"能否识别 status",字段级覆盖由直接 fixture 测试承担(上方测试)。

describe("parseTaskUsageFromMessages · contract: 与 task.ts format 双向绑定", () => {
  // 最小 ChildAgentResult 构造器 —— 各 status 共享 usage / id 字段,各分支独立填差异字段
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

  // 用真实 format function 生成 messages,只填 parse-task-usage 关心的 description 字段
  function makeContractMessages(
    description: string,
    childResult: ChildAgentResult,
  ): Message[] {
    const toolResult = formatChildResultAsToolResult(childResult, description);
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description, prompt: "do work" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "task-1",
            content: toolResult.content,
            ...(toolResult.isError && { isError: true }),
          },
        ],
      },
    ];
  }

  it("completed: parser 推断为 succeeded(无 failed/aborted 前缀)", () => {
    const messages = makeContractMessages(
      "test",
      makeChildResult({
        status: "completed",
        finalAssistantText: "task done",
        toolUses: 3,
      }),
    );
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("succeeded");
  });

  it("failed (provider_error): parser 推断为 failed(SubAgentErrorType tag 同步)", () => {
    // 锁死 Layer 1+2 的 type tag format 与 parser 的 regex 同步 —— 这是本 contract
    // test 的核心目的: task.ts 若改 format → 此断言失败 → 强制改 regex
    const messages = makeContractMessages(
      "fetch data",
      makeChildResult({
        status: "failed",
        error: { type: "provider_error", message: "upstream rejected" },
      }),
    );
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("failed");
  });

  it("failed (max_turns_exceeded): sub-agent 专属 type 也正确识别", () => {
    // 验证 regex 不依赖具体 type 字符串,SubAgentErrorType 联合任意值都兼容
    const messages = makeContractMessages(
      "long task",
      makeChildResult({
        status: "failed",
        error: { type: "max_turns_exceeded", message: "max turns reached" },
      }),
    );
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries[0]?.status).toBe("failed");
  });

  it("aborted: parser 推断为 aborted", () => {
    const messages = makeContractMessages(
      "research",
      makeChildResult({
        status: "aborted",
        abortReason: { kind: "parent-abort" },
      }),
    );
    const entries = parseTaskUsageFromMessages(messages);
    expect(entries[0]?.status).toBe("aborted");
  });
});
