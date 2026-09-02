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
}

interface PairingJoinerContinuationBase {
  readonly v: 1;
  readonly side: "joiner";
  readonly invitation: DurablePairingInvitation;
  readonly localDeviceId: string;
  readonly join: PairingJoin;
  readonly pakeRounds: readonly PakeRound[];
  readonly proof: PairingAcceptance["finished"]["joiner"];
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
