/**
 * 文件写入原语测试 —— 原子替换（双平台路径）与崩溃残留 tmp 的收尾
 * （能恢复则恢复，其余清理）。
 */

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { recoverOrphanTmp, writeAtomic } from "../serializer.js";

let dir: string;

beforeEach(async () => {
  dir = await createTempDir("serializer");
});

describe("writeAtomic", () => {
  it("POSIX 路径：原子覆盖既有内容", async () => {
    const file = path.join(dir, "a.json");
    await writeAtomic(file, "v1", { platform: "linux" });
    await writeAtomic(file, "v2", { platform: "linux" });
    expect(await fs.readFile(file, "utf-8")).toBe("v2");
  });

  it("win32 fallback 路径：unlink → rename 同样落成新内容", async () => {
    const file = path.join(dir, "b.json");
    await writeAtomic(file, "v1", { platform: "win32" });
    await writeAtomic(file, "v2", { platform: "win32" });
    expect(await fs.readFile(file, "utf-8")).toBe("v2");
  });

  it("目标目录不存在时自动创建", async () => {
    const file = path.join(dir, "deep", "nested", "c.json");
    await writeAtomic(file, "x", { platform: "linux" });
    expect(await fs.readFile(file, "utf-8")).toBe("x");
  });

  it("成功写入后不留 .tmp 残留", async () => {
    const file = path.join(dir, "d.json");
    await writeAtomic(file, "x", { platform: "linux" });
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});

describe("recoverOrphanTmp", () => {
  it("目标文件存在 → 清理孤立 tmp，不误删他人文件、不动目标", async () => {
    const target = path.join(dir, "index.json");
    await fs.writeFile(`${target}.123-456-abc.tmp`, "orphan", "utf-8");
    await fs.writeFile(path.join(dir, "other.tmp"), "keep", "utf-8");
    await fs.writeFile(target, "real", "utf-8");

    await recoverOrphanTmp(target);

    const entries = await fs.readdir(dir);
    expect(entries).toContain("other.tmp");
    expect(entries).toContain("index.json");
    expect(entries.filter((e) => e.startsWith("index.json."))).toEqual([]);
    expect(await fs.readFile(target, "utf-8")).toBe("real");
  });

  it("替换窗口崩溃形态（目标缺失 + tmp 在）→ tmp 恢复为目标", async () => {
    // win32 写序：写 tmp 完成 → unlink 旧文件 →〔崩溃〕→ rename 未执行。
    // 该形态下 tmp 必为完整新内容（unlink 只发生在 tmp 落盘后）。
    const target = path.join(dir, "index.json");
    await fs.writeFile(`${target}.123-456-abc.tmp`, "recovered", "utf-8");

    await recoverOrphanTmp(target);

    expect(await fs.readFile(target, "utf-8")).toBe("recovered");
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("多个 tmp（多次崩溃叠加）→ 按文件名内嵌时间戳取最新恢复，其余清理", async () => {
    const target = path.join(dir, "index.json");
    await fs.writeFile(`${target}.99-1000-old.tmp`, "older", "utf-8");
    await fs.writeFile(`${target}.99-2000-new.tmp`, "newest", "utf-8");
    await fs.writeFile(`${target}.99-1500-mid.tmp`, "middle", "utf-8");

    await recoverOrphanTmp(target);

    expect(await fs.readFile(target, "utf-8")).toBe("newest");
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("目录不存在时静默", async () => {
    await expect(
      recoverOrphanTmp(path.join(dir, "nope", "x.json")),
    ).resolves.toBeUndefined();
  });
});
