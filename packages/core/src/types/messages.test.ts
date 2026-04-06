import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  extractText,
  extractToolCalls,
  hasToolCalls,
  toolResultMessage,
  userMessage,
} from "./messages.js";
import type {
  ContentBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./messages.js";

describe("消息构建辅助函数", () => {
  describe("userMessage", () => {
    it("应创建包含单个文本块的 user 消息", () => {
      const msg = userMessage("你好");

      expect(msg.role).toBe("user");
      expect(msg.content).toHaveLength(1);
      expect(msg.content[0]).toEqual({ type: "text", text: "你好" });
    });

    it("空字符串也应正常创建", () => {
      const msg = userMessage("");

      expect(msg.role).toBe("user");
      expect(msg.content[0]).toEqual({ type: "text", text: "" });
    });
  });

  describe("assistantMessage", () => {
    it("应创建包含单个文本块的 assistant 消息", () => {
      const msg = assistantMessage("我来帮你");

      expect(msg.role).toBe("assistant");
      expect(msg.content).toHaveLength(1);
      expect(msg.content[0]).toEqual({ type: "text", text: "我来帮你" });
    });
  });

  describe("toolResultMessage", () => {
    it("应创建包含工具结果的 user 消息", () => {
      const results: ToolResultBlock[] = [
        { type: "tool_result", toolUseId: "call_1", content: "文件内容" },
        {
          type: "tool_result",
          toolUseId: "call_2",
          content: "命令失败",
          isError: true,
        },
      ];

      const msg = toolResultMessage(results);

      expect(msg.role).toBe("user");
      expect(msg.content).toHaveLength(2);
      expect(msg.content[0]).toEqual(results[0]);
      expect(msg.content[1]).toEqual(results[1]);
    });

    it("空结果数组应创建空内容的 user 消息", () => {
      const msg = toolResultMessage([]);

      expect(msg.role).toBe("user");
      expect(msg.content).toHaveLength(0);
    });
  });
});

describe("消息内容提取", () => {
  describe("extractText", () => {
    it("应从单个文本块中提取文本", () => {
      const msg = userMessage("hello");
      expect(extractText(msg)).toBe("hello");
    });

    it("应拼接多个文本块的文本", () => {
      const msg: Message = {
        role: "assistant",
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
      };
      expect(extractText(msg)).toBe("第一段第二段");
    });

    it("应跳过非文本块", () => {
      const msg: Message = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "让我想想..." },
          { type: "text", text: "答案是42" },
          {
            type: "tool_use",
            id: "call_1",
            name: "read",
            input: { path: "/tmp" },
          },
        ],
      };
      expect(extractText(msg)).toBe("答案是42");
    });

    it("没有文本块时应返回空字符串", () => {
      const msg: Message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      };
      expect(extractText(msg)).toBe("");
    });
  });

  describe("extractToolCalls", () => {
    it("应提取所有工具调用块", () => {
      const msg: Message = {
        role: "assistant",
        content: [
          { type: "text", text: "我来执行两个命令" },
          {
            type: "tool_use",
            id: "call_1",
            name: "bash",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "call_2",
            name: "read",
            input: { path: "README.md" },
          },
        ],
      };

      const calls = extractToolCalls(msg);

      expect(calls).toHaveLength(2);
      expect(calls[0]!.name).toBe("bash");
      expect(calls[1]!.name).toBe("read");
    });

    it("没有工具调用时应返回空数组", () => {
      const msg = assistantMessage("纯文本回复");
      expect(extractToolCalls(msg)).toEqual([]);
    });
  });

  describe("hasToolCalls", () => {
    it("包含工具调用时返回 true", () => {
      const msg: Message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      };
      expect(hasToolCalls(msg)).toBe(true);
    });

    it("不包含工具调用时返回 false", () => {
      expect(hasToolCalls(assistantMessage("hello"))).toBe(false);
    });
  });
});

describe("ContentBlock 类型判别", () => {
  it("switch 语句应能穷尽匹配所有类型", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hello" },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/img.png" },
      },
      { type: "tool_use", id: "1", name: "bash", input: {} },
      { type: "tool_result", toolUseId: "1", content: "ok" },
      { type: "thinking", thinking: "hmm" },
    ];

    const types: string[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          types.push("text");
          break;
        case "image":
          types.push("image");
          break;
        case "tool_use":
          types.push("tool_use");
          break;
        case "tool_result":
          types.push("tool_result");
          break;
        case "thinking":
          types.push("thinking");
          break;
      }
    }

    expect(types).toEqual([
      "text",
      "image",
      "tool_use",
      "tool_result",
      "thinking",
    ]);
  });

  it("type guard 类型收窄应正确工作", () => {
    const block: ContentBlock = {
      type: "tool_use",
      id: "call_1",
      name: "bash",
      input: { command: "ls" },
    };

    if (block.type === "tool_use") {
      // 此处 TypeScript 应自动收窄为 ToolUseBlock
      const toolBlock: ToolUseBlock = block;
      expect(toolBlock.name).toBe("bash");
      expect(toolBlock.input).toEqual({ command: "ls" });
    }

    const textBlock: ContentBlock = { type: "text", text: "hello" };
    if (textBlock.type === "text") {
      const narrowed: TextBlock = textBlock;
      expect(narrowed.text).toBe("hello");
    }
  });
});
