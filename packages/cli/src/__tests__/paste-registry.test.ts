import { describe, expect, it } from "vitest";
import {
  PASTE_TOKEN_PATTERN,
  PasteRegistry,
} from "../paste-registry.js";

describe("PasteRegistry — register / get", () => {
  it("空 registry size=0", () => {
    const r = new PasteRegistry();
    expect(r.size).toBe(0);
  });

  it("register 新内容返回 id=1，size+1", () => {
    const r = new PasteRegistry();
    const id = r.register("hello");
    expect(id).toBe(1);
    expect(r.size).toBe(1);
  });

  it("register 同内容复用同一 id", () => {
    const r = new PasteRegistry();
    const id1 = r.register("hello");
    const id2 = r.register("hello");
    expect(id1).toBe(id2);
    expect(r.size).toBe(1);
  });

  it("register 不同内容分配不同 id", () => {
    const r = new PasteRegistry();
    const id1 = r.register("hello");
    const id2 = r.register("world");
    expect(id1).not.toBe(id2);
    expect(r.size).toBe(2);
  });

  it("get 返回完整 entry（id / content / lineCount / byteSize）", () => {
    const r = new PasteRegistry();
    const id = r.register("a\nb\nc");
    const entry = r.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
    expect(entry!.content).toBe("a\nb\nc");
    expect(entry!.lineCount).toBe(3);
    expect(entry!.byteSize).toBe(5);
  });

  it("get 不存在的 id 返回 null", () => {
    const r = new PasteRegistry();
    expect(r.get(999)).toBeNull();
  });
});

describe("PasteRegistry — lineCount", () => {
  it("空内容 lineCount=0", () => {
    const r = new PasteRegistry();
    const id = r.register("");
    expect(r.get(id)!.lineCount).toBe(0);
  });

  it("单行无换行 lineCount=1", () => {
    const r = new PasteRegistry();
    const id = r.register("hello");
    expect(r.get(id)!.lineCount).toBe(1);
  });

  it("多行 lineCount = 行数", () => {
    const r = new PasteRegistry();
    const id = r.register("a\nb\nc");
    expect(r.get(id)!.lineCount).toBe(3);
  });

  it("末尾 \\n 不算独立一行（与编辑器行号一致）", () => {
    const r = new PasteRegistry();
    const id = r.register("a\nb\n");
    expect(r.get(id)!.lineCount).toBe(2);
  });

  it("末尾连续多 \\n 仍只算到非空末行", () => {
    const r = new PasteRegistry();
    const id = r.register("a\nb\n\n\n");
    expect(r.get(id)!.lineCount).toBe(2);
  });
});

describe("PasteRegistry — byteSize", () => {
  it("ASCII 字符 byteSize = char.length", () => {
    const r = new PasteRegistry();
    const id = r.register("hello");
    expect(r.get(id)!.byteSize).toBe(5);
  });

  it("CJK 字符 byteSize = UTF-8 字节数（每字 3 bytes）", () => {
    const r = new PasteRegistry();
    const id = r.register("你好");
    expect(r.get(id)!.byteSize).toBe(6);
  });

  it("emoji byteSize 按 UTF-8 计算", () => {
    const r = new PasteRegistry();
    // 火焰 emoji 4 bytes
    const id = r.register("🔥");
    expect(r.get(id)!.byteSize).toBe(4);
  });
});

describe("PasteRegistry — format", () => {
  it("token 格式：[Pasted #N +M lines · ...B]", () => {
    const r = new PasteRegistry();
    const id = r.register("a\nb\nc");
    const token = r.format(id);
    expect(token).toBe(`[Pasted #${id} +3 lines · 5B]`);
  });

  it("byteSize < 1024 用 B 整数", () => {
    const r = new PasteRegistry();
    const id = r.register("x".repeat(500));
    expect(r.format(id)).toContain("500B");
  });

  it("byteSize 1024-1MB 用 KB 一位小数", () => {
    const r = new PasteRegistry();
    const id = r.register("x".repeat(2048));
    expect(r.format(id)).toContain("2.0KB");
  });

  it("byteSize > 1MB 用 MB 一位小数", () => {
    const r = new PasteRegistry();
    const id = r.register("x".repeat(2 * 1024 * 1024));
    expect(r.format(id)).toContain("2.0MB");
  });

  it("非整 KB 保留一位小数", () => {
    const r = new PasteRegistry();
    const id = r.register("x".repeat(1500));
    expect(r.format(id)).toContain("1.5KB");
  });

  it("token 与 PASTE_TOKEN_PATTERN 互通（regex 能匹配 format 输出）", () => {
    const r = new PasteRegistry();
    const id = r.register("line\nline\n");
    const token = r.format(id);
    PASTE_TOKEN_PATTERN.lastIndex = 0;
    const match = PASTE_TOKEN_PATTERN.exec(token);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(String(id));
    expect(match![2]).toBe("2");
  });
});

describe("PasteRegistry — cleanup", () => {
  it("aliveIds 包含所有 id 时不删", () => {
    const r = new PasteRegistry();
    const id1 = r.register("a");
    const id2 = r.register("b");
    r.cleanup(new Set([id1, id2]));
    expect(r.size).toBe(2);
  });

  it("aliveIds 为空时全部删除", () => {
    const r = new PasteRegistry();
    r.register("a");
    r.register("b");
    r.cleanup(new Set());
    expect(r.size).toBe(0);
  });

  it("aliveIds 部分包含时只删除不在 set 内的", () => {
    const r = new PasteRegistry();
    const id1 = r.register("a");
    const id2 = r.register("b");
    r.cleanup(new Set([id1]));
    expect(r.size).toBe(1);
    expect(r.get(id1)).not.toBeNull();
    expect(r.get(id2)).toBeNull();
  });

  it("cleanup 后被删 id 不再复用 hash 加速（重新 register 同内容走新 id）", () => {
    const r = new PasteRegistry();
    const id1 = r.register("hello");
    r.cleanup(new Set());
    const id2 = r.register("hello");
    expect(id2).not.toBe(id1);
  });
});

describe("PasteRegistry — clearAll", () => {
  it("clearAll 清空所有 entry", () => {
    const r = new PasteRegistry();
    r.register("a");
    r.register("b");
    r.clearAll();
    expect(r.size).toBe(0);
  });

  it("clearAll 后 nextId 重置回 1", () => {
    const r = new PasteRegistry();
    r.register("a");
    r.register("b");
    r.clearAll();
    const id = r.register("c");
    expect(id).toBe(1);
  });
});

describe("PASTE_TOKEN_PATTERN", () => {
  it("匹配单 token", () => {
    PASTE_TOKEN_PATTERN.lastIndex = 0;
    const text = "before [Pasted #1 +30 lines · 1.2KB] after";
    const match = PASTE_TOKEN_PATTERN.exec(text);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("[Pasted #1 +30 lines · 1.2KB]");
    expect(match![1]).toBe("1");
    expect(match![2]).toBe("30");
    expect(match![3]).toBe("1.2");
    expect(match![4]).toBe("KB");
  });

  it("匹配 B / KB / MB 三档", () => {
    const cases = [
      "[Pasted #1 +1 lines · 100B]",
      "[Pasted #2 +5 lines · 1.5KB]",
      "[Pasted #3 +9999 lines · 2.0MB]",
    ];
    for (const t of cases) {
      PASTE_TOKEN_PATTERN.lastIndex = 0;
      expect(PASTE_TOKEN_PATTERN.exec(t)).not.toBeNull();
    }
  });

  it("不匹配字面被破坏的 token", () => {
    const cases = [
      "[Pasted 1 +30 lines · 1KB]", // 缺 #
      "[Pasted #1 +30 line · 1KB]", // line 单数
      "[Pasted #1 +30 lines · 1GB]", // GB 不在三档
      "[Paste #1 +30 lines · 1KB]", // Paste 拼写
    ];
    for (const t of cases) {
      PASTE_TOKEN_PATTERN.lastIndex = 0;
      expect(PASTE_TOKEN_PATTERN.exec(t)).toBeNull();
    }
  });

  it("matchAll 找到多个 token", () => {
    const text = "[Pasted #1 +1 lines · 1B] middle [Pasted #2 +2 lines · 2B]";
    const matches = Array.from(text.matchAll(PASTE_TOKEN_PATTERN));
    expect(matches).toHaveLength(2);
    expect(matches[0]![1]).toBe("1");
    expect(matches[1]![1]).toBe("2");
  });
});
