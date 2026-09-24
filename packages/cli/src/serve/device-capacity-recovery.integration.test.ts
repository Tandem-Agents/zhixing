import { describe, expect, it, vi } from "vitest";
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";

class FixtureSecrets implements SecretStorePort {
  readonly values = new Map<string, string>();
  key(ref: SecretRef) { return `${ref.kind}/${ref.bindingId}`; }
  async get(ref: SecretRef) { return this.values.get(this.key(ref)) ?? null; }
  async put(ref: SecretRef, value: string) { this.values.set(this.key(ref), value); }
  async delete(ref: SecretRef) { this.values.delete(this.key(ref)); }
  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()].filter(key => key.startsWith(prefix)).map(key => ({
      kind: key.slice(0, key.indexOf("/")) as SecretRef["kind"], bindingId: key.slice(key.indexOf("/") + 1),
    }));
  }
  async unlockState() { return "unlocked" as const; }
}

describe("real Authority recovery with the entry capacity adapter", () => {
  it.each([true, false])("makes progress when the recovery prefix outlives a pressure sample (createDirectory=%s)", async (createDirectory) => {
    const home = await createTempDir("capacity-recovery");
    const capacity = createDeviceCapacityRuntime(home, { createDirectory });
    const original = FileAuthorityCommitLog.prototype.originCheckpoint;
    // Only delay a normal filesystem result. Do not inject an admission result
    // or alter the production freshness window, policy or zero-wait contract.
    const origin = vi.spyOn(FileAuthorityCommitLog.prototype, "originCheckpoint").mockImplementation(async function (...args) {
      const value = await original.apply(this, args);
      await new Promise(resolve => setTimeout(resolve, 300));
      return value;
    });
    const acquire = vi.spyOn(capacity.storage, "acquire");
    let authority: Awaited<ReturnType<typeof setupAuthorityRuntime>> | undefined;
    try {
      authority = await setupAuthorityRuntime({
        zhixingHome: home, secretStore: new FixtureSecrets(),
        executorReadiness: { tools: [], mcpServers: [], credentialBindings: [], deviceScopedCredentialBindingIds: [], credentialGeneration: null },
        deviceCapacity: capacity.arbiter, storageMaintenance: capacity.storage,
      });
      expect(origin.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(acquire.mock.calls.some(([request]) => request.kind === "projection-scrub" && request.maxWaitMs === 0)).toBe(true);
      expect(authority.deviceId).toBeTruthy();
    } finally {
      try { await authority?.startupCleanup.run(); } finally { capacity.close(); origin.mockRestore(); acquire.mockRestore(); }
    }
  }, 20_000);
});
