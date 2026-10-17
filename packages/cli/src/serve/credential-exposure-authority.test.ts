import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { protocolDigest } from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import {
  CredentialExposureAuthority,
  exposureGuardedSecretStore,
} from "./credential-exposure-authority.js";

describe("credential exposure authority", () => {
  it("forwards the internal integrity key without treating it as a remote credential route", async () => {
    const root = await createTempDir("integrity-key-exposure-boundary");
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
    const backing = new MemorySecretStore();
    const store = Object.assign(backing, {
      getExisting: (ref: SecretRef) => backing.get(ref),
      getOrCreate: async (ref: SecretRef, create: () => string) => {
        const prior = await backing.get(ref);
        if (prior !== null) return prior;
        const value = create(); await backing.put(ref, value); return value;
      },
    });
    const authority = new CredentialExposureAuthority({ deviceId: "synthetic-device", log, secretStore: store });
    const route = vi.spyOn(authority, "assertRoute").mockRejectedValue(new Error("remote credentials blocked"));
    try {
      const guarded = exposureGuardedSecretStore(store, authority);
      const ref = { kind: "authority-integrity" as const, bindingId: "startup-proofs:v1" };
      expect(await guarded.getOrCreate!(ref, () => "synthetic-integrity")).toBe("synthetic-integrity");
      expect(await guarded.getExisting!(ref)).toBe("synthetic-integrity");
      expect(route).not.toHaveBeenCalled();
      await expect(guarded.get({ kind: "provider", bindingId: "credential-provider-main" })).rejects.toThrow("remote credentials blocked");
    } finally { route.mockRestore(); await log.stopStorageMaintenance(); }
  });
  it("folds repeated exposure history into current bindings without reading the complete stream", async () => {
    const root = await createTempDir("credential-exposure-growth");
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
    const secretStore = new MemorySecretStore();
    const authority = new CredentialExposureAuthority({ deviceId: "device-growth", log, secretStore });
    try {
      const first = await authority.publishActiveBindings({ bindings: [{
        bindingId: "credential-provider-growth", service: "provider", verification: "user-alias", revision: 1,
      }], markedAt: "2026-01-01T00:00:00.000Z" });
      const record = first.records[0]!;
      await log.append(Array.from({ length: 64 }, (_, index) => ({ stream: "exposure", body: {
        ...record, markedAt: new Date(Date.parse(record.markedAt) + index + 1).toISOString(),
      } })));
      const read = vi.spyOn(log, "readStream").mockRejectedValue(new Error("whole exposure history is not a query"));
      try {
        expect((await authority.projection()).records).toEqual([{ ...record, markedAt: "2026-01-01T00:00:00.064Z" }]);
        expect(await authority.rotationRequired()).toEqual([]);
        expect(read).not.toHaveBeenCalled();
      } finally { read.mockRestore(); }
    } finally { await log.stopStorageMaintenance(); }
  });

  it("blocks only the compromised binding and restores it with one verified rotation envelope", async () => {
    const root = await createTempDir("credential-exposure");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts);
    const secretStore = new MemorySecretStore();
    const affectedRef = { kind: "provider", bindingId: "credential-provider-main" } as const;
    const unaffectedRef = { kind: "mcp", bindingId: "credential-mcp-docs" } as const;
    await secretStore.put(affectedRef, "new-secret");
    await secretStore.put(unaffectedRef, "unaffected-secret");
    const sourceAuthority = new CredentialExposureAuthority({
      deviceId: "lost-device",
      log,
      secretStore,
    });
    const active = (await sourceAuthority.publishActiveBindings({
      bindings: [{
        bindingId: affectedRef.bindingId,
        revision: 1,
        service: "provider",
        verification: "service-verified",
        principalFingerprint: protocolDigest("CredentialPrincipal", 1, {
          service: "provider",
          canonicalProviderPrincipal: "account@example.invalid",
        }),
      }],
      markedAt: "2026-08-10T00:00:00.000Z",
    })).records[0]!;
    expect(active.state).toBe("active");
    await log.append([{
      stream: "exposure",
      body: { ...active, state: "compromised", markedAt: "2026-08-10T00:01:00.000Z" },
    }]);
    const authority = new CredentialExposureAuthority({
      deviceId: "recovered-device",
      log,
      secretStore,
      now: () => "2026-08-10T00:02:00.000Z",
    });
    const guarded = exposureGuardedSecretStore(secretStore, authority);
    const physicalRef = {
      kind: "provider",
      bindingId: `credentials/v1/generations/0123456789abcdef/${Buffer.from("main").toString("base64url")}`,
    } as const;
    await secretStore.put(physicalRef, "physical-secret");

    await expect(authority.secretForRoute({ ref: affectedRef, service: "provider" }))
      .rejects.toThrow(/blocked|rotated/i);
    await expect(guarded.get(physicalRef)).rejects.toThrow(/blocked|rotated/i);
    await expect(authority.secretForRoute({ ref: unaffectedRef, service: "mcp" }))
      .resolves.toBe("unaffected-secret");
    expect(await authority.rotationRequired()).toEqual([{
      bindingId: affectedRef.bindingId,
      service: "provider",
    }]);

    let published = 0;
    const rotated = await authority.publishRotation({
      requestId: "rotate-provider-main",
      oldDeviceId: "lost-device",
      ref: affectedRef,
      service: "provider",
      bindingRevision: 2,
      verifiedPrincipal: {
        verification: "service-verified",
        canonicalProviderPrincipal: "account@example.invalid",
      },
      rotationHint: "在服务商账号安全页撤销旧密钥并创建新密钥",
      publishAndReadBack: async () => {
        published += 1;
        expect(await secretStore.get(affectedRef)).toBe("new-secret");
      },
      readiness: async () => undefined,
    });

    expect(published).toBe(1);
    expect(rotated.rotationRequired).toEqual([]);
    await expect(authority.secretForRoute({ ref: affectedRef, service: "provider" }))
      .resolves.toBe("new-secret");
    await expect(guarded.get(physicalRef)).resolves.toBe("physical-secret");
    const records = await log.readStream("exposure");
    expect(records.slice(-2).map((entry) => (entry.body as { state: string }).state))
      .toEqual(["active", "rotated"]);
  });
});

class MemorySecretStore implements SecretStorePort {
  readonly #values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.#values.set(secretId(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.#values.get(secretId(ref)) ?? null;
  }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const storageKey = secretId(ref);
    const existing = this.#values.get(storageKey);
    if (existing !== undefined) return existing;
    const value = create();
    this.#values.set(storageKey, value);
    return value;
  }


  async delete(ref: SecretRef): Promise<void> {
    this.#values.delete(secretId(ref));
  }

  async list(): Promise<readonly SecretRef[]> {
    return [...this.#values.keys()].map((value) => {
      const separator = value.indexOf("/");
      return {
        kind: value.slice(0, separator) as SecretRef["kind"],
        bindingId: value.slice(separator + 1),
      };
    });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

function secretId(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
