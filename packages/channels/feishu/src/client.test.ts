import { describe, expect, it } from "vitest";
import { FeishuApiError, detectReceiveIdType } from "./client.js";

describe("detectReceiveIdType", () => {
  it("returns chat_id for oc_ prefix", () => {
    expect(detectReceiveIdType("oc_abc123")).toBe("chat_id");
  });

  it("returns open_id for ou_ prefix", () => {
    expect(detectReceiveIdType("ou_abc123")).toBe("open_id");
  });

  it("defaults to open_id for unknown prefix", () => {
    expect(detectReceiveIdType("unknown_id")).toBe("open_id");
  });
});

describe("FeishuApiError", () => {
  it("marks rate limit (99991429) as retryable", () => {
    const err = new FeishuApiError(99991429, "rate limited");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("FeishuApiError");
  });

  it("marks internal error (99991500) as retryable", () => {
    expect(new FeishuApiError(99991500, "internal").retryable).toBe(true);
  });

  it("marks gateway timeout (99991504) as retryable", () => {
    expect(new FeishuApiError(99991504, "timeout").retryable).toBe(true);
  });

  it("marks param error (99991400) as non-retryable", () => {
    expect(new FeishuApiError(99991400, "invalid param").retryable).toBe(false);
  });

  it("marks permission error (99991403) as non-retryable", () => {
    expect(new FeishuApiError(99991403, "no permission").retryable).toBe(false);
  });

  it("marks unknown codes as non-retryable", () => {
    expect(new FeishuApiError(12345, "unknown").retryable).toBe(false);
  });

  it("includes code and message in error string", () => {
    const err = new FeishuApiError(99991400, "bad request");
    expect(err.message).toContain("99991400");
    expect(err.message).toContain("bad request");
    expect(err.code).toBe(99991400);
    expect(err.apiMessage).toBe("bad request");
  });
});
