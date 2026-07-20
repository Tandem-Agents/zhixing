import type {
  AdmissionClass,
  AuthorityError,
  AuthorityCapability,
  ControlLease,
  IngressContext,
  PermissionSnapshotLease,
  TrustRuleSnapshot,
} from "@zhixing/core/contracts";
import {
  ASSIGNMENT_SUBMISSION_METHODS,
  MAX_CONTROL_LEASE_TTL_MS,
  MAX_PERMISSION_LEASE_TTL_MS,
  createExecutionManifest,
  matchManifest,
  protocolDigest,
  validateTrustRuleSnapshot,
  type ExecutorCapabilitySnapshot,
  type ProtocolSignatureVerifier,
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
  readonly policy: TransitionConversationCredentialPolicy;
}

/** Stable issuance port replaced by the governed authority without changing wire contracts. */
export interface ConversationAssignmentIssuer {
  issue(input: ConversationAssignmentIssueInput): UnsignedConversationEnvelope;
}

export interface TransitionConversationAssignmentIssuerOptions {
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly localDomainId: string;
  readonly snapshotFor: (
    executorId: string,
  ) => ExecutorCapabilitySnapshot | undefined;
  readonly clock?: () => string;
}

export class ManifestSelectionError extends Error {
  readonly authorityError: AuthorityError;

  constructor(error: AuthorityError) {
    super(`Executor manifest mismatch (${error.code}): ${error.message}`);
    this.name = "ManifestSelectionError";
    this.authorityError = structuredClone(error);
  }
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
  };
  readonly manifestCapabilities: {
    readonly protocolVersion: string;
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
    readonly credentialBindings: readonly {
      readonly service: string;
      readonly bindingId: string;
      readonly revision: number;
    }[];
  };
  readonly permissionSnapshot: TrustRuleSnapshot;
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
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #localDomainId: string;
  readonly #snapshotFor: TransitionConversationAssignmentIssuerOptions["snapshotFor"];
  readonly #clock: () => string;

  constructor(options: TransitionConversationAssignmentIssuerOptions) {
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#localDomainId = requireIdentifier(
      options.localDomainId,
      "Local resource domain id",
    );
    this.#snapshotFor = options.snapshotFor;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  issue(input: ConversationAssignmentIssueInput): UnsignedConversationEnvelope {
    const policy = validateTransitionPolicy(input.policy, this.#verifier);
    if (
      !Number.isSafeInteger(input.attempt) || input.attempt <= 0
    ) {
      throw new TypeError("Assignment attempt must be a positive safe integer");
    }
    const issuedAt = canonicalTime(this.#clock(), "Credential issue time");
    const expiry = new Date(
      Date.parse(issuedAt) + policy.credentialTtlMs,
    ).toISOString();
    const target = this.#snapshotFor(input.executorId);
    if (!target) {
      throw new ManifestSelectionError({
        code: "capability-gap",
        message: "Executor capability snapshot is unavailable",
        retryable: true,
      });
    }
    const manifest = createExecutionManifest({
      baseRef: {
        execution: "conversation" as const,
        conversationId: input.conversationId,
        baseRevision: input.baseRevision,
      },
      protocolVersion: policy.manifestCapabilities.protocolVersion,
      requires: {
        ...policy.manifestRequires,
        permissionSnapshotVersion: policy.permissionSnapshot.snapshotVersion,
      },
      tools: [...policy.manifestCapabilities.tools],
      mcpServers: [...policy.manifestCapabilities.mcpServers],
      environment: {
        credentialBindings: policy.manifestCapabilities.credentialBindings.map(
          ({ service, bindingId }) => ({ service, bindingId }),
        ),
      },
      credentialBindings: policy.manifestCapabilities.credentialBindings.map(
        (binding) => ({ ...binding }),
      ),
    });
    const compatibility = matchManifest(
      manifest,
      target.descriptor,
      target.inventory,
    );
    if (!compatibility.ok) {
      throw new ManifestSelectionError(compatibility.error);
    }

    const permissionPayload = {
      v: 1 as const,
      snapshotVersion: policy.permissionSnapshot.snapshotVersion,
      snapshotDigest: policy.permissionSnapshot.digest,
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

    const renewalIntervalMs = Math.floor(MAX_CONTROL_LEASE_TTL_MS / 3);
    const renewalSeq = Math.floor(Date.parse(issuedAt) / renewalIntervalMs);
    const controlIssuedAt = new Date(
      renewalSeq * renewalIntervalMs,
    ).toISOString();
    const controlExpiry = new Date(
      renewalSeq * renewalIntervalMs + MAX_CONTROL_LEASE_TTL_MS,
    ).toISOString();
    const controlPayload = {
      v: 1 as const,
      controlLeaseId: `control-${input.assignmentId}`,
      assignmentId: input.assignmentId,
      authority: {
        execution: "conversation" as const,
        conversationId: input.conversationId,
        ownerEpoch: input.ownerEpoch,
      },
      renewalSeq,
      issuedAt: controlIssuedAt,
      expiry: controlExpiry,
    };
    const controlLease: ControlLease = {
      ...controlPayload,
      signature: this.#signer.sign("ControlLease", 1, controlPayload),
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
      methods: [...ASSIGNMENT_SUBMISSION_METHODS],
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
      budget: { ...policy.budget },
      domain: {
        kind: "local" as const,
        localDomainId: this.#localDomainId,
        localGovernorEpoch: policy.localGovernorEpoch,
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
      controlLease,
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

function validateTransitionPolicy(
  input: TransitionConversationCredentialPolicy,
  verifier: ProtocolSignatureVerifier,
): TransitionConversationCredentialPolicy {
  const policy = structuredClone(input);
  if (
    !Number.isSafeInteger(policy.credentialTtlMs) ||
    policy.credentialTtlMs <= 0 ||
    policy.credentialTtlMs > MAX_PERMISSION_LEASE_TTL_MS ||
    !Number.isSafeInteger(policy.budget.maxCalls) ||
    policy.budget.maxCalls <= 0 ||
    !Number.isSafeInteger(policy.budget.maxTokens) ||
    policy.budget.maxTokens <= 0 ||
    !Number.isSafeInteger(policy.localGovernorEpoch) ||
    policy.localGovernorEpoch <= 0
  ) {
    throw new TypeError("Transition credential policy is invalid");
  }
  for (const revision of Object.values(policy.manifestRequires)) {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new TypeError("Transition manifest revisions must be positive integers");
    }
  }
  return {
    ...policy,
    permissionSnapshot: validateTrustRuleSnapshot(
      policy.permissionSnapshot,
      verifier,
    ),
  };
}
