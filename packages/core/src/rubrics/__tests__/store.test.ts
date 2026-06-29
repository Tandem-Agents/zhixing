import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toSafePathSegment } from "../../paths.js";
import { RubricStore } from "../store.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rubrics-store-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeRubric(
  source: "own" | "linked",
  dir: string,
  opts: { title: string; description?: string; pass?: string; reply?: string },
): Promise<void> {
  const target = path.join(root, source, dir);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(
    path.join(target, "RUBRIC.md"),
    `---
title: ${opts.title}
description: ${opts.description ?? "场景描述"}
---

## 通过标准

- ${opts.pass ?? "完成标准"}

## 未通过时的处理

- 场景：仍未完成
  回复：${opts.reply ?? "请继续处理未满足项。"}
`,
    "utf-8",
  );
}

async function writeRaw(
  source: "own" | "linked",
  dir: string,
  content: string,
): Promise<void> {
  const target = path.join(root, source, dir);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "RUBRIC.md"), content, "utf-8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readIndex(): Promise<
  Array<{ id: string; createdAt: string; updatedAt: string }>
> {
  const raw = await fs.readFile(path.join(root, "index.json"), "utf-8");
  return JSON.parse(raw);
}

describe("RubricStore", () => {
  it("扫描 RUBRIC.md，解析协议并生成匹配索引", async () => {
    await writeRubric("own", "code", {
      title: "代码开发完成验收",
      description: "当任务要求修改代码并确认完成时使用",
    });

    const store = new RubricStore(root);
    const records = await store.listForMatching();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "代码开发完成验收",
      title: "代码开发完成验收",
      description: "当任务要求修改代码并确认完成时使用",
      source: "own",
    });
    const index = await readIndex();
    expect(index[0]?.id).toBe("代码开发完成验收");
    expect(Number.isNaN(Date.parse(index[0]?.createdAt ?? ""))).toBe(false);
  });

  it("own 同 id 遮蔽 linked", async () => {
    await writeRubric("linked", "upstream", {
      title: "同名准则",
      reply: "linked 回复",
    });
    await writeRubric("own", "local", {
      title: "同名准则",
      reply: "own 回复",
    });

    const store = new RubricStore(root);
    const records = await store.listForMatching();
    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("own");
    const loaded = await store.load("同名准则");
    expect(loaded.document.content.failureHandling[0]?.reply).toBe("own 回复");
  });

  it("坏 RUBRIC.md 被隔离，不污染索引", async () => {
    await writeRaw("own", "bad-frontmatter", "没有 frontmatter");
    await writeRaw(
      "own",
      "bad-content",
      `---
title: 坏准则
description: 缺少未通过处理
---

## 通过标准

- 有标准
`,
    );
    await writeRaw(
      "own",
      "bad-id",
      `---
id: ///
title: 身份损坏准则
description: 显式 id 无效
---

## 通过标准

- 有标准

## 未通过时的处理

- 场景：未完成
  回复：继续。
`,
    );
    await writeRubric("own", "good", { title: "好准则" });

    const store = new RubricStore(root);
    expect((await store.listForMatching()).map((record) => record.id)).toEqual([
      "好准则",
    ]);
  });

  it("saveOwn 写入 own/RUBRIC.md、登记 index，并可加载全文", async () => {
    const store = new RubricStore(root);
    const record = await store.saveOwn({
      title: "文档审查完成验收",
      description: "当任务要求审查文档是否完成时使用",
      content: {
        passCriteria: ["文档覆盖用户提出的核心需求。"],
        evidenceRequirements: ["查看目标文档内容。"],
        failureHandling: [
          {
            scenario: "覆盖不完整",
            reply: "当前文档还没有覆盖以下核心点：{missing_items}。",
          },
        ],
      },
    });

    expect(record).toMatchObject({
      id: "文档审查完成验收",
      source: "own",
    });
    const dir = path.join(root, "own", toSafePathSegment(record.id));
    expect(await exists(path.join(dir, "RUBRIC.md"))).toBe(true);
    expect(await fs.readFile(path.join(dir, "RUBRIC.md"), "utf-8")).toContain(
      "id: 文档审查完成验收",
    );
    expect((await readIndex())[0]?.id).toBe(record.id);

    const loaded = await store.load(record.id);
    expect(loaded.document.content.passCriteria).toEqual([
      "文档覆盖用户提出的核心需求。",
    ]);
  });

  it("Rubric 标题被编辑后仍按固化 id 加载同一资产", async () => {
    const store = new RubricStore(root);
    const record = await store.saveOwn({
      title: "初始验收准则",
      description: "用于验证稳定身份",
      content: {
        passCriteria: ["结果可核对。"],
        failureHandling: [{ scenario: "未完成", reply: "继续处理。" }],
      },
    });
    const file = path.join(record.dir, "RUBRIC.md");
    const raw = await fs.readFile(file, "utf-8");
    await fs.writeFile(
      file,
      raw.replace("title: 初始验收准则", "title: 改名后的验收准则"),
      "utf-8",
    );

    const loaded = await store.load(record.id);
    expect(loaded.id).toBe(record.id);
    expect(loaded.title).toBe("改名后的验收准则");
    expect(loaded.document.id).toBe(record.id);

    const records = await store.listForMatching();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: record.id,
      title: "改名后的验收准则",
    });
    expect((await readIndex()).map((item) => item.id)).toEqual([record.id]);
  });

  it("saveOwn 撞名即拒绝", async () => {
    await writeRubric("own", "existing", { title: "重复准则" });
    const store = new RubricStore(root);

    await expect(
      store.saveOwn({
        title: "重复准则",
        description: "重复",
        content: {
          passCriteria: ["完成"],
          failureHandling: [{ scenario: "未完成", reply: "继续。" }],
        },
      }),
    ).rejects.toThrow();
  });

  it("archive 移入 archived，own 被移走后 linked 版本重新可见", async () => {
    await writeRubric("linked", "linked", {
      title: "可归档准则",
      reply: "linked 回复",
    });
    await writeRubric("own", "own", {
      title: "可归档准则",
      reply: "own 回复",
    });

    const store = new RubricStore(root);
    await store.archive("可归档准则");

    expect((await store.listForMatching())[0]?.source).toBe("linked");
    const archived = await fs.readdir(path.join(root, "archived"));
    expect(archived).toHaveLength(1);
    expect(
      await exists(path.join(root, "archived", archived[0]!, "RUBRIC.md")),
    ).toBe(true);
  });

  it("指向库外的软链被边界拒绝", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rubrics-outside-"));
    try {
      await fs.mkdir(path.join(outside, "evil"), { recursive: true });
      await fs.writeFile(
        path.join(outside, "evil", "RUBRIC.md"),
        `---
title: 越界准则
description: 不应读取
---

## 通过标准

- 不应出现

## 未通过时的处理

- 场景：越界
  回复：不应出现
`,
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
      if (!symlinkOk) return;

      const store = new RubricStore(root);
      expect(await store.listForMatching()).toEqual([]);
      await expect(store.load("越界准则")).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
