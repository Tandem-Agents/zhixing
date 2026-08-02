import type {
  AssignmentResourceLease,
  AuthorityCapability,
  ControlLease,
  EnvironmentRequirement,
  JobExecutionInstruction,
  JobOccurrence,
  PermissionSnapshotLease,
  TaskDefinition,
} from "@zhixing/core/contracts";
import {
  MAX_CONTROL_LEASE_TTL_MS,
  MAX_PERMISSION_LEASE_TTL_MS,
  PRINCIPAL_METHODS,
  canonicalize,
  createExecutionManifest,
  createJobCommitFence,
  matchManifest,
  validateJobOccurrence,
  validateReservableResourceLease,
  validateTaskDefinition,
  validateTrustRuleSnapshot,
  type ExecutorCapabilitySnapshot,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type UnsignedJobEnvelope,
} from "@zhixing/core/protocol";
import {
  ManifestSelectionError,
  type ConversationAssignmentCredentialPolicy,
} from "./conversation-assignment-authority.js";

export type JobAssignmentCredentialPolicy = ConversationAssignmentCredentialPolicy;

export interface JobAssignmentIssueInput {
  readonly assignmentId: string;
  readonly executorId: string;
  readonly anchorEpoch: number;
  readonly attempt: number;
  readonly occurrence: JobOccurrence;
  readonly definition: TaskDefinition & {
    readonly definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
  };
  readonly instruction: JobExecutionInstruction;
  readonly environment: EnvironmentRequirement;
  readonly resourceLease: AssignmentResourceLease<"job">;
  readonly policy: JobAssignmentCredentialPolicy;
}

/**
 * The single credential issuer for scheduler-owned user jobs.
 *
 * Selection is completed before any signed credential is materialized.  The
 * returned envelope contains only execution input; delivery and scheduler
 * authority remain frozen in the occurrence and task revision on the anchor.
 */
export class JobAssignmentAuthority {
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #snapshotFor: (executorId: string) => ExecutorCapabilitySnapshot | undefined;
  readonly #clock: () => string;

  constructor(options: {
    readonly signer: ProtocolSigner;
    readonly verifier: ProtocolSignatureVerifier;
    readonly snapshotFor: (
      executorId: string,
    ) => ExecutorCapabilitySnapshot | undefined;
    readonly clock?: () => string;
  }) {
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#snapshotFor = options.snapshotFor;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  issue(input: JobAssignmentIssueInput): UnsignedJobEnvelope {
    const occurrence = validateJobOccurrence(input.occurrence);
    const definition = validateTaskDefinition(input.definition) as JobAssignmentIssueInput["definition"];
    const policy = validatePolicy(input.policy, this.#verifier);
    if (
      occurrence.taskId !== definition.taskId ||
      occurrence.taskRevision !== definition.taskRevision ||
      occurrence.state !== "queued"
    ) {
      throw new TypeError("Job occurrence does not bind the queued task revision");
    }
    if (definition.state !== "enabled") {
      throw new TypeError("Only an enabled user task can issue an assignment");
    }
    if (!Number.isSafeInteger(input.anchorEpoch) || input.anchorEpoch <= 0) {
      throw new TypeError("Job anchor epoch must be a positive safe integer");
    }
    if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) {
      throw new TypeError("Job assignment attempt must be a positive safe integer");
    }

    const issuedAt = canonicalTime(this.#clock(), "Job credential issue time");
    const expiry = new Date(Date.parse(issuedAt) + policy.credentialTtlMs).toISOString();
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
        execution: "job" as const,
        taskId: occurrence.taskId,
        jobRunId: occurrence.jobRunId,
        taskRevision: occurrence.taskRevision,
      },
      protocolVersion: policy.manifestCapabilities.protocolVersion,
      requires: {
        ...policy.manifestRequires,
        permissionSnapshotVersion: policy.permissionSnapshot.snapshotVersion,
      },
      tools: [...policy.manifestCapabilities.tools],
      mcpServers: [...policy.manifestCapabilities.mcpServers],
      environment: structuredClone(input.environment),
      credentialBindings: policy.manifestCapabilities.credentialBindings.map(
        (binding) => ({ ...binding }),
      ),
    });
    const compatibility = matchManifest(
      manifest,
      target.descriptor,
      target.inventory,
    );
    if (!compatibility.ok) throw new ManifestSelectionError(compatibility.error);

    const permissionPayload = {
      v: 1 as const,
      snapshotVersion: policy.permissionSnapshot.snapshotVersion,
      snapshotDigest: policy.permissionSnapshot.digest,
      binding: {
        execution: "job" as const,
        jobRunId: occurrence.jobRunId,
        taskId: occurrence.taskId,
        anchorEpoch: input.anchorEpoch,
      },
      assignmentId: input.assignmentId,
      executorId: input.executorId,
      controlLeaseId: `control-${input.assignmentId}`,
      issuedAt,
      expiry,
    };
    const permissionLease: PermissionSnapshotLease<"job"> = {
      ...permissionPayload,
      signature: this.#signer.sign("PermissionSnapshotLease", 1, permissionPayload),
    };

    const controlLease = this.controlLeaseFor({
      assignmentId: input.assignmentId,
      taskId: occurrence.taskId,
      anchorEpoch: input.anchorEpoch,
      at: issuedAt,
    });

    const capabilityPayload = {
      v: 1 as const,
      capId: `cap-${input.assignmentId}`,
      executorId: input.executorId,
      scope: { execution: "job" as const, taskId: occurrence.taskId },
      anchorEpoch: input.anchorEpoch,
      methods: [...PRINCIPAL_METHODS.assignment],
      resources: [`task:${occurrence.taskId}`] as AuthorityCapability<"job">["resources"],
      assignmentId: input.assignmentId,
      issuedAt,
      expiry,
    };
    const capability: AuthorityCapability<"job"> = {
      ...capabilityPayload,
      signature: this.#signer.sign("AuthorityCapability", 1, capabilityPayload),
    };

    const resourceLease = validateReservableResourceLease(
      input.resourceLease,
      this.#verifier,
    ) as AssignmentResourceLease<"job">;
    if (
      resourceLease.parentId !== undefined ||
      resourceLease.activation.kind !== "assignment" ||
      resourceLease.activation.assignmentId !== input.assignmentId ||
      resourceLease.workload.kind !== "job" ||
      resourceLease.workload.id !== occurrence.jobRunId ||
      resourceLease.workload.attempt !== input.attempt ||
      resourceLease.scopeBinding.kind !== "job" ||
      resourceLease.scopeBinding.taskId !== occurrence.taskId ||
      resourceLease.scopeBinding.anchorEpoch !== input.anchorEpoch ||
      resourceLease.audience.executorId !== input.executorId ||
      canonicalize(resourceLease.budget) !== canonicalize(policy.budget)
    ) {
      throw new TypeError("Resource lease does not bind the job assignment request");
    }

    return {
      v: 1,
      execution: "job",
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
        t: "job",
        jobRunId: occurrence.jobRunId,
        taskId: occurrence.taskId,
        fence: createJobCommitFence({
          taskId: occurrence.taskId,
          jobRunId: occurrence.jobRunId,
          scheduledFor: occurrence.scheduledFor,
          taskRevision: occurrence.taskRevision,
          deliveryPlanDigest: occurrence.deliveryPlan.planDigest,
          anchorEpoch: input.anchorEpoch,
          assignmentId: input.assignmentId,
          executorId: input.executorId,
        }),
        instruction: structuredClone(input.instruction),
      },
    };
  }

  /**
   * Reissues the deterministic lease generation for an existing assignment.
   * Recovery never reuses an expired envelope lease and never changes the
   * assignment, task, or anchor binding.
   */
  controlLeaseFor(input: {
    readonly assignmentId: string;
    readonly taskId: string;
    readonly anchorEpoch: number;
    readonly at?: string;
  }): ControlLease {
    const at = canonicalTime(input.at ?? this.#clock(), "Job control lease time");
    const renewalIntervalMs = Math.floor(MAX_CONTROL_LEASE_TTL_MS / 3);
    const renewalSeq = Math.floor(Date.parse(at) / renewalIntervalMs);
    const issuedAt = new Date(renewalSeq * renewalIntervalMs).toISOString();
    const expiry = new Date(
      renewalSeq * renewalIntervalMs + MAX_CONTROL_LEASE_TTL_MS,
    ).toISOString();
    const payload = {
      v: 1 as const,
      controlLeaseId: `control-${input.assignmentId}`,
      assignmentId: input.assignmentId,
      authority: {
        execution: "job" as const,
        taskId: input.taskId,
        anchorEpoch: input.anchorEpoch,
      },
      renewalSeq,
      issuedAt,
      expiry,
    };
    return {
      ...payload,
      signature: this.#signer.sign("ControlLease", 1, payload),
    };
  }
}

function validatePolicy(
  input: JobAssignmentCredentialPolicy,
  verifier: ProtocolSignatureVerifier,
): JobAssignmentCredentialPolicy {
  const policy = structuredClone(input);
  if (
    !Number.isSafeInteger(policy.credentialTtlMs) ||
    policy.credentialTtlMs <= 0 ||
    policy.credentialTtlMs > MAX_PERMISSION_LEASE_TTL_MS ||
    !Number.isSafeInteger(policy.budget.maxCalls) ||
    policy.budget.maxCalls <= 0 ||
    !Number.isSafeInteger(policy.budget.maxTokens) ||
    policy.budget.maxTokens <= 0
  ) {
    throw new TypeError("Job assignment credential policy is invalid");
  }
  for (const revision of Object.values(policy.manifestRequires)) {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new TypeError("Job assignment manifest revisions must be positive integers");
    }
  }
  return {
    ...policy,
    permissionSnapshot: validateTrustRuleSnapshot(policy.permissionSnapshot, verifier),
  };
}

function canonicalTime(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}
