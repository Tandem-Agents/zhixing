import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getLlmChunkDump, __resetForTesting } from "../llm-chunk-dump.js";

const LOG_DIR = path.join(os.homedir(), ".zhixing", "logs");

describe("LLM chunk dump · 默认禁用（无 ZHIXING_RAW_DUMP env）", () => {
  beforeEach(() => {
    __resetForTesting();
    delete process.env["ZHIXING_RAW_DUMP"];
  });
  afterEach(() => {
    __resetForTesting();
  });

  it("env var 未启用时返回 noop handle —— 调用 record/dispose 不写文件不抛错", () => {
    const dump = getLlmChunkDump();
    expect(() => {
      dump.recordChunk("text_delta", "hello");
      dump.recordChunk("thinking_delta", "world");
      dump.recordTurnBoundary();
      dump.dispose();
    }).not.toThrow();
  });

  it("多次 getLlmChunkDump 返回同一 handle —— singleton 语义", () => {
    const a = getLlmChunkDump();
    const b = getLlmChunkDump();
    expect(a).toBe(b);
  });
});

describe("LLM chunk dump · 启用（ZHIXING_RAW_DUMP=1）", () => {
  let logsBefore: string[] = [];

  beforeEach(() => {
    __resetForTesting();
    process.env["ZHIXING_RAW_DUMP"] = "1";
    // 记录测试启动前 logs/ 目录下的现有文件，方便比对新建的
    try {
      logsBefore = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : [];
    } catch {
      logsBefore = [];
    }
  });
  afterEach(() => {
    __resetForTesting();
    delete process.env["ZHIXING_RAW_DUMP"];
    // 清理本测试创建的新日志（不动其他文件）
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
      // 取最新一个（按文件名排序，时间戳后）
      fresh.sort();
      return path.join(LOG_DIR, fresh[fresh.length - 1]!);
    } catch {
      return null;
    }
  }

  function readLogSync(p: string): string {
    // 关闭 stream 后文件应已 flush；test 内调 dispose 触发
    return fs.readFileSync(p, "utf-8");
  }

  it("启用时创建日志文件并写启动横幅 + 路径提示走 stderr", () => {
    const dump = getLlmChunkDump();
    dump.dispose();
    const logPath = findNewLog();
    expect(logPath).not.toBeNull();
    const content = readLogSync(logPath!);
    expect(content).toContain("# LLM raw chunk dump");
    expect(content).toContain(`pid ${process.pid}`);
  });

  it("recordChunk 写入完整 raw + codepoint hex —— 含不可见字符也保留", () => {
    const dump = getLlmChunkDump();
    // emoji ☀️ 是 U+2600 + U+FE0F (VS16); BOM 是 U+FEFF; LRM 是 U+200E
    const sample = "你好☀️‎﻿\n";
    dump.recordChunk("text_delta", sample);
    dump.dispose();
    const logPath = findNewLog();
    const content = readLogSync(logPath!);
    // raw 字段用 JSON.stringify 编码——控制字符（\n）转义，其它字符（含 LRM/BOM）字面保留
    expect(content).toContain(`raw: ${JSON.stringify(sample)}`);
    // codepoint 字段含每个字符的 U+ 形式——这是诊断不可见字符的关键
    expect(content).toContain("U+4F60"); // 你
    expect(content).toContain("U+597D"); // 好
    expect(content).toContain("U+2600"); // ☀
    expect(content).toContain("U+FE0F"); // VS16
    expect(content).toContain("U+200E"); // LRM
    expect(content).toContain("U+FEFF"); // BOM
    expect(content).toContain("U+000A"); // \n
  });

  it("text_delta / thinking_delta 都被记录，标注 kind", () => {
    const dump = getLlmChunkDump();
    dump.recordChunk("text_delta", "AI text");
    dump.recordChunk("thinking_delta", "AI thinking");
    dump.dispose();
    const content = readLogSync(findNewLog()!);
    expect(content).toContain("text_delta");
    expect(content).toContain("thinking_delta");
    expect(content).toContain('raw: "AI text"');
    expect(content).toContain('raw: "AI thinking"');
  });

  it("recordTurnBoundary 在 turn 之间写分隔标记 + 重置时间戳", () => {
    const dump = getLlmChunkDump();
    dump.recordChunk("text_delta", "turn 1 chunk");
    dump.recordTurnBoundary();
    dump.recordChunk("text_delta", "turn 2 chunk");
    dump.dispose();
    const content = readLogSync(findNewLog()!);
    expect(content).toContain("=== TURN 1");
    expect(content).toContain("--- end of TURN 1 ---");
    expect(content).toContain("=== TURN 2");
    expect(content).toContain("turn 1 chunk");
    expect(content).toContain("turn 2 chunk");
  });

  it("turn 内无 chunk 时 recordTurnBoundary 不写 end 标记 —— 避免空 turn 噪音", () => {
    const dump = getLlmChunkDump();
    dump.recordTurnBoundary(); // 还没有任何 chunk
    dump.recordTurnBoundary();
    dump.recordChunk("text_delta", "first real chunk");
    dump.dispose();
    const content = readLogSync(findNewLog()!);
    expect(content).not.toContain("--- end of TURN 1 ---");
    // 第一个真实 chunk 应在 TURN 3 开始（前 2 次 boundary 推进了 turnIndex）
    expect(content).toContain("=== TURN 3");
  });
});
