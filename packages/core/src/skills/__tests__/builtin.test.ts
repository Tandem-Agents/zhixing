/**
 * builtin 来源区边界测试 —— 负向断言为主:失守即把系统能力重新暴露成用户入口。
 *
 * 钉死读视图规则:索引含(双池、按注册集模式)、loadText 可读不写 usage、
 * listAll / listForManagement 零暴露、own 同名遮蔽、不进 index.json、
 * 分池不挤占用户 top-N。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillStore } from "../store.js";
import {
  getBuiltinSkill,
  builtinIndexEntries,
  type BuiltinIndexEntry,
} from "../builtin.js";
import { skillNameToId } from "../id.js";

/** 首份内置能力的 id —— 与注册集 name 同源派生,测试不硬编码字符串拼写。 */
const DISTILL_ID = skillNameToId("提炼技能");

let root: string;
let store: SkillStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-builtin-"));
  store = new SkillStore(root);
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

describe("builtin 注册集", () => {
  it("「提炼技能」已登记:全模式可见、description 以何时用为导向", () => {
    const entry = getBuiltinSkill(DISTILL_ID);
    expect(entry).not.toBeNull();
    expect(entry!.modes).toEqual(["main", "work"]);
    expect(entry!.description.length).toBeGreaterThan(0);
    expect(entry!.body).toContain("何时提议");
  });

  it("索引拼池:main 与 work 模式都含「提炼技能」(注册集声明,不走用户 mode 状态)", () => {
    for (const mode of ["main", "work"] as const) {
      const entries = builtinIndexEntries(mode, new Set());
      expect(entries.map((e: BuiltinIndexEntry) => e.id)).toContain(DISTILL_ID);
    }
  });

  it("工具预算红线:每能力 ≤ 1 工具(膨胀即触发暴露形态切换裁决,不得静默超)", () => {
    const entry = getBuiltinSkill(DISTILL_ID)!;
    expect(entry.tools).toEqual(["save_skill"]);
    expect((entry.tools ?? []).length).toBeLessThanOrEqual(1);
  });
});

describe("builtin 读视图边界(负向)", () => {
  it("listAll 不含 builtin —— slash 补全零暴露", async () => {
    await writeSkill("own", "user-skill", { name: "用户技能" });
    const all = await store.listAll();
    expect(all.map((r) => r.id)).not.toContain(DISTILL_ID);
  });

  it("listForManagement 不含 builtin —— 管理列表零暴露", async () => {
    await writeSkill("own", "user-skill", { name: "用户技能" });
    const managed = await store.listForManagement();
    expect(managed.map((r) => r.id)).not.toContain(DISTILL_ID);
  });

  it("queryTopN(用户池)不含 builtin —— builtin 只经独立拼池进索引", async () => {
    await writeSkill("own", "user-skill", { name: "用户技能" });
    const top = await store.queryTopN("main", 10);
    expect(top.map((r) => r.id)).not.toContain(DISTILL_ID);
  });

  it("loadText(builtin) 可读全文,且不写 usage、不进 index.json", async () => {
    const loaded = await store.loadText(DISTILL_ID);
    expect(loaded.name).toBe("提炼技能");
    expect(loaded.body).toContain("保存");

    // 零状态记录:usage 目录无该 id 文件;index.json 不存在或无该 id
    await expect(
      fs.access(path.join(root, "usage", `${DISTILL_ID}.json`)),
    ).rejects.toThrow();
    let indexIds: string[] = [];
    try {
      const raw = await fs.readFile(path.join(root, "index.json"), "utf-8");
      indexIds = (JSON.parse(raw) as Array<{ id: string }>).map((s) => s.id);
    } catch {
      // index.json 不存在 = 同样满足"不进 index.json"
    }
    expect(indexIds).not.toContain(DISTILL_ID);
  });

  it("loadText 对目录技能照常写 usage(分支不影响既有行为)", async () => {
    await writeSkill("own", "user-skill", { name: "用户技能" });
    const id = skillNameToId("用户技能");
    await store.loadText(id);
    const usage = JSON.parse(
      await fs.readFile(path.join(root, "usage", `${id}.json`), "utf-8"),
    ) as { hitCount: number };
    expect(usage.hitCount).toBe(1);
  });
});

describe("own 同名遮蔽 builtin(fork-to-own 生效)", () => {
  it("own 存在同名技能时 loadText 返回用户版", async () => {
    await writeSkill("own", "distill-fork", {
      name: "提炼技能",
      body: "用户定制版内容",
    });
    const loaded = await store.loadText(DISTILL_ID);
    expect(loaded.body).toContain("用户定制版内容");
  });

  it("索引拼池对被遮蔽 id 不再产 builtin 条目(展示与加载一致)", () => {
    const entries = builtinIndexEntries("main", new Set([DISTILL_ID]));
    expect(entries.map((e) => e.id)).not.toContain(DISTILL_ID);
  });
});

describe("builtin 分池不挤占用户 top-N", () => {
  it("用户技能满 N 时全员仍在,builtin 在池外另列", async () => {
    for (let i = 0; i < 3; i++) {
      await writeSkill("own", `s${i}`, { name: `技能${i}` });
    }
    const n = 3;
    const userTopN = await store.queryTopN("main", n);
    expect(userTopN).toHaveLength(n); // builtin 不占用户名额

    const composed = [
      ...userTopN,
      ...builtinIndexEntries("main", new Set(userTopN.map((r) => r.id))),
    ];
    expect(composed.length).toBe(n + 1); // 用户满额 + builtin 另列
    expect(composed.map((e) => e.id)).toContain(DISTILL_ID);
  });
});
