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
  it("failed Task → status=failed + 无 tool_uses + partial 段不影响解析", () => {
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
