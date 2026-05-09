import { describe, expect, it } from "vitest";
import {
  toolResultMessage,
  userMessage,
} from "../../../../types/messages.js";
import type { Message, ToolUseBlock } from "../../../../types/messages.js";
import { buildCompactSummaryPair } from "../../../system-meta.js";
import {
  AnchorRegistry,
  createDefaultAnchorRegistry,
  readAnchor,
} from "../../anchors/index.js";
import type { RenderContext } from "../../types.js";
import { ToolResultAnchorStage } from "../tool-result-anchor.js";

// ─── 测试辅助 ───

function assistantToolUse(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `调用 ${toolName}` },
      {
        type: "tool_use",
        id: toolUseId,
        name: toolName,
        input,
      } satisfies ToolUseBlock,
    ],
  };
}

function ctxFor(messages: Message[]): RenderContext {
  return { messages, tools: [], state: {} };
}

// ─── 基础锚化 ───

describe("ToolResultAnchorStage · 基础锚化", () => {
  it("空 messages → pass-through", () => {
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages: Message[] = [];
    const out = stage.render(ctxFor(messages));
    expect(out.messages).toBe(messages);
  });

  it("无 tool_use 历史 → messages 引用透传", () => {
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages = [userMessage("你好"), userMessage("world")];
    const out = stage.render(ctxFor(messages));
    expect(out.messages).toBe(messages);
  });

  it("仅 1 个 tool_result（即 Focus）→ 保 raw 不锚化", () => {
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages: Message[] = [
      userMessage("查 file"),
      assistantToolUse("u1", "read", { path: "a.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u1",
          content: "line1\nline2\nline3",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));
    expect(out.messages).toBe(messages); // 无 anchor 替换 → 引用透传
    const lastResult = out.messages[2]!.content[0];
    expect(lastResult?.type).toBe("tool_result");
    if (lastResult?.type === "tool_result") {
      expect(lastResult.content).toBe("line1\nline2\nline3");
    }
  });

  it("多个 tool_use：仅 Focus 保 raw，其他锚化", () => {
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages: Message[] = [
      userMessage("分析 a.ts 与 b.ts"),
      assistantToolUse("u1", "read", { path: "a.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u1",
          content: "aaa\nbbb\nccc",
        },
      ]),
      assistantToolUse("u2", "read", { path: "b.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u2",
          content: "xxx\nyyy",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));

    // u1 历史 tool_result：被锚化
    const u1Block = out.messages[2]!.content[0];
    expect(u1Block?.type).toBe("tool_result");
    if (u1Block?.type === "tool_result") {
      expect(u1Block.content).toBe("[read a.ts, 3 lines]");
    }

    // u2 Focus：保 raw
    const u2Block = out.messages[4]!.content[0];
    if (u2Block?.type === "tool_result") {
      expect(u2Block.content).toBe("xxx\nyyy");
    }
  });

  it("parallel tool_use：同 assistant 整批 Focus 都保 raw", () => {
    // 设计核心（innovation §4.2 / §6.5）：LLM 第一次见 tool_result 时需要完整 raw
    // 才能消化。parallel tool_use 的整批 result 在下一 LLM call 是同时第一次曝光的，
    // 必须整批 Focus，否则非末尾 result 在初次曝光就只剩 anchor，违反核心原则。
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages: Message[] = [
      userMessage("read a + b"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "并发读取" },
          {
            type: "tool_use",
            id: "u1",
            name: "read",
            input: { path: "a.ts" },
          },
          {
            type: "tool_use",
            id: "u2",
            name: "read",
            input: { path: "b.ts" },
          },
        ],
      },
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u1",
          content: "aa\nbb",
        },
        {
          type: "tool_result",
          toolUseId: "u2",
          content: "cc\ndd\nee",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));
    // 整批引用透传 —— 没任何 anchor 替换，输出引用与输入相同
    expect(out.messages).toBe(messages);

    const blocks = out.messages[2]!.content;
    const u1 = blocks.find(
      (b) => b.type === "tool_result" && b.toolUseId === "u1",
    );
    if (u1?.type === "tool_result") {
      expect(u1.content).toBe("aa\nbb");
    }
    const u2 = blocks.find(
      (b) => b.type === "tool_result" && b.toolUseId === "u2",
    );
    if (u2?.type === "tool_result") {
      expect(u2.content).toBe("cc\ndd\nee");
    }
  });

  it("mixed batches：旧批整批 anchor，新 parallel 批整批 raw", () => {
    // 序列：串行 u1 → parallel (u2, u3) → 下一次 LLM call
    // 期望：u1 已被前一轮消化 → anchor；u2/u3 是最近 assistant 整批 → 都 raw
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages: Message[] = [
      userMessage("先读 a 再并发读 b/c"),
      assistantToolUse("u1", "read", { path: "a.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u1",
          content: "aa\nbb\ncc",
        },
      ]),
      {
        role: "assistant",
        content: [
          { type: "text", text: "再并发读 b 和 c" },
          {
            type: "tool_use",
            id: "u2",
            name: "read",
            input: { path: "b.ts" },
          },
          {
            type: "tool_use",
            id: "u3",
            name: "read",
            input: { path: "c.ts" },
          },
        ],
      },
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u2",
          content: "B\nB",
        },
        {
          type: "tool_result",
          toolUseId: "u3",
          content: "C\nC\nC",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));

    // u1 旧批 → anchor
    const u1 = out.messages[2]!.content[0];
    if (u1?.type === "tool_result") {
      expect(u1.content).toBe("[read a.ts, 3 lines]");
    }

    // u2 / u3 同批新 Focus → 都 raw
    const newBlocks = out.messages[4]!.content;
    const u2 = newBlocks.find(
      (b) => b.type === "tool_result" && b.toolUseId === "u2",
    );
    if (u2?.type === "tool_result") {
      expect(u2.content).toBe("B\nB");
    }
    const u3 = newBlocks.find(
      (b) => b.type === "tool_result" && b.toolUseId === "u3",
    );
    if (u3?.type === "tool_result") {
      expect(u3.content).toBe("C\nC\nC");
    }
  });

  it("最近 assistant 是纯文本（无 tool_use）：继续向前找带 tool_use 的 assistant", () => {
    // 防御场景：上一轮 LLM 完成 tool_use → 拿到 result → 又一次 LLM call 是
    // 纯文本 assistant 回复（无 tool_use）。再下一 call 渲染时，"最近 assistant
    // with tool_use" 应是更早的那条；其 results 仍是当前 Focus（纯文本 turn 没有
    // 新引入 tool_result，那批仍未"被新批替代"）。
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages: Message[] = [
      userMessage("read a"),
      assistantToolUse("u1", "read", { path: "a.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u1",
          content: "aa",
        },
      ]),
      {
        role: "assistant",
        content: [{ type: "text", text: "总结：a 是单行测试文件" }],
      },
      userMessage("好，再帮我..."),
    ];

    const out = stage.render(ctxFor(messages));
    // u1 仍是最近含 tool_use 的 assistant 的 Focus → 保 raw
    const u1 = out.messages[2]!.content[0];
    if (u1?.type === "tool_result") {
      expect(u1.content).toBe("aa");
    }
    // 全程无 anchor 替换 → 引用透传
    expect(out.messages).toBe(messages);
  });
});

// ─── 边界条件 ───

describe("ToolResultAnchorStage · 边界条件", () => {
  it("找不到配对 tool_use（toolUseId 异常）→ 保留原样", () => {
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages: Message[] = [
      userMessage("初次"),
      // 模拟异常历史：tool_result 但无对应 tool_use
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "orphan-id",
          content: "orphan content",
        },
      ]),
      // 再来一个正常的 Focus，确保 stage 跑到这里
      assistantToolUse("u-focus", "read", { path: "x.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u-focus",
          content: "x",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));

    // orphan tool_result 保留原样
    const orphan = out.messages[1]!.content[0];
    if (orphan?.type === "tool_result") {
      expect(orphan.content).toBe("orphan content");
    }
  });

  it("失败 tool_result 走 error 锚", () => {
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const messages: Message[] = [
      userMessage("read"),
      assistantToolUse("u1", "read", { path: "missing.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u1",
          content: "ENOENT",
          isError: true,
        },
      ]),
      assistantToolUse("u2", "read", { path: "found.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u2",
          content: "ok",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));
    const u1 = out.messages[2]!.content[0];
    if (u1?.type === "tool_result") {
      expect(u1.content).toBe("[read missing.ts, error]");
    }
  });

  it("system-meta 消息透传不锚化", () => {
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const [summaryPair, ackPair] = buildCompactSummaryPair("此处为压缩摘要");
    const messages: Message[] = [
      summaryPair,
      ackPair,
      userMessage("继续"),
      assistantToolUse("u1", "read", { path: "x.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u1",
          content: "x",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));
    // system-meta 消息引用不变
    expect(out.messages[0]).toBe(summaryPair);
    expect(out.messages[1]).toBe(ackPair);
  });

  it("已经是 anchor 形态（content 已等于 generator 输出）→ 不重建对象", () => {
    // tier-compressor T4 输出形态可能恰好等于 generator 会生成的 anchor，
    // 此时 stage 跳过 content 替换，保留原 block 引用。
    const reg = new AnchorRegistry().register({
      toolName: "read",
      generate: () => "[read pre-anchored, 3 lines]",
    });
    const stage = new ToolResultAnchorStage(reg);

    const preAnchoredBlock = {
      type: "tool_result" as const,
      toolUseId: "u1",
      content: "[read pre-anchored, 3 lines]",
    };
    const messages: Message[] = [
      userMessage("x"),
      assistantToolUse("u1", "read", { path: "pre-anchored" }),
      { role: "user", content: [preAnchoredBlock] },
      assistantToolUse("u2", "read", { path: "y.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u2",
          content: "fresh",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));
    // u1 block 引用透传（content 已等于 anchor，不重建）
    expect(out.messages[2]!.content[0]).toBe(preAnchoredBlock);
  });

  it("tools 字段透传不动（Stage 1 不影响工具）", () => {
    const stage = new ToolResultAnchorStage(createDefaultAnchorRegistry());
    const tools = [
      {
        name: "x",
        description: "x",
        inputSchema: { type: "object" as const },
        call: async () => ({ content: "" }),
      },
    ];
    const out = stage.render({
      messages: [],
      tools,
      state: {},
    });
    expect(out.tools).toBe(tools);
  });
});

// ─── 与 fallback 的协作 ───

describe("ToolResultAnchorStage · 与 fallback 协作", () => {
  it("registry 仅注册 read：未注册工具走 fallback", () => {
    const reg = new AnchorRegistry().register(readAnchor);
    const stage = new ToolResultAnchorStage(reg);
    const messages: Message[] = [
      userMessage("混合"),
      assistantToolUse("u1", "custom_tool", { foo: "bar" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u1",
          content: "abc",
        },
      ]),
      assistantToolUse("u-focus", "read", { path: "y.ts" }),
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "u-focus",
          content: "ok",
        },
      ]),
    ];

    const out = stage.render(ctxFor(messages));
    const u1 = out.messages[2]!.content[0];
    if (u1?.type === "tool_result") {
      expect(u1.content).toBe("[custom_tool, ok, 3 chars]");
    }
  });
});
