import { describe, expect, it } from "vitest";
import { userMessage, assistantMessage } from "../../../types/messages.js";
import type { Message } from "../../../types/messages.js";
import type { ToolDefinition } from "../../../types/tools.js";
import { ContextCompiler } from "../compiler.js";
import type { Stage, RenderContext, StageOutput } from "../types.js";

// ─── 测试辅助 ───

function stubTool(name: string): ToolDefinition {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: "object" },
    call: async () => ({ content: "" }),
  };
}

function makeStage(
  id: string,
  fn: (ctx: RenderContext) => StageOutput | Promise<StageOutput>,
): Stage {
  return { id, render: fn };
}

// ─── 空 stage 链 ───

describe("ContextCompiler · 空链", () => {
  it("空 stage 链 = pass-through（messages / tools 引用直接透传）", async () => {
    const compiler = new ContextCompiler();
    const messages: Message[] = [userMessage("hello")];
    const tools = [stubTool("read")];

    const result = await compiler.compile({ messages, tools, state: {} });

    expect(result.messages).toBe(messages);
    expect(result.tools).toBe(tools);
    expect(result.stateDelta).toEqual({});
  });

  it("默认构造无参数等同传空数组", async () => {
    const c1 = new ContextCompiler();
    const c2 = new ContextCompiler([]);
    const input = {
      messages: [userMessage("x")],
      tools: [],
      state: {},
    };
    const r1 = await c1.compile(input);
    const r2 = await c2.compile(input);
    expect(r1.messages).toBe(r2.messages);
  });
});

// ─── Stage 链顺序 ───

describe("ContextCompiler · stage 链顺序", () => {
  it("stage[i] 输出成为 stage[i+1] 输入", async () => {
    const order: string[] = [];

    const stage1 = makeStage("s1", (ctx) => {
      order.push("s1");
      return {
        messages: [...ctx.messages, userMessage("from s1")],
        tools: ctx.tools,
      };
    });
    const stage2 = makeStage("s2", (ctx) => {
      order.push("s2");
      // s2 看到的 messages 含 s1 加的 "from s1"
      const last = ctx.messages[ctx.messages.length - 1];
      const lastText =
        last && last.content[0]?.type === "text" ? last.content[0].text : "";
      return {
        messages: [...ctx.messages, userMessage(`s2 saw: ${lastText}`)],
        tools: ctx.tools,
      };
    });

    const compiler = new ContextCompiler([stage1, stage2]);
    const result = await compiler.compile({
      messages: [userMessage("init")],
      tools: [],
      state: {},
    });

    expect(order).toEqual(["s1", "s2"]);
    expect(result.messages).toHaveLength(3);
    const lastBlock = result.messages[2]!.content[0];
    expect(lastBlock?.type).toBe("text");
    if (lastBlock?.type === "text") {
      expect(lastBlock.text).toBe("s2 saw: from s1");
    }
  });

  it("stage 可同时改 messages 和 tools", async () => {
    const stage = makeStage("s", (ctx) => ({
      messages: [...ctx.messages, assistantMessage("added")],
      tools: [...ctx.tools, stubTool("added_tool")],
    }));
    const compiler = new ContextCompiler([stage]);
    const result = await compiler.compile({
      messages: [userMessage("x")],
      tools: [stubTool("read")],
      state: {},
    });
    expect(result.messages).toHaveLength(2);
    expect(result.tools.map((t) => t.name)).toEqual(["read", "added_tool"]);
  });
});

// ─── 失败容忍 ───

describe("ContextCompiler · stage 失败跳过", () => {
  it("单 stage 抛错 → 跳过，下一 stage 收到上一 stage 输出", async () => {
    const order: string[] = [];

    const stage1 = makeStage("s1", (ctx) => {
      order.push("s1");
      return {
        messages: [...ctx.messages, assistantMessage("ok-1")],
        tools: ctx.tools,
      };
    });
    const stage2Throws = makeStage("s2", () => {
      order.push("s2-attempt");
      throw new Error("stage2 fail");
    });
    const stage3 = makeStage("s3", (ctx) => {
      order.push("s3");
      return {
        messages: [...ctx.messages, assistantMessage("ok-3")],
        tools: ctx.tools,
      };
    });

    const compiler = new ContextCompiler([stage1, stage2Throws, stage3]);
    const result = await compiler.compile({
      messages: [userMessage("init")],
      tools: [],
      state: {},
    });

    // s2 尝试但抛错；s3 仍按 s1 输出继续
    expect(order).toEqual(["s1", "s2-attempt", "s3"]);
    // s3 看到的是 s1 输出（init + ok-1），而非 s2 的（不存在）
    expect(result.messages).toHaveLength(3); // init + ok-1 (s1) + ok-3 (s3)
  });

  it("第一 stage 抛错 → 后续 stage 收到原始输入", async () => {
    const stage1 = makeStage("s1", () => {
      throw new Error("fail");
    });
    const stage2 = makeStage("s2", (ctx) => ({
      messages: [...ctx.messages, assistantMessage("from s2")],
      tools: ctx.tools,
    }));

    const compiler = new ContextCompiler([stage1, stage2]);
    const result = await compiler.compile({
      messages: [userMessage("init")],
      tools: [],
      state: {},
    });

    expect(result.messages).toHaveLength(2); // init + from s2
  });

  it("全部 stage 失败 → 退化为透明层（输入直接成为输出）", async () => {
    const stage1 = makeStage("s1", () => {
      throw new Error("a");
    });
    const stage2 = makeStage("s2", () => {
      throw new Error("b");
    });

    const compiler = new ContextCompiler([stage1, stage2]);
    const messages = [userMessage("init")];
    const tools = [stubTool("read")];
    const result = await compiler.compile({ messages, tools, state: {} });

    expect(result.messages).toBe(messages);
    expect(result.tools).toBe(tools);
  });
});

// ─── StateDelta 聚合 ───

describe("ContextCompiler · StateDelta 聚合", () => {
  it("无 stage 输出 stateDelta → 聚合结果为空对象", async () => {
    const stage = makeStage("s", (ctx) => ({
      messages: ctx.messages,
      tools: ctx.tools,
    }));
    const compiler = new ContextCompiler([stage]);
    const result = await compiler.compile({
      messages: [userMessage("x")],
      tools: [],
      state: {},
    });
    expect(result.stateDelta).toEqual({});
  });

  it("多 stage 输出 stateDelta → 浅合并", async () => {
    // StateDelta 当前为占位 type；测试用 cast 携带任意字段验证合并逻辑
    const stage1 = makeStage("s1", (ctx) => ({
      messages: ctx.messages,
      tools: ctx.tools,
      stateDelta: { fieldA: 1 } as never,
    }));
    const stage2 = makeStage("s2", (ctx) => ({
      messages: ctx.messages,
      tools: ctx.tools,
      stateDelta: { fieldB: 2 } as never,
    }));

    const compiler = new ContextCompiler([stage1, stage2]);
    const result = await compiler.compile({
      messages: [userMessage("x")],
      tools: [],
      state: {},
    });

    expect(result.stateDelta).toEqual({ fieldA: 1, fieldB: 2 });
  });
});

// ─── 异步 stage ───

describe("ContextCompiler · 异步 stage", () => {
  it("async stage 被 await", async () => {
    const stage = makeStage("async-s", async (ctx) => {
      await new Promise((r) => setTimeout(r, 5));
      return {
        messages: [...ctx.messages, assistantMessage("async-output")],
        tools: ctx.tools,
      };
    });
    const compiler = new ContextCompiler([stage]);
    const result = await compiler.compile({
      messages: [userMessage("x")],
      tools: [],
      state: {},
    });
    expect(result.messages).toHaveLength(2);
  });

  it("sync stage 与 async stage 混合 → 按注册顺序串行", async () => {
    const order: string[] = [];
    const sync1 = makeStage("sync1", (ctx) => {
      order.push("sync1");
      return { messages: ctx.messages, tools: ctx.tools };
    });
    const async1 = makeStage("async1", async (ctx) => {
      order.push("async1-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("async1-end");
      return { messages: ctx.messages, tools: ctx.tools };
    });
    const sync2 = makeStage("sync2", (ctx) => {
      order.push("sync2");
      return { messages: ctx.messages, tools: ctx.tools };
    });

    const compiler = new ContextCompiler([sync1, async1, sync2]);
    await compiler.compile({
      messages: [userMessage("x")],
      tools: [],
      state: {},
    });

    expect(order).toEqual(["sync1", "async1-start", "async1-end", "sync2"]);
  });
});
