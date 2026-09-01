import { describe, expect, it, vi } from "vitest";
import { assertKernelModelProviderBinding } from "@zhixing/orchestrator/runtime";
import type {
  ProviderCredentialProjection,
  ZhixingConfig,
} from "@zhixing/providers";
import {
  createHostKernelModelProviderFactory,
  createHostKernelRuntimeEnvironmentFactory,
} from "../kernel-runtime-bindings.js";
import { projectRuntimeConfiguration } from "../runtime-configuration-projections.js";
import { createRuntimeConfigurationSnapshot } from "../runtime-configuration-snapshot.js";

const credentials: ProviderCredentialProjection = {
  providers: { deepseek: { apiKey: "test-only" } },
};

function config(overrides: Partial<ZhixingConfig> = {}): ZhixingConfig {
  return {
    llm: {
      main: { provider: "deepseek", model: "deepseek-chat" },
    },
    ...overrides,
  };
}

function projections(configuration: ZhixingConfig) {
  return projectRuntimeConfiguration(
    createRuntimeConfigurationSnapshot(configuration),
  );
}

describe("Host Kernel runtime bindings", () => {
  it("resolves main/light/power once and applies a job main-model override", () => {
    const configuration = projections(config());
    const factory = createHostKernelModelProviderFactory({
      configuration: configuration.model,
      credentials,
    });

    const power = factory.create({ primaryRole: "power" });
    const job = factory.create({
      primaryRole: "main",
      mainModelOverride: "deepseek-reasoner",
    });

    expect(power.primaryRole).toBe("power");
    expect(power.roles.light.model).toBe("deepseek-chat");
    expect(power.roles.power.model).toBe("deepseek-chat");
    expect(job.roles.main.model).toBe("deepseek-reasoner");
    expect(job.primary.budget.contextWindow).toBeGreaterThan(0);
    expect(() => assertKernelModelProviderBinding(power, "power")).not.toThrow();
    expect(() => assertKernelModelProviderBinding(job, "main")).not.toThrow();
    expect(Object.keys(job.primary.attention).sort()).toEqual([
      "optimalMaxTokens",
      "riskMaxTokens",
    ]);
    expect("modelId" in job.primary.attention).toBe(false);
    expect(Object.isFrozen(job.roles.main)).toBe(true);
    expect("config" in job).toBe(false);
    expect("credentials" in job).toBe(false);
  });

  it("keeps optional-role degradation visible while returning the main fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const configuration = projections(config({
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          light: { provider: "openai", model: "gpt-4o-mini" },
        },
      }));
      const factory = createHostKernelModelProviderFactory({
        configuration: configuration.model,
        credentials,
      });

      const binding = factory.create({ primaryRole: "main" });

      expect(binding.roles.light.model).toBe("deepseek-chat");
      expect(warn.mock.calls.flat().join("\n")).toContain("已回退主模型");
    } finally {
      warn.mockRestore();
    }
  });

  it("projects identity/proxy and preserves explicit no-workspace without config leakage", () => {
    const configuration = projections(config({
      agent: { displayName: "测试知行" },
      network: { proxy: "http://127.0.0.1:8080" },
    }));
    const factory = createHostKernelRuntimeEnvironmentFactory({
      configuration: configuration.kernelEnvironment,
    });

    const environment = factory.create({ workspace: null });

    expect(environment.agentIdentity.displayName).toBe("测试知行");
    expect(environment.networkProxy).toBe("http://127.0.0.1:8080");
    expect(environment.workspace).toEqual({ path: null, source: "none" });
    expect(Object.isFrozen(environment.workspace)).toBe(true);
    expect("config" in environment).toBe(false);
  });
});
