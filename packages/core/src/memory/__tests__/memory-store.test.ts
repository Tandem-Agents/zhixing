import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { MemoryStore } from "../memory-store.js";

describe("MemoryStore", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await createTempDir("memory");
    store = new MemoryStore(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("authority takeover", () => {
    it("rejects a configured root that is itself a directory link", async () => {
      const outside = path.join(tmpDir, "outside");
      const configured = path.join(tmpDir, "configured");
      await fs.mkdir(path.join(outside, "people"), { recursive: true });
      await fs.writeFile(path.join(outside, "profile.md"), "outside", "utf-8");
      if (!(await createDirectoryLink(outside, configured))) return;

      await expect(new MemoryStore(configured).readAuthorityTakeoverSnapshot())
        .rejects.toThrow("stable directory");
    });

    it("rejects an owned category root that is itself a directory link", async () => {
      const configured = path.join(tmpDir, "configured");
      const outside = path.join(tmpDir, "outside");
      await fs.mkdir(configured, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      if (!(await createDirectoryLink(outside, path.join(configured, "people")))) return;

      await expect(new MemoryStore(configured).readAuthorityTakeoverSnapshot())
        .rejects.toThrow("stable directory");
    });

    it.each(["scope", "category"] as const)(
      "rejects a %s root replaced while its binding is established",
      async (rootKind) => {
        const configured = path.join(tmpDir, "configured");
        const outside = path.join(tmpDir, "outside");
        const boundRoot = rootKind === "scope"
          ? configured
          : path.join(configured, "people");
        const original = `${boundRoot}-original`;
        await fs.mkdir(boundRoot, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        if (!(await supportsDirectoryLinks(tmpDir, outside))) return;
        const realpath = fs.realpath.bind(fs);
        let replaced = false;
        vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
          if (!replaced && path.resolve(target.toString()) === boundRoot) {
            replaced = true;
            await fs.rename(boundRoot, original);
            await fs.symlink(outside, boundRoot, "junction");
          }
          return realpath(target);
        });

        await expect(new MemoryStore(configured).readAuthorityTakeoverSnapshot())
          .rejects.toThrow("stable directory");
      },
    );

    it("rejects a configured root replaced after binding but before a file read", async () => {
      const configured = path.join(tmpDir, "configured");
      const original = path.join(tmpDir, "configured-original");
      const outside = path.join(tmpDir, "outside");
      const profile = path.join(configured, "profile.md");
      await fs.mkdir(configured, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(profile, "owned", "utf-8");
      await fs.writeFile(path.join(outside, "profile.md"), "outside", "utf-8");
      if (!(await supportsDirectoryLinks(tmpDir, outside))) return;
      const lstat = fs.lstat.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
        if (!replaced && path.resolve(target.toString()) === profile) {
          replaced = true;
          await fs.rename(configured, original);
          await fs.symlink(outside, configured, "junction");
        }
        return lstat(target, options);
      });

      await expect(new MemoryStore(configured).readAuthorityTakeoverSnapshot())
        .rejects.toThrow("owned root changed");
    });

    it("rejects a final file replaced after its handle is opened", async () => {
      const configured = path.join(tmpDir, "configured");
      const profile = path.join(configured, "profile.md");
      const originalProfile = path.join(configured, "profile.original.md");
      await fs.mkdir(configured, { recursive: true });
      await fs.writeFile(profile, "owned", "utf-8");
      const open = fs.open.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
        const handle = await open(target, flags, mode);
        if (!replaced && path.resolve(target.toString()) === profile) {
          replaced = true;
          await fs.rename(profile, originalProfile);
          await fs.writeFile(profile, "replacement", "utf-8");
        }
        return handle;
      });

      await expect(new MemoryStore(configured).readAuthorityTakeoverSnapshot())
        .rejects.toThrow("changed before its owned read");
    });
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

    it.each([
      ["profile", "other"],
      ["person", "../escape"],
      ["person", "CON"],
      ["person", "nested/path"],
      ["journal", "2025-02-29"],
      ["journal", "../escape"],
    ] as const)("在最终 I/O 前拒绝非法 %s/%s 身份", async (category, id) => {
      await expect(store.save({ category, id, meta: {}, content: "blocked" }))
        .rejects.toThrow();
      await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
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

    it("does not acknowledge non-ENOENT deletion failures", async () => {
      const target = path.join(tmpDir, "people", "blocked.md");
      await fs.mkdir(target, { recursive: true });
      await expect(store.delete("person", "blocked")).rejects.toBeDefined();
      await expect(fs.stat(target)).resolves.toBeDefined();
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
      const entries = await store.list("journal");
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
        category: "person",
        id: "docker-mentor",
        meta: { name: "老王" },
        content: "Docker 调试经验丰富",
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

    it("按内容搜索（含 Docker）", async () => {
      const results = await store.search("Docker");
      expect(results).toHaveLength(1);
      expect(results[0]!.meta.name).toBe("老王");
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

async function supportsDirectoryLinks(root: string, target: string): Promise<boolean> {
  const probe = path.join(root, ".junction-probe");
  return createDirectoryLink(target, probe).then(async (created) => {
    if (created) await fs.unlink(probe);
    return created;
  });
}

async function createDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, "junction");
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "EPERM") return false;
    throw error;
  }
}
