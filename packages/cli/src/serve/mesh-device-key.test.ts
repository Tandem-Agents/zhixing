import { describe, expect, it } from "vitest";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceKey } from "@zhixing/mesh/device-identity";
import { loadDeviceKey, persistDeviceKey } from "@zhixing/mesh/device-key-store";
import {
  loadExistingDeviceKey,
  loadOrCreateCandidateDeviceKey,
  publishSwitchedDeviceKey,
  readDeviceKeySwitch,
  replacedDeviceOf,
} from "./mesh-device-key.js";

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> { this.values.set(`${ref.kind}/${ref.bindingId}`, value); }
  async get(ref: SecretRef): Promise<string | null> { return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null; }
  async delete(ref: SecretRef): Promise<void> { this.values.delete(`${ref.kind}/${ref.bindingId}`); }
  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => {
      const separator = entry.indexOf("/");
      return { kind: entry.slice(0, separator) as SecretRef["kind"], bindingId: entry.slice(separator + 1) };
    });
  }
  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}

// 显式重新加入需要新身份：候选钥不被普通身份发现选中；配对提交后经切换记录发布，任何中断点之后恰好一份当前身份
describe("device identity switch for an explicit re-pairing", () => {
  async function fixture() {
    const store = new MemorySecretStore();
    const old = await DeviceKey.generate();
    await persistDeviceKey(store, old);
    const candidate = await loadOrCreateCandidateDeviceKey(store);
    return { store, old, candidate };
  }

  it("keeps the candidate out of normal identity discovery and reuses it across retries", async () => {
    const { store, old, candidate } = await fixture();
    expect((await loadExistingDeviceKey(store))?.deviceId).toBe(old.deviceId);
    expect((await loadOrCreateCandidateDeviceKey(store)).deviceId).toBe(candidate.deviceId);
    expect(await readDeviceKeySwitch(store)).toBeUndefined();
  });

  it("publishes the new identity, isolates the old key and keeps the switch binding", async () => {
    const { store, old, candidate } = await fixture();
    await publishSwitchedDeviceKey(store, old, candidate, PAIRING_1);
    expect(await readDeviceKeySwitch(store)).toEqual({ from: old.deviceId, to: candidate.deviceId, pairing: PAIRING_1 });
    expect((await loadExistingDeviceKey(store))?.deviceId).toBe(candidate.deviceId);
    expect(await loadDeviceKey(store, old.deviceId)).toBeNull();
    expect(store.values.has(`device-key/retired/v1/${old.deviceId}`)).toBe(true);
    expect(await store.list("device-key/candidate/v1/")).toEqual([]);
    expect(await replacedDeviceOf(store, candidate.deviceId)).toBe(old.deviceId);
    expect(await replacedDeviceOf(store, old.deviceId)).toBeUndefined();
  });

  it.each(["record-only", "both-current", "old-deleted-candidate-left"] as const)(
    "completes an interrupted switch (%s) to exactly one current identity", async (point) => {
      const { store, old, candidate } = await fixture();
      await store.put({ kind: "device-key", bindingId: "switch/v1/current" }, JSON.stringify({ from: old.deviceId, to: candidate.deviceId, pairing: PAIRING_1 }));
      if (point !== "record-only") await persistDeviceKey(store, candidate);
      if (point === "old-deleted-candidate-left") {
        await store.put({ kind: "device-key", bindingId: `retired/v1/${old.deviceId}` }, JSON.stringify(old.exportMaterial()));
        await store.delete({ kind: "device-key", bindingId: `device/v1/${old.deviceId}` });
      }
      expect((await loadExistingDeviceKey(store))?.deviceId).toBe(candidate.deviceId);
      expect((await store.list("device-key/device/v1/")).map((ref) => ref.bindingId)).toEqual([`device/v1/${candidate.deviceId}`]);
      expect(await store.list("device-key/candidate/v1/")).toEqual([]);
      expect(store.values.has(`device-key/retired/v1/${old.deviceId}`)).toBe(true);
    });

  it("still refuses two current identities without a switch record and never selects a candidate on its own", async () => {
    const store = new MemorySecretStore();
    await persistDeviceKey(store, await DeviceKey.generate());
    await persistDeviceKey(store, await DeviceKey.generate());
    await expect(loadExistingDeviceKey(store)).rejects.toThrow("multiple local device identities");
    const fresh = new MemorySecretStore();
    await loadOrCreateCandidateDeviceKey(fresh);
    expect(await loadExistingDeviceKey(fresh)).toBeUndefined();
  });

  it("re-enters the same switch idempotently and refuses one that does not start from the current identity", async () => {
    const { store, old, candidate } = await fixture();
    await publishSwitchedDeviceKey(store, old, candidate, PAIRING_1);
    await publishSwitchedDeviceKey(store, old, candidate, PAIRING_1);
    expect((await loadExistingDeviceKey(store))?.deviceId).toBe(candidate.deviceId);
    // 同一对身份换了配对、或从已被取代的旧身份再切：都不是合法的下一次切换
    await expect(publishSwitchedDeviceKey(store, old, candidate, PAIRING_2)).rejects.toThrow("must start from the current identity");
    await expect(publishSwitchedDeviceKey(store, old, await DeviceKey.generate(), PAIRING_2)).rejects.toThrow("must start from the current identity");
  });

  it("switches again after the previous switch finished and keeps every earlier binding", async () => {
    const { store, old: a, candidate: b } = await fixture();
    await publishSwitchedDeviceKey(store, a, b, PAIRING_1);
    const c = await loadOrCreateCandidateDeviceKey(store);
    await publishSwitchedDeviceKey(store, b, c, PAIRING_2);
    expect((await loadExistingDeviceKey(store))?.deviceId).toBe(c.deviceId);
    expect((await store.list("device-key/device/v1/")).map((ref) => ref.bindingId)).toEqual([`device/v1/${c.deviceId}`]);
    expect(await readDeviceKeySwitch(store)).toEqual({ from: b.deviceId, to: c.deviceId, pairing: PAIRING_2 });
    expect(await replacedDeviceOf(store, c.deviceId)).toBe(b.deviceId);
    expect(await replacedDeviceOf(store, b.deviceId)).toBe(a.deviceId);
    expect(store.values.has(`device-key/retired/v1/${a.deviceId}`) && store.values.has(`device-key/retired/v1/${b.deviceId}`)).toBe(true);
  });

  it("finishes the next switch when it was interrupted after archiving the previous one", async () => {
    const { store, old: a, candidate: b } = await fixture();
    await publishSwitchedDeviceKey(store, a, b, PAIRING_1);
    const c = await loadOrCreateCandidateDeviceKey(store);
    // 归档已写、current 还是上一条
    await store.put({ kind: "device-key", bindingId: `switch/v1/history/${b.deviceId}` }, JSON.stringify({ from: a.deviceId, to: b.deviceId, pairing: PAIRING_1 }));
    expect((await loadExistingDeviceKey(store))?.deviceId).toBe(b.deviceId);
    await publishSwitchedDeviceKey(store, b, c, PAIRING_2);
    expect((await loadExistingDeviceKey(store))?.deviceId).toBe(c.deviceId);
    expect(await replacedDeviceOf(store, b.deviceId)).toBe(a.deviceId);
  });
});

const PAIRING_1 = `sha256:${"1".repeat(64)}`;
const PAIRING_2 = `sha256:${"2".repeat(64)}`;
