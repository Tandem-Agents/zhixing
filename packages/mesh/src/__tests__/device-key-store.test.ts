import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import { DeviceKey } from "../device-identity.js";
import {
  deleteDeviceKey,
  deviceKeyRef,
  loadDeviceKey,
  persistDeviceKey,
} from "../device-key-store.js";

class MemoryStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string) { this.values.set(key(ref), value); }
  async get(ref: SecretRef) { return this.values.get(key(ref)) ?? null; }
  async delete(ref: SecretRef) { this.values.delete(key(ref)); }
  async list() { return []; }
  async unlockState() { return "unlocked" as const; }
}

describe("device key SecretStore binding", () => {
  it("persists, reimports and verifies the stable device identity", async () => {
    const store = new MemoryStore();
    const original = await DeviceKey.generate();
    const ref = await persistDeviceKey(store, original);
    await expect(persistDeviceKey(store, original)).resolves.toEqual(ref);
    const loaded = await loadDeviceKey(store, original.deviceId);
    expect(ref.kind).toBe("device-key");
    expect(loaded?.deviceId).toBe(original.deviceId);
    expect(loaded?.publicKey).toBe(original.publicKey);
  });

  it("does not roll back over a concurrent replacement after read-back fails", async () => {
    const original = await DeviceKey.generate();
    const ref = deviceKeyRef(original.deviceId);
    const competing = "concurrent-replacement";
    let reads = 0;
    const store = new MemoryStore();
    const get = store.get.bind(store);
    store.get = async (candidate) => {
      reads += 1;
      if (reads === 2) {
        store.values.set(key(ref), competing);
        return "invalid-read-back";
      }
      return get(candidate);
    };

    await expect(persistDeviceKey(store, original)).rejects.toThrow(
      "failed read-back verification",
    );
    expect(store.values.get(key(ref))).toBe(competing);
  });

  it("accepts only canonical device fingerprints as key references", () => {
    expect(() => deviceKeyRef("fp:uinvalid\n")).toThrow("device fingerprint");
  });

  it("fails closed when a backend reports deletion without removing the key", async () => {
    const original = await DeviceKey.generate();
    const store = new MemoryStore();
    const ref = await persistDeviceKey(store, original);
    store.delete = async () => {};

    await expect(deleteDeviceKey(store, original.deviceId)).rejects.toThrow(
      "retained the deleted device key",
    );
    expect(store.values.has(key(ref))).toBe(true);
  });
});

function key(ref: SecretRef) {
  return `${ref.kind}/${ref.bindingId}`;
}
