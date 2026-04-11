import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillsStore, type SkillMeta } from "../skills-store.js";
import { MemoryRetriever } from "../retriever.js";

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

describe("MemoryRetriever", () => {
  let tmpDir: string;
  let skillsStore: SkillsStore;
  let retriever: MemoryRetriever;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-retriever-test-"));
    skillsStore = new SkillsStore(tmpDir);
    retriever = new MemoryRetriever(skillsStore);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("匹配技能并返回格式化文本", async () => {
    await skillsStore.save(
      "docker-debug",
      makeMeta({
        title: "Docker 网络调试",
        triggers: ["docker network", "容器连不上"],
      }),
      "## 排查步骤\n1. 检查网络模式",
    );

    const result = await retriever.retrieve("我的 docker network 连不上了");
    expect(result.skills).toHaveLength(1);
    expect(result.contextText).not.toBeNull();
    expect(result.contextText).toContain("# Relevant Skills");
    expect(result.contextText).toContain("Docker 网络调试");
  });

  it("无匹配时返回空", async () => {
    const result = await retriever.retrieve("今天天气真好");
    expect(result.skills).toEqual([]);
    expect(result.contextText).toBeNull();
  });

  it("匹配后自动记录使用", async () => {
    await skillsStore.save(
      "git-skill",
      makeMeta({ triggers: ["git rebase"], useCount: 0 }),
      "",
    );

    await retriever.retrieve("如何使用 git rebase");

    const loaded = await skillsStore.load("git-skill");
    expect(loaded!.meta.useCount).toBe(1);
    expect(loaded!.meta.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("多技能匹配时全部注入", async () => {
    await skillsStore.save(
      "skill-a",
      makeMeta({ title: "技能A", triggers: ["alpha"] }),
      "内容A",
    );
    await skillsStore.save(
      "skill-b",
      makeMeta({ title: "技能B", triggers: ["beta"] }),
      "内容B",
    );

    const result = await retriever.retrieve("alpha and beta 的问题");
    expect(result.skills).toHaveLength(2);
    expect(result.contextText).toContain("技能A");
    expect(result.contextText).toContain("技能B");
  });
});
