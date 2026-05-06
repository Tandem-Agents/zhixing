import { describe, it, expect, beforeEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { SkillsStore, type SkillMeta, type SkillEntry } from "../skills-store.js";

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

describe("Skill Governance (M4c)", () => {
  let tmpDir: string;
  let store: SkillsStore;

  beforeEach(async () => {
    tmpDir = await createTempDir("governance");
    store = new SkillsStore(tmpDir);
  });

  // ─── updateWithRevision ───

  describe("updateWithRevision", () => {
    it("递增版本号并记录修订历史", async () => {
      await store.save("sk1", makeMeta(), "Version 1 content");
      const updated = await store.updateWithRevision(
        "sk1", "Version 2 content", "user-update", "增加了错误处理",
      );

      expect(updated).not.toBeNull();
      expect(updated!.meta.version).toBe(2);
      expect(updated!.meta.revisions).toHaveLength(1);
      expect(updated!.meta.revisions![0]!.reason).toBe("user-update");
      expect(updated!.meta.revisions![0]!.summary).toBe("增加了错误处理");
      expect(updated!.content).toBe("Version 2 content");
    });

    it("支持同时更新 meta 字段", async () => {
      await store.save("sk1", makeMeta({ title: "Old Title" }), "content");
      const updated = await store.updateWithRevision(
        "sk1", "content", "user-edit", "改标题",
        { title: "New Title" },
      );

      expect(updated!.meta.title).toBe("New Title");
    });

    it("不存在时返回 null", async () => {
      const result = await store.updateWithRevision(
        "nope", "content", "user-update", "test",
      );
      expect(result).toBeNull();
    });

    it("多次更新累积修订历史", async () => {
      await store.save("sk1", makeMeta(), "v1");
      await store.updateWithRevision("sk1", "v2", "user-update", "second");
      await store.updateWithRevision("sk1", "v3", "reflection-update", "third");

      const loaded = await store.load("sk1");
      expect(loaded!.meta.version).toBe(3);
      expect(loaded!.meta.revisions).toHaveLength(2);
    });

    it("revisions 最多保留 10 条", async () => {
      await store.save("sk1", makeMeta(), "v1");
      for (let i = 2; i <= 15; i++) {
        await store.updateWithRevision("sk1", `v${i}`, "user-update", `update ${i}`);
      }

      const loaded = await store.load("sk1");
      expect(loaded!.meta.revisions!.length).toBeLessThanOrEqual(11);
    });
  });

  // ─── archive / restore ───

  describe("archive / restore", () => {
    it("归档后 listAll 不再包含该技能", async () => {
      await store.save("sk1", makeMeta({ title: "Skill 1" }), "content");
      await store.save("sk2", makeMeta({ title: "Skill 2" }), "content");

      const archived = await store.archive("sk1");
      expect(archived).toBe(true);

      const active = await store.listAll();
      expect(active).toHaveLength(1);
      expect(active[0]!.meta.title).toBe("Skill 2");
    });

    it("归档后可通过 listArchived 查询", async () => {
      await store.save("sk1", makeMeta({ title: "Archived Skill" }), "content");
      await store.archive("sk1");

      const archivedList = await store.listArchived();
      expect(archivedList).toHaveLength(1);
      expect(archivedList[0]!.meta.title).toBe("Archived Skill");
    });

    it("恢复归档的技能", async () => {
      await store.save("sk1", makeMeta(), "content");
      await store.archive("sk1");
      const restored = await store.restore("sk1");
      expect(restored).toBe(true);

      const loaded = await store.load("sk1");
      expect(loaded).not.toBeNull();
    });

    it("归档不存在的技能返回 false", async () => {
      expect(await store.archive("nope")).toBe(false);
    });

    it("恢复不存在的技能返回 false", async () => {
      expect(await store.restore("nope")).toBe(false);
    });

    it("归档后 matchByMessage 不再匹配", async () => {
      await store.save("sk1", makeMeta({ triggers: ["docker network"] }), "content");
      await store.archive("sk1");

      const matches = await store.matchByMessage("docker network issue");
      expect(matches).toHaveLength(0);
    });
  });

  // ─── getStatus ───

  describe("getStatus", () => {
    it("新建技能为 active", async () => {
      await store.save("sk1", makeMeta({ created: new Date().toISOString().slice(0, 10) }), "");
      const skill = await store.load("sk1");
      expect(store.getStatus(skill!)).toBe("active");
    });

    it("最近使用过的技能为 active", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await store.save("sk1", makeMeta({ lastUsedAt: today, useCount: 5 }), "");
      const skill = await store.load("sk1");
      expect(store.getStatus(skill!)).toBe("active");
    });

    it("超过 90 天未使用为 stale", async () => {
      const oldDate = "2024-01-01";
      await store.save("sk1", makeMeta({ created: oldDate, lastUsedAt: oldDate }), "");
      const skill = await store.load("sk1");
      expect(store.getStatus(skill!)).toBe("stale");
    });

    it("自定义 staleDays 阈值", async () => {
      const thirtyDaysAgo = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
      await store.save("sk1", makeMeta({ created: thirtyDaysAgo, lastUsedAt: thirtyDaysAgo }), "");
      const skill = await store.load("sk1");
      expect(store.getStatus(skill!, 30)).toBe("stale");
      expect(store.getStatus(skill!, 60)).toBe("active");
    });

    it("归档目录中的技能为 archived", async () => {
      await store.save("sk1", makeMeta(), "");
      await store.archive("sk1");

      const archived = await store.listArchived();
      expect(store.getStatus(archived[0]!)).toBe("archived");
    });
  });
});
