import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { CredentialExposureRecord, SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { createCredentialExposureRecord } from "@zhixing/mesh/credential-exposure";
import type { ZhixingConfig } from "@zhixing/providers";
import type { CredentialRotationSecretProjection } from "../runtime/runtime-secret-projections.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import { publishRequiredCredentialRotations } from "./credential-rotation-publication.js";

describe("credential rotation publication", { timeout: 30_000 }, () => {
  it("service-verifies provider, channel and MCP rotations before one exposure transaction each", async () => {
    const fixture = await createFixture([
      ["provider", "main"],
      ["channel", "chat"],
      ["mcp", "docs"],
    ]);

    await publishRequiredCredentialRotations({
      ...fixture.options,
      probeProvider: async ({ providerId }) => `provider:${providerId}:https://verified.invalid`,
      mcpStatuses: () => [{
        serverId: "docs",
        status: "connected",
        transport: "http",
        toolCount: 1,
      }],
      channelStatuses: () => [{ channelId: "feishu", state: "connected" }],
      waitForChannels: async () => undefined,
    });

    const firstEntries = await fixture.log.readStream<CredentialExposureRecord>("exposure");
    const firstProjection = await fixture.authority.projection();
    expect(firstProjection.rotationRequired).toEqual([]);
    expect(firstProjection.records.filter((record) =>
      record.deviceId === "current-device" && record.state === "active"))
      .toHaveLength(3);
    expect(firstProjection.records.filter((record) =>
      record.deviceId === "lost-device" && record.state === "rotated"))
      .toHaveLength(3);
    expect(firstProjection.records.filter((record) =>
      record.deviceId === "current-device" && record.state === "active")
      .every((record) => record.principalFingerprint?.startsWith("sha256:")))
      .toBe(true);

    await publishRequiredCredentialRotations({
      ...fixture.options,
      probeProvider: async ({ providerId }) => `provider:${providerId}:https://verified.invalid`,
      mcpStatuses: () => [{
        serverId: "docs",
        status: "connected",
        transport: "http",
        toolCount: 1,
      }],
      channelStatuses: () => [{ channelId: "feishu", state: "connected" }],
      waitForChannels: async () => undefined,
    });
    expect(await fixture.log.readStream("exposure")).toHaveLength(firstEntries.length);
  });

  it("keeps the compromised exposure when SecretStore read-back differs", async () => {
    const fixture = await createFixture([["provider", "main"]]);

    await expect(publishRequiredCredentialRotations({
      ...fixture.options,
      readCredentials: async () => ({ providers: { main: { apiKey: "different" } } }),
      probeProvider: async () => "provider:main:https://verified.invalid",
    })).rejects.toThrow(/read-back/i);

    expect((await fixture.authority.projection()).rotationRequired).toHaveLength(1);
    expect(await fixture.log.readStream("exposure")).toHaveLength(2);
  });

  it("keeps the compromised exposure when the current service is unavailable", async () => {
    const fixture = await createFixture([["mcp", "docs"]]);

    await expect(publishRequiredCredentialRotations({
      ...fixture.options,
      mcpStatuses: () => [{
        serverId: "docs",
        status: "connecting",
        transport: "http",
        toolCount: 0,
      }],
    })).rejects.toThrow(/not connected/i);

    expect((await fixture.authority.projection()).rotationRequired).toHaveLength(1);
    expect(await fixture.log.readStream("exposure")).toHaveLength(2);
  });

  it("fails closed before an ungoverned production provider verification", async () => {
    const fixture = await createFixture([["provider", "main"]]);

    await expect(publishRequiredCredentialRotations(fixture.options)).rejects.toThrow(
      "Credential provider verification governor is not configured",
    );

    expect((await fixture.authority.projection()).rotationRequired).toHaveLength(1);
    expect(await fixture.log.readStream("exposure")).toHaveLength(2);
  });
});

type BindingKind = "provider" | "channel" | "mcp";

async function createFixture(bindings: readonly (readonly [BindingKind, string])[]) {
  const root = await createTempDir("credential-rotation-publication");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts);
  onTestFinished(() => log.stopStorageMaintenance());
  const secretStore = new MemorySecretStore();
  const source = new CredentialExposureAuthority({
    deviceId: "lost-device",
    log,
    secretStore,
  });
  const descriptors = bindings.map(([kind, id]) => ({
    bindingId: `user-alias:lost-device:credential-${kind}-${id}`,
    service: `${kind}-${id}`,
    verification: "service-verified" as const,
    principalFingerprint: `sha256:${kind === "provider" ? "1" : kind === "channel" ? "2" : "3"}`.padEnd(71, kind === "provider" ? "1" : kind === "channel" ? "2" : "3"),
    revision: 1,
  }));
  const active = await source.publishActiveBindings({
    bindings: descriptors,
    markedAt: "2026-08-10T00:00:00.000Z",
  });
  await log.append(active.records.map((record) => ({
    stream: "exposure" as const,
    body: {
      ...record,
      state: "compromised" as const,
      markedAt: "2026-08-10T00:01:00.000Z",
    },
  })));
  const authority = new CredentialExposureAuthority({
    deviceId: "current-device",
    log,
    secretStore,
    now: () => "2026-08-10T00:02:00.000Z",
  });
  const credentials: CredentialRotationSecretProjection = {
    providers: { main: { apiKey: "provider-secret" } },
    channels: { chat: { appId: "app-current", appSecret: "channel-secret" } },
    mcp: { docs: { token: "mcp-secret" } },
  };
  const config: ZhixingConfig = {
    llm: { main: { provider: "main", model: "model-main" } },
    messaging: { chat: { type: "feishu" } },
    mcp: { servers: { docs: { type: "http", url: "https://mcp.invalid" } } },
  };
  return {
    authority,
    log,
    options: {
      authority,
      deviceId: "current-device",
      config,
      credentials,
      credentialGeneration: "generation-current",
      readCredentials: async () => credentials,
      mcpStatuses: () => [],
      channelStatuses: () => [],
      now: () => "2026-08-10T00:02:00.000Z",
    },
  };
}

class MemorySecretStore implements SecretStorePort {
  async put(_ref: SecretRef, _value: string): Promise<void> {}
  async get(_ref: SecretRef): Promise<string | null> { return null; }
  async delete(_ref: SecretRef): Promise<void> {}
  async list(): Promise<readonly SecretRef[]> { return []; }
  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}
