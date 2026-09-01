import type { ZhixingConfig } from "@zhixing/providers";
import { describe, expect, it } from "vitest";
import { projectRuntimeConfiguration } from "../runtime-configuration-projections.js";
import { createRuntimeConfigurationSnapshot } from "../runtime-configuration-snapshot.js";

describe("runtime configuration purpose projections", () => {
  it("deep-clones and freezes the exact fields for every production purpose", () => {
    const source: ZhixingConfig = {
      mesh: { enabledRoles: ["anchor", "executor"] },
      llm: {
        main: { provider: "main", model: "model-main" },
        light: { provider: "light", model: "model-light" },
      },
      messaging: {
        chat: {
          type: "feishu",
          options: { labels: ["one"] },
          defaultTarget: { to: "owner" },
        },
      },
      mcp: {
        servers: {
          docs: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
          },
        },
      },
      agent: { displayName: "知行" },
      intent: { cancelKeywords: ["停止"] },
      workspace: { root: "C:\\workspace", protectedPaths: ["private"] },
      network: { proxy: "off" },
      advancement: { sessionTokenBudget: 42_000 },
      modelCapabilityOverrides: {
        "model-main": {
          optimalMaxTokens: 12_000,
          riskMaxTokens: 24_000,
        },
      },
    };
    const snapshot = createRuntimeConfigurationSnapshot(source);
    const projections = projectRuntimeConfiguration(snapshot);

    expect(Object.keys(projections).sort()).toEqual([
      "advancement",
      "authority",
      "channel",
      "credentialRotation",
      "kernelEnvironment",
      "mcp",
      "model",
      "topology",
      "workspace",
    ]);
    expect(Object.keys(projections.topology)).toEqual(["mesh"]);
    expect(Object.keys(projections.model).sort()).toEqual([
      "llm",
      "modelCapabilityOverrides",
    ]);
    expect(Object.keys(projections.kernelEnvironment).sort()).toEqual([
      "agent",
      "network",
      "workspace",
    ]);
    expect(Object.keys(projections.advancement).sort()).toEqual([
      "advancement",
      "llm",
      "modelCapabilityOverrides",
      "workspace",
    ]);
    expect(Object.keys(projections.mcp).sort()).toEqual(["mcp", "network"]);
    expect(Object.keys(projections.channel).sort()).toEqual([
      "intent",
      "messaging",
    ]);
    expect(Object.keys(projections.workspace)).toEqual(["workspace"]);
    expect(Object.keys(projections.credentialRotation).sort()).toEqual([
      "llm",
      "messaging",
    ]);
    expect(projections.authority).toEqual(snapshot);

    expect(Object.isFrozen(projections)).toBe(true);
    expect(Object.isFrozen(projections.model)).toBe(true);
    expect(Object.isFrozen(projections.model.llm)).toBe(true);
    expect(Object.isFrozen(projections.channel.messaging?.chat?.options)).toBe(
      true,
    );
    expect(Object.isFrozen(projections.mcp.mcp?.servers?.docs?.args)).toBe(true);
    expect(Object.isFrozen(projections.authority)).toBe(true);
    expect(projections.model.llm).not.toBe(snapshot.llm);
    expect(projections.model.llm).not.toBe(projections.advancement.llm);
    expect(projections.authority.llm).not.toBe(snapshot.llm);

    source.llm!.main.model = "changed-source";
    expect(projections.model.llm?.main.model).toBe("model-main");
    expect(() => {
      projections.model.llm!.main.model = "runtime-mutation";
    }).toThrow();
  });

  it("preserves absence and explicit undefined without adding defaults", () => {
    const snapshot = createRuntimeConfigurationSnapshot({
      messaging: undefined,
      network: { proxy: undefined },
    });
    const projections = projectRuntimeConfiguration(snapshot);

    expect("messaging" in projections.channel).toBe(true);
    expect(projections.channel.messaging).toBeUndefined();
    expect("intent" in projections.channel).toBe(false);
    expect(projections.mcp.network).toEqual({ proxy: undefined });
    expect("mcp" in projections.mcp).toBe(false);
    expect(Object.isFrozen(projections.mcp.network)).toBe(true);
    expect("llm" in projections.model).toBe(false);
    expect("workspace" in projections.workspace).toBe(false);
  });
});
