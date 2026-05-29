import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillStore } from "../store.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-fa-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeSkill(
  source: "own" | "linked",
  dir: string,
  opts: { name: string; body?: string; attach?: { name: string; content: Uint8Array | string } },
): Promise<void> {
  const d = path.join(root, source, dir);
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(
    path.join(d, "SKILL.md"),
    `---\nname: ${opts.name}\n---\n${opts.body ?? "body"}`,
    "utf-8",
  );
  if (opts.attach) {
    await fs.writeFile(path.join(d, opts.attach.name), opts.attach.content);
  }
}

async function makeStaging(
  name: string | null,
  body: string,
  extra?: (dir: string) => Promise<void>,
): Promise<string> {
  const parent = path.join(root, ".staging");
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, "s-"));
  const fm = name === null ? "" : `name: ${name}\n`;
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${fm}---\n${body}`, "utf-8");
  if (extra) await extra(dir);
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readIndexFile(): Promise<Array<{ id: string; mode: string; pinned: boolean }>> {
  return JSON.parse(await fs.readFile(path.join(root, "index.json"), "utf-8"));
}

describe("SkillStore fork", () => {
  it("linked → own copy,原 linked 不动", async () => {
    await writeSkill("linked", "x", { name: "Tool", body: "LINKED-BODY" });
    const store = new SkillStore(root);
    const rec = await store.fork("tool");
    expect(rec.source).toBe("own");
    expect(await exists(path.join(root, "own", "tool", "SKILL.md"))).toBe(true);
    expect(await exists(path.join(root, "linked", "x", "SKILL.md"))).toBe(true);
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.source).toBe("own");
    expect((await store.loadText("tool")).body).toBe("LINKED-BODY");
  });

  it("复制附属文件", async () => {
    await writeSkill("linked", "x", {
      name: "Tool",
      attach: { name: "ref.txt", content: "REF" },
    });
    const store = new SkillStore(root);
    await store.fork("tool");
    expect(
      await fs.readFile(path.join(root, "own", "tool", "ref.txt"), "utf-8"),
    ).toBe("REF");
  });

  it("无 linked 版本即抛", async () => {
    await writeSkill("own", "y", { name: "Solo" });
    const store = new SkillStore(root);
    await expect(store.fork("solo")).rejects.toThrow();
  });

  it("已有 own 版本即抛", async () => {
    await writeSkill("linked", "x", { name: "Dup" });
    await writeSkill("own", "z", { name: "Dup" });
    const store = new SkillStore(root);
    await expect(store.fork("dup")).rejects.toThrow();
  });

  it("linked 含符号链接即拒、不留半成品(创建软链失败则跳过)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skills-out-"));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "SECRET", "utf-8");
      await writeSkill("linked", "x", { name: "Sym" });
      let symlinkOk = true;
      try {
        await fs.symlink(
          path.join(outside, "secret.txt"),
          path.join(root, "linked", "x", "link.txt"),
        );
      } catch {
        symlinkOk = false;
      }
      if (!symlinkOk) return;
      const store = new SkillStore(root);
      await expect(store.fork("sym")).rejects.toThrow();
      expect(await exists(path.join(root, "own", "sym"))).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("SkillStore update", () => {
  it("own 技能改正文", async () => {
    await writeSkill("own", "a", { name: "A", body: "OLD" });
    const store = new SkillStore(root);
    await store.update("a", { name: "A", description: "d", body: "NEW", mode: "main" });
    expect((await store.loadText("a")).body).toBe("NEW");
  });

  it("linked-only 触发 fork-on-edit,原 linked 不动", async () => {
    await writeSkill("linked", "x", { name: "Lnk", body: "OLD" });
    const store = new SkillStore(root);
    const rec = await store.update("lnk", {
      name: "Lnk",
      description: "",
      body: "NEW",
      mode: "work",
    });
    expect(rec.source).toBe("own");
    expect((await store.loadText("lnk")).body).toBe("NEW");
    expect(
      await fs.readFile(path.join(root, "linked", "x", "SKILL.md"), "utf-8"),
    ).toContain("OLD");
  });

  it("改名:迁移状态(保 pinned)、旧 id 消失", async () => {
    await writeSkill("own", "a", { name: "Old Name" });
    const store = new SkillStore(root);
    await store.listAll();
    await store.setState("old-name", { pinned: true });
    await store.update("old-name", {
      name: "New Name",
      description: "",
      body: "b",
      mode: "work",
    });
    const all = await store.listAll();
    expect(all.map((r) => r.id)).toEqual(["new-name"]);
    expect(all[0]!.pinned).toBe(true);
    expect(all[0]!.mode).toBe("work");
    const idx = await readIndexFile();
    expect(idx.find((s) => s.id === "old-name")).toBeUndefined();
    expect(idx.find((s) => s.id === "new-name")!.pinned).toBe(true);
  });

  it("改名撞已存在 id 即抛", async () => {
    await writeSkill("own", "a", { name: "A" });
    await writeSkill("own", "b", { name: "B" });
    const store = new SkillStore(root);
    await expect(
      store.update("a", { name: "B", description: "", body: "b", mode: "main" }),
    ).rejects.toThrow();
  });
});

describe("SkillStore admit", () => {
  it("从暂存接入到 linked,可加载", async () => {
    const staging = await makeStaging("Imported", "IMP-BODY");
    const store = new SkillStore(root);
    const rec = await store.admit(staging);
    expect(rec.id).toBe("imported");
    expect(rec.source).toBe("linked");
    expect(rec.mode).toBe("main");
    expect((await store.loadText("imported")).body).toBe("IMP-BODY");
    expect((await store.listAll()).map((r) => r.id)).toContain("imported");
  });

  it("mode 接入时选定", async () => {
    const staging = await makeStaging("Imp2", "b");
    const store = new SkillStore(root);
    await store.admit(staging, { mode: "work" });
    expect((await readIndexFile()).find((s) => s.id === "imp2")!.mode).toBe("work");
  });

  it("撞名即拒", async () => {
    await writeSkill("own", "x", { name: "Dup" });
    const staging = await makeStaging("Dup", "b");
    const store = new SkillStore(root);
    await expect(store.admit(staging)).rejects.toThrow();
  });

  it("无 name 即拒", async () => {
    const staging = await makeStaging(null, "b");
    const store = new SkillStore(root);
    await expect(store.admit(staging)).rejects.toThrow();
  });

  it("二进制附属文件逐字节保真", async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f]);
    const staging = await makeStaging("Bin", "b", async (dir) => {
      await fs.writeFile(path.join(dir, "img.bin"), bytes);
    });
    const store = new SkillStore(root);
    await store.admit(staging);
    const back = await fs.readFile(path.join(root, "linked", "bin", "img.bin"));
    expect(Buffer.compare(back, Buffer.from(bytes))).toBe(0);
  });

  it("暂存含符号链接即拒、不留半成品(创建软链失败则跳过)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skills-out-"));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "SECRET", "utf-8");
      const staging = await makeStaging("Sym", "b");
      let symlinkOk = true;
      try {
        await fs.symlink(
          path.join(outside, "secret.txt"),
          path.join(staging, "link.txt"),
        );
      } catch {
        symlinkOk = false;
      }
      if (!symlinkOk) return;
      const store = new SkillStore(root);
      await expect(store.admit(staging)).rejects.toThrow();
      expect(await exists(path.join(root, "linked", "sym"))).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("目录名 ≠ id 时写入不覆盖既有技能(reserveDir)", () => {
  it("改名后重建同名:旧技能不被覆盖,各占独立目录", async () => {
    const store = new SkillStore(root);
    await store.create({ name: "A", description: "", body: "A-BODY", mode: "main" });
    await store.update("a", { name: "B", description: "", body: "B-BODY", mode: "main" });
    // 此刻 own/a 物理目录持有 id "b"
    await store.create({ name: "A", description: "", body: "A2-BODY", mode: "main" });
    expect((await store.listAll()).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect((await store.loadText("b")).body).toBe("B-BODY");
    expect((await store.loadText("a")).body).toBe("A2-BODY");
  });

  it("admit 命中被占用的 linked 目录:不覆盖", async () => {
    await writeSkill("linked", "imported", { name: "Other", body: "OTHER" });
    const staging = await makeStaging("Imported", "IMP");
    const store = new SkillStore(root);
    await store.admit(staging);
    expect((await store.loadText("other")).body).toBe("OTHER");
    expect((await store.loadText("imported")).body).toBe("IMP");
  });
});
