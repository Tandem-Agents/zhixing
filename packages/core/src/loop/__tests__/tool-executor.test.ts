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
  opts: { isParallelSafe?: boolean } = {},
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: "object" as const },
    isReadOnly: true,
    // 串行 abort 边界(前 K 完成 + 后 N-K 未启动)只在串行分支存在;并发分支
    // 入口已启动全 N 个 promise,无"未启动"边界。abort 契约用 unsafe 工具锚定
    // 串行路径,并发路径在专属 describe 段独立验证。默认 true 保持现有覆盖。
    isParallelSafe: opts.isParallelSafe ?? true,
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
    // 串行 abort 边界(完成 K 个 + 后 N-K 个未启动)是串行分支特有契约;
    // 显式 isParallelSafe=false 让本测试稳定锚定串行路径
    const tool = makeBatchTool("t", () => {
      executedCount++;
      if (executedCount === 2) {
        // 第 2 个工具完成 (返回前) 触发 abort,第 3 个工具进 unexecutedToolUses
        // 当前工具的合规 result 必须 push (在 abort check 之前) —— 否则 abort 时丢 result
        // 会让 LLM 在下一轮看不到该工具已执行,可能重发同 tool_use 引发幂等性破坏
        ctrl.abort();
      }
      return { content: `done-${executedCount}` };
    }, { isParallelSafe: false });

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
    // 串行路径下"前 K 完成 + 第 K+1 抛 AbortError + 后 N-K-1 未启动"分布是串行特有形态;
    // 显式 isParallelSafe=false 锁定串行路径
    const tool = makeBatchTool("t", () => {
      attemptCount++;
      if (attemptCount === 1) {
        return { content: "done-1" };
      }
      // 第 2 个工具 await 期间 abort,模拟工具响应 abort 抛 AbortError
      ctrl.abort();
      throw new Error("AbortError: aborted by signal");
    }, { isParallelSafe: false });

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
    //
    // 串行循环顶 abort guard 让 tc3 不发 tool_start 是串行分支特性;并发分支
    // 入口已发完 N 个 tool_start 才启动 promise,本测试用 isParallelSafe=false 锚定串行路径
    const ctrl = new AbortController();
    let attemptCount = 0;
    const tool = makeBatchTool("t", () => {
      attemptCount++;
      if (attemptCount === 1) {
        return { content: "done-1" };
      }
      ctrl.abort();
      throw new Error("AbortError: aborted by signal");
    }, { isParallelSafe: false });

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

// ─── 并发模式测试 ───
//
// 进入条件:N≥2 且 toolCalls 全部 isParallelSafe===true 且工具均已注册。
// 串行行为契约由上面的 describe 段覆盖,本段聚焦并发分支特有形态:
//   - tool_start 同步全发(批次启动可见性)
//   - tool_end 严格按输入顺序 yield(主 LLM 看到的 tool_result 顺序契约)
//   - allSettled rejected + abortSignal.aborted → 不 yield tool_end,进 unexecutedToolUses
//   - 入口 abort guard:已 aborted 时不发 tool_start
//   - 回退路径:含 unsafe / N=1 / 含未注册工具 → 走串行(行为零差异)

describe("executeToolCalls · 并发模式", () => {
  const calls3: ToolUseBlock[] = [
    { type: "tool_use", id: "1", name: "t", input: {} },
    { type: "tool_use", id: "2", name: "t", input: {} },
    { type: "tool_use", id: "3", name: "t", input: {} },
  ];

  it("happy path:全 safe N=3 → tool_start 同步全发,tool_end 按输入顺序,results 完整", async () => {
    let invokedCount = 0;
    const tool = makeBatchTool("t", () => {
      invokedCount += 1;
      return { content: `done-${invokedCount}` };
    });

    const yields: AgentYield[] = [];
    const gen = executeToolCalls({
      toolCalls: calls3,
      tools: [tool],
      deps: passthroughDeps,
      workingDirectory: "/tmp",
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

    // tool_start 同步全发(顺序 = 输入顺序),且全部出现在第一个 tool_end 之前
    const toolStarts = yields.filter((y) => y.type === "tool_start");
    const toolEnds = yields.filter((y) => y.type === "tool_end");
    expect(toolStarts).toHaveLength(3);
    expect(toolEnds).toHaveLength(3);
    expect(toolStarts.map((y) => (y.type === "tool_start" ? y.id : ""))).toEqual([
      "1",
      "2",
      "3",
    ]);

    // 关键不变量:批次启动可见性 —— 所有 tool_start 必在所有 tool_end 之前
    const lastStartIdx = yields.findIndex(
      (y) => y.type === "tool_start" && y.id === "3",
    );
    const firstEndIdx = yields.findIndex((y) => y.type === "tool_end");
    expect(lastStartIdx).toBeLessThan(firstEndIdx);

    // tool_end 严格按输入顺序(主 LLM 看到的 tool_result 顺序契约)
    expect(toolEnds.map((y) => (y.type === "tool_end" ? y.id : ""))).toEqual([
      "1",
      "2",
      "3",
    ]);

    // results 全部进 completedResults,顺序与 toolCalls 一致
    expect(result?.completedResults).toHaveLength(3);
    expect(result?.completedResults.map((r) => r.toolUseId)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(result?.unexecutedToolUses).toEqual([]);
    expect(result?.abortedDuringToolAt).toBeUndefined();
  });

  it("isError 隔离:3 工具 1 throw 非 abort,其他 2 仍各自完成 + isError tool_result", async () => {
    let invokeCount = 0;
    const tool = makeBatchTool("t", () => {
      invokeCount += 1;
      if (invokeCount === 2) {
        throw new Error("boom from tool 2");
      }
      return { content: `done-${invokeCount}` };
    });

    const result = await drainResult(
      executeToolCalls({
        toolCalls: calls3,
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
      }),
    );

    // 3 个 result 全部到位(主 LLM 看到完整 tool_result 集),其中 tc2 是 isError
    expect(result.completedResults).toHaveLength(3);
    expect(result.completedResults[0]?.isError).toBeFalsy();
    expect(result.completedResults[1]?.isError).toBe(true);
    expect(
      typeof result.completedResults[1]?.content === "string" &&
        result.completedResults[1].content.includes("boom from tool 2"),
    ).toBe(true);
    expect(result.completedResults[2]?.isError).toBeFalsy();
    expect(result.unexecutedToolUses).toEqual([]);
    // 非 abort 异常,abortedDuringToolAt 不应被设
    expect(result.abortedDuringToolAt).toBeUndefined();
  });

  it("入口 abort guard:已 aborted signal → 不发 tool_start,全部进 unexecutedToolUses", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const tool = makeBatchTool("t", () => ({ content: "ok" }));

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

    // 入口已 aborted → 没有任何 yield(无 tool_start / tool_end)
    expect(yields).toHaveLength(0);
    expect(result?.completedResults).toHaveLength(0);
    expect(result?.unexecutedToolUses).toHaveLength(3);
    expect(result?.unexecutedToolUses.map((t) => t.id)).toEqual(["1", "2", "3"]);
    // 工具间隙 abort,非工具内 → undefined(与串行入口 guard 行为对齐)
    expect(result?.abortedDuringToolAt).toBeUndefined();
  });

  it("批次进行中 abort:fulfilled 进 completedResults,reject 进 unexecutedToolUses,abortedDuringToolAt 有值", async () => {
    const ctrl = new AbortController();
    let invokeCount = 0;
    // 模拟"工具响应 abort 抛 AbortError":第 1 个正常完成,第 2/3 个并发 await 时
    // ctrl.abort() 被外部触发后抛错。并发分支 allSettled 等齐后,signal.aborted=true
    // 的 reject 走 unexecutedToolUses 路径(与串行 catch 块 abort 同语义,不 yield tool_end)
    const tool = makeBatchTool("t", async () => {
      invokeCount += 1;
      if (invokeCount === 1) {
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

    // tool_start 全 3 个发(批次启动)
    const toolStarts = yields.filter((y) => y.type === "tool_start");
    expect(toolStarts).toHaveLength(3);

    // tool_end 只 1 个(tc1 fulfilled);tc2/tc3 abort reject 不 yield(等 cleanup 注 placeholder)
    const toolEnds = yields.filter((y) => y.type === "tool_end");
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]?.type === "tool_end" && toolEnds[0].id).toBe("1");

    // completedResults: 仅 tc1
    expect(result?.completedResults).toHaveLength(1);
    expect(result?.completedResults[0]?.toolUseId).toBe("1");
    // unexecutedToolUses: tc2 + tc3(由 cleanup 在 agent-loop 那一层注 placeholder)
    expect(result?.unexecutedToolUses).toHaveLength(2);
    expect(result?.unexecutedToolUses.map((t) => t.id)).toEqual(["2", "3"]);
    // 整批退出时刻代理:allSettled 等齐时刻
    expect(typeof result?.abortedDuringToolAt).toBe("number");
  });

  it("回退串行:含 unsafe 工具 → 走串行路径(任一 unsafe 整批回退)", async () => {
    // 回退判定:任一 toolCall 命中的工具 isParallelSafe!==true 则 canRunParallel 返回 false
    const safeTool = makeBatchTool("safe", () => ({ content: "safe-ok" }));
    const unsafeTool = makeBatchTool(
      "unsafe",
      () => ({ content: "unsafe-ok" }),
      { isParallelSafe: false },
    );

    // 验证策略:让 unsafe 工具同步累加调用顺序 + 断言 [safe, unsafe, safe] 严格串行触发
    const startOrder: string[] = [];
    const safeWithOrder: ToolDefinition = {
      ...safeTool,
      call: async () => {
        startOrder.push("safe");
        return { content: "safe-ok" };
      },
    };
    const unsafeWithOrder: ToolDefinition = {
      ...unsafeTool,
      call: async () => {
        startOrder.push("unsafe");
        return { content: "unsafe-ok" };
      },
    };

    const result = await drainResult(
      executeToolCalls({
        toolCalls: [
          { type: "tool_use", id: "1", name: "safe", input: {} },
          { type: "tool_use", id: "2", name: "unsafe", input: {} },
          { type: "tool_use", id: "3", name: "safe", input: {} },
        ],
        tools: [safeWithOrder, unsafeWithOrder],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
      }),
    );

    // 串行路径下 push 顺序严格对应输入(并发可能乱序)
    expect(startOrder).toEqual(["safe", "unsafe", "safe"]);
    expect(result.completedResults).toHaveLength(3);
    expect(result.completedResults.map((r) => r.toolUseId)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("回退串行:N=1 单工具不进并发(避免 Promise.allSettled 开销)", async () => {
    const tool = makeBatchTool("t", () => ({ content: "single" }));

    const result = await drainResult(
      executeToolCalls({
        toolCalls: [{ type: "tool_use", id: "only", name: "t", input: {} }],
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
      }),
    );

    // 单工具走串行,行为完整一致(N=1 在并发模式无收益)
    expect(result.completedResults).toHaveLength(1);
    expect(result.completedResults[0]?.toolUseId).toBe("only");
    expect(result.completedResults[0]?.content).toBe("single");
  });

  it("回退串行:含未注册工具 → 走串行让 isError 分支合成 tool_result", async () => {
    // canRunParallel 内部 toolMap.get(name)?.isParallelSafe === true,未注册 → undefined → false
    // 走串行路径让"工具未找到 isError"分支处理(避免在并发分支重复实现错误路径)
    const tool = makeBatchTool("t", () => ({ content: "ok" }));
    const result = await drainResult(
      executeToolCalls({
        toolCalls: [
          { type: "tool_use", id: "1", name: "t", input: {} },
          { type: "tool_use", id: "2", name: "missing-tool", input: {} },
        ],
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
      }),
    );

    expect(result.completedResults).toHaveLength(2);
    expect(result.completedResults[0]?.isError).toBeFalsy();
    expect(result.completedResults[1]?.isError).toBe(true);
    expect(
      typeof result.completedResults[1]?.content === "string" &&
        result.completedResults[1].content.includes("not found"),
    ).toBe(true);
  });

  it("并发实证:3 个 50ms 工具 → 总耗时 ≈ max(单个) 而非 sum,实测远低于 150ms", async () => {
    // 并发收益核心:I/O 重叠让总时间 ≈ max(单个),而非 sum;
    // 阈值放松到 120ms 容忍 vitest 调度抖动 + Promise.allSettled overhead
    const sleepMs = 50;
    const tool = makeBatchTool("t", async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      return { content: "ok" };
    });

    const start = Date.now();
    const result = await drainResult(
      executeToolCalls({
        toolCalls: calls3,
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/tmp",
      }),
    );
    const elapsed = Date.now() - start;

    expect(result.completedResults).toHaveLength(3);
    // 串行 50ms × 3 = 150ms;并发 ≈ 50-80ms。120ms 阈值锚定"显著并行"
    expect(elapsed).toBeLessThan(120);
    // 同时验证下界(防 setTimeout 提前触发 vitest fake timers 误判):至少有一个 sleep 周期
    expect(elapsed).toBeGreaterThanOrEqual(sleepMs - 10);
  });

  it("ctx 透传契约:并发模式 N 工具均收到正确 workingDirectory / abortSignal / llm 同源引用", async () => {
    const captured: Array<ToolExecutionContext | undefined> = [];
    const roles = makeStubRoles();
    const ac = new AbortController();
    const tool: ToolDefinition = {
      name: "t",
      description: "ctx capture spy",
      inputSchema: { type: "object" as const },
      isReadOnly: true,
      isParallelSafe: true,
      needsPermission: false,
      call: async (_input, ctx) => {
        captured.push(ctx);
        return { content: "ok" };
      },
    };

    await drain(
      executeToolCalls({
        toolCalls: calls3,
        tools: [tool],
        deps: passthroughDeps,
        workingDirectory: "/concurrent/wd",
        abortSignal: ac.signal,
        llmRoles: roles,
      }),
    );

    expect(captured).toHaveLength(3);
    for (const ctx of captured) {
      expect(ctx).toBeDefined();
      // 三字段全部同源引用(并发模式共享同一 ctx 对象,串行 per-call 新建但内容相同)
      expect(ctx!.workingDirectory).toBe("/concurrent/wd");
      expect(ctx!.abortSignal).toBe(ac.signal);
      expect(ctx!.llm).toBe(roles);
    }
  });
});
