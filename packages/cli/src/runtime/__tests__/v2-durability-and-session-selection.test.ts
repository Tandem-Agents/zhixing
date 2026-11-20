import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedVaultSecretStore, type MasterKeyProvider } from "@zhixing-ai/secrets";
import {
  MODEL_RETIREMENTS_REF,
  readManifestMetadataUnlocked,
  writeCredentials,
  settlePendingModelRetirements,
  type LLMConfigV2,
} from "@zhixing-ai/providers/configuration";
import { buildBuiltinRegistry, createServerContext } from "@zhixing-ai/server";
import { createLocalConfigurationApplication } from "../../serve/local-configuration-application.js";
import { ModelRuntimePort } from "../model-runtime-port.js";
import { projectRuntimeConfiguration } from "../runtime-configuration-projections.js";
import { projectRuntimeSecrets } from "../runtime-secret-projections.js";
import { checkModel } from "../model-configuration-check.js";

function makeMemoryKey(bytes: Buffer): MasterKeyProvider {
  return {
    state: async () => "unlocked",
    loadExisting: async () => Buffer.from(bytes),
    loadOrCreate: async () => Buffer.from(bytes),
  };
}

describe("Unit 1 Group D: real EncryptedVaultSecretStore durability, revocation restart, headless concurrency & session modelSelection RPC", () => {
  const dirs: string[] = [];

  async function mkTempHome(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-u1-durability-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("migrates v1→v2 on real EncryptedVaultSecretStore, persists explicit revocation across store restart without resurrection, and settles retirements idempotently", async () => {
    const homeDir = await mkTempHome();
    const configPath = path.join(homeDir, "config.jsonc");
    const vaultPath = path.join(homeDir, "secrets.vault.json");
    const keyBytes = randomBytes(32);

    const openStore = () =>
      new EncryptedVaultSecretStore({
        vaultPath,
        masterKey: makeMemoryKey(keyBytes),
      });

    // 1. Seed a real v1 config + v1 secret on disk
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          llm: {
            main: { provider: "deepseek", model: "deepseek-chat" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const store1 = openStore();
    await writeCredentials(
      {
        providers: {
          deepseek: { apiKey: "sk-v1-live-secret-123456" },
        },
      },
      { store: store1 },
    );

    // 2. Startup auto-migration via localConfigurationApplication
    const app1 = createLocalConfigurationApplication({
      homeDir,
      configPath,
      store: store1,
    });
    const migrated = await app1.read({ autoMigrate: true });
    expect((migrated.config.llm as LLMConfigV2 | undefined)?.schemaVersion).toBe(2);
    expect(migrated.credentials.modelSecrets?.deepseek?.value).toBe("sk-v1-live-secret-123456");

    // Verify MANIFEST_REF persisted modelConfigVersion: 2 on real vault
    const manifestMeta = await readManifestMetadataUnlocked(openStore());
    expect(manifestMeta).not.toBeNull();
    expect(manifestMeta!.modelConfigVersion).toBe(2);

    // 3. Add a backup connection, then explicitly REVOKE deepseek's secret while rebinding main
    const llmV2 = migrated.config.llm as LLMConfigV2;
    const nextLlm: LLMConfigV2 = {
      schemaVersion: 2,
      connections: {
        backup: {
          name: "Local Ollama",
          presetId: "ollama",
          adapter: "openai-compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          auth: { mode: "none" },
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      },
      main: { connectionId: "backup", model: "qwen2.5:14b" },
    };
    expect(llmV2.connections.deepseek).toBeDefined();

    await app1.edit(
      { config: migrated.config, credentials: migrated.credentials },
      {
        config: { ...migrated.config, llm: nextLlm },
        credentials: {
          ...migrated.credentials,
          version: 2,
          modelSecrets: {},
          revokedModelSecretRefs: ["deepseek"],
        },
      },
      {
        modelRetirements: [
          {
            operationId: "revoke-op-1",
            connectionId: "deepseek",
            secretRef: "deepseek",
            mode: "revoke",
            sourceRevision: "rev-1",
            createdAt: new Date().toISOString(),
          },
        ],
        forceModelConfigVersion2: true,
      },
    );

    // 4. Simulate cold process restart: brand new EncryptedVaultSecretStore on same disk vault
    const storeAfterRestart = openStore();
    const appAfterRestart = createLocalConfigurationApplication({
      homeDir,
      configPath,
      store: storeAfterRestart,
    });
    const reloaded = await appAfterRestart.read({ autoMigrate: true });

    // Revoked secret MUST NOT resurrect after restart!
    expect(reloaded.credentials.modelSecrets?.deepseek).toBeUndefined();
    expect(reloaded.credentials.revokedModelSecretRefs).toContain("deepseek");
    expect((reloaded.config.llm as LLMConfigV2).main?.connectionId).toBe("backup");

    // Verify no-key backup connection is ready without fake credentials
    const cProj = projectRuntimeConfiguration(reloaded.config);
    const sProj = projectRuntimeSecrets(reloaded.credentials);
    const port = new ModelRuntimePort({
      modelConfiguration: cProj.model,
      advancementConfiguration: cProj.advancement,
      providerCredentials: sProj.providerCredentials,
      exposureCredentials: sProj.credentialExposureCredentials,
      credentialGeneration: reloaded.generation,
    });
    expect(port.readiness().credentialBindings).toEqual([]);
    expect(port.readiness().readyRoles).toEqual(["light", "main", "power"]);
    expect(checkModel(reloaded.config, reloaded.credentials)).toEqual([]);

    // Verify retirement settlement cleans up completed revocation records idempotently
    const settled = await settlePendingModelRetirements({
      configPath,
      store: storeAfterRestart,
      inFlightConnectionIds: [],
    });
    expect(settled.remaining).toBe(0);
    const rawRetirements = await storeAfterRestart.get(MODEL_RETIREMENTS_REF);
    expect(rawRetirements === null || JSON.parse(rawRetirements).entries.length === 0).toBe(true);
    await port.dispose();
  });

  it("handles headless concurrent first-run saves safely via real file lock + CAS without corrupting config or vault", async () => {
    const homeDir = await mkTempHome();
    const configPath = path.join(homeDir, "config.jsonc");
    const vaultPath = path.join(homeDir, "secrets.vault.json");
    const keyBytes = randomBytes(32);

    const openApp = () =>
      createLocalConfigurationApplication({
        homeDir,
        configPath,
        store: new EncryptedVaultSecretStore({
          vaultPath,
          masterKey: makeMemoryKey(keyBytes),
        }),
      });

    // Two independent headless processes read the initial empty state concurrently
    const appA = openApp();
    const appB = openApp();
    const [snapA, snapB] = await Promise.all([
      appA.read({ autoMigrate: true }),
      appB.read({ autoMigrate: true }),
    ]);

    const makeEdit = (connId: string, model: string, apiKey: string) => ({
      config: {
        llm: {
          schemaVersion: 2 as const,
          connections: {
            [connId]: {
              name: connId,
              presetId: "deepseek",
              adapter: "openai-compatible" as const,
              endpoint: "https://api.deepseek.com/v1",
              auth: { mode: "api-key" as const, secretRef: connId },
              network: { proxy: "inherit" as const },
            },
          },
          main: { connectionId: connId, model },
        },
      },
      credentials: {
        version: 2 as const,
        modelSecrets: {
          [connId]: { v: 2 as const, kind: "api-key" as const, value: apiKey },
        },
      },
    });

    const results = await Promise.allSettled([
      appA.edit({ config: snapA.config, credentials: snapA.credentials }, makeEdit("conn_a", "deepseek-chat", "sk-aaaa-111111"), {
        forceModelConfigVersion2: true,
      }),
      appB.edit({ config: snapB.config, credentials: snapB.credentials }, makeEdit("conn_b", "deepseek-reasoner", "sk-bbbb-222222"), {
        forceModelConfigVersion2: true,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/配置在编辑期间已变更/);

    // On-disk state must be completely consistent (either conn_a or conn_b, never torn)
    const finalSnap = await openApp().read();
    const finalLlm = finalSnap.config.llm as LLMConfigV2;
    const winnerId = finalLlm.main?.connectionId;
    expect(winnerId === "conn_a" || winnerId === "conn_b").toBe(true);
    expect(finalSnap.credentials.modelSecrets?.[winnerId!]?.value).toMatch(/^sk-(aaaa|bbbb)-/);
  });

  it("exposes session.getModelSelection and session.setModelSelection through canonical server RPC with validation and broadcast", async () => {
    const store = new Map<string, import("@zhixing-ai/core/contracts").SessionModelSelection>();
    const broadcasts: Array<{ id: string; method: string; payload: unknown }> = [];
    const ctx = createServerContext({
      config: { port: 0, host: "127.0.0.1", authTimeoutMs: 5_000, maxConnections: 8 },
      version: "0.0.0-test",
      token: "test-token",
      sessionModelSelection: {
        get: async (conversationId) =>
          store.get(conversationId) ?? { mode: "follow-default" },
        set: async (conversationId, modelSelection) => {
          store.set(conversationId, modelSelection);
          return modelSelection;
        },
      },
    });
    ctx.sessionBroadcast = (conversationId, method, payload) => {
      broadcasts.push({ id: conversationId, method, payload });
    };

    const registry = buildBuiltinRegistry();
    const getEntry = registry.get("session.getModelSelection");
    const setEntry = registry.get("session.setModelSelection");
    expect(getEntry).toBeDefined();
    expect(setEntry).toBeDefined();

    const fakeConn = {
      id: 1,
      authenticated: true,
      loopback: true,
      closed: false,
      notify: vi.fn(),
      onClose: () => () => {},
    } as never;

    // 1. Default state is follow-default
    const initial = await getEntry!.handler({ conversationId: "conv-1" }, { server: ctx, connection: fakeConn });
    expect(initial).toEqual({
      conversationId: "conv-1",
      modelSelection: { mode: "follow-default" },
    });

    // 2. Set structured override
    const override = {
      mode: "override" as const,
      connectionId: "openai_work",
      model: "gpt-5",
      maxOutputPreference: 4096,
    };
    const updated = await setEntry!.handler(
      { conversationId: "conv-1", modelSelection: override },
      { server: ctx, connection: fakeConn },
    );
    expect(updated).toEqual({ conversationId: "conv-1", modelSelection: override });
    expect(broadcasts).toEqual([
      {
        id: "conv-1",
        method: "session.changed",
        payload: {
          conversationId: "conv-1",
          change: "modelSelection",
          modelSelection: override,
        },
      },
    ]);

    // 3. Read back returns persisted override
    const afterSet = await getEntry!.handler({ conversationId: "conv-1" }, { server: ctx, connection: fakeConn });
    expect(afterSet).toEqual({ conversationId: "conv-1", modelSelection: override });

    // 4. Restore to follow-default
    const restored = await setEntry!.handler(
      { conversationId: "conv-1", modelSelection: { mode: "follow-default" } },
      { server: ctx, connection: fakeConn },
    );
    expect(restored).toEqual({
      conversationId: "conv-1",
      modelSelection: { mode: "follow-default" },
    });

    // 5. Rejects invalid arbitrary fields
    await expect(
      setEntry!.handler(
        {
          conversationId: "conv-1",
          modelSelection: { mode: "override", connectionId: "c1", model: "m1", params: { temperature: 0.9 } },
        },
        { server: ctx, connection: fakeConn },
      ),
    ).rejects.toThrow(/Unsupported modelSelection\.params field/);
  });
});
