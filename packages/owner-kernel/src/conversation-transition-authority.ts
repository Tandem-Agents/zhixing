import type {
  AdmissionClass,
  AuthorityCapability,
  IngressContext,
  PermissionSnapshotLease,
} from "@zhixing/core/contracts";
import {
  protocolDigest,
  type ProtocolSigner,
  type UnsignedConversationEnvelope,
} from "@zhixing/core/protocol";

export interface ConversationAssignmentIssueInput {
  readonly runId: string;
  readonly assignmentId: string;
  readonly executorId: string;
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly baseRevision: number;
  readonly attempt: number;
  readonly admissionClass: AdmissionClass;
  readonly ingress: IngressContext;
  readonly windowInput: UnsignedConversationEnvelope["work"]["windowInput"];
  readonly controlContext?: UnsignedConversationEnvelope["work"]["controlContext"];
}

/** Stable issuance port replaced by the governed authority without changing wire contracts. */
export interface ConversationAssignmentIssuer {
  issue(input: ConversationAssignmentIssueInput): UnsignedConversationEnvelope;
}

export interface TransitionConversationAssignmentIssuerOptions {
  readonly signer: ProtocolSigner;
  readonly localDomainId: string;
  readonly clock?: () => string;
  readonly policy: TransitionConversationCredentialPolicy;
}

export interface TransitionConversationCredentialPolicy {
  readonly credentialTtlMs: number;
  readonly manifestRequires: {
    readonly runtimeConfigRev: number;
    readonly modelProfileRev: number;
    readonly policyRev: number;
    readonly skillsRev: number;
    readonly rubricsRev: number;
    readonly promptAssetsRev: number;
    readonly permissionSnapshotVersion: number;
  };
  readonly permissionSnapshot: {
    readonly version: number;
    readonly digest: string;
  };
  readonly budget: {
    readonly maxCalls: number;
    readonly maxTokens: number;
  };
  readonly localGovernorEpoch: number;
}

/**
 * Conservative local issuer used while the formal capability and resource governors are absent.
 * It produces the final signed wire shapes and intentionally owns no alternate authorization path.
 */
export class TransitionConversationAssignmentIssuer
  implements ConversationAssignmentIssuer
{
  readonly #signer: ProtocolSigner;
  readonly #localDomainId: string;
  readonly #clock: () => string;
  readonly #policy: TransitionConversationCredentialPolicy;

  constructor(options: TransitionConversationAssignmentIssuerOptions) {
    this.#signer = options.signer;
    this.#localDomainId = requireIdentifier(
      options.localDomainId,
      "Local resource domain id",
    );
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#policy = structuredClone(options.policy);
    if (
      !Number.isSafeInteger(this.#policy.credentialTtlMs) ||
      this.#policy.credentialTtlMs <= 0 ||
      !Number.isSafeInteger(this.#policy.permissionSnapshot.version) ||
      this.#policy.permissionSnapshot.version <= 0 ||
      !/^sha256:[a-f0-9]{64}$/u.test(this.#policy.permissionSnapshot.digest) ||
      !Number.isSafeInteger(this.#policy.budget.maxCalls) ||
      this.#policy.budget.maxCalls <= 0 ||
      !Number.isSafeInteger(this.#policy.budget.maxTokens) ||
      this.#policy.budget.maxTokens <= 0 ||
      !Number.isSafeInteger(this.#policy.localGovernorEpoch) ||
      this.#policy.localGovernorEpoch <= 0
    ) {
      throw new TypeError("Transition credential policy is invalid");
    }
    for (const revision of Object.values(this.#policy.manifestRequires)) {
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        throw new TypeError("Transition manifest revisions must be positive integers");
      }
    }
  }

  issue(input: ConversationAssignmentIssueInput): UnsignedConversationEnvelope {
    if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) {
      throw new TypeError("Assignment attempt must be a positive safe integer");
    }
    const issuedAt = canonicalTime(this.#clock(), "Credential issue time");
    const expiry = new Date(
      Date.parse(issuedAt) + this.#policy.credentialTtlMs,
    ).toISOString();
    const manifestPayload = {
      v: 1 as const,
      baseRef: {
        execution: "conversation" as const,
        conversationId: input.conversationId,
        baseRevision: input.baseRevision,
      },
      requires: { ...this.#policy.manifestRequires },
      environment: {},
      credentialBindings: [],
    };
    const manifest = {
      ...manifestPayload,
      digest: protocolDigest("ExecutionManifest", 1, manifestPayload),
    };

    const permissionPayload = {
      v: 1 as const,
      snapshotVersion: this.#policy.permissionSnapshot.version,
      snapshotDigest: this.#policy.permissionSnapshot.digest,
      binding: {
        execution: "conversation" as const,
        runId: input.runId,
        conversationId: input.conversationId,
        ownerEpoch: input.ownerEpoch,
      },
      assignmentId: input.assignmentId,
      executorId: input.executorId,
      controlLeaseId: `control-${input.assignmentId}`,
      issuedAt,
      expiry,
    };
    const permissionLease: PermissionSnapshotLease<"conversation"> = {
      ...permissionPayload,
      signature: this.#signer.sign(
        "PermissionSnapshotLease",
        1,
        permissionPayload,
      ),
    };

    const capabilityPayload = {
      v: 1 as const,
      capId: `cap-${input.assignmentId}`,
      executorId: input.executorId,
      scope: {
        execution: "conversation" as const,
        conversationId: input.conversationId,
      },
      ownerEpoch: input.ownerEpoch,
      methods: [
        "submission.mirrorInteractions",
        "submission.reportStarted",
        "submission.submitBundle",
        "submission.submitCancelProof",
      ] as AuthorityCapability<"conversation">["methods"],
      resources: [
        `conversation:${input.conversationId}`,
      ] as AuthorityCapability<"conversation">["resources"],
      assignmentId: input.assignmentId,
      issuedAt,
      expiry,
    };
    const capability: AuthorityCapability<"conversation"> = {
      ...capabilityPayload,
      signature: this.#signer.sign("AuthorityCapability", 1, capabilityPayload),
    };

    const resourcePayload = {
      v: 1 as const,
      reservationId: `reservation-${input.assignmentId}`,
      admissionClass: input.admissionClass,
      workload: { kind: "run" as const, id: input.runId, attempt: input.attempt },
      scopeBinding: {
        kind: "conversation" as const,
        conversationId: input.conversationId,
        ownerEpoch: input.ownerEpoch,
      },
      audience: { executorId: input.executorId },
      budget: { ...this.#policy.budget },
      domain: {
        kind: "local" as const,
        localDomainId: this.#localDomainId,
        localGovernorEpoch: this.#policy.localGovernorEpoch,
      },
      activation: { kind: "assignment" as const, assignmentId: input.assignmentId },
      issuedAt,
      expiry,
    };
    const resourceWithDigest = {
      ...resourcePayload,
      digest: protocolDigest("ResourceLease", 1, resourcePayload),
    };
    const resourceLease = {
      ...resourceWithDigest,
      signature: this.#signer.sign("ResourceLease", 1, resourceWithDigest),
    };

    return {
      v: 1,
      execution: "conversation",
      assignmentId: input.assignmentId,
      executorId: input.executorId,
      manifest,
      permissionLease,
      capabilities: [capability],
      resourceLease,
      dependencyArtifacts: [],
      issuedAt,
      work: {
        t: "conversation",
        runId: input.runId,
        conversationId: input.conversationId,
        ownerEpoch: input.ownerEpoch,
        baseRevision: input.baseRevision,
        ingress: input.ingress,
        windowInput: input.windowInput,
        controlContext: input.controlContext ? [...input.controlContext] : [],
      },
    };
  }
}

function canonicalTime(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (!value || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
