import type { MeshEndpointDescriptor } from "@zhixing/core/contracts";
import type { MeshEndpointDirectory } from "@zhixing/mesh/bootstrap";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";

/** Demand-owned access to the local Mesh endpoint projection. */
export interface MeshEndpointDirectoryPersistencePort {
  readonly loadEndpoints: () => Promise<MeshEndpointDirectory>;
  readonly acceptEndpoint: (value: unknown) => Promise<MeshEndpointDescriptor>;
}

/** Demand-owned access to authenticated transport peer projections. */
export interface MeshTransportPeerDirectoryPersistencePort {
  readonly loadTransportPeers: () => Promise<readonly TrustedMeshPeer[]>;
  readonly acceptTransportPeer: (peer: TrustedMeshPeer) => Promise<void>;
}

/** Demand-owned idempotency boundary for completed Mesh bootstrap offers. */
export interface MeshBootstrapCompletionPersistencePort {
  readonly markBootstrapComplete: (
    peerDeviceId: string,
    offerId: string,
  ) => Promise<void>;
  readonly bootstrapCompleted: (
    peerDeviceId: string,
    offerId: string,
  ) => Promise<boolean>;
}

export interface MeshBootstrapProjectionPorts {
  readonly endpoints: MeshEndpointDirectoryPersistencePort;
  readonly transportPeers: MeshTransportPeerDirectoryPersistencePort;
  readonly completions: MeshBootstrapCompletionPersistencePort;
}

/** Projects one physical owner into three finite, runtime-narrow capabilities. */
export function createMeshBootstrapProjectionPorts(
  source:
    & MeshEndpointDirectoryPersistencePort
    & MeshTransportPeerDirectoryPersistencePort
    & MeshBootstrapCompletionPersistencePort,
): MeshBootstrapProjectionPorts {
  return Object.freeze({
    endpoints: Object.freeze({
      loadEndpoints: () => source.loadEndpoints(),
      acceptEndpoint: (value: unknown) => source.acceptEndpoint(value),
    }),
    transportPeers: Object.freeze({
      loadTransportPeers: () => source.loadTransportPeers(),
      acceptTransportPeer: (peer: TrustedMeshPeer) =>
        source.acceptTransportPeer(peer),
    }),
    completions: Object.freeze({
      markBootstrapComplete: (peerDeviceId: string, offerId: string) =>
        source.markBootstrapComplete(peerDeviceId, offerId),
      bootstrapCompleted: (peerDeviceId: string, offerId: string) =>
        source.bootstrapCompleted(peerDeviceId, offerId),
    }),
  });
}
