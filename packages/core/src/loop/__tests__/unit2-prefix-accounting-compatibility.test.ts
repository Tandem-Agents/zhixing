/**
 * 单元 2 · Responses 追加式前缀稳定、锚点增量计量、多思考/空摘要块组装、
 * 未完工具往返兼容阻断、协议状态校验与四协议结构化错误分类单元测试。
 */

import { describe, expect, it } from "vitest";
import { createEventBus } from "../../events/index.js";
import type { ITokenEstimator } from "../../context/types.js";
import { TaskListProvider, TurnContextInjector } from "../../context/turn-context.js";
import { computeContextTokens } from "../../context/token-accounting.js";
import type { TaskItem } from "../../conversation/types.js";
import { validateMessages } from "../../protocol/values.js";
import {
  classifyProviderErrorDetail,
  formatProviderErrorForUser,
  sanitizeProviderErrorMessage,
} from "../../resilience/classify.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import type { ChatRequest, LLMProvider, StreamEvent } from "../../types/llm.js";
import { validatePreSendCompatibility } from "../../types/llm.js";
import {
  isTextProtocolState,
  isThinkingProtocolState,
  userMessage,
  type Message,
} from "../../types/messages.js";
import type { ToolDefinition } from "../../types/tools.js";
import { drainAgentLoop } from "../agent-loop.js";
import { createAppendOnlyTurnContextState } from "../prefix-projection.js";

function createLengthEstimator(): ITokenEstimator {
  const estimateText = (text: string) => text.length;
  const estimateMessage = (m: Message) =>
    m.content.reduce((sum, b) => {
      if (b.type === "text") return sum + b.text.length;
      if (b.type === "thinking") return sum + b.thinking.length;
      if (b.type === "tool_result") return sum + b.content.length;
      if (b.type === "tool_use") return sum + b.name.length + JSON.stringify(b.input).length;
      return sum + 10;
    }, 0);
  return {
    estimateText,
    estimateMessage,
    estimateMessages: (msgs) => msgs.reduce((s, m) => s + estimateMessage(m), 0),
    estimateTools: (tools) => tools.length * 10,
    calibrate() {},
    calibrationFactor: 1,
  };
}

describe("Unit 2 · Responses append-only prefix stability & truth-anchor delta accounting", () => {
  it("preserves byte-identical prefix before R0 across 2-call tool roundtrip, refreshes live C1, keeps user trust level & clean history, and counts ONLY post-anchor ephemeral delta", async () => {
    let tasks: TaskItem[] = [{ id: "t1", content: "第一步检查", status: "in_progress" }];
    const injector = new TurnContextInjector();
    injector.register(new TaskListProvider(() => tasks));

    const capturedRequests: ChatRequest[] = [];
    const responsesState = {
      protocol: "openai-responses" as const,
      sourceConnectionId: "conn-oa",
      sourceOriginKey: "openai-responses@https://api.openai.com/v1",
      sourceModel: "gpt-6.2-astra",
      payloadVersion: 1,
      encryptedContent: "enc_rs_turn1",
      opaqueStep: JSON.stringify({ id: "rs_turn1" }),
    };

    const provider: LLMProvider = {
      id: "conn-oa",
      protocol: "openai-responses",
      sourceConnectionId: "conn-oa",
      sourceOriginKey: "openai-responses@https://api.openai.com/v1",
      appendOnlyTurnContext: true,
      models: [],
      async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
        capturedRequests.push(structuredClone(request));
        yield { type: "message_start" };
        if (capturedRequests.length === 1) {
          yield { type: "thinking_block_start" };
          yield { type: "thinking_delta", thinking: "准备更新任务" };
          yield { type: "thinking_block_end", protocolState: responsesState };
          yield {
            type: "text_delta",
            text: "先更新任务状态。",
            blockId: "msg_1",
            protocolState: {
              protocol: "openai-responses",
              sourceConnectionId: "conn-oa",
              sourceOriginKey: "openai-responses@https://api.openai.com/v1",
              sourceModel: "gpt-6.2-astra",
              phase: "commentary",
              itemId: "msg_1",
            },
          };
          yield { type: "tool_call_start", id: "call_1", name: "update_task" };
          yield { type: "tool_call_delta", id: "call_1", argsFragment: '{"done":true}' };
          yield { type: "tool_call_end", id: "call_1" };
          yield {
            type: "message_end",
            stopReason: "tool_use",
            usage: { inputTokens: 1000, outputTokens: 40 },
          };
          return;
        }
        yield {
          type: "text_delta",
          text: "任务已完成。",
          blockId: "msg_2",
          protocolState: {
            protocol: "openai-responses",
            sourceConnectionId: "conn-oa",
            sourceOriginKey: "openai-responses@https://api.openai.com/v1",
            sourceModel: "gpt-6.2-astra",
            phase: "final_answer",
            itemId: "msg_2",
          },
        };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: { inputTokens: 1200, outputTokens: 20 },
        };
      },
    };

    const updateTaskTool: ToolDefinition = {
      name: "update_task",
      description: "更新任务",
      inputSchema: { type: "object", properties: { done: { type: "boolean" } } },
      async call() {
        tasks = [{ id: "t1", content: "第一步检查", status: "completed" }];
        return { content: "task updated" };
      },
    };

    const bus = createEventBus<AgentEventMap>();
    const snapshots: Array<{ totalTokens: number; turnCount: number }> = [];
    bus.on("context:tokens_snapshot", (evt) => {
      snapshots.push(evt);
    });

    const estimator = createLengthEstimator();
    const prefixMessage = userMessage("stable-window-prefix");
    const prefixState = createAppendOnlyTurnContextState([userMessage("请完成第一步")]);

    // 反复纯投影不产生重复叠加副作用
    const dryRun1 = prefixState.project([userMessage("请完成第一步")], injector.build());
    const dryRun2 = prefixState.project([userMessage("请完成第一步")], injector.build());
    expect(dryRun1.messagesForLLM).toEqual(dryRun2.messagesForLLM);
    expect(dryRun1.messagesForLLM).toHaveLength(2);

    const { yields, result } = await drainAgentLoop({
      provider,
      model: "gpt-6.2-astra",
      systemPrompt: "稳定系统提示",
      getMessagePrefix: () => [prefixMessage],
      messages: [userMessage("请完成第一步")],
      tools: [updateTaskTool],
      turnContextInjector: injector,
      prefixProjectionState: prefixState,
      tokenEstimator: estimator,
      eventBus: bus,
    });

    expect(result.reason).toBe("completed");
    expect(capturedRequests).toHaveLength(2);

    const req1Msgs = capturedRequests[0]!.messages;
    const req2Msgs = capturedRequests[1]!.messages;

    // 1. 首调为 [稳定前缀, U0, user(C0)]，次调前 3 项（R0 之前全部前缀）逐字节完全相同
    expect(req1Msgs).toHaveLength(3);
    expect(req2Msgs.slice(0, 3)).toEqual(req1Msgs);
    expect(req1Msgs[2]!.role).toBe("user");
    expect(JSON.stringify(req1Msgs[2])).toContain("[~] 第一步检查");

    // 2. 次调结构为 [稳定前缀, U0, user(C0), R0, tool_result, user(C1_refreshed)]
    expect(req2Msgs).toHaveLength(6);
    expect(req2Msgs[3]!.role).toBe("assistant");
    expect(req2Msgs[4]!.role).toBe("user");
    expect(req2Msgs[5]!.role).toBe("user");
    expect(JSON.stringify(req2Msgs[5])).toContain("[x] 第一步检查");

    // 3. 系统提示保持纯稳定，绝未把 <turn-context> 提权写入 systemPrompt
    expect(capturedRequests[0]!.systemPrompt).toBe("稳定系统提示");
    expect(capturedRequests[1]!.systemPrompt).toBe("稳定系统提示");

    // 4. 权威产出的 assistant_message 绝不含 <turn-context>
    const emittedAssistants = yields.filter((y) => y.type === "assistant_message");
    expect(JSON.stringify(emittedAssistants)).not.toContain("<turn-context>");

    // 5. Turn 1 结束时的 tokens 快照使用 anchor(1000) + delta(R0 + tool_result) + 仅新增的 C1（绝不重复计算 C0！）
    const r0 = req2Msgs[3]!;
    const toolResultMsg = req2Msgs[4]!;
    const c1Msg = req2Msgs[5]!;
    const expectedTurn1Snapshot =
      1000 +
      estimator.estimateMessages([r0, toolResultMsg]) +
      estimator.estimateMessages([c1Msg]);
    expect(snapshots[0]!.totalTokens).toBe(expectedTurn1Snapshot);

    // 6. 前缀代际失效时，computeContextTokens 忽略旧锚点并按完整发送视图重算
    const invalidatedTotal = computeContextTokens({
      estimator,
      systemPrompt: "sys",
      stateMessages: [userMessage("u")],
      providerMessages: [userMessage("p"), userMessage("u"), userMessage("c")],
      tools: [],
      anchor: { totalInputTokens: 99_999, baselineMessageCount: 1, prefixGeneration: 1 },
      prefixGeneration: 2,
    });
    expect(invalidatedTotal).toBe("sys".length + "p".length + "u".length + "c".length);
  });

  it("marks pre-existing settled history as invalidatedPrefixBeforeIndex on cold restart", async () => {
    const captured: ChatRequest[] = [];
    const provider: LLMProvider = {
      id: "conn-oa",
      protocol: "openai-responses",
      sourceConnectionId: "conn-oa",
      sourceOriginKey: "openai-responses@https://api.openai.com/v1",
      appendOnlyTurnContext: true,
      models: [],
      async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
        captured.push(structuredClone(request));
        yield { type: "message_start" };
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } };
      },
    };

    await drainAgentLoop({
      provider,
      model: "gpt-6.2-astra",
      messages: [
        userMessage("历史问题"),
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "冷重启前的旧推理",
              protocolState: {
                protocol: "openai-responses",
                sourceConnectionId: "conn-oa",
                sourceOriginKey: "openai-responses@https://api.openai.com/v1",
                sourceModel: "gpt-6.2-astra",
                payloadVersion: 1,
                encryptedContent: "stale_enc_before_restart",
              },
            },
            { type: "text", text: "历史回答" },
          ],
        },
        userMessage("重启后的新提问"),
      ],
    });

    // 冷重启从干净权威转录恢复：历史中已结算的旧推理位于 invalidatedPrefixBeforeIndex 之前
    expect(captured[0]!.invalidatedPrefixBeforeIndex).toBe(3);
  });
});

describe("Unit 2 · multi-thinking / empty-summary assembly, §2.3 compatibility, validators, and unified 403 classification", () => {
  it("preserves multiple thinking blocks, empty-summary signature-only block, and exact block ordering in streamLLMCall", async () => {
    const provider: LLMProvider = {
      id: "google",
      protocol: "google-interactions",
      sourceConnectionId: "google",
      sourceOriginKey: "google-interactions@https://generativelanguage.googleapis.com",
      models: [],
      async *chat(): AsyncGenerator<StreamEvent, void, undefined> {
        yield { type: "message_start" };
        yield { type: "thinking_block_start" };
        yield { type: "thinking_delta", thinking: "先思考" };
        yield {
          type: "thinking_block_end",
          signature: "sig-1",
          protocolState: {
            protocol: "google-interactions",
            sourceConnectionId: "google",
            sourceOriginKey: "google-interactions@https://generativelanguage.googleapis.com",
            sourceModel: "gemini-3.5-pro",
            payloadVersion: 1,
            signature: "sig-1",
          },
        };
        yield { type: "thinking_block_start" };
        // 空摘要纯签名思考块
        yield {
          type: "thinking_block_end",
          signature: "sig-2-empty",
          protocolState: {
            protocol: "google-interactions",
            sourceConnectionId: "google",
            sourceOriginKey: "google-interactions@https://generativelanguage.googleapis.com",
            sourceModel: "gemini-3.5-pro",
            payloadVersion: 1,
            signature: "sig-2-empty",
            opaqueStep: JSON.stringify({ type: "thought", signature: "sig-2-empty" }),
          },
        };
        yield { type: "text_delta", text: "答案" };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };

    const { result } = await drainAgentLoop({
      provider,
      model: "gemini-3.5-pro",
      messages: [userMessage("hi")],
    });
    expect(result.reason).toBe("completed");
    if (result.reason !== "completed") throw new Error("expected completed");
    expect(result.message.content).toHaveLength(3);
    expect(result.message.content[0]).toMatchObject({
      type: "thinking",
      thinking: "先思考",
      signature: "sig-1",
    });
    expect(result.message.content[1]).toMatchObject({
      type: "thinking",
      thinking: "",
      signature: "sig-2-empty",
    });
    expect(result.message.content[2]).toEqual({ type: "text", text: "答案" });

    // 经 protocol/values.ts 严格消息校验完整通过
    expect(() => validateMessages([result.message])).not.toThrow();
  });

  it("blocks unfinished tool roundtrip mandatory-signature conflicts and unsupported images while allowing settled cross-protocol continuation", () => {
    const unfinishedRoundtrip: Message[] = [
      userMessage("帮我查一下"),
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Claude 推理",
            signature: "sig-anth-1",
            protocolState: {
              protocol: "anthropic-messages",
              sourceConnectionId: "anth-a",
              sourceOriginKey: "anthropic-messages@https://api.anthropic.com",
              sourceModel: "claude-opus-4-7",
              payloadVersion: 1,
              signature: "sig-anth-1",
            },
          },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }] },
    ];

    // 同来源 Anthropic → 放行
    expect(
      validatePreSendCompatibility({
        messages: unfinishedRoundtrip,
        target: {
          protocol: "anthropic-messages",
          sourceConnectionId: "anth-a",
          sourceOriginKey: "anthropic-messages@https://api.anthropic.com",
          thinking: { mode: "effort", effort: "high" },
        },
      }),
    ).toBeNull();

    // 跨连接到另一 Anthropic 连接 B（未完工具往返）→ 诚实阻断并保原选择
    const conflictCrossConn = validatePreSendCompatibility({
      messages: unfinishedRoundtrip,
      target: {
        protocol: "anthropic-messages",
        sourceConnectionId: "anth-b",
        sourceOriginKey: "anthropic-messages@https://api.anthropic.com",
        thinking: { mode: "effort", effort: "high" },
      },
    });
    expect(conflictCrossConn).not.toBeNull();
    expect(conflictCrossConn!.message).toContain("未完成的工具调用往返");

    // 跨协议切换到 Google（未完工具往返 + 开启思考）→ 诚实阻断
    const conflictCrossProto = validatePreSendCompatibility({
      messages: unfinishedRoundtrip,
      target: {
        protocol: "google-interactions",
        sourceConnectionId: "google-a",
        sourceOriginKey: "google-interactions@https://generativelanguage.googleapis.com",
        thinking: { mode: "on" },
      },
    });
    expect(conflictCrossProto).not.toBeNull();

    // 已结算普通轮次跨协议切换 → 允许继续同一对话
    const settledCrossProto: Message[] = [
      userMessage("问"),
      {
        role: "assistant",
        content: [unfinishedRoundtrip[1]!.content[0]!, { type: "text", text: "答" }],
      },
      userMessage("换家模型继续"),
    ];
    expect(
      validatePreSendCompatibility({
        messages: settledCrossProto,
        target: {
          protocol: "google-interactions",
          sourceConnectionId: "google-a",
          sourceOriginKey: "google-interactions@https://generativelanguage.googleapis.com",
          thinking: { mode: "on" },
        },
      }),
    ).toBeNull();

    // 不支持图片材料 → 明确阻断并保留原选择与材料
    const imgErr = validatePreSendCompatibility({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAA" } },
          ],
        },
      ],
      inputCapabilities: { images: false },
    });
    expect(imgErr).not.toBeNull();
    expect(imgErr!.message).toContain("不支持图片输入");
  });

  it("enforces closed bounded validation on ThinkingProtocolState / TextProtocolState and distinguishes structured 403 subcodes with redaction", () => {
    expect(
      isThinkingProtocolState({
        protocol: "openai-responses",
        sourceConnectionId: "c1",
        sourceOriginKey: "openai-responses@https://api.openai.com/v1",
        sourceModel: "gpt-6.2-astra",
        payloadVersion: 1,
        encryptedContent: "enc",
        extraBadKey: true,
      }),
    ).toBe(false);
    expect(
      isThinkingProtocolState({
        protocol: "openai-responses",
        sourceConnectionId: "c1",
        sourceOriginKey: "openai-responses@https://api.openai.com/v1",
        sourceModel: "gpt-6.2-astra",
        payloadVersion: 1,
        encryptedContent: "x".repeat(300_000),
      }),
    ).toBe(false);
    expect(
      isTextProtocolState({
        protocol: "openai-responses",
        sourceConnectionId: "c1",
        sourceOriginKey: "openai-responses@https://api.openai.com/v1",
        sourceModel: "gpt-6.2-astra",
        phase: "commentary",
      }),
    ).toBe(true);
    expect(
      isTextProtocolState({
        protocol: "openai-responses",
        sourceConnectionId: "c1",
        sourceOriginKey: "openai-responses@https://api.openai.com/v1",
        sourceModel: "gpt-6.2-astra",
        phase: "guessed",
      }),
    ).toBe(false);

    // 401 vs 403 structured subcodes + secret redaction
    expect(classifyProviderErrorDetail("HTTP 401: Invalid API key sk-secret-12345678").subcode).toBe(
      "auth_invalid_credentials",
    );
    expect(classifyProviderErrorDetail("HTTP 403: unsupported_country_region_territory").subcode).toBe(
      "forbidden_region",
    );
    expect(classifyProviderErrorDetail("HTTP 403: insufficient_quota exceeded").subcode).toBe(
      "forbidden_quota",
    );
    expect(
      classifyProviderErrorDetail("HTTP 403 (PERMISSION_DENIED): does not have access to model").subcode,
    ).toBe("forbidden_model_access");
    expect(classifyProviderErrorDetail("HTTP 403: blocked by enterprise WAF policy").subcode).toBe(
      "forbidden_policy",
    );
    expect(classifyProviderErrorDetail("HTTP 403: Forbidden").subcode).toBe("forbidden_generic");
    expect(formatProviderErrorForUser("HTTP 403: Forbidden")).not.toContain("检查 API Key");

    const redacted = sanitizeProviderErrorMessage(
      "POST https://alice:secret@gw.local/v1?api_key=abc123 failed: Authorization: Bearer sk-1234567890abcdef x-goog-api-key: AIzaSyABCDEFGHIJKLMNOPQRSTUV",
    );
    expect(redacted).not.toContain("alice:secret");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("sk-1234567890abcdef");
    expect(redacted).not.toContain("AIzaSyABCDEFGHIJKLMNOPQRSTUV");
  });

  it("R1-F3: append-only Responses turn context never bypasses unfinished tool-roundtrip compatibility precheck in runAgentLoop", async () => {
    let providerCalled = 0;
    const providerB: LLMProvider = {
      id: "conn-b",
      protocol: "openai-responses",
      sourceConnectionId: "conn-b",
      sourceOriginKey: "openai-responses@https://gateway.b.example/v1",
      appendOnlyTurnContext: true,
      models: [],
      async *chat(): AsyncGenerator<StreamEvent, void, undefined> {
        providerCalled += 1;
        yield { type: "message_start" };
        yield { type: "text_delta", text: "should not run" };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const injector = new TurnContextInjector().register({
      id: "task",
      shouldInject: () => true,
      render: () => ({ title: "任务", body: "1. [~] 进行中" }),
    });

    const { result } = await drainAgentLoop({
      provider: providerB,
      model: "gpt-6.2-astra",
      thinking: { mode: "effort", effort: "high" },
      turnContextInjector: injector,
      messages: [
        userMessage("帮我查一下"),
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "来源 A 推理",
              protocolState: {
                protocol: "openai-responses",
                sourceConnectionId: "conn-a",
                sourceOriginKey: "openai-responses@https://api.openai.com/v1",
                sourceModel: "gpt-6.2-astra",
                payloadVersion: 1,
                encryptedContent: "enc_from_source_a",
              },
            },
            { type: "tool_use", id: "call_1", name: "lookup", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "call_1", content: "ok" }],
        },
      ],
    });

    expect(providerCalled).toBe(0);
    expect(result.reason).toBe("error");
    if (result.reason === "error") {
      expect(result.error.type).toBe("invalid_request");
      expect(result.error.message).toContain("未完成的工具调用往返");
    }
  });
});
