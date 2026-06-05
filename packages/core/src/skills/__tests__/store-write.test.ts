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

describe("listForManagement(面向管理的全集读)", () => {
  it("返回全集含 disabled 并带回 usage —— 与剔 disabled 的 listAll 对比", async () => {
    await writeSkill("own", "a", { name: "A" });
    await writeSkill("linked", "b", { name: "B" });
    const store = new SkillStore(root);
    await store.setState("a", { disabled: true }); // 禁用 a
    await store.loadText("b"); // 记一次 b 的命中(usage)

    const managed = await store.listForManagement();
    expect(managed.map((m) => m.id).sort()).toEqual(["a", "b"]); // 全集:含被禁用的 a

    const a = managed.find((m) => m.id === "a")!;
    const b = managed.find((m) => m.id === "b")!;
    expect(a.disabled).toBe(true); // 禁用技能可见、带状态(供就地重启用)
    expect(a.usage).toBeNull(); // 未命中过 → usage 为 null
    expect(b.usage?.hitCount).toBe(1); // 带回 usage

    // 对比:listAll 剔 disabled,只剩 b
    expect((await store.listAll()).map((r) => r.id)).toEqual(["b"]);
  });

  it("空库返回空数组", async () => {
    expect(await new SkillStore(root).listForManagement()).toEqual([]);
  });
});

describe("version(投影版本号)", () => {
  it("结构性写递增、usage 命中不计入", async () => {
    const store = new SkillStore(root);
    const v0 = store.version("main");

    await store.create({ name: "A", description: "", body: "b", mode: "main" });
    const v1 = store.version("main");
    expect(v1).toBeGreaterThan(v0);

    await store.setState("a", { pinned: true });
    const v2 = store.version("main");
    expect(v2).toBeGreaterThan(v1);

    // usage 命中(loadText → recordHit):不计入版本
    await store.loadText("a");
    expect(store.version("main")).toBe(v2);

    await store.update("a", { name: "A", description: "改", body: "b2", mode: "main" });
    const v3 = store.version("main");
    expect(v3).toBeGreaterThan(v2);

    await store.archive("a");
    expect(store.version("main")).toBeGreaterThan(v3);
  });

  it("admit 令版本递增", async () => {
    const store = new SkillStore(root);
    const v0 = store.version("main");
    const staging = await store.prepareStaging();
    await fs.writeFile(
      path.join(staging, "SKILL.md"),
      `---\nname: Imported\n---\nbody`,
      "utf-8",
    );
    await store.admit(staging, { mode: "main" });
    expect(store.version("main")).toBeGreaterThan(v0);
  });

  it("fork 不改投影、版本不变;读路径(listAll)也不递增版本", async () => {
    await writeSkill("linked", "lk", { name: "Lk" });
    const store = new SkillStore(root);
    await store.listAll(); // 触发首次状态落盘,但读路径不计入版本
    const v0 = store.version("main");
    await store.fork("lk");
    expect(store.version("main")).toBe(v0);
  });

  it("publish-after-commit:版本递增后投影即可读到该变更", async () => {
    const store = new SkillStore(root);
    await store.create({ name: "P", description: "", body: "b", mode: "main" });
    expect(store.version("main")).toBeGreaterThan(0);
    expect((await store.queryTopN("main", 10)).map((r) => r.id)).toContain("p");
  });
});
