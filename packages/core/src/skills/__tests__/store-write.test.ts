import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillStore } from "../store.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-write-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeSkill(
  source: "own" | "linked",
  dir: string,
  opts: { name: string; body?: string },
): Promise<void> {
  const d = path.join(root, source, dir);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(
    path.join(d, "SKILL.md"),
    `---\nname: ${opts.name}\n---\n${opts.body ?? "body"}`,
    "utf-8",
  );
}

async function readIndexFile(): Promise<
  Array<{ id: string; mode: string; pinned: boolean; disabled: boolean; createdAt: string }>
> {
  const raw = await fs.readFile(path.join(root, "index.json"), "utf-8");
  return JSON.parse(raw);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("SkillStore 写路径", () => {
  describe("setState", () => {
    it("pin / 改 mode 落入 index", async () => {
      await writeSkill("own", "a", { name: "A" });
      const store = new SkillStore(root);
      await store.listAll();
      await store.setState("a", { pinned: true, mode: "work" });
      const a = (await readIndexFile()).find((s) => s.id === "a")!;
      expect(a.pinned).toBe(true);
      expect(a.mode).toBe("work");
    });

    it("禁用后不进 listAll(无需先 listAll)", async () => {
      await writeSkill("own", "a", { name: "A" });
      const store = new SkillStore(root);
      await store.setState("a", { disabled: true });
      expect(await store.listAll()).toHaveLength(0);
    });

    it("保持 createdAt 不变", async () => {
      await writeSkill("own", "a", { name: "A" });
      const store = new SkillStore(root);
      await store.listAll();
      const before = (await readIndexFile()).find((s) => s.id === "a")!.createdAt;
      await store.setState("a", { pinned: true });
      const after = (await readIndexFile()).find((s) => s.id === "a")!.createdAt;
      expect(after).toBe(before);
    });

    it("技能不存在即抛", async () => {
      const store = new SkillStore(root);
      await expect(store.setState("nope", { pinned: true })).rejects.toThrow();
    });
  });

  describe("archive", () => {
    it("移到 archived/、原位置消失、不再进 listAll", async () => {
      await writeSkill("own", "a", { name: "A" });
      const store = new SkillStore(root);
      await store.archive("a");
      expect(await store.listAll()).toHaveLength(0);
      expect(await exists(path.join(root, "own", "a"))).toBe(false);
      const archived = await fs.readdir(path.join(root, "archived"));
      expect(archived).toHaveLength(1);
      expect(
        await exists(path.join(root, "archived", archived[0]!, "SKILL.md")),
      ).toBe(true);
    });

    it("同名重复归档追加序号、不覆盖", async () => {
      const store = new SkillStore(root);
      await writeSkill("own", "a", { name: "A" });
      await store.archive("a");
      await writeSkill("own", "a", { name: "A" });
      await store.archive("a");
      const archived = await fs.readdir(path.join(root, "archived"));
      expect(archived).toHaveLength(2);
    });

    it("不存在即抛", async () => {
      const store = new SkillStore(root);
      await expect(store.archive("nope")).rejects.toThrow();
    });
  });

  describe("create", () => {
    it("写 own/<id>/SKILL.md + 登记状态 + 可加载", async () => {
      const store = new SkillStore(root);
      const rec = await store.create({
        name: "Deploy Flow",
        description: "部署",
        body: "步骤正文",
        mode: "work",
      });
      expect(rec.id).toBe("deploy-flow");
      expect(rec.source).toBe("own");
      expect(rec.mode).toBe("work");
      expect((await store.listAll()).map((r) => r.id)).toContain("deploy-flow");
      expect((await store.loadText("deploy-flow")).body).toBe("步骤正文");
      const st = (await readIndexFile()).find((s) => s.id === "deploy-flow")!;
      expect(st.mode).toBe("work");
    });

    it("撞名即拒", async () => {
      await writeSkill("own", "x", { name: "Dup" });
      const store = new SkillStore(root);
      await expect(
        store.create({ name: "Dup", description: "", body: "b", mode: "main" }),
      ).rejects.toThrow();
    });

    it("空 id(全非法名)即拒", async () => {
      const store = new SkillStore(root);
      await expect(
        store.create({ name: "///", description: "", body: "b", mode: "main" }),
      ).rejects.toThrow();
    });

    it("中文名创建:id 保 Unicode、可加载", async () => {
      const store = new SkillStore(root);
      const rec = await store.create({
        name: "代码审查",
        description: "审",
        body: "正文",
        mode: "main",
      });
      expect(rec.id).toBe("代码审查");
      expect((await store.loadText("代码审查")).body).toBe("正文");
    });
  });
});
