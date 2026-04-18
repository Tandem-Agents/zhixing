import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Message } from "../../types/messages.js";
import type { CompactMarker, TranscriptHeader, Turn } from "../types.js";
import {
  appendRecord,
  countTurns,
  loadRecords,
  parseRecords,
  readHeader,
  writeHeader,
} from "../serializer.js";

// ─── 测试 fixtures ───

const HEADER: TranscriptHeader = {
  type: "header",
  version: 1,
  sessionId: "20260409-a3f1",
  name: "测试会话",
  projectPath: "E:\\Dev\\longxia\\zhixing",
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
  summary: "## 核心目标\n用户想了解项目结构\n## 技术上下文\nTypeScript monorepo",
  turnsCompacted: 15,
  tokensBefore: 45000,
  tokensAfter: 8000,
};

// ─── 临时目录管理 ───

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-transcript-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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
});

// ─── writeHeader + readHeader ───

describe("writeHeader / readHeader", () => {
  it("写入 header 后可正确读取", async () => {
    const file = tmpFile("transcript.jsonl");
    await writeHeader(file, HEADER);

    const header = await readHeader(file);
    expect(header).toEqual(HEADER);
  });

  it("自动创建不存在的父目录", async () => {
    const file = path.join(tmpDir, "deep", "nested", "transcript.jsonl");
    await writeHeader(file, HEADER);

    const header = await readHeader(file);
    expect(header).toEqual(HEADER);
  });

  it("文件不存在时返回 null", async () => {
    const header = await readHeader(tmpFile("nonexistent.jsonl"));
    expect(header).toBeNull();
  });

  it("首行不是 header 时返回 null", async () => {
    const file = tmpFile("bad.jsonl");
    await fs.writeFile(file, JSON.stringify(TURN) + "\n");

    const header = await readHeader(file);
    expect(header).toBeNull();
  });
});

// ─── appendRecord + loadRecords ───

describe("appendRecord / loadRecords", () => {
  it("追加多条记录后可全部加载", async () => {
    const file = tmpFile("full.jsonl");
    await writeHeader(file, HEADER);
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
    await writeHeader(file, HEADER);
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
    await writeHeader(file, HEADER);
    await appendRecord(file, TURN);
    await appendRecord(file, { ...TURN, turnIndex: 1 });
    await appendRecord(file, { ...TURN, turnIndex: 2 });
    await appendRecord(file, COMPACT);

    const count = await countTurns(file);
    expect(count).toBe(3);
  });

  it("空文件返回 0", async () => {
    const file = tmpFile("empty.jsonl");
    await writeHeader(file, HEADER);

    const count = await countTurns(file);
    expect(count).toBe(0);
  });

  it("文件不存在返回 0", async () => {
    const count = await countTurns(tmpFile("nope.jsonl"));
    expect(count).toBe(0);
  });
});
