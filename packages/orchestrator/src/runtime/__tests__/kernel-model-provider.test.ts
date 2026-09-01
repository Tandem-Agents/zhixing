import { describe, expect, it } from "vitest";
import { MockLLMProvider, type LLMRole } from "@zhixing/core";
import {
  assertKernelModelProviderBinding,
  createKernelModelProviderBinding,
} from "../kernel-model-provider.js";

function role(provider: MockLLMProvider, model: string): LLMRole {
  return {
    provider,
    model,
    chat: (request) => provider.chat(request),
  };
}

function fixture() {
  const provider = new MockLLMProvider([{ text: "ok" }]);
  const main = role(provider, "main-model");
  const power = role(provider, "power-model");
  return {
    primaryRole: "main" as const,
    roles: { main, light: main, power },
    roleThinking: {
      main: { mode: "effort" as const, effort: "high" },
      light: undefined,
      power: undefined,
    },
    defaultMaxOutputTokens: { main: 8192, light: 4096, power: 16_384 },
    primary: {
      budget: { contextWindow: 128_000, maxOutputTokens: 8192 },
      inputCapabilities: { images: true },
      attention: { optimalMaxTokens: 64_000, riskMaxTokens: 96_000 },
    },
  };
}

describe("Kernel model provider binding", () => {
  it("captures one finite immutable value without freezing the provider implementation", () => {
    const input = fixture();
    const binding = createKernelModelProviderBinding(input);

    input.roles.main.model = "mutated";
    input.primary.budget.contextWindow = 1;
    input.roleThinking.main.effort = "low";

    expect(binding.roles.main.model).toBe("main-model");
    expect(binding.primary.budget.contextWindow).toBe(128_000);
    expect(binding.roleThinking.main).toEqual({ mode: "effort", effort: "high" });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.roles.main)).toBe(true);
    expect(Object.isFrozen(binding.roles.main.provider)).toBe(false);
    expect(() => assertKernelModelProviderBinding(binding, "main")).not.toThrow();
  });

  it("rejects a mutable, extended, or wrong-primary binding", () => {
    const valid = createKernelModelProviderBinding(fixture());
    expect(() => assertKernelModelProviderBinding(valid, "power")).toThrow(
      "Kernel model provider binding must be finite and immutable",
    );
    expect(() =>
      assertKernelModelProviderBinding({ ...valid } as never),
    ).toThrow("Kernel model provider binding must be finite and immutable");
    expect(() =>
      assertKernelModelProviderBinding(
        Object.freeze({ ...valid, providerConfig: {} }) as never,
      ),
    ).toThrow("Kernel model provider binding must be finite and immutable");
  });
});
