import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceKey, type DeviceKeyMaterial } from "./device-identity.js";

const DEVICE_KEY_NAMESPACE = "device/v1/";
const ANCHOR_ISSUER_KEY_NAMESPACE = "anchor-issuer/v1/";
const ACTIVE_ANCHOR_ISSUER_KEY_NAMESPACE = "anchor-issuer-active/v1/";
const anchorIssuerKeyFlights = new WeakMap<SecretStorePort, Map<string, Promise<DeviceKey>>>();

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

export async function deleteDeviceKeyExact(
  store: SecretStorePort,
  expected: DeviceKey,
): Promise<void> {
  const ref = deviceKeyRef(expected.deviceId);
  const current = await store.get(ref);
  if (current === null) return;
  const persisted = DeviceKey.import(parseMaterial(current));
  if (
    persisted.deviceId !== expected.deviceId ||
    JSON.stringify(persisted.exportMaterial()) !== JSON.stringify(expected.exportMaterial())
  ) {
    throw new Error("Refusing to delete a device-key slot with a different generation");
  }
  await store.delete(ref);
  if (await store.get(ref) !== null) {
    throw new Error("SecretStore retained the exact deleted device key");
  }
}

export async function loadOrCreateAnchorIssuerKey(
  store: SecretStorePort,
  transferId: string,
): Promise<DeviceKey> {
  anchorIssuerKeyRef(transferId);
  let flights = anchorIssuerKeyFlights.get(store);
  if (!flights) {
    flights = new Map();
    anchorIssuerKeyFlights.set(store, flights);
  }
  const active = flights.get(transferId);
  if (active) return active;
  const operation = (async () => {
    const existing = await loadAnchorIssuerKey(store, transferId);
    if (existing) return existing;
    const generated = await DeviceKey.generate();
    await persistAnchorIssuerKey(store, transferId, generated);
    const persisted = await loadAnchorIssuerKey(store, transferId);
    if (!persisted) throw new Error("Persisted anchor issuer key disappeared");
    return persisted;
  })();
  flights.set(transferId, operation);
  try {
    return await operation;
  } finally {
    if (flights.get(transferId) === operation) flights.delete(transferId);
  }
}

export async function persistAnchorIssuerKey(
  store: SecretStorePort,
  transferId: string,
  key: DeviceKey,
): Promise<SecretRef> {
  if ((await store.unlockState()) !== "unlocked") {
    throw new Error("SecretStore must be unlocked before persisting an anchor issuer key");
  }
  const ref = anchorIssuerKeyRef(transferId);
  const encoded = JSON.stringify(key.exportMaterial());
  const previous = await store.get(ref);
  if (previous !== null) {
    const existing = DeviceKey.import(parseMaterial(previous));
    if (JSON.stringify(existing.exportMaterial()) !== encoded) {
      throw new Error("Transfer already owns different anchor issuer key material");
    }
    return ref;
  }
  await store.put(ref, encoded);
  const readBack = await store.get(ref);
  if (readBack !== encoded) {
    throw new Error("Persisted anchor issuer key failed read-back verification");
  }
  return ref;
}

export async function loadAnchorIssuerKey(
  store: SecretStorePort,
  transferId: string,
): Promise<DeviceKey | null> {
  const encoded = await store.get(anchorIssuerKeyRef(transferId));
  return encoded === null ? null : DeviceKey.import(parseMaterial(encoded));
}

export async function deleteAnchorIssuerKey(
  store: SecretStorePort,
  transferId: string,
  expectedIssuerKeyId: string,
): Promise<void> {
  const ref = anchorIssuerKeyRef(transferId);
  const current = await store.get(ref);
  if (current === null) return;
  const key = DeviceKey.import(parseMaterial(current));
  if (key.deviceId !== expectedIssuerKeyId) {
    throw new Error("Refusing to delete an anchor issuer key with a different identity");
  }
  await store.delete(ref);
  if ((await store.get(ref)) !== null) {
    throw new Error("SecretStore retained the deleted anchor issuer key");
  }
}

export async function activateAnchorIssuerKey(
  store: SecretStorePort,
  transferId: string,
  expectedIssuerKeyId: string,
): Promise<SecretRef> {
  if ((await store.unlockState()) !== "unlocked") {
    throw new Error("SecretStore must be unlocked before activating an anchor issuer key");
  }
  const key = await loadAnchorIssuerKey(store, transferId);
  if (!key || key.deviceId !== expectedIssuerKeyId) {
    throw new Error("Transfer anchor issuer key does not match the committed issuer identity");
  }
  const ref = activeAnchorIssuerKeyRef(expectedIssuerKeyId);
  const encoded = JSON.stringify(key.exportMaterial());
  const previous = await store.get(ref);
  if (previous !== null && previous !== encoded) {
    throw new Error("Active anchor issuer identity already owns different key material");
  }
  if (previous === null) await store.put(ref, encoded);
  const readBack = await store.get(ref);
  if (readBack !== encoded || DeviceKey.import(parseMaterial(readBack)).deviceId !== expectedIssuerKeyId) {
    throw new Error("Activated anchor issuer key failed read-back verification");
  }
  return ref;
}

export async function loadActiveAnchorIssuerKey(
  store: SecretStorePort,
  issuerKeyId: string,
): Promise<DeviceKey | null> {
  const encoded = await store.get(activeAnchorIssuerKeyRef(issuerKeyId));
  if (encoded === null) return null;
  const key = DeviceKey.import(parseMaterial(encoded));
  if (key.deviceId !== issuerKeyId) {
    throw new Error("Active anchor issuer key is bound to another identity");
  }
  return key;
}

export function anchorIssuerKeyRef(transferId: string): SecretRef {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(transferId)) {
    throw new TypeError("Anchor issuer key reference requires a stable transfer id");
  }
  return {
    kind: "device-key",
    bindingId: `${ANCHOR_ISSUER_KEY_NAMESPACE}${transferId}`,
  };
}

export function activeAnchorIssuerKeyRef(issuerKeyId: string): SecretRef {
  if (!/^fp:u[A-Za-z0-9_-]{43}$/u.test(issuerKeyId)) {
    throw new TypeError("Active anchor issuer key reference requires an issuer fingerprint");
  }
  return {
    kind: "device-key",
    bindingId: `${ACTIVE_ANCHOR_ISSUER_KEY_NAMESPACE}${issuerKeyId}`,
  };
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
