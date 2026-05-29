import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillStore } from "../store.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-staging-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("SkillStore — 暂存管理 + 接入端到端", () => {
  it("prepareStaging 建唯一空目录、落在 .staging 区内", async () => {
    const store = new SkillStore(root);
    const a = await store.prepareStaging();
    const b = await store.prepareStaging();
    expect(a).not.toBe(b);
    expect((await fs.stat(a)).isDirectory()).toBe(true);
    const rel = path.relative(path.join(root, ".staging"), a);
    expect(rel.startsWith("..")).toBe(false);
  });

  it("放候选 → admit 落 linked → discardStaging 清暂存", async () => {
    const store = new SkillStore(root);
    const staging = await store.prepareStaging();
    await fs.writeFile(
      path.join(staging, "SKILL.md"),
      "---\nname: 接入技能\ndescription: 测试\n---\n正文",
      "utf-8",
    );

    const rec = await store.admit(staging, { mode: "main" });
    expect(rec.source).toBe("linked");
    expect(rec.name).toBe("接入技能");
    expect((await fs.stat(path.join(rec.dir, "SKILL.md"))).isFile()).toBe(true);

    await store.discardStaging(staging);
    expect(await exists(staging)).toBe(false);
  });

  it("discardStaging 拒绝 .staging 区外的路径(防误删)", async () => {
    const store = new SkillStore(root);
    const outside = path.join(root, "own");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "keep.txt"), "x", "utf-8");

    await store.discardStaging(outside); // 不在 .staging 内 → 忽略、不删
    expect(await exists(outside)).toBe(true);
  });
});
