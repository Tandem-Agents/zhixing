import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PeopleStore, type PersonMeta } from "../people-store.js";

function makeMeta(overrides?: Partial<PersonMeta>): PersonMeta {
  return {
    name: "小丽",
    relation: "女友",
    ...overrides,
  };
}

describe("PeopleStore", () => {
  let tmpDir: string;
  let store: PeopleStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-people-test-"));
    store = new PeopleStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── save + load ───

  describe("save + load", () => {
    it("保存并加载人物", async () => {
      await store.save("girlfriend-xiaoli", makeMeta(), "喜欢吃寿司");
      const loaded = await store.load("girlfriend-xiaoli");

      expect(loaded).not.toBeNull();
      expect(loaded!.meta.name).toBe("小丽");
      expect(loaded!.meta.relation).toBe("女友");
      expect(loaded!.content).toBe("喜欢吃寿司");
    });

    it("保存含可选字段的人物", async () => {
      await store.save("mom", makeMeta({
        name: "张妈妈",
        relation: "母亲",
        birthday: "1965-03-15",
        tags: ["家人", "退休"],
      }), "住在北京");

      const loaded = await store.load("mom");
      expect(loaded!.meta.birthday).toBe("1965-03-15");
      expect(loaded!.meta.tags).toEqual(["家人", "退休"]);
    });

    it("不存在时返回 null", async () => {
      const loaded = await store.load("nonexistent");
      expect(loaded).toBeNull();
    });
  });

  // ─── delete ───

  describe("delete", () => {
    it("删除已有人物", async () => {
      await store.save("test-person", makeMeta(), "");
      expect(await store.delete("test-person")).toBe(true);
      expect(await store.load("test-person")).toBeNull();
    });

    it("不存在时返回 false", async () => {
      expect(await store.delete("nope")).toBe(false);
    });
  });

  // ─── listAll ───

  describe("listAll", () => {
    it("列出所有人物", async () => {
      await store.save("person-a", makeMeta({ name: "A" }), "");
      await store.save("person-b", makeMeta({ name: "B" }), "");

      const all = await store.listAll();
      expect(all).toHaveLength(2);
      const names = all.map((p) => p.meta.name).sort();
      expect(names).toEqual(["A", "B"]);
    });

    it("目录不存在时返回空", async () => {
      const emptyStore = new PeopleStore(path.join(tmpDir, "nonexistent"));
      const all = await emptyStore.listAll();
      expect(all).toEqual([]);
    });
  });

  // ─── matchByMessage ───

  describe("matchByMessage", () => {
    beforeEach(async () => {
      await store.save("wife", makeMeta({ name: "小丽", relation: "妻子" }), "喜欢吃寿司");
      await store.save("mom", makeMeta({ name: "张妈妈", relation: "母亲" }), "住在北京");
      await store.save("boss", makeMeta({ name: "王总", relation: "上司" }), "技术总监");
    });

    it("人名精确匹配", async () => {
      const matches = await store.matchByMessage("小丽最近怎么样");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.person.meta.name).toBe("小丽");
      expect(matches[0]!.matchType).toBe("name");
    });

    it("关系词映射匹配：老婆 → 妻子", async () => {
      const matches = await store.matchByMessage("我老婆喜欢什么");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.person.meta.name).toBe("小丽");
      expect(matches[0]!.matchType).toBe("relation");
      expect(matches[0]!.matchedKeyword).toBe("老婆");
    });

    it("关系词映射匹配：我妈 → 母亲", async () => {
      const matches = await store.matchByMessage("我妈生日是什么时候");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.person.meta.name).toBe("张妈妈");
    });

    it("关系词映射匹配：领导 → 上司", async () => {
      const matches = await store.matchByMessage("领导说什么了");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.person.meta.name).toBe("王总");
    });

    it("人名匹配优先于关系词（同一人不重复）", async () => {
      const matches = await store.matchByMessage("小丽是我老婆");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchType).toBe("name");
    });

    it("多个人物同时匹配", async () => {
      const matches = await store.matchByMessage("小丽和张妈妈一起去旅游");
      expect(matches).toHaveLength(2);
    });

    it("无匹配时返回空", async () => {
      const matches = await store.matchByMessage("今天天气怎么样");
      expect(matches).toEqual([]);
    });

    it("人名匹配不区分大小写", async () => {
      await store.save("john", makeMeta({ name: "John", relation: "朋友" }), "");
      const matches = await store.matchByMessage("john is my friend");
      expect(matches).toHaveLength(1);
    });
  });

  // ─── formatForContext ───

  describe("formatForContext", () => {
    it("格式化匹配的人物", async () => {
      await store.save("wife", makeMeta({ name: "小丽", relation: "妻子", birthday: "1995-08-20" }), "喜欢吃寿司");
      const matches = await store.matchByMessage("小丽");
      const text = PeopleStore.formatForContext(matches);

      expect(text).toContain("# Relevant People");
      expect(text).toContain("小丽（妻子）");
      expect(text).toContain("Birthday: 1995-08-20");
      expect(text).toContain("喜欢吃寿司");
    });

    it("空匹配返回空字符串", () => {
      expect(PeopleStore.formatForContext([])).toBe("");
    });
  });
});
