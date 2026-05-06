import { describe, expect, it } from "vitest";
import { PasteRegistry } from "../paste-registry.js";
import { expandPastes, extractAliveIds } from "../paste-expand.js";

describe("expandPastes", () => {
  it("无占位符时原样返回", () => {
    const r = new PasteRegistry();
    expect(expandPastes("hello world", r)).toBe("hello world");
  });

  it("空字符串返回空字符串", () => {
    const r = new PasteRegistry();
    expect(expandPastes("", r)).toBe("");
  });

  it("单 token 替换为原文", () => {
    const r = new PasteRegistry();
    const id = r.register("line1\nline2\nline3");
    const token = r.format(id);
    expect(expandPastes(`prefix ${token} suffix`, r)).toBe(
      "prefix line1\nline2\nline3 suffix",
    );
  });

  it("多 token 倒序替换 offset 安全", () => {
    const r = new PasteRegistry();
    const id1 = r.register("AAA");
    const id2 = r.register("BBB");
    const t1 = r.format(id1);
    const t2 = r.format(id2);
    const draft = `head ${t1} mid ${t2} tail`;
    expect(expandPastes(draft, r)).toBe("head AAA mid BBB tail");
  });

  it("unknown id 保留字面字符串作 fallback", () => {
    const r = new PasteRegistry();
    const literal = "[Pasted #999 +1 lines · 1B]";
    expect(expandPastes(`x ${literal} y`, r)).toBe(`x ${literal} y`);
  });

  it("混合：alive token + unknown token", () => {
    const r = new PasteRegistry();
    const id = r.register("REAL");
    const realToken = r.format(id);
    const fakeToken = "[Pasted #999 +0 lines · 0B]";
    const draft = `${realToken} and ${fakeToken}`;
    expect(expandPastes(draft, r)).toBe(`REAL and ${fakeToken}`);
  });

  it("CJK 内容正确还原", () => {
    const r = new PasteRegistry();
    const id = r.register("你好\n世界");
    const token = r.format(id);
    expect(expandPastes(token, r)).toBe("你好\n世界");
  });

  it("token 紧贴非空白字符也能识别", () => {
    const r = new PasteRegistry();
    const id = r.register("X");
    const token = r.format(id);
    expect(expandPastes(`a${token}b`, r)).toBe("aXb");
  });
});

describe("extractAliveIds", () => {
  it("无占位符返回空 set", () => {
    expect(extractAliveIds("hello world").size).toBe(0);
  });

  it("空字符串返回空 set", () => {
    expect(extractAliveIds("").size).toBe(0);
  });

  it("单 token 抽出 id", () => {
    const r = new PasteRegistry();
    const id = r.register("X");
    const ids = extractAliveIds(`pre ${r.format(id)} post`);
    expect(ids.size).toBe(1);
    expect(ids.has(id)).toBe(true);
  });

  it("多 token 抽出所有 id", () => {
    const r = new PasteRegistry();
    const id1 = r.register("A");
    const id2 = r.register("B");
    const ids = extractAliveIds(`${r.format(id1)} mid ${r.format(id2)}`);
    expect(ids.size).toBe(2);
    expect(ids.has(id1)).toBe(true);
    expect(ids.has(id2)).toBe(true);
  });

  it("同 id 多次出现去重为 1 个 set 元素", () => {
    const r = new PasteRegistry();
    const id = r.register("X");
    const t = r.format(id);
    const ids = extractAliveIds(`${t} and ${t}`);
    expect(ids.size).toBe(1);
    expect(ids.has(id)).toBe(true);
  });

  it("被破坏的占位符（regex 不再 match）不进 alive set", () => {
    const draft = "[Paste #1 +30 lines · 1KB]"; // Paste 拼错（少 d）
    expect(extractAliveIds(draft).size).toBe(0);
  });

  it("unknown id 仍进 alive set（regex match 即可，不查 registry）", () => {
    // 此函数不持有 registry，只看 regex 匹配
    const draft = "[Pasted #999 +1 lines · 1B]";
    const ids = extractAliveIds(draft);
    expect(ids.has(999)).toBe(true);
  });
});

describe("expandPastes + extractAliveIds 联动场景", () => {
  it("orphan 回收典型流程：用户删除占位符 → cleanup 删 entry", () => {
    const r = new PasteRegistry();
    const id = r.register("CONTENT");
    const tokenStr = r.format(id);
    const draftBefore = `before ${tokenStr} after`;

    // 扫描 alive
    const alive1 = extractAliveIds(draftBefore);
    r.cleanup(alive1);
    expect(r.size).toBe(1);

    // 用户删除占位符
    const draftAfter = "before  after";
    const alive2 = extractAliveIds(draftAfter);
    r.cleanup(alive2);
    expect(r.size).toBe(0);
  });

  it("用户编辑破坏占位符（中间漏字符）→ 视为 orphan 回收", () => {
    const r = new PasteRegistry();
    const id = r.register("CONTENT");
    const tokenStr = r.format(id);
    expect(extractAliveIds(tokenStr).has(id)).toBe(true);

    // 用户删了一个字符破坏 token
    const broken = tokenStr.slice(0, -3) + tokenStr.slice(-2);
    const alive = extractAliveIds(broken);
    r.cleanup(alive);
    expect(r.size).toBe(0);
  });

  it("submit 流程：expand 还原原文喂给 agent", () => {
    const r = new PasteRegistry();
    const id1 = r.register("import x from 'y';\nconst a = 1;");
    const id2 = r.register("function foo() {}");
    const draft = `请审一下 ${r.format(id1)} 和 ${r.format(id2)}`;
    const expanded = expandPastes(draft, r);
    expect(expanded).toBe(
      "请审一下 import x from 'y';\nconst a = 1; 和 function foo() {}",
    );
  });
});
