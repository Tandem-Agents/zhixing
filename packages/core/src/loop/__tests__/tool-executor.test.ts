/**
 * tool-executor 的 ToolExecutionContext 注入契约
 *
 * 覆盖 ctx.llm 字段透传——secondary-llm-capability.md §三 承诺：
 *   - 不传 llmRoles 时，工具收到的 ctx.llm 为 undefined（消费者必须处理 !ctx.llm）
 *   - 传 llmRoles 时，工具收到的就是 caller 传入的同一实例（不复制、不替换）
 *
 * 这层契约支撑后续 WebFetch distill / 子 agent / MCP digest 等需要 secondary 的工具
 * 能稳定从 ctx 拿到 roles，不被 tool-executor 的内部演化偷偷破坏。
 */

import { describe, expect, it } from "vitest";
import type { LLMProvider, LLMRole, LLMRoles } from "../../types/llm.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../types/tools.js";
import type { ToolUseBlock } from "../../types/messages.js";
import type { AgentLoopDeps, AgentYield } from "../types.js";
import { executeToolCalls } from "../tool-executor.js";

// ─── 辅助 ───

function makeStubRoles(): LLMRoles {
  const stubProvider = {} as LLMProvider;
  const stubRole: LLMRole = {
    provider: stubProvider,
    model: "stub-model",
    chat: async function* () {
      // 测试不会触发 chat
    },
  };
  return { main: stubRole, secondary: stubRole };
}

interface CapturedCtx {
  ctx?: ToolExecutionContext;
}

function makeSpyTool(captured: CapturedCtx): ToolDefinition {
  return {
    name: "spy",
    description: "captures execution context",
    inputSchema: { type: "object" as const },
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    call: async (_input, ctx) => {
      captured.ctx = ctx;
      return { content: "ok" };
    },
  };
}

const passthroughDeps: AgentLoopDeps = {
  // executeToolCalls 不调用 callLLM，但类型要求字段存在
  callLLM: () => {
    throw new Error("callLLM should not be called from executeToolCalls");
  },
  executeTool: (tool, input, ctx) => tool.call(input, ctx),
};

const TOOL_CALL: ToolUseBlock = {
  type: "tool_use",
  id: "call_1",
  name: "spy",
  input: {},
};

async function drain(
  gen: AsyncGenerator<AgentYield, unknown, undefined>,
): Promise<void> {
  while (true) {
    const { done } = await gen.next();
    if (done) return;
  }
}

// ─── 测试 ───

describe("executeToolCalls · ctx.llm 注入契约", () => {
  it("不传 llmRoles → ctx.llm 为 undefined", async () => {
    const captured: CapturedCtx = {};
    const tool = makeSpyTool(captured);

    const gen = executeToolCalls({
      toolCalls: [TOOL_CALL],
      tools: [tool],
      deps: passthroughDeps,
      workingDirectory: "/tmp/wd",
    });
    await drain(gen);

    expect(captured.ctx).toBeDefined();
    expect(captured.ctx!.llm).toBeUndefined();
  });

  it("传 llmRoles → ctx.llm 与传入实例引用相同（不复制）", async () => {
    const captured: CapturedCtx = {};
    const tool = makeSpyTool(captured);
    const roles = makeStubRoles();

    const gen = executeToolCalls({
      toolCalls: [TOOL_CALL],
      tools: [tool],
      deps: passthroughDeps,
      workingDirectory: "/tmp/wd",
      llmRoles: roles,
    });
    await drain(gen);

    expect(captured.ctx!.llm).toBe(roles);
    expect(captured.ctx!.llm!.main).toBe(roles.main);
    expect(captured.ctx!.llm!.secondary).toBe(roles.secondary);
  });

  it("workingDirectory / abortSignal 同时透传，不被 llm 注入污染", async () => {
    const captured: CapturedCtx = {};
    const tool = makeSpyTool(captured);
    const roles = makeStubRoles();
    const ac = new AbortController();

    const gen = executeToolCalls({
      toolCalls: [TOOL_CALL],
      tools: [tool],
      deps: passthroughDeps,
      workingDirectory: "/custom/dir",
      abortSignal: ac.signal,
      llmRoles: roles,
    });
    await drain(gen);

    expect(captured.ctx!.workingDirectory).toBe("/custom/dir");
    expect(captured.ctx!.abortSignal).toBe(ac.signal);
    expect(captured.ctx!.llm).toBe(roles);
  });

  it("多 toolCalls 时每次 ctx.llm 都注入同一实例", async () => {
    const captured1: CapturedCtx = {};
    const captured2: CapturedCtx = {};
    const tool1: ToolDefinition = {
      ...makeSpyTool(captured1),
      name: "spy1",
    };
    const tool2: ToolDefinition = {
      ...makeSpyTool(captured2),
      name: "spy2",
    };
    const roles = makeStubRoles();

    const gen = executeToolCalls({
      toolCalls: [
        { ...TOOL_CALL, id: "c1", name: "spy1" },
        { ...TOOL_CALL, id: "c2", name: "spy2" },
      ],
      tools: [tool1, tool2],
      deps: passthroughDeps,
      workingDirectory: "/tmp",
      llmRoles: roles,
    });
    await drain(gen);

    expect(captured1.ctx!.llm).toBe(roles);
    expect(captured2.ctx!.llm).toBe(roles);
  });
});
