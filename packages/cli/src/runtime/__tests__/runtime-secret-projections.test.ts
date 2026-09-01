import { describe, expect, it } from "vitest";
import type { ZhixingCredentials } from "@zhixing/providers";
import { projectRuntimeSecrets } from "../runtime-secret-projections.js";

describe("runtime secret projections", () => {
  it("publishes frozen purpose exact-sets without sharing mutable source containers", () => {
    const source: ZhixingCredentials = {
      version: 1,
      providers: {
        main: {
          apiKey: "provider-secret",
          models: ["model-a"],
        },
      },
      mcp: { docs: { authorization: "mcp-secret" } },
      channels: { chat: { appId: "app-a", appSecret: "channel-secret" } },
    };

    const projections = projectRuntimeSecrets(source);

    expect(Object.keys(projections).sort()).toEqual([
      "channelCredentials",
      "credentialExposureCredentials",
      "credentialRotationCredentials",
      "mcpCredentials",
      "providerCredentials",
    ]);
    expect(Object.keys(projections.providerCredentials)).toEqual(["providers"]);
    expect(Object.keys(projections.mcpCredentials)).toEqual(["mcp"]);
    expect(Object.keys(projections.channelCredentials)).toEqual(["channels"]);
    expect(Object.keys(projections.credentialExposureCredentials).sort()).toEqual([
      "mcp",
      "providers",
    ]);
    expect(Object.keys(projections.credentialRotationCredentials).sort()).toEqual([
      "channels",
      "mcp",
      "providers",
    ]);
    expect("version" in projections.credentialRotationCredentials).toBe(false);
    expect(Object.isFrozen(projections)).toBe(true);
    expect(Object.isFrozen(projections.providerCredentials)).toBe(true);
    expect(Object.isFrozen(projections.providerCredentials.providers)).toBe(true);
    expect(Object.isFrozen(
      projections.providerCredentials.providers?.main?.models,
    )).toBe(true);
    expect(projections.providerCredentials.providers).not.toBe(source.providers);
    expect(projections.mcpCredentials.mcp).not.toBe(source.mcp);
    expect(projections.channelCredentials.channels).not.toBe(source.channels);

    source.providers!.main!.apiKey = "changed-after-publication";
    expect(projections.providerCredentials.providers?.main?.apiKey)
      .toBe("provider-secret");
  });

  it("preserves missing families as frozen empty purpose projections", () => {
    const projections = projectRuntimeSecrets({});

    for (const projection of Object.values(projections)) {
      expect(projection).toEqual({});
      expect(Object.isFrozen(projection)).toBe(true);
    }
  });
});
