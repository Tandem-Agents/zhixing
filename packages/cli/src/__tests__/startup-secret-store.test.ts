import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { writeCredentials } from "@zhixing/providers";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { runStartupCheck } from "../startup.js";

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
      config: { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
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
