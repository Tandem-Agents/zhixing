import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  completion: { complete: vi.fn() },
  reviewer: { review: vi.fn() },
  createProviderRoles: vi.fn(),
  resolveWorkspace: vi.fn(),
  resolveWorkspaceSessionType: vi.fn(),
  resolveModelCapability: vi.fn(),
  getModelCapabilityOverride: vi.fn(),
  createControlCompletionPort: vi.fn(),
  createAdvancementRuntime: vi.fn(),
}));

vi.mock("@zhixing/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zhixing/providers")>()),
  createProviderRoles: doubles.createProviderRoles,
  resolveWorkspace: doubles.resolveWorkspace,
  resolveWorkspaceSessionType: doubles.resolveWorkspaceSessionType,
  resolveModelCapability: doubles.resolveModelCapability,
  getModelCapabilityOverride: doubles.getModelCapabilityOverride,
  PROTOCOL_BUDGET_DEFAULTS: {
    "main-protocol": { maxOutputTokens: 2_222 },
    "light-protocol": { maxOutputTokens: 1_111 },
  },
}));

vi.mock("@zhixing/orchestrator/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zhixing/orchestrator/runtime")>()),
  createControlCompletionPort: doubles.createControlCompletionPort,
}));

vi.mock("@zhixing/orchestrator/advancement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zhixing/orchestrator/advancement")>()),
  createAdvancementRuntime: doubles.createAdvancementRuntime,
}));

import type { ZhixingConfig } from "@zhixing/providers";
import { createHostAdvancementModelProviderFactory } from "../advancement-model-provider.js";
import { projectRuntimeConfiguration } from "../runtime-configuration-projections.js";
import { createRuntimeConfigurationSnapshot } from "../runtime-configuration-snapshot.js";

const resourceMeter = {
  reserveUsage: vi.fn(async () => {}),
  consume: vi.fn(async () => {}),
};

describe("Host Advancement model provider projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.createControlCompletionPort.mockReturnValue(doubles.completion);
    doubles.createAdvancementRuntime.mockReturnValue(doubles.reviewer);
    doubles.resolveWorkspaceSessionType.mockReturnValue("conversation");
    doubles.resolveWorkspace.mockReturnValue({ path: "C:\\workspace" });
    doubles.getModelCapabilityOverride.mockReturnValue({ riskMaxTokens: 99 });
    doubles.resolveModelCapability.mockReturnValue({
      modelId: "provider-owned-model-id",
      optimalMaxTokens: 12_000,
      riskMaxTokens: 24_000,
    });
  });

  it("projects validated thinking, protocol budgets, workspace, attention, and session budget", () => {
    const mainProvider = {
      models: [{
        id: "main-model",
        name: "main",
        contextWindow: 32_000,
        maxOutputTokens: 4_000,
        thinkingControl: {
          type: "effort",
          efforts: ["high"],
          default: "high",
        },
      }],
    };
    const lightProvider = {
      models: [{
        id: "light-model",
        name: "light",
        contextWindow: 16_000,
        maxOutputTokens: 2_000,
        thinkingControl: { type: "none" },
      }],
    };
    const resolvedConfig: ZhixingConfig = {
      llm: {
        main: {
          provider: "main",
          model: "main-model",
          thinking: { mode: "effort", effort: "high" },
        },
        light: {
          provider: "light",
          model: "light-model",
          thinking: { mode: "on" },
        },
      },
      advancement: { sessionTokenBudget: 42_000 },
    };
    doubles.createProviderRoles.mockReturnValue({
      roles: {
        main: { provider: mainProvider, model: "main-model" },
        light: { provider: lightProvider, model: "light-model" },
      },
      resolvedRoles: {
        main: { resolved: { protocol: "main-protocol" } },
        light: { resolved: { protocol: "light-protocol" } },
      },
      config: resolvedConfig,
    });

    const configuration = projectRuntimeConfiguration(
      createRuntimeConfigurationSnapshot(resolvedConfig),
    );
    const binding = createHostAdvancementModelProviderFactory({
      configuration: configuration.advancement,
      credentials: {},
    }).create(Object.freeze({ resourceMeter }));

    expect(doubles.createControlCompletionPort).toHaveBeenCalledWith({
      roles: {
        main: { provider: mainProvider, model: "main-model" },
        light: { provider: lightProvider, model: "light-model" },
      },
      thinking: {
        main: { mode: "effort", effort: "high" },
        light: undefined,
      },
      meter: resourceMeter,
      defaultMaxOutputTokens: 1_111,
    });
    expect(doubles.createAdvancementRuntime).toHaveBeenCalledWith(expect.objectContaining({
      provider: mainProvider,
      model: "main-model",
      thinking: { mode: "effort", effort: "high" },
      lightProvider,
      lightModel: "light-model",
      lightThinking: undefined,
      resourceMeter,
      defaultMaxOutputTokens: 2_222,
      workingDirectory: "C:\\workspace",
      contextWindow: {
        capability: {
          optimalMaxTokens: 12_000,
          riskMaxTokens: 24_000,
        },
      },
    }));
    expect(doubles.createAdvancementRuntime.mock.calls[0]?.[0].contextWindow)
      .not.toHaveProperty("capability.modelId");
    expect(binding).toEqual({
      completion: doubles.completion,
      reviewer: doubles.reviewer,
      sessionTokenBudget: 42_000,
    });
  });
});
