import { describe, expect, it, vi } from "vitest";
import { assertAdvancementModelProviderBinding } from "@zhixing/orchestrator/advancement";
import type { ProviderCredentialProjection, ZhixingConfig } from "@zhixing/providers";
import { createHostAdvancementModelProviderFactory } from "../advancement-model-provider.js";

const credentials: ProviderCredentialProjection = {
  providers: { deepseek: { apiKey: "test-only" } },
};

const resourceMeter = {
  reserveUsage: vi.fn(async () => {}),
  consume: vi.fn(async () => {}),
};

describe("Host Advancement model provider", () => {
  it("projects fallback, window thresholds, and session budget behind finite ports", () => {
    const config: ZhixingConfig = {
      llm: {
        main: { provider: "deepseek", model: "deepseek-chat" },
        light: { provider: "openai", model: "gpt-4o-mini" },
      },
      advancement: { sessionTokenBudget: 42_000 },
      modelCapabilityOverrides: {
        "deepseek-chat": {
          optimalMaxTokens: 12_000,
          riskMaxTokens: 24_000,
        },
      },
    };
    const factory = createHostAdvancementModelProviderFactory({
      config,
      credentials,
    });

    const binding = factory.create(Object.freeze({
      resourceMeter,
      evidenceCapabilities: {
        independentKinds: ["file-diff", "log", "artifact"],
      },
    }));

    expect(() => assertAdvancementModelProviderBinding(binding)).not.toThrow();
    expect(Object.keys(binding).sort()).toEqual([
      "completion",
      "reviewer",
      "sessionTokenBudget",
    ]);
    expect(binding.sessionTokenBudget).toBe(42_000);
    expect("config" in binding).toBe(false);
    expect("credentials" in binding).toBe(false);
    expect("roles" in binding).toBe(false);
    expect("capability" in binding).toBe(false);
  });

  it("fails before publishing a binding when required Provider configuration is absent", () => {
    const factory = createHostAdvancementModelProviderFactory({
      config: {},
      credentials,
    });

    expect(() => factory.create(Object.freeze({ resourceMeter }))).toThrow(
      "ZhixingConfig.llm.main is required",
    );
  });
});
