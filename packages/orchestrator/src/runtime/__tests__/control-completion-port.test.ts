import { describe, expect, it } from "vitest";
import type { ChatRequest, LLMRole, StreamEvent } from "@zhixing/core";
import type {
  AuthorityCallContext,
  ImmediateRootResourceLease,
  ResourceLease,
} from "@zhixing/core/contracts";
import { userMessage } from "@zhixing/core";
import { createControlCompletionPort } from "../control-completion-port.js";

const NOW = "2026-08-02T00:00:00.000Z";
const DEADLINE = "2026-08-02T01:00:00.000Z";

function testLease(): ImmediateRootResourceLease {
  return {
    v: 1,
    reservationId: "rsv-control-1",
    admissionClass: "advancement",
    workload: { kind: "control", id: "work-1", attempt: 1 },
    scopeBinding: { kind: "control", subject: "work-1" },
    audience: {},
    budget: { maxCalls: 4 },
    domain: { kind: "anchor", anchorEpoch: 1 },
    issuedAt: NOW,
    expiry: DEADLINE,
    digest: `sha256:${"0".repeat(64)}`,
    signature: { alg: "test", keyId: "test", sig: `sha256:${"0".repeat(64)}` },
  };
}

interface MeterCall {
  readonly method: "reserveUsage" | "consume";
  readonly lease: ResourceLease;
  readonly usage: { usageId: string; tokens?: number; calls?: number };
  readonly ctx: AuthorityCallContext;
}

function fakeMeter() {
  const calls: MeterCall[] = [];
  return {
    meter: {
      reserveUsage: async (lease: ResourceLease, usage: MeterCall["usage"], ctx: AuthorityCallContext) => {
        calls.push({ method: "reserveUsage", lease, usage, ctx });
      },
      consume: async (lease: ResourceLease, usage: MeterCall["usage"], ctx: AuthorityCallContext) => {
        calls.push({ method: "consume", lease, usage, ctx });
      },
    },
    calls,
  };
}

function roleWith(events: StreamEvent[], capture?: { request?: ChatRequest }): LLMRole {
  return {
    model: "mock-model",
    provider: {
      id: "mock",
      models: [],
      async *chat(request: ChatRequest) {
        if (capture) capture.request = request;
        for (const event of events) {
          if (event.type === "error") throw event.error;
          yield event;
        }
      },
    } as unknown as LLMRole["provider"],
    chat(request: ChatRequest) {
      return (this.provider as { chat: (r: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined> }).chat(request);
    },
  };
}

function textEvents(text: string, inputTokens = 10, outputTokens = 3): StreamEvent[] {
  return [
    { type: "text_delta", text },
    {
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens, outputTokens },
    } as StreamEvent,
  ];
}

describe("ControlCompletionPort", () => {
  it("按角色档位路由并返回文本与用量", async () => {
    const { meter } = fakeMeter();
    const mainCapture: { request?: ChatRequest } = {};
    const port = createControlCompletionPort({
      meter,
      roles: {
        main: roleWith(textEvents("main 输出"), mainCapture),
        light: roleWith(textEvents("light 输出")),
      },
      defaultMaxOutputTokens: 1024,
    });

    const abort = new AbortController().signal;
    const main = await port.complete({
      role: "main",
      messages: [userMessage("你好")],
      lease: testLease(),
      abort,
      deadlineAt: DEADLINE,
    });
    expect(main).toMatchObject({
      ok: true,
      text: "main 输出",
      usage: { inputTokens: 10, outputTokens: 3 },
    });
    expect(mainCapture.request?.abortSignal).toBe(abort);

    const light = await port.complete({
      role: "light",
      messages: [userMessage("你好")],
      lease: testLease(),
      abort,
      deadlineAt: DEADLINE,
    });
    expect(light).toMatchObject({ ok: true, text: "light 输出" });
  });

  it("真实调用沿稳定 usageId 对调用方租约预占与消费", async () => {
    const { meter, calls } = fakeMeter();
    const port = createControlCompletionPort({
      meter,
      roles: { main: roleWith(textEvents("一", 120, 30)), light: roleWith([]) },
      defaultMaxOutputTokens: 1024,
    });
    const lease = testLease();
    await port.complete({
      role: "main",
      messages: [userMessage("计费")],
      lease,
      abort: new AbortController().signal,
      deadlineAt: DEADLINE,
    });

    expect(calls).toHaveLength(2);
    const [reserve, consume] = calls;
    expect(reserve!.method).toBe("reserveUsage");
    expect(reserve!.lease).toBe(lease);
    expect(reserve!.usage.usageId).toBe(`usage:${lease.reservationId}:control:1`);
    expect(reserve!.usage.calls).toBe(1);
    expect(reserve!.usage.tokens).toBeGreaterThan(1024);
    expect(reserve!.ctx.deadlineAt).toBe(DEADLINE);
    expect(consume!.method).toBe("consume");
    expect(consume!.usage.usageId).toBe(reserve!.usage.usageId);
    expect(consume!.usage.tokens).toBe(150);
  });

  it("schemaToolName 经工具流聚合并提取结构化调用", async () => {
    const { meter } = fakeMeter();
    const events: StreamEvent[] = [
      { type: "tool_call_start", id: "tc-1", name: "submit_review" } as StreamEvent,
      { type: "tool_call_delta", id: "tc-1", argsFragment: '{"decision":"pass' } as StreamEvent,
      { type: "tool_call_delta", id: "tc-1", argsFragment: 'ed"}' } as StreamEvent,
      { type: "tool_call_end", id: "tc-1" } as StreamEvent,
      {
        type: "message_end",
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 2 },
      } as StreamEvent,
    ];
    const capture: { request?: ChatRequest } = {};
    const port = createControlCompletionPort({
      meter,
      roles: { main: roleWith(events, capture), light: roleWith([]) },
      defaultMaxOutputTokens: 1024,
    });
    const result = await port.complete({
      role: "main",
      messages: [userMessage("评审")],
      schemaToolName: "submit_review",
      lease: testLease(),
      abort: new AbortController().signal,
      deadlineAt: DEADLINE,
    });
    expect(result).toMatchObject({
      ok: true,
      toolCall: { name: "submit_review", input: { decision: "passed" } },
    });
    expect(capture.request?.tools?.[0]?.name).toBe("submit_review");
  });

  it("基础设施失败映射为可重试错误，结论性失败不重试", async () => {
    const { meter } = fakeMeter();
    const transient = createControlCompletionPort({
      meter,
      roles: {
        main: roleWith([{ type: "error", error: new Error("429 rate limit") } as StreamEvent]),
        light: roleWith([]),
      },
      defaultMaxOutputTokens: 1024,
    });
    const failed = await transient.complete({
      role: "main",
      messages: [userMessage("x")],
      lease: testLease(),
      abort: new AbortController().signal,
      deadlineAt: DEADLINE,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.retryable).toBe(true);
    }

    const fatal = createControlCompletionPort({
      meter,
      roles: {
        main: roleWith([{ type: "error", error: new Error("invalid api key") } as StreamEvent]),
        light: roleWith([]),
      },
      defaultMaxOutputTokens: 1024,
    });
    const rejected = await fatal.complete({
      role: "main",
      messages: [userMessage("x")],
      lease: testLease(),
      abort: new AbortController().signal,
      deadlineAt: DEADLINE,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.retryable).toBe(false);
    }
  });
});
