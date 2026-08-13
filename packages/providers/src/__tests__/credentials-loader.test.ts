import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import {
  applyCredentialsPatch,
  loadCredentialSnapshot,
  loadCredentials,
  writeCredentials,
} from "../credentials-loader.js";

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  failManifestWrite = false;
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async put(ref: SecretRef, value: string): Promise<void> {
    if (this.failManifestWrite && ref.bindingId === "credentials/v1/manifest") {
      this.failManifestWrite = false;
      throw new Error("manifest write failed");
    }
    this.values.set(key(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(key(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> { this.values.delete(key(ref)); }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}

describe("SecretStore credentials repository", () => {
  it("loads credentials and their opaque generation from one coordinated snapshot", async () => {
    const store = new MemorySecretStore();
    await writeCredentials({ providers: { main: { apiKey: "first-secret" } } }, { store });
    const first = await loadCredentialSnapshot({ store });
    expect(first.credentials).toEqual({ providers: { main: { apiKey: "first-secret" } } });
    expect(first.generation).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);

    await writeCredentials({ providers: { main: { apiKey: "replacement-secret" } } }, { store });
    const replacement = await loadCredentialSnapshot({ store });
    expect(replacement.credentials).toEqual({ providers: { main: { apiKey: "replacement-secret" } } });
    expect(replacement.generation).not.toBe(first.generation);
  });

  it("round-trips every binding family without scanning plaintext paths", async () => {
    const store = new MemorySecretStore();
    const credentials = {
      providers: { main: { apiKey: "provider-secret" } },
      channels: { feishu: { appId: "app", appSecret: "channel-secret" } },
      mcp: { github: { Authorization: "Bearer mcp-secret" } },
    };
    await writeCredentials(credentials, { store });
    await expect(loadCredentials({ store })).resolves.toEqual(credentials);
  });

  it("keeps the prior generation when the manifest switch fails", async () => {
    const store = new MemorySecretStore();
    await writeCredentials({ providers: { old: { apiKey: "old" } } }, { store });
    store.failManifestWrite = true;
    await expect(writeCredentials({ providers: { next: { apiKey: "next" } } }, { store }))
      .rejects.toThrow("manifest write failed");
    await expect(loadCredentials({ store })).resolves.toEqual({ providers: { old: { apiKey: "old" } } });
  });

  it("serializes concurrent replacements into complete generations", async () => {
    const store = new MemorySecretStore();
    const left = { providers: { left: { apiKey: "left" } } };
    const right = { providers: { right: { apiKey: "right" } } };
    await Promise.all([writeCredentials(left, { store }), writeCredentials(right, { store })]);
    await expect(loadCredentials({ store })).resolves.toEqual(right);
  });
});

describe("applyCredentialsPatch", () => {
  it("supports merge and authoritative replacement semantics", () => {
    const current = { providers: { one: { apiKey: "1" }, two: { apiKey: "2" } } };
    expect(applyCredentialsPatch(current, { providers: { one: { apiKey: "new" } } }))
      .toEqual({ providers: { one: { apiKey: "new" }, two: { apiKey: "2" } } });
    expect(applyCredentialsPatch(current, { providers: { one: { apiKey: "new" } } }, "replace"))
      .toEqual({ providers: { one: { apiKey: "new" } } });
  });
});

function key(ref: SecretRef): string { return `${ref.kind}/${ref.bindingId}`; }
