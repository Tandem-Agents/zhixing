import { describe, it, expect } from "vitest";
import { skillNameToId } from "../id.js";

const SP = " "; // 普通空格,运行时拼接避免源码里的空白歧义
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);

describe("skillNameToId", () => {
  it("小写化", () => {
    expect(skillNameToId("MySkill")).toBe("myskill");
  });

  it("空白(含 tab/换行)转连字符", () => {
    expect(skillNameToId("deploy" + SP + "to" + SP + "prod")).toBe("deploy-to-prod");
    expect(skillNameToId("a\tb\nc")).toBe("a-b-c");
  });

  it("保留 Unicode —— 中文名不被抹空", () => {
    expect(skillNameToId("代码审查")).toBe("代码审查");
    expect(skillNameToId("代码" + SP + "审查")).toBe("代码-审查");
  });

  it("移除文件名非法字符与路径分隔符(防越界)", () => {
    expect(skillNameToId("a/b")).toBe("ab");
    expect(skillNameToId("a\\b")).toBe("ab");
    expect(skillNameToId('na:me"?*|<>')).toBe("name");
  });

  it("移除非空白控制符(运行时构造)", () => {
    expect(skillNameToId("a" + BEL + "bc")).toBe("abc");
    expect(skillNameToId("a" + NUL + "b")).toBe("ab");
  });

  it("合并连续连字符、去首尾连字符", () => {
    expect(skillNameToId(SP + SP + "hi" + SP + SP)).toBe("hi");
    expect(skillNameToId("a" + SP + SP + SP + "b")).toBe("a-b");
    expect(skillNameToId("--a--b--")).toBe("a-b");
  });

  it("保留非分隔的普通符号(. !)", () => {
    expect(skillNameToId("notes.v2!")).toBe("notes.v2!");
  });

  it("幂等 —— 对结果再跑一次不变", () => {
    const once = skillNameToId("My" + SP + "Code/Review:" + SP + "工具!");
    expect(skillNameToId(once)).toBe(once);
  });

  it("退化输入(全非法 / 空)产出空串,交由上层拒绝", () => {
    expect(skillNameToId("")).toBe("");
    expect(skillNameToId("///")).toBe("");
  });
});
