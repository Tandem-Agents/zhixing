import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_DISPLAY_NAME,
  getAgentIdentity,
  resetAgentIdentityForTests,
  resolveAgentIdentity,
  setAgentIdentity,
} from "../index.js";

afterEach(() => {
  resetAgentIdentityForTests();
});

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

describe("setAgentIdentity / getAgentIdentity", () => {
  it("默认身份是 '知行'", () => {
    expect(getAgentIdentity()).toEqual({ displayName: "知行" });
  });

  it("set 后 get 返回新身份", () => {
    setAgentIdentity({ displayName: "小助" });
    expect(getAgentIdentity()).toEqual({ displayName: "小助" });
  });

  it("set 空字符串 → 回退到默认", () => {
    setAgentIdentity({ displayName: "" });
    expect(getAgentIdentity()).toEqual({ displayName: "知行" });
  });

  it("resetAgentIdentityForTests 恢复默认", () => {
    setAgentIdentity({ displayName: "改过的名字" });
    expect(getAgentIdentity().displayName).toBe("改过的名字");
    resetAgentIdentityForTests();
    expect(getAgentIdentity()).toEqual({ displayName: "知行" });
  });

  it("多次 set 覆盖前值", () => {
    setAgentIdentity({ displayName: "a" });
    setAgentIdentity({ displayName: "b" });
    expect(getAgentIdentity().displayName).toBe("b");
  });
});
