import { describe, expect, it } from "vitest";
import { createServerContext } from "../context.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";

const TEST_VERSION = "0.1.0-test";
const TEST_TOKEN = "test-token-context";

describe("createServerContext", () => {
  it("llmComplete 不让 ServerContext 拥有或发布推进控制面", () => {
    const llmComplete = async () => "{}";
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      llmComplete,
    });

    expect(ctx.llmComplete).toBe(llmComplete);
    expect(ctx).not.toHaveProperty("advancement");
  });
});
