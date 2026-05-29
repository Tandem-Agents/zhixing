import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillStore } from "../store.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-store-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeSkill(
  source: "own" | "linked",
  dir: string,
  opts: { name: string; description?: string; body?: string },
): Promise<void> {
  const d = path.join(root, source, dir);
  await fs.mkdir(d, { recursive: true });
  const lines = [`name: ${opts.name}`];
  if (opts.description) lines.push(`description: ${opts.description}`);
  const content = `---\n${lines.join("\n")}\n---\n${opts.body ?? "body text"}`;
  await fs.writeFile(path.join(d, "SKILL.md"), content, "utf-8");
}

async function writeRaw(
  source: "own" | "linked",
  dir: string,
  content: string,
): Promise<void> {
  const d = path.join(root, source, dir);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(d, "SKILL.md"), content, "utf-8");
}

async function writeIndexFile(states: unknown[]): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "index.json"),
    JSON.stringify(states),
    "utf-8",
  );
}

async function writeUsage(
  id: string,
  usage: { lastHitAt: string; hitCount: number },
): Promise<void> {
  await fs.mkdir(path.join(root, "usage"), { recursive: true });
  await fs.writeFile(
    path.join(root, "usage", `${id}.json`),
    JSON.stringify(usage),
    "utf-8",
  );
}

async function readIndexFile(): Promise<
  Array<{ id: string; mode: string; pinned: boolean; disabled: boolean; createdAt: string }>
> {
  const raw = await fs.readFile(path.join(root, "index.json"), "utf-8");
  return JSON.parse(raw);
}

describe("SkillStore 读路径", () => {
  it("扫描发现 + 解析 frontmatter + 派生 id", async () => {
    await writeSkill("own", "code-review", {
      name: "Code Review",
      description: "审代码",
    });
    const store = new SkillStore(root);
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: "code-review",
      name: "Code Review",
      description: "审代码",
      source: "own",
    });
  });

  it("首次扫到持久化默认状态(mode main / createdAt 写一次)", async () => {
    await writeSkill("own", "a", { name: "A" });
    const store = new SkillStore(root);
    await store.listAll();
    const idx = await readIndexFile();
    const a = idx.find((s) => s.id === "a");
    expect(a).toBeDefined();
    expect(a!.mode).toBe("main");
    expect(a!.pinned).toBe(false);
    expect(a!.disabled).toBe(false);
    expect(typeof a!.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(a!.createdAt))).toBe(false);
  });

  it("createdAt 只写一次,后续扫描不变", async () => {
    await writeSkill("own", "a", { name: "A" });
    const store = new SkillStore(root);
    await store.listAll();
    const first = (await readIndexFile()).find((s) => s.id === "a")!.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.listAll();
    const second = (await readIndexFile()).find((s) => s.id === "a")!.createdAt;
    expect(second).toBe(first);
  });

  it("own 同 id 遮蔽 linked", async () => {
    await writeSkill("linked", "x", { name: "Dup", body: "LINKED" });
    await writeSkill("own", "y", { name: "Dup", body: "OWN" });
    const store = new SkillStore(root);
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.source).toBe("own");
    const loaded = await store.loadText("dup");
    expect(loaded.body).toBe("OWN");
  });

  it("disabled 技能不进 listAll", async () => {
    await writeSkill("own", "a", { name: "A" });
    await writeIndexFile([
      {
        id: "a",
        mode: "main",
        pinned: false,
        disabled: true,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const store = new SkillStore(root);
    expect(await store.listAll()).toHaveLength(0);
  });

  it("queryTopN 按 mode 过滤 + 限量", async () => {
    await writeSkill("own", "a", { name: "A" });
    await writeSkill("own", "b", { name: "B" });
    await writeSkill("own", "c", { name: "C" });
    await writeIndexFile([
      { id: "a", mode: "main", pinned: false, disabled: false, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "b", mode: "main", pinned: false, disabled: false, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "c", mode: "work", pinned: false, disabled: false, createdAt: "2024-01-01T00:00:00.000Z" },
    ]);
    const store = new SkillStore(root);
    const main = await store.queryTopN("main", 10);
    expect(main.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(await store.queryTopN("main", 1)).toHaveLength(1);
  });

  it("排序:pinned 优先,其余按新近度降序", async () => {
    await writeSkill("own", "a", { name: "A" });
    await writeSkill("own", "b", { name: "B" });
    await writeSkill("own", "c", { name: "C" });
    await writeIndexFile([
      { id: "a", mode: "main", pinned: false, disabled: false, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "b", mode: "main", pinned: false, disabled: false, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "c", mode: "main", pinned: true, disabled: false, createdAt: "2024-01-01T00:00:00.000Z" },
    ]);
    await writeUsage("a", { lastHitAt: "2024-01-01T00:00:00.000Z", hitCount: 1 });
    await writeUsage("b", { lastHitAt: "2024-06-01T00:00:00.000Z", hitCount: 1 });
    const store = new SkillStore(root);
    const ranked = await store.queryTopN("main", 10);
    expect(ranked.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("loadText 返回正文 + 累计命中度量", async () => {
    await writeSkill("own", "a", { name: "A", body: "这是做法正文" });
    const store = new SkillStore(root);
    const first = await store.loadText("a");
    expect(first.body).toBe("这是做法正文");
    const u1 = JSON.parse(
      await fs.readFile(path.join(root, "usage", "a.json"), "utf-8"),
    );
    expect(u1.hitCount).toBe(1);
    expect(typeof u1.lastHitAt).toBe("string");
    await store.loadText("a");
    const u2 = JSON.parse(
      await fs.readFile(path.join(root, "usage", "a.json"), "utf-8"),
    );
    expect(u2.hitCount).toBe(2);
  });

  it("loadText 不存在即抛", async () => {
    const store = new SkillStore(root);
    await expect(store.loadText("nope")).rejects.toThrow();
  });

  it("坏 SKILL.md(无 frontmatter / 无 name)被隔离,不污染全局", async () => {
    await writeRaw("own", "bad", "没有 frontmatter 的内容");
    await writeRaw("own", "bad2", "---\ndescription: 只有描述没名字\n---\n正文");
    await writeSkill("own", "good", { name: "Good" });
    const store = new SkillStore(root);
    const all = await store.listAll();
    expect(all.map((r) => r.id)).toEqual(["good"]);
  });

  it("symlink 指向库外的技能被边界拒绝(创建软链失败则跳过)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skills-outside-"));
    try {
      await fs.mkdir(path.join(outside, "evil"), { recursive: true });
      await fs.writeFile(
        path.join(outside, "evil", "SKILL.md"),
        "---\nname: Evil\n---\n越界内容",
        "utf-8",
      );
      await fs.mkdir(path.join(root, "own"), { recursive: true });
      let symlinkOk = true;
      try {
        await fs.symlink(
          path.join(outside, "evil"),
          path.join(root, "own", "evil"),
          "dir",
        );
      } catch {
        symlinkOk = false;
      }
      if (!symlinkOk) return; // 平台不支持创建软链(如 Windows 无权限)→ 跳过
      const store = new SkillStore(root);
      expect(await store.listAll()).toHaveLength(0);
      await expect(store.loadText("evil")).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
