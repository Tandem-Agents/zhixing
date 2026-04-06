import { describe, expect, it } from "vitest";
import { AgentError, isAgentError, toAgentError } from "./errors.js";

describe("AgentError", () => {
  it("应携带正确的类型和可恢复性标记", () => {
    const err = new AgentError("Rate limited", "rate_limit", true);

    expect(err.message).toBe("Rate limited");
    expect(err.type).toBe("rate_limit");
    expect(err.recoverable).toBe(true);
    expect(err.name).toBe("AgentError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentError);
  });

  it("应保留原始错误作为 cause", () => {
    const original = new Error("Connection refused");
    const err = new AgentError("网络错误", "network", true, original);

    expect(err.cause).toBe(original);
  });

  it("不可恢复错误的 recoverable 应为 false", () => {
    const err = new AgentError("Invalid API key", "auth", false);
    expect(err.recoverable).toBe(false);
  });
});

describe("isAgentError", () => {
  it("AgentError 实例应返回 true", () => {
    const err = new AgentError("test", "unknown", false);
    expect(isAgentError(err)).toBe(true);
  });

  it("普通 Error 应返回 false", () => {
    expect(isAgentError(new Error("普通错误"))).toBe(false);
  });

  it("非 Error 值应返回 false", () => {
    expect(isAgentError("字符串错误")).toBe(false);
    expect(isAgentError(null)).toBe(false);
    expect(isAgentError(undefined)).toBe(false);
    expect(isAgentError(42)).toBe(false);
  });
});

describe("toAgentError", () => {
  it("AgentError 应原样返回", () => {
    const err = new AgentError("已知错误", "timeout", true);
    const result = toAgentError(err);

    expect(result).toBe(err);
    expect(result.type).toBe("timeout");
  });

  it("普通 Error 应包装为 unknown 类型的不可恢复 AgentError", () => {
    const original = new Error("something broke");
    const result = toAgentError(original);

    expect(result).toBeInstanceOf(AgentError);
    expect(result.message).toBe("something broke");
    expect(result.type).toBe("unknown");
    expect(result.recoverable).toBe(false);
    expect(result.cause).toBe(original);
  });

  it("字符串错误应包装为 AgentError", () => {
    const result = toAgentError("string error");

    expect(result).toBeInstanceOf(AgentError);
    expect(result.message).toBe("string error");
    expect(result.type).toBe("unknown");
    expect(result.cause).toBe("string error");
  });

  it("null/undefined 应包装为 AgentError", () => {
    const nullResult = toAgentError(null);
    expect(nullResult.message).toBe("null");

    const undefinedResult = toAgentError(undefined);
    expect(undefinedResult.message).toBe("undefined");
  });
});
