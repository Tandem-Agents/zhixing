import type {
  ArtifactRef,
  Digest,
  IsoTime,
  KeyConfirmation,
  ProtocolVersion,
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

export interface MeshRoleBootConfig {
  enabledRoles: readonly DeviceRole[];
  anchorListen?: {
    bind: { host: string; port: number };
    advertised?: ReadonlyArray<{ host: string; port: number }>;
  };
  relayRegistration?: { host: string; port: number };
}

export type MeshEndpointTransport =
  | { kind: "direct"; host: string; port: number }
  | { kind: "blind-relay"; relay: { host: string; port: number } };

export interface MeshEndpointDescriptor
  extends WireSchemaV1<"MeshEndpointDescriptor"> {
  deviceId: string;
  transports: readonly MeshEndpointTransport[];
  revision: number;
  at: IsoTime;
}

export type RendezvousKey = `rzv:${string}`;

export interface BlindRendezvousHello {
  v: 1;
  key: RendezvousKey;
  ttlMs: number;
}

export type HomeTrustEventBody =
  | {
      t: "genesis";
      issuer: DeviceIdentity;
    }
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
  | ({
      t: "issuer-transition";
      nextTrustEpoch: number;
      fromIssuerKeyId: string;
      toIssuerKeyId: string;
      /** Present when the issuer key is distinct from the target device identity key. */
      toIssuerPublicKey?: string;
      toDeviceId: string;
    } &
      (
        | { reason: "migration"; signedBy: "issuer" }
        | { reason: "disaster-recovery"; signedBy: "recovery-root" }
      ));

export interface HomeTrustEvent extends WireSchemaV1<"HomeTrustEvent"> {
  homeId: Ulid;
  seq: number;
  prevEventDigest: Digest;
  trustEpoch: number;
  body: HomeTrustEventBody;
  at: IsoTime;
  signature: Signature;
}

export type HomeTrustEventWithBody<Body extends HomeTrustEventBody> = Omit<
  HomeTrustEvent,
  "body"
> & { body: Body };

export interface HomeTrustRecord extends WireSchemaV1<"HomeTrustRecord"> {
  homeId: Ulid;
  trustEpoch: number;
  chainHead: { seq: number; eventDigest: Digest };
  issuer: { deviceId: string; issuerKeyId: string; issuerPublicKey?: string };
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

export interface ReadyProof extends WireSchemaV1<"ReadyProof"> {
  transferId: string;
  homeId: string;
  targetDeviceId: string;
  trustEpoch: number;
  trustChainHead: { seq: number; eventDigest: Digest };
  targetIssuerKeyId: string;
  targetIssuerPublicKey: string;
  roles: readonly DeviceRole[];
  configuredCapabilities: {
    providers: readonly string[];
    mcpServers: readonly string[];
    channels: readonly string[];
  };
  protocolRevision: string;
  assetRevision: string;
  serviceRevision: string;
  secretStore: "unlocked";
  issuedAt: IsoTime;
  expiresAt: IsoTime;
  /** Existing device identity proves which paired target produced the proof. */
  signature: Signature;
  /** The transfer-bound issuer key proves possession without exposing private material. */
  issuerPossession: Signature;
}

export type AuthorityCatalogCoverage =
  | "global-authority"
  | "conversation-authority"
  | "conversation-content"
  | "execution-assets"
  | "trust-and-anchor"
  | "pending-obligations";

export interface AuthorityCatalogStreamRange {
  stream: string;
  firstLsn: number;
  lastLsn: number;
  recordCount: number;
  digest: Digest;
}

/** Canonical inventory of one frozen anchor-authority prefix. */
export interface AuthorityCatalog extends WireSchemaV1<"AuthorityCatalog"> {
  transferId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sourceAnchorEpoch: number;
  source: {
    logId: string;
    lsn: number;
    frameEndOffset: number;
    prefixDigest: Digest;
  };
  trust: {
    homeId: string;
    trustEpoch: number;
    chainHead: { seq: number; eventDigest: Digest };
    issuerDeviceId: string;
    issuerKeyId: string;
  };
  coverage: readonly AuthorityCatalogCoverage[];
  streams: readonly AuthorityCatalogStreamRange[];
  authorityRecords: ArtifactRef;
  retainedArtifacts: readonly ArtifactRef[];
  pendingObligations: readonly {
    kind: "assignment" | "interaction" | "final" | "delivery" | "intent" | "confirmation";
    id: string;
  }[];
}

export interface AnchorTransferAbort
  extends WireSchemaV1<"AnchorTransferAbort"> {
  requestId: string;
  transferId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sourceAnchorEpoch: number;
  reason: "source-resumed" | "target-rejected" | "operator-cancelled";
  at: IsoTime;
  signature: Signature;
}

export type AnchorTransferCommand = WireSchemaV1<"AnchorTransferCommand"> &
  (
    | {
        op: "prepare";
        requestId: string;
        transferId: string;
        sourceDeviceId: string;
        targetDeviceId: string;
        sourceAnchorEpoch: number;
        nextAnchorEpoch: number;
        readyProof: ReadyProof;
        trustTransition: HomeTrustEventWithBody<
          Extract<HomeTrustEventBody, { t: "issuer-transition"; reason: "migration" }>
        >;
        signature: Signature;
      }
    | {
        op: "freeze";
        requestId: string;
        transferId: string;
        recoveryCheckpointDigest: Digest;
        checkpoint: ArtifactRef;
        catalog: ArtifactRef;
        proof: SourceFreezeProof;
        signature: Signature;
      }
    | {
        op: "probe";
        requestId: string;
        transferId: string;
        ref: ArtifactRef;
        signature: Signature;
      }
    | {
        op: "read-range";
        requestId: string;
        transferId: string;
        ref: ArtifactRef;
        offset: number;
        length: number;
        signature: Signature;
      }
    | {
        op: "import";
        requestId: string;
        transferId: string;
        checkpoint: ArtifactRef;
        catalog: ArtifactRef;
        signature: Signature;
      }
    | {
        op: "commit";
        requestId: string;
        transferId: string;
        commit: Extract<AnchorTransferCommit, { mode: "planned" }>;
        signature: Signature;
      }
    | {
        op: "abort";
        requestId: string;
        transferId: string;
        abort: AnchorTransferAbort;
        signature: Signature;
      }
    | {
        op: "status";
        requestId: string;
        transferId: string;
        signature: Signature;
      }
  );

export type AnchorTransferResult = WireSchemaV1<"AnchorTransferResult"> &
  (
    | ({
        status: "ok";
        requestId: string;
        transferId: string;
      } & (
        | { state: "prepared"; ref?: never; commit?: never; abort?: never }
        | { state: "frozen" | "imported"; ref: ArtifactRef; commit?: never; abort?: never }
        | {
            state: "committed" | "tombstoned";
            commit: Extract<AnchorTransferCommit, { mode: "planned" }>;
            ref?: never;
            abort?: never;
          }
        | { state: "aborted"; abort: AnchorTransferAbort; ref?: never; commit?: never }
      ))
    | {
        status: "range";
        requestId: string;
        transferId: string;
        ref: ArtifactRef;
        offset: number;
        data: string;
      }
    | {
        status: "rejected";
        requestId: string;
        transferId: string;
        error: {
          code:
            | "unauthorized"
            | "invalid"
            | "not-found"
            | "conflict"
            | "unavailable"
            | "not-ready"
            | "committed";
          retryable: boolean;
        };
      }
  );

export interface ConversationTransferCommit
  extends WireSchemaV1<"ConversationTransferCommit"> {
  transferId: string;
  conversationId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  freezeProofDigest: Digest;
  checkpointDigest: Digest;
  sourceOwnerEpoch: number;
  nextOwnerEpoch: number;
  signature: Signature;
  at: IsoTime;
}

export interface ConversationTransferStreamRange {
  stream: string;
  firstLsn: number;
  lastLsn: number;
  recordCount: number;
  digest: Digest;
}

export interface ConversationTransferAuthorityBase {
  checkpoint: {
    logId: string;
    lsn: number;
    frameEndOffset: number;
    prefixDigest: Digest;
  };
  records: ArtifactRef;
  sessionState: ArtifactRef;
  reducerVersion: string;
}

/** Canonical, content-addressed description of one frozen conversation domain. */
export interface ConversationTransferManifest
  extends WireSchemaV1<"ConversationTransferManifest"> {
  requestId: string;
  transferId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  conversationId: string;
  sourceOwnerEpoch: number;
  nextOwnerEpoch: number;
  lastLsn: number;
  authorityBase: ConversationTransferAuthorityBase;
  streams: ConversationTransferStreamRange[];
  contentAssets: ArtifactRef[];
}

export interface ConversationTransferAbort
  extends WireSchemaV1<"ConversationTransferAbort"> {
  requestId: string;
  transferId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  conversationId: string;
  sourceOwnerEpoch: number;
  reason: "source-resumed" | "target-rejected" | "operator-cancelled";
  at: IsoTime;
  signature: Signature;
}

export type ConversationTransferCommand =
  WireSchemaV1<"ConversationTransferCommand"> &
    (
      | {
          op: "prepare";
          requestId: string;
          transferId: string;
          sourceDeviceId: string;
          targetDeviceId: string;
          conversationId: string;
          sourceOwnerEpoch: number;
          nextOwnerEpoch: number;
          signature: Signature;
        }
      | {
          op: "freeze";
          requestId: string;
          transferId: string;
          manifest: ArtifactRef;
          proof: SourceFreezeProof;
          signature: Signature;
        }
      | {
          op: "probe";
          requestId: string;
          transferId: string;
          ref: ArtifactRef;
          signature: Signature;
        }
      | {
          op: "read-range";
          requestId: string;
          transferId: string;
          ref: ArtifactRef;
          offset: number;
          length: number;
          signature: Signature;
        }
      | {
          op: "import";
          requestId: string;
          transferId: string;
          manifest: ArtifactRef;
          signature: Signature;
        }
      | {
          op: "commit";
          requestId: string;
          transferId: string;
          commit: ConversationTransferCommit;
          signature: Signature;
        }
      | {
          op: "abort";
          requestId: string;
          transferId: string;
          abort: ConversationTransferAbort;
          signature: Signature;
        }
      | {
          op: "status";
          requestId: string;
          transferId: string;
          signature: Signature;
        }
    );

export type ConversationTransferResult =
  WireSchemaV1<"ConversationTransferResult"> &
    (
      | ({
          status: "ok";
          requestId: string;
          transferId: string;
          data?: never;
          error?: never;
        } &
          (
            | {
                state: "prepared";
                ref?: never;
                commit?: never;
                abort?: never;
              }
            | {
                state: "frozen" | "imported";
                ref: ArtifactRef;
                commit?: never;
                abort?: never;
              }
            | {
                state: "committed" | "tombstoned";
                commit: ConversationTransferCommit;
                ref?: never;
                abort?: never;
              }
            | {
                state: "aborted";
                abort: ConversationTransferAbort;
                ref?: never;
                commit?: never;
              }
          ))
      | {
          status: "range";
          requestId: string;
          transferId: string;
          ref: ArtifactRef;
          offset: number;
          data: string;
          state?: never;
          abort?: never;
          error?: never;
        }
      | {
          status: "rejected";
          requestId: string;
          transferId: string;
          error: {
            code:
              | "unauthorized"
              | "invalid"
              | "not-found"
              | "conflict"
              | "unavailable";
            retryable: boolean;
          };
          state?: never;
          ref?: never;
          data?: never;
          abort?: never;
        }
    );

export interface PairingOffer extends WireSchemaV1<"PairingOffer"> {
  offerId: Ulid;
  homeId: Ulid;
  protocolVersion: ProtocolVersion;
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

export type PairingStreamRecord =
  | {
      t: "pairing-attempt-started";
      offerId: Ulid;
      offerDigest: Digest;
      attemptId: Ulid;
      ordinal: number;
      at: IsoTime;
      retryNotBefore: IsoTime;
    }
  | {
      t: "pairing-attempt-failed";
      offerId: Ulid;
      attemptId: Ulid;
    }
  | {
      t: "pairing-attempt-succeeded";
      offerId: Ulid;
      attemptId: Ulid;
      offerDigest: Digest;
      acceptance: PairingAcceptance;
      trustEventDigest: Digest;
    };

export type RecoveryActivationPlan = WireSchemaV1<"RecoveryActivationPlan"> &
  (
    | {
        kind: "establish";
        rootEvent: HomeTrustEventWithBody<
          Extract<HomeTrustEventBody, { t: "recovery-root"; op: "establish" }>
        >;
      }
    | {
        kind: "rotate";
        rootEvent: HomeTrustEventWithBody<
          Extract<HomeTrustEventBody, { t: "recovery-root"; op: "rotate" }>
        >;
      }
    | {
        kind: "domain-reset-establish";
        resetEvent: HomeTrustEventWithBody<Extract<HomeTrustEventBody, { t: "domain-reset" }>>;
        rootEvent: HomeTrustEventWithBody<
          Extract<HomeTrustEventBody, { t: "recovery-root"; op: "establish" }>
        >;
      }
  );

export type RecoveryCheckpointPurpose =
  | { kind: "periodic" }
  | { kind: "root-activation"; activationDigest: Digest };

export type FullAuthorityCheckpointCoverage =
  | "global-authority"
  | "conversation-authority"
  | "conversation-content"
  | "execution-assets";

export interface FullAuthorityCheckpointPayload
  extends WireSchemaV1<"FullAuthorityCheckpointPayload"> {
  checkpointId: Ulid;
  createdAt: IsoTime;
  homeId: Ulid;
  issuer: { deviceId: string; keyId: string };
  recipientKeyId: string;
  purpose:
    | { kind: "periodic" }
    | { kind: "root-activation"; plan: RecoveryActivationPlan };
  source: {
    logId: string;
    lsn: number;
    frameEndOffset: number;
    prefixDigest: Digest;
  };
  trustChainHead: { seq: number; eventDigest: Digest };
  coverage: {
    version: 1;
    classes: readonly FullAuthorityCheckpointCoverage[];
  };
  records: {
    pages: readonly {
      seq: number;
      firstLsn: number;
      lastLsn: number;
      recordCount: number;
      bytes: number;
      digest: Digest;
    }[];
    count: number;
    bytes: number;
    digest: Digest;
  };
  retainedArtifacts: {
    entries: readonly ArtifactRef[];
    count: number;
    bytes: number;
    digest: Digest;
  };
}

export interface RecoveryCheckpointVerification
  extends WireSchemaV1<"RecoveryCheckpointVerification"> {
  checkpointId: Ulid;
  recipientKeyId: string;
  targetId: string;
  purpose: RecoveryCheckpointPurpose;
  envelopeDigest: Digest;
  nonceDigest: Digest;
  verifiedAt: IsoTime;
  signature: Signature;
}

export interface RecoveryCheckpointGeneration {
  rootKeyId: string;
  recipientKeyId: string;
  trustChainHead: { seq: number; eventDigest: Digest };
  targetId: string;
}

export type RecoveryCheckpointRequest =
  | { kind: "daily"; day: string }
  | { kind: "forced"; requestId: string };

export interface RecoveryCheckpointSource {
  logId: string;
  lsn: number;
  frameEndOffset: number;
  prefixDigest: Digest;
}

export type CheckpointStreamRecord =
  | {
      t: "checkpoint-created";
      checkpointId: Ulid;
      recipientKeyId: string;
      purpose: RecoveryCheckpointPurpose;
      envelopeRef: ArtifactRef;
      upToLsn: number;
      envelopeDigest: Digest;
      /** Full checkpoints bind their durable destination; legacy S2 records omit it. */
      targetId?: string;
      /** Current full checkpoints bind one exact root/chain/target generation and source prefix. */
      generation?: RecoveryCheckpointGeneration;
      request?: RecoveryCheckpointRequest;
      source?: RecoveryCheckpointSource;
    }
  | {
      t: "checkpoint-replicated";
      checkpointId: Ulid;
      recipientKeyId: string;
      purpose: RecoveryCheckpointPurpose;
      targetId: string;
      envelopeDigest: Digest;
      at: IsoTime;
    }
  | {
      t: "checkpoint-verified";
      checkpointId: Ulid;
      recipientKeyId: string;
      purpose: RecoveryCheckpointPurpose;
      targetId: string;
      envelopeDigest: Digest;
      verification: RecoveryCheckpointVerification;
    }
  | {
      t: "checkpoint-verify-failed";
      checkpointId: Ulid;
      recipientKeyId: string;
      purpose: RecoveryCheckpointPurpose;
      targetId: string;
      envelopeDigest: Digest;
      reason: string;
      at: IsoTime;
    }
  | {
      t: "checkpoint-superseded";
      checkpointId: Ulid;
      supersededBy: Ulid;
      at: IsoTime;
    }
  | {
      t: "checkpoint-cleanup-progress";
      checkpointId: Ulid;
      supersededBy: Ulid;
      targetId: string;
      /** `local-released` is accepted only when replaying historical logs. */
      phase: "target-retired" | "local-released";
      at: IsoTime;
    };

export interface CheckpointEnvelope extends WireSchemaV1<"CheckpointEnvelope"> {
  checkpointId: Ulid;
  createdAt: IsoTime;
  alg: {
    kem: "X25519-HKDF-SHA256";
    aead: "AES-256-GCM";
  };
  recipientKeyId: string;
  enc: string;
  wrappedDek: string;
  nonceBase: string;
  manifest: {
    scope: string[];
    domainRevisions: Record<string, number>;
    upToLsn: number;
    purpose:
      | { kind: "periodic" }
      | { kind: "root-activation"; plan: RecoveryActivationPlan };
  };
  chunks: Array<{ seq: number; digest: Digest; bytes: number }>;
  digest: Digest;
  signature: Signature;
}

export type SecretRef = {
  kind: "provider" | "channel" | "mcp" | "device-key" | "webhook" | "rendezvous";
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
