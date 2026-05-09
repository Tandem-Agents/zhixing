import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../../../types/tools.js";
import { CapabilityState } from "../../../capability/index.js";
import type { RenderContext } from "../../types.js";
import { ToolSchemaCompilerStage } from "../tool-schema-compiler.js";

// ─── 测试辅助 ───

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object" as const },
    call: async () => ({ content: "" }),
  };
}

function ctx(tools: ToolDefinition[]): RenderContext {
  return { messages: [], tools, state: {} };
}

// ─── 基础过滤 ───

describe("ToolSchemaCompilerStage · 按 layer 过滤", () => {
  it("空状态 + 任意 tools → 全过滤掉（未注册视为 cold）", () => {
    const state = new CapabilityState();
    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("read"), tool("memory")];
    const out = stage.render(ctx(tools));
    expect(out.tools).toEqual([]);
  });

  it("全 always → 全保留，引用透传", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    state.initialize("recall_history", "always");
    state.initialize("request_capabilities", "always");
    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("memory"), tool("recall_history"), tool("request_capabilities")];
    const out = stage.render(ctx(tools));
    expect(out.tools).toBe(tools); // 引用透传
  });

  it("全 hot → 全保留，引用透传", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.initialize("grep", "discoverable");
    state.recordToolUse("read");
    state.recordToolUse("grep");
    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("read"), tool("grep")];
    const out = stage.render(ctx(tools));
    expect(out.tools).toBe(tools);
  });

  it("混合 always + hot + discoverable → 仅暴露 always + hot", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    state.initialize("read", "discoverable");
    state.initialize("write", "discoverable");
    state.recordToolUse("read"); // read → hot

    const stage = new ToolSchemaCompilerStage(state);
    const tools = [
      tool("memory"),
      tool("read"),
      tool("write"),
    ];
    const out = stage.render(ctx(tools));
    expect(out.tools.map((t) => t.name)).toEqual(["memory", "read"]);
  });

  it("全 discoverable → 空 tools[]", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.initialize("write", "discoverable");
    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("read"), tool("write")];
    const out = stage.render(ctx(tools));
    expect(out.tools).toEqual([]);
  });

  it("cold 工具过滤掉", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    state.initialize("legacy", "cold");
    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("memory"), tool("legacy")];
    const out = stage.render(ctx(tools));
    expect(out.tools.map((t) => t.name)).toEqual(["memory"]);
  });

  it("未注册工具过滤掉（视为 cold）", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    // "stranger" 没注册
    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("memory"), tool("stranger")];
    const out = stage.render(ctx(tools));
    expect(out.tools.map((t) => t.name)).toEqual(["memory"]);
  });
});

// ─── 顺序保持 + 引用稳定 ───

describe("ToolSchemaCompilerStage · 顺序与引用语义", () => {
  it("过滤后 tools 顺序按原 ctx.tools 顺序", () => {
    const state = new CapabilityState();
    state.initialize("a", "always");
    state.initialize("b", "discoverable");
    state.initialize("c", "always");
    state.initialize("d", "discoverable");
    state.initialize("e", "always");
    const stage = new ToolSchemaCompilerStage(state);
    const tools = ["a", "b", "c", "d", "e"].map((name) => tool(name));
    const out = stage.render(ctx(tools));
    expect(out.tools.map((t) => t.name)).toEqual(["a", "c", "e"]);
  });

  it("无过滤发生时 tools 引用与输入相同", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    state.initialize("read", "discoverable");
    state.recordToolUse("read"); // → hot
    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("memory"), tool("read")];
    const out = stage.render(ctx(tools));
    expect(out.tools).toBe(tools);
  });

  it("有过滤发生时 tools 是新数组（不修改输入）", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    state.initialize("read", "discoverable");
    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("memory"), tool("read")];
    const out = stage.render(ctx(tools));
    expect(out.tools).not.toBe(tools);
    expect(tools).toHaveLength(2); // 输入未被修改
  });

  it("messages 字段始终原样透传", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    const stage = new ToolSchemaCompilerStage(state);
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
    ];
    const out = stage.render({ messages, tools: [tool("memory")], state: {} });
    expect(out.messages).toBe(messages);
  });
});

// ─── 与 LRU 降级动态联动 ───

describe("ToolSchemaCompilerStage · 与 capability LRU 联动", () => {
  it("hot 工具在 LRU 降级后，下一次 render 不再暴露", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.advanceTurn();
    state.recordToolUse("read"); // → hot, lastUseTurn=1

    const stage = new ToolSchemaCompilerStage(state);
    const tools = [tool("read")];

    // 当前 hot：暴露
    expect(stage.render(ctx(tools)).tools.map((t) => t.name)).toEqual(["read"]);

    // 推进超过保持窗口 → 降级
    for (let i = 0; i < 8; i++) state.advanceTurn();
    expect(state.layerOf("read")).toBe("discoverable");

    // 现在不暴露
    expect(stage.render(ctx(tools)).tools).toEqual([]);
  });
});
