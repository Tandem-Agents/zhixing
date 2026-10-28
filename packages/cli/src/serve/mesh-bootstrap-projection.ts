import type { MeshEndpointDescriptor } from "@zhixing/core/contracts";
import type { MeshEndpointDirectory } from "@zhixing/mesh/bootstrap";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";

/** Demand-owned access to the local Mesh endpoint projection. */
export interface MeshEndpointDirectoryPersistencePort {
  readonly loadEndpoints: () => Promise<MeshEndpointDirectory>;
  readonly acceptEndpoint: (value: unknown) => Promise<MeshEndpointDescriptor>;
}

/** 已认证传输身份按设备键存取；启动与常驻路径只做精确读。 */
export interface MeshTransportPeerDirectoryPersistencePort {
  readonly transportPeer: (deviceId: string) => Promise<TrustedMeshPeer | undefined>;
  readonly acceptTransportPeer: (peer: TrustedMeshPeer) => Promise<void>;
}

/** 已知对端清单的显式枚举：只给灾备、备份等人工命令。 */
export interface MeshTransportPeerInventoryPort {
  readonly listTransportPeers: () => Promise<readonly TrustedMeshPeer[]>;
}

/** Demand-owned idempotency boundary for completed Mesh bootstrap offers. */
export interface MeshBootstrapCompletionPersistencePort {
  readonly markBootstrapComplete: (
    peerDeviceId: string,
    offerId: string,
    options?: { readonly replacePrevious?: boolean },
  ) => Promise<void>;
  readonly bootstrapCompleted: (
    peerDeviceId: string,
    offerId: string,
  ) => Promise<boolean>;
}

export interface MeshBootstrapProjectionPorts {
  readonly endpoints: MeshEndpointDirectoryPersistencePort;
  readonly transportPeers: MeshTransportPeerDirectoryPersistencePort & MeshTransportPeerInventoryPort;
  readonly completions: MeshBootstrapCompletionPersistencePort;
}

/** 当前信任投影里 active 的其他成员：只为它们精确读传输身份，读取随成员数。 */
export async function loadActiveMemberTransportPeers(
  directory: Pick<MeshTransportPeerDirectoryPersistencePort, "transportPeer">,
  members: readonly { readonly device: { readonly deviceId: string }; readonly state: string }[],
  localDeviceId: string,
): Promise<readonly TrustedMeshPeer[]> {
  const peers: TrustedMeshPeer[] = [];
  for (const member of members) {
    if (member.state !== "active" || member.device.deviceId === localDeviceId) continue;
    const peer = await directory.transportPeer(member.device.deviceId);
    if (peer) peers.push(peer);
  }
  return peers;
}

/** Projects one physical owner into three finite, runtime-narrow capabilities. */
export function createMeshBootstrapProjectionPorts(
  source:
    & MeshEndpointDirectoryPersistencePort
    & MeshTransportPeerDirectoryPersistencePort
    & MeshTransportPeerInventoryPort
    & MeshBootstrapCompletionPersistencePort,
): MeshBootstrapProjectionPorts {
  return Object.freeze({
    endpoints: Object.freeze({
      loadEndpoints: () => source.loadEndpoints(),
      acceptEndpoint: (value: unknown) => source.acceptEndpoint(value),
    }),
    transportPeers: Object.freeze({
      transportPeer: (deviceId: string) => source.transportPeer(deviceId),
      listTransportPeers: () => source.listTransportPeers(),
      acceptTransportPeer: (peer: TrustedMeshPeer) =>
        source.acceptTransportPeer(peer),
    }),
    completions: Object.freeze({
      markBootstrapComplete: (peerDeviceId: string, offerId: string, options?: { readonly replacePrevious?: boolean }) =>
        source.markBootstrapComplete(peerDeviceId, offerId, options),
      bootstrapCompleted: (peerDeviceId: string, offerId: string) =>
        source.bootstrapCompleted(peerDeviceId, offerId),
    }),
  });
}
