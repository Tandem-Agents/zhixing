import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../memory-store.js";

describe("MemoryStore", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-memory-test-"));
    store = new MemoryStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── save ───

  describe("save", () => {
    it("保存 profile 记忆", async () => {
      const filePath = await store.save({
        category: "profile",
        id: "profile",
        meta: { name: "张三", language: "zh-CN" },
        content: "## 技术栈\nTypeScript, React",
      });

      expect(filePath).toContain("profile.md");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("name: 张三");
      expect(content).toContain("language: zh-CN");
      expect(content).toContain("## 技术栈");
    });

    it("保存 person 记忆", async () => {
      const filePath = await store.save({
        category: "person",
        id: "wife-xiaoli",
        meta: { name: "小丽", relation: "妻子" },
        content: "喜欢喝咖啡，不喜欢吃辣",
      });

      expect(filePath).toContain(path.join("people", "wife-xiaoli.md"));
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("name: 小丽");
      expect(content).toContain("relation: 妻子");
    });

    it("保存 skill 记忆", async () => {
      const filePath = await store.save({
        category: "skill",
        id: "docker-network-debug",
        meta: {
          title: "Docker 网络调试",
          tags: ["docker", "networking"],
          triggers: ["docker network", "容器连不上"],
          source: "conversation",
          version: 1,
          useCount: 0,
        },
        content: "## 排查步骤\n1. 检查网络模式",
      });

      expect(filePath).toContain(path.join("skills", "docker-network-debug.md"));
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("title: Docker 网络调试");
      expect(content).toContain("tags: [docker, networking]");
    });

    it("覆盖已有记忆", async () => {
      await store.save({
        category: "person",
        id: "friend-bob",
        meta: { name: "Bob" },
        content: "v1",
      });

      await store.save({
        category: "person",
        id: "friend-bob",
        meta: { name: "Bob", relation: "朋友" },
        content: "v2 updated",
      });

      const entry = await store.load("person", "friend-bob");
      expect(entry).not.toBeNull();
      expect(entry!.content).toBe("v2 updated");
      expect(entry!.meta.relation).toBe("朋友");
    });

    it("自动创建目录", async () => {
      await store.save({
        category: "journal",
        id: "2025-06-15",
        meta: { date: "2025-06-15" },
        content: "今天学习了 Docker",
      });

      const dirExists = await fs.stat(path.join(tmpDir, "journal"))
        .then((s) => s.isDirectory())
        .catch(() => false);
      expect(dirExists).toBe(true);
    });
  });

  // ─── load ───

  describe("load", () => {
    it("加载已有记忆", async () => {
      await store.save({
        category: "person",
        id: "test-person",
        meta: { name: "Test", relation: "同事" },
        content: "在 A 公司工作",
      });

      const entry = await store.load("person", "test-person");
      expect(entry).not.toBeNull();
      expect(entry!.category).toBe("person");
      expect(entry!.id).toBe("test-person");
      expect(entry!.meta.name).toBe("Test");
      expect(entry!.meta.relation).toBe("同事");
      expect(entry!.content).toBe("在 A 公司工作");
    });

    it("不存在时返回 null", async () => {
      const entry = await store.load("person", "nonexistent");
      expect(entry).toBeNull();
    });
  });

  // ─── delete ───

  describe("delete", () => {
    it("删除已有记忆", async () => {
      await store.save({
        category: "person",
        id: "to-delete",
        meta: { name: "Deleteme" },
        content: "",
      });

      const result = await store.delete("person", "to-delete");
      expect(result).toBe(true);

      const entry = await store.load("person", "to-delete");
      expect(entry).toBeNull();
    });

    it("不存在时返回 false", async () => {
      const result = await store.delete("person", "nonexistent");
      expect(result).toBe(false);
    });
  });

  // ─── list ───

  describe("list", () => {
    it("列出所有 person 记忆", async () => {
      await store.save({
        category: "person",
        id: "alice",
        meta: { name: "Alice" },
        content: "",
      });
      await store.save({
        category: "person",
        id: "bob",
        meta: { name: "Bob" },
        content: "",
      });

      const entries = await store.list("person");
      expect(entries).toHaveLength(2);

      const names = entries.map((e) => e.meta.name).sort();
      expect(names).toEqual(["Alice", "Bob"]);
    });

    it("目录不存在时返回空数组", async () => {
      const entries = await store.list("skill");
      expect(entries).toEqual([]);
    });

    it("跳过非 .md 文件", async () => {
      const dir = path.join(tmpDir, "people");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "not-markdown.txt"), "ignore me");
      await store.save({
        category: "person",
        id: "valid",
        meta: { name: "Valid" },
        content: "",
      });

      const entries = await store.list("person");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe("valid");
    });
  });

  // ─── search ───

  describe("search", () => {
    beforeEach(async () => {
      await store.save({
        category: "person",
        id: "wife-xiaoli",
        meta: { name: "小丽", relation: "妻子" },
        content: "喜欢咖啡",
      });
      await store.save({
        category: "skill",
        id: "docker-debug",
        meta: { title: "Docker 调试", tags: ["docker"] },
        content: "检查网络模式",
      });
    });

    it("按名字搜索 person", async () => {
      const results = await store.search("小丽");
      expect(results).toHaveLength(1);
      expect(results[0]!.meta.name).toBe("小丽");
    });

    it("按内容搜索", async () => {
      const results = await store.search("咖啡");
      expect(results).toHaveLength(1);
    });

    it("按 title 搜索 skill", async () => {
      const results = await store.search("Docker");
      expect(results).toHaveLength(1);
      expect(results[0]!.meta.title).toBe("Docker 调试");
    });

    it("无结果时返回空数组", async () => {
      const results = await store.search("不存在的东西");
      expect(results).toEqual([]);
    });

    it("搜索不区分大小写", async () => {
      const results = await store.search("docker");
      expect(results).toHaveLength(1);
    });
  });
});
