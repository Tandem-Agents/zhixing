import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog, FileDurableProjectionIndex } from "@zhixing/core/authority";
import type { CredentialExposureRecord, SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { createCredentialExposureRecord } from "@zhixing/mesh/credential-exposure";
import type { ZhixingConfig } from "@zhixing/providers";
import type { CredentialRotationSecretProjection } from "../runtime/runtime-secret-projections.js";
import { projectRuntimeConfiguration } from "../runtime/runtime-configuration-projections.js";
import { createRuntimeConfigurationSnapshot } from "../runtime/runtime-configuration-snapshot.js";
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
      channelStatuses: () => [{ channelId: "chat", state: "connected" }],
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
      channelStatuses: () => [{ channelId: "chat", state: "connected" }],
      waitForChannels: async () => undefined,
    });
    expect(await fixture.log.readStream("exposure")).toHaveLength(firstEntries.length);
  });

  it("reads only the pending rotations whatever the number of past identities, advancing from the highest binding revision", async () => {
    const rows: { history: number; keys: number; scanned: number; revision: number | undefined }[] = [];
    for (const history of [16, 128, 512]) {
      const fixture = await createFixture([
        ["provider", "main"],
        ["channel", "chat"],
        ["mcp", "docs"],
      ]);
      const binding = "user-alias:current-device:credential-provider-main";
      const principal = (index: number) => ({
        verification: "service-verified" as const,
        canonicalProviderPrincipal: `past-principal-${index}@example.invalid`,
      });
      // 与本次轮换无关的过往身份：其他设备的同名逻辑绑定，均已轮换
      const unrelated = Array.from({ length: history }, (_, index) => createCredentialExposureRecord({
        deviceId: `past-device-${index}`,
        bindingId: `user-alias:past-device-${index}:credential-provider-main`,
        bindingRevision: 1 + (index % 4),
        service: "provider-main",
        verifiedPrincipal: principal(index),
        markedAt: "2026-08-10T00:00:10.000Z",
      }));
      // 本机同一绑定的过往主体：修订号按 7、3、5 的次序写入，下一修订号应取历来最大的 7 再加一
      const own = [7, 3, 5].map((revision) => createCredentialExposureRecord({
        deviceId: "current-device",
        bindingId: binding,
        bindingRevision: revision,
        service: "provider-main",
        verifiedPrincipal: principal(1000 + revision),
        markedAt: "2026-08-10T00:00:20.000Z",
      }));
      await fixture.log.append([...unrelated, ...own].flatMap((record) => [
        { stream: "exposure" as const, body: record },
        { stream: "exposure" as const, body: { ...record, state: "rotated" as const, markedAt: "2026-08-10T00:00:30.000Z" } },
      ]));
      const counts = { keys: 0, scanned: 0 };
      const prototype = FileDurableProjectionIndex.prototype;
      const { get, getMany, scan } = prototype;
      const spies = [
        vi.spyOn(prototype, "get").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
          counts.keys += 1;
          return get.apply(this, args);
        }),
        vi.spyOn(prototype, "getMany").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
          counts.keys += args[0].length;
          return getMany.apply(this, args);
        }),
        vi.spyOn(prototype, "scan").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
          const page = await scan.apply(this, args);
          counts.scanned += page.entries.length;
          return page;
        }),
      ];
      try {
        await publishRequiredCredentialRotations({
          ...fixture.options,
          probeProvider: async ({ providerId }) => `provider:${providerId}:https://verified.invalid`,
          mcpStatuses: () => [{ serverId: "docs", status: "connected", transport: "http", toolCount: 1 }],
          channelStatuses: () => [{ channelId: "chat", state: "connected" }],
          waitForChannels: async () => undefined,
        });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const projection = await fixture.authority.projection();
      expect(projection.rotationRequired).toEqual([]);
      const current = projection.records.find((record) =>
        record.deviceId === "current-device" && record.bindingId === binding && record.state === "active");
      rows.push({ history, ...counts, revision: current?.bindingRevision });
    }
    // allow-direct-stdout：规模用例的读数输出；测试文件不是运行时输出面
    console.log("ROTATION_PUBLICATION_ROWS", JSON.stringify(rows));
    for (const row of rows) expect(row.revision).toBe(8);
    // 读取只随待轮换数：三档相同（从全量投影起步时随过往身份增长）
    expect(rows.map(({ keys, scanned }) => [keys, scanned]))
      .toEqual(rows.map(() => [rows[0]!.keys, rows[0]!.scanned]));
  }, 300_000);

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

  it.each(["pending", "another-instance"])("does not verify channel credentials from %s transport evidence", async (kind) => {
    const fixture = await createFixture([["channel", "chat"]]);
    await expect(publishRequiredCredentialRotations({ ...fixture.options,
      channelStatuses: () => [{ channelId: kind === "pending" ? "chat" : "feishu", state: "connected",
        ...(kind === "pending" ? { configurationIssue: "配置待应用" } : {}) }],
    })).rejects.toThrow(/not connected/i);
    expect((await fixture.authority.projection()).rotationRequired).toHaveLength(1);
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
  const configuration = projectRuntimeConfiguration(
    createRuntimeConfigurationSnapshot(config),
  ).credentialRotation;
  return {
    authority,
    log,
    options: {
      authority,
      deviceId: "current-device",
      configuration,
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
