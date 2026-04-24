import { describe, expect, it } from "vitest";
import { buildTurn, resolveTurnTimestamp } from "../turn-builder.js";
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
} from "../../types/messages.js";
import type { Message } from "../../types/messages.js";
import type { AgentResult } from "../types.js";
import type { CompactMarker } from "../../transcript/types.js";
import { emptyUsage } from "../../types/llm.js";

// ─── 测试辅助 ───

const FIXED_TIMESTAMP = "2026-04-24T00:00:00.000Z";

function completedResult(): AgentResult {
  return {
    reason: "completed",
    message: assistantMessage("done"),
    usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 150 },
  };
}

function abortedResult(): AgentResult {
  return { reason: "aborted", usage: emptyUsage() };
}

// ─── pure-text 场景 ───

describe("buildTurn — pure-text turn（无工具调用）", () => {
  it("最简场景：单 user + 单 assistant → Turn 无 toolCalls", () => {
    const userMsg = userMessage("你好");
    const assistantMsg = assistantMessage("你好，我是知行");

    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMsg,
      newMessages: [assistantMsg],
      agentResult: completedResult(),
      timestamp: FIXED_TIMESTAMP,
    });

    expect(turn.type).toBe("turn");
    expect(turn.turnIndex).toBe(0);
    expect(turn.timestamp).toBe(FIXED_TIMESTAMP);
    expect(turn.userMessage).toBe(userMsg);
    expect(turn.assistantMessage).toBe(assistantMsg);
    // 无 tool 调用 → 字段应为 undefined（保持 JSONL 紧凑，不写 `"toolCalls":[]`）
    expect(turn.toolCalls).toBeUndefined();
  });

  it("usage 从 agentResult.usage 原样取", () => {
    const agentResult = completedResult();
    const turn = buildTurn({
      turnIndex: 1,
      userMessage: userMessage("x"),
      newMessages: [assistantMessage("y")],
      agentResult,
    });

    expect(turn.usage).toEqual(agentResult.usage);
  });

  it("source 透传（interactive / scheduler / channel）", () => {
    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMessage("x"),
      newMessages: [assistantMessage("y")],
      agentResult: completedResult(),
      source: "scheduler",
    });

    expect(turn.source).toBe("scheduler");
  });

  it("未传 timestamp 时用 new Date() 当前时间（ISO 8601 格式）", () => {
    const beforeMs = Date.now();
    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMessage("x"),
      newMessages: [assistantMessage("y")],
      agentResult: completedResult(),
    });
    const afterMs = Date.now();

    const tsMs = Date.parse(turn.timestamp);
    expect(tsMs).toBeGreaterThanOrEqual(beforeMs);
    expect(tsMs).toBeLessThanOrEqual(afterMs);
  });
});

// ─── tool-loop 场景 ───

describe("buildTurn — tool-loop turn（含工具调用）", () => {
  it("单次 tool_use + tool_result + 总结 assistant → toolCalls 含 1 条完整记录", () => {
    const userMsg = userMessage("读一下 README");
    // assistant 发起 tool_use
    const toolCallMsg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "我来读一下" },
        { type: "tool_use", id: "tc_1", name: "read", input: { path: "README.md" } },
      ],
    };
    // user 消息携带 tool_result
    const toolResultMsg = toolResultMessage([
      { type: "tool_result", toolUseId: "tc_1", content: "# Zhixing\n\n..." },
    ]);
    // 工具链结束后的总结 assistant
    const finalAssistant = assistantMessage("README 是项目主介绍");

    const turn = buildTurn({
      turnIndex: 3,
      userMessage: userMsg,
      newMessages: [toolCallMsg, toolResultMsg, finalAssistant],
      agentResult: completedResult(),
    });

    // assistantMessage 取 newMessages 尾部的最后一条 assistant（总结），
    // 而不是第一条（发 tool_use 的中间态）—— 这是 REPL 旧 bug(newMessages[0]) 的修复
    expect(turn.assistantMessage).toBe(finalAssistant);

    // toolCalls 扁平化持久化：1 条记录
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls![0]).toEqual({
      name: "read",
      input: { path: "README.md" },
      result: "# Zhixing\n\n...",
      isError: undefined,
    });
  });

  it("多次 tool_use 按发生顺序产生 ToolCallRecord[]，与 toolUseId 正确配对", () => {
    const toolUse1: Message = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "grep", input: { pattern: "foo" } },
        { type: "tool_use", id: "b", name: "read", input: { path: "x.ts" } },
      ],
    };
    const toolResults: Message = toolResultMessage([
      // 故意乱序放 result，验证按 id 查 map 而不是按位置
      { type: "tool_result", toolUseId: "b", content: "file content" },
      { type: "tool_result", toolUseId: "a", content: "match1\nmatch2", isError: false },
    ]);
    const finalAssistant = assistantMessage("done");

    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMessage("x"),
      newMessages: [toolUse1, toolResults, finalAssistant],
      agentResult: completedResult(),
    });

    expect(turn.toolCalls).toHaveLength(2);
    // 顺序按 tool_use 发生顺序（不是 result 顺序）
    expect(turn.toolCalls![0]!.name).toBe("grep");
    expect(turn.toolCalls![0]!.result).toBe("match1\nmatch2");
    expect(turn.toolCalls![1]!.name).toBe("read");
    expect(turn.toolCalls![1]!.result).toBe("file content");
  });

  it("isError=true 的 tool_result 原样透传到 ToolCallRecord.isError", () => {
    const toolUse: Message = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "bash", input: {} }],
    };
    const result = toolResultMessage([
      { type: "tool_result", toolUseId: "x", content: "err: not found", isError: true },
    ]);

    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMessage("run"),
      newMessages: [toolUse, result, assistantMessage("ok")],
      agentResult: completedResult(),
    });

    expect(turn.toolCalls![0]!.isError).toBe(true);
    expect(turn.toolCalls![0]!.result).toBe("err: not found");
  });

  it("orphan tool_use（中途 abort 无对应 result）→ ToolCallRecord.result='', isError=undefined", () => {
    // 契约：即便工具未执行完，tool_use 记录仍落盘，便于审计（谁发起了什么）；
    // result 空字符串作占位，isError 不设以区别"失败"和"未完成"
    const toolUse: Message = {
      role: "assistant",
      content: [{ type: "tool_use", id: "orphan", name: "slow-tool", input: { arg: 1 } }],
    };

    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMessage("x"),
      newMessages: [toolUse],
      agentResult: abortedResult(),
    });

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls![0]!.name).toBe("slow-tool");
    expect(turn.toolCalls![0]!.result).toBe("");
    expect(turn.toolCalls![0]!.isError).toBeUndefined();
  });
});

// ─── abort / error 兜底 ───

describe("buildTurn — 异常路径兜底（abort / 无 assistant）", () => {
  it("newMessages 完全为空（abort 前连 LLM 都没开始）→ assistantMessage 兜底空 content", () => {
    const userMsg = userMessage("被 abort 的请求");

    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMsg,
      newMessages: [],
      agentResult: abortedResult(),
    });

    // Turn 结构完整（调用方不需特判 null/undefined）
    expect(turn.type).toBe("turn");
    expect(turn.userMessage).toBe(userMsg);
    expect(turn.assistantMessage.role).toBe("assistant");
    expect(turn.assistantMessage.content).toEqual([]);
    expect(turn.toolCalls).toBeUndefined();
  });

  it("newMessages 只有 tool_use 没有任何 assistant text（罕见 abort 路径）→ assistantMessage 为兜底空 content", () => {
    // 场景：agent-loop 在 LLM 返回含 tool_use 的 message 后被 abort，tool 没执行
    // 但 trackMessages 里 assistant_message 已 push 过
    // 本测验证"完全无 assistant"的极端 case —— 此时兜底生效
    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMessage("x"),
      newMessages: [toolResultMessage([])], // 只有空 tool_result user，无 assistant
      agentResult: abortedResult(),
    });

    expect(turn.assistantMessage.role).toBe("assistant");
    expect(turn.assistantMessage.content).toEqual([]);
  });

  it("aborted usage（通常为 empty）照样进 Turn.usage，调用方自决怎么显示", () => {
    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMessage("x"),
      newMessages: [],
      agentResult: abortedResult(),
    });

    expect(turn.usage).toEqual(emptyUsage());
  });
});

// ─── turnIndex 契约 ───

describe("buildTurn — turnIndex 原样持有（调用方维护 counter）", () => {
  it("turnIndex=0 合法（ephemeral 首轮）", () => {
    const turn = buildTurn({
      turnIndex: 0,
      userMessage: userMessage("x"),
      newMessages: [assistantMessage("y")],
      agentResult: completedResult(),
    });
    expect(turn.turnIndex).toBe(0);
  });

  it("turnIndex=N 原样保留（REPL 长对话 / server 跨进程恢复）", () => {
    const turn = buildTurn({
      turnIndex: 42,
      userMessage: userMessage("x"),
      newMessages: [assistantMessage("y")],
      agentResult: completedResult(),
    });
    expect(turn.turnIndex).toBe(42);
  });
});

// ─── resolveTurnTimestamp: turn.timestamp > compact.timestamp 时序保证 ───
//
// 消灭 rebuild.ts 的 normalize 路径对"同毫秒 turn"的误判。这是 Phase 5 债务 #2 的根治：
// 不改 CompactMarker schema、不改 normalize 的 `<=` 判据，而是在源头协调 timestamp。

describe("resolveTurnTimestamp — compact 时序协调", () => {
  function makeCompact(isoTimestamp: string): CompactMarker {
    return {
      type: "compact",
      timestamp: isoTimestamp,
      summary: "x",
      turnsCompacted: 1,
      tokensBefore: 100,
      tokensAfter: 50,
    };
  }

  it("无 compactBefore：返回标准现时", () => {
    const before = Date.now();
    const ts = resolveTurnTimestamp(undefined);
    const t = Date.parse(ts);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it("compactBefore.timestamp 在过去：返回现时（现时已严格大于 compact）", () => {
    const compact = makeCompact("2020-01-01T00:00:00.000Z");
    const before = Date.now();
    const ts = resolveTurnTimestamp(compact);
    const t = Date.parse(ts);
    // 现时比 2020 远大，无需提升
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeGreaterThan(Date.parse(compact.timestamp));
  });

  it("compactBefore.timestamp 是刚才：返回至少 compact+1ms（严格大于）", () => {
    const now = Date.now();
    // compact 时间戳设为"现时+5ms"（模拟同毫秒或微小时钟漂移）
    const compact = makeCompact(new Date(now + 5).toISOString());
    const ts = resolveTurnTimestamp(compact);
    const t = Date.parse(ts);
    // 关键：turn.timestamp 严格大于 compact.timestamp
    expect(t).toBeGreaterThan(Date.parse(compact.timestamp));
    expect(t).toBe(Date.parse(compact.timestamp) + 1);
  });

  it("compactBefore.timestamp 和现时同一毫秒：turn +1ms（消灭 normalize 误判）", () => {
    const now = Date.now();
    const compact = makeCompact(new Date(now).toISOString());
    const ts = resolveTurnTimestamp(compact);
    const t = Date.parse(ts);
    // rebuild.normalize 判据 `turn.timestamp <= compact.timestamp` 会丢弃 turn —
    // 新 timestamp 严格大于 compact，不会被误判
    expect(t).toBeGreaterThan(Date.parse(compact.timestamp));
  });

  it("compactBefore.timestamp 非法（无法 parse）：退化到现时", () => {
    const compact = makeCompact("not-a-date");
    const before = Date.now();
    const ts = resolveTurnTimestamp(compact);
    const t = Date.parse(ts);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
