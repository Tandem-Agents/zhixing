/**
 * findTriggerToken 单元测试
 *
 * 覆盖要点：
 *   - 空 draft / 空 cursor 边界
 *   - 基本 `/` / `@` / `#` 触发
 *   - Unicode / CJK 字符在命令名和正文里
 *   - requireBoundary=true：拒绝 Unix 路径 `/usr/bin`
 *   - requireBoundary=false：允许 mid-input
 *   - Cursor 位置在 token 不同位置的影响（中间、token 后空格、token 之后）
 *   - Emoji / 代理对 safety
 */

import { describe, expect, it } from "vitest";
import { findTriggerToken } from "../trigger-matcher.js";

describe("findTriggerToken — 基本触发", () => {
  it("空 draft 返回 null", () => {
    expect(
      findTriggerToken("", 0, { triggerChar: "/", requireBoundary: true }),
    ).toBeNull();
  });

  it("draft 只有 '/' 时命中空 query token", () => {
    const m = findTriggerToken("/", 1, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m).toEqual({
      tokenStart: 0,
      tokenEnd: 1,
      token: "/",
      query: "",
    });
  });

  it("`/el` cursor 在末尾 → 命中，query = 'el'", () => {
    const m = findTriggerToken("/el", 3, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m).toEqual({
      tokenStart: 0,
      tokenEnd: 3,
      token: "/el",
      query: "el",
    });
  });

  it("`/elevated` cursor 在 `/el|evated` → 仍命中完整 token", () => {
    const m = findTriggerToken("/elevated", 3, {
      triggerChar: "/",
      requireBoundary: true,
    });
    // Token 范围是到 "elevated" 末尾，但 query 是 cursor 前的部分吗？
    // 看实现：实际上 findTriggerToken 返回的 token 是按**字符类**扫描到的完整词，
    // query 是 triggerPos+1..tokenEnd。所以 query = "elevated"，不是 "el"。
    expect(m?.tokenStart).toBe(0);
    expect(m?.tokenEnd).toBe(9);
    expect(m?.token).toBe("/elevated");
    expect(m?.query).toBe("elevated");
  });
});

describe("findTriggerToken — requireBoundary", () => {
  it("requireBoundary=true + Unix 路径 `/usr/bin` 不命中（因为没有 boundary）", () => {
    const m = findTriggerToken("ls /usr/bin", 11, {
      triggerChar: "/",
      requireBoundary: true,
    });
    // cursor 在末尾，token 字符类会吃到 'b','i','n'，往前是 '/'，再往前是 'r','s','u'，
    // 再往前的 '/' 是正则的 trigger char，前面是空格。但问题是 `/usr/bin` 里的
    // 第二个 `/`（也就是 `/usr` 后面那个）也是 trigger char —— findTriggerToken 从
    // cursor 往前扫时会先撞上它。此时它前面是 'r'（不是 whitespace），所以
    // boundary 检查应该失败 → 返回 null。
    expect(m).toBeNull();
  });

  it("requireBoundary=true + 句首 '/cmd' 命中", () => {
    const m = findTriggerToken("/cmd", 4, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m?.token).toBe("/cmd");
  });

  it("requireBoundary=true + 空格后 '/cmd' 命中", () => {
    const m = findTriggerToken("  /cmd", 6, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m?.tokenStart).toBe(2);
    expect(m?.token).toBe("/cmd");
    expect(m?.query).toBe("cmd");
  });

  it("requireBoundary=true + `foo/bar` 不命中（foo 不是空白）", () => {
    const m = findTriggerToken("foo/bar", 7, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m).toBeNull();
  });

  it("requireBoundary=false 允许 mid-input 触发", () => {
    const m = findTriggerToken("帮我运行/ba", 6, {
      triggerChar: "/",
      requireBoundary: false,
    });
    // 字符位置：帮(0)我(1)运(2)行(3)/(4)b(5)a(6)
    expect(m?.tokenStart).toBe(4);
    expect(m?.token).toBe("/ba");
    expect(m?.query).toBe("ba");
  });
});

describe("findTriggerToken — Unicode / CJK", () => {
  it("中文命令名命中（默认 tokenCharClass 包含 \\p{L}）", () => {
    const m = findTriggerToken("/提交", 3, {
      triggerChar: "/",
      requireBoundary: true,
    });
    // 字符位置：/(0) 提(1) 交(2)
    expect(m?.tokenStart).toBe(0);
    expect(m?.tokenEnd).toBe(3);
    expect(m?.token).toBe("/提交");
    expect(m?.query).toBe("提交");
  });

  it("emoji 代理对不撕裂：cursor=1 在 `/` 与 🚀 之间命中空 query 的 `/` token", () => {
    // "/🚀" 的 JS string.length === 3（'/' + 2 个代理对 code unit），
    // 但 Array.from 产出 2 个逻辑字符 —— 位置按逻辑字符计数。
    const draft = "/🚀";
    // cursor=1 表示光标在 '/' 之后、🚀 之前
    const m = findTriggerToken(draft, 1, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m?.token).toBe("/");
    expect(m?.query).toBe("");
  });

  it("emoji 不是 token 字符：cursor 在 emoji 之后返回 null（保守）", () => {
    // 光标越过非 token 字符 → 退出扫描 → 不命中
    // 这是正确行为 —— 用户已经打了一个 emoji 而不是命令名
    const draft = "/🚀";
    const m = findTriggerToken(draft, 2, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m).toBeNull();
  });

  it("全角空格作为 boundary（\\s 识别 U+3000）", () => {
    const m = findTriggerToken("a　/cmd", 6, {
      triggerChar: "/",
      requireBoundary: true,
    });
    // 字符位置：a(0) 　(1) /(2) c(3) m(4) d(5)
    expect(m?.tokenStart).toBe(2);
    expect(m?.token).toBe("/cmd");
  });
});

describe("findTriggerToken — cursor 位置", () => {
  it("cursor 在 token 范围之外（后面）返回 null", () => {
    // "/cmd xxx" cursor 在 'xxx' 里 → 不在 /cmd 的 token 范围内
    const m = findTriggerToken("/cmd xxx", 7, {
      triggerChar: "/",
      requireBoundary: true,
    });
    // 从 cursor=7 往前扫会遇到 'x','x' (token 字符),'空格' → 退出，返回 null
    expect(m).toBeNull();
  });

  it("cursor 在 token 中间命中", () => {
    const m = findTriggerToken("/cmd", 2, {
      triggerChar: "/",
      requireBoundary: true,
    });
    // cursor 在 '/c|md'
    expect(m?.tokenStart).toBe(0);
    expect(m?.tokenEnd).toBe(4);
    expect(m?.query).toBe("cmd");
  });

  it("cursor 恰好在 token 末尾（exclusive 边界）仍命中", () => {
    const m = findTriggerToken("/cmd", 4, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m?.token).toBe("/cmd");
  });

  it("cursor 越过 draft 长度自动 clamp", () => {
    const m = findTriggerToken("/cmd", 999, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m?.token).toBe("/cmd");
  });

  it("cursor 为 0 且 draft 以 '/' 开头 → 返回 null（cursor 不在 token 内）", () => {
    // cursor=0 意味着光标在 '/' 左边，还没"进入"token
    // 从 cursor-1 = -1 往前扫立即退出
    const m = findTriggerToken("/cmd", 0, {
      triggerChar: "/",
      requireBoundary: true,
    });
    expect(m).toBeNull();
  });
});

describe("findTriggerToken — @ 触发", () => {
  it("`@file` 基本触发", () => {
    const m = findTriggerToken("@file", 5, {
      triggerChar: "@",
      requireBoundary: true,
    });
    expect(m?.token).toBe("@file");
    expect(m?.query).toBe("file");
  });

  it("`看看 @src` mid-input @ 触发", () => {
    const m = findTriggerToken("看看 @src", 6, {
      triggerChar: "@",
      requireBoundary: true,
    });
    // 字符位置：看(0) 看(1) 空格(2) @(3) s(4) r(5) c(6)
    expect(m?.tokenStart).toBe(3);
    expect(m?.query).toBe("src");
  });

  it("邮箱 `user@example.com` 中的 @ 不命中（因为 @ 前是字母，requireBoundary 失败）", () => {
    const m = findTriggerToken("user@example.com", 16, {
      triggerChar: "@",
      requireBoundary: true,
    });
    // 但 tokenCharClass 里不含 '.'，所以扫到 '.' 会停；'.' 前是 'e'，
    // 继续往前会遇到 @，@前是 'r' —— boundary 失败 → null
    expect(m).toBeNull();
  });
});

describe("findTriggerToken — 自定义 tokenCharClass", () => {
  it("不含点的 token 类：`@file.ts` 的 query 只到 `file`", () => {
    // 默认 class 不含 '.'
    const m = findTriggerToken("@file.ts", 8, {
      triggerChar: "@",
      requireBoundary: true,
    });
    // cursor=8 从 's','t','.' 扫 → '.' 不是 token 字符 → 返回 null
    expect(m).toBeNull();
  });

  it("含 '.' 的 token 类能吃到 `.ts`", () => {
    const m = findTriggerToken("@file.ts", 8, {
      triggerChar: "@",
      tokenCharClass: "\\p{L}\\p{N}_\\-:.",
      requireBoundary: true,
    });
    expect(m?.token).toBe("@file.ts");
    expect(m?.query).toBe("file.ts");
  });
});
