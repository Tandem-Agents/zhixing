import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceKey, type DeviceKeyMaterial } from "./device-identity.js";

const DEVICE_KEY_NAMESPACE = "device/v1/";

export async function persistDeviceKey(
  store: SecretStorePort,
  key: DeviceKey,
): Promise<SecretRef> {
  if ((await store.unlockState()) !== "unlocked") {
    throw new Error("SecretStore must be unlocked before persisting a device key");
  }
  const ref = deviceKeyRef(key.deviceId);
  const encoded = JSON.stringify(key.exportMaterial());
  const previous = await store.get(ref);
  if (previous !== null) {
    const existing = DeviceKey.import(parseMaterial(previous));
    if (
      existing.deviceId !== key.deviceId ||
      JSON.stringify(existing.exportMaterial()) !== encoded
    ) {
      throw new Error("SecretStore already contains different device key material");
    }
    return ref;
  }
  await store.put(ref, encoded);
  const readBack = await store.get(ref);
  if (readBack !== encoded || DeviceKey.import(parseMaterial(readBack)).deviceId !== key.deviceId) {
    throw new Error("Persisted device key failed read-back verification");
  }
  return ref;
}

export async function loadDeviceKey(
  store: SecretStorePort,
  deviceId: string,
): Promise<DeviceKey | null> {
  const encoded = await store.get(deviceKeyRef(deviceId));
  if (encoded === null) return null;
  const key = DeviceKey.import(parseMaterial(encoded));
  if (key.deviceId !== deviceId) throw new Error("Stored device key is bound to another device");
  return key;
}

export async function deleteDeviceKey(
  store: SecretStorePort,
  deviceId: string,
): Promise<void> {
  const ref = deviceKeyRef(deviceId);
  await store.delete(ref);
  if ((await store.get(ref)) !== null) {
    throw new Error("SecretStore retained the deleted device key");
  }
}

export function deviceKeyRef(deviceId: string): SecretRef {
  if (!/^fp:u[A-Za-z0-9_-]{43}$/u.test(deviceId)) {
    throw new TypeError("Device key reference requires a device fingerprint");
  }
  return { kind: "device-key", bindingId: `${DEVICE_KEY_NAMESPACE}${deviceId}` };
}

function parseMaterial(encoded: string | null): DeviceKeyMaterial {
  if (encoded === null) throw new Error("Persisted device key disappeared during verification");
  try {
    const value = JSON.parse(encoded) as Partial<DeviceKeyMaterial>;
    if (
      !value ||
      typeof value.pkcs8 !== "string" ||
      typeof value.rootCertificatePem !== "string" ||
      Object.keys(value).some((field) => !["pkcs8", "rootCertificatePem"].includes(field))
    ) {
      throw new TypeError("Device key material schema is invalid");
    }
    return { pkcs8: value.pkcs8, rootCertificatePem: value.rootCertificatePem };
  } catch (error) {
    throw new Error("Stored device key material is invalid", { cause: error });
  }
}
