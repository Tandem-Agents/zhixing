import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTempDir } from "../temp-dir.js";

describe("createTempDir — 基本契约", () => {
  it("创建的目录真实存在且 prefix 匹配 zhixing-test-{label}-", async () => {
    const dir = await createTempDir("alpha");
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(path.basename(dir).startsWith("zhixing-test-alpha-")).toBe(true);
    expect(path.dirname(dir)).toBe(os.tmpdir());
  });

  it("同一 test 多次调用得到不同目录（mkdtemp 自带随机后缀）", async () => {
    const a = await createTempDir("multi");
    const b = await createTempDir("multi");
    expect(a).not.toBe(b);
  });

  it("不同 label 落在不同语义 prefix 的目录", async () => {
    const a = await createTempDir("foo");
    const b = await createTempDir("bar");
    expect(path.basename(a).startsWith("zhixing-test-foo-")).toBe(true);
    expect(path.basename(b).startsWith("zhixing-test-bar-")).toBe(true);
  });
});

describe("createTempDir — label 格式校验", () => {
  it("空字符串抛错", async () => {
    await expect(createTempDir("")).rejects.toThrow(/必须是小写 kebab/);
  });

  it("含大写字母抛错", async () => {
    await expect(createTempDir("Foo")).rejects.toThrow(/必须是小写 kebab/);
  });

  it("含下划线抛错", async () => {
    await expect(createTempDir("a_b")).rejects.toThrow(/必须是小写 kebab/);
  });

  it("含空格抛错", async () => {
    await expect(createTempDir("a b")).rejects.toThrow(/必须是小写 kebab/);
  });

  it("含点号抛错", async () => {
    await expect(createTempDir("a.b")).rejects.toThrow(/必须是小写 kebab/);
  });

  it("纯数字 / 纯连字符 / 含数字-连字符 都接受", async () => {
    expect((await createTempDir("123")).length).toBeGreaterThan(0);
    expect((await createTempDir("a-b-c")).length).toBeGreaterThan(0);
    expect((await createTempDir("v2-x")).length).toBeGreaterThan(0);
  });
});

describe("createTempDir — beforeEach 模式", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await createTempDir("before-each");
  });

  it("beforeEach 中创建的 dir 在 it 中可读写", async () => {
    expect(await fs.stat(dir)).toBeDefined();
    await fs.writeFile(path.join(dir, "marker"), "ok");
    const content = await fs.readFile(path.join(dir, "marker"), "utf8");
    expect(content).toBe("ok");
  });

  it("每个 test 拿到独立的 dir（无 marker 残留）", async () => {
    const items = await fs.readdir(dir);
    expect(items).toEqual([]);
  });
});

describe("createTempDir — 错误上下文 fail-safe", () => {
  // 在 beforeAll 内调用 createTempDir 应抛 user-friendly Error——onTestFinished
  // 没有"当前 test"概念。这是 helper 的核心安全承诺，必须有测试守护，否则
  // vitest 升级若改变 onTestFinished 在 beforeAll 中的行为，fail-safe 会静默失效。
  let captured: unknown;
  beforeAll(async () => {
    try {
      await createTempDir("should-fail-in-before-all");
    } catch (err) {
      captured = err;
    }
  });

  it("beforeAll 中调用应抛 user-friendly Error", () => {
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(
      /必须在 vitest 测试上下文内调用/,
    );
  });
});

describe("createTempDir — 自动清理", () => {
  // 跨 test 验证清理：在前一个 test 把 dir 写入 module-level 变量，下一个
  // test 检查这个 dir 在新 test 开始时已被 rm（onTestFinished 注册的清理在
  // 前 test 结束后跑）
  let leakedDirFromPriorTest: string | null = null;

  it("第一个 test：创建 dir 并保存路径供下个 test 验证", async () => {
    const dir = await createTempDir("cleanup-check");
    leakedDirFromPriorTest = dir;
    expect(await fs.stat(dir)).toBeDefined();
  });

  it("第二个 test：上一个 test 的 dir 已被自动清理", async () => {
    expect(leakedDirFromPriorTest).not.toBeNull();
    const exists = await fs
      .stat(leakedDirFromPriorTest!)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});
