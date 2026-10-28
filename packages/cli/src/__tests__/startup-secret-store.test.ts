import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { FileLockBusyError } from "@zhixing/core/persistence";
import { StorageMaintenanceAdmissionError } from "@zhixing/core/resources";
import { writeCredentials } from "@zhixing/providers";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { runStartupCheck } from "../startup.js";
import { checkStartupConfiguration } from "../runtime/startup-application.js";
import { FileMeshBootstrapStore } from "../serve/mesh-bootstrap-store.js";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { persistDeviceKey } from "@zhixing/mesh/device-key-store";
import { createLocalConfigurationApplication } from "../serve/local-configuration-application.js";
import { CredentialExposureAuthority } from "../serve/credential-exposure-authority.js";

class MemoryStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  unlockCalls = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly state: "unlocked" | "locked" = "unlocked") {}
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async put(ref: SecretRef, value: string) { this.values.set(key(ref), value); }
  async get(ref: SecretRef) { return this.values.get(key(ref)) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const storageKey = key(ref);
    const existing = this.values.get(storageKey);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(storageKey, value);
    return value;
  }

  async delete(ref: SecretRef) { this.values.delete(key(ref)); }
  async list(prefix: string) {
    return [...this.values.keys()].filter((value) => value.startsWith(prefix)).map((value) => {
      const separator = value.indexOf("/");
      return { kind: value.slice(0, separator) as SecretRef["kind"], bindingId: value.slice(separator + 1) };
    });
  }
  async unlockState() {
    this.unlockCalls += 1;
    return this.state;
  }
}

describe("startup SecretStore boundary", () => {
  it.each([
    new FileLockBusyError('synthetic-authority'),
    new StorageMaintenanceAdmissionError({ kind: 'backpressured', blockedBy: 'ioOperations', retryAfterMs: 25 }),
  ])('reports a blocked configuration authority without claiming the credential store is broken: %s', async error => {
    const homeDir = await createTempDir('startup-preparation-unavailable');
    await writeFile(path.join(homeDir, 'config.jsonc'), JSON.stringify({ llm: { main: { provider: 'deepseek', model: 'deepseek-chat' } } }));
    const edit = vi.fn(async () => ({ kind: 'non-tty' as const }));
    // 接续期限内一直不可读才交给用户
    const result = await checkStartupConfiguration({ homeDir, mode: 'repl', secretStore: new MemoryStore(), edit, readContinuationMs: 300,
      configuration: { read: async () => { throw error; }, edit: async () => { throw Error('must not edit'); } } });
    expect(result).toMatchObject({ kind: 'read-unavailable', message: expect.stringContaining('稍后重试') });
    expect(edit).not.toHaveBeenCalled();
  });
  it.each([
    new FileLockBusyError('synthetic-authority'),
    new StorageMaintenanceAdmissionError({ kind: 'backpressured', blockedBy: 'ioOperations', retryAfterMs: 25 }),
  ])('continues the same startup attempt once a normal internal contention clears: %s', async error => {
    const homeDir = await createTempDir('startup-preparation-continues');
    let attempts = 0;
    const result = await checkStartupConfiguration({ homeDir, mode: 'repl', secretStore: new MemoryStore(), edit: vi.fn(),
      configuration: { read: async () => {
        if (++attempts < 3) throw error;
        return { config: { llm: { main: { provider: 'deepseek', model: 'deepseek-chat' } } }, credentials: {}, generation: 'g1' } as never;
      }, edit: async () => { throw Error('must not edit'); } } });
    expect(attempts).toBe(3);
    expect(result.kind).not.toBe('read-unavailable');
  });
  it('does not retry a non-retryable admission refusal and stops continuing when the attempt is cancelled', async () => {
    const homeDir = await createTempDir('startup-preparation-refused');
    let attempts = 0;
    const refused = await checkStartupConfiguration({ homeDir, mode: 'repl', secretStore: new MemoryStore(), edit: vi.fn(),
      configuration: { read: async () => { attempts++; throw new StorageMaintenanceAdmissionError({ kind: 'capacity-gap', blockedBy: 'temporaryBytes', required: 2, available: 1 }); },
        edit: async () => { throw Error('must not edit'); } } });
    expect(refused).toMatchObject({ kind: 'read-unavailable' });
    expect(attempts).toBe(1);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await expect(checkStartupConfiguration({ homeDir, mode: 'repl', secretStore: new MemoryStore(), edit: vi.fn(), signal: abort.signal,
      configuration: { read: async () => { throw new FileLockBusyError('synthetic-authority'); }, edit: async () => { throw Error('must not edit'); } } }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
  it("a reused local configuration port rechecks committed exposure before returning credentials", async () => {
    const homeDir = await createTempDir("configuration-fresh-policy"), store = new MemoryStore();
    const device = await DeviceKey.generate(); await persistDeviceKey(store, device);
    const writer = await FileMeshBootstrapStore.open(homeDir, device, { secretStore: store });
    try {
      await writer.initializeLocalHome({ key: device,
        identity: enrollDeviceIdentity(device, { displayName: "synthetic", platform: "linux", enrolledAt: "2026-10-17T00:00:00.000Z" }),
        roles: ["anchor", "executor"], homeId: "configuration-fresh-policy", at: "2026-10-17T00:00:00.000Z" });
      const application = createLocalConfigurationApplication({ homeDir, configPath: path.join(homeDir, "config.jsonc"), store });
      const initial = await application.read();
      await application.edit(initial, { config: { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
        credentials: { providers: { deepseek: { apiKey: "synthetic-only" } } } });
      expect((await application.read()).credentials.providers?.deepseek?.apiKey).toBe("synthetic-only");
      const exposure = new CredentialExposureAuthority({ deviceId: device.deviceId, log: writer.authorityLog(), secretStore: store });
      const record = (await exposure.publishActiveBindings({ bindings: [{
        bindingId: `user-alias:${device.deviceId}:credential-provider-deepseek`, service: "provider-deepseek", verification: "user-alias", revision: 1,
      }], markedAt: "2026-10-17T00:00:00.000Z" })).records[0]!;
      await writer.authorityLog().append([{ stream: "exposure", body: { ...record, state: "compromised", markedAt: "2026-10-17T00:01:00.000Z" } }]);
      expect((await application.read()).credentials.providers?.deepseek).toBeUndefined();
    } finally { await writer.stopStorageMaintenance(); }
  }, 60_000);

  it("closes the read-only trust and exposure guard after a trusted-home configuration read or failure", async () => {
    const homeDir = await createTempDir("startup-trusted-read-guard");
    const secrets = new MemoryStore();
    const device = await DeviceKey.generate();
    await persistDeviceKey(secrets, device);
    const writer = new FileMeshBootstrapStore(homeDir, device);
    try {
      await writer.initializeLocalHome({ key: device,
        identity: enrollDeviceIdentity(device, { displayName: "synthetic", platform: "linux", enrolledAt: "2026-10-16T00:00:00.000Z" }),
        roles: ["anchor", "executor"], homeId: "startup-read-guard", at: "2026-10-16T00:00:00.000Z" });
    } finally { await writer.stopStorageMaintenance(); }
    await writeFile(path.join(homeDir, "config.jsonc"), JSON.stringify({ llm: { main: { provider: "deepseek", model: "deepseek-chat" } } }));
    await writeCredentials({ providers: { deepseek: { apiKey: "synthetic-guard-key" } } }, { store: secrets });
    const close = vi.spyOn(FileMeshBootstrapStore.prototype, "stopStorageMaintenance");
    const options = { homeDir, mode: "repl" as const, isTTY: false, secretStore: secrets, edit: async () => ({ kind: "non-tty" as const }) };
    try {
      expect(await checkStartupConfiguration(options)).toMatchObject({ kind: "ready" });
      expect(close).toHaveBeenCalledTimes(1);
      const trustRead = vi.spyOn(FileMeshBootstrapStore.prototype, "loadCurrentTrust").mockRejectedValueOnce(new Error("synthetic source unavailable"));
      try { expect(await checkStartupConfiguration(options)).toMatchObject({ kind: "secret-store-error", message: "synthetic source unavailable" }); }
      finally { trustRead.mockRestore(); }
      expect(close).toHaveBeenCalledTimes(2);
    } finally { close.mockRestore(); }
  }, 60_000);

  it.each(["repl", "host", "pairing"] as const)("%s 首配编辑端口通过 owner 保存后重读，不依赖终端或模型", async mode => {
    const homeDir = await createTempDir("startup-edit-port");
    const store = new MemoryStore();
    const edit = vi.fn(async ({ save }: Parameters<Parameters<typeof checkStartupConfiguration>[0]["edit"]>[0]) => {
      await save({ config: { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } }, credentials: { providers: { deepseek: { apiKey: "synthetic-key" } } } });
      return { kind: "completed" as const };
    });
    const result = await checkStartupConfiguration({ homeDir, mode, isTTY: true, secretStore: store, edit });
    expect(edit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: "ready", configurationCompleted: true, runtimeConfiguration: { llm: { main: { provider: "deepseek" } } } });
    expect(await readFile(path.join(homeDir, "config.jsonc"), "utf8")).not.toContain("synthetic-key");
  });

  it("取消首配不宣称完成，非交互必要缺项不调用编辑端口", async () => {
    const homeDir = await createTempDir("startup-edit-cancel");
    const edit = vi.fn(async () => ({ kind: "cancelled" as const }));
    const options = { homeDir, mode: "repl" as const, secretStore: new MemoryStore(), edit };
    expect(await checkStartupConfiguration({ ...options, isTTY: true })).toEqual({ kind: "cancelled" });
    expect(await checkStartupConfiguration({ ...options, isTTY: false })).toMatchObject({ kind: "non-tty" });
    expect(edit).toHaveBeenCalledOnce();
  });
  it("migrates legacy plaintext before returning a ready in-memory projection", async () => {
    const homeDir = await createTempDir("startup-secret");
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      path.join(homeDir, "config.jsonc"),
      JSON.stringify({ llm: { main: { provider: "deepseek", model: "deepseek-chat" } } }),
      "utf8",
    );
    const legacyPath = path.join(homeDir, "credentials.json");
    await writeFile(
      legacyPath,
      JSON.stringify({ providers: { deepseek: { apiKey: "startup-secret" } } }),
      "utf8",
    );
    const store = new MemoryStore();

    const result = await runStartupCheck({
      homeDir,
      mode: "host",
      isTTY: false,
      secretStore: store,
    });
    expect(result).toMatchObject({
      kind: "ready",
      runtimeConfiguration: {
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
      },
      providerCredentials: {
        providers: { deepseek: { apiKey: "startup-secret" } },
      },
      mcpCredentials: {},
      channelCredentials: {},
      credentialExposureCredentials: {
        providers: { deepseek: { apiKey: "startup-secret" } },
      },
      credentialRotationCredentials: {
        providers: { deepseek: { apiKey: "startup-secret" } },
      },
      secretStore: store,
    });
    expect(result.kind === "ready" && "credentials" in result).toBe(false);
    if (result.kind === "ready") {
      expect("config" in result).toBe(false);
      expect(Object.isFrozen(result.runtimeConfiguration)).toBe(true);
      expect(Object.isFrozen(result.runtimeConfiguration.llm)).toBe(true);
      expect(Object.isFrozen(result.providerCredentials)).toBe(true);
      expect(Object.isFrozen(result.providerCredentials.providers)).toBe(true);
    }
    expect(result.kind === "ready" ? result.credentialGeneration : null)
      .toMatch(/^[A-Za-z0-9_-]{16,64}$/u);
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps malformed legacy plaintext unchanged and refuses ready", async () => {
    const homeDir = await createTempDir("startup-secret-malformed");
    const legacyPath = path.join(homeDir, "credentials.json");
    await writeFile(legacyPath, "{invalid", "utf8");

    const result = await runStartupCheck({
      homeDir,
      mode: "host",
      isTTY: false,
      secretStore: new MemoryStore(),
    });

    expect(result).toMatchObject({ kind: "schema-error", filePath: legacyPath });
    await expect(readFile(legacyPath, "utf8")).resolves.toBe("{invalid");
  });

  it("does not overwrite a different active SecretStore generation", async () => {
    const homeDir = await createTempDir("startup-secret-conflict");
    const legacyPath = path.join(homeDir, "credentials.json");
    await writeFile(
      legacyPath,
      JSON.stringify({ providers: { deepseek: { apiKey: "legacy-secret" } } }),
      "utf8",
    );
    const store = new MemoryStore();
    await writeCredentials({
      providers: { deepseek: { apiKey: "current-secret" } },
    }, { store });

    const result = await runStartupCheck({
      homeDir,
      mode: "host",
      isTTY: false,
      secretStore: store,
    });

    expect(result).toMatchObject({ kind: "schema-error", filePath: legacyPath });
    await expect(readFile(legacyPath, "utf8")).resolves.toContain("legacy-secret");
  });

  it("fails closed before configuration when the platform vault is locked", async () => {
    const homeDir = await createTempDir("startup-locked");
    const result = await runStartupCheck({
      homeDir,
      mode: "host",
      isTTY: false,
      secretStore: new MemoryStore("locked"),
    });
    expect(result).toEqual({
      kind: "secret-store-error",
      filePath: homeDir,
      message: "SecretStore 当前状态：locked",
    });
  });

  it("reports malformed public config without touching the SecretStore", async () => {
    const homeDir = await createTempDir("startup-config-error");
    await writeFile(path.join(homeDir, "config.jsonc"), "{ invalid", "utf8");
    const store = new MemoryStore();

    const result = await runStartupCheck({
      homeDir,
      mode: "host",
      isTTY: false,
      secretStore: store,
    });

    expect(result.kind).toBe("schema-error");
    expect(store.unlockCalls).toBe(0);
  });

  it("rejects deprecated public credential fields before touching the SecretStore", async () => {
    const homeDir = await createTempDir("startup-semantic-error");
    await writeFile(
      path.join(homeDir, "config.jsonc"),
      JSON.stringify({
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        providers: { deepseek: { apiKey: "must-not-be-public" } },
      }),
      "utf8",
    );
    const store = new MemoryStore();

    const result = await runStartupCheck({
      homeDir,
      mode: "host",
      isTTY: false,
      secretStore: store,
    });

    expect(result.kind).toBe("semantic-error");
    expect(store.unlockCalls).toBe(0);
  });

  it("rejects invalid mesh role configuration before touching the SecretStore", async () => {
    const homeDir = await createTempDir("startup-mesh-semantic-error");
    await writeFile(
      path.join(homeDir, "config.jsonc"),
      JSON.stringify({
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        mesh: {
          enabledRoles: ["anchor"],
          anchorListen: { bind: { host: "0.0.0.0", port: 7443 } },
        },
      }),
      "utf8",
    );
    const store = new MemoryStore();

    const result = await runStartupCheck({
      homeDir,
      mode: "host",
      isTTY: false,
      secretStore: store,
    });

    expect(result).toMatchObject({
      kind: "semantic-error",
      issues: [{ field: "mesh" }],
    });
    expect(store.unlockCalls).toBe(0);
  });

  it("classifies SecretStore exceptions separately from public config failures", async () => {
    const homeDir = await createTempDir("startup-secret-error");
    await writeFile(
      path.join(homeDir, "config.jsonc"),
      JSON.stringify({ llm: { main: { provider: "deepseek", model: "deepseek-chat" } } }),
      "utf8",
    );
    const store = new MemoryStore();
    store.unlockState = async () => {
      throw new Error("credential backend unavailable");
    };

    await expect(
      runStartupCheck({ homeDir, mode: "host", isTTY: false, secretStore: store }),
    ).resolves.toEqual({
      kind: "secret-store-error",
      filePath: homeDir,
      message: "credential backend unavailable",
    });
  });
});

function key(ref: SecretRef) {
  return `${ref.kind}/${ref.bindingId}`;
}
