import type {
  DeviceIdentity,
  HomeTrustEvent,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  MeshEndpointTransport,
  PairingAcceptance,
  PairingJoin,
  PairingOffer,
  PakeRound,
} from "@zhixing/core/contracts";
import type { PairingAttemptAdmission } from "@zhixing/mesh/bootstrap-authority";
import type { SealedPairingDiscoverySecret } from "@zhixing/mesh/bootstrap";

export interface DurablePairingInvitation {
  readonly v: 1;
  readonly offer: PairingOffer;
  readonly issuer: DeviceIdentity;
  readonly rendezvousKey: string;
  readonly transports: readonly MeshEndpointTransport[];
}

export type PairingIssuerContinuation =
  | {
      readonly v: 1;
      readonly side: "issuer";
      readonly phase: "offer-secret-pending" | "offered";
      readonly invitation: DurablePairingInvitation;
      readonly issuerEndpoint: MeshEndpointDescriptor;
    }
  | ({
      readonly v: 1;
      readonly side: "issuer";
      readonly invitation: DurablePairingInvitation;
      readonly issuerEndpoint: MeshEndpointDescriptor;
      readonly attempt: PairingAttemptAdmission;
      readonly join: PairingJoin;
      readonly joinerRootCertificatePem: string;
      readonly pakeRounds: readonly PakeRound[];
      readonly acceptanceBody: Omit<PairingAcceptance, "finished">;
      readonly issuerProof: PairingAcceptance["finished"]["issuer"];
      readonly trustEvent: HomeTrustEvent;
    } & (
      | { readonly phase: "secret-pending" }
      | { readonly phase: "commit-ready" }
    ));

export interface DurablePairingBootstrap {
  readonly acceptance: PairingAcceptance;
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly trustRecord: HomeTrustRecord;
  readonly issuerRootCertificatePem: string;
  readonly issuerEndpoint: MeshEndpointDescriptor;
  /** 配对会话钥封装的家级 discovery 秘密。 */
  readonly homeDiscovery?: SealedPairingDiscoverySecret;
}

/**
 * 已是成员的设备重新加入时，在接续前耐久绑定的工作流事实：被这次显式配对取代的本机旧移除、
 * 新身份时被取代的原身份；分叉接续在发布当前分支之前记下 adoptionId。续接按它逐阶段补完。
 */
export interface PairingRejoinBinding {
  readonly operationIds: readonly string[];
  readonly replacedDeviceId?: string;
  readonly adoptionId?: string;
}

interface PairingJoinerContinuationBase {
  readonly v: 1;
  readonly side: "joiner";
  readonly invitation: DurablePairingInvitation;
  readonly localDeviceId: string;
  readonly join: PairingJoin;
  readonly pakeRounds: readonly PakeRound[];
  readonly proof: PairingAcceptance["finished"]["joiner"];
  readonly rejoin?: PairingRejoinBinding;
}

export type PairingJoinerContinuation = PairingJoinerContinuationBase & (
  | { readonly phase: "secret-pending" }
  | { readonly phase: "proof-ready" }
  | {
      readonly phase: "bootstrap-ready";
      readonly committed: DurablePairingBootstrap;
    }
);

export type PairingContinuation = PairingIssuerContinuation | PairingJoinerContinuation;

export interface MeshPairingContinuationRepository {
  readonly load: () => Promise<PairingContinuation | undefined>;
  readonly save: (state: PairingContinuation) => Promise<void>;
  readonly clear: (expectedOfferId: string) => Promise<void>;
}

/** Freezes the only continuation capabilities exposed beyond a Host edge. */
export function projectMeshPairingContinuationRepository(
  source: MeshPairingContinuationRepository,
): MeshPairingContinuationRepository {
  return Object.freeze({
    load: () => source.load(),
    save: (state: PairingContinuation) => source.save(state),
    clear: (expectedOfferId: string) => source.clear(expectedOfferId),
  });
}
