import { describe, expect, it } from "vitest";
import { classifyProviderError, getRecoveryStrategy } from "../classify.js";

describe("classifyProviderError", () => {
  // ─── HTTP 状态码 ───

  describe("HTTP 状态码分类", () => {
    it("429 → rate_limit", () => {
      expect(classifyProviderError({ status: 429, message: "" })).toBe("rate_limit");
    });

    it("401 → auth", () => {
      expect(classifyProviderError({ status: 401, message: "" })).toBe("auth");
    });

    it("403 → auth", () => {
      expect(classifyProviderError({ status: 403, message: "" })).toBe("auth");
    });

    it("408 → timeout", () => {
      expect(classifyProviderError({ status: 408, message: "" })).toBe("timeout");
    });

    it("413 → context_overflow", () => {
      expect(classifyProviderError({ status: 413, message: "" })).toBe("context_overflow");
    });

    it("400 → invalid_request", () => {
      expect(classifyProviderError({ status: 400, message: "" })).toBe("invalid_request");
    });

    it("500 → provider_error", () => {
      expect(classifyProviderError({ status: 500, message: "" })).toBe("provider_error");
    });

    it("502 → provider_error", () => {
      expect(classifyProviderError({ status: 502, message: "" })).toBe("provider_error");
    });

    it("503 → provider_error", () => {
      expect(classifyProviderError({ status: 503, message: "" })).toBe("provider_error");
    });

    it("529 → provider_error（Anthropic overloaded）", () => {
      expect(classifyProviderError({ status: 529, message: "" })).toBe("provider_error");
    });

    it("未知 4xx → invalid_request", () => {
      expect(classifyProviderError({ status: 422, message: "" })).toBe("invalid_request");
    });

    it("未知 5xx → provider_error", () => {
      expect(classifyProviderError({ status: 504, message: "" })).toBe("provider_error");
    });
  });

  // ─── 网络错误码 ───

  describe("Node.js 网络错误码", () => {
    const networkCodes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
      "ECONNABORTED",
    ];

    for (const code of networkCodes) {
      it(`${code} → network`, () => {
        const error = new Error(`connect ${code}`);
        (error as NodeJS.ErrnoException).code = code;
        expect(classifyProviderError(error)).toBe("network");
      });
    }
  });

  // ─── AbortError ───

  describe("AbortError", () => {
    it("DOMException AbortError → aborted", () => {
      const error = new DOMException("The operation was aborted.", "AbortError");
      expect(classifyProviderError(error)).toBe("aborted");
    });

    it("Error with name=AbortError → aborted", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      expect(classifyProviderError(error)).toBe("aborted");
    });
  });

  // ─── 消息启发式 ───

  describe("消息启发式分类", () => {
    it("'rate limit' → rate_limit", () => {
      expect(classifyProviderError(new Error("Rate limit exceeded"))).toBe("rate_limit");
    });

    it("'too many requests' → rate_limit", () => {
      expect(classifyProviderError(new Error("Too many requests"))).toBe("rate_limit");
    });

    it("'timeout' → timeout", () => {
      expect(classifyProviderError(new Error("Request timeout"))).toBe("timeout");
    });

    it("'timed out' → timeout", () => {
      expect(classifyProviderError(new Error("Connection timed out"))).toBe("timeout");
    });

    it("'socket hang up' → network", () => {
      expect(classifyProviderError(new Error("socket hang up"))).toBe("network");
    });

    it("'fetch failed' → network", () => {
      expect(classifyProviderError(new Error("fetch failed"))).toBe("network");
    });

    it("'context overflow' → context_overflow", () => {
      expect(classifyProviderError(new Error("context overflow: prompt too long"))).toBe(
        "context_overflow",
      );
    });

    it("'unauthorized' → auth", () => {
      expect(classifyProviderError(new Error("Unauthorized access"))).toBe("auth");
    });

    it("'overloaded' → provider_error", () => {
      expect(classifyProviderError(new Error("Server is overloaded"))).toBe("provider_error");
    });
  });

  // ─── 边界情况 ───

  describe("边界情况", () => {
    it("null → unknown", () => {
      expect(classifyProviderError(null)).toBe("unknown");
    });

    it("undefined → unknown", () => {
      expect(classifyProviderError(undefined)).toBe("unknown");
    });

    it("空字符串 → unknown", () => {
      expect(classifyProviderError("")).toBe("unknown");
    });

    it("普通 Error（无特征）→ unknown", () => {
      expect(classifyProviderError(new Error("something happened"))).toBe("unknown");
    });

    it("HTTP 状态码优先于消息启发式", () => {
      const error = { status: 429, message: "timeout" };
      expect(classifyProviderError(error)).toBe("rate_limit");
    });
  });
});

describe("getRecoveryStrategy", () => {
  it("rate_limit → retry + 5 次 + 退避", () => {
    const strategy = getRecoveryStrategy("rate_limit");
    expect(strategy).toEqual({
      action: "retry",
      maxRetries: 5,
      useBackoff: true,
    });
  });

  it("network → retry + 5 次 + 退避", () => {
    const strategy = getRecoveryStrategy("network");
    expect(strategy).toEqual({
      action: "retry",
      maxRetries: 5,
      useBackoff: true,
    });
  });

  it("timeout → retry + 3 次 + 退避", () => {
    const strategy = getRecoveryStrategy("timeout");
    expect(strategy).toEqual({
      action: "retry",
      maxRetries: 3,
      useBackoff: true,
    });
  });

  it("auth → surface + 不重试", () => {
    const strategy = getRecoveryStrategy("auth");
    expect(strategy).toEqual({
      action: "surface",
      maxRetries: 0,
      useBackoff: false,
    });
  });

  it("context_overflow → surface + 不重试", () => {
    const strategy = getRecoveryStrategy("context_overflow");
    expect(strategy).toEqual({
      action: "surface",
      maxRetries: 0,
      useBackoff: false,
    });
  });

  it("aborted → abort + 不重试", () => {
    const strategy = getRecoveryStrategy("aborted");
    expect(strategy).toEqual({
      action: "abort",
      maxRetries: 0,
      useBackoff: false,
    });
  });
});
