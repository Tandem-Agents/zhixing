/**
 * 单元 2 · 四协议真实 HTTP 链路与跨源隔离集成测试
 *
 * 证明边界：使用本机回环 HTTP 服务（allowPrivateOrigin: true）与真实受控单跳传输
 * （createConnectionDeliveryFetch）+ 真实 OpenAI SDK v6.33.0 + 真实 Anthropic SDK v0.85.0 +
 * 真实 Google Interactions SSE 消费，覆盖四协议流式、工具往返、思考形态、用量、取消、
 * 结构化错误脱敏与同源/跨源/改址/未知来源隔离；不替代收费公网厂商线上实测。
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatRequest, Message, StreamEvent, ThinkingBlock } from "@zhixing-ai/core";
import { userMessage } from "@zhixing-ai/core";
import {
  classifyProviderErrorDetail,
  isResponseStreamInterrupted,
  providerRequestNeverSent,
  withRetry,
} from "@zhixing-ai/core/resilience";
import { createProviderFromResolved } from "../create-provider.js";
import { computeSourceOriginKey } from "../resolve.js";
import { DEFAULT_QUIRKS, type ResolvedProvider } from "../types.js";

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

interface MockServerHandle {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  readonly close: () => Promise<void>;
}

async function startHttpServer(
  handler: (
    req: CapturedRequest,
    rawReq: http.IncomingMessage,
    res: http.ServerResponse,
    callIndex: number,
  ) => void | Promise<void>,
): Promise<MockServerHandle> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (rawReq, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of rawReq) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const captured: CapturedRequest = {
      method: rawReq.method ?? "GET",
      url: rawReq.url ?? "/",
      headers: rawReq.headers,
      body,
    };
    requests.push(captured);
    await handler(captured, rawReq, res, requests.length - 1);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function makeResolved(
  overrides: Partial<ResolvedProvider> & Pick<ResolvedProvider, "id" | "baseUrl" | "protocol">,
): ResolvedProvider {
  return {
    connectionId: overrides.connectionId ?? overrides.id,
    name: overrides.name ?? overrides.id,
    sourceOriginKey:
      overrides.sourceOriginKey ??
      computeSourceOriginKey(overrides.baseUrl, overrides.protocol),
    authMode: overrides.authMode ?? "api-key",
    apiKey: overrides.apiKey ?? "sk-test-secret-value-12345678",
    quirks: { ...DEFAULT_QUIRKS, ...overrides.quirks },
    network: { proxy: "direct", allowPrivateOrigin: true },
    declaredModels: [],
    ...overrides,
  };
}

const servers: MockServerHandle[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

describe("Unit 2 · OpenAI Responses real HTTP adapter", () => {
  it("supports GPT-6.2 developer prefix, older instructions, stateless encrypted reasoning + phase replay, tool roundtrip, usage, and cross-source/invalidated isolation", async () => {
    const server = await startHttpServer((_req, _raw, res, idx) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (idx === 0) {
        const sse = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_01", summary: [] } })}\n\n`,
          `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_01", delta: "先查目录" })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_01", summary: [{ type: "summary_text", text: "先查目录" }], encrypted_content: "enc_payload_v1_abc" } })}\n\n`,
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_01", role: "assistant", status: "in_progress", phase: "commentary", content: [] } })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 1, item_id: "msg_01", delta: "我先看一下文件。" })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_01", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "我先看一下文件。", annotations: [] }] } })}\n\n`,
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_01", call_id: "call_read_1", name: "read_file", arguments: "" } })}\n\n`,
          `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_01", delta: '{"path":"a.txt"}' })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_01", call_id: "call_read_1", name: "read_file", arguments: '{"path":"a.txt"}' } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "function_call" }], usage: { input_tokens: 120, output_tokens: 35, total_tokens: 155, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 12 } } } })}\n\n`,
        ].join("");
        res.end(sse);
        return;
      }
      const sse = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `resp_${idx + 1}` } })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_final_${idx}`, role: "assistant", status: "in_progress", phase: "final_answer", content: [] } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, item_id: `msg_final_${idx}`, delta: "已完成。" })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: `msg_final_${idx}`, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "已完成。", annotations: [] }] } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${idx + 1}`, status: "completed", output: [], usage: { input_tokens: 200, output_tokens: 10, total_tokens: 210, input_tokens_details: { cached_tokens: 120 }, output_tokens_details: { reasoning_tokens: 0 } } } })}\n\n`,
      ].join("");
      res.end(sse);
    });
    servers.push(server);

    const providerA = createProviderFromResolved(
      makeResolved({
        id: "openai-official",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-responses",
      }),
    );
    expect(providerA.protocol).toBe("openai-responses");
    expect(providerA.appendOnlyTurnContext).toBe(true);

    // 1. GPT-6.2+ uses first developer item in input (instructions omitted)
    const events1 = await collect(
      providerA.chat({
        model: "gpt-6.2-astra",
        systemPrompt: "稳定系统提示",
        thinking: { mode: "effort", effort: "high" },
        tools: [
          {
            name: "read_file",
            description: "读取文件",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        messages: [userMessage("读一下 a.txt")],
      }),
    );

    expect(server.requests[0]!.url).toBe("/v1/responses");
    expect(server.requests[0]!.body.store).toBe(false);
    expect(server.requests[0]!.body.include).toEqual(["reasoning.encrypted_content"]);
    expect(server.requests[0]!.body.instructions).toBeUndefined();
    expect(server.requests[0]!.body.reasoning).toEqual({ effort: "high", summary: "auto" });
    const req1Input = server.requests[0]!.body.input as Array<Record<string, unknown>>;
    expect(req1Input[0]).toEqual({
      type: "message",
      role: "developer",
      content: "稳定系统提示",
    });

    const thinkingEnd = events1.find((e) => e.type === "thinking_block_end");
    expect(thinkingEnd?.type).toBe("thinking_block_end");
    if (thinkingEnd?.type !== "thinking_block_end") throw new Error("missing thinking_block_end");
    expect(thinkingEnd.protocolState).toMatchObject({
      protocol: "openai-responses",
      sourceConnectionId: "openai-official",
      sourceOriginKey: `openai-responses@${server.baseUrl}/v1`,
      sourceModel: "gpt-6.2-astra",
      encryptedContent: "enc_payload_v1_abc",
    });

    const textDelta = events1.find((e) => e.type === "text_delta" && e.text.length > 0);
    expect(textDelta?.type).toBe("text_delta");
    if (textDelta?.type !== "text_delta") throw new Error("missing text_delta");
    expect(textDelta.protocolState).toMatchObject({
      protocol: "openai-responses",
      phase: "commentary",
      itemId: "msg_01",
    });

    const msgEnd1 = events1.find((e) => e.type === "message_end");
    expect(msgEnd1).toEqual({
      type: "message_end",
      stopReason: "tool_use",
      usage: { inputTokens: 120, outputTokens: 35, cacheReadTokens: 80 },
    });

    // 2. Same-source tool roundtrip replays exact order: reasoning(id+encrypted) -> message(phase="commentary") -> function_call -> function_call_output
    const roundtripMessages: Message[] = [
      userMessage("读一下 a.txt"),
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "先查目录",
            protocolState: thinkingEnd.protocolState,
          },
          {
            type: "text",
            text: "我先看一下文件。",
            protocolState: textDelta.protocolState,
          },
          {
            type: "tool_use",
            id: "call_read_1",
            name: "read_file",
            input: { path: "a.txt" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "call_read_1", content: "hello" }],
      },
    ];

    await collect(
      providerA.chat({
        model: "gpt-6.2-astra",
        systemPrompt: "稳定系统提示",
        messages: roundtripMessages,
      }),
    );

    const req2Input = server.requests[1]!.body.input as Array<Record<string, unknown>>;
    expect(req2Input.map((item) => item.type)).toEqual([
      "message", // developer
      "message", // user
      "reasoning",
      "message", // assistant commentary
      "function_call",
      "function_call_output",
    ]);
    expect(req2Input[2]).toEqual({
      type: "reasoning",
      id: "rs_01",
      summary: [{ type: "summary_text", text: "先查目录" }],
      encrypted_content: "enc_payload_v1_abc",
    });
    expect(req2Input[3]).toMatchObject({
      type: "message",
      id: "msg_01",
      role: "assistant",
      phase: "commentary",
    });
    expect(req2Input[4]).toEqual({
      type: "function_call",
      call_id: "call_read_1",
      name: "read_file",
      arguments: '{"path":"a.txt"}',
    });

    // 3. Earlier Responses model (gpt-6.1-sol) uses top-level instructions (not developer prefix)
    //    AND invalidatedPrefixBeforeIndex honestly omits prior settled encrypted reasoning
    await collect(
      providerA.chat({
        model: "gpt-6.1-sol",
        systemPrompt: "旧机型系统指令",
        invalidatedPrefixBeforeIndex: 2,
        messages: [
          userMessage("第一轮"),
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "旧推理", protocolState: thinkingEnd.protocolState },
              { type: "text", text: "旧回答" },
            ],
          },
          userMessage("第二轮"),
        ],
      }),
    );
    expect(server.requests[2]!.body.instructions).toBe("旧机型系统指令");
    const req3Input = server.requests[2]!.body.input as Array<Record<string, unknown>>;
    expect(req3Input.some((i) => i.role === "developer")).toBe(false);
    expect(req3Input.some((i) => i.type === "reasoning")).toBe(false);
    // 无原 phase 时绝不猜造 phase
    const req3Assistant = req3Input.find((i) => i.role === "assistant");
    expect(req3Assistant).toEqual({
      type: "message",
      role: "assistant",
      content: "旧回答",
    });
    expect("phase" in req3Assistant!).toBe(false);

    // 4. Same protocol + same model name on a DIFFERENT connection B (or changed basePath) MUST NOT forward encrypted_content or phase/itemId
    const providerB = createProviderFromResolved(
      makeResolved({
        id: "openai-gateway-b",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-responses",
      }),
    );
    const providerAChangedPath = createProviderFromResolved(
      makeResolved({
        id: "openai-official",
        baseUrl: `${server.baseUrl}/alt/v1`,
        protocol: "openai-responses",
      }),
    );
    const settledHistory: Message[] = [
      userMessage("问"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "秘密推理", protocolState: thinkingEnd.protocolState },
          { type: "text", text: "可见回答", protocolState: textDelta.protocolState },
        ],
      },
      userMessage("继续"),
    ];
    await collect(providerB.chat({ model: "gpt-6.2-astra", messages: settledHistory }));
    await collect(providerAChangedPath.chat({ model: "gpt-6.2-astra", messages: settledHistory }));

    for (const idx of [3, 4]) {
      const inp = server.requests[idx]!.body.input as Array<Record<string, unknown>>;
      expect(inp.some((i) => i.type === "reasoning")).toBe(false);
      expect(JSON.stringify(inp)).not.toContain("enc_payload_v1_abc");
      const asst = inp.find((i) => i.role === "assistant");
      expect(asst).toEqual({ type: "message", role: "assistant", content: "可见回答" });
      expect("phase" in asst!).toBe(false);
    }

    await providerA.close?.();
    await providerB.close?.();
    await providerAChangedPath.close?.();
  });

  it("handles abort, structured HTTP 403 error redaction, and provenUndelivered on connect refused", async () => {
    const server = await startHttpServer((_req, _raw, res, idx) => {
      if (idx === 0) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "Country, region, or territory not supported for Bearer sk-live-secret999999 at https://u:p@proxy.local",
              type: "forbidden",
              code: "unsupported_country_region_territory",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r_abort" } })}\n\n`,
      );
      // 保持流挂起直到客户端 abort
    });
    servers.push(server);

    const provider = createProviderFromResolved(
      makeResolved({
        id: "openai-err",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-responses",
      }),
    );

    const errEvents = await collect(
      provider.chat({ model: "gpt-6.2-astra", messages: [userMessage("hi")] }),
    );
    const errEvt = errEvents.find((e) => e.type === "error");
    expect(errEvt?.type).toBe("error");
    if (errEvt?.type !== "error") throw new Error("expected error");
    expect(errEvt.error.message).not.toContain("sk-live-secret999999");
    expect(errEvt.error.message).not.toContain("u:p@");
    const detail = classifyProviderErrorDetail(errEvt.error);
    expect(detail.subcode).toBe("forbidden_region");
    expect(detail.userMessage).toContain("地区");
    expect(detail.userMessage).not.toContain("API Key");

    // Abort mid-stream
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const abortEvents = await collect(
      provider.chat({
        model: "gpt-6.2-astra",
        messages: [userMessage("abort me")],
        abortSignal: ac.signal,
      }),
    );
    const abortErr = abortEvents.find((e) => e.type === "error");
    expect(abortErr?.type).toBe("error");
    if (abortErr?.type === "error") {
      expect(classifyProviderErrorDetail(abortErr.error).type).toBe("aborted");
    }

    // Connection refused on a closed ephemeral local port → provenUndelivered === true
    await provider.close?.();
    const closedServer = await startHttpServer((_req, _raw, res) => res.end());
    const closedBaseUrl = closedServer.baseUrl;
    await closedServer.close();
    const deadProvider = createProviderFromResolved(
      makeResolved({
        id: "openai-dead",
        baseUrl: `${closedBaseUrl}/v1`,
        protocol: "openai-responses",
      }),
    );
    const deadEvents = await collect(
      deadProvider.chat({ model: "gpt-6.2-astra", messages: [userMessage("hi")] }),
    );
    const deadErr = deadEvents.find((e) => e.type === "error");
    expect(deadErr?.type).toBe("error");
    if (deadErr?.type === "error") {
      expect(providerRequestNeverSent(deadErr.error)).toBe(true);
    }
    await deadProvider.close?.();
  });
});

describe("Unit 2 · Google Interactions real HTTP adapter (GA step contract)", () => {
  it("streams multi-thought + empty-summary signature-only thought + arguments_delta + requires_action, replays statelessly on same source & model switch, and isolates cross-source", async () => {
    const server = await startHttpServer((_req, _raw, res, idx) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (idx === 0) {
        // 严格按官方 GA step.start / step.delta / step.stop 与 interaction.completed(requires_action, 无 steps)
        const sse = [
          `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "int_1", status: "in_progress" } })}\n\n`,
          // Thought #1: 含摘要与签名
          `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "thought" } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "第一步规划" } } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "gsig_one_AAA" } })}\n\n`,
          `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 0 })}\n\n`,
          // Thought #2: 空摘要纯签名
          `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 1, step: { type: "thought" } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 1, delta: { type: "thought_signature", signature: "gsig_two_empty_summary" } })}\n\n`,
          `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 1 })}\n\n`,
          // Function call with incremental arguments_delta.arguments
          `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 2, step: { type: "function_call", id: "gfc_1", name: "lookup_weather", arguments: {} } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 2, delta: { type: "arguments_delta", arguments: '{"city":' } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 2, delta: { type: "arguments_delta", arguments: '"Tokyo"}' } })}\n\n`,
          `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 2 })}\n\n`,
          // interaction.completed 无 steps 字段且 status = requires_action
          `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: { id: "int_1", status: "requires_action", usage: { total_input_tokens: 90, total_output_tokens: 20, total_thought_tokens: 15, total_cached_tokens: 40, total_tokens: 125 } } })}\n\n`,
          `event: done\ndata: [DONE]\n\n`,
        ].join("");
        res.end(sse);
        return;
      }
      const sse = [
        `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: `int_${idx + 1}`, status: "in_progress" } })}\n\n`,
        `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "model_output" } })}\n\n`,
        `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "text", text: "东京晴天 22°C" } })}\n\n`,
        `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 0 })}\n\n`,
        `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: { id: `int_${idx + 1}`, status: "completed", usage: { total_input_tokens: 140, total_output_tokens: 12, total_tokens: 152 } } })}\n\n`,
        `event: done\ndata: [DONE]\n\n`,
      ].join("");
      res.end(sse);
    });
    servers.push(server);

    const googleA = createProviderFromResolved(
      makeResolved({
        id: "google-official",
        baseUrl: server.baseUrl,
        protocol: "google-interactions",
        apiKey: "AIzaSyTestSecretKey1234567890",
      }),
    );

    const events1 = await collect(
      googleA.chat({
        model: "gemini-3.5-pro",
        systemPrompt: "天气助手",
        thinking: { mode: "effort", effort: "high" },
        tools: [
          {
            name: "lookup_weather",
            description: "查询天气",
            inputSchema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        messages: [userMessage("东京天气？")],
      }),
    );

    expect(server.requests[0]!.url).toBe("/v1/interactions?alt=sse");
    expect(server.requests[0]!.headers["x-goog-api-key"]).toBe("AIzaSyTestSecretKey1234567890");
    expect(server.requests[0]!.body.store).toBe(false);
    expect(server.requests[0]!.body.stream).toBe(true);
    expect(server.requests[0]!.body.system_instruction).toBe("天气助手");
    expect(server.requests[0]!.body.generation_config).toMatchObject({
      thinking_level: "high",
      thinking_summaries: "auto",
    });

    const thinkingEnds = events1.filter(
      (e): e is Extract<StreamEvent, { type: "thinking_block_end" }> =>
        e.type === "thinking_block_end",
    );
    expect(thinkingEnds).toHaveLength(2);
    expect(thinkingEnds[0]!.signature).toBe("gsig_one_AAA");
    expect(thinkingEnds[1]!.signature).toBe("gsig_two_empty_summary");

    const toolDeltas = events1
      .filter((e): e is Extract<StreamEvent, { type: "tool_call_delta" }> => e.type === "tool_call_delta")
      .map((e) => e.argsFragment)
      .join("");
    expect(toolDeltas).toBe('{"city":"Tokyo"}');

    const msgEnd1 = events1.find((e) => e.type === "message_end");
    expect(msgEnd1).toEqual({
      type: "message_end",
      stopReason: "tool_use",
      usage: { inputTokens: 90, outputTokens: 35, cacheReadTokens: 40 },
    });

    // Build persisted history preserving BOTH thought steps (including empty summary!) and replay on SAME source with DIFFERENT model (gemini-3.5-flash)
    const history: Message[] = [
      userMessage("东京天气？"),
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "第一步规划",
            signature: "gsig_one_AAA",
            protocolState: thinkingEnds[0]!.protocolState,
          },
          {
            type: "thinking",
            thinking: "",
            signature: "gsig_two_empty_summary",
            protocolState: thinkingEnds[1]!.protocolState,
          },
          {
            type: "tool_use",
            id: "gfc_1",
            name: "lookup_weather",
            input: { city: "Tokyo" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "gfc_1", content: "sunny 22C" }],
      },
    ];

    await collect(googleA.chat({ model: "gemini-3.5-flash", messages: history }));
    const req2Steps = server.requests[1]!.body.input as Array<Record<string, unknown>>;
    expect(req2Steps).toEqual([
      { type: "user_input", content: [{ type: "text", text: "东京天气？" }] },
      {
        type: "thought",
        signature: "gsig_one_AAA",
        summary: [{ type: "text", text: "第一步规划" }],
      },
      {
        type: "thought",
        signature: "gsig_two_empty_summary",
      },
      {
        type: "function_call",
        id: "gfc_1",
        name: "lookup_weather",
        arguments: { city: "Tokyo" },
      },
      {
        type: "function_result",
        call_id: "gfc_1",
        name: "lookup_weather",
        result: "sunny 22C",
      },
    ]);

    // Different connection B (or changed /v1beta endpoint) MUST NOT forward Google thought steps
    const googleB = createProviderFromResolved(
      makeResolved({
        id: "google-second-conn",
        baseUrl: `${server.baseUrl}/v1beta`,
        protocol: "google-interactions",
      }),
    );
    await collect(
      googleB.chat({
        model: "gemini-3.5-pro",
        messages: [
          userMessage("问"),
          {
            role: "assistant",
            content: [
              history[1]!.content[0] as ThinkingBlock,
              history[1]!.content[1] as ThinkingBlock,
              { type: "text", text: "已答复" },
            ],
          },
          userMessage("追问"),
        ],
      }),
    );
    expect(server.requests[2]!.url).toBe("/v1beta/interactions?alt=sse");
    const req3Steps = server.requests[2]!.body.input as Array<Record<string, unknown>>;
    expect(req3Steps.some((s) => s.type === "thought")).toBe(false);
    expect(JSON.stringify(req3Steps)).not.toContain("gsig_one_AAA");
    expect(JSON.stringify(req3Steps)).not.toContain("gsig_two_empty_summary");

    await googleA.close?.();
    await googleB.close?.();
  });

  it("classifies Google HTTP 403 permission/quota errors without leaking x-goog-api-key and handles abort", async () => {
    const server = await startHttpServer((_req, _raw, res, idx) => {
      if (idx === 0) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message:
                "User does not have access to model gemini-3.5-pro (key=AIzaSyLeakyKey123456789012)",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "g_abort" } })}\n\n`,
      );
    });
    servers.push(server);

    const provider = createProviderFromResolved(
      makeResolved({
        id: "google-err",
        baseUrl: server.baseUrl,
        protocol: "google-interactions",
        apiKey: "AIzaSyLeakyKey123456789012",
      }),
    );
    const events = await collect(
      provider.chat({ model: "gemini-3.5-pro", messages: [userMessage("hi")] }),
    );
    const errEvt = events.find((e) => e.type === "error");
    expect(errEvt?.type).toBe("error");
    if (errEvt?.type !== "error") throw new Error("expected error");
    expect(errEvt.error.message).not.toContain("AIzaSyLeakyKey123456789012");
    const detail = classifyProviderErrorDetail(errEvt.error);
    expect(detail.subcode).toBe("forbidden_model_access");
    expect(detail.userMessage).toContain("无权访问");

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const abortEvents = await collect(
      provider.chat({
        model: "gemini-3.5-pro",
        messages: [userMessage("stop")],
        abortSignal: ac.signal,
      }),
    );
    const abortErr = abortEvents.find((e) => e.type === "error");
    expect(abortErr?.type).toBe("error");
    if (abortErr?.type === "error") {
      expect(classifyProviderErrorDetail(abortErr.error).type).toBe("aborted");
    }
    await provider.close?.();
  });
});

describe("Unit 2 · Anthropic Messages & OpenAI Compatible real HTTP dialect/thinking verification", () => {
  it("sends adaptive + output_config.effort on Claude 4.7+ (never deprecated enabled+budget_tokens) and preserves budget_tokens on pre-4.7 over real HTTP", async () => {
    const server = await startHttpServer((_req, _raw, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const sse = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-4-7", content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "分析中" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "anth_sig_123" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "好的" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join("");
      res.end(sse);
    });
    servers.push(server);

    const anthropic = createProviderFromResolved(
      makeResolved({
        id: "anthropic-official",
        baseUrl: server.baseUrl,
        protocol: "anthropic-messages",
        quirks: { ...DEFAULT_QUIRKS, thinkingDialect: "anthropic", supportsThinking: true },
      }),
    );

    const events47 = await collect(
      anthropic.chat({
        model: "claude-opus-4-7",
        thinking: { mode: "effort", effort: "max" },
        messages: [userMessage("复杂问题")],
      }),
    );
    expect(server.requests[0]!.body.thinking).toEqual({ type: "adaptive" });
    expect(server.requests[0]!.body.output_config).toEqual({ effort: "max" });
    const end47 = events47.find((e) => e.type === "message_end");
    expect(end47).toEqual({
      type: "message_end",
      stopReason: "end_turn",
      usage: {
        inputTokens: 40,
        totalInputTokens: 55,
        outputTokens: 15,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
    });

    // Passing legacy budget to Claude 4.7+ must NOT send deprecated enabled+budget_tokens
    await collect(
      anthropic.chat({
        model: "claude-sonnet-4-7",
        thinking: { mode: "budget", budget: 4096 },
        messages: [userMessage("hi")],
      }),
    );
    expect(server.requests[1]!.body.thinking).toEqual({ type: "adaptive" });

    // Pre-4.7 Claude model preserves enabled + budget_tokens
    await collect(
      anthropic.chat({
        model: "claude-sonnet-4-5-20250929",
        thinking: { mode: "budget", budget: 4096 },
        messages: [userMessage("hi")],
      }),
    );
    expect(server.requests[2]!.body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });

    await anthropic.close?.();
  });

  it("verifies OpenAI Compatible dialects (qwen / glm / kimi / deepseek / conservative proxy) over real HTTP", async () => {
    const server = await startHttpServer((_req, _raw, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const sse = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { reasoning_content: "思考" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "答复" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 12 } } })}\n\n`,
        `data: [DONE]\n\n`,
      ].join("");
      res.end(sse);
    });
    servers.push(server);

    const qwen = createProviderFromResolved(
      makeResolved({
        id: "qwen",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-compatible",
        quirks: { ...DEFAULT_QUIRKS, thinkingDialect: "qwen", supportsStreamUsage: true },
      }),
    );
    const glm = createProviderFromResolved(
      makeResolved({
        id: "glm",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-compatible",
        quirks: { ...DEFAULT_QUIRKS, thinkingDialect: "glm", supportsStreamUsage: true },
      }),
    );
    const conservative = createProviderFromResolved(
      makeResolved({
        id: "openrouter",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-compatible",
        quirks: { ...DEFAULT_QUIRKS, thinkingDialect: "none", supportsStreamUsage: true },
      }),
    );

    const qEvents = await collect(
      qwen.chat({
        model: "qwen-max",
        thinking: { mode: "budget", budget: 2048 },
        messages: [userMessage("hi")],
      }),
    );
    expect(server.requests[0]!.body.enable_thinking).toBe(true);
    expect(server.requests[0]!.body.thinking_budget).toBe(2048);
    expect(qEvents.find((e) => e.type === "message_end")).toEqual({
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens: 30, outputTokens: 8, cacheReadTokens: 12 },
    });

    await collect(
      glm.chat({
        model: "glm-4.7",
        thinking: { mode: "on" },
        messages: [userMessage("hi")],
      }),
    );
    expect(server.requests[1]!.body.thinking).toEqual({ type: "enabled" });

    // Conservative proxy never forwards vendor thinking params or foreign reasoning_content
    const qEnd = qEvents.find((e) => e.type === "thinking_block_end");
    await collect(
      conservative.chat({
        model: "qwen/qwen-max",
        thinking: { mode: "on" },
        messages: [
          userMessage("hi"),
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "思考",
                protocolState: qEnd?.type === "thinking_block_end" ? qEnd.protocolState : undefined,
              },
              { type: "text", text: "答复" },
            ],
          },
          userMessage("next"),
        ],
      }),
    );
    expect(server.requests[2]!.body.thinking).toBeUndefined();
    expect(server.requests[2]!.body.enable_thinking).toBeUndefined();
    const proxyMsgs = server.requests[2]!.body.messages as Array<Record<string, unknown>>;
    const proxyAsst = proxyMsgs.find((m) => m.role === "assistant");
    expect("reasoning_content" in proxyAsst!).toBe(false);

    await qwen.close?.();
    await glm.close?.();
    await conservative.close?.();
  });
});

describe("Unit 2 R2 regressions · R1-F1 premature EOF, R1-F2 native summary fidelity, R1-F4 bound secret & 403 subcode", () => {
  it("R1-F1: rejects premature SSE EOF / [DONE] without protocol terminal event or unclosed items on both new adapters and prevents withRetry replay", async () => {
    const server = await startHttpServer((req, _raw, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (req.url.includes("/responses")) {
        // 仅发前 5 个事件后正常关闭连接（无 response.completed / response.incomplete，且 item 未闭合）
        res.end([
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_cut", status: "in_progress" } })}\n\n`,
          `event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", response: { id: "resp_cut", status: "in_progress" } })}\n\n`,
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_cut", role: "assistant", status: "in_progress", content: [] } })}\n\n`,
          `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", output_index: 0, item_id: "msg_cut", content_index: 0, part: { type: "output_text", text: "" } })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, item_id: "msg_cut", delta: "截断前的部分回答" })}\n\n`,
        ].join(""));
        return;
      }
      // Google Interactions：仅发未闭合 step 后发 [DONE] 关闭（无 interaction.completed）
      res.end([
        `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "g_cut", status: "in_progress" } })}\n\n`,
        `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "thought" } })}\n\n`,
        `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "截断思考" } } })}\n\n`,
        `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 1, step: { type: "model_output" } })}\n\n`,
        `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 1, delta: { type: "text", text: "半截内容" } })}\n\n`,
        `event: done\ndata: [DONE]\n\n`,
      ].join(""));
    });
    servers.push(server);

    const responses = createProviderFromResolved(
      makeResolved({
        id: "oa-cut",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-responses",
        apiKey: "bare-secret-cut-oa",
      }),
    );
    const google = createProviderFromResolved(
      makeResolved({
        id: "gg-cut",
        baseUrl: server.baseUrl,
        protocol: "google-interactions",
        apiKey: "bare-secret-cut-gg",
      }),
    );

    const retryResponses = withRetry((req) => responses.chat(req), { maxRetries: 2 });
    const oaEvents = await collect(
      retryResponses({ model: "gpt-6.2-astra", messages: [userMessage("hi")] }),
    );
    expect(oaEvents.some((e) => e.type === "message_end")).toBe(false);
    expect(oaEvents.some((e) => e.type === "text_delta" && e.text === "截断前的部分回答")).toBe(true);
    const oaErr = oaEvents.find((e) => e.type === "error");
    expect(oaErr?.type).toBe("error");
    if (oaErr?.type === "error") {
      expect(isResponseStreamInterrupted(oaErr.error)).toBe(true);
      expect(providerRequestNeverSent(oaErr.error)).toBe(false);
      expect(classifyProviderErrorDetail(oaErr.error.message).userMessage).toContain("未收到协议终止事件");
    }
    expect(server.requests.filter((r) => r.url.includes("/responses"))).toHaveLength(1);

    const retryGoogle = withRetry((req) => google.chat(req), { maxRetries: 2 });
    const ggEvents = await collect(
      retryGoogle({ model: "gemini-3.5-pro", messages: [userMessage("hi")] }),
    );
    expect(ggEvents.some((e) => e.type === "message_end")).toBe(false);
    // 截断时绝不刷出未闭合的 thought step
    expect(ggEvents.some((e) => e.type === "thinking_block_end")).toBe(false);
    expect(ggEvents.some((e) => e.type === "text_delta" && e.text === "半截内容")).toBe(true);
    const ggErr = ggEvents.find((e) => e.type === "error");
    expect(ggErr?.type).toBe("error");
    if (ggErr?.type === "error") {
      expect(isResponseStreamInterrupted(ggErr.error)).toBe(true);
      expect(providerRequestNeverSent(ggErr.error)).toBe(false);
    }
    expect(server.requests.filter((r) => r.url.includes("/interactions"))).toHaveLength(1);

    await responses.close?.();
    await google.close?.();
  });

  it("R1-F2: preserves native multi-summary array on OpenAI Responses and ordered text-image-text thought summary on Google Interactions across stateless replay", async () => {
    const server = await startHttpServer((req, _raw, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (req.url.includes("/responses")) {
        const callNum = server.requests.filter((r) => r.url.includes("/responses")).length;
        if (callNum === 1) {
          res.end([
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_multi_sum", summary: [] } })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_multi_sum", summary_index: 0, delta: "第一条摘要" })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_multi_sum", summary_index: 1, delta: "第二条摘要" })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_multi_sum", summary: [{ type: "summary_text", text: "第一条摘要" }, { type: "summary_text", text: "第二条摘要" }], encrypted_content: "enc_multi_sum_1" } })}\n\n`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_m1", role: "assistant", status: "in_progress", phase: "final_answer", content: [] } })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 1, item_id: "msg_m1", delta: "ok" })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_m1", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "ok", annotations: [] }] } })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_m1", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
          ].join(""));
          return;
        }
        res.end([
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_m2", role: "assistant", status: "in_progress", phase: "final_answer", content: [] } })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, item_id: "msg_m2", delta: "done" })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_m2", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "done", annotations: [] }] } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_m2", status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } })}\n\n`,
        ].join(""));
        return;
      }

      const gCall = server.requests.filter((r) => r.url.includes("/interactions")).length;
      if (gCall === 1) {
        res.end([
          `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "g_struct_1", status: "in_progress" } })}\n\n`,
          `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "thought" } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "前段文字" } } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "image", uri: "https://example.invalid/thought-diagram.png", mime_type: "image/png" } } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "后段文字" } } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "gsig_struct_1" } })}\n\n`,
          `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 0 })}\n\n`,
          `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 1, step: { type: "model_output" } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 1, delta: { type: "text", text: "完成" } })}\n\n`,
          `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 1 })}\n\n`,
          `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: { id: "g_struct_1", status: "completed", usage: { total_input_tokens: 15, total_output_tokens: 4 } } })}\n\n`,
          `event: done\ndata: [DONE]\n\n`,
        ].join(""));
        return;
      }
      res.end([
        `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "g_struct_2", status: "in_progress" } })}\n\n`,
        `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "model_output" } })}\n\n`,
        `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "text", text: "二轮完成" } })}\n\n`,
        `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 0 })}\n\n`,
        `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: { id: "g_struct_2", status: "completed", usage: { total_input_tokens: 20, total_output_tokens: 4 } } })}\n\n`,
        `event: done\ndata: [DONE]\n\n`,
      ].join(""));
    });
    servers.push(server);

    const oa = createProviderFromResolved(
      makeResolved({
        id: "oa-struct",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-responses",
        apiKey: "oa-struct-key",
      }),
    );
    const oaEvents1 = await collect(
      oa.chat({ model: "gpt-6.2-astra", messages: [userMessage("q1")] }),
    );
    const oaThinkEnd = oaEvents1.find((e) => e.type === "thinking_block_end");
    expect(oaThinkEnd?.type).toBe("thinking_block_end");
    const oaState = oaThinkEnd?.type === "thinking_block_end" ? oaThinkEnd.protocolState : undefined;
    expect(JSON.parse(oaState!.opaqueStep!)).toMatchObject({
      type: "reasoning",
      id: "rs_multi_sum",
      summary: [
        { type: "summary_text", text: "第一条摘要" },
        { type: "summary_text", text: "第二条摘要" },
      ],
    });

    await collect(
      oa.chat({
        model: "gpt-6.2-astra",
        messages: [
          userMessage("q1"),
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "第一条摘要\n\n第二条摘要", protocolState: oaState },
              { type: "text", text: "ok" },
            ],
          },
          userMessage("q2"),
        ],
      }),
    );
    const oaReqs = server.requests.filter((r) => r.url.includes("/responses"));
    const replayedReasoning = (oaReqs[1]!.body.input as Array<Record<string, unknown>>).find(
      (i) => i.type === "reasoning",
    );
    expect(replayedReasoning).toEqual({
      type: "reasoning",
      id: "rs_multi_sum",
      summary: [
        { type: "summary_text", text: "第一条摘要" },
        { type: "summary_text", text: "第二条摘要" },
      ],
      encrypted_content: "enc_multi_sum_1",
    });

    const gg = createProviderFromResolved(
      makeResolved({
        id: "gg-struct",
        baseUrl: server.baseUrl,
        protocol: "google-interactions",
        apiKey: "gg-struct-key",
      }),
    );
    const ggEvents1 = await collect(
      gg.chat({ model: "gemini-3.5-pro", messages: [userMessage("g1")] }),
    );
    const ggDisplay = ggEvents1
      .filter((e): e is Extract<StreamEvent, { type: "thinking_delta" }> => e.type === "thinking_delta")
      .map((e) => e.thinking)
      .join("");
    expect(ggDisplay).toBe("前段文字\n\n后段文字");
    const ggThinkEnd = ggEvents1.find((e) => e.type === "thinking_block_end");
    expect(ggThinkEnd?.type).toBe("thinking_block_end");
    const ggState = ggThinkEnd?.type === "thinking_block_end" ? ggThinkEnd.protocolState : undefined;
    const parsedThought = JSON.parse(ggState!.opaqueStep!) as Record<string, unknown>;
    expect(parsedThought).toEqual({
      type: "thought",
      signature: "gsig_struct_1",
      summary: [
        { type: "text", text: "前段文字" },
        { type: "image", uri: "https://example.invalid/thought-diagram.png", mime_type: "image/png" },
        { type: "text", text: "后段文字" },
      ],
    });

    await collect(
      gg.chat({
        model: "gemini-3.5-pro",
        messages: [
          userMessage("g1"),
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: ggDisplay, signature: "gsig_struct_1", protocolState: ggState },
              { type: "text", text: "完成" },
            ],
          },
          userMessage("g2"),
        ],
      }),
    );
    const ggReqs = server.requests.filter((r) => r.url.includes("/interactions"));
    const replayedThought = (ggReqs[1]!.body.input as Array<Record<string, unknown>>).find(
      (s) => s.type === "thought",
    );
    expect(replayedThought).toEqual(parsedThought);

    await oa.close?.();
    await gg.close?.();
  });

  it("R1-F4: redacts non-prefixed active bound credentials and preserves structured 403 subcode across string-only projection on both HTTP and Google SSE errors", async () => {
    const bareSecret = "custom-bare-token-99887766";
    const server = await startHttpServer((req, _raw, res) => {
      if (req.url.includes("/responses")) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "model_access_denied",
              message: `Request rejected for credential ${bareSecret}`,
            },
          }),
        );
        return;
      }
      if (req.body.model === "gemini-sse-err") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end([
          `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "g_err", status: "in_progress" } })}\n\n`,
          `event: error\ndata: ${JSON.stringify({ event_type: "error", error: { code: "model_access_denied", http_status: 403, message: `Denied credential ${bareSecret}` } })}\n\n`,
        ].join(""));
        return;
      }
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "model_access_denied",
            message: `Denied for token ${bareSecret}`,
          },
        }),
      );
    });
    servers.push(server);

    const oa = createProviderFromResolved(
      makeResolved({
        id: "oa-403",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-responses",
        apiKey: bareSecret,
      }),
    );
    const gg = createProviderFromResolved(
      makeResolved({
        id: "gg-403",
        baseUrl: server.baseUrl,
        protocol: "google-interactions",
        apiKey: bareSecret,
      }),
    );

    for (const [provider, model] of [
      [oa, "gpt-6.2-astra"],
      [gg, "gemini-3.5-pro"],
      [gg, "gemini-sse-err"],
    ] as const) {
      const events = await collect(provider.chat({ model, messages: [userMessage("hi")] }));
      const errEv = events.find((e) => e.type === "error");
      expect(errEv?.type).toBe("error");
      if (errEv?.type === "error") {
        expect(errEv.error.message).not.toContain(bareSecret);
        expect(errEv.error.cause).toBeUndefined();
        // 字符串形态（模拟跨 AgentError/RPC 仅传 error.message 到 CLI）仍准确归入 forbidden_model_access
        const fromString = classifyProviderErrorDetail(errEv.error.message);
        expect(fromString.subcode).toBe("forbidden_model_access");
        expect(fromString.sanitizedMessage).not.toContain(bareSecret);
        expect(fromString.userMessage).toContain("无权访问");
      }
    }

    await oa.close?.();
    await gg.close?.();
  });

  it("R2-F1: TCP drop in catch after empty-summary private reasoning/thought marks response interrupted and prevents withRetry replay", async () => {
    const server = await startHttpServer((req, _raw, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (req.url.includes("/responses")) {
        res.write(
          [
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_drop", status: "in_progress" } })}\n\n`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_empty_drop", summary: [] } })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_empty_drop", summary: [], encrypted_content: "enc_empty_drop" } })}\n\n`,
          ].join(""),
        );
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      res.write(
        [
          `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "g_drop", status: "in_progress" } })}\n\n`,
          `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "thought" } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "gsig_empty_drop" } })}\n\n`,
          `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 0 })}\n\n`,
        ].join(""),
      );
      setTimeout(() => res.socket?.destroy(), 20);
    });
    servers.push(server);

    const oa = createProviderFromResolved(
      makeResolved({
        id: "oa-tcp-drop",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-responses",
        apiKey: "bare-tcp-drop-oa",
      }),
    );
    const gg = createProviderFromResolved(
      makeResolved({
        id: "gg-tcp-drop",
        baseUrl: server.baseUrl,
        protocol: "google-interactions",
        apiKey: "bare-tcp-drop-gg",
      }),
    );

    const retryOa = withRetry((req) => oa.chat(req), { maxRetries: 1 });
    const oaEvents = await collect(
      retryOa({ model: "gpt-6.2-astra", messages: [userMessage("hi")] }),
    );
    expect(server.requests.filter((r) => r.url.includes("/responses"))).toHaveLength(1);
    expect(oaEvents.filter((e) => e.type === "thinking_block_end")).toHaveLength(1);
    expect(oaEvents.some((e) => e.type === "message_end")).toBe(false);
    const oaErr = oaEvents.find((e) => e.type === "error");
    expect(oaErr?.type).toBe("error");
    if (oaErr?.type === "error") {
      expect(isResponseStreamInterrupted(oaErr.error)).toBe(true);
      expect(providerRequestNeverSent(oaErr.error)).toBe(false);
    }

    const retryGg = withRetry((req) => gg.chat(req), { maxRetries: 1 });
    const ggEvents = await collect(
      retryGg({ model: "gemini-3.5-pro", messages: [userMessage("hi")] }),
    );
    expect(server.requests.filter((r) => r.url.includes("/interactions"))).toHaveLength(1);
    expect(ggEvents.filter((e) => e.type === "thinking_block_end")).toHaveLength(1);
    expect(ggEvents.some((e) => e.type === "message_end")).toBe(false);
    const ggErr = ggEvents.find((e) => e.type === "error");
    expect(ggErr?.type).toBe("error");
    if (ggErr?.type === "error") {
      expect(isResponseStreamInterrupted(ggErr.error)).toBe(true);
      expect(providerRequestNeverSent(ggErr.error)).toBe(false);
    }

    await oa.close?.();
    await gg.close?.();
  });

  it("R2-F2: rejects oversized native protocolState (>256 KiB) fail-closed instead of silently dropping summary structure", async () => {
    const hugeSummary = "A".repeat(262_208);
    const server = await startHttpServer((req, _raw, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (req.url.includes("/responses")) {
        res.end(
          [
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_huge", summary: [] } })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_huge", summary: [{ type: "summary_text", text: hugeSummary }], encrypted_content: "enc_huge" } })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_huge", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
          ].join(""),
        );
        return;
      }
      res.end(
        [
          `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "g_huge", status: "in_progress" } })}\n\n`,
          `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "thought" } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: hugeSummary } } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "gsig_huge" } })}\n\n`,
          `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 0 })}\n\n`,
          `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: { id: "g_huge", status: "completed", usage: { total_input_tokens: 10, total_output_tokens: 5 } } })}\n\n`,
        ].join(""),
      );
    });
    servers.push(server);

    const oa = createProviderFromResolved(
      makeResolved({
        id: "oa-huge",
        baseUrl: `${server.baseUrl}/v1`,
        protocol: "openai-responses",
        apiKey: "oa-huge-key",
      }),
    );
    const gg = createProviderFromResolved(
      makeResolved({
        id: "gg-huge",
        baseUrl: server.baseUrl,
        protocol: "google-interactions",
        apiKey: "gg-huge-key",
      }),
    );

    for (const [provider, model] of [
      [oa, "gpt-6.2-astra"],
      [gg, "gemini-3.5-pro"],
    ] as const) {
      const retryWrapped = withRetry((req) => provider.chat(req), { maxRetries: 1 });
      const events = await collect(
        retryWrapped({ model, messages: [userMessage("hi")] }),
      );
      expect(events.some((e) => e.type === "thinking_block_end")).toBe(false);
      expect(events.some((e) => e.type === "message_end")).toBe(false);
      const errEv = events.find((e) => e.type === "error");
      expect(errEv?.type).toBe("error");
      if (errEv?.type === "error") {
        expect(isResponseStreamInterrupted(errEv.error)).toBe(true);
        expect(errEv.error.message).toContain("protocol_state_limit_exceeded");
        expect(classifyProviderErrorDetail(errEv.error.message).userMessage).toContain("有界安全上限");
      }
    }

    await oa.close?.();
    await gg.close?.();
  });
});
