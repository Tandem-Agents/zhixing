import { describe, expect, it } from "vitest";
import { parseModelBudgetStop } from "../budget-stop.js";
import { CAUSE_SUMMARY_CHARS, classifyProviderError, errorCauseSummary, getRecoveryStrategy, isConnectPhaseFailure, markRequestUndelivered, providerRequestNeverSent } from "../classify.js";

const coded = (code: string, message = `connect ${code}`) => Object.assign(new Error(message), { code });
const fetchFailed = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });
const wrapped = (cause: unknown) => Object.assign(new Error("Connection error."), { cause: fetchFailed(cause) });
const marked = <T>(error: T): T => { markRequestUndelivered(error); return error; };

describe("errorCauseSummary", () => {
  const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED", syscall: "connect", address, port: 54001 });

  it("保留拒绝连接的因果链，只用类名、错误码、系统调用与 HTTP 状态", () => {
    const aggregate = Object.assign(new AggregateError([refused("::1"), refused("127.0.0.1")]), { code: "ECONNREFUSED" });
    expect(errorCauseSummary(wrapped(aggregate))).toBe("Error ← TypeError ← AggregateError ECONNREFUSED ← Error ECONNREFUSED connect ×2");
    expect(errorCauseSummary(Object.assign(new Error("Upstream failed"), { cause: Object.assign(new Error("Bad gateway"), { status: 502 }) })))
      .toBe("Error ← Error HTTP 502");
    // 只有外层一句、或各层都没有错误码与状态：没有摘要
    expect(errorCauseSummary(Object.assign(new Error("Bad gateway"), { status: 502 }))).toBeUndefined();
    expect(errorCauseSummary(Object.assign(new Error("a"), { cause: new Error("b") }))).toBeUndefined();
  });

  it("不带任何消息文本：私有查询值、路径与地址不进摘要", () => {
    const marker = "PRIVATE-MARKER-7f3a";
    const inner = Object.assign(new Error(`request to https://example.invalid/v1?token=${marker} failed at C:\\Users\\someone\\${marker}`), {
      code: "ECONNREFUSED", syscall: "connect", address: `10.0.0.1-${marker}`, name: `Bad${marker}Name!`,
    });
    const summary = errorCauseSummary(Object.assign(new Error(`outer ${marker}`), { cause: Object.assign(new TypeError(`fetch ${marker}`), { cause: inner }) }))!;
    expect(summary).toBe("Error ← TypeError ← Error ECONNREFUSED connect");
    expect(summary).not.toContain(marker);
  });

  it("节点总数有界，环、重复与读取出错都不抛出", () => {
    let deep: Error = Object.assign(new Error("root"), { code: "ECONNRESET" });
    for (let i = 0; i < 20; i++) deep = Object.assign(new Error(`wrap ${i}`), { code: "ECONNRESET", cause: deep });
    expect(errorCauseSummary(deep)).toBe("Error ECONNRESET ×8");
    // 首因若在遍历上限之外则不臆测
    let beyond: Error = Object.assign(new Error("root"), { code: "ECONNREFUSED" });
    for (let i = 0; i < 20; i++) beyond = Object.assign(new Error(`wrap ${i}`), { cause: beyond });
    expect(errorCauseSummary(beyond)).toBeUndefined();
    const a = Object.assign(new Error("a"), { code: "ECONNRESET" }) as Error & { cause?: unknown }, b = new Error("b") as Error & { cause?: unknown };
    a.cause = b; b.cause = a;
    expect(errorCauseSummary(a)).toBe("Error ECONNRESET ← Error");
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "cause", { get() { throw new Error("getter boom"); } });
    Object.defineProperty(hostile, "code", { get() { throw new Error("getter boom"); } });
    expect(() => errorCauseSummary(Object.assign(new Error("outer"), { code: "ECONNREFUSED", cause: hostile }))).not.toThrow();
    expect(errorCauseSummary(Object.assign(new Error("outer"), { code: "ECONNREFUSED", cause: hostile }))).toBe("Error ECONNREFUSED ← Error");
  });

  it("摘要长度有上界，与事件流协议的校验上界一致", () => {
    // 每层都是最长的安全类名、错误码与系统调用，且互不相同、无法合并
    const layer = (i: number, cause?: unknown) => Object.assign(new Error(`layer ${i}`), {
      name: `N${String(i).padStart(2, "0")}${"x".repeat(38)}`, code: `C${String(i).padStart(2, "0")}${"X".repeat(38)}`,
      syscall: `s${"y".repeat(20)}`, ...(cause ? { cause } : {}),
    });
    const inners = Array.from({ length: 4 }, (_, i) => layer(20 + i));
    let chain: unknown = Object.assign(new AggregateError(inners, "agg"), { code: "ECONNREFUSED" });
    for (let i = 0; i < 7; i++) chain = layer(i, chain);
    const summary = errorCauseSummary(chain)!;
    expect(summary.length).toBe(CAUSE_SUMMARY_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("isConnectPhaseFailure", () => {
  it("一次 fetch 的拒绝只来自连接阶段（含 localhost 多地址的 AggregateError）", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
      expect(isConnectPhaseFailure(fetchFailed(coded(code)))).toBe(true);
    }
    const aggregate = Object.assign(new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")]), { code: "ECONNREFUSED" });
    expect(isConnectPhaseFailure(fetchFailed(aggregate))).toBe(true);
  });

  it("连接中断、超时、链上有 HTTP 状态、内层混入其他错误或没有错误码都不算", () => {
    expect(isConnectPhaseFailure(fetchFailed(coded("ECONNRESET")))).toBe(false);
    expect(isConnectPhaseFailure(fetchFailed(coded("UND_ERR_SOCKET")))).toBe(false);
    // 外层拒连码、内层 502：先扫完整条链，见到响应即否
    expect(isConnectPhaseFailure(Object.assign(coded("ECONNREFUSED"), { cause: Object.assign(new Error("Bad gateway"), { status: 502 }) }))).toBe(false);
    expect(isConnectPhaseFailure(fetchFailed(new AggregateError([coded("ECONNREFUSED"), coded("ECONNRESET")])))).toBe(false);
    expect(isConnectPhaseFailure(new TypeError("fetch failed"))).toBe(false);
  });

  it("链长超过扫描上限：原因无法辨清，不成立", () => {
    let deep: Error = coded("ECONNREFUSED");
    for (let i = 0; i < 10; i++) deep = Object.assign(new Error(`wrap ${i}`), { cause: deep });
    expect(isConnectPhaseFailure(deep)).toBe(false);
  });
});

describe("providerRequestNeverSent", () => {
  it("错误码本身不构成证明：只认受控传输打的未送达标记", () => {
    expect(providerRequestNeverSent(wrapped(coded("ECONNREFUSED")))).toBe(false);
    expect(providerRequestNeverSent(marked(wrapped(coded("ECONNREFUSED"))))).toBe(true);
  });

  it("带标记但链上有 HTTP 状态或链被截断，仍不成立", () => {
    expect(providerRequestNeverSent(marked(Object.assign(new Error("Connection error."), { cause: Object.assign(coded("ECONNREFUSED"), { cause: Object.assign(new Error("Bad gateway"), { status: 502 }) }) })))).toBe(false);
    let deep: Error = coded("ECONNREFUSED");
    for (let i = 0; i < 10; i++) deep = Object.assign(new Error(`wrap ${i}`), { cause: deep });
    expect(providerRequestNeverSent(marked(deep))).toBe(false);
  });
});

describe("资源额度停止", () => {
  it("单独的额度拒绝与重试后的组合错误都识别，并且不重试", () => {
    for (const message of ["Resource commitments tokens exceeds budget", "Resource usage calls exceeds budget"]) {
      expect(parseModelBudgetStop(message)).toEqual({});
      expect(classifyProviderError(new TypeError(message))).toBe("invalid_request");
    }
    const combined = "Model usage budget exhausted while retrying after: Connection error.";
    expect(parseModelBudgetStop(combined)).toEqual({ afterFailure: "Connection error." });
    expect(classifyProviderError(new Error(combined))).toBe("invalid_request");
    expect(parseModelBudgetStop("Your credit balance exceeds budget")).toBeUndefined();
  });
});

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

    it("SDK 连接错误：错误码在 cause 链里 → network", () => {
      // OpenAI 兼容 SDK 的 APIConnectionError：消息只有 "Connection error."，底层 fetch 错误再包一层
      const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54001"), { code: "ECONNREFUSED" });
      const fetchFailed = new Error("request failed", { cause: refused });
      class APIConnectionError extends Error {}
      const sdk = new APIConnectionError("Retry: ", { cause: fetchFailed });
      expect(classifyProviderError(sdk)).toBe("network");
    });

    it("消息为 Connection error. → network", () => {
      expect(classifyProviderError(new Error("Connection error."))).toBe("network");
    });
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
