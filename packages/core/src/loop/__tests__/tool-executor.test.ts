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

// ─── abort 路径测试 ───

import type { ExecuteToolCallsResult } from "../types.js";

async function drainResult(
  gen: AsyncGenerator<AgentYield, ExecuteToolCallsResult>,
): Promise<ExecuteToolCallsResult> {
  while (true) {
    const { value, done } = await gen.next();
    if (done) return value;
  }
}

function makeBatchTool(
  name: string,
  handler: () => Promise<{ content: string; isError?: boolean }> | { content: string; isError?: boolean },
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: "object" as const },
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    call: async () => handler(),
  };
}

describe("executeToolCalls · abort 路径", () => {
  const calls3: ToolUseBlock[] = [
    { type: "tool_use", id: "1", name: "t", input: {} },
    { type: "tool_use", id: "2", name: "t", input: {} },
    { type: "tool_use", id: "3", name: "t", input: {} },
  ];

  it("循环顶 abort guard:已 aborted signal → 立即退出,所有 tool_use 进 unexecutedToolUses", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const tool = makeBatchTool("t", () => ({ content: "ok" }));

    const result = await drainResult(
      executeToolCalls({
        toolCalls: calls3,
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
        abortSignal: ctrl.signal,
      }),
    );

    expect(result.completedResults).toHaveLength(0);
    expect(result.unexecutedToolUses).toHaveLength(3);
    expect(result.unexecutedToolUses.map((t) => t.id)).toEqual(["1", "2", "3"]);
    // 工具间隙 abort,非工具内 → undefined
    expect(result.abortedDuringToolAt).toBeUndefined();
  });

  it("第 N 工具完成后 abort:completedResults 含已完成的合规 result,unexecutedToolUses 含未执行的", async () => {
    const ctrl = new AbortController();
    let executedCount = 0;
    const tool = makeBatchTool("t", () => {
      executedCount++;
      if (executedCount === 2) {
        // 第 2 个工具完成 (返回前) 触发 abort,第 3 个工具进 unexecutedToolUses
        // 当前工具的合规 result 必须 push (在 abort check 之前) —— 否则 abort 时丢 result
        // 会让 LLM 在下一轮看不到该工具已执行,可能重发同 tool_use 引发幂等性破坏
        ctrl.abort();
      }
      return { content: `done-${executedCount}` };
    });

    const result = await drainResult(
      executeToolCalls({
        toolCalls: calls3,
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
        abortSignal: ctrl.signal,
      }),
    );

    expect(result.completedResults).toHaveLength(2);
    expect(result.completedResults[0]?.toolUseId).toBe("1");
    expect(result.completedResults[1]?.toolUseId).toBe("2");
    expect(result.unexecutedToolUses).toHaveLength(1);
    expect(result.unexecutedToolUses[0]?.id).toBe("3");
    // abort 在工具完成 (await 期间) 触发,记录退出时刻供 toolGraceMs 计算
    expect(typeof result.abortedDuringToolAt).toBe("number");
  });

  it("工具 await 期间 abort 抛 AbortError:当前工具不进 completedResults,从当前进 unexecutedToolUses", async () => {
    const ctrl = new AbortController();
    let attemptCount = 0;
    const tool = makeBatchTool("t", () => {
      attemptCount++;
      if (attemptCount === 1) {
        return { content: "done-1" };
      }
      // 第 2 个工具 await 期间 abort,模拟工具响应 abort 抛 AbortError
      ctrl.abort();
      throw new Error("AbortError: aborted by signal");
    });

    const result = await drainResult(
      executeToolCalls({
        toolCalls: calls3,
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
        abortSignal: ctrl.signal,
      }),
    );

    // 第 1 个完成,第 2 个 abort 抛错不进 completedResults
    expect(result.completedResults).toHaveLength(1);
    expect(result.completedResults[0]?.toolUseId).toBe("1");
    // 第 2 个 + 第 3 个进 unexecutedToolUses (cleanup 注入 placeholder)
    expect(result.unexecutedToolUses).toHaveLength(2);
    expect(result.unexecutedToolUses.map((t) => t.id)).toEqual(["2", "3"]);
    expect(typeof result.abortedDuringToolAt).toBe("number");
  });

  it("非 abort 路径:completedResults 含全部,unexecutedToolUses 空,abortedDuringToolAt undefined", async () => {
    const tool = makeBatchTool("t", () => ({ content: "ok" }));

    const result = await drainResult(
      executeToolCalls({
        toolCalls: calls3,
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
      }),
    );

    expect(result.completedResults).toHaveLength(3);
    expect(result.unexecutedToolUses).toEqual([]);
    expect(result.abortedDuringToolAt).toBeUndefined();
  });

  it("catch 块 abort 抛 AbortError:yield 序列只含 tool_start,不 yield tool_end (cleanup 注入唯一 placeholder)", async () => {
    // 修复回归:之前 catch 块 abort 路径 yield/emit tool_end 与 cleanup placeholder 重复,
    // 同一 tool_use 收两个 tool_result 进 user message → Anthropic API 报 400。
    // 修复后 catch 块只 break,cleanup 在 agent-loop 那一层为 unexecutedToolUses (含本工具)
    // 注入唯一 placeholder。
    const ctrl = new AbortController();
    let attemptCount = 0;
    const tool = makeBatchTool("t", () => {
      attemptCount++;
      if (attemptCount === 1) {
        return { content: "done-1" };
      }
      ctrl.abort();
      throw new Error("AbortError: aborted by signal");
    });

    const yields: AgentYield[] = [];
    const gen = executeToolCalls({
      toolCalls: calls3,
      tools: [tool],
      deps: passthroughDeps,
      workingDirectory: "/tmp",
      abortSignal: ctrl.signal,
    });

    let result: ExecuteToolCallsResult | undefined;
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        result = value;
        break;
      }
      yields.push(value);
    }

    // tool_start: tc1 + tc2 (tc3 因循环顶 abort guard 不进)
    const toolStarts = yields.filter((y) => y.type === "tool_start");
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts.map((y) => (y.type === "tool_start" ? y.id : ""))).toEqual([
      "1",
      "2",
    ]);

    // tool_end: 只 tc1 (完成的);tc2 因 catch 块 abort 不 yield (避免与 cleanup placeholder 重复)
    const toolEnds = yields.filter((y) => y.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]?.type === "tool_end" && toolEnds[0].id).toBe("1");

    // 返回值:tc1 进 completedResults,tc2+tc3 进 unexecutedToolUses
    expect(result?.completedResults).toHaveLength(1);
    expect(result?.unexecutedToolUses).toHaveLength(2);
  });

  it("工具未找到分支保持 isError 路径:不进 unexecutedToolUses,继续后续 tool", async () => {
    const tool = makeBatchTool("t", () => ({ content: "ok" }));
    const callsWithMissing: ToolUseBlock[] = [
      { type: "tool_use", id: "1", name: "t", input: {} },
      { type: "tool_use", id: "2", name: "missing-tool", input: {} },
      { type: "tool_use", id: "3", name: "t", input: {} },
    ];

    const result = await drainResult(
      executeToolCalls({
        toolCalls: callsWithMissing,
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
      }),
    );

    // 全部 3 个进 completedResults (含 missing 的 isError tool_result)
    expect(result.completedResults).toHaveLength(3);
    expect(result.completedResults[1]?.isError).toBe(true);
    expect(result.unexecutedToolUses).toEqual([]);
  });
});
