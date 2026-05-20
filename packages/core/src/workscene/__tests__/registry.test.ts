import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { FsWorkSceneRegistry } from "../registry.js";
import {
  getWorkSceneConversationsRoot,
  getWorkSceneDir,
  getWorkSceneIndexPath,
  getWorkSceneMemoryDir,
  getWorkScenesRoot,
} from "../paths.js";

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpDir = await createTempDir("workscene");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmpDir;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.ZHIXING_HOME;
  } else {
    process.env.ZHIXING_HOME = originalHome;
  }
});

describe("工作场景路径解析", () => {
  it("全部从 ZHIXING_HOME 派生，id 经 safe-segment", () => {
    expect(getWorkScenesRoot()).toBe(path.join(tmpDir, "workscenes"));
    expect(getWorkSceneIndexPath()).toBe(
      path.join(tmpDir, "workscenes", "index.json"),
    );
    // id 含 ':' → 安全化为 '--'
    const dir = getWorkSceneDir("a:b");
    expect(dir).toBe(path.join(tmpDir, "workscenes", "a--b"));
    expect(getWorkSceneMemoryDir("x")).toBe(
      path.join(tmpDir, "workscenes", "x", "me"),
    );
    expect(getWorkSceneConversationsRoot("x")).toBe(
      path.join(tmpDir, "workscenes", "x", "conversations"),
    );
  });
});

describe("FsWorkSceneRegistry · CRUD", () => {
  it("add → get 命中，meta.json + index.json 落盘", async () => {
    const reg = new FsWorkSceneRegistry();
    const scene = await reg.add({ name: "知行 CLI 开发" });

    expect(scene.id).toBe("知行-cli-开发");
    expect(scene.name).toBe("知行 CLI 开发");
    expect(scene.workdir).toBeUndefined();
    expect(scene.createdAt).toBeTruthy();

    const got = await reg.get(scene.id);
    expect(got).toEqual(scene);

    const metaRaw = await fs.readFile(
      path.join(getWorkSceneDir(scene.id), "meta.json"),
      "utf-8",
    );
    expect(JSON.parse(metaRaw)).toEqual(scene);

    const indexRaw = await fs.readFile(getWorkSceneIndexPath(), "utf-8");
    expect(JSON.parse(indexRaw)).toEqual({ scenes: [scene.id] });
  });

  it("add 带 workdir 持久化", async () => {
    const reg = new FsWorkSceneRegistry();
    const scene = await reg.add({ name: "site", workdir: "/tmp/site" });
    expect(scene.workdir).toBe("/tmp/site");
    expect((await reg.get(scene.id))?.workdir).toBe("/tmp/site");
  });

  it("同名 add → id 自动去重", async () => {
    const reg = new FsWorkSceneRegistry();
    const a = await reg.add({ name: "demo" });
    const b = await reg.add({ name: "demo" });
    expect(a.id).toBe("demo");
    expect(b.id).toBe("demo-2");
    expect((await reg.list()).map((s) => s.id).sort()).toEqual([
      "demo",
      "demo-2",
    ]);
  });

  it("list 按 lastActiveAt 倒序，默认过滤 archived", async () => {
    const reg = new FsWorkSceneRegistry();
    const a = await reg.add({ name: "alpha" });
    const b = await reg.add({ name: "beta" });
    // 让 a 更晚活跃
    await new Promise((r) => setTimeout(r, 5));
    await reg.touch(a.id);

    const list = await reg.list();
    expect(list.map((s) => s.id)).toEqual([a.id, b.id]);

    await reg.setArchived(b.id, true);
    expect((await reg.list()).map((s) => s.id)).toEqual([a.id]);
    expect(
      (await reg.list({ includeArchived: true })).map((s) => s.id).sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it("rename / setArchived / touch 改 meta 并持久化", async () => {
    const reg = new FsWorkSceneRegistry();
    const s = await reg.add({ name: "old" });

    const renamed = await reg.rename(s.id, "new name");
    expect(renamed.name).toBe("new name");
    expect(renamed.id).toBe(s.id); // id 不可变
    expect((await reg.get(s.id))?.name).toBe("new name");

    await reg.setArchived(s.id, true);
    expect((await reg.get(s.id))?.archived).toBe(true);

    const before = (await reg.get(s.id))!.lastActiveAt;
    await new Promise((r) => setTimeout(r, 5));
    await reg.touch(s.id);
    expect(
      new Date((await reg.get(s.id))!.lastActiveAt).getTime(),
    ).toBeGreaterThan(new Date(before).getTime());
  });

  it("mutate 不存在的场景 → 抛错", async () => {
    const reg = new FsWorkSceneRegistry();
    await expect(reg.rename("nope", "x")).rejects.toThrow(/不存在/);
  });

  it("remove → index 摘 id + 系统目录(meta + me + conversations)物理消失", async () => {
    const reg = new FsWorkSceneRegistry();
    const s = await reg.add({ name: "to-delete" });
    const dir = getWorkSceneDir(s.id);
    // 模拟该场景已累积数据：写一份 me/ 与 conversations/ 子目录
    await fs.mkdir(path.join(dir, "me"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "me", "profile.md"),
      "# fake profile",
    );
    await fs.mkdir(path.join(dir, "conversations"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "conversations", "c-1.json"),
      "{}",
    );

    await reg.remove(s.id);

    // index 摘掉,list/get 立即失效
    expect(await reg.list()).toEqual([]);
    expect(
      JSON.parse(await fs.readFile(getWorkSceneIndexPath(), "utf-8")),
    ).toEqual({ scenes: [] });
    expect(await reg.get(s.id)).toBeNull();

    // 系统目录物理消失(meta + me + conversations 一刀清)
    await expect(fs.stat(dir)).rejects.toThrow();

    // 不会创建 trash 目录(本次需求废弃了搬 trash 语义)
    await expect(
      fs.stat(path.join(tmpDir, "trash")),
    ).rejects.toThrow();
  });

  it("remove 幂等 → 不存在的 id 不抛错(force:true 容忍)", async () => {
    const reg = new FsWorkSceneRegistry();
    // 从未 add 过的 id，直接 remove 不应抛错
    await expect(reg.remove("never-existed")).resolves.toBeUndefined();
    // 已 remove 一次后再 remove 同 id，也不抛错
    const s = await reg.add({ name: "twice" });
    await reg.remove(s.id);
    await expect(reg.remove(s.id)).resolves.toBeUndefined();
  });

  it("remove 不动 workdir(系统永不写用户代码目录)", async () => {
    const reg = new FsWorkSceneRegistry();
    // 用 tmp 下一个独立目录模拟 workdir,与 ZHIXING_HOME 物理隔离
    const userWorkdir = path.join(tmpDir, "user-code", "my-project");
    await fs.mkdir(userWorkdir, { recursive: true });
    await fs.writeFile(path.join(userWorkdir, "README.md"), "user content");
    const s = await reg.add({ name: "with-wd", workdir: userWorkdir });

    await reg.remove(s.id);

    // workdir 及其内容完全不动
    await expect(fs.stat(userWorkdir)).resolves.toBeTruthy();
    expect(
      await fs.readFile(path.join(userWorkdir, "README.md"), "utf-8"),
    ).toBe("user content");
  });

  it("跨实例持久化：新 registry 实例读到既有数据", async () => {
    const r1 = new FsWorkSceneRegistry();
    const s = await r1.add({ name: "persist" });
    const r2 = new FsWorkSceneRegistry();
    expect((await r2.list()).map((x) => x.id)).toEqual([s.id]);
    expect((await r2.get(s.id))?.name).toBe("persist");
  });
});

describe("FsWorkSceneRegistry · 并发安全", () => {
  it("同 id 并发 touch 串行化，meta.json 不损坏", async () => {
    const reg = new FsWorkSceneRegistry();
    const s = await reg.add({ name: "race" });
    await Promise.all(
      Array.from({ length: 12 }, () => reg.touch(s.id)),
    );
    // 仍是合法 JSON、字段完整
    const got = await reg.get(s.id);
    expect(got?.id).toBe(s.id);
    expect(got?.name).toBe("race");
  });

  it("并发 add 不同名 → 全部注册、index 无丢失", async () => {
    const reg = new FsWorkSceneRegistry();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => reg.add({ name: `p${i}` })),
    );
    const ids = (await reg.list()).map((s) => s.id).sort();
    expect(ids).toEqual(
      Array.from({ length: 8 }, (_, i) => `p${i}`).sort(),
    );
    const index = JSON.parse(
      await fs.readFile(getWorkSceneIndexPath(), "utf-8"),
    ) as { scenes: string[] };
    expect(index.scenes.sort()).toEqual(ids);
  });
});
