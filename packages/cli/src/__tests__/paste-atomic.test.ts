import { describe, expect, it } from "vitest";
import { PasteRegistry } from "../paste-registry.js";
import { InputMaterialRegistry } from "../input-material-registry.js";
import {
  findTokenCharRanges,
  removeAllPasteTokens,
  tryAtomicEdit,
} from "../paste-atomic.js";

describe("findTokenCharRanges", () => {
  it("空 draft 返回空数组", () => {
    expect(findTokenCharRanges("")).toEqual([]);
  });

  it("无占位符 draft 返回空数组", () => {
    expect(findTokenCharRanges("hello world")).toEqual([]);
  });

  it("单占位符返回 char range", () => {
    const r = new PasteRegistry();
    const id = r.register("X");
    const token = r.format(id);
    const draft = `pre ${token} post`;
    const ranges = findTokenCharRanges(draft);
    expect(ranges).toHaveLength(1);
    const expectedStart = "pre ".length;
    const expectedEnd = expectedStart + Array.from(token).length;
    expect(ranges[0]).toEqual({ start: expectedStart, end: expectedEnd });
  });

  it("多个占位符按出现顺序返回", () => {
    const r = new PasteRegistry();
    const t1 = r.format(r.register("A"));
    const t2 = r.format(r.register("B"));
    const draft = `${t1} mid ${t2}`;
    const ranges = findTokenCharRanges(draft);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges[1]!.start).toBeGreaterThan(ranges[0]!.end);
  });

  it("CJK 内容时 char offset 不被 surrogate pair 撕裂", () => {
    const r = new PasteRegistry();
    const token = r.format(r.register("X"));
    const draft = `你好${token}世界`;
    const ranges = findTokenCharRanges(draft);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.start).toBe(2); // "你好" 2 chars
    expect(ranges[0]!.end).toBe(2 + Array.from(token).length);
  });
});

describe("tryAtomicEdit — backspace", () => {
  const r = new PasteRegistry();
  const TOKEN = r.format(r.register("CONTENT"));
  const TOKEN_LEN = Array.from(TOKEN).length;

  it("cursor 紧跟占位符末尾 → 整段删", () => {
    const draft = `pre ${TOKEN}`;
    const cursor = "pre ".length + TOKEN_LEN;
    const result = tryAtomicEdit(draft, cursor, "backspace");
    expect(result).not.toBeNull();
    expect(result!.draft).toBe("pre ");
    expect(result!.cursor).toBe("pre ".length);
  });

  it("cursor 在占位符内部 → 整段删", () => {
    const draft = `${TOKEN}`;
    const cursor = 5; // 在 token 中间
    const result = tryAtomicEdit(draft, cursor, "backspace");
    expect(result).not.toBeNull();
    expect(result!.draft).toBe("");
    expect(result!.cursor).toBe(0);
  });

  it("cursor 不紧贴占位符 → 返回 null（caller fallback）", () => {
    const draft = `pre ${TOKEN} post`;
    const cursor = draft.length; // 末尾，不紧贴 token
    const result = tryAtomicEdit(draft, cursor, "backspace");
    expect(result).toBeNull();
  });

  it("cursor 在占位符之前 → 返回 null", () => {
    const draft = `pre ${TOKEN}`;
    const cursor = 1; // 'p' 之后，不紧贴 token
    const result = tryAtomicEdit(draft, cursor, "backspace");
    expect(result).toBeNull();
  });

  it("无占位符的 draft → 返回 null", () => {
    expect(tryAtomicEdit("hello", 5, "backspace")).toBeNull();
  });
});

describe("tryAtomicEdit — delete", () => {
  const r = new PasteRegistry();
  const TOKEN = r.format(r.register("X"));
  const TOKEN_LEN = Array.from(TOKEN).length;

  it("cursor 紧贴占位符起始 → 整段删，cursor 不变", () => {
    const draft = `pre ${TOKEN} post`;
    const cursor = "pre ".length;
    const result = tryAtomicEdit(draft, cursor, "delete");
    expect(result).not.toBeNull();
    expect(result!.draft).toBe("pre  post");
    expect(result!.cursor).toBe(cursor);
  });

  it("cursor 在占位符内部 → 整段删", () => {
    const draft = TOKEN;
    const cursor = 3;
    const result = tryAtomicEdit(draft, cursor, "delete");
    expect(result).not.toBeNull();
    expect(result!.draft).toBe("");
    expect(result!.cursor).toBe(0);
  });

  it("cursor 在占位符末尾之后 → 返回 null", () => {
    const draft = `${TOKEN}post`;
    const cursor = TOKEN_LEN;
    const result = tryAtomicEdit(draft, cursor, "delete");
    expect(result).toBeNull();
  });
});

describe("tryAtomicEdit — left", () => {
  const r = new PasteRegistry();
  const TOKEN = r.format(r.register("X"));
  const TOKEN_LEN = Array.from(TOKEN).length;

  it("cursor 紧贴占位符末尾 → 跳到 token 起始", () => {
    const draft = `pre ${TOKEN}`;
    const cursor = "pre ".length + TOKEN_LEN;
    const result = tryAtomicEdit(draft, cursor, "left");
    expect(result).not.toBeNull();
    expect(result!.draft).toBe(draft);
    expect(result!.cursor).toBe("pre ".length);
  });

  it("cursor 在占位符内部 → 跳到 token 起始", () => {
    const draft = TOKEN;
    const cursor = 5;
    const result = tryAtomicEdit(draft, cursor, "left");
    expect(result).not.toBeNull();
    expect(result!.cursor).toBe(0);
  });

  it("cursor 不紧贴占位符 → 返回 null", () => {
    expect(tryAtomicEdit(`pre ${TOKEN}`, 1, "left")).toBeNull();
  });
});

describe("tryAtomicEdit — right", () => {
  const r = new PasteRegistry();
  const TOKEN = r.format(r.register("X"));
  const TOKEN_LEN = Array.from(TOKEN).length;

  it("cursor 紧贴占位符起始 → 跳到 token 末尾", () => {
    const draft = `pre ${TOKEN} post`;
    const cursor = "pre ".length;
    const result = tryAtomicEdit(draft, cursor, "right");
    expect(result).not.toBeNull();
    expect(result!.cursor).toBe("pre ".length + TOKEN_LEN);
  });

  it("cursor 在占位符内部 → 跳到 token 末尾", () => {
    const draft = TOKEN;
    const cursor = 3;
    const result = tryAtomicEdit(draft, cursor, "right");
    expect(result).not.toBeNull();
    expect(result!.cursor).toBe(TOKEN_LEN);
  });

  it("cursor 在占位符末尾之后 → 返回 null", () => {
    const draft = `${TOKEN}post`;
    const cursor = TOKEN_LEN + 2;
    const result = tryAtomicEdit(draft, cursor, "right");
    expect(result).toBeNull();
  });
});

describe("removeAllPasteTokens", () => {
  it("空 draft / 无占位符 → 返回 null", () => {
    expect(removeAllPasteTokens("", 0)).toBeNull();
    expect(removeAllPasteTokens("hello", 5)).toBeNull();
  });

  it("单占位符整段删除，非占位符文本保留", () => {
    const r = new PasteRegistry();
    const token = r.format(r.register("X"));
    const draft = `pre ${token} post`;
    const result = removeAllPasteTokens(draft, 0);
    expect(result).not.toBeNull();
    expect(result!.draft).toBe("pre  post");
    expect(result!.cursor).toBe(0);
  });

  it("cursor 在占位符之后 → 跟随长度变化平移", () => {
    const r = new PasteRegistry();
    const token = r.format(r.register("X"));
    const tokenLen = Array.from(token).length;
    const draft = `${token}post`;
    const cursor = tokenLen + 2;
    const result = removeAllPasteTokens(draft, cursor);
    expect(result).not.toBeNull();
    expect(result!.draft).toBe("post");
    expect(result!.cursor).toBe(2);
  });

  it("cursor 在占位符内部 → 落到 range 起始（删除点）", () => {
    const r = new PasteRegistry();
    const token = r.format(r.register("X"));
    const cursor = 3;
    const result = removeAllPasteTokens(token, cursor);
    expect(result).not.toBeNull();
    expect(result!.draft).toBe("");
    expect(result!.cursor).toBe(0);
  });

  it("多占位符全部删除", () => {
    const r = new PasteRegistry();
    const t1 = r.format(r.register("A"));
    const t2 = r.format(r.register("B"));
    const draft = `${t1} mid ${t2}`;
    const result = removeAllPasteTokens(draft, 0);
    expect(result).not.toBeNull();
    expect(result!.draft).toBe(" mid ");
  });

  it("用户编辑的非粘贴文本完整保留", () => {
    const r = new PasteRegistry();
    const token = r.format(r.register("X"));
    const draft = `请审一下 ${token} 谢谢`;
    const result = removeAllPasteTokens(draft, 0);
    expect(result).not.toBeNull();
    expect(result!.draft).toBe("请审一下  谢谢");
  });

  it("只删除文本粘贴 token，保留材料 chip", () => {
    const pasteRegistry = new PasteRegistry();
    const materialRegistry = new InputMaterialRegistry();
    const pasteToken = pasteRegistry.format(pasteRegistry.register("X"));
    const materialId = materialRegistry.registerLocalFile({
      kind: "image",
      filePath: "E:/repo/shot.png",
      name: "shot.png",
      mimeType: "image/png",
      byteSize: 24,
      image: { width: 4, height: 5 },
    });
    const materialChip = materialRegistry.format(materialId);
    const draft = `${materialChip} ${pasteToken} tail`;

    const result = removeAllPasteTokens(draft, Array.from(draft).length);

    expect(result).not.toBeNull();
    expect(result!.draft).toBe(`${materialChip}  tail`);
    expect(result!.cursor).toBe(Array.from(result!.draft).length);
  });
});
