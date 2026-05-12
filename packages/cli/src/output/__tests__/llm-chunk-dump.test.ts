import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createEventBus,
  type AgentEventMap,
  type IEventBus,
} from "@zhixing/core";
import {
  attachChunkDumpToBus,
  configureLlmChunkDump,
  getLlmChunkDump,
  __resetForTesting,
} from "../llm-chunk-dump.js";

const LOG_DIR = path.join(os.homedir(), ".zhixing", "logs");

describe("LLM chunk dump · 默认禁用（未 configure / configure false）", () => {
  beforeEach(() => {
    __resetForTesting();
  });
  afterEach(() => {
    __resetForTesting();
  });

  it("未 configure 时返回 noop handle —— 调用 record 不写文件不抛错", () => {
    const dump = getLlmChunkDump();
    expect(() => {
      dump.recordStreamEvent({ type: "text_delta", text: "hello" });
      dump.recordStreamEvent({
        type: "tool_call_delta",
        id: "tc1",
        argsFragment: '{"foo":"bar"}',
      });
      dump.recordTurnBoundary();
      dump.dispose();
    }).not.toThrow();
  });

  it("configure(false) 显式禁用同样走 noop 路径", () => {
    configureLlmChunkDump(false);
    const dump = getLlmChunkDump();
    expect(() => {
      dump.recordStreamEvent({ type: "text_delta", text: "x" });
    }).not.toThrow();
  });

  it("attachChunkDumpToBus noop 时仍正确订阅 + cleanup 不抛错", () => {
    const bus: IEventBus<AgentEventMap> = createEventBus();
    const detach = attachChunkDumpToBus(bus);
    expect(() => detach()).not.toThrow();
  });

  it("多次 getLlmChunkDump 返回同一 handle —— singleton 语义", () => {
    const a = getLlmChunkDump();
    const b = getLlmChunkDump();
    expect(a).toBe(b);
  });
});

describe("LLM chunk dump · 启用（configure(true)）", () => {
  let logsBefore: string[] = [];

  beforeEach(() => {
    __resetForTesting();
    configureLlmChunkDump(true);
    try {
      logsBefore = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : [];
    } catch {
      logsBefore = [];
    }
  });
  afterEach(() => {
    __resetForTesting();
    try {
      const after = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : [];
      for (const name of after) {
        if (logsBefore.includes(name)) continue;
        if (!name.startsWith("llm-raw-")) continue;
        try {
          fs.unlinkSync(path.join(LOG_DIR, name));
        } catch {
          /* swallow */
        }
      }
    } catch {
      /* swallow */
    }
  });

  function findNewLog(): string | null {
    try {
      const after = fs.readdirSync(LOG_DIR);
      const fresh = after.filter(
        (n) => n.startsWith("llm-raw-") && !logsBefore.includes(n),
      );
      if (fresh.length === 0) return null;
      fresh.sort();
      return path.join(LOG_DIR, fresh[fresh.length - 1]!);
    } catch {
      return null;
    }
  }

  function readLogSync(p: string): string {
    return fs.readFileSync(p, "utf-8");
  }

  it("启用时创建日志文件并写启动横幅", () => {
    const dump = getLlmChunkDump();
    dump.dispose();
    const logPath = findNewLog();
    expect(logPath).not.toBeNull();
    const content = readLogSync(logPath!);
    expect(content).toContain("# LLM raw dump");
    expect(content).toContain(`pid ${process.pid}`);
  });

  it("text_delta 写完整 raw + codepoint hex —— 含不可见字符也保留", () => {
    const dump = getLlmChunkDump();
    const sample = "你好☀️‎﻿\n";
    dump.recordStreamEvent({ type: "text_delta", text: sample });
    dump.dispose();
    const content = readLogSync(findNewLog()!);
    expect(content).toContain(`raw: ${JSON.stringify(sample)}`);
    expect(content).toContain("U+4F60"); // 你
    expect(content).toContain("U+200E"); // LRM
    expect(content).toContain("U+FEFF"); // BOM
    expect(content).toContain("U+000A"); // \n
  });

  it("thinking_delta / tool_call_delta 都被记录，结构事件也被简短记录", () => {
    const dump = getLlmChunkDump();
    dump.recordStreamEvent({ type: "message_start", messageId: "m1" });
    dump.recordStreamEvent({
      type: "thinking_delta",
      thinking: "AI thinking",
    });
    dump.recordStreamEvent({
      type: "tool_call_start",
      id: "tc1",
      name: "Read",
    });
    dump.recordStreamEvent({
      type: "tool_call_delta",
      id: "tc1",
      argsFragment: '{"path":"a.ts"}',
    });
    dump.recordStreamEvent({ type: "tool_call_end", id: "tc1" });
    dump.recordStreamEvent({
      type: "message_end",
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    dump.dispose();
    const content = readLogSync(findNewLog()!);
    expect(content).toContain("thinking_delta");
    expect(content).toContain('raw: "AI thinking"');
    expect(content).toContain("message_start");
    expect(content).toContain("tool_call_start (id=tc1, name=Read)");
    expect(content).toContain("tool_call_delta");
    expect(content).toContain('args: "{\\"path\\":\\"a.ts\\"}"');
    expect(content).toContain("tool_call_end (id=tc1)");
    expect(content).toContain("message_end");
  });

  it("recordTurnBoundary 写分隔标记 + 重置时间戳", () => {
    const dump = getLlmChunkDump();
    dump.recordStreamEvent({ type: "text_delta", text: "turn 1 chunk" });
    dump.recordTurnBoundary();
    dump.recordStreamEvent({ type: "text_delta", text: "turn 2 chunk" });
    dump.dispose();
    const content = readLogSync(findNewLog()!);
    expect(content).toContain("=== TURN 1");
    expect(content).toContain("--- end of TURN 1 ---");
    expect(content).toContain("=== TURN 2");
    expect(content).toContain("turn 1 chunk");
    expect(content).toContain("turn 2 chunk");
  });

  it("attachChunkDumpToBus 转发 EventBus llm:stream_event 与 agent:run_end", async () => {
    const bus: IEventBus<AgentEventMap> = createEventBus();
    const detach = attachChunkDumpToBus(bus);

    await bus.emit("llm:stream_event", {
      type: "text_delta",
      text: "hello via bus",
    });
    await bus.emit("llm:stream_event", {
      type: "tool_call_delta",
      id: "tc1",
      argsFragment: "{",
    });
    await bus.emit("agent:run_end", {
      reason: "completed",
      duration: 100,
      turnCount: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await bus.emit("llm:stream_event", {
      type: "text_delta",
      text: "second turn",
    });

    detach();
    getLlmChunkDump().dispose();
    const content = readLogSync(findNewLog()!);
    expect(content).toContain('raw: "hello via bus"');
    expect(content).toContain("tool_call_delta");
    expect(content).toContain("--- end of TURN 1 ---");
    expect(content).toContain("=== TURN 2");
    expect(content).toContain('raw: "second turn"');
  });

  it("recordRequestPayload 写完整入参——含 system / messages 摘要 + 完整 JSON", () => {
    const dump = getLlmChunkDump();
    dump.recordRequestPayload({
      model: "test/m1",
      systemPrompt: "you are an assistant",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            {
              type: "tool_use",
              id: "tc1",
              name: "Read",
              input: { path: "a.ts" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "Read",
          description: "read a file",
          inputSchema: { type: "object" },
        } as never,
      ],
    });
    dump.dispose();
    const content = readLogSync(findNewLog()!);
    // 顶部摘要
    expect(content).toContain(">>> LLM REQUEST PAYLOAD <<<");
    expect(content).toContain("model:    test/m1");
    expect(content).toContain("system:   20 chars");
    expect(content).toContain("messages: 2 entries");
    expect(content).toContain("user");
    expect(content).toContain("assistant");
    expect(content).toContain("text(5c)"); // hello
    expect(content).toContain("tool_use(Read#tc1)");
    expect(content).toContain("tools:    1 (Read)");
    // 完整 JSON 块
    expect(content).toContain("--- full payload (JSON) ---");
    expect(content).toContain('"model": "test/m1"');
    expect(content).toContain('"systemPrompt": "you are an assistant"');
    expect(content).toContain("--- end payload ---");
  });

  it("attachChunkDumpToBus 订阅 llm:request_start 并转发到 recordRequestPayload", async () => {
    const bus: IEventBus<AgentEventMap> = createEventBus();
    const detach = attachChunkDumpToBus(bus);

    await bus.emit("llm:request_start", {
      model: "test/m1",
      messageCount: 1,
      hasTools: false,
      systemPrompt: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
      tools: [],
    });

    detach();
    getLlmChunkDump().dispose();
    const content = readLogSync(findNewLog()!);
    expect(content).toContain(">>> LLM REQUEST PAYLOAD <<<");
    expect(content).toContain("model:    test/m1");
    expect(content).toContain("system:   3 chars");
  });
});
