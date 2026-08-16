import { describe, expect, it } from "vitest";
import { AdvancementController, SessionAdvancementStore } from "@zhixing/owner-services";
import { createServerContext } from "../context.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";

const TEST_VERSION = "0.1.0-test";
const TEST_TOKEN = "test-token-context";

async function makeStore() {
  return new SessionAdvancementStore({
    port: () => {
      throw new Error("context test does not reach the session state port");
    },
    requestIdFor: () => `req-${Math.random()}`,
  });
}

describe("createServerContext", () => {
  it("llmComplete 不自动启用推进控制面", () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      llmComplete: async () => "{}",
    });

    expect(ctx.advancement).toBeUndefined();
  });

  it("显式传入的推进控制面优先于默认装配", async () => {
    const advancement = new AdvancementController({ store: await makeStore() });
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      advancement,
      llmComplete: async () => "{}",
    });

    expect(ctx.advancement).toBe(advancement);
  });

  it("没有 llmComplete 时保持原有纯执行语义", () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
    });

    expect(ctx.advancement).toBeUndefined();
  });
});
