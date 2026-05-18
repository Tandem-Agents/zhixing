/**
 * compaction-llm 路由契约测试
 *
 * spec 承诺:上下文压缩 / I/O 边界净化的 LLM 调用走 light 角色,不消耗主对话
 * 成本(light-llm-capability.md)。本文件用 spy LLMRoles 反向验证:
 *   - light.chat 被调用一次
 *   - main.chat 永远不被调用
 *   - text_delta 拼接正确
 *   - abortSignal 透传
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
import { createCompactionFlush } from "../compaction-llm.js";

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
  const light = makeSpyRole(opts.lightChunks ?? ["SEC"]);
  return {
    // power 走兜底（compaction 永不调用 power），复用 light spy 仅为满足 LLMRoles 三键
    roles: { main: main.role, light: light.role, power: light.role },
    mainChat: main.chat,
    lightChat: light.chat,
  };
}

// ─── 测试 ───

describe("createCompactionFlush · 路由契约", () => {
  it("调用走 light，main 永不被调用", async () => {
    const { roles, mainChat, lightChat } = makeSpyRoles({
      lightChunks: ["compacted"],
    });
    const flush = createCompactionFlush(roles);

    const result = await flush([userMessage("旧历史")]);

    expect(result).toBe("compacted");
    expect(lightChat).toHaveBeenCalledTimes(1);
    expect(mainChat).not.toHaveBeenCalled();
  });

  it("text_delta 多片拼接为完整字符串", async () => {
    const { roles } = makeSpyRoles({
      lightChunks: ["第一段", "第二段", "第三段"],
    });
    const flush = createCompactionFlush(roles);

    const result = await flush([userMessage("input")]);

    expect(result).toBe("第一段第二段第三段");
  });

  it("空响应回退为 \"[]\"——给 JSON parse 路径安全兜底", async () => {
    const { roles } = makeSpyRoles({ lightChunks: [] });
    const flush = createCompactionFlush(roles);

    const result = await flush([userMessage("input")]);

    expect(result).toBe("[]");
  });

  it("abortSignal 透传给 light.chat", async () => {
    const { roles, lightChat } = makeSpyRoles({});
    const flush = createCompactionFlush(roles);
    const ac = new AbortController();

    await flush([userMessage("input")], { abortSignal: ac.signal });

    const callArg = lightChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.abortSignal).toBe(ac.signal);
  });

  it("ChatRequest 不带 model 字段（由 LLMRole.chat 内部绑定）", async () => {
    const { roles, lightChat } = makeSpyRoles({});
    const flush = createCompactionFlush(roles);

    await flush([userMessage("input")]);

    const callArg = lightChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg).not.toHaveProperty("model");
    expect(callArg.tools).toEqual([]);
    expect(callArg.messages).toHaveLength(1);
  });

  it("lightThinking 注入时透传给 light.chat", async () => {
    const { roles, lightChat } = makeSpyRoles({});
    const flush = createCompactionFlush(roles, { mode: "off" });

    await flush([userMessage("input")]);

    const callArg = lightChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.thinking).toEqual({ mode: "off" });
  });

  it("未注入 lightThinking 时 ChatRequest.thinking 为 undefined", async () => {
    const { roles, lightChat } = makeSpyRoles({});
    const flush = createCompactionFlush(roles);

    await flush([userMessage("input")]);

    const callArg = lightChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.thinking).toBeUndefined();
  });

  it("messages 原样透传，不做改写", async () => {
    const { roles, lightChat } = makeSpyRoles({});
    const flush = createCompactionFlush(roles);

    const inputMsgs: Message[] = [
      userMessage("a"),
      userMessage("b"),
    ];
    await flush(inputMsgs);

    const callArg = lightChat.mock.calls[0]![0] as Omit<ChatRequest, "model">;
    expect(callArg.messages).toBe(inputMsgs);
  });
});
