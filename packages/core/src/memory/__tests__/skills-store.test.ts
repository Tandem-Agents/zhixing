import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { SkillsStore, type SkillMeta } from "../skills-store.js";

function makeMeta(overrides?: Partial<SkillMeta>): SkillMeta {
  return {
    title: "Test Skill",
    tags: ["test"],
    triggers: ["test trigger"],
    created: "2025-06-15",
    source: "conversation",
    version: 1,
    useCount: 0,
    effectiveness: "unknown",
    ...overrides,
  };
}

describe("SkillsStore", () => {
  let tmpDir: string;
  let store: SkillsStore;

  beforeEach(async () => {
    tmpDir = await createTempDir("skills");
    store = new SkillsStore(tmpDir);
  });

  // ─── save / load ───

  describe("save + load", () => {
    it("保存并加载技能", async () => {
      const meta = makeMeta({
        title: "Docker 网络调试",
        tags: ["docker", "networking"],
        triggers: ["docker network", "容器连不上"],
      });

      await store.save("docker-debug", meta, "## 排查步骤\n1. 检查网络");

      const loaded = await store.load("docker-debug");
      expect(loaded).not.toBeNull();
      expect(loaded!.meta.title).toBe("Docker 网络调试");
      expect(loaded!.meta.tags).toEqual(["docker", "networking"]);
      expect(loaded!.meta.triggers).toEqual(["docker network", "容器连不上"]);
      expect(loaded!.meta.version).toBe(1);
      expect(loaded!.meta.useCount).toBe(0);
      expect(loaded!.content).toContain("## 排查步骤");
    });

    it("不存在时返回 null", async () => {
      const loaded = await store.load("nonexistent");
      expect(loaded).toBeNull();
    });

    it("覆盖更新", async () => {
      await store.save("evolving", makeMeta({ version: 1 }), "v1");
      await store.save("evolving", makeMeta({ version: 2 }), "v2");

      const loaded = await store.load("evolving");
      expect(loaded!.meta.version).toBe(2);
      expect(loaded!.content).toBe("v2");
    });
  });

  // ─── delete ───

  describe("delete", () => {
    it("删除已有技能", async () => {
      await store.save("to-delete", makeMeta(), "");
      expect(await store.delete("to-delete")).toBe(true);
      expect(await store.load("to-delete")).toBeNull();
    });

    it("不存在时返回 false", async () => {
      expect(await store.delete("nonexistent")).toBe(false);
    });
  });

  // ─── listAll ───

  describe("listAll", () => {
    it("列出所有技能", async () => {
      await store.save("skill-a", makeMeta({ title: "A" }), "");
      await store.save("skill-b", makeMeta({ title: "B" }), "");

      const all = await store.listAll();
      expect(all).toHaveLength(2);
      const titles = all.map((s) => s.meta.title).sort();
      expect(titles).toEqual(["A", "B"]);
    });

    it("目录不存在时返回空", async () => {
      const emptyStore = new SkillsStore(path.join(tmpDir, "empty"));
      const all = await emptyStore.listAll();
      expect(all).toEqual([]);
    });
  });

  // ─── matchByMessage ───

  describe("matchByMessage", () => {
    beforeEach(async () => {
      await store.save(
        "docker-debug",
        makeMeta({
          title: "Docker 网络调试",
          tags: ["docker", "networking"],
          triggers: ["docker network", "容器连不上"],
        }),
        "检查网络模式",
      );
      await store.save(
        "git-rebase",
        makeMeta({
          title: "Git Rebase 技巧",
          tags: ["git"],
          triggers: ["git rebase", "合并冲突"],
        }),
        "交互式 rebase",
      );
    });

    it("匹配 trigger", async () => {
      const matches = await store.matchByMessage("我的 docker network 有问题");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.skill.meta.title).toBe("Docker 网络调试");
      expect(matches[0]!.matchType).toBe("trigger");
      expect(matches[0]!.matchedTrigger).toBe("docker network");
    });

    it("匹配中文 trigger", async () => {
      const matches = await store.matchByMessage("容器连不上外网了怎么办");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.skill.meta.title).toBe("Docker 网络调试");
    });

    it("无匹配时返回空", async () => {
      const matches = await store.matchByMessage("今天天气真好");
      expect(matches).toEqual([]);
    });

    it("多个技能同时匹配", async () => {
      const matches = await store.matchByMessage("docker network 和 git rebase 都有问题");
      expect(matches).toHaveLength(2);
    });

    it("trigger 匹配不区分大小写", async () => {
      const matches = await store.matchByMessage("DOCKER NETWORK issue");
      expect(matches).toHaveLength(1);
    });

    it("tag 作为兜底匹配", async () => {
      const matches = await store.matchByMessage("networking 的一些概念");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchType).toBe("tag");
    });

    it("trigger 优先于 tag", async () => {
      const matches = await store.matchByMessage("docker network 配置和 networking 理论");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchType).toBe("trigger");
    });
  });

  // ─── recordUsage ───

  describe("recordUsage", () => {
    it("递增 useCount 并更新 lastUsedAt", async () => {
      await store.save("test-skill", makeMeta({ useCount: 5 }), "");

      const updated = await store.recordUsage("test-skill");
      expect(updated).not.toBeNull();
      expect(updated!.useCount).toBe(6);
      expect(updated!.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // 持久化验证
      const loaded = await store.load("test-skill");
      expect(loaded!.meta.useCount).toBe(6);
    });

    it("不存在时返回 null", async () => {
      const result = await store.recordUsage("nonexistent");
      expect(result).toBeNull();
    });
  });

  // ─── buildDomainIndex ───

  describe("buildDomainIndex", () => {
    it("生成领域索引", async () => {
      await store.save("a", makeMeta({ title: "Docker 调试" }), "");
      await store.save("b", makeMeta({ title: "Git 技巧" }), "");

      const index = await store.buildDomainIndex();
      expect(index).toContain("Docker 调试");
      expect(index).toContain("Git 技巧");
      expect(index).toContain(" · ");
    });

    it("无技能时返回 null", async () => {
      const index = await store.buildDomainIndex();
      expect(index).toBeNull();
    });
  });

  // ─── formatForContext ───

  describe("formatForContext", () => {
    it("格式化匹配的技能", () => {
      const matches = [
        {
          skill: {
            id: "docker",
            meta: makeMeta({ title: "Docker 调试", tags: ["docker"] }),
            content: "检查网络",
            filePath: "/path",
          },
          matchedTrigger: "docker network",
          matchType: "trigger" as const,
        },
      ];

      const result = SkillsStore.formatForContext(matches);
      expect(result).toContain("# Relevant Skills");
      expect(result).toContain("### Docker 调试");
      expect(result).toContain("Tags: docker");
      expect(result).toContain("检查网络");
    });

    it("空匹配返回空字符串", () => {
      expect(SkillsStore.formatForContext([])).toBe("");
    });
  });

  // ─── 多维优先级排序 (M7b) ───

  describe("matchByMessage priority sorting", () => {
    it("helpful 技能排在 unknown 技能前面（同为 trigger 匹配）", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await store.save("skill-helpful", makeMeta({
        title: "Helpful Skill",
        triggers: ["docker"],
        effectiveness: "helpful",
        lastUsedAt: today,
      }), "...");

      await store.save("skill-unknown", makeMeta({
        title: "Unknown Skill",
        triggers: ["docker compose"],
        effectiveness: "unknown",
        lastUsedAt: today,
      }), "...");

      const matches = await store.matchByMessage("docker compose 问题");
      expect(matches.length).toBe(2);
      expect(matches[0]!.skill.id).toBe("skill-helpful");
    });

    it("needs-update 技能排在最后", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await store.save("good", makeMeta({
        title: "Good",
        triggers: ["nginx"],
        effectiveness: "helpful",
        lastUsedAt: today,
      }), "...");

      await store.save("outdated", makeMeta({
        title: "Outdated",
        triggers: ["nginx config"],
        effectiveness: "needs-update",
        lastUsedAt: today,
      }), "...");

      const matches = await store.matchByMessage("nginx config 配置");
      expect(matches.length).toBe(2);
      expect(matches[matches.length - 1]!.skill.id).toBe("outdated");
    });

    it("最近使用的技能优先于长期未使用的", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const oldDate = "2024-01-01";

      await store.save("fresh", makeMeta({
        title: "Fresh",
        triggers: ["git rebase"],
        effectiveness: "unknown",
        lastUsedAt: today,
      }), "...");

      await store.save("stale", makeMeta({
        title: "Stale",
        triggers: ["git rebase onto"],
        effectiveness: "unknown",
        lastUsedAt: oldDate,
      }), "...");

      const matches = await store.matchByMessage("git rebase onto main");
      expect(matches.length).toBe(2);
      expect(matches[0]!.skill.id).toBe("fresh");
    });
  });
});
