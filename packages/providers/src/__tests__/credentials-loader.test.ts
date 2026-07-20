import { link, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  applyCredentialsPatch,
  CredentialCommitStateUnknownError,
  exportCredentialsToLegacyFile,
  getCredentialsPath,
  legacyCredentialsPresent,
  loadCredentials,
  loadCredentialsWithLegacyMigration,
  migrateLegacyCredentials,
  writeCredentials,
} from "../credentials-loader.js";

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  failOnPut: number | null = null;
  failOnBindingId: string | null = null;
  failGenerationDeletes = false;
  failCommittedMarker = false;
  onPut?: (ref: SecretRef) => Promise<void>;
  onGet?: (ref: SecretRef) => Promise<void>;
  uncoordinatedAccesses = 0;
  private puts = 0;
  private exclusiveActive = false;
  private exclusiveQueue: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveQueue;
    let release!: () => void;
    this.exclusiveQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.exclusiveActive = true;
    try {
      return await operation();
    } finally {
      this.exclusiveActive = false;
      release();
    }
  }

  async put(ref: SecretRef, value: string): Promise<void> {
    this.trackCoordination();
    this.puts += 1;
    if (this.failOnPut !== null && this.puts === this.failOnPut) throw new Error("injected put failure");
    if (this.failOnBindingId === ref.bindingId) {
      this.failOnBindingId = null;
      throw new Error("injected put failure");
    }
    if (
      this.failCommittedMarker &&
      ref.bindingId.includes("/generation-markers/") &&
      value.includes('"state":"committed"')
    ) {
      this.failCommittedMarker = false;
      throw new Error("injected marker failure");
    }
    this.values.set(key(ref), value);
    await this.onPut?.(ref);
  }
  async get(ref: SecretRef): Promise<string | null> {
    this.trackCoordination();
    const value = this.values.get(key(ref)) ?? null;
    await this.onGet?.(ref);
    return value;
  }
  async delete(ref: SecretRef): Promise<void> {
    this.trackCoordination();
    if (this.failGenerationDeletes && ref.bindingId.includes("/generations/")) {
      throw new Error("injected delete failure");
    }
    this.values.delete(key(ref));
  }
  async list(prefix: string): Promise<SecretRef[]> {
    this.trackCoordination();
    return [...this.values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return { kind: value.slice(0, separator) as SecretRef["kind"], bindingId: value.slice(separator + 1) };
      });
  }
  async unlockState(): Promise<"unlocked"> {
    this.trackCoordination();
    return "unlocked";
  }

  private trackCoordination(): void {
    if (!this.exclusiveActive) this.uncoordinatedAccesses += 1;
  }
}

describe("SecretStore credentials repository", () => {
  it("loads credentials and their opaque committed generation from one coordinated snapshot", async () => {
    const store = new MemorySecretStore();
    const homeDir = await createTempDir("credential-snapshot");
    await writeCredentials({ providers: { main: { apiKey: "first-secret" } } }, { store });
    const first = await loadCredentialsWithLegacyMigration({ homeDir, store });
    const firstGeneration = first.generation;
    expect(first.credentials).toEqual({ providers: { main: { apiKey: "first-secret" } } });
    expect(firstGeneration).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);
    expect(firstGeneration).not.toContain("first-secret");

    await writeCredentials({ providers: { main: { apiKey: "replacement-secret" } } }, { store });
    const replacement = await loadCredentialsWithLegacyMigration({ homeDir, store });
    const replacementGeneration = replacement.generation;
    expect(replacement.credentials).toEqual({
      providers: { main: { apiKey: "replacement-secret" } },
    });
    expect(replacementGeneration).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);
    expect(replacementGeneration).not.toBe(firstGeneration);
    expect(replacementGeneration).not.toContain("replacement-secret");
  });

  it("round-trips provider, channel and MCP bindings without a plaintext file", async () => {
    const store = new MemorySecretStore();
    const credentials = {
      providers: { deepseek: { apiKey: "sk-provider", baseUrl: "https://example.test" } },
      channels: { feishu: { appId: "app", appSecret: "channel-secret" } },
      mcp: { github: { Authorization: "Bearer mcp-secret" } },
    };
    await writeCredentials(credentials, { store });
    expect(await loadCredentials({ store })).toEqual(credentials);
    expect([...store.values.keys()].filter((value) => value.endsWith("/manifest"))).toEqual([
      "provider/credentials/v1/manifest",
    ]);
    expect([...store.values.keys()].filter((value) => value.includes("/generations/"))).toHaveLength(3);
    expect([...store.values.keys()].filter((value) => value.includes("/generation-markers/"))).toHaveLength(1);
  });

  it("preserves omitted credential tables while replacing an explicitly supplied table", async () => {
    const store = new MemorySecretStore();
    await writeCredentials(
      {
        providers: { old: { apiKey: "old" } },
        channels: { feishu: { appSecret: "channel" } },
      },
      { store },
    );
    await writeCredentials({ providers: { replacement: { apiKey: "new" } } }, { store });

    expect(await loadCredentials({ store })).toEqual({
      providers: { replacement: { apiKey: "new" } },
      channels: { feishu: { appSecret: "channel" } },
    });
  });

  it("rejects an oversized binding before creating a credential generation", async () => {
    const store = new MemorySecretStore();
    await expect(
      writeCredentials(
        { providers: { ["x".repeat(600)]: { apiKey: "secret" } } },
        { store },
      ),
    ).rejects.toThrow("exceeds the SecretStore limit");
    expect(store.values.size).toBe(0);
  });

  it("migrates each binding with read-back and removes the plaintext source only after success", async () => {
    const homeDir = await createTempDir("credential-migrate");
    const filePath = getCredentialsPath(homeDir);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
    await writeFile(
      filePath,
      JSON.stringify({
        providers: { deepseek: { apiKey: "sk-provider" } },
        channels: { feishu: { appSecret: "channel-secret" } },
      }),
      "utf8",
    );
    const store = new MemorySecretStore();

    await expect(migrateLegacyCredentials({ homeDir, store })).resolves.toEqual({
      migrated: true,
      entries: 2,
    });
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await loadCredentials({ store })).toEqual({
      providers: { deepseek: { apiKey: "sk-provider" } },
      channels: { feishu: { appSecret: "channel-secret" } },
    });
  });

  it("detects and clears a crash-left plaintext export temp before startup can become ready", async () => {
    const homeDir = await createTempDir("credential-temp-recovery");
    const temporary = path.join(
      homeDir,
      "credentials.json.4242.0123456789abcdef.tmp",
    );
    await writeFile(temporary, '{"providers":{"main":{"apiKey":"plaintext"}}}', "utf8");
    const store = new MemorySecretStore();

    await expect(legacyCredentialsPresent(homeDir)).resolves.toBe(true);
    await expect(loadCredentialsWithLegacyMigration({ homeDir, store })).resolves.toEqual({
      credentials: {},
      generation: null,
      migration: { migrated: false, entries: 0 },
    });
    await expect(readFile(temporary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(legacyCredentialsPresent(homeDir)).resolves.toBe(false);
  });

  it("preserves the legacy empty skeleton so first-run onboarding can fill it", async () => {
    const homeDir = await createTempDir("credential-skeleton");
    const filePath = getCredentialsPath(homeDir);
    const skeleton = {
      providers: { siliconflow: { apiKey: "" }, deepseek: { apiKey: "" } },
      channels: { feishu: { appId: "", appSecret: "" } },
    };
    await writeFile(filePath, JSON.stringify(skeleton), "utf8");
    const store = new MemorySecretStore();

    await migrateLegacyCredentials({ homeDir, store });
    expect(await loadCredentials({ store })).toEqual(skeleton);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the previous SecretStore state and keeps plaintext when a migration item fails", async () => {
    const homeDir = await createTempDir("credential-rollback");
    const filePath = getCredentialsPath(homeDir);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
    await writeFile(
      filePath,
      JSON.stringify({
        providers: {
          first: { apiKey: "first" },
          second: { apiKey: "second" },
        },
      }),
      "utf8",
    );
    const store = new MemorySecretStore();
    store.values.set("device-key/device/v1/existing", "old-device-key");
    store.failOnPut = 2;

    await expect(migrateLegacyCredentials({ homeDir, store })).rejects.toThrow("明文源文件保持不变");
    expect(await readFile(filePath, "utf8")).toContain("second");
    expect([...store.values.entries()]).toEqual([
      ["device-key/device/v1/existing", "old-device-key"],
    ]);
  });

  it("rejects malformed nested provider fields before retiring the plaintext source", async () => {
    const homeDir = await createTempDir("credential-schema");
    const filePath = getCredentialsPath(homeDir);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
    await writeFile(
      filePath,
      JSON.stringify({
        providers: {
          deepseek: {
            apiKey: "secret",
            quirks: { supportsTools: "yes" },
          },
        },
      }),
      "utf8",
    );
    const store = new MemorySecretStore();

    await expect(migrateLegacyCredentials({ homeDir, store })).rejects.toThrow(
      "supportsTools 必须是布尔值",
    );
    expect(await readFile(filePath, "utf8")).toContain("supportsTools");
    expect(store.values.size).toBe(0);
  });

  it("rejects linked migration sources instead of reporting false plaintext retirement", async () => {
    const homeDir = await createTempDir("credential-linked-source");
    const filePath = getCredentialsPath(homeDir);
    const secondLink = path.join(homeDir, "credentials-copy.json");
    await writeFile(filePath, JSON.stringify({ providers: { main: { apiKey: "secret" } } }), "utf8");
    await link(filePath, secondLink);
    const store = new MemorySecretStore();

    await expect(migrateLegacyCredentials({ homeDir, store })).rejects.toThrow(
      "单一普通文件",
    );
    expect(await readFile(filePath, "utf8")).toContain("secret");
    expect(await readFile(secondLink, "utf8")).toContain("secret");
    expect(store.values.size).toBe(0);
  });

  it("rolls back activation when the migration source changes before retirement", async () => {
    const homeDir = await createTempDir("credential-source-race");
    const filePath = getCredentialsPath(homeDir);
    await writeFile(filePath, JSON.stringify({ providers: { main: { apiKey: "first" } } }), "utf8");
    const store = new MemorySecretStore();
    store.onPut = async (ref) => {
      if (ref.bindingId.endsWith("/manifest")) {
        await writeFile(filePath, JSON.stringify({ providers: { main: { apiKey: "second" } } }), "utf8");
      }
    };

    await expect(migrateLegacyCredentials({ homeDir, store })).rejects.toThrow(
      "迁移收尾尚未完成",
    );
    expect(await readFile(filePath, "utf8")).toContain("second");
    expect(await loadCredentials({ store })).toEqual({
      providers: { main: { apiKey: "first" } },
    });
  });

  it("never overwrites a different active SecretStore generation with a legacy file", async () => {
    const homeDir = await createTempDir("credential-conflict");
    const filePath = getCredentialsPath(homeDir);
    await writeFile(filePath, JSON.stringify({ providers: { main: { apiKey: "legacy" } } }), "utf8");
    const store = new MemorySecretStore();
    await writeCredentials({ providers: { main: { apiKey: "current" } } }, { store });

    await expect(migrateLegacyCredentials({ homeDir, store })).rejects.toThrow(
      "拒绝用旧明文文件覆盖",
    );
    expect(await loadCredentials({ store })).toEqual({
      providers: { main: { apiKey: "current" } },
    });
    expect(await readFile(filePath, "utf8")).toContain("legacy");
  });

  it("retires a leftover legacy file when it matches the active generation", async () => {
    const homeDir = await createTempDir("credential-idempotent-retire");
    const filePath = getCredentialsPath(homeDir);
    const credentials = {
      providers: {
        main: {
          apiKey: "same",
          quirks: { supportsTools: true },
        },
      },
    };
    const store = new MemorySecretStore();
    await writeCredentials(credentials, { store });
    const before = new Map(store.values);
    await writeFile(filePath, JSON.stringify(credentials), "utf8");

    await expect(migrateLegacyCredentials({ homeDir, store })).resolves.toEqual({
      migrated: true,
      entries: 1,
    });
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.values).toEqual(before);
  });

  it("keeps the previous generation active when the manifest switch fails", async () => {
    const store = new MemorySecretStore();
    await writeCredentials({ providers: { old: { apiKey: "old" } } }, { store });
    store.failOnBindingId = "credentials/v1/manifest";
    await expect(
      writeCredentials({ providers: { replacement: { apiKey: "new" } } }, { store }),
    ).rejects.toThrow("injected put failure");
    expect(await loadCredentials({ store })).toEqual({ providers: { old: { apiKey: "old" } } });
  });

  it("reports an unknown commit state and recovers forward when manifest verification cannot be read", async () => {
    const store = new MemorySecretStore();
    let manifestWritten = false;
    store.onPut = async (ref) => {
      if (ref.bindingId === "credentials/v1/manifest") manifestWritten = true;
    };
    store.onGet = async (ref) => {
      if (manifestWritten && ref.bindingId === "credentials/v1/manifest") {
        manifestWritten = false;
        throw new Error("injected manifest read failure");
      }
    };

    const error = await writeCredentials(
      { providers: { main: { apiKey: "committed" } } },
      { store },
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CredentialCommitStateUnknownError);
    expect((error as Error).message).toContain("激活状态未知");
    expect((error as Error).message).not.toContain("明文");

    store.onPut = undefined;
    store.onGet = undefined;
    await expect(loadCredentials({ store })).resolves.toEqual({
      providers: { main: { apiKey: "committed" } },
    });
  });

  it("keeps legacy plaintext when both manifest write and verification outcomes are unknown", async () => {
    const homeDir = await createTempDir("credential-unknown-commit");
    const filePath = getCredentialsPath(homeDir);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.dirname(filePath), { recursive: true }),
    );
    await writeFile(
      filePath,
      JSON.stringify({ providers: { main: { apiKey: "committed" } } }),
      "utf8",
    );
    const store = new MemorySecretStore();
    let manifestWriteReturnedError = false;
    store.onPut = async (ref) => {
      if (ref.bindingId === "credentials/v1/manifest") {
        manifestWriteReturnedError = true;
        throw new Error("injected post-write failure");
      }
    };
    store.onGet = async (ref) => {
      if (manifestWriteReturnedError && ref.bindingId === "credentials/v1/manifest") {
        manifestWriteReturnedError = false;
        throw new Error("injected manifest read failure");
      }
    };

    await expect(migrateLegacyCredentials({ homeDir, store })).rejects.toThrow(
      "凭据激活状态未知",
    );
    await expect(readFile(filePath, "utf8")).resolves.toContain("committed");

    store.onPut = undefined;
    store.onGet = undefined;
    await expect(migrateLegacyCredentials({ homeDir, store })).resolves.toEqual({
      migrated: true,
      entries: 1,
    });
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an aborted marker when pre-commit cleanup fails and recovers it without an active manifest", async () => {
    const store = new MemorySecretStore();
    store.failOnBindingId = "credentials/v1/manifest";
    store.failGenerationDeletes = true;

    await expect(
      writeCredentials({ providers: { staged: { apiKey: "staged" } } }, { store }),
    ).rejects.toThrow("Uncommitted credential generation cleanup failed");
    const marker = [...store.values.entries()].find(([key]) =>
      key.includes("/generation-markers/"),
    )?.[1];
    expect(marker).toContain('"state":"aborted"');

    store.failGenerationDeletes = false;
    expect(await loadCredentials({ store })).toEqual({});
    expect([...store.values.keys()].some((key) => key.includes("/generations/"))).toBe(false);
    expect([...store.values.keys()].some((key) => key.includes("/generation-markers/"))).toBe(false);
  });

  it("persists retirement work across a cleanup failure and completes it on the next read", async () => {
    const store = new MemorySecretStore();
    await writeCredentials({ providers: { old: { apiKey: "old" } } }, { store });
    store.failGenerationDeletes = true;

    await expect(
      writeCredentials({ providers: { replacement: { apiKey: "new" } } }, { store }),
    ).rejects.toThrow("提交后收尾尚未完成");
    store.failGenerationDeletes = false;
    expect(await loadCredentials({ store })).toEqual({
      providers: { replacement: { apiKey: "new" } },
    });
    expect([...store.values.keys()].filter((value) => value.includes("/generations/"))).toHaveLength(1);
    expect([...store.values.keys()].filter((value) => value.includes("/generation-markers/"))).toHaveLength(1);
  });

  it("recovers forward when generation-marker finalization fails after manifest activation", async () => {
    const store = new MemorySecretStore();
    store.failCommittedMarker = true;

    await expect(
      writeCredentials({ providers: { main: { apiKey: "committed" } } }, { store }),
    ).rejects.toThrow("提交后收尾尚未完成");
    expect(await loadCredentials({ store })).toEqual({
      providers: { main: { apiKey: "committed" } },
    });
    const marker = [...store.values.entries()].find(([key]) =>
      key.includes("/generation-markers/"),
    )?.[1];
    expect(marker).toContain('"state":"committed"');
  });

  it("removes an unreachable staged generation even when its creator process is still alive", async () => {
    const store = new MemorySecretStore();
    await writeCredentials({ providers: { active: { apiKey: "active" } } }, { store });
    const generation = "0123456789abcdef";
    const orphanRef = `provider/credentials/v1/generations/${generation}/${Buffer.from("orphan").toString("base64url")}`;
    const markerRef = `provider/credentials/v1/generation-markers/${generation}`;
    store.values.set(orphanRef, JSON.stringify({ apiKey: "orphan" }));
    store.values.set(
      markerRef,
      JSON.stringify({
        v: 1,
        pid: process.pid,
        createdAt: "2026-07-13T00:00:00.000Z",
        state: "staging",
        generation,
        entries: [{ kind: "provider", id: "orphan" }],
      }),
    );

    expect(await loadCredentials({ store })).toEqual({
      providers: { active: { apiKey: "active" } },
    });
    expect(store.values.has(orphanRef)).toBe(false);
    expect(store.values.has(markerRef)).toBe(false);
  });

  it("rechecks the live manifest before cleanup and never deletes a concurrently activated generation", async () => {
    const store = new MemorySecretStore();
    await writeCredentials({ providers: { first: { apiKey: "first" } } }, { store });
    const nextGeneration = "fedcba9876543210";
    const nextId = Buffer.from("next").toString("base64url");
    const nextEntryRef = `provider/credentials/v1/generations/${nextGeneration}/${nextId}`;
    const nextMarkerRef = `provider/credentials/v1/generation-markers/${nextGeneration}`;
    const nextManifest = JSON.stringify({
      v: 1,
      generation: nextGeneration,
      entries: [{ kind: "provider", id: "next" }],
    });
    store.values.set(nextEntryRef, JSON.stringify({ apiKey: "next" }));
    store.values.set(
      nextMarkerRef,
      JSON.stringify({
        v: 1,
        pid: process.pid,
        createdAt: "2026-07-13T00:00:00.000Z",
        state: "committed",
        generation: nextGeneration,
        entries: [{ kind: "provider", id: "next" }],
      }),
    );
    let switched = false;
    store.onGet = async (ref) => {
      if (!switched && ref.bindingId.includes("/generations/")) {
        switched = true;
        store.values.set("provider/credentials/v1/manifest", nextManifest);
      }
    };

    expect(await loadCredentials({ store })).toEqual({
      providers: { first: { apiKey: "first" } },
    });
    delete store.onGet;
    expect(store.values.has(nextEntryRef)).toBe(true);
    expect(await loadCredentials({ store })).toEqual({
      providers: { next: { apiKey: "next" } },
    });
  });

  it("publishes concurrent replacements as one complete generation, never a mixed set", async () => {
    const store = new MemorySecretStore();
    const left = {
      providers: { left: { apiKey: "left" } },
      channels: { left: { token: "l" } },
      mcp: { left: { token: "l" } },
    };
    const right = {
      providers: { right: { apiKey: "right" } },
      channels: { right: { token: "r" } },
      mcp: { right: { token: "r" } },
    };
    const outcomes = await Promise.allSettled([
      writeCredentials(left, { store }),
      writeCredentials(right, { store }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(await loadCredentials({ store })).toEqual(right);
    expect(store.uncoordinatedAccesses).toBe(0);
  });

  it("requires explicit acknowledgement before exporting a plaintext rollback file", async () => {
    const homeDir = await createTempDir("credential-export");
    const store = new MemorySecretStore();
    await writeCredentials({ providers: { main: { apiKey: "rollback-secret" } } }, { store });

    await expect(
      exportCredentialsToLegacyFile({
        homeDir,
        store,
        acknowledgePlaintextRisk: false as true,
      }),
    ).rejects.toThrow("plaintext-risk acknowledgement");
    const filePath = await exportCredentialsToLegacyFile({
      homeDir,
      store,
      acknowledgePlaintextRisk: true,
    });
    expect(await readFile(filePath, "utf8")).toContain("rollback-secret");

    await writeFile(filePath, "preserve-existing", "utf8");
    await expect(
      exportCredentialsToLegacyFile({
        homeDir,
        store,
        acknowledgePlaintextRisk: true,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(filePath, "utf8")).resolves.toBe("preserve-existing");
  });
});

describe("applyCredentialsPatch", () => {
  it("supports merge and authoritative replacement semantics", () => {
    const current = {
      providers: {
        one: { apiKey: "1", baseUrl: "https://one.test" },
        two: { apiKey: "2" },
      },
    };
    expect(
      applyCredentialsPatch(current, { providers: { one: { apiKey: "new" } } }),
    ).toEqual({
      providers: {
        one: { apiKey: "new", baseUrl: "https://one.test" },
        two: { apiKey: "2" },
      },
    });
    expect(
      applyCredentialsPatch(current, { providers: { one: { apiKey: "new" } } }, "replace"),
    ).toEqual({ providers: { one: { apiKey: "new" } } });
  });
});

function key(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
