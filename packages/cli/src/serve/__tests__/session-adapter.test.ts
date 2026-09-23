/**
 * SessionRuntime 适配器测试 — 用 mock AgentRuntime 验证 callback → AsyncGenerator 桥接。
 *
 * adapter 是纯执行体:输入消息由调用方构造(窗口归 ConversationManager,接受协议
 * 与历史投影的测试在 @zhixing/server 侧),此处只锁协议桥接契约——yield 流转、
 * RunResult / 错误透传、参数透传(messages / conversationId / turnIndex / source)、
 * abort 行为、broker 与 dispose 透传。
 *
 * Mock 设计:cooperative 响应 abortSignal —— 真实 AgentLoop 在 abort 触发后通过
 * cleanup 路径返回 `AgentResult.aborted` with abortReason(.then 而非 throw),
 * 此 mock 同模式,避免测试和实现脱节。
 */

import { describe, it, expect, vi } from "vitest";
import { AgentError, type AgentEventMap, type Message } from "@zhixing/core";
import { ConfirmationBroker } from "@zhixing/core/confirmation";
import { getAbortReason, type AbortReason } from "@zhixing/core/interrupt";
import { type AgentResult, type AgentYield } from "@zhixing/core/loop";
import {
  createAssignmentRuntimeAdapter,
  createOwnerRuntimeAdapter,
} from "@zhixing/runtime-host/session-adapter";
import type { RunResult } from "@zhixing/core/loop";
import type {
  AgentRuntime,
  KernelRunEnvelope,
  KernelRunEvent,
  KernelRunCompletion,
} from "@zhixing/orchestrator/runtime";

const KERNEL_EVENT_EXACT_SET: readonly KernelRunEvent[] = [
  { type: "text_delta", text: "hello" },
  { type: "thinking_block_start" },
  { type: "thinking_delta", thinking: "reason" },
  { type: "thinking_block_end" },
  {
    type: "assistant_message",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  },
  { type: "tool_start", id: "t1", name: "read", input: { path: "a" } },
  {
    type: "tool_end",
    id: "t1",
    name: "read",
    result: { content: "ok" },
    duration: 1,
  },
  {
    type: "turn_complete",
    turnCount: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
  },
];

/** 本轮用户消息构造——run 输入由调用方组装(此处模拟 runTurnWithCommit 的构造) */
function um(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

interface MockBehavior {
  yields?: AgentYield[];
  malformedEvent?: unknown;
  throwError?: string;
  reason?: AgentResult["reason"];
  /** 模拟 LLM 流的延迟,让测试有空间在中途触发 abort */
  yieldDelayMs?: number;
  /** 捕获 run 收到的参数,供透传契约断言 */
  capture?: (envelope: KernelRunEnvelope) => void;
  /** 捕获编排入口参数,证明 SessionRuntime 只做必需能力的单向转交。 */
  captureOrchestration?: (
    params: Parameters<AgentRuntime["runOrchestrationV1"]>[0],
  ) => void;
}

function createMockAgentRuntime(behavior: MockBehavior = {}): AgentRuntime {
  const stub = {} as AgentRuntime;
  const broker = new ConfirmationBroker();
  return Object.assign(stub, {
    providerId: "mock",
    model: "mock-model",
    confirmationBroker: broker,
    drainLifecycleDiagnostics: () => [],
    estimateConversationRequestBudget: () => ({
      contextWindow: 200_000,
      effectiveWindow: 180_000,
      currentTokens: 1_000,
      usageRatio: 0.01,
      status: "normal",
    }),
    estimateMessagesTokens: () => 1_000,
    subAgentUsages: () => [],
    callText: async () => "text",
    callTextWithUsage: async () => ({
      text: "text",
      usage: { inputTokens: 2, outputTokens: 1 },
    }),
    securitySnapshot: () => ({
      contextId: { kind: "main" },
      workspacePath: null,
      permissionRules: [],
      builtinRules: [],
      rateLimits: [],
      confirmations: [],
    }),
    calibrationFactor: 1,
    async run(envelope: KernelRunEnvelope): Promise<KernelRunCompletion> {
      behavior.capture?.(envelope);
      if (behavior.throwError) {
        throw new Error(behavior.throwError);
      }
      if (behavior.malformedEvent !== undefined) {
        const onEvent = envelope.observation.onEvent;
        if (!onEvent) throw new Error("Kernel event observer is missing");
        Reflect.apply(onEvent, undefined, [behavior.malformedEvent]);
      }

      // pre-flight:已 aborted 的 signal 直接走 aborted 路径,模拟 agent-loop 行为
      if (envelope.control.abortSignal?.aborted) {
        const abortReason =
          getAbortReason(envelope.control.abortSignal) ?? undefined;
        return buildAbortedResult(envelope, abortReason);
      }

      const yields = behavior.yields ?? [
        { type: "text_delta", text: "hello" } as AgentYield,
      ];
      for (const y of yields) {
        if (envelope.control.abortSignal?.aborted) {
          const abortReason =
            getAbortReason(envelope.control.abortSignal) ?? undefined;
          return buildAbortedResult(envelope, abortReason);
        }
        await envelope.observation.onEvent?.(y);
        if (behavior.yieldDelayMs && behavior.yieldDelayMs > 0) {
          await sleepWithAbort(
            behavior.yieldDelayMs,
            envelope.control.abortSignal,
          );
          if (envelope.control.abortSignal?.aborted) {
            const abortReason =
              getAbortReason(envelope.control.abortSignal) ?? undefined;
            return buildAbortedResult(envelope, abortReason);
          }
        }
      }

      const reason = behavior.reason ?? "completed";
      return buildResultByReason(envelope, reason);
    },
    async runOrchestrationV1(
      params: Parameters<AgentRuntime["runOrchestrationV1"]>[0],
    ) {
      behavior.captureOrchestration?.(params);
      return { status: "completed" } as never;
    },
    async dispose() {},
  });
}

function buildAbortedResult(
  envelope: KernelRunEnvelope,
  abortReason: AbortReason | undefined,
): KernelRunCompletion {
  return {
    terminal: {
      reason: "aborted",
      abortReason,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    artifacts: {
      runRecord: {
        timestamp: new Date().toISOString(),
        messages: [
          envelope.modelInput.messages[envelope.modelInput.messages.length - 1] ??
            ({ role: "user", content: [] } as Message),
          { role: "assistant", content: [] } as Message,
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      newMessages: [],
      durationMs: 1,
    },
  };
}

function buildResultByReason(
  envelope: KernelRunEnvelope,
  reason: AgentResult["reason"],
): KernelRunCompletion {
  const assistantMsg: Message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
  };
  const terminal: KernelRunCompletion["terminal"] =
    reason === "completed"
      ? {
          reason: "completed",
          message: assistantMsg,
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      : reason === "max_turns"
        ? { reason: "max_turns", maxTurns: 100, usage: { inputTokens: 1, outputTokens: 1 } }
        : reason === "aborted"
          ? { reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } }
          : {
              reason: "error",
              error: {
                name: "AgentError",
                message: "agent error",
                type: "unknown",
                recoverable: false,
              },
              usage: { inputTokens: 0, outputTokens: 0 },
            };

  const newMessages: Message[] =
    reason === "completed" ? [assistantMsg] : [];

  return {
    terminal,
    artifacts: {
      runRecord: {
        timestamp: new Date().toISOString(),
        messages: [
          envelope.modelInput.messages[envelope.modelInput.messages.length - 1] ??
            ({ role: "user", content: [] } as Message),
          reason === "completed"
            ? assistantMsg
            : ({ role: "assistant", content: [] } as Message),
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      newMessages,
      durationMs: 10,
    },
  };
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

describe("createOwnerRuntimeAdapter", () => {
  it("passes the owner input port unchanged into the Kernel correctness boundary", async () => {
    const inputPort = { receive: async () => [], close: async () => {} };
    let captured: KernelRunEnvelope | undefined;
    const runtime = createOwnerRuntimeAdapter("input-port", createMockAgentRuntime({ capture: envelope => { captured = envelope; } }));
    const run = runtime.run([um("hello")], { inputPort });
    while (!(await run.next()).done) { /* drain */ }
    expect(captured?.correctness.inputPort).toBe(inputPort);
  });
  it("forwards orchestration through the required AgentRuntime capability", async () => {
    let captured:
      | Parameters<AgentRuntime["runOrchestrationV1"]>[0]
      | undefined;
    const runtime = createOwnerRuntimeAdapter(
      "orchestration-required",
      createMockAgentRuntime({
        captureOrchestration: (params) => {
          captured = params;
        },
      }),
    );
    const params = {
      executable: {},
      eventBus: {},
    } as unknown as Parameters<AgentRuntime["runOrchestrationV1"]>[0];

    await runtime.runOrchestrationV1?.(params);

    expect(captured).toBe(params);
  });

  it("yields events from onYield callback then returns final result", async () => {
    const runtime = createOwnerRuntimeAdapter(
      "test-1",
      createMockAgentRuntime({
        yields: [
          { type: "text_delta", text: "hi" } as AgentYield,
          { type: "text_delta", text: " there" } as AgentYield,
        ],
      }),
    );

    const yields: AgentYield[] = [];
    const gen = runtime.run([um("hello")]);
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        expect(value.agentResult.reason).toBe("completed");
        break;
      }
      yields.push(value);
    }
    expect(yields).toHaveLength(2);
    expect((yields[0] as { text: string }).text).toBe("hi");
  });

  it("explicitly projects the complete Kernel event set into Conversation yields", async () => {
    const runtime = createOwnerRuntimeAdapter(
      "event-exact-set",
      createMockAgentRuntime({ yields: [...KERNEL_EVENT_EXACT_SET] }),
    );
    const received: AgentYield[] = [];
    const run = runtime.run([um("hello")]);
    while (true) {
      const next = await run.next();
      if (next.done) break;
      received.push(next.value);
    }

    expect(received).toEqual(KERNEL_EVENT_EXACT_SET);
    for (const [index, event] of received.entries()) {
      expect(event).not.toBe(KERNEL_EVENT_EXACT_SET[index]);
    }
  });

  it("fails closed when a runtime supplies an incomplete Kernel event", async () => {
    const runtime = createOwnerRuntimeAdapter(
      "invalid-event",
      createMockAgentRuntime({ malformedEvent: { type: "text_delta" } }),
    );
    await expect(runtime.run([um("hello")]).next()).rejects.toThrow(
      "Incomplete AgentYield variant",
    );
  });

  it.each(["completed", "max_turns", "aborted", "error"] as const)(
    "explicitly projects the %s Kernel terminal into the Conversation RunResult",
    async (reason) => {
      const runtime = createOwnerRuntimeAdapter(
        `terminal-${reason}`,
        createMockAgentRuntime({ reason }),
      );
      const run = runtime.run([um("hello")]);
      let result: RunResult | undefined;
      while (true) {
        const next = await run.next();
        if (next.done) {
          result = next.value;
          break;
        }
      }

      expect(result!.agentResult.reason).toBe(reason);
      expect(result!.runRecord.messages[0]).toEqual(um("hello"));
      if (result!.agentResult.reason === "error") {
        expect(result!.agentResult.error).toBeInstanceOf(AgentError);
        expect(result!.agentResult.error).toMatchObject({
          name: "AgentError",
          message: "agent error",
          type: "unknown",
          recoverable: false,
        });
      }
    },
  );

  it("projects evidence, window change, control proposal and diagnostics without recomputing them", async () => {
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "done" }],
    };
    const terminalMessage = structuredClone(assistant);
    const terminalUsage = { inputTokens: 2, outputTokens: 3 };
    const runRecord = {
      timestamp: "2026-08-29T00:00:00.000Z",
      messages: [um("hello"), assistant],
    };
    const newMessages = [assistant];
    const windowCompact = {
      summary: "summary",
      pairsCompacted: 1,
      tokensBefore: 10,
      tokensAfter: 4,
    };
    const pendingPostTurnControl = { intent: { kind: "exit" as const } };
    const agent = Object.assign({} as AgentRuntime, {
      run: async (): Promise<KernelRunCompletion> => ({
        terminal: {
          reason: "completed",
          message: terminalMessage,
          usage: terminalUsage,
        },
        artifacts: {
          runRecord,
          newMessages,
          durationMs: 17,
          windowCompact,
          pendingPostTurnControl,
        },
      }),
    });
    const worksceneContinuation = { kind: "result" as const, conversationId: "ws:reports:primary", runId: "child-1" };
    const run = createOwnerRuntimeAdapter("artifacts", agent).run([um("hello")], { turnContext: { turnOrigin: { channel: "rpc", worksceneContinuation } } });
    const next = await run.next();

    expect(next).toMatchObject({
      done: true,
      value: {
        runRecord: { timestamp: "2026-08-29T00:00:00.000Z" },
        newMessages: [assistant],
        durationMs: 17,
        windowCompact: { summary: "summary", pairsCompacted: 1 },
        pendingPostTurnControl: { intent: { kind: "exit" } },
      },
    });
    if (!next.done) throw new Error("expected completed run");
    expect(next.value.agentResult.reason).toBe("completed");
    if (next.value.agentResult.reason !== "completed") {
      throw new Error("expected completed result");
    }
    expect(next.value.agentResult.message).toBe(terminalMessage);
    expect(next.value.agentResult.usage).toBe(terminalUsage);
    expect(next.value.runRecord).toEqual({ ...runRecord, postTurnControl: pendingPostTurnControl, worksceneContinuation });
    expect(next.value.newMessages).not.toBe(newMessages);
    expect(next.value.newMessages[0]).toBe(assistant);
    expect(next.value.windowCompact).toBe(windowCompact);
    expect(next.value.pendingPostTurnControl).toBe(pendingPostTurnControl);
  });

  it("纯执行体透传契约:messages 原样、conversationId=sessionId、turnIndex/source 透传", async () => {
    let captured: KernelRunEnvelope | undefined;
    const runtime = createOwnerRuntimeAdapter(
      "conv-42",
      createMockAgentRuntime({ capture: (p) => (captured = p) }),
    );

    const input = [um("ctx"), um("hello")];
    const gen = runtime.run(input, { turnIndex: 7, source: "channel" });
    while (!(await gen.next()).done) {/* drain */}

    expect(captured!.modelInput.messages).toEqual(input);
    expect(captured!.identity.conversationId).toBe("conv-42");
    expect(captured!.identity.turnIndex).toBe(7);
    expect(captured!.identity.source).toBe("channel");
  });

  it("conversation 只构造唯一五分区 Envelope 并原样投影 observer/Correctness 端口", async () => {
    let captured: KernelRunEnvelope | undefined;
    const runtime = createOwnerRuntimeAdapter(
      "conv-envelope",
      createMockAgentRuntime({ capture: (envelope) => (captured = envelope) }),
    );
    const onProtocolEvent = async () => undefined;
    const toolSideEffectObserver = {} as never;
    const authorizeToolExecution = async () => [];
    const modelCallResourceMeter = {} as never;
    const assignmentMutations = {} as never;
    const globalQuery = {} as never;
    const resourceReservation = {
      port: {} as never,
      parentLease: {} as never,
      contextFor: () => ({}) as never,
    };

    const gen = runtime.run([um("hello")], {
      turnIndex: 11,
      source: "interactive",
      turnContext: { turnId: "turn-envelope" },
      onProtocolEvent,
      toolSideEffectObserver,
      authorizeToolExecution,
      modelCallResourceMeter,
      assignmentMutations,
      globalQuery,
      assignmentIssuedAt: "2026-08-29T00:00:00.000Z",
      resourceReservation,
    });
    while (!(await gen.next()).done) {/* drain */}

    expect(Object.keys(captured!).sort()).toEqual([
      "control",
      "correctness",
      "identity",
      "modelInput",
      "observation",
    ]);
    expect(captured!.identity).toMatchObject({
      conversationId: "conv-envelope",
      turnIndex: 11,
      source: "interactive",
      turnContext: { turnId: "turn-envelope" },
    });
    expect(captured!.control.modelCallResourceMeter).toBe(
      modelCallResourceMeter,
    );
    expect(captured!.correctness).toMatchObject({
      toolSideEffectObserver,
      authorizeToolExecution,
      assignmentMutations,
      globalQuery,
      assignmentIssuedAt: "2026-08-29T00:00:00.000Z",
      resourceReservation,
    });
    expect(captured!.observation.onProtocolEvent).toBe(onProtocolEvent);
    expect(captured!.observation.onEvent).toBeTypeOf("function");
  });

  it("propagates errors from agentRuntime.run via throw", async () => {
    const runtime = createOwnerRuntimeAdapter(
      "test-3",
      createMockAgentRuntime({ throwError: "boom" }),
    );

    const gen = runtime.run([um("hi")]);
    await expect(gen.next()).rejects.toThrow("boom");
  });

  it("dispose 透传底层运行体销毁", async () => {
    let disposedWith: string | undefined;
    const agent = createMockAgentRuntime();
    (agent as unknown as { dispose: (r: string) => Promise<void> }).dispose =
      async (reason: string) => {
        disposedWith = reason;
      };
    const runtime = createOwnerRuntimeAdapter("test-5", agent);

    await runtime.dispose();
    expect(disposedWith).toBe("session-dispose");
  });

  it("uses the assignment lifecycle reason for assignment-scoped runtimes", async () => {
    let disposedWith: string | undefined;
    const agent = createMockAgentRuntime();
    (agent as unknown as { dispose: (reason: string) => Promise<void> }).dispose =
      async (reason: string) => {
        disposedWith = reason;
      };
    const runtime = createAssignmentRuntimeAdapter("assignment-1", agent);

    await runtime.dispose();

    expect(disposedWith).toBe("assignment-dispose");
  });

  it("adapter 透传 AgentRuntime 的 confirmationBroker——远程确认链路依赖", () => {
    const agent = createMockAgentRuntime();
    const runtime = createOwnerRuntimeAdapter("test-broker", agent);
    expect(runtime.confirmationBroker).toBe(agent.confirmationBroker);
  });

  it("adapter 透传 run 外 lifecycle 诊断 drain 能力", () => {
    const diagnostics: AgentEventMap["lifecycle:warning"][] = [
      {
        hookId: "soft-window",
        phase: "onWindowOpen",
        windowIndex: 1,
        runtimeId: "rt-1",
        message: "clear degraded",
      },
    ];
    const agent = createMockAgentRuntime();
    (agent as unknown as {
      drainLifecycleDiagnostics: () => readonly AgentEventMap["lifecycle:warning"][];
    }).drainLifecycleDiagnostics = () => diagnostics;

    const runtime = createOwnerRuntimeAdapter("test-diagnostics", agent);

    expect(runtime.drainLifecycleDiagnostics?.()).toBe(diagnostics);
  });

  it("透传运行体预算 / 子 agent 用量 / 单发文本 / 安全快照能力", async () => {
    const agent = createMockAgentRuntime();
    const runtime = createOwnerRuntimeAdapter("test-inspect", agent);

    const budget = runtime.estimateConversationRequestBudget?.([um("hello")]);
    expect(budget?.currentTokens).toBe(1_000);
    expect(runtime.subAgentUsages?.([um("hello")])).toEqual([]);
    await expect(runtime.callText?.("prompt", "main")).resolves.toBe("text");
    await expect(runtime.callTextWithUsage?.("prompt", "main")).resolves.toEqual({
      text: "text",
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    expect(runtime.securitySnapshot?.()).toMatchObject({
      contextId: { kind: "main" },
      workspacePath: null,
    });
  });

  it("bounds slow-consumer text and preserves semantic barriers without losing or mutating deltas", async () => {
    const agent = createMockAgentRuntime();
    let produced = 0;
    let toolStarted = false;
    const chunk = "x".repeat(512);
    agent.run = async envelope => {
      for (let i = 0; i < 40; i++) {
        produced++;
        await envelope.observation.onEvent?.({ type: "text_delta", text: chunk });
      }
      await envelope.observation.onEvent?.({ type: "tool_start", id: "t", name: "work", input: {} });
      toolStarted = true;
      return buildResultByReason(envelope, "completed");
    };
    const run = createOwnerRuntimeAdapter("slow-consumer", agent).run([um("go")]);
    const first = await run.next();
    expect(first).toMatchObject({ done: false, value: { type: "text_delta", text: chunk } });
    await vi.waitFor(() => expect(produced).toBeGreaterThan(1));
    expect(produced).toBeLessThanOrEqual(9);
    expect(first.value).toEqual({ type: "text_delta", text: chunk });
    let text = chunk;
    let chunks = 1;
    while (true) {
      const next = await run.next();
      if (next.done) break;
      if (next.value.type === "text_delta") { text += next.value.text; chunks++; }
      if (next.value.type === "tool_start") expect(toolStarted).toBe(false);
    }
    expect(text).toBe(chunk.repeat(40));
    expect(chunks).toBeLessThan(40);
    expect(toolStarted).toBe(true);
  });

  it("preserves text/thinking boundaries and a single oversized delta", async () => {
    const yields: AgentYield[] = [
      { type: "text_delta", text: "before" },
      { type: "thinking_block_start" },
      { type: "thinking_delta", thinking: "a" },
      { type: "thinking_delta", thinking: "b" },
      { type: "thinking_block_end" },
      { type: "text_delta", text: "z".repeat(10_000) },
    ];
    const run = createOwnerRuntimeAdapter("boundaries", createMockAgentRuntime({ yields })).run([um("go")]);
    const values: AgentYield[] = [];
    while (true) { const next = await run.next(); if (next.done) break; values.push(next.value); }
    expect(values.filter(x => x.type === "text_delta").map(x => x.text).join("")).toBe("before" + "z".repeat(10_000));
    expect(values.filter(x => x.type === "thinking_delta").map(x => x.thinking).join("")).toBe("ab");
    expect(values[1]?.type).toBe("thinking_block_start");
    expect(values.at(-2)?.type).toBe("thinking_block_end");
  });

  it("delivers coalesced output and finality through the real durable stream spool", async () => {
    const { join } = await import("node:path");
    const { createTempDir } = await import("@zhixing/test-utils");
    const { FileArtifactStore } = await import("@zhixing/core/authority");
    const { createGrepTool } = await import("@zhixing/tools-builtin");
    const { writeFile } = await import("node:fs/promises");
    const { AssignmentStreamSpool, AssignmentStreamWriter } = await import("@zhixing/executor/assignment-stream-spool");
    const root = await createTempDir("adapter-stream");
    const spool = new AssignmentStreamSpool(join(root, "streams"), new FileArtifactStore(join(root, "artifacts")));
    const writer = await AssignmentStreamWriter.open(spool, "adapter-assignment", { execution: "conversation", conversationId: "adapter-conversation", runId: "adapter-run", ownerEpoch: 1 });
    const text = "some incremental output ";
    await writeFile(join(root, "fixture.txt"), "durable grep result\n");
    const grepResult = await createGrepTool().call({ pattern: "durable", path: "fixture.txt" }, { workingDirectory: root });
    const yields: AgentYield[] = [
      ...Array.from({ length: 20 }, (): AgentYield => ({ type: "text_delta", text })),
      { type: "tool_end", id: "grep", name: "grep", duration: 1, result: grepResult },
      { type: "turn_complete", turnCount: 1, usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    const run = createOwnerRuntimeAdapter("adapter-conversation", createMockAgentRuntime({ yields })).run([um("go")]);
    const persisted: AgentYield[] = [];
    const start = performance.now();
    try {
      while (true) {
        const next = await run.next();
        if (next.done) break;
        const frame = await writer.append({ kind: "agent-yield", yield: next.value });
        if (frame.payload.kind === "agent-yield") persisted.push(frame.payload.yield);
      }
      const final = await writer.final();
      await writer.markTerminal();
      expect(persisted.filter(x => x.type === "text_delta").map(x => x.text).join("")).toBe(text.repeat(20));
      expect(persisted.at(-1)?.type).toBe("turn_complete");
      expect(persisted.find(x => x.type === "tool_end")).toEqual({ type: "tool_end", id: "grep", name: "grep", duration: 1, result: grepResult });
      expect(final.finalSeq).toBeLessThanOrEqual(5);
      expect((await spool.snapshot("adapter-assignment")).finalSeq).toBe(final.finalSeq);
      console.info("durable adapter sample", { chunks: 20, frames: final.finalSeq, elapsedMs: Math.round(performance.now() - start) });
    } finally {
      await run.return(undefined as never);
      await spool.closeAssignmentScan();
      await spool.stopStorageMaintenance();
    }
  }, 30_000);

  it.each(["return", "throw", "dispose"] as const)("%s cancels and joins a producer waiting on consumer acknowledgement", async ending => {
    const agent = createMockAgentRuntime();
    let signal!: AbortSignal;
    let cleanupStarted = false;
    let settled = false;
    let disposed = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    agent.run = async envelope => {
      signal = envelope.control.abortSignal!;
      try {
        await envelope.observation.onEvent?.({ type: "tool_start", id: "t", name: "work", input: {} });
        expect(signal.aborted).toBe(true);
        // Cleanup may still report partial output; a closed consumer must not
        // leave this callback waiting on an acknowledgement nobody can give.
        await envelope.observation.onEvent?.({ type: "turn_complete", turnCount: 1, usage: { inputTokens: 0, outputTokens: 0 } });
        return buildAbortedResult(envelope, getAbortReason(signal) ?? undefined);
      } finally { cleanupStarted = true; await cleanup; settled = true; }
    };
    agent.dispose = async () => { expect(settled).toBe(true); disposed = true; };
    const runtime = createOwnerRuntimeAdapter("close-consumer", agent);
    const run = runtime.run([um("go")]);
    await run.next();
    const sinkError = new Error("durable sink failed");
    let closed = false;
    const close = (ending === "return" ? run.return(undefined as never)
      : ending === "throw" ? run.throw(sinkError) : runtime.dispose()).then(
      () => { closed = true; }, error => { expect(ending).toBe("throw"); expect(error).toBe(sinkError); closed = true; },
    );
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    expect(signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(disposed).toBe(false);
    releaseCleanup();
    await close;
    expect(settled).toBe(true);
    expect(runtime.abort()).toBe(false);
    if (ending === "dispose") { expect(disposed).toBe(true); await run.return(undefined as never); }
  });

  it.each(["completed", "error"] as const)("dispose preserves an already queued %s terminal", async ending => {
    const agent = createMockAgentRuntime();
    const failure = new Error("producer failed after text");
    agent.run = async envelope => {
      await envelope.observation.onEvent?.({ type: "text_delta", text: "partial" });
      if (ending === "error") throw failure;
      return buildResultByReason(envelope, "completed");
    };
    const runtime = createOwnerRuntimeAdapter("queued-terminal", agent);
    const run = runtime.run([um("go")]);
    expect(await run.next()).toMatchObject({ done: false, value: { type: "text_delta" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    await runtime.dispose();
    if (ending === "error") await expect(run.next()).rejects.toBe(failure);
    else expect(await run.next()).toMatchObject({ done: true, value: { agentResult: { reason: "completed" } } });
  });

  it.each(["aborted", "error"] as const)("dispose between wake and dequeue preserves the producer's %s terminal", async ending => {
    const agent = createMockAgentRuntime();
    const failure = new Error("producer failed during cancellation");
    let settled = false;
    agent.run = async envelope => {
      try {
        await envelope.observation.onEvent?.({ type: "tool_start", id: "t", name: "work", input: {} });
        const signal = envelope.control.abortSignal!;
        expect(signal.aborted).toBe(true);
        if (ending === "error") throw failure;
        return buildAbortedResult(envelope, getAbortReason(signal) ?? undefined);
      } finally { settled = true; }
    };
    agent.dispose = vi.fn(async () => { expect(settled).toBe(true); });
    const runtime = createOwnerRuntimeAdapter("wake-before-dequeue", agent);
    const run = runtime.run([um("go")]);
    const pending = run.next();
    let disposing!: Promise<void>;
    // The producer runs first and wakes next(); dispose then clears the yield
    // before the consumer continuation can dequeue it or a terminal is queued.
    queueMicrotask(() => { disposing = runtime.dispose(); });
    try {
      if (ending === "error") await expect(pending).rejects.toBe(failure);
      else await expect(pending).resolves.toMatchObject({ done: true, value: { agentResult: { reason: "aborted" } } });
    } finally { await disposing; }
    expect(agent.dispose).toHaveBeenCalledOnce();
    expect(runtime.abort()).toBe(false);
  });

  // ─── abort(reason?):fire current controller / 单维度返 boolean ───

  describe("abort(reason?)", () => {
    it("无 in-flight 时 abort() 返 false(idle 是正常状态,不抛)", () => {
      const runtime = createOwnerRuntimeAdapter("test-no-flight", createMockAgentRuntime());
      expect(runtime.abort()).toBe(false);
    });

    it("无 in-flight 时 abort 不影响下一轮 run(controller 由 run 入口创建)", async () => {
    const runtime = createOwnerRuntimeAdapter(
        "test-no-flight-then-run",
        createMockAgentRuntime(),
      );

      runtime.abort();

      const gen = runtime.run([um("normal")]);
      let runResult: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { runResult = value; break; }
      }
      expect(runResult?.agentResult.reason).toBe("completed");
    });

    it("in-flight abort:agent loop 通过 abortSignal 自然产 RunResult.aborted", async () => {
    const runtime = createOwnerRuntimeAdapter(
        "test-inflight-abort",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "partial" } as AgentYield],
          yieldDelayMs: 200,
        }),
      );

      const gen = runtime.run([um("long task")]);

      // 拿到第一个 partial yield
      const first = await gen.next();
      expect(first.done).toBe(false);

      // 触发 abort
      const fired = runtime.abort();
      expect(fired).toBe(true);

      // mock 检测到 abortSignal,后续 .then 返回 aborted RunResult,consumer loop done
      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }
      expect(result?.agentResult.reason).toBe("aborted");
    });

    it("abort 携带 reason → 透传到 agent loop 的 abortSignal(无 parent 时不 wrap)", async () => {
      // 无 parent abortSignal:run 入口创建独立 controller,abort fire 后 reason
      // 直接是用户传入的 typed reason(无 parent-abort 包装)。
      // 真实 server 路径(RPC connection close → SessionAdapter outer)会有 parent
      // 因此 fork 一层,渲染层走 unwrapParentAbort 拿根因(详见 abort-formatter-zh)。
    const runtime = createOwnerRuntimeAdapter(
        "test-typed-reason",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "x" } as AgentYield],
          yieldDelayMs: 100,
        }),
      );

      const gen = runtime.run([um("task")]);
      await gen.next();

      runtime.abort({ kind: "user-cancel", source: "rpc", pressedAt: 12345 });

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }

      expect(result?.agentResult.reason).toBe("aborted");
      const r = result!.agentResult as { reason: "aborted"; abortReason?: AbortReason };
      expect(r.abortReason).toEqual({
        kind: "user-cancel",
        source: "rpc",
        pressedAt: 12345,
      });
    });

    it("有 parent abortSignal:parent 触发 abort 经 fork wrap 为 parent-abort", async () => {
      // createInterruptController({ parent }) 走 forkController 路径:parent 自己
      // fire abort 时,fork listener 把 parent reason wrap 成 parent-abort{ parentReason }。
    const runtime = createOwnerRuntimeAdapter(
        "test-parent-fork",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "x" } as AgentYield],
          yieldDelayMs: 100,
        }),
      );

      const parent = new AbortController();
      const gen = runtime.run([um("task")], { abortSignal: parent.signal });
      await gen.next();

      // parent 触发 abort,带 typed reason
      const { abortWithReason } = await import("@zhixing/core/interrupt");
      abortWithReason(parent, { kind: "user-cancel", source: "rpc", pressedAt: 99 });

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }

      expect(result?.agentResult.reason).toBe("aborted");
      const r = result!.agentResult as { reason: "aborted"; abortReason?: AbortReason };
      expect(r.abortReason?.kind).toBe("parent-abort");
      const wrapped = r.abortReason as Extract<AbortReason, { kind: "parent-abort" }>;
      expect(wrapped.parentReason).toEqual({
        kind: "user-cancel",
        source: "rpc",
        pressedAt: 99,
      });
    });

    it("abort 缺省 reason → external{ origin: session-runtime-abort } 兜底", async () => {
    const runtime = createOwnerRuntimeAdapter(
        "test-default-reason",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "x" } as AgentYield],
          yieldDelayMs: 100,
        }),
      );

      const gen = runtime.run([um("task")]);
      await gen.next();

      runtime.abort();

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }
      const r = result!.agentResult as { reason: "aborted"; abortReason?: AbortReason };
      // 无 parent → reason 直接是 external 兜底
      expect(r.abortReason).toEqual({
        kind: "external",
        origin: "session-runtime-abort",
      });
    });

    it("幂等:多次 abort 仅第一次返 true,后续返 false 不覆盖原 reason", async () => {
    const runtime = createOwnerRuntimeAdapter(
        "test-idempotent",
        createMockAgentRuntime({
          yields: [{ type: "text_delta", text: "x" } as AgentYield],
          yieldDelayMs: 100,
        }),
      );

      const gen = runtime.run([um("task")]);
      await gen.next();

      const first = runtime.abort({ kind: "user-cancel", source: "rpc", pressedAt: 1 });
      const second = runtime.abort({ kind: "user-cancel", source: "esc", pressedAt: 2 });
      const third = runtime.abort();

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(third).toBe(false);

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }
      const r = result!.agentResult as { reason: "aborted"; abortReason?: AbortReason };
      // first-wins:保留 source: "rpc" pressedAt: 1(无 parent → 不 wrap)
      expect(r.abortReason).toEqual({
        kind: "user-cancel",
        source: "rpc",
        pressedAt: 1,
      });
    });

    it("已 aborted 的 parent abortSignal:run 入口 controller 立即 aborted,agent pre-flight 返 aborted", async () => {
    const runtime = createOwnerRuntimeAdapter(
        "test-pre-aborted",
        createMockAgentRuntime(),
      );

      const ac = new AbortController();
      ac.abort();

      const gen = runtime.run([um("never runs")], { abortSignal: ac.signal });

      let result: RunResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) { result = value; break; }
      }

      expect(result?.agentResult.reason).toBe("aborted");
    });

    it("turn 完成后 abort 返 false(currentController 已被 finally 清空)", async () => {
      const runtime = createOwnerRuntimeAdapter("test-after-done", createMockAgentRuntime());

      const gen = runtime.run([um("ok")]);
      while (true) {
        const { done } = await gen.next();
        if (done) break;
      }

      expect(runtime.abort()).toBe(false);
    });
  });
});
