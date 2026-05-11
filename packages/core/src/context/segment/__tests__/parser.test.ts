/**
 * parseSummary 纯函数测试。
 *
 * 覆盖标准三段 / 跨行 / 大小写 / 缺段兜底 / 标签外文本 / 首尾空白 / 重复标签。
 */

import { describe, it, expect } from "vitest";
import { parseSummary } from "../parser.js";

describe("parseSummary", () => {
  it("解析完整三段", () => {
    const text = `<facts>事实 A</facts>
<state>状态 B</state>
<active>active C</active>`;
    expect(parseSummary(text)).toEqual({
      facts: "事实 A",
      state: "状态 B",
      active: "active C",
    });
  });

  it("跨行内容保留内部换行", () => {
    const text = `<facts>
line 1
line 2
</facts>
<state>multi
line state</state>
<active>x</active>`;
    expect(parseSummary(text)).toEqual({
      facts: "line 1\nline 2",
      state: "multi\nline state",
      active: "x",
    });
  });

  it("标签名大小写不敏感", () => {
    const text = `<Facts>F</Facts><STATE>S</STATE><Active>A</Active>`;
    expect(parseSummary(text)).toEqual({
      facts: "F",
      state: "S",
      active: "A",
    });
  });

  it("缺失单段降级为空字符串（不抛错）", () => {
    const text = `<facts>F</facts><active>A</active>`;
    expect(parseSummary(text)).toEqual({
      facts: "F",
      state: "",
      active: "A",
    });
  });

  it("全部缺失 → 三段空字符串", () => {
    expect(parseSummary("纯文本回复，没有任何 XML 标签")).toEqual({
      facts: "",
      state: "",
      active: "",
    });
  });

  it("空字符串输入 → 三段空字符串", () => {
    expect(parseSummary("")).toEqual({
      facts: "",
      state: "",
      active: "",
    });
  });

  it("标签前后的解释/问候被忽略", () => {
    const text = `当然，我来压缩对话：
<facts>F</facts>
<state>S</state>
<active>A</active>
希望对你有帮助！`;
    expect(parseSummary(text)).toEqual({
      facts: "F",
      state: "S",
      active: "A",
    });
  });

  it("首尾空白被裁掉（保留中间空格）", () => {
    const text = `<facts>   F with space   </facts><state>\t\nS\n\t</state><active>A</active>`;
    expect(parseSummary(text)).toEqual({
      facts: "F with space",
      state: "S",
      active: "A",
    });
  });

  it("重复标签只取第一组（非贪婪匹配）", () => {
    const text = `<facts>first</facts><facts>second</facts><state>S</state><active>A</active>`;
    expect(parseSummary(text)).toEqual({
      facts: "first",
      state: "S",
      active: "A",
    });
  });

  it("段内出现伪标签字符不影响解析（非贪婪）", () => {
    const text = `<facts>foo &lt;state&gt; bar</facts><state>real state</state><active>A</active>`;
    expect(parseSummary(text)).toEqual({
      facts: "foo &lt;state&gt; bar",
      state: "real state",
      active: "A",
    });
  });
});
