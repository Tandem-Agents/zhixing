/**
 * 端到端集成测试
 *
 * 用真实 API 验证：Provider 创建 → LLM 调用 → Agent Loop 连通。
 * 需要环境变量 SILICONFLOW_API_KEY，未设置时自动跳过。
 *
 * 运行方式：
 *   SILICONFLOW_API_KEY=sk-xxx pnpm test -- --testNamePattern integration
 */

import { describe, expect, it } from "vitest";
import { userMessage, extractText, type Message } from "@zhixing/core";
import { drainAgentLoop } from "@zhixing/core/loop";
import { createProvider, createProviderDirect } from "../create-provider.js";

const SF_KEY = process.env["SILICONFLOW_API_KEY"];
const TEST_MODEL = "Pro/MiniMaxAI/MiniMax-M2.5";
const describeWithKey = SF_KEY ? describe : describe.skip;

describeWithKey("integration: 硅基流动 真实 LLM 调用", () => {
  it("createProviderDirect → chat 应返回流式文本响应", async () => {
    const provider = createProviderDirect("siliconflow", {
      apiKey: SF_KEY!,
    });

    const events = [];
    for await (const event of provider.chat({
      model: TEST_MODEL,
      messages: [userMessage("请用一句话回答：1+1等于几？")],
      maxTokens: 50,
    })) {
      events.push(event);
    }

    const startEvent = events.find((e) => e.type === "message_start");
    expect(startEvent).toBeDefined();

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.length).toBeGreaterThan(0);

    const endEvent = events.find((e) => e.type === "message_end");
    expect(endEvent).toBeDefined();
    if (endEvent?.type === "message_end") {
      expect(endEvent.stopReason).toBe("end_turn");
    }
  }, 30_000);

  it("createProvider（从 config 创建） → chat 应正常工作", async () => {
    const provider = createProvider({
      defaultProvider: "siliconflow",
      defaultModel: TEST_MODEL,
      providers: {
        siliconflow: { apiKey: SF_KEY! },
      },
    });

    const events = [];
    for await (const event of provider.chat({
      model: TEST_MODEL,
      messages: [userMessage("请说'你好'")],
      maxTokens: 20,
    })) {
      events.push(event);
    }

    const hasText = events.some((e) => e.type === "text_delta");
    expect(hasText).toBe(true);
  }, 30_000);

  it("Agent Loop + 真实 LLM 应能完成一轮对话", async () => {
    const provider = createProviderDirect("siliconflow", {
      apiKey: SF_KEY!,
    });

    const messages: Message[] = [
      userMessage("请用一个字回答：天空是什么颜色？"),
    ];

    const { result, yields } = await drainAgentLoop({
      provider,
      model: TEST_MODEL,
      messages,
      maxTurns: 1,
      systemPrompt: "你是一个简洁的助手，用最少的字回答。",
    });

    expect(result.reason).toBe("completed");
    if (result.reason === "completed") {
      const text = extractText(result.message);
      expect(text.length).toBeGreaterThan(0);
    }

    const textDeltas = yields.filter((y) => y.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
  }, 30_000);
});
