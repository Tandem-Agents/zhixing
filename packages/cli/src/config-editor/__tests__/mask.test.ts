/**
 * Mask 渲染纯函数测试。
 */

import { describe, expect, it } from "vitest";
import { maskForDisplay, maskForInput } from "../ui/mask.js";

describe("maskForDisplay · 列表态渲染", () => {
  it("空字符串返回空", () => {
    expect(maskForDisplay("")).toBe("");
  });

  it("长度 ≤ 8 全 mask（避免前4+后4 暴露过半）", () => {
    expect(maskForDisplay("abc")).toBe("***");
    expect(maskForDisplay("12345678")).toBe("********");
  });

  it("长度 > 8 显示前 4 + **** + 后 4", () => {
    expect(maskForDisplay("sk-abcd1234wxyz")).toBe("sk-a****wxyz");
    expect(maskForDisplay("sk-xldthyxrwzcmoazlrudnprbgs")).toBe("sk-x****rbgs");
  });

  it("9 字符的临界处理", () => {
    expect(maskForDisplay("123456789")).toBe("1234****6789");
  });
});

describe("maskForInput · 输入态渲染", () => {
  it("空字符串返回空", () => {
    expect(maskForInput("")).toBe("");
  });

  it("每个字符渲染为 *", () => {
    expect(maskForInput("abc")).toBe("***");
    expect(maskForInput("sk-test1234")).toBe("***********");
  });

  it("Unicode codepoint 计数（不按字节）", () => {
    // 4 个字符（含 emoji）应该 4 个 *
    expect(maskForInput("a😀bc").length).toBe(4);
  });
});
