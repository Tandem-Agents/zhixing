/**
 * FileProvider 单元测试
 *
 * 覆盖点：
 *   - matchTrigger: 显式 @file: / 裸 @path / 空 @ / 非 file 前缀 / boundary
 *   - 路径解析：相对路径 / ~/ / 绝对路径 / ../
 *   - query: 目录列表 + 前缀过滤 + 目录优先排序
 *   - 隐藏文件：显式前缀时显示，裸 @path 时隐藏
 *   - isOutsideWorkspace 标记
 *   - AbortSignal 取消
 *   - 不存在的目录 → 空结果
 *   - maxResults 上限
 *   - acceptPayload 结构（execute=false，replacement 带 @file: 前缀）
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDescribeTempDir } from "@zhixing/test-utils";
import { FileProvider } from "../providers/file-provider.js";
import type { RuntimeContext, TriggerContext, TriggerMatch } from "../types.js";

// ─── 临时目录结构 ───

const tmpRootDir = createDescribeTempDir("file-provider");
let provider: FileProvider;

/**
 * 测试用目录结构：
 *   tmpRoot/
 *     src/
 *       index.ts    (空文件)
 *       utils/
 *         helper.ts (空文件)
 *     docs/
 *       readme.md   (空文件)
 *     .hidden/
 *       secret.txt  (空文件)
 *     .gitignore    (空文件)
 *     package.json  (空文件)
 *     tsconfig.json (空文件)
 */
beforeAll(async () => {
  const tmpRoot = tmpRootDir.getDir();

  // 创建目录
  await fs.mkdir(path.join(tmpRoot, "src", "utils"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, "docs"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".hidden"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, "dynamic-a"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, "dynamic-b"), { recursive: true });

  // 创建文件
  const files = [
    "src/index.ts",
    "src/utils/helper.ts",
    "docs/readme.md",
    ".hidden/secret.txt",
    ".gitignore",
    "package.json",
    "tsconfig.json",
    "dynamic-a/a-only.txt",
    "dynamic-b/b-only.txt",
  ];
  for (const f of files) {
    await fs.writeFile(path.join(tmpRoot, f), "", "utf-8");
  }

  provider = new FileProvider({ root: tmpRoot });
});

// ─── 辅助 ───

function makeCtx(
  draft: string,
  cursor = draft.length,
  overrides: Partial<TriggerContext> = {},
): TriggerContext {
  return {
    draft,
    cursor,
    mode: "prompt",
    runtime: makeRuntime(),
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: "/tmp",
    target: "cli",
    features: {},
    now: 1_700_000_000_000,
    ...overrides,
  };
}

function noAbort(): AbortSignal {
  return new AbortController().signal;
}

// ─── matchTrigger ───

describe("FileProvider.matchTrigger", () => {
  it("显式 @file: 前缀触发", () => {
    const m = provider.matchTrigger(makeCtx("@file:src/index.ts"));
    expect(m).not.toBeNull();
    expect(m!.providerId).toBe("file");
    expect(m!.query).toBe("src/index.ts");
    expect((m!.providerData as { explicit: boolean }).explicit).toBe(true);
  });

  it("显式 @file: 空路径触发", () => {
    const m = provider.matchTrigger(makeCtx("@file:"));
    expect(m).not.toBeNull();
    expect(m!.query).toBe("");
    expect((m!.providerData as { explicit: boolean }).explicit).toBe(true);
  });

  it("裸 @path 触发", () => {
    const m = provider.matchTrigger(makeCtx("@src/foo"));
    expect(m).not.toBeNull();
    expect(m!.query).toBe("src/foo");
    expect((m!.providerData as { explicit: boolean }).explicit).toBe(false);
  });

  it("裸 @word 触发（非空 query 即匹配）", () => {
    const m = provider.matchTrigger(makeCtx("@package"));
    expect(m).not.toBeNull();
    expect(m!.query).toBe("package");
  });

  it("空 @ 不触发", () => {
    const m = provider.matchTrigger(makeCtx("@"));
    expect(m).toBeNull();
  });

  it("@memory: 前缀不触发（让出给 MemoryProvider）", () => {
    const m = provider.matchTrigger(makeCtx("@memory:greeting"));
    expect(m).toBeNull();
  });

  it("@tool: 前缀不触发（让出给 ToolProvider）", () => {
    const m = provider.matchTrigger(makeCtx("@tool:search"));
    expect(m).toBeNull();
  });

  it("requireBoundary 生效 —— 前面紧跟非空白不触发", () => {
    // email@test 中 @ 前是 l，不是空白
    const m = provider.matchTrigger(makeCtx("email@test"));
    expect(m).toBeNull();
  });

  it("空格后 @path 触发", () => {
    const m = provider.matchTrigger(makeCtx("请查看 @src/index.ts"));
    expect(m).not.toBeNull();
    expect(m!.query).toBe("src/index.ts");
  });

  it("cursor 在 @ 前 —— 不触发", () => {
    // cursor 停在 "请查看" 的末尾（4），还没到 @
    const m = provider.matchTrigger(makeCtx("请查看 @src/index.ts", 4));
    expect(m).toBeNull();
  });
});

// ─── query: 基础目录列表 ───

describe("FileProvider.query", () => {
  it("列出 workspace root 的非隐藏内容（裸 @path 前缀过滤）", async () => {
    const match = provider.matchTrigger(makeCtx("@s"))!;
    const items = await provider.query(match, noAbort());

    // 应该只返回以 "s" 开头的条目：src/
    expect(items.length).toBe(1);
    expect(items[0]!.displayText).toBe("src/");
    expect(items[0]!.description).toBe("src");
  });

  it("列出子目录内容", async () => {
    const match = provider.matchTrigger(makeCtx("@file:src/"))!;
    const items = await provider.query(match, noAbort());

    const names = items.map((i) => i.displayText);
    // src/ 下有 utils/ 和 index.ts
    expect(names).toContain("utils/");
    expect(names).toContain("index.ts");
    // 目录排在文件前面
    expect(names.indexOf("utils/")).toBeLessThan(names.indexOf("index.ts"));
  });

  it("前缀过滤子目录内容", async () => {
    const match = provider.matchTrigger(makeCtx("@file:src/i"))!;
    const items = await provider.query(match, noAbort());

    expect(items.length).toBe(1);
    expect(items[0]!.displayText).toBe("index.ts");
    expect(items[0]!.description).toBe("src/index.ts");
  });

  it("前缀过滤大小写不敏感", async () => {
    const match = provider.matchTrigger(makeCtx("@file:src/I"))!;
    const items = await provider.query(match, noAbort());

    expect(items.length).toBe(1);
    expect(items[0]!.displayText).toBe("index.ts");
  });

  it("root 函数在每次 query 读取当前 workspace", async () => {
    let root = path.join(tmpRootDir.getDir(), "dynamic-a");
    const dynamicProvider = new FileProvider({ root: () => root });
    const match = dynamicProvider.matchTrigger(makeCtx("@file:"))!;

    const first = await dynamicProvider.query(match, noAbort());
    expect(first.map((i) => i.displayText)).toEqual(["a-only.txt"]);

    root = path.join(tmpRootDir.getDir(), "dynamic-b");
    const second = await dynamicProvider.query(match, noAbort());
    expect(second.map((i) => i.displayText)).toEqual(["b-only.txt"]);
  });
});

// ─── 隐藏文件 ───

describe("FileProvider 隐藏文件", () => {
  it("裸 @ 不显示隐藏文件", async () => {
    // 裸 @ 列 root —— 列 "d" 前缀
    const match = provider.matchTrigger(makeCtx("@d"))!;
    const items = await provider.query(match, noAbort());

    expect(items.some((i) => i.displayText === "docs/")).toBe(true);

    // 再列全部（用 "." 前缀过滤）—— 裸 @ 不显示隐藏
    const match2 = provider.matchTrigger(makeCtx("@."))!;
    const items2 = await provider.query(match2, noAbort());
    expect(items2.length).toBe(0);
  });

  it("显式 @file: 显示隐藏文件", async () => {
    const match = provider.matchTrigger(makeCtx("@file:."))!;
    const items = await provider.query(match, noAbort());

    const names = items.map((i) => i.displayText);
    expect(names).toContain(".hidden/");
    expect(names).toContain(".gitignore");
  });
});

// ─── isOutsideWorkspace ───

describe("FileProvider.isOutsideWorkspace", () => {
  it("workspace 内的文件标记 isOutsideWorkspace=false", async () => {
    const match = provider.matchTrigger(makeCtx("@file:src/"))!;
    const items = await provider.query(match, noAbort());

    for (const item of items) {
      const meta = item.acceptPayload.metadata as {
        isOutsideWorkspace: boolean;
      };
      expect(meta.isOutsideWorkspace).toBe(false);
    }
  });

  it("~/ 路径标记 isOutsideWorkspace=true", async () => {
    const match = provider.matchTrigger(makeCtx("@file:~/"))!;
    const items = await provider.query(match, noAbort());

    // home 目录大概率不在 tmpRoot 内
    if (items.length > 0) {
      const meta = items[0]!.acceptPayload.metadata as {
        isOutsideWorkspace: boolean;
      };
      expect(meta.isOutsideWorkspace).toBe(true);
    }
  });
});

// ─── acceptPayload ───

describe("FileProvider.acceptPayload", () => {
  it("文件的 execute=false，replacement 带 @file: 前缀 + 尾部空格", async () => {
    const match = provider.matchTrigger(makeCtx("@file:src/i"))!;
    const items = await provider.query(match, noAbort());

    const item = items[0]!;
    expect(item.acceptPayload.execute).toBe(false);
    // 文件加尾部空格打断 trigger token，用户可直接继续输入
    expect(item.acceptPayload.replacement).toBe("@file:src/index.ts ");
  });

  it("目录的 replacement 以 / 结尾", async () => {
    const match = provider.matchTrigger(makeCtx("@file:src/u"))!;
    const items = await provider.query(match, noAbort());

    const item = items[0]!;
    expect(item.acceptPayload.replacement).toBe("@file:src/utils/");
  });

  it("metadata 包含 resolvedPath 和 isDirectory", async () => {
    const match = provider.matchTrigger(makeCtx("@file:src/i"))!;
    const items = await provider.query(match, noAbort());

    const meta = items[0]!.acceptPayload.metadata as Record<string, unknown>;
    expect(meta.resolvedPath).toContain("src");
    expect(meta.resolvedPath).toContain("index.ts");
    expect(meta.isDirectory).toBe(false);
    // resolvedPath 是正斜杠
    expect((meta.resolvedPath as string).includes("\\")).toBe(false);
  });
});

// ─── AbortSignal ───

describe("FileProvider AbortSignal", () => {
  it("query 前 abort → 空结果", async () => {
    const ac = new AbortController();
    ac.abort();
    const match = provider.matchTrigger(makeCtx("@file:src/"))!;
    const items = await provider.query(match, ac.signal);
    expect(items).toEqual([]);
  });
});

// ─── 不存在的目录 ───

describe("FileProvider 边界情况", () => {
  it("不存在的目录 → 空结果", async () => {
    const match = provider.matchTrigger(makeCtx("@file:nonexistent/"))!;
    const items = await provider.query(match, noAbort());
    expect(items).toEqual([]);
  });

  it("显式 @file: 空路径列 workspace root", async () => {
    const match = provider.matchTrigger(makeCtx("@file:"))!;
    const items = await provider.query(match, noAbort());

    // 显式模式，包含隐藏文件
    const names = items.map((i) => i.displayText);
    expect(names).toContain("src/");
    expect(names).toContain("docs/");
    expect(names).toContain("package.json");
    expect(names).toContain(".gitignore");
    expect(names).toContain(".hidden/");
  });
});

// ─── maxResults ───

describe("FileProvider maxResults", () => {
  it("超过 maxResults 的条目被截断", async () => {
    const smallProvider = new FileProvider({ root: tmpRootDir.getDir(), maxResults: 2 });
    const match = smallProvider.matchTrigger(makeCtx("@file:"))!;
    const items = await smallProvider.query(match, noAbort());

    expect(items.length).toBeLessThanOrEqual(2);
  });
});

// ─── 排序 ───

describe("FileProvider 排序", () => {
  it("目录排在文件前面", async () => {
    const match = provider.matchTrigger(makeCtx("@file:"))!;
    const items = await provider.query(match, noAbort());

    // 找到第一个文件和最后一个目录的索引
    let lastDirIdx = -1;
    let firstFileIdx = items.length;
    items.forEach((item, idx) => {
      if (item.displayText.endsWith("/")) lastDirIdx = idx;
      else if (idx < firstFileIdx) firstFileIdx = idx;
    });

    if (lastDirIdx >= 0 && firstFileIdx < items.length) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx);
    }
  });

  it("同类型内按字母序", async () => {
    const match = provider.matchTrigger(makeCtx("@file:"))!;
    const items = await provider.query(match, noAbort());

    // 取出所有文件（非目录）
    const files = items
      .filter((i) => !i.displayText.endsWith("/"))
      .map((i) => i.displayText);

    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(sorted);
  });
});

// ─── 深层路径 ───

describe("FileProvider 深层路径", () => {
  it("@file:src/utils/ 列出深层文件", async () => {
    const match = provider.matchTrigger(makeCtx("@file:src/utils/"))!;
    const items = await provider.query(match, noAbort());

    expect(items.length).toBe(1);
    expect(items[0]!.displayText).toBe("helper.ts");
    expect(items[0]!.description).toBe("src/utils/helper.ts");
    expect(items[0]!.acceptPayload.replacement).toBe(
      "@file:src/utils/helper.ts ",
    );
  });
});

// ─── provider 属性 ───

describe("FileProvider 属性", () => {
  it("id / priority / supportsGhostText / supportsChaining", () => {
    expect(provider.id).toBe("file");
    expect(provider.priority).toBe(200);
    expect(provider.supportsGhostText).toBe(false);
    expect(provider.supportsChaining).toBe(false);
  });
});
