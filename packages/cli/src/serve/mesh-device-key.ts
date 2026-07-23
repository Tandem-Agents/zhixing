import type { SecretStorePort } from "@zhixing/core/contracts";
import { DeviceKey } from "@zhixing/mesh/device-identity";
import {
  loadDeviceKey,
  persistDeviceKey,
} from "@zhixing/mesh/device-key-store";

/** Loads the device identity without importing either authority role runtime. */
export async function loadOrCreateDeviceKey(
  store: SecretStorePort,
): Promise<DeviceKey> {
  const refs = await store.list("device-key/device/v1/");
  if (refs.length > 1) {
    throw new Error("SecretStore contains multiple local device identities");
  }
  const existing = refs[0];
  if (existing) {
    const deviceId = existing.bindingId.slice("device/v1/".length);
    const key = await loadDeviceKey(store, deviceId);
    if (!key) {
      throw new Error("SecretStore device identity disappeared during startup");
    }
    return key;
  }
  const generated = await DeviceKey.generate();
  await persistDeviceKey(store, generated);
  return generated;
}
