import type { ZhixingConfig } from "@zhixing/providers";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeConfigurationProvider } from "../runtime-configuration-provider.js";

describe("RuntimeConfigurationProvider", () => {
  it("publishes only frozen REPL display values and redacts the proxy source", () => {
    const source = {
      llm: { main: { provider: "openai", model: "gpt-current" } },
      network: { proxy: "http://admin:secret@proxy.example:8080" },
      mesh: { enabledRoles: ["anchor"] },
    } as unknown as ZhixingConfig;
    const loadConfiguration = vi.fn(() => source);
    const provider = createRuntimeConfigurationProvider(loadConfiguration);

    const projection = provider.readReplSurface();

    expect(Object.keys(projection).sort()).toEqual([
      "networkProxy",
      "primaryModel",
    ]);
    expect(projection.primaryModel).toEqual({
      providerId: "openai",
      model: "gpt-current",
    });
    expect(projection.networkProxy).toMatchObject({
      mode: "explicit",
      hasResolvedProxy: true,
    });
    expect(projection.networkProxy.display).not.toMatch(/admin|secret/u);
    expect(JSON.stringify(projection)).not.toMatch(/admin|secret/u);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.primaryModel)).toBe(true);
    expect(Object.isFrozen(projection.networkProxy)).toBe(true);

    source.llm!.main.model = "mutated-after-read";
    expect(projection.primaryModel.model).toBe("gpt-current");
    expect(provider.readReplSurface().primaryModel.model).toBe(
      "mutated-after-read",
    );
  });

  it("publishes only the canonical topology purpose projection", () => {
    const source = {
      mesh: { enabledRoles: ["anchor"] },
      llm: { main: { provider: "openai", model: "gpt-current" } },
    } as unknown as ZhixingConfig;
    const loadConfiguration = vi.fn(() => source);
    const provider = createRuntimeConfigurationProvider(loadConfiguration);

    const topology = provider.readTopology({ homeDir: "C:/zhixing-home" });

    expect(loadConfiguration).toHaveBeenCalledWith({
      homeDir: "C:/zhixing-home",
    });
    expect(Object.keys(topology)).toEqual(["mesh"]);
    expect(topology.mesh).toEqual({ enabledRoles: ["anchor"] });
    expect(Object.isFrozen(topology)).toBe(true);
    expect(Object.isFrozen(topology.mesh)).toBe(true);
  });
});
