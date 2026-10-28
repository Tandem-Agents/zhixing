import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceKey } from "@zhixing/mesh/device-identity";
import {
  deleteDeviceKey,
  loadDeviceKey,
  persistDeviceKey,
} from "@zhixing/mesh/device-key-store";

/**
 * 本机当前设备身份只有一份（device-key/device/v1/）。显式重新配对需要新身份时（原身份已被撤销），
 * 候选钥先放在不被普通身份发现选中的 candidate 命名空间；配对提交并校验后写切换记录，再发布新钥、
 * 把旧钥移到隔离的 retired 命名空间。切换中断时加载只按切换记录补齐，任何时刻可选的当前身份恰好一份。
 * 切换记录绑定发布它的那次配对，长期保留：current 是最近一次，更早的按新身份归档在 history 下，
 * 是本机把每个身份与它取代的旧设备关联起来的依据。上一次切换完成之后，下一次合法的显式重新配对可以再切换。
 */
const DEVICE_PREFIX = "device-key/device/v1/";
const CANDIDATE_PREFIX = "device-key/candidate/v1/";
const candidateRef = (deviceId: string): SecretRef => ({ kind: "device-key", bindingId: `candidate/v1/${deviceId}` });
const retiredRef = (deviceId: string): SecretRef => ({ kind: "device-key", bindingId: `retired/v1/${deviceId}` });
const SWITCH_REF: SecretRef = { kind: "device-key", bindingId: "switch/v1/current" };
const switchHistoryRef = (deviceId: string): SecretRef => ({ kind: "device-key", bindingId: `switch/v1/history/${deviceId}` });

/** 一次身份切换：旧身份、新身份与发布它的配对事件摘要。 */
export interface DeviceKeySwitch { readonly from: string; readonly to: string; readonly pairing: string }

/** Loads the device identity without importing either authority role runtime. */
export async function loadOrCreateDeviceKey(
  store: SecretStorePort,
): Promise<DeviceKey> {
  const existing = await loadExistingDeviceKey(store);
  if (existing) return existing;
  const generated = await DeviceKey.generate();
  await persistDeviceKey(store, generated);
  return generated;
}

/** Reads the single local identity without creating one. */
export async function loadExistingDeviceKey(
  store: SecretStorePort,
): Promise<DeviceKey | undefined> {
  const ids = await deviceIds(store);
  const switched = await readDeviceKeySwitch(store);
  // 切换中断：已提交的显式配对要求的切换，只按记录补齐到唯一的新身份
  if (switched && (ids.length > 1 || (ids.length === 1 && ids[0] === switched.from))) {
    if (!ids.every((id) => id === switched.from || id === switched.to)) {
      throw new Error("SecretStore contains multiple local device identities");
    }
    return completeSwitch(store, switched);
  }
  if (ids.length > 1) {
    throw new Error("SecretStore contains multiple local device identities");
  }
  const deviceId = ids[0];
  if (!deviceId) return undefined;
  const key = await loadDeviceKey(store, deviceId);
  if (!key) throw new Error("SecretStore device identity disappeared during startup");
  // 切换在删候选之前中断：当前身份已是新钥，残留候选不能留给下一次重新加入复用
  if (switched?.to === deviceId) await store.delete(candidateRef(deviceId));
  return key;
}

/** 显式重新配对用的候选新身份：已有就复用（重试不重复生成），不被普通身份发现选中。 */
export async function loadOrCreateCandidateDeviceKey(store: SecretStorePort): Promise<DeviceKey> {
  const refs = await store.list(CANDIDATE_PREFIX);
  if (refs.length > 1) throw new Error("SecretStore contains multiple candidate device identities");
  const existing = refs[0];
  if (existing) {
    const encoded = await store.get({ kind: "device-key", bindingId: existing.bindingId });
    if (encoded === null) throw new Error("Candidate device identity disappeared");
    return DeviceKey.import(JSON.parse(encoded));
  }
  const generated = await DeviceKey.generate();
  await store.put(candidateRef(generated.deviceId), JSON.stringify(generated.exportMaterial()));
  return generated;
}

/** 已存在的候选新身份（配对续接按它恢复）；没有返回 undefined。 */
export async function loadCandidateDeviceKey(store: SecretStorePort, deviceId: string): Promise<DeviceKey | undefined> {
  const encoded = await store.get(candidateRef(deviceId));
  return encoded === null ? undefined : DeviceKey.import(JSON.parse(encoded));
}

/**
 * 配对提交并校验之后发布新身份：先写切换记录，再写新钥、隔离旧钥、删旧当前项与候选。
 * 同一切换（新旧身份与配对都相同）重入即续做；新的切换只能从当前唯一身份开始，上一次切换（若有）必须正是切换到它，
 * 先把上一条归档再写新记录。每步幂等，中断后由 loadExistingDeviceKey 按记录补齐；旧钥保留在隔离命名空间。
 */
export async function publishSwitchedDeviceKey(store: SecretStorePort, from: DeviceKey, to: DeviceKey, pairing: string): Promise<void> {
  const next: DeviceKeySwitch = { from: from.deviceId, to: to.deviceId, pairing };
  const existing = await readDeviceKeySwitch(store);
  if (!existing || !sameSwitch(existing, next)) {
    const ids = await deviceIds(store);
    if (ids.length !== 1 || ids[0] !== from.deviceId) throw new Error("A device identity switch must start from the current identity");
    if (existing) {
      if (existing.to !== from.deviceId) throw new Error("A different device identity switch is already recorded");
      await archiveSwitch(store, existing);
    }
    await store.put(SWITCH_REF, JSON.stringify(next));
  }
  await persistDeviceKey(store, to);
  await completeSwitch(store, next);
}

/** 身份经显式重新配对取代的旧设备（按切换记录，含已归档的更早切换）；不是切换来的身份返回 undefined。 */
export async function replacedDeviceOf(store: SecretStorePort, deviceId: string): Promise<string | undefined> {
  const switched = await readDeviceKeySwitch(store);
  if (switched?.to === deviceId) return switched.from;
  const archived = await store.get(switchHistoryRef(deviceId));
  return archived === null ? undefined : parseSwitch(archived).from;
}

/** 本机最近一次设备身份切换（新身份取代的旧设备）；没有切换过返回 undefined。 */
export async function readDeviceKeySwitch(store: SecretStorePort): Promise<DeviceKeySwitch | undefined> {
  const encoded = await store.get(SWITCH_REF);
  return encoded === null ? undefined : parseSwitch(encoded);
}

function parseSwitch(encoded: string): DeviceKeySwitch {
  const value = JSON.parse(encoded) as Partial<DeviceKeySwitch>;
  if (typeof value.from !== "string" || typeof value.to !== "string" || value.from === value.to || typeof value.pairing !== "string") {
    throw new Error("Device identity switch record is invalid");
  }
  return { from: value.from, to: value.to, pairing: value.pairing };
}

function sameSwitch(left: DeviceKeySwitch, right: DeviceKeySwitch): boolean {
  return left.from === right.from && left.to === right.to && left.pairing === right.pairing;
}

/** 已完成的上一次切换按它的新身份归档（每个身份只由一次切换产生）；重入幂等，内容不同即冲突。 */
async function archiveSwitch(store: SecretStorePort, switched: DeviceKeySwitch): Promise<void> {
  const ref = switchHistoryRef(switched.to);
  const archived = await store.get(ref);
  if (archived === null) await store.put(ref, JSON.stringify(switched));
  else if (!sameSwitch(parseSwitch(archived), switched)) throw new Error("A different device identity switch is already archived");
}

async function completeSwitch(store: SecretStorePort, switched: DeviceKeySwitch): Promise<DeviceKey> {
  let next = await loadDeviceKey(store, switched.to);
  if (!next) {
    const candidate = await loadCandidateDeviceKey(store, switched.to);
    if (!candidate) throw new Error("Device identity switch lost its new identity");
    await persistDeviceKey(store, candidate);
    next = candidate;
  }
  const previous = await loadDeviceKey(store, switched.from);
  if (previous) {
    if ((await store.get(retiredRef(switched.from))) === null) {
      await store.put(retiredRef(switched.from), JSON.stringify(previous.exportMaterial()));
    }
    await deleteDeviceKey(store, switched.from);
  }
  await store.delete(candidateRef(switched.to));
  return next;
}

async function deviceIds(store: SecretStorePort): Promise<string[]> {
  return (await store.list(DEVICE_PREFIX)).map((ref) => ref.bindingId.slice("device/v1/".length));
}
