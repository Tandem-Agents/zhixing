import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { Message } from "../../types/messages.js";
import type { CompactMarker, TranscriptHeader, Turn } from "../types.js";
import {
  appendRecord,
  countTurns,
  loadRecords,
  parseRecords,
} from "../serializer.js";

// ─── 测试 fixtures ───

const HEADER: TranscriptHeader = {
  type: "header",
  version: 1,
  conversationId: "20260409-a3f1",
  name: "测试会话",
  createdAt: "2026-04-09T10:00:00.000Z",
  model: "deepseek-chat",
  provider: "deepseek",
};

const USER_MSG: Message = {
  role: "user",
  content: [{ type: "text", text: "你好，帮我读一下 README" }],
};

const ASSISTANT_MSG: Message = {
  role: "assistant",
  content: [
    { type: "text", text: "好的，我来读取 README 文件。" },
    {
      type: "tool_use",
      id: "tool_1",
      name: "read_file",
      input: { path: "README.md" },
    },
  ],
};

const TURN: Turn = {
  type: "turn",
  turnIndex: 0,
  timestamp: "2026-04-09T10:00:05.000Z",
  userMessage: USER_MSG,
  assistantMessage: ASSISTANT_MSG,
  toolCalls: [
    { name: "read_file", input: { path: "README.md" }, result: "# Zhixing" },
  ],
  usage: { inputTokens: 100, outputTokens: 50 },
};

const COMPACT: CompactMarker = {
  type: "compact",
  timestamp: "2026-04-09T11:00:00.000Z",
  summary: "## 核心目标\n用户想了解项目结构\n## 约束与偏好\nTypeScript monorepo",
  turnsCompacted: 15,
  tokensBefore: 45000,
  tokensAfter: 8000,
};

// ─── 临时目录管理 ───

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTempDir("transcript");
});

function tmpFile(name: string): string {
  return path.join(tmpDir, name);
}

// ─── parseRecords（纯函数） ───

describe("parseRecords", () => {
  it("解析包含 header + turn + compact 的完整 JSONL", () => {
    const content = [
      JSON.stringify(HEADER),
      JSON.stringify(TURN),
      JSON.stringify({ ...TURN, turnIndex: 1 }),
      JSON.stringify(COMPACT),
    ].join("\n");

    const result = parseRecords(content);
    expect(result.header).toEqual(HEADER);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].turnIndex).toBe(0);
    expect(result.turns[1].turnIndex).toBe(1);
    expect(result.compacts).toHaveLength(1);
    expect(result.compacts[0].summary).toContain("核心目标");
    expect(result.corruptedLines).toBe(0);
  });

  it("跳过损坏的行，不影响其余记录", () => {
    const content = [
      JSON.stringify(HEADER),
      "这不是JSON{{{",
      JSON.stringify(TURN),
      '{"type":"unknown","foo":"bar"}',
      "",
    ].join("\n");

    const result = parseRecords(content);
    expect(result.header).toEqual(HEADER);
    expect(result.turns).toHaveLength(1);
    expect(result.corruptedLines).toBe(2);
  });

  it("空内容返回 null header 和空数组", () => {
    const result = parseRecords("");
    expect(result.header).toBeNull();
    expect(result.turns).toHaveLength(0);
    expect(result.compacts).toHaveLength(0);
    expect(result.corruptedLines).toBe(0);
  });

  it("正确处理包含中文的消息", () => {
    const chineseTurn: Turn = {
      ...TURN,
      userMessage: {
        role: "user",
        content: [{ type: "text", text: "请帮我重构数据库连接池" }],
      },
    };
    const content = [
      JSON.stringify(HEADER),
      JSON.stringify(chineseTurn),
    ].join("\n");

    const result = parseRecords(content);
    expect(result.turns[0].userMessage.content[0]).toEqual({
      type: "text",
      text: "请帮我重构数据库连接池",
    });
  });

  it("处理末尾换行符", () => {
    const content = JSON.stringify(HEADER) + "\n" + JSON.stringify(TURN) + "\n";
    const result = parseRecords(content);
    expect(result.header).toEqual(HEADER);
    expect(result.turns).toHaveLength(1);
  });

  it("旧格式 sessionId 自动迁移为 conversationId", () => {
    const oldHeader = {
      type: "header",
      version: 1,
      sessionId: "20260409-legacy",
      name: null,
      createdAt: "2026-04-09T10:00:00.000Z",
      model: "m",
      provider: "p",
    };
    const content = JSON.stringify(oldHeader);
    const result = parseRecords(content);

    expect(result.header).not.toBeNull();
    expect(result.header!.conversationId).toBe("20260409-legacy");
    expect((result.header as Record<string, unknown>).sessionId).toBeUndefined();
  });
});

// ─── appendRecord + loadRecords ───

describe("appendRecord / loadRecords", () => {
  it("追加多条记录后可全部加载", async () => {
    const file = tmpFile("full.jsonl");
    await fs.writeFile(file, JSON.stringify(HEADER) + "\n", "utf-8");
    await appendRecord(file, TURN);
    await appendRecord(file, { ...TURN, turnIndex: 1 });
    await appendRecord(file, COMPACT);

    const result = await loadRecords(file);
    expect(result.header).toEqual(HEADER);
    expect(result.turns).toHaveLength(2);
    expect(result.compacts).toHaveLength(1);
    expect(result.corruptedLines).toBe(0);
  });

  it("round-trip 保持数据完整（序列化 → 反序列化 = 原始数据）", async () => {
    const file = tmpFile("roundtrip.jsonl");
    await fs.writeFile(file, JSON.stringify(HEADER) + "\n", "utf-8");
    await appendRecord(file, TURN);

    const result = await loadRecords(file);
    expect(result.header).toEqual(HEADER);
    expect(result.turns[0]).toEqual(TURN);
  });
});

// ─── countTurns ───

describe("countTurns", () => {
  it("正确统计 turn 数量", async () => {
    const file = tmpFile("count.jsonl");
    await fs.writeFile(file, JSON.stringify(HEADER) + "\n", "utf-8");
    await appendRecord(file, TURN);
    await appendRecord(file, { ...TURN, turnIndex: 1 });
    await appendRecord(file, { ...TURN, turnIndex: 2 });
    await appendRecord(file, COMPACT);

    const count = await countTurns(file);
    expect(count).toBe(3);
  });

  it("空文件返回 0", async () => {
    const file = tmpFile("empty.jsonl");
    await fs.writeFile(file, JSON.stringify(HEADER) + "\n", "utf-8");

    const count = await countTurns(file);
    expect(count).toBe(0);
  });

  it("文件不存在返回 0", async () => {
    const count = await countTurns(tmpFile("nope.jsonl"));
    expect(count).toBe(0);
  });
});

// ─── CompactMarker 字段填法契约（段切换路径 vs 数据层兜底路径） ───

describe("CompactMarker 填法契约", () => {
  it("段切换路径：含 segmentId + structuredSummary + summary 完整往返", () => {
    const segmentMarker: CompactMarker = {
      type: "compact",
      timestamp: "2026-05-11T10:00:00Z",
      summary: "facts: 讨论了 X\nstate: 进行中 Y\nactive: file=A.ts",
      turnsCompacted: 20,
      tokensBefore: 130_000,
      tokensAfter: 800,
      segmentId: "seg-001",
      structuredSummary: {
        facts: "讨论了 X",
        state: "进行中 Y",
        active: "file=A.ts",
      },
    };

    const json = JSON.stringify(segmentMarker);
    const result = parseRecords(json);

    expect(result.compacts).toHaveLength(1);
    expect(result.compacts[0]?.segmentId).toBe("seg-001");
    expect(result.compacts[0]?.structuredSummary?.facts).toBe("讨论了 X");
    expect(result.compacts[0]?.structuredSummary?.state).toBe("进行中 Y");
    expect(result.compacts[0]?.structuredSummary?.active).toBe("file=A.ts");
    expect(result.compacts[0]?.summary).toContain("facts: 讨论了 X");
  });

  it("数据层兜底路径：只填 summary，扩展字段缺省", () => {
    const fallbackMarker: CompactMarker = {
      type: "compact",
      timestamp: "2026-05-11T11:00:00Z",
      summary: "纯文本摘要 from LLMSummarize",
      turnsCompacted: 5,
      tokensBefore: 50_000,
      tokensAfter: 5_000,
    };

    const json = JSON.stringify(fallbackMarker);
    const result = parseRecords(json);

    expect(result.compacts).toHaveLength(1);
    expect(result.compacts[0]?.summary).toBe("纯文本摘要 from LLMSummarize");
    expect(result.compacts[0]?.segmentId).toBeUndefined();
    expect(result.compacts[0]?.structuredSummary).toBeUndefined();
  });

  it("混合 JSONL：段切换 marker 与兜底 marker 共存，各自字段隔离", () => {
    const content = [
      JSON.stringify(HEADER),
      JSON.stringify({
        type: "compact",
        timestamp: "T1",
        summary: "fallback",
        turnsCompacted: 1,
        tokensBefore: 100,
        tokensAfter: 50,
      }),
      JSON.stringify({
        type: "compact",
        timestamp: "T2",
        summary: "struct",
        turnsCompacted: 2,
        tokensBefore: 200,
        tokensAfter: 80,
        segmentId: "seg-A",
        structuredSummary: { facts: "f", state: "s", active: "a" },
      }),
    ].join("\n");

    const result = parseRecords(content);

    expect(result.compacts).toHaveLength(2);
    expect(result.compacts[0]?.segmentId).toBeUndefined();
    expect(result.compacts[1]?.segmentId).toBe("seg-A");
    expect(result.compacts[1]?.structuredSummary?.facts).toBe("f");
  });
});
