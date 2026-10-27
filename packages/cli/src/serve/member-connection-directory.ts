import type { AuthorityCommitLog, DurableProjectionMutation, DurableProjectionReadContext } from "@zhixing/core/authority";
import { DurableProjectionRecordBindingError } from "@zhixing/core/authority";
import type { DeviceIdentity, JsonValue, MeshEndpointDescriptor } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { validateMeshEndpointDescriptor } from "@zhixing/mesh/bootstrap";
import { validateDeviceTrustRoot } from "@zhixing/mesh/device-identity";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";

/**
 * 成员连接目录：本机认证过的公开连接资料（传输身份、端点），按设备与密钥代际绑定，写进权威日志，
 * 随计划迁居的导入前缀与完整检查点交给继任值班设备。它不是第二信任源：成员资格、角色、issuer 只看 trust，
 * 读取方须核目录里的公钥与当前信任中该成员一致。端点只收发布者等于描述设备、revision 严格递增的记录。
 */
export const MEMBER_CONNECTION_STREAM = "member-connection";
export const MEMBER_CONNECTION_PROJECTION_ID = "member-connection-v1";

export interface MemberConnectionLogPort {
  durableProjection: AuthorityCommitLog["durableProjection"];
  transactDurableProjection: AuthorityCommitLog["transactDurableProjection"];
}

type DirectoryRecord =
  | { readonly v: 1; readonly t: "member-transport"; readonly peer: TrustedMeshPeer; readonly keyGeneration: string }
  | {
      readonly v: 1;
      readonly t: "member-endpoint";
      readonly descriptor: MeshEndpointDescriptor;
      readonly publisherDeviceId: string;
      readonly keyGeneration: string;
    };

const transportKey = (deviceId: string) => `transport/${protocolDigest("MemberConnectionIdentity", 1, { deviceId })}`;
const endpointKey = (deviceId: string) => `endpoint/${protocolDigest("MemberConnectionIdentity", 1, { deviceId })}`;

export function deviceKeyGeneration(identity: Pick<DeviceIdentity, "deviceId" | "publicKey">): string {
  return protocolDigest("DeviceKeyGeneration", 1, { deviceId: identity.deviceId, publicKey: identity.publicKey });
}

export function registerMemberConnectionDirectory(log: Pick<MemberConnectionLogPort, "durableProjection">): void {
  log.durableProjection({
    projectionId: MEMBER_CONNECTION_PROJECTION_ID,
    reducerVersion: 1,
    authenticated: true,
    inputs: { streams: [MEMBER_CONNECTION_STREAM] },
    reduce: async (envelope, current) => {
      const changes: DurableProjectionMutation[] = [];
      const overlay = new Map<string, JsonValue>();
      const read = async (key: string) => overlay.has(key) ? overlay.get(key) : current.get(key);
      for (const entry of envelope.entries) {
        if (entry.stream !== MEMBER_CONNECTION_STREAM) continue;
        const record = validateRecord(entry.body);
        if (record.t === "member-transport") {
          const key = transportKey(record.peer.identity.deviceId);
          const existing = await read(key);
          // 同一设备同一代际只认第一份；换了代际（重新入网换钥）由新记录接替
          if (existing !== undefined && canonicalize((existing as { keyGeneration?: unknown }).keyGeneration) === canonicalize(record.keyGeneration)) continue;
          overlay.set(key, record as unknown as JsonValue);
          changes.push({ kind: "put", key, value: record as unknown as JsonValue });
        } else {
          const key = endpointKey(record.descriptor.deviceId);
          const existing = await read(key) as { descriptor?: MeshEndpointDescriptor; keyGeneration?: string } | undefined;
          if (existing?.descriptor && existing.keyGeneration === record.keyGeneration &&
              existing.descriptor.revision >= record.descriptor.revision) continue;
          overlay.set(key, record as unknown as JsonValue);
          changes.push({ kind: "put", key, value: record as unknown as JsonValue });
        }
      }
      return changes;
    },
  });
}

/** 记录本机认证过的传输身份：根证书须绑定该设备公钥；同一代际已记录即不再追加。 */
export async function recordMemberTransport(log: MemberConnectionLogPort, peer: TrustedMeshPeer): Promise<void> {
  validateDeviceTrustRoot(peer.identity, peer.rootCertificatePem);
  const record: DirectoryRecord = {
    v: 1,
    t: "member-transport",
    peer: { identity: peer.identity, rootCertificatePem: peer.rootCertificatePem },
    keyGeneration: deviceKeyGeneration(peer.identity),
  };
  registerMemberConnectionDirectory(log);
  await log.transactDurableProjection(MEMBER_CONNECTION_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    const existing = await view.get(transportKey(peer.identity.deviceId)) as { keyGeneration?: string; peer?: TrustedMeshPeer } | undefined;
    if (existing?.keyGeneration === record.keyGeneration) {
      if (canonicalize(existing.peer) !== canonicalize(record.peer)) {
        throw new Error("Authenticated mesh peer transport identity changed");
      }
      return { kind: "return" as const, value: undefined };
    }
    return { kind: "append" as const, entries: [{ stream: MEMBER_CONNECTION_STREAM, body: record as unknown as JsonValue }], value: undefined };
  });
}

/**
 * 记录成员认证发布的端点：调用方保证描述设备即发布者（端点服务按连接对端核过、配对按配对双方核过）。
 * revision 不大于已记录的同代际端点时不追加。
 */
export async function recordMemberEndpoint(
  log: MemberConnectionLogPort,
  descriptor: MeshEndpointDescriptor,
  publisher: Pick<DeviceIdentity, "deviceId" | "publicKey">,
): Promise<void> {
  const accepted = validateMeshEndpointDescriptor(descriptor);
  if (accepted.deviceId !== publisher.deviceId) throw new Error("Mesh endpoint descriptor does not belong to its publisher");
  const record: DirectoryRecord = {
    v: 1,
    t: "member-endpoint",
    descriptor: accepted,
    publisherDeviceId: publisher.deviceId,
    keyGeneration: deviceKeyGeneration(publisher),
  };
  registerMemberConnectionDirectory(log);
  await log.transactDurableProjection(MEMBER_CONNECTION_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    const existing = await view.get(endpointKey(accepted.deviceId)) as { descriptor?: MeshEndpointDescriptor; keyGeneration?: string } | undefined;
    if (existing?.descriptor && existing.keyGeneration === record.keyGeneration && existing.descriptor.revision >= accepted.revision) {
      return { kind: "return" as const, value: undefined };
    }
    return { kind: "append" as const, entries: [{ stream: MEMBER_CONNECTION_STREAM, body: record as unknown as JsonValue }], value: undefined };
  });
}

/** 按设备精确读传输身份；调用方给出当前信任里该成员的身份时，公钥不一致即视为没有。 */
export async function readMemberTransport(
  log: MemberConnectionLogPort,
  deviceId: string,
  expected?: Pick<DeviceIdentity, "deviceId" | "publicKey">,
): Promise<TrustedMeshPeer | undefined> {
  registerMemberConnectionDirectory(log);
  const value = (await log.transactDurableProjection(MEMBER_CONNECTION_PROJECTION_ID, async (view: DurableProjectionReadContext) => ({
    kind: "return" as const,
    value: await view.get(transportKey(deviceId)),
  }))).value;
  if (value === undefined) return undefined;
  const record = readRow(value);
  if (record.t !== "member-transport" || record.peer.identity.deviceId !== deviceId) throw invalidRow();
  if (expected && (expected.deviceId !== deviceId || expected.publicKey !== record.peer.identity.publicKey)) return undefined;
  validateDeviceTrustRoot(record.peer.identity, record.peer.rootCertificatePem);
  return record.peer;
}

export async function readMemberEndpoint(
  log: MemberConnectionLogPort,
  deviceId: string,
  expected?: Pick<DeviceIdentity, "deviceId" | "publicKey">,
): Promise<MeshEndpointDescriptor | undefined> {
  registerMemberConnectionDirectory(log);
  const value = (await log.transactDurableProjection(MEMBER_CONNECTION_PROJECTION_ID, async (view: DurableProjectionReadContext) => ({
    kind: "return" as const,
    value: await view.get(endpointKey(deviceId)),
  }))).value;
  if (value === undefined) return undefined;
  const record = readRow(value);
  if (record.t !== "member-endpoint" || record.descriptor.deviceId !== deviceId) throw invalidRow();
  if (expected && record.keyGeneration !== deviceKeyGeneration(expected)) return undefined;
  return record.descriptor;
}

function validateRecord(value: unknown): DirectoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Member connection record is invalid");
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.keyGeneration !== "string") throw new TypeError("Member connection record is invalid");
  if (record.t === "member-transport") {
    const peer = record.peer as TrustedMeshPeer | undefined;
    if (!peer || typeof peer !== "object" || !peer.identity || typeof peer.rootCertificatePem !== "string" ||
        canonicalize(Object.keys(record).sort()) !== canonicalize(["keyGeneration", "peer", "t", "v"]) ||
        record.keyGeneration !== deviceKeyGeneration(peer.identity)) {
      throw new TypeError("Member transport record is invalid");
    }
    // 根证书的有效期随时间变化，不放进归约（重放不能因时间失败）；写入与读取时各核一次
    return record as unknown as DirectoryRecord;
  }
  if (record.t === "member-endpoint") {
    if (canonicalize(Object.keys(record).sort()) !== canonicalize(["descriptor", "keyGeneration", "publisherDeviceId", "t", "v"])) {
      throw new TypeError("Member endpoint record is invalid");
    }
    const descriptor = validateMeshEndpointDescriptor(record.descriptor);
    if (descriptor.deviceId !== record.publisherDeviceId) throw new TypeError("Member endpoint record names another publisher");
    return record as unknown as DirectoryRecord;
  }
  throw new TypeError("Member connection record type is unsupported");
}

function readRow(value: JsonValue): DirectoryRecord {
  try {
    return validateRecord(value);
  } catch {
    throw invalidRow();
  }
}

function invalidRow(): DurableProjectionRecordBindingError {
  return new DurableProjectionRecordBindingError("Member connection directory row is invalid");
}
