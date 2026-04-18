import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Message } from "../../types/messages.js";
import type { CompactMarker, Turn } from "../types.js";
import { TranscriptStore, generateTranscriptId, getProjectId } from "../store.js";

// ─── 测试 fixtures ───

const USER_MSG: Message = {
  role: "user",
  content: [{ type: "text", text: "帮我读取 README" }],
};

const ASSISTANT_MSG: Message = {
  role: "assistant",
  content: [{ type: "text", text: "好的，正在读取。" }],
};

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

// ─── 临时目录 & 环境变量 ───

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-store-test-"));
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmpDir;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.ZHIXING_HOME;
  } else {
    process.env.ZHIXING_HOME = originalHome;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── getProjectId ───

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

// ─── generateTranscriptId ───

describe("generateTranscriptId", () => {
  it("格式为 YYYYMMDD-xxxx", () => {
    const id = generateTranscriptId();
    expect(id).toMatch(/^\d{8}-[0-9a-f]{4}$/);
  });

  it("日期前缀是今天", () => {
    const id = generateTranscriptId();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(id.startsWith(today)).toBe(true);
  });
});

// ─── TranscriptStore CRUD ───

describe("TranscriptStore", () => {
  let store: TranscriptStore;

  beforeEach(() => {
    store = new TranscriptStore("/test/project");
  });

  describe("create", () => {
    it("创建转录并返回 header", async () => {
      const header = await store.create({
        model: "deepseek-chat",
        provider: "deepseek",
      });

      expect(header.type).toBe("header");
      expect(header.version).toBe(1);
      expect(header.sessionId).toMatch(/^\d{8}-[0-9a-f]{4}$/);
      expect(header.model).toBe("deepseek-chat");
      expect(header.provider).toBe("deepseek");
      expect(header.name).toBeNull();
    });

    it("支持自定义名称", async () => {
      const header = await store.create({
        name: "重构数据库",
        model: "gpt-4o",
        provider: "openai",
      });

      expect(header.name).toBe("重构数据库");
    });

    it("创建 project.json", async () => {
      await store.create({ model: "test", provider: "test" });

      // path.resolve("/test/project") 在 Windows 上会变为 "E:\test\project"
      const resolvedPath = path.resolve("/test/project");
      const projectDir = path.join(
        tmpDir,
        "projects",
        getProjectId(resolvedPath),
      );
      const meta = JSON.parse(
        await fs.readFile(path.join(projectDir, "project.json"), "utf-8"),
      );
      expect(meta.path).toContain("test");
      expect(meta.createdAt).toBeTruthy();
    });
  });

  describe("appendTurn + load", () => {
    it("追加 turns 后可完整加载", async () => {
      const header = await store.create({
        model: "deepseek-chat",
        provider: "deepseek",
      });

      await store.appendTurn(header.sessionId, makeTurn(0));
      await store.appendTurn(header.sessionId, makeTurn(1));
      await store.appendTurn(header.sessionId, makeTurn(2));

      const loaded = await store.load(header.sessionId);
      expect(loaded.header.sessionId).toBe(header.sessionId);
      expect(loaded.turnCount).toBe(3);
      // 3 turns × 2 messages = 6 messages
      expect(loaded.messages).toHaveLength(6);
      expect(loaded.messages[0].role).toBe("user");
      expect(loaded.messages[1].role).toBe("assistant");
    });

    it("不存在的 session 抛出错误", async () => {
      await expect(
        store.appendTurn("nonexistent", makeTurn(0)),
      ).rejects.toThrow("不存在");
    });
  });

  describe("appendCompact + load（消息重建）", () => {
    it("compact 后只加载近期 turns + 摘要前缀", async () => {
      const header = await store.create({
        model: "deepseek-chat",
        provider: "deepseek",
      });

      const baseTime = Date.now();

      // 3 个 compact 之前的 turns
      for (let i = 0; i < 3; i++) {
        await store.appendTurn(
          header.sessionId,
          makeTurn(i, new Date(baseTime + i * 1000).toISOString()),
        );
      }

      // compact 标记
      const compact: CompactMarker = {
        type: "compact",
        timestamp: new Date(baseTime + 5000).toISOString(),
        summary: "## 核心目标\n用户想读取 README",
        turnsCompacted: 3,
        tokensBefore: 10000,
        tokensAfter: 2000,
      };
      await store.appendCompact(header.sessionId, compact);

      // compact 之后的 2 个 turns
      for (let i = 3; i < 5; i++) {
        await store.appendTurn(
          header.sessionId,
          makeTurn(i, new Date(baseTime + 10000 + i * 1000).toISOString()),
        );
      }

      const loaded = await store.load(header.sessionId);
      // 摘要注入（2 条：user summary + assistant ack） + compact 后的 2 turns × 2 = 6
      expect(loaded.messages).toHaveLength(6);
      // 首条消息包含摘要
      expect(loaded.messages[0].role).toBe("user");
      expect(loaded.messages[0].content[0]).toHaveProperty("text");
      const firstText = (loaded.messages[0].content[0] as { type: "text"; text: string }).text;
      expect(firstText).toContain("对话已压缩");
      expect(firstText).toContain("核心目标");
      // 后续是 compact 后的 turns
      expect(loaded.messages[2].role).toBe("user");
      expect(loaded.messages[3].role).toBe("assistant");
    });
  });

  describe("list", () => {
    it("列出所有转录并按时间倒序", async () => {
      const h1 = await store.create({
        name: "第一个",
        model: "m1",
        provider: "p1",
      });
      // 确保文件修改时间有差异
      await new Promise((r) => setTimeout(r, 50));
      const h2 = await store.create({
        name: "第二个",
        model: "m2",
        provider: "p2",
      });

      const transcripts = await store.list();
      expect(transcripts).toHaveLength(2);
      // 最近的排前面
      expect(transcripts[0].sessionId).toBe(h2.sessionId);
      expect(transcripts[0].name).toBe("第二个");
      expect(transcripts[1].sessionId).toBe(h1.sessionId);
    });

    it("无转录时返回空数组", async () => {
      const transcripts = await store.list();
      expect(transcripts).toHaveLength(0);
    });

    it("包含 turnCount", async () => {
      const h = await store.create({ model: "m", provider: "p" });
      await store.appendTurn(h.sessionId, makeTurn(0));
      await store.appendTurn(h.sessionId, makeTurn(1));

      const transcripts = await store.list();
      expect(transcripts[0].turnCount).toBe(2);
    });
  });

  describe("rename", () => {
    it("更新转录名称", async () => {
      const header = await store.create({
        model: "m",
        provider: "p",
      });

      await store.rename(header.sessionId, "新名称");

      const loaded = await store.load(header.sessionId);
      expect(loaded.header.name).toBe("新名称");
    });
  });

  describe("delete", () => {
    it("删除转录文件", async () => {
      const header = await store.create({ model: "m", provider: "p" });
      await store.delete(header.sessionId);

      const transcripts = await store.list();
      expect(transcripts).toHaveLength(0);
    });

    it("删除不存在的转录抛出错误", async () => {
      await expect(store.delete("nonexistent")).rejects.toThrow();
    });
  });

  describe("findLatest", () => {
    it("返回最近的 session ID", async () => {
      await store.create({ model: "m1", provider: "p1" });
      await new Promise((r) => setTimeout(r, 50));
      const h2 = await store.create({ model: "m2", provider: "p2" });

      const latest = await store.findLatest();
      expect(latest).toBe(h2.sessionId);
    });

    it("无转录时返回 null", async () => {
      const latest = await store.findLatest();
      expect(latest).toBeNull();
    });
  });
});
