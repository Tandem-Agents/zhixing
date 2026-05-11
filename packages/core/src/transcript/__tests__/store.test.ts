import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { CompactMarker, Turn } from "../types.js";
import { TranscriptStore } from "../store.js";
import { getProjectId } from "../../paths.js";
import { detectSystemMetaKind } from "../../context/system-meta.js";

// ─── 测试 fixtures ───

function makeTurn(index: number, timestamp?: string): Turn {
  return {
    type: "turn",
    turnIndex: index,
    timestamp: timestamp ?? new Date(Date.now() + index * 1000).toISOString(),
    userMessage: {
      role: "user",
      content: [{ type: "text", text: `用户消息 ${index}` }],
    },
    assistantMessage: {
      role: "assistant",
      content: [{ type: "text", text: `助手回复 ${index}` }],
    },
    usage: { inputTokens: 100 + index, outputTokens: 50 + index },
  };
}

// ─── 临时目录 ───

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTempDir("transcript-store");
});

// ─── getProjectId（共享路径工具） ───

describe("getProjectId", () => {
  it("相同路径生成相同 ID", () => {
    const id1 = getProjectId("E:\\Dev\\longxia\\zhixing");
    const id2 = getProjectId("E:\\Dev\\longxia\\zhixing");
    expect(id1).toBe(id2);
  });

  it("路径归一化：正斜杠和反斜杠生成相同 ID", () => {
    const id1 = getProjectId("E:\\Dev\\longxia\\zhixing");
    const id2 = getProjectId("E:/Dev/longxia/zhixing");
    expect(id1).toBe(id2);
  });

  it("大小写不敏感", () => {
    const id1 = getProjectId("E:\\Dev\\Longxia\\Zhixing");
    const id2 = getProjectId("e:\\dev\\longxia\\zhixing");
    expect(id1).toBe(id2);
  });

  it("生成 12 位 hex", () => {
    const id = getProjectId("/some/path");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});

// ─── TranscriptStore ───

describe("TranscriptStore", () => {
  let convDir: string;
  let store: TranscriptStore;

  beforeEach(() => {
    convDir = path.join(tmpDir, "conversations");
    store = new TranscriptStore(convDir, "/test/project");
  });

  describe("init", () => {
    it("初始化 transcript 文件", async () => {
      await store.init("test-conv", {
        model: "deepseek-chat",
        provider: "deepseek",
      });

      const file = path.join(convDir, "test-conv", "transcript.jsonl");
      const stat = await fs.stat(file);
      expect(stat.isFile()).toBe(true);
    });

    it("写入正确的 header", async () => {
      await store.init("test-conv", {
        model: "deepseek-chat",
        provider: "deepseek",
      });

      const loaded = await store.load("test-conv");
      expect(loaded.header.type).toBe("header");
      expect(loaded.header.version).toBe(1);
      expect(loaded.header.conversationId).toBe("test-conv");
      expect(loaded.header.model).toBe("deepseek-chat");
      expect(loaded.header.provider).toBe("deepseek");
      expect(loaded.header.name).toBeNull();
    });
  });

  describe("appendTurn + load", () => {
    it("追加 turns 后可完整加载", async () => {
      await store.init("turn-test", { model: "deepseek-chat", provider: "deepseek" });

      await store.appendTurn("turn-test", makeTurn(0));
      await store.appendTurn("turn-test", makeTurn(1));
      await store.appendTurn("turn-test", makeTurn(2));

      const loaded = await store.load("turn-test");
      expect(loaded.header.conversationId).toBe("turn-test");
      expect(loaded.turnCount).toBe(3);
      expect(loaded.messages).toHaveLength(6);
      expect(loaded.messages[0].role).toBe("user");
      expect(loaded.messages[1].role).toBe("assistant");
    });

    it("不存在的 conversation 抛出错误", async () => {
      await expect(
        store.appendTurn("nonexistent", makeTurn(0)),
      ).rejects.toThrow("不存在");
    });
  });

  describe("appendCompact + load（消息重建）", () => {
    it("compact 后只加载近期 turns + 摘要前缀", async () => {
      await store.init("compact-test", { model: "deepseek-chat", provider: "deepseek" });

      const baseTime = Date.now();

      for (let i = 0; i < 3; i++) {
        await store.appendTurn(
          "compact-test",
          makeTurn(i, new Date(baseTime + i * 1000).toISOString()),
        );
      }

      const compact: CompactMarker = {
        type: "compact",
        timestamp: new Date(baseTime + 5000).toISOString(),
        summary: "## 核心目标\n用户想读取 README",
        turnsCompacted: 3,
        tokensBefore: 10000,
        tokensAfter: 2000,
      };
      await store.appendCompact("compact-test", compact);

      for (let i = 3; i < 5; i++) {
        await store.appendTurn(
          "compact-test",
          makeTurn(i, new Date(baseTime + 10000 + i * 1000).toISOString()),
        );
      }

      const loaded = await store.load("compact-test");
      expect(loaded.messages).toHaveLength(6);
      expect(loaded.messages[0].role).toBe("user");
      // 占位符是 system-meta compact-summary（结构化断言）
      expect(detectSystemMetaKind(loaded.messages[0])).toBe("compact-summary");
      // summary 内容保留（"核心目标" 来自 makeTurn 生成的 compact summary）
      const firstText = (loaded.messages[0].content[0] as { type: "text"; text: string }).text;
      expect(firstText).toContain("核心目标");
    });
  });

  describe("countTurns", () => {
    it("正确统计 turn 数量", async () => {
      await store.init("count-test", { model: "m", provider: "p" });
      await store.appendTurn("count-test", makeTurn(0));
      await store.appendTurn("count-test", makeTurn(1));

      const count = await store.countTurns("count-test");
      expect(count).toBe(2);
    });

    it("无 turn 时返回 0", async () => {
      await store.init("empty", { model: "m", provider: "p" });
      const count = await store.countTurns("empty");
      expect(count).toBe(0);
    });

    it("文件不存在返回 0", async () => {
      const count = await store.countTurns("nonexistent");
      expect(count).toBe(0);
    });
  });

  describe("exists", () => {
    it("初始化后返回 true", async () => {
      await store.init("ex", { model: "m", provider: "p" });
      expect(await store.exists("ex")).toBe(true);
    });

    it("不存在时返回 false", async () => {
      expect(await store.exists("nonexistent")).toBe(false);
    });
  });

});
