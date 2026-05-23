import { describe, expect, it } from "vitest";
import {
  isValidServerId,
  makeToolName,
  makeUniqueToolName,
  parseToolName,
  sanitizeToolName,
} from "../naming.js";

describe("isValidServerId", () => {
  it.each(["github", "my-server", "my_server", "a1", "1a", "a", "a-b-c"])(
    "接受合法 id %s",
    (id) => {
      expect(isValidServerId(id)).toBe(true);
    },
  );

  it.each(["", "a__b", "-a", "a-", "_a", "a_", "a/b", "a b", "a.b"])(
    "拒绝非法 id %s",
    (id) => {
      expect(isValidServerId(id)).toBe(false);
    },
  );

  it("按长度上限接受 40 字符、拒绝 41 字符", () => {
    expect(isValidServerId("a".repeat(40))).toBe(true);
    expect(isValidServerId("a".repeat(41))).toBe(false);
  });
});

describe("sanitizeToolName", () => {
  it.each([
    ["create_issue", "create_issue"],
    ["create__issue", "create_issue"],
    ["a___b___c", "a_b_c"],
    ["weird name!", "weird_name"],
    ["__lead__", "lead"],
    ["a/b.c", "a_b_c"],
    ["", "tool"],
    ["!!!", "tool"],
  ])("消毒 %s → %s", (raw, expected) => {
    expect(sanitizeToolName(raw)).toBe(expected);
  });

  it("消毒结果内部不含 __", () => {
    for (const raw of ["a__b", "x///y", "p....q", "_ _ _"]) {
      expect(sanitizeToolName(raw)).not.toContain("__");
    }
  });
});

describe("makeToolName", () => {
  it("拼出三段式工具名", () => {
    expect(makeToolName("github", "create_issue")).toBe(
      "mcp__github__create_issue",
    );
  });
});

describe("makeUniqueToolName", () => {
  it("普通名消毒后拼接", () => {
    expect(makeUniqueToolName("github", "create.issue", new Set())).toBe(
      "mcp__github__create_issue",
    );
  });

  it("同 server 消毒后重名加 -2 / -3 后缀", () => {
    const used = new Set<string>();
    expect(makeUniqueToolName("github", "a.b", used)).toBe("mcp__github__a_b");
    expect(makeUniqueToolName("github", "a/b", used)).toBe("mcp__github__a_b-2");
    expect(makeUniqueToolName("github", "a b", used)).toBe("mcp__github__a_b-3");
  });

  it("超长工具名截断到总长 64 以内", () => {
    const name = makeUniqueToolName("srv", "x".repeat(200), new Set());
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("mcp__srv__")).toBe(true);
  });

  it("截断后仍重名时去重且都不超长", () => {
    const used = new Set<string>();
    const first = makeUniqueToolName("srv", "y".repeat(200), used);
    const second = makeUniqueToolName("srv", "y".repeat(200), used);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
  });

  it("产出的名仍可被 parseToolName 反解析", () => {
    const name = makeUniqueToolName("github", "weird name!", new Set());
    expect(parseToolName(name)).toEqual({
      serverId: "github",
      tool: "weird_name",
    });
  });
});

describe("parseToolName", () => {
  it("反解析合法三段名", () => {
    expect(parseToolName("mcp__github__create_issue")).toEqual({
      serverId: "github",
      tool: "create_issue",
    });
  });

  it.each([
    "mcp__github", // 仅两段
    "mcp__a__b__c", // 四段
    "other__a__b", // 前缀错
    "mcp____b", // server 段空
    "mcp__a__", // tool 段空
    "plain",
  ])("拒绝 %s 返回 null", (name) => {
    expect(parseToolName(name)).toBeNull();
  });

  it("与 makeToolName + sanitizeToolName 闭环一致", () => {
    const name = makeToolName("github", sanitizeToolName("create.issue"));
    expect(parseToolName(name)).toEqual({
      serverId: "github",
      tool: "create_issue",
    });
  });
});
