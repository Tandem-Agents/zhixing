/**
 * compaction-llm 路由契约测试
 *
 * 两个 helper 按用途分流到不同角色：
 *   - createSummarizeCallLLM  → roles.main.chat  (主对话压缩，质量直接影响下一轮认知)
 *   - createMemoryFlushCallLLM → roles.light.chat (记忆提取，I/O 边界结构化净化)
 *
 * 本文件用 spy LLMRoles 反向验证两条路径互不干扰、每条路径的 ChatRequest 透传正确。
 */

import { describe, expect, it, vi } from "vitest";
import {
  type ChatRequest,
  type LLMProvider,
  type LLMRole,
  type LLMRoles,
  type Message,
  type StreamEvent,
  userMessage,
} from "@zhixing/core";
import {
  createSummarizeCallLLM,
  createMemoryFlushCallLLM,
} from "../compaction-llm.js";

// ─── 测试辅助 ───

interface SpyRole {
  role: LLMRole;
  chat: ReturnType<typeof vi.fn>;
}

/**
 * 构造一个返回固定 text_delta 序列的 spy role。
 * chat fn 是 vi.fn,可断言调用次数 / 参数。
 */
function makeSpyRole(textChunks: string[]): SpyRole {
  const stubProvider = { id: "stub", models: [] } as unknown as LLMProvider;

  const chat = vi.fn(async function* (
    _request: Omit<ChatRequest, "model">,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    yield { type: "message_start" };
    for (const text of textChunks) {
      yield { type: "text_delta", text };
    }
    yield {
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });

  const role: LLMRole = {
    provider: stubProvider,
    model: "stub-model",
    chat: chat as unknown as LLMRole["chat"],
  };

  return { role, chat };
}

function makeSpyRoles(opts: {
  mainChunks?: string[];
  lightChunks?: string[];
}): { roles: LLMRoles; mainChat: SpyRole["chat"]; lightChat: SpyRole["chat"] } {
  const main = makeSpyRole(opts.mainChunks ?? ["MAIN"]);
  const light = makeSpyRole(opts.lightChunks ?? ["LIGHT"]);
  return {
    // power 走兜底（compaction-llm 永不调用 power），复用 light spy 仅为满足 LLMRoles 三键
    roles: { main: main.role, light: light.role, power: light.role },
    mainChat: main.chat,
    lightChat: light.chat,
  };
}

// ─── createSummarizeCallLLM · 主对话压缩走 main ───

describe("createSummarizeCallLLM · 路由契约", () => {
  it("调用走 main，light 永不被调用", async () => {
    const { roles, mainChat, lightChat } = makeSpyRoles({
      mainChunks: ["summarized"],
    });
    const callLLM = createSummarizeCallLLM(roles);

    const result = await callLLM([userMessage("旧历史")]);

    expect(result).toBe("summarized");
    expect(mainChat).toHaveBeenCalledTimes(1);
    expect(lightChat).not.toHaveBeenCalled();
  });

  it("text_delta 多片拼接为完整字符串", async () => {
    const { roles } = makeSpyRoles({
      mainChunks: ["第一段", "第二段", "第三段"],
    });
    const callLLM = createSummarizeCallLLM(roles);

    const result = await callLLM([userMessage("input")]);

    expect(result).toBe("第一段第二段第三段");
  });

  it("空响应直接返回空字符串（caller 自行容错）", async () => {
    const { roles } = makeSpyRoles({ mainChunks: [] });
    const callLLM = createSummarizeCallLLM(roles);

    const result = await callLLM([userMessage("input")]);

    expect(result).toBe("");
  });

  it("abortSignal 透传给 main.chat", async () => {
    const { roles, mainChat } = makeSpyRoles({});
    const callLLM = createSummarizeCallLLM(roles);
    const ac = new AbortController();

    await callLLM([userMessage("input")], { abortSignal: ac.signal });

    const callArg = mainChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.abortSignal).toBe(ac.signal);
  });

  it("ChatRequest 不带 model 字段（由 LLMRole.chat 内部绑定）", async () => {
    const { roles, mainChat } = makeSpyRoles({});
    const callLLM = createSummarizeCallLLM(roles);

    await callLLM([userMessage("input")]);

    const callArg = mainChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg).not.toHaveProperty("model");
    expect(callArg.tools).toEqual([]);
    expect(callArg.messages).toHaveLength(1);
  });

  it("mainThinking 注入时透传给 main.chat", async () => {
    const { roles, mainChat } = makeSpyRoles({});
    const callLLM = createSummarizeCallLLM(roles, { mode: "off" });

    await callLLM([userMessage("input")]);

    const callArg = mainChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.thinking).toEqual({ mode: "off" });
  });

  it("未注入 mainThinking 时 ChatRequest.thinking 为 undefined", async () => {
    const { roles, mainChat } = makeSpyRoles({});
    const callLLM = createSummarizeCallLLM(roles);

    await callLLM([userMessage("input")]);

    const callArg = mainChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.thinking).toBeUndefined();
  });

  it("messages 原样透传，不做改写", async () => {
    const { roles, mainChat } = makeSpyRoles({});
    const callLLM = createSummarizeCallLLM(roles);

    const inputMsgs: Message[] = [userMessage("a"), userMessage("b")];
    await callLLM(inputMsgs);

    const callArg = mainChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.messages).toBe(inputMsgs);
  });
});

// ─── createMemoryFlushCallLLM · 记忆提取走 light ───

describe("createMemoryFlushCallLLM · 路由契约", () => {
  it("调用走 light，main 永不被调用", async () => {
    const { roles, mainChat, lightChat } = makeSpyRoles({
      lightChunks: ["extracted"],
    });
    const callLLM = createMemoryFlushCallLLM(roles);

    const result = await callLLM([userMessage("旧历史")]);

    expect(result).toBe("extracted");
    expect(lightChat).toHaveBeenCalledTimes(1);
    expect(mainChat).not.toHaveBeenCalled();
  });

  it("text_delta 多片拼接为完整字符串", async () => {
    const { roles } = makeSpyRoles({
      lightChunks: ["第一段", "第二段"],
    });
    const callLLM = createMemoryFlushCallLLM(roles);

    const result = await callLLM([userMessage("input")]);

    expect(result).toBe("第一段第二段");
  });

  it("空响应直接返回空字符串（MemoryFlush 经 parseExtractions 自带 try/catch 容错）", async () => {
    const { roles } = makeSpyRoles({ lightChunks: [] });
    const callLLM = createMemoryFlushCallLLM(roles);

    const result = await callLLM([userMessage("input")]);

    expect(result).toBe("");
  });

  it("abortSignal 透传给 light.chat", async () => {
    const { roles, lightChat } = makeSpyRoles({});
    const callLLM = createMemoryFlushCallLLM(roles);
    const ac = new AbortController();

    await callLLM([userMessage("input")], { abortSignal: ac.signal });

    const callArg = lightChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.abortSignal).toBe(ac.signal);
  });

  it("lightThinking 注入时透传给 light.chat", async () => {
    const { roles, lightChat } = makeSpyRoles({});
    const callLLM = createMemoryFlushCallLLM(roles, { mode: "off" });

    await callLLM([userMessage("input")]);

    const callArg = lightChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.thinking).toEqual({ mode: "off" });
  });
});
