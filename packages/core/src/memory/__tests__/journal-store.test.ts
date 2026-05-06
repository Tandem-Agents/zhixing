import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { JournalStore, type CondenseLLM } from "../journal-store.js";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

describe("JournalStore", () => {
  let tmpDir: string;
  let store: JournalStore;

  beforeEach(async () => {
    tmpDir = await createTempDir("journal");
    store = new JournalStore(tmpDir);
  });

  // ─── append + load ───

  describe("append + load", () => {
    it("创建当日日志", async () => {
      const today = daysAgo(0);
      await store.append("今天调试了 Docker 网络", today);

      const entry = await store.load(today);
      expect(entry).not.toBeNull();
      expect(entry!.content).toContain("今天调试了 Docker 网络");
      expect(entry!.meta.date).toBe(today);
    });

    it("追加到同一天的日志", async () => {
      const today = daysAgo(0);
      await store.append("上午的内容", today);
      await store.append("下午的内容", today);

      const entry = await store.load(today);
      expect(entry!.content).toContain("上午的内容");
      expect(entry!.content).toContain("下午的内容");
      expect(entry!.content).toContain("---");
    });

    it("不存在时返回 null", async () => {
      expect(await store.load("2099-01-01")).toBeNull();
    });
  });

  // ─── list ───

  describe("list", () => {
    it("按日期降序排列", async () => {
      await store.append("day 1", daysAgo(3));
      await store.append("day 2", daysAgo(1));
      await store.append("day 3", daysAgo(2));

      const entries = await store.list();
      expect(entries).toHaveLength(3);
      expect(entries[0]!.meta.date).toBe(daysAgo(1));
      expect(entries[2]!.meta.date).toBe(daysAgo(3));
    });

    it("目录不存在时返回空", async () => {
      const emptyStore = new JournalStore(path.join(tmpDir, "nonexistent"));
      expect(await emptyStore.list()).toEqual([]);
    });
  });

  // ─── scan — 生命周期阶段分类 ───

  describe("scan", () => {
    it("30 天内的日志为 hot", async () => {
      await store.append("recent", daysAgo(5));
      const plan = await store.scan();

      expect(plan.stats.hotCount).toBe(1);
      expect(plan.stats.warmCount).toBe(0);
    });

    it("超过 30 天的日志为 warm", async () => {
      await store.append("old", daysAgo(35));
      const plan = await store.scan();

      expect(plan.stats.warmCount).toBe(1);
      expect(plan.condensePlan).not.toBeNull();
      expect(plan.condensePlan!.months).toHaveLength(1);
    });

    it("识别凝练文件", async () => {
      const month = monthsAgo(3);
      const filePath = path.join(tmpDir, "journal", `${month}.md`);
      await fs.mkdir(path.join(tmpDir, "journal"), { recursive: true });
      await fs.writeFile(filePath, `---\ndate: ${month}\ncondensed: true\ncondensedFrom: 5\n---\nSummary`, "utf-8");

      const plan = await store.scan();
      expect(plan.stats.condensedCount).toBe(1);
    });

    it("超过 12 个月的凝练文件标记为 expired", async () => {
      const oldMonth = monthsAgo(14);
      const filePath = path.join(tmpDir, "journal", `${oldMonth}.md`);
      await fs.mkdir(path.join(tmpDir, "journal"), { recursive: true });
      await fs.writeFile(filePath, `---\ndate: ${oldMonth}\ncondensed: true\n---\nOld`, "utf-8");

      const plan = await store.scan();
      expect(plan.expiredFiles).toHaveLength(1);
    });

    it("无文件时返回空计划", async () => {
      const plan = await store.scan();
      expect(plan.stats.totalFiles).toBe(0);
      expect(plan.condensePlan).toBeNull();
      expect(plan.expiredFiles).toHaveLength(0);
    });
  });

  // ─── expireOld ───

  describe("expireOld", () => {
    it("删除过期凝练文件", async () => {
      const oldMonth = monthsAgo(14);
      const filePath = path.join(tmpDir, "journal", `${oldMonth}.md`);
      await fs.mkdir(path.join(tmpDir, "journal"), { recursive: true });
      await fs.writeFile(filePath, `---\ndate: ${oldMonth}\ncondensed: true\n---\nOld`, "utf-8");

      const result = await store.expireOld();
      expect(result.deleted).toBe(1);

      // 文件确实被删除了
      const entries = await store.list();
      expect(entries).toHaveLength(0);
    });

    it("不删除未过期的文件", async () => {
      await store.append("recent", daysAgo(5));
      const result = await store.expireOld();
      expect(result.deleted).toBe(0);
    });
  });

  // ─── condense ───

  describe("condense", () => {
    const mockLLM: CondenseLLM = {
      async condense(content: string) {
        return `## Monthly Summary\n\nKey points from ${content.split("---").length} entries.\n\n[SKILL_CANDIDATE] Docker 网络调试方法论`;
      },
    };

    it("凝练日志并生成月度文件", async () => {
      // 创建 >30 天前的日志
      const oldDate1 = daysAgo(35);
      const oldDate2 = daysAgo(36);
      await store.append("Day 1 content", oldDate1);
      await store.append("Day 2 content", oldDate2);

      const plan = await store.scan();
      expect(plan.condensePlan).not.toBeNull();

      const result = await store.condense(plan.condensePlan!, mockLLM);

      expect(result.condensedMonths).toHaveLength(1);
      expect(result.deletedFiles).toBe(2);

      // 原始日志已删除
      expect(await store.load(oldDate1)).toBeNull();
      expect(await store.load(oldDate2)).toBeNull();

      // 月度凝练文件已创建
      const month = oldDate1.slice(0, 7);
      const condensed = await store.load(month);
      expect(condensed).not.toBeNull();
      expect(condensed!.meta.condensed).toBe(true);
      expect(condensed!.meta.condensedFrom).toBe(2);
    });

    it("检测 SKILL_CANDIDATE 标记", async () => {
      await store.append("content", daysAgo(35));
      const plan = await store.scan();
      const result = await store.condense(plan.condensePlan!, mockLLM);

      expect(result.skillCandidates).toHaveLength(1);
      expect(result.skillCandidates[0]).toContain("Docker 网络调试方法论");
    });
  });

  // ─── 自定义配置 ───

  describe("自定义配置", () => {
    it("dailyRetentionDays = 7", async () => {
      const customStore = new JournalStore(tmpDir, { dailyRetentionDays: 7 });
      await customStore.append("recent", daysAgo(10));

      const plan = await customStore.scan();
      expect(plan.stats.warmCount).toBe(1);
    });

    it("condensedRetentionMonths = 6", async () => {
      const customStore = new JournalStore(tmpDir, { condensedRetentionMonths: 6 });
      const month = monthsAgo(8);
      const filePath = path.join(tmpDir, "journal", `${month}.md`);
      await fs.mkdir(path.join(tmpDir, "journal"), { recursive: true });
      await fs.writeFile(filePath, `---\ndate: ${month}\ncondensed: true\n---\nOld`, "utf-8");

      const plan = await customStore.scan();
      expect(plan.expiredFiles).toHaveLength(1);
    });
  });
});
