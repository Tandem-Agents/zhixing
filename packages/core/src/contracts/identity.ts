import type {
  Digest,
  IsoTime,
  KeyConfirmation,
  Signature,
  Ulid,
} from "./foundation.js";
import type { WireSchemaV1 } from "../types/distributed.js";

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  displayName: string;
  platform: "windows" | "macos" | "linux" | "headless";
  enrolledAt: IsoTime;
}

export type DeviceRole = "anchor" | "executor" | "surface";

export type HomeTrustEventBody =
  | {
      t: "enroll";
      device: DeviceIdentity;
      roles: DeviceRole[];
      pairingTranscriptDigest: Digest;
    }
  | { t: "reenroll"; deviceId: string; pairingTranscriptDigest: Digest }
  | { t: "role-change"; deviceId: string; roles: DeviceRole[] }
  | { t: "revoke"; deviceId: string; reason: string }
  | {
      t: "recovery-root";
      op: "establish";
      rootPublicKey: string;
      backupPublicKey: string;
      rootProof: Signature;
      signedBy: "issuer";
    }
  | {
      t: "recovery-root";
      op: "rotate";
      rootPublicKey: string;
      backupPublicKey: string;
      rootProof: Signature;
      signedBy: "recovery-root";
    }
  | { t: "recovery-root"; op: "invalidate"; signedBy: "recovery-root" }
  | {
      t: "domain-reset";
      nextTrustEpoch: number;
      reason: "recovery-root-lost";
      coSign: { deviceId: string; sig: Signature };
    }
  | {
      t: "issuer-transition";
      nextTrustEpoch: number;
      fromIssuerKeyId: string;
      toIssuerKeyId: string;
      toDeviceId: string;
      reason: "migration" | "disaster-recovery";
      signedBy: "issuer" | "recovery-root";
    };

export interface HomeTrustEvent extends WireSchemaV1<"HomeTrustEvent"> {
  homeId: Ulid;
  seq: number;
  prevEventDigest: Digest;
  trustEpoch: number;
  body: HomeTrustEventBody;
  at: IsoTime;
  signature: Signature;
}

export interface HomeTrustRecord extends WireSchemaV1<"HomeTrustRecord"> {
  homeId: Ulid;
  trustEpoch: number;
  chainHead: { seq: number; eventDigest: Digest };
  issuer: { deviceId: string; issuerKeyId: string };
  recoveryRootPublicKey?: string;
  recoveryBackupPublicKey?: string;
  members: Array<{
    device: DeviceIdentity;
    roles: DeviceRole[];
    state: "active" | "revoked" | "pending-reenroll";
  }>;
  signature: Signature;
}

export type AnchorTransferCommit = WireSchemaV1<"AnchorTransferCommit"> &
  (
    | {
        mode: "planned";
        transferId: string;
        sourceDeviceId: string;
        targetDeviceId: string;
        freezeProofDigest: Digest;
        checkpointDigest: Digest;
        authorityCatalogDigest: Digest;
        trustTransitionDigest: Digest;
        nextAnchorEpoch: number;
        nextTrustEpoch: number;
        targetIssuerPublicKey: string;
        readyProofDigest: Digest;
        signature: Signature;
        at: IsoTime;
      }
    | {
        mode: "disaster-recovery";
        transferId: string;
        targetDeviceId: string;
        checkpointEnvelopeDigest: Digest;
        authorityCatalogDigest: Digest;
        trustTransitionDigest: Digest;
        nextAnchorEpoch: number;
        nextTrustEpoch: number;
        targetIssuerPublicKey: string;
        readyProofDigest: Digest;
        signature: Signature;
        at: IsoTime;
      }
  );

export interface SourceFreezeProof extends WireSchemaV1<"SourceFreezeProof"> {
  transferId: string;
  scope: "conversation" | "anchor";
  subject: string;
  sourceEpoch: number;
  checkpointDigest: Digest;
  lastLsn: number;
  signature: Signature;
}

export interface ConversationTransferCommit
  extends WireSchemaV1<"ConversationTransferCommit"> {
  transferId: string;
  conversationId: string;
  sourceDeviceId: string;
  freezeProofDigest: Digest;
  checkpointDigest: Digest;
  sourceOwnerEpoch: number;
  nextOwnerEpoch: number;
  signature: Signature;
  at: IsoTime;
}

export interface PairingOffer extends WireSchemaV1<"PairingOffer"> {
  offerId: Ulid;
  homeId: Ulid;
  protocolVersion: string;
  issuer: { deviceId: string; keyFingerprint: Digest };
  issuerNonce: string;
  method: { kind: "qr-secret" } | { kind: "short-pake"; suite: string };
  expiresAt: IsoTime;
  singleUse: true;
  attempts: { max: number; onExhaust: "expire" };
}

export type PairingJoin = WireSchemaV1<"PairingJoin"> &
  (
    | {
        method: "qr-secret";
        offerId: Ulid;
        device: DeviceIdentity;
        joinerNonce: string;
        confirmation: KeyConfirmation;
      }
    | {
        method: "short-pake";
        offerId: Ulid;
        device: DeviceIdentity;
        joinerNonce: string;
      }
  );

export interface PakeRound extends WireSchemaV1<"PakeRound"> {
  offerId: Ulid;
  round: number;
  from: "issuer" | "joiner";
  payload: string;
}

export type PairingFinished =
  | {
      method: "qr-secret";
      issuer: { sig: Signature };
      joiner: { sig: Signature };
    }
  | {
      method: "short-pake";
      issuer: { sig: Signature; keyConfirm: KeyConfirmation };
      joiner: { sig: Signature; keyConfirm: KeyConfirmation };
    };

export interface PairingAcceptance extends WireSchemaV1<"PairingAcceptance"> {
  offerId: Ulid;
  transcriptDigest: Digest;
  chainHead: { seq: number; eventDigest: Digest };
  acceptedAt: IsoTime;
  finished: PairingFinished;
}

export type SecretRef = {
  kind: "provider" | "channel" | "mcp" | "device-key" | "webhook";
  bindingId: string;
};

export interface SecretStorePort {
  put(ref: SecretRef, value: string): Promise<void>;
  get(ref: SecretRef): Promise<string | null>;
  delete(ref: SecretRef): Promise<void>;
  list(prefix: string): Promise<SecretRef[]>;
  unlockState(): Promise<"unlocked" | "locked" | "unavailable">;
}

export interface CredentialExposureRecord {
  deviceId: string;
  bindingId: string;
  service: string;
  principalFingerprint?: Digest;
  tenant?: string;
  scopes?: string[];
  state: "active" | "compromised" | "rotated";
  markedAt: IsoTime;
  rotationHint?: string;
}
