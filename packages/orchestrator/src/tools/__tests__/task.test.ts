/**
 * Task 工具测试矩阵
 *
 * 覆盖维度:
 *   A. formatChildResultAsToolResult 三态格式化(纯函数,无副作用)
 *      - completed:finalText + <usage> trailer + 无 isError 字段
 *      - failed:头部 [Task "X" failed: msg] + (partial?) + <usage> + isError=true
 *      - aborted:头部 [Task "X" aborted: reason] + (partial?) + <usage> + isError=true
 *      - 边界:partial 缺失 / error.message 缺失 / abortReason 缺失 各自降级文本
 *      - <usage> 字段顺序与截断(sub_id 前 6 字符)
 *
 *   B. TASK_INPUT_SCHEMA 严格契约(防 LLM 看到漂移的字段)
 *
 *   C. TASK_TOOL_PROMPT 关键短语(防 prompt 文案被意外替换)
 *
 *   D. createTaskTool(env) 工具元信息(name / 各 fail-closed 标记 / interruptBehavior)
 *
 *   E. ALS 缺失保护:Task call 在 runContextStorage 上下文外调用应抛明确 error
 *
 *   F. 集成 happy path:在 runContextStorage.run 包裹下,Task call 走完
 *      runChildAgent → ToolResult,验证 content 含子 final text + <usage>
 */

import { describe, expect, it } from "vitest";
import {
  ConfirmationBroker,
  createEventBus,
  emptyUsage,
  MockLLMProvider,
  PermissionStore,
  SecurityPipeline,
  type AbortReason,
  type AgentEventMap,
  type LLMRole,
  type LLMRoles,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@zhixing/core";
import {
  createTaskTool,
  formatChildResultAsToolResult,
  TASK_INPUT_SCHEMA,
  TASK_TOOL_PROMPT,
  type TaskToolEnv,
} from "../task.js";
import { runContextStorage } from "../../runtime/run-context.js";
import type { ChildAgentResult } from "../../subagent/factory.js";

// ─── 测试辅助 ───

function makeRoles(provider: MockLLMProvider): LLMRoles {
  const role: LLMRole = {
    provider,
    model: "mock-model",
    chat: (req) => provider.chat(req),
  };
  return { main: role, light: role, power: role };
}

function makeReadOnlyTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" } as never,
    needsPermission: false,
    call: async () => ({ content: `${name}-ok`, isError: false }),
  };
}

function makeEnv(provider: MockLLMProvider): TaskToolEnv {
  return {
    provider,
    model: "mock-model",
    llmRoles: makeRoles(provider),
    securityPipeline: new SecurityPipeline({
      trustContext: { kind: "workspace", dir: process.cwd() },
      sessionType: "ci",
      permissionStore: new PermissionStore({ rootDir: null }),
    }),
    workspace: process.cwd(),
    workspaceSource: "cwd-fallback",
    parentBroker: new ConfirmationBroker({ id: "parent-broker-test" }),
    parentTools: [makeReadOnlyTool("read")],
    // 默认大阈值,避免现有测试场景误触发 context_overflow;
    // 专项测试需要触发时单独构造 env 注入更小值
    riskMaxTokens: 10_000_000,
  };
}

/** 构造 ToolExecutionContext —— Task call 接口契约要求,实际只读 abortSignal */
function makeToolCtx(): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    workingDirectory: process.cwd(),
  } as ToolExecutionContext;
}

/** 构造完整 ChildAgentResult 的工厂 —— 三态格式化测试用 */
function makeResult(overrides: Partial<ChildAgentResult>): ChildAgentResult {
  return {
    status: "completed",
    subAgentId: "abc123-def456-7890-1234-567890abcdef",
    finalAssistantText: "",
    usage: { inputTokens: 100, outputTokens: 50 },
    toolUses: 0,
    durationMs: 250,
    ...overrides,
  } as ChildAgentResult;
}

// ─── A. 三态格式化:completed ───

describe("formatChildResultAsToolResult · completed", () => {
  it("拼接 finalText + <usage> trailer,无 isError(默认 false)", () => {
    const r = makeResult({
      status: "completed",
      finalAssistantText: "the analysis result",
      toolUses: 3,
    });

    const tr = formatChildResultAsToolResult(r, "analyze code");

    expect(tr.isError).toBe(false);
    expect(tr.content).toContain("the analysis result");
    // <usage> trailer 紧跟在文本后(空行分隔)
    expect(tr.content).toMatch(/the analysis result\n\n<usage>/);
  });

  it("usage 字段顺序:tokens → tool_uses → duration_ms → sub_id", () => {
    const r = makeResult({
      status: "completed",
      finalAssistantText: "x",
      toolUses: 7,
      durationMs: 4321,
    });

    const tr = formatChildResultAsToolResult(r, "t");

    // tokens = inputTokens + outputTokens = 100 + 50 = 150
    expect(tr.content).toMatch(
      /<usage>tokens: 150, tool_uses: 7, duration_ms: 4321, sub_id: abc123<\/usage>/,
    );
  });

  it("sub_id 截断到前 6 字符", () => {
    const r = makeResult({
      status: "completed",
      finalAssistantText: "ok",
      subAgentId: "xyzabcdef-rest-of-uuid",
    });

    const tr = formatChildResultAsToolResult(r, "t");

    expect(tr.content).toMatch(/sub_id: xyzabc<\/usage>/);
  });
});

// ─── A. 三态格式化:failed ───

describe("formatChildResultAsToolResult · failed", () => {
  it("头部 [Task \"X\" failed (<type>): msg] + isError=true", () => {
    const r = makeResult({
      status: "failed",
      finalAssistantText: "",
      error: { message: "provider timeout", type: "provider_error" },
    });

    const tr = formatChildResultAsToolResult(r, "fetch data");

    expect(tr.isError).toBe(true);
    // type tag 让主 LLM 拿到结构化 error 分类(provider_error / context_overflow /
    // rate_limit / ...),据此自主决策。比纯文本前缀更易解析。
    expect(
      tr.content.startsWith(
        '[Task "fetch data" failed (provider_error): provider timeout]',
      ),
    ).toBe(true);
  });

  it("有 partial 时拼接 Partial output 段", () => {
    const r = makeResult({
      status: "failed",
      error: { message: "x", type: "unknown_error" },
      partial: "step 1 done\nstep 2 in progress",
    });

    const tr = formatChildResultAsToolResult(r, "t");

    expect(tr.content).toContain("Partial output:\nstep 1 done\nstep 2 in progress");
  });

  it("无 partial 时不渲染 Partial output 段", () => {
    const r = makeResult({
      status: "failed",
      error: { message: "x", type: "y" },
    });

    const tr = formatChildResultAsToolResult(r, "t");

    expect(tr.content).not.toContain("Partial output:");
  });

  it("error 缺失时降级 'unknown error'", () => {
    const r = makeResult({
      status: "failed",
    });

    const tr = formatChildResultAsToolResult(r, "t");

    expect(tr.content).toContain('[Task "t" failed: unknown error]');
  });

  it("failed 时 <usage> 不含 tool_uses 字段(只 completed 才暴露)", () => {
    const r = makeResult({
      status: "failed",
      error: { message: "x", type: "y" },
      toolUses: 99,
    });

    const tr = formatChildResultAsToolResult(r, "t");

    expect(tr.content).not.toContain("tool_uses");
  });
});

// ─── A. 三态格式化:aborted ───

describe("formatChildResultAsToolResult · aborted", () => {
  it("头部 [Task \"X\" aborted: <reason>] + isError=true,reason 走 formatAbortReasonForLLM", () => {
    const reason: AbortReason = { kind: "user-cancel" };
    const r = makeResult({
      status: "aborted",
      abortReason: reason,
    });

    const tr = formatChildResultAsToolResult(r, "long research");

    expect(tr.isError).toBe(true);
    expect(tr.content.startsWith('[Task "long research" aborted: user cancelled the parent task]')).toBe(
      true,
    );
  });

  it("idle-timeout / parent-abort / external 各 kind 走对应英文短语", () => {
    const cases: Array<[AbortReason, string]> = [
      [{ kind: "idle-timeout" }, "sub-agent LLM stream idle for too long"],
      [{ kind: "parent-abort", parentReason: { kind: "user-cancel" } }, "parent agent was aborted"],
      [{ kind: "external", origin: "test-suite" }, "external abort: test-suite"],
      [{ kind: "external" }, "external abort"],
    ];
    for (const [reason, expectText] of cases) {
      const r = makeResult({ status: "aborted", abortReason: reason });
      const tr = formatChildResultAsToolResult(r, "t");
      expect(tr.content).toContain(expectText);
    }
  });

  it("有 partial 时拼接 Partial output 段(对齐 failed)", () => {
    const r = makeResult({
      status: "aborted",
      abortReason: { kind: "user-cancel" },
      partial: "halfway through",
    });

    const tr = formatChildResultAsToolResult(r, "t");

    expect(tr.content).toContain("Partial output:\nhalfway through");
  });

  it("abortReason 缺失时降级 'unknown abort reason'(防御 fallback)", () => {
    const r = makeResult({
      status: "aborted",
    });

    const tr = formatChildResultAsToolResult(r, "t");

    expect(tr.content).toContain('[Task "t" aborted: unknown abort reason]');
  });
});

// ─── B. TASK_INPUT_SCHEMA 严格契约 ───

describe("TASK_INPUT_SCHEMA", () => {
  it("required 含 description 与 prompt(LLM 必须提供)", () => {
    expect(TASK_INPUT_SCHEMA.required).toContain("description");
    expect(TASK_INPUT_SCHEMA.required).toContain("prompt");
  });

  it("additionalProperties 严格 false(防 LLM 注入额外字段)", () => {
    expect(TASK_INPUT_SCHEMA.additionalProperties).toBe(false);
  });

  it("description / prompt 类型为 string", () => {
    const props = TASK_INPUT_SCHEMA.properties as Record<string, { type: string }>;
    expect(props["description"]?.type).toBe("string");
    expect(props["prompt"]?.type).toBe("string");
  });
});

// ─── C. TASK_TOOL_PROMPT 关键短语 ───

describe("TASK_TOOL_PROMPT", () => {
  it("含 When to use / When NOT to use 决策双轴", () => {
    expect(TASK_TOOL_PROMPT).toContain("When to use:");
    expect(TASK_TOOL_PROMPT).toContain("When NOT to use:");
  });

  it("声明并发上限与递归禁令", () => {
    expect(TASK_TOOL_PROMPT).toMatch(/Concurrency:.*up to 3/i);
    expect(TASK_TOOL_PROMPT).toMatch(/Recursion:.*cannot dispatch further sub-agents/i);
  });

  it("失败处理强制约定:LLM 必须在 final response 中暴露失败", () => {
    expect(TASK_TOOL_PROMPT).toContain("MUST acknowledge the failure");
  });
});

// ─── D. createTaskTool(env) 工具元信息 ───

describe("createTaskTool · 工具元信息(fail-closed 契约)", () => {
  it("name === 'Task',description === TASK_TOOL_PROMPT,schema 引用一致", () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));
    expect(tool.name).toBe("Task");
    expect(tool.description).toBe(TASK_TOOL_PROMPT);
    expect(tool.inputSchema).toBe(TASK_INPUT_SCHEMA);
  });

  it("isParallelSafe === true(LLM I/O bound,主可并发派多个 Task)", () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));
    expect(tool.isParallelSafe).toBe(true);
  });

  it("needsPermission === false(子内部决策,不弹用户)", () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));
    expect(tool.needsPermission).toBe(false);
  });

  it("interruptBehavior === 'cancel'(父 abort 立即级联)", () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));
    expect(tool.interruptBehavior).toBe("cancel");
  });
});

// ─── E. 契约前置校验(fail-fast) ───
//
// 设计取舍:Task call 入口任一契约不满足直接 throw,而非用 fallback "降级"
// 处理(如旧版本"description 缺失时填 '(unnamed task)'")—— 残缺输入派一个
// 无任务子 agent 浪费 token,且让主 LLM 看到误导性"成功"tool_result。
// fail-fast 让主 LLM 通过 tool_result.isError 触发自我修正(改输入重派/放弃)。

describe("createTaskTool.call · 契约前置校验", () => {
  it("ALS 上下文缺失 → throw 含 'outside an agent run context'(指明根因)", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));

    await expect(
      tool.call({ description: "t", prompt: "do" }, makeToolCtx()),
    ).rejects.toThrow(/outside an agent run context/);
  });

  it("ctx.abortSignal 缺失 → throw 含 'requires ctx.abortSignal'(指明 tool-executor 契约)", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));
    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });

    // 显式构造缺 abortSignal 的 ctx —— 模拟 tool-executor 路径外的直接调用 /
    // 未来某 path 漏传 abortSignal 时,fail-fast 比 ! 非空断言更早暴露契约违反
    const ctxWithoutSignal = {
      workingDirectory: process.cwd(),
    } as ToolExecutionContext;

    await expect(
      runContextStorage.run({ bus: parentBus, lineage: "main" }, async () =>
        tool.call({ description: "t", prompt: "do" }, ctxWithoutSignal),
      ),
    ).rejects.toThrow(/requires ctx\.abortSignal/);
  });

  it("description 缺失 / 空字符串 / 纯空白 → throw 含 'requires non-empty .description.'", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));
    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });

    // 三态等价:undefined / "" / "   " 都应被 trim() 检测为空 → throw
    for (const badDesc of [undefined, "", "   "] as const) {
      await expect(
        runContextStorage.run({ bus: parentBus, lineage: "main" }, async () =>
          tool.call(
            { description: badDesc as never, prompt: "valid prompt" },
            makeToolCtx(),
          ),
        ),
      ).rejects.toThrow(/requires non-empty 'description'/);
    }
  });

  it("prompt 缺失 / 空字符串 / 纯空白 → throw 含 'requires non-empty .prompt.'", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));
    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });

    for (const badPrompt of [undefined, "", "\n  \t  "] as const) {
      await expect(
        runContextStorage.run({ bus: parentBus, lineage: "main" }, async () =>
          tool.call(
            { description: "valid desc", prompt: badPrompt as never },
            makeToolCtx(),
          ),
        ),
      ).rejects.toThrow(/requires non-empty 'prompt'/);
    }
  });

  it("description / prompt 含周围空白时 trim() 后接受(非纯空白即合法)", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const tool = createTaskTool(makeEnv(provider));
    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });

    // "  hello  " trim 后 "hello" 非空,应接受;ToolResult 主体不含周围空白
    const tr = await runContextStorage.run(
      { bus: parentBus, lineage: "main" },
      async () =>
        tool.call(
          { description: "  short desc  ", prompt: "  some task  " },
          makeToolCtx(),
        ),
    );
    expect(tr.isError).toBe(false);
  });
});

// ─── F. 集成 happy path ───

describe("createTaskTool.call · 集成 happy path", () => {
  it("ALS 包裹下:Task call → runChildAgent → ToolResult(含 final text + <usage>)", async () => {
    const provider = new MockLLMProvider([{ text: "sub agent final answer" }]);
    const tool = createTaskTool(makeEnv(provider));
    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });

    const tr = await runContextStorage.run(
      { bus: parentBus, lineage: "main" },
      async () => tool.call({ description: "test task", prompt: "research X" }, makeToolCtx()),
    );

    expect(tr.isError).toBe(false);
    expect(tr.content).toContain("sub agent final answer");
    expect(tr.content).toMatch(/<usage>tokens: \d+, tool_uses: 0, duration_ms: \d+, sub_id: [0-9a-f]{6}<\/usage>/);
  });

  it("provider error → ToolResult 含 [Task X failed (<type>): ...] + isError=true(永不抛) + 透传真实 type/message", async () => {
    const provider = new MockLLMProvider([
      { error: new Error("upstream rejected") },
    ]);
    const tool = createTaskTool(makeEnv(provider));
    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });

    const tr = await runContextStorage.run(
      { bus: parentBus, lineage: "main" },
      async () => tool.call({ description: "fetch", prompt: "x" }, makeToolCtx()),
    );

    expect(tr.isError).toBe(true);
    // 真实 AgentError type 透传(provider_error)+ message 文本透传 → 主 LLM 拿到
    // 结构化诊断信号。历史输出"[Task fetch failed: sub-agent loop terminated
    // with error]"是占位丢信息;修复后是"[Task fetch failed (provider_error):
    // upstream rejected]"含完整诊断。
    expect(tr.content).toContain('[Task "fetch" failed (provider_error):');
    expect(tr.content).toContain("upstream rejected");
  });

  it("emptyUsage helper 验证 —— 兜底用例,确保 inputTokens+outputTokens=0 时 tokens 字段为 0", () => {
    const r = makeResult({
      status: "completed",
      finalAssistantText: "x",
      usage: emptyUsage(),
    });
    const tr = formatChildResultAsToolResult(r, "t");
    expect(tr.content).toMatch(/<usage>tokens: 0, /);
  });

  // 设计契约保护:cache tokens(Anthropic prompt caching 维度)有意不出现
  // 在 <usage> trailer。回归保护:若未来误把 cacheRead/Write 拼进字段,这两个
  // 断言能立即捕获,提示开发者去独立的 token 可观察性模块呈现。
  it("cache tokens 不出现在 <usage> trailer(单一真相源:cache 维度走 EventBus llm:end)", () => {
    const r = makeResult({
      status: "completed",
      finalAssistantText: "answer",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 9999,
        cacheWriteTokens: 1234,
      },
    });
    const tr = formatChildResultAsToolResult(r, "t");

    // tokens 字段的数值是 input + output 之和,不含任何 cache 部分
    expect(tr.content).toMatch(/<usage>tokens: 150, /);
    // <usage> 字面层不含任何 cache 关键词,LLM 不会被分项细节污染决策上下文
    expect(tr.content).not.toMatch(/cache/i);
    expect(tr.content).not.toContain("9999");
    expect(tr.content).not.toContain("1234");
  });
});
