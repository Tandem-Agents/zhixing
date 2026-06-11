/**
 * SkillSavePipeline 测试 —— 四不变量焊点与 upsert 路由的验收锚。
 *
 * 管线无触发语义:这里只验"草稿进、不变量兑现、结果出";确认护栏归
 * save_skill 工具包装层(tools-builtin 侧测试)。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillStore } from "../store.js";
import { runSkillSavePipeline } from "../save-pipeline.js";
import { skillNameToId } from "../id.js";

let root: string;
let store: SkillStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-save-"));
  store = new SkillStore(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const DRAFT = {
  name: "部署流程",
  description: "要把服务部署到生产环境时",
  body: "1. 全量构建\n2. 滚动发布",
  mode: "main" as const,
};

describe("upsert 路由", () => {
  it("own 无该 id → created,落 own 区、mode 写 index", async () => {
    const r = await runSkillSavePipeline(store, DRAFT);

    expect(r.outcome).toBe("created");
    expect(r.id).toBe(skillNameToId("部署流程"));
    expect(r.scrubbedCount).toBe(0);
    const loaded = await store.loadText(r.id);
    expect(loaded.body).toContain("滚动发布");
    const index = JSON.parse(
      await fs.readFile(path.join(root, "index.json"), "utf-8"),
    ) as Array<{ id: string; mode: string }>;
    expect(index.find((s) => s.id === r.id)?.mode).toBe("main");
  });

  it("同名再存 → updated,内容覆盖、不新建目录", async () => {
    await runSkillSavePipeline(store, DRAFT);
    const r2 = await runSkillSavePipeline(store, {
      ...DRAFT,
      body: "新版本正文",
    });

    expect(r2.outcome).toBe("updated");
    expect((await store.loadText(r2.id)).body).toContain("新版本正文");
    const ownDirs = await fs.readdir(path.join(root, "own"));
    expect(ownDirs).toHaveLength(1);
  });

  it("update 保持原 mode —— 工作场景里打磨 main 技能不被静默迁到 work", async () => {
    await runSkillSavePipeline(store, DRAFT); // mode: main
    // 模拟工作场景的缺省 mode = work 的更新
    await runSkillSavePipeline(store, {
      ...DRAFT,
      body: "在 work 场景补的一条",
      mode: "work",
    });

    const index = JSON.parse(
      await fs.readFile(path.join(root, "index.json"), "utf-8"),
    ) as Array<{ id: string; mode: string }>;
    expect(index.find((s) => s.id === skillNameToId("部署流程"))?.mode).toBe(
      "main",
    );
    // 内容确实更新了
    expect(
      (await store.loadText(skillNameToId("部署流程"))).body,
    ).toContain("work 场景补的一条");
  });

  it("同名 disabled 技能 → updated 且重新启用(保存闭环:承诺可唤起就必须可见)", async () => {
    const r1 = await runSkillSavePipeline(store, DRAFT);
    await store.setState(r1.id, { disabled: true });

    const r2 = await runSkillSavePipeline(store, { ...DRAFT, body: "更新" });
    expect(r2.outcome).toBe("updated");
    // 用户亲手打磨并确认保存 = 最强启用信号:回到索引与 slash 补全视图
    const all = await store.listAll();
    expect(all.map((s) => s.id)).toContain(r2.id);
  });

  it("builtin id 保存 → created 落 own(fork-to-own,注册集原件不动)", async () => {
    const r = await runSkillSavePipeline(store, {
      name: "提炼技能",
      description: "用户定制版",
      body: "定制正文",
      mode: "main",
    });

    expect(r.outcome).toBe("created");
    // own 版从此遮蔽 builtin:loadText 出定制正文
    expect((await store.loadText(r.id)).body).toContain("定制正文");
    // own 目录真实落盘
    const ownDirs = await fs.readdir(path.join(root, "own"));
    expect(ownDirs.length).toBe(1);
  });
});

describe("凭证脱敏(不变量①)", () => {
  it("body 中的 secret 被抹掉、计数返回,落盘文件零 secret", async () => {
    const r = await runSkillSavePipeline(store, {
      ...DRAFT,
      body: "部署前 export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmn-abcd1234 然后构建",
    });

    expect(r.scrubbedCount).toBeGreaterThan(0);
    const loaded = await store.loadText(r.id);
    expect(loaded.body).not.toContain("sk-ant-api03");
    expect(loaded.body).toContain("已脱敏");
  });

  it("干净草稿计数为零", async () => {
    const r = await runSkillSavePipeline(store, DRAFT);
    expect(r.scrubbedCount).toBe(0);
  });
});

describe("索引一致性(不变量④)", () => {
  it("保存令结构版本递增 —— 下一窗口重渲染索引的触发依据", async () => {
    const before = store.version("main");
    await runSkillSavePipeline(store, DRAFT);
    expect(store.version("main")).toBeGreaterThan(before);
  });
});
