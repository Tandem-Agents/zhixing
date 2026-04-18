import { describe, expect, it } from "vitest";
import {
  DIGEST_PREVIEW_CHARS,
  MAX_DIGEST_COUNT,
  extractTurnDigest,
  formatDigestTrail,
} from "../turn-digest.js";
import type { TurnDigest } from "../turn-digest.js";
import type { Turn, ToolCallRecord } from "../../transcript/types.js";
import { userMessage, assistantMessage } from "../../types/messages.js";

// ─── 测试辅助 ───

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    type: "turn",
    turnIndex: 1,
    timestamp: "2026-04-18T12:00:00Z",
    userMessage: userMessage("你好"),
    assistantMessage: assistantMessage("你好！有什么可以帮你的？"),
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    name: "read",
    input: { file_path: "/src/app.ts" },
    result: "file content...",
    ...overrides,
  };
}

function makeDigest(overrides: Partial<TurnDigest> = {}): TurnDigest {
  return {
    turnIndex: 1,
    userMessagePreview: "测试消息",
    toolCalls: [],
    filesModified: [],
    outcome: "success",
    ...overrides,
  };
}

// ─── extractTurnDigest ───

describe("extractTurnDigest", () => {
  describe("userMessagePreview", () => {
    it("preserves short messages", () => {
      const turn = makeTurn({ userMessage: userMessage("简短消息") });
      const digest = extractTurnDigest(turn);
      expect(digest.userMessagePreview).toBe("简短消息");
    });

    it("truncates messages exceeding DIGEST_PREVIEW_CHARS", () => {
      const longText = "重".repeat(DIGEST_PREVIEW_CHARS + 20);
      const turn = makeTurn({ userMessage: userMessage(longText) });
      const digest = extractTurnDigest(turn);

      expect(digest.userMessagePreview).toHaveLength(DIGEST_PREVIEW_CHARS + 1);
      expect(digest.userMessagePreview.endsWith("…")).toBe(true);
    });

    it("handles empty user message", () => {
      const turn = makeTurn({ userMessage: userMessage("") });
      const digest = extractTurnDigest(turn);
      expect(digest.userMessagePreview).toBe("");
    });

    it("concatenates multiple text blocks", () => {
      const turn = makeTurn({
        userMessage: {
          role: "user",
          content: [
            { type: "text", text: "第一段" },
            { type: "text", text: "第二段" },
          ],
        },
      });
      const digest = extractTurnDigest(turn);
      expect(digest.userMessagePreview).toBe("第一段第二段");
    });

    it("ignores non-text blocks", () => {
      const turn = makeTurn({
        userMessage: {
          role: "user",
          content: [
            { type: "text", text: "用户消息" },
            {
              type: "tool_result",
              toolUseId: "t1",
              content: "should be ignored",
            },
          ],
        },
      });
      const digest = extractTurnDigest(turn);
      expect(digest.userMessagePreview).toBe("用户消息");
    });
  });

  describe("toolCalls formatting", () => {
    it("formats tool with file_path as name(filename)", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({ name: "read", input: { file_path: "/src/auth.ts" } }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.toolCalls).toEqual(["read(auth.ts)"]);
    });

    it("formats bash with command preview", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({
            name: "bash",
            input: { command: "npm test -- --watch" },
          }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.toolCalls).toEqual(["bash(npm test -- --watch)"]);
    });

    it("truncates long bash commands to 30 chars", () => {
      const longCmd =
        "npm run build && npm test && npm run lint && npm run format";
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({ name: "bash", input: { command: longCmd } }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.toolCalls[0]!.length).toBeLessThanOrEqual(
        "bash()".length + 30,
      );
    });

    it("strips multiline commands to first line", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({
            name: "bash",
            input: { command: "echo hello\necho world" },
          }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.toolCalls).toEqual(["bash(echo hello)"]);
    });

    it("formats tool without file_path as name only", () => {
      const turn = makeTurn({
        toolCalls: [makeToolCall({ name: "glob", input: { pattern: "*.ts" } })],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.toolCalls).toEqual(["glob"]);
    });

    it("handles Windows backslash paths", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({
            name: "edit",
            input: { file_path: "C:\\Users\\dev\\src\\app.ts" },
          }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.toolCalls).toEqual(["edit(app.ts)"]);
    });

    it("returns empty array when no toolCalls", () => {
      const turn = makeTurn({ toolCalls: undefined });
      const digest = extractTurnDigest(turn);
      expect(digest.toolCalls).toEqual([]);
    });
  });

  describe("filesModified", () => {
    it("extracts files from edit tool calls", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({
            name: "edit",
            input: { file_path: "/src/auth.ts" },
          }),
          makeToolCall({
            name: "write",
            input: { file_path: "/src/config.ts" },
          }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.filesModified).toEqual(["/src/auth.ts", "/src/config.ts"]);
    });

    it("ignores read-only tools", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({
            name: "read",
            input: { file_path: "/src/auth.ts" },
          }),
          makeToolCall({ name: "grep", input: { pattern: "TODO" } }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.filesModified).toEqual([]);
    });

    it("deduplicates repeated file paths", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({
            name: "edit",
            input: { file_path: "/src/auth.ts" },
          }),
          makeToolCall({
            name: "edit",
            input: { file_path: "/src/auth.ts" },
          }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.filesModified).toEqual(["/src/auth.ts"]);
    });

    it("includes notebook_edit as mutation tool", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({
            name: "notebook_edit",
            input: { file_path: "/notebooks/analysis.ipynb" },
          }),
        ],
      });
      const digest = extractTurnDigest(turn);
      expect(digest.filesModified).toEqual(["/notebooks/analysis.ipynb"]);
    });
  });

  describe("outcome", () => {
    it("returns success when no errors", () => {
      const turn = makeTurn({
        toolCalls: [makeToolCall({ isError: false })],
      });
      expect(extractTurnDigest(turn).outcome).toBe("success");
    });

    it("returns error when any tool has isError", () => {
      const turn = makeTurn({
        toolCalls: [
          makeToolCall({ isError: false }),
          makeToolCall({ isError: true }),
        ],
      });
      expect(extractTurnDigest(turn).outcome).toBe("error");
    });

    it("returns success for no tool calls", () => {
      const turn = makeTurn({ toolCalls: [] });
      expect(extractTurnDigest(turn).outcome).toBe("success");
    });
  });

  it("preserves turnIndex", () => {
    const turn = makeTurn({ turnIndex: 42 });
    expect(extractTurnDigest(turn).turnIndex).toBe(42);
  });
});

// ─── formatDigestTrail ───

describe("formatDigestTrail", () => {
  it("returns empty string for empty array", () => {
    expect(formatDigestTrail([])).toBe("");
  });

  it("formats single digest", () => {
    const result = formatDigestTrail([
      makeDigest({ turnIndex: 1, userMessagePreview: "你好" }),
    ]);

    expect(result).toBe('[轨迹]\nT1: "你好"');
  });

  it("formats digest with tool calls", () => {
    const result = formatDigestTrail([
      makeDigest({
        turnIndex: 3,
        userMessagePreview: "重构代码",
        toolCalls: ["edit(auth.ts)", "bash(npm test)"],
      }),
    ]);

    expect(result).toContain("edit(auth.ts), bash(npm test)");
    expect(result).toContain("→");
  });

  it("groups duplicate tool calls with ×N", () => {
    const result = formatDigestTrail([
      makeDigest({
        turnIndex: 1,
        userMessagePreview: "分析项目",
        toolCalls: ["read(a.ts)", "read(a.ts)", "read(a.ts)"],
      }),
    ]);

    expect(result).toContain("read(a.ts)×3");
  });

  it("appends error marker for error outcome", () => {
    const result = formatDigestTrail([
      makeDigest({
        turnIndex: 2,
        userMessagePreview: "运行测试",
        toolCalls: ["bash(npm test)"],
        outcome: "error",
      }),
    ]);

    expect(result).toContain("→ 错误");
  });

  it("formats multiple digests as multiline", () => {
    const result = formatDigestTrail([
      makeDigest({ turnIndex: 1, userMessagePreview: "第一轮" }),
      makeDigest({ turnIndex: 2, userMessagePreview: "第二轮" }),
      makeDigest({ turnIndex: 3, userMessagePreview: "第三轮" }),
    ]);

    const lines = result.split("\n");
    expect(lines[0]).toBe("[轨迹]");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("T1");
    expect(lines[3]).toContain("T3");
  });

  it("merges oldest digests when exceeding MAX_DIGEST_COUNT", () => {
    const digests: TurnDigest[] = [];
    for (let i = 1; i <= MAX_DIGEST_COUNT + 5; i++) {
      digests.push(
        makeDigest({
          turnIndex: i,
          userMessagePreview: `第${i}轮`,
          filesModified: i <= 3 ? [`/file${i}.ts`] : [],
        }),
      );
    }

    const result = formatDigestTrail(digests);
    const lines = result.split("\n");

    expect(lines[0]).toBe("[轨迹]");
    expect(lines[1]).toMatch(/^T1-T\d+: \d+ 轮/);
    expect(lines[1]).toContain("文件修改");
    expect(lines).toHaveLength(MAX_DIGEST_COUNT + 1);
  });

  it("group summary counts unique files across merged digests", () => {
    const digests: TurnDigest[] = [];
    for (let i = 1; i <= MAX_DIGEST_COUNT + 2; i++) {
      digests.push(
        makeDigest({
          turnIndex: i,
          userMessagePreview: `T${i}`,
          filesModified: i <= 3 ? [`/file${i}.ts`] : [],
        }),
      );
    }

    const result = formatDigestTrail(digests);
    expect(result).toContain("3 文件修改");
  });

  it("group summary omits file count when no files modified", () => {
    const digests: TurnDigest[] = [];
    for (let i = 1; i <= MAX_DIGEST_COUNT + 2; i++) {
      digests.push(
        makeDigest({ turnIndex: i, userMessagePreview: `T${i}` }),
      );
    }

    const result = formatDigestTrail(digests);
    expect(result).not.toContain("文件修改");
  });
});
