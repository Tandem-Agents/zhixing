import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  createEventBus,
  getZhixingHome,
  type AgentEventMap,
  type IEventBus,
} from "@zhixing/core";
import { createDescribeTempDir, createTempDir } from "@zhixing/test-utils";
import {
  attachChunkDumpToBus,
  configureLlmChunkDump,
  getLlmChunkDump,
  pruneAllLogs,
  __resetForTesting,
  __pruneLogDirForTesting,
} from "../llm-chunk-dump.js";

// raw dump 落到 <ZHIXING_HOME>/logs/llm-raw/ 子目录(详见 llm-chunk-dump.ts
// 顶部"日志目录布局与轮转"section)。动态读 ZHIXING_HOME —— "启用"测试组会
// 切到 createDescribeTempDir 临时目录,避免测试期 prune 误删用户真实日志。
function logDir(): string {
  return path.join(getZhixingHome(), "logs", "llm-raw");
}

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
  // 切 ZHIXING_HOME 到 describe-scope 临时目录 —— createDump 路径基于
  // getZhixingHome() 派生,本组测试就在隔离根下跑(避免 prune 误删用户真实日志,
  // 也避免测试间产物互相残留)。
  const tempHome = createDescribeTempDir("llm-chunk-dump");
  let originalHome: string | undefined;
  let logsBefore: string[] = [];

  beforeEach(() => {
    __resetForTesting();
    originalHome = process.env.ZHIXING_HOME;
    process.env.ZHIXING_HOME = tempHome.getDir();
    configureLlmChunkDump(true);
    try {
      logsBefore = fs.existsSync(logDir()) ? fs.readdirSync(logDir()) : [];
    } catch {
      logsBefore = [];
    }
  });
  afterEach(() => {
    __resetForTesting();
    try {
      const after = fs.existsSync(logDir()) ? fs.readdirSync(logDir()) : [];
      for (const name of after) {
        if (logsBefore.includes(name)) continue;
        if (!name.startsWith("llm-raw-")) continue;
        try {
          fs.unlinkSync(path.join(logDir(), name));
        } catch {
          /* swallow */
        }
      }
    } catch {
      /* swallow */
    }
    if (originalHome === undefined) delete process.env.ZHIXING_HOME;
    else process.env.ZHIXING_HOME = originalHome;
  });

  function findNewLog(): string | null {
    try {
      const after = fs.readdirSync(logDir());
      const fresh = after.filter(
        (n) => n.startsWith("llm-raw-") && !logsBefore.includes(n),
      );
      if (fresh.length === 0) return null;
      fresh.sort();
      return path.join(logDir(), fresh[fresh.length - 1]!);
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

describe("LLM chunk dump · 日志目录轮转 (prune-to-N)", () => {
  // 用临时目录隔离测试,不污染真实 ~/.zhixing/logs/

  it("目录文件 <= keep 时 prune 不动任何文件", async () => {
    const dir = await createTempDir("llm-chunk-dump-prune");
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.log`), `content ${i}`);
    }
    __pruneLogDirForTesting(dir, 7);
    expect(fs.readdirSync(dir).sort()).toEqual(
      ["f0.log", "f1.log", "f2.log", "f3.log", "f4.log"].sort(),
    );
  });

  it("目录文件 > keep 时按 mtime 倒序保留最新 N 个", async () => {
    const dir = await createTempDir("llm-chunk-dump-prune");
    // 写 10 个文件,人为拉开 mtime 顺序:文件 i 的 mtime = 基准时间 + i 秒
    const base = Date.now() - 10_000;
    for (let i = 0; i < 10; i++) {
      const p = path.join(dir, `f${i}.log`);
      fs.writeFileSync(p, `content ${i}`);
      const t = new Date(base + i * 1000);
      fs.utimesSync(p, t, t);
    }

    __pruneLogDirForTesting(dir, 7);

    // 应保留 mtime 最新的 7 个 = f3..f9;淘汰 f0/f1/f2
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toEqual(["f3.log", "f4.log", "f5.log", "f6.log", "f7.log", "f8.log", "f9.log"]);
  });

  it("目录不存在时 prune swallow 不抛错", () => {
    expect(() => {
      __pruneLogDirForTesting(path.join(getZhixingHome(), "logs", "non-existent-xxxx"), 7);
    }).not.toThrow();
  });

  it("keep=0 时清空目录所有文件", async () => {
    const dir = await createTempDir("llm-chunk-dump-prune");
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.log`), `x`);
    }
    __pruneLogDirForTesting(dir, 0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("LLM chunk dump · 守门 (启动巡检 + 写盘失败 fail-safe)", () => {
  // ZHIXING_HOME 切到 describe-scope 临时目录,让 forensicDir / rawDumpDir 指向
  // 隔离根。守门测试两条契约:
  //   1. pruneAllLogs 巡检两个子目录(进程间累积 / 冷目录覆盖)
  //   2. forensic 写盘失败时 prune 仍然跑(锁死"prune 在 try/catch 外"的结构性
  //      保证 —— 防止未来有人不知情把 prune 挪回 try 块内绕过守门)
  const tempHome = createDescribeTempDir("llm-chunk-dump-guard");
  let originalHome: string | undefined;

  beforeEach(() => {
    __resetForTesting();
    originalHome = process.env.ZHIXING_HOME;
    process.env.ZHIXING_HOME = tempHome.getDir();
    // describe-scope tempHome 跨 it 共享,每个 it 前清空 logs/ 子目录,
    // 避免前一个 test 的 seed 文件污染当前 test 断言
    const logsDir = path.join(tempHome.getDir(), "logs");
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
  afterEach(() => {
    __resetForTesting();
    if (originalHome === undefined) delete process.env.ZHIXING_HOME;
    else process.env.ZHIXING_HOME = originalHome;
  });

  function seedDir(dir: string, count: number): void {
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.now() - count * 1000;
    for (let i = 0; i < count; i++) {
      const p = path.join(dir, `seed-${i}.log`);
      fs.writeFileSync(p, "seed");
      const t = new Date(base + i * 1000);
      fs.utimesSync(p, t, t);
    }
  }

  it("pruneAllLogs 同时巡检 llm-raw/ 与 llm-error/ 子目录,各裁剪到 7", () => {
    const rawDir = path.join(tempHome.getDir(), "logs", "llm-raw");
    const errDir = path.join(tempHome.getDir(), "logs", "llm-error");
    seedDir(rawDir, 10);
    seedDir(errDir, 12);

    pruneAllLogs();

    expect(fs.readdirSync(rawDir)).toHaveLength(7);
    expect(fs.readdirSync(errDir)).toHaveLength(7);
  });

  it("pruneAllLogs 在目录不存在时 swallow,不抛错", () => {
    // tempHome 下当前没有 logs/ 子目录,pruneAllLogs 应 swallow 不抛错
    expect(() => pruneAllLogs()).not.toThrow();
  });

  it("forensic 写盘失败时 prune 仍然跑(写盘失败不绕过守门)", async () => {
    // 预放 8 个老文件到 forensic 目录,模拟"已有累积"
    const errDir = path.join(tempHome.getDir(), "logs", "llm-error");
    seedDir(errDir, 8);
    expect(fs.readdirSync(errDir)).toHaveLength(8);

    // Mock writeFileSync 抛错(模拟磁盘满 / 权限不足 / 等 IO 失败)
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated IO failure");
    });

    try {
      // 触发 writeLlmErrorForensic —— attachChunkDumpToBus 在 agent:run_end
      // reason="error" 时强制调
      const bus = createEventBus<AgentEventMap>();
      const detach = attachChunkDumpToBus(bus);
      await bus.emit("agent:run_end", {
        reason: "error",
        error: "test",
        errorType: "provider_error",
        duration: 0,
        turnCount: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      detach();
    } finally {
      spy.mockRestore();
    }

    // 关键断言:writeFileSync 抛错 → 新 forensic 文件没落地,但 prune 仍跑过
    // → 8 个老文件被裁剪到 7 个。若 prune 被写盘失败绕过,这里会断言失败,
    // 测试锁死"prune 在 try/catch 外"的结构性保证。
    expect(fs.readdirSync(errDir)).toHaveLength(7);
  });
});
