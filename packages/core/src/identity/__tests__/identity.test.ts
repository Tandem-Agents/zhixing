import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_DISPLAY_NAME,
  resolveAgentIdentity,
} from "../index.js";

describe("resolveAgentIdentity", () => {
  it("未传配置 → 默认显示名 '知行'", () => {
    expect(resolveAgentIdentity()).toEqual({ displayName: "知行" });
    expect(DEFAULT_AGENT_DISPLAY_NAME).toBe("知行");
  });

  it("传 null → 默认", () => {
    expect(resolveAgentIdentity(null)).toEqual({ displayName: "知行" });
  });

  it("传空对象 → 默认", () => {
    expect(resolveAgentIdentity({})).toEqual({ displayName: "知行" });
  });

  it("空字符串 displayName → 回退到默认", () => {
    expect(resolveAgentIdentity({ displayName: "" })).toEqual({
      displayName: "知行",
    });
  });

  it("纯空白 displayName → 回退到默认", () => {
    expect(resolveAgentIdentity({ displayName: "   " })).toEqual({
      displayName: "知行",
    });
  });

  it("自定义 displayName → 采用并 trim", () => {
    expect(resolveAgentIdentity({ displayName: "小助" })).toEqual({
      displayName: "小助",
    });
    expect(resolveAgentIdentity({ displayName: "  管家  " })).toEqual({
      displayName: "管家",
    });
  });
});

it("captures independent immutable values rather than sharing current identity", () => {
  const source = { displayName: "first" };
  const first = resolveAgentIdentity(source);
  source.displayName = "second";
  const second = resolveAgentIdentity(source);
  expect(first.displayName).toBe("first");
  expect(second.displayName).toBe("second");
  expect(resolveAgentIdentity().displayName).toBe("知行");
  expect(Object.isFrozen(first)).toBe(true);
});
