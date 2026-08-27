import { describe, expect, it } from "vitest";
import {
  createSignedTrustRuleSnapshot,
  jobDeliveryPlanDigest,
  protocolDigest,
  type ExecutorCapabilitySnapshot,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { AssignmentResourceLease, Signature } from "@zhixing/core/contracts";
import {
  ManifestSelectionError,
  ConversationAssignmentAuthority,
  type ConversationAssignmentIssueInput,
  type ConversationAssignmentCredentialPolicy,
} from "../conversation-assignment-authority.js";
import { JobAssignmentAuthority } from "../job-assignment-authority.js";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device:test-owner",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier = {
  verify(schemaId: string, version: number, payload: unknown, signature: Signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

function policy(revision: number): ConversationAssignmentCredentialPolicy {
  return {
    credentialTtlMs: 60_000,
    manifestRequires: {
      runtimeConfigRev: revision,
      modelProfileRev: revision,
      policyRev: revision,
      skillsRev: revision,
      rubricsRev: revision,
      promptAssetsRev: revision,
    },
    manifestCapabilities: {
      protocolVersion: "1",
      tools: [],
      mcpServers: [],
      credentialBindings: [],
    },
    permissionSnapshot: createSignedTrustRuleSnapshot({
      snapshotVersion: revision,
      rules: [],
      generatedAt: "2026-07-18T00:00:00.000Z",
    }, signer),
    budget: { maxCalls: revision * 10, maxTokens: revision * 1_000 },
  };
}

function snapshotFor(revision: number) {
  return (executorId: string): ExecutorCapabilitySnapshot | undefined => {
    if (executorId !== "executor:local") return undefined;
    const signature = { alg: "test", keyId: "test", sig: "test" };
    return {
      descriptor: {
        v: 1,
        executorId,
        revision: 1,
        protocolVersion: "1",
        workspaces: [],
        tools: [],
        mcpServers: [],
        credentialBindings: [],
        evidenceCapabilities: [],
        at: "2026-07-18T00:00:00.000Z",
        signature,
      },
      inventory: {
        v: 1,
        executorId,
        inventoryRevision: revision,
        capabilityRevision: 1,
        configVersions: {
          runtimeConfigRev: revision,
          modelProfileRev: revision,
          policyRev: revision,
        },
        assetVersions: {
          skillsRev: revision,
          rubricsRev: revision,
          promptAssetsRev: revision,
        },
        permissionSnapshotHighWater: revision,
        credentialBindingRevisions: [],
        at: "2026-07-18T00:00:00.000Z",
        signature,
      },
    };
  };
}

function issueInput(
  admissionClass: AssignmentResourceLease["admissionClass"],
  credentialPolicy = policy(3),
  identity: { readonly assignmentId?: string; readonly attempt?: number } = {},
): ConversationAssignmentIssueInput {
  const assignmentId = identity.assignmentId ?? "assignment-1";
  const attempt = identity.attempt ?? 1;
  return {
    runId: "run-1",
    assignmentId,
    executorId: "executor:local",
    conversationId: "conversation-1",
    ownerEpoch: 7,
    baseRevision: 3,
    attempt,
    resourceLease: assignmentResourceLease({
      assignmentId,
      attempt,
      admissionClass,
      budget: credentialPolicy.budget,
    }),
    ingress: {
      kind: "first-party",
      surfacePrincipal: "rpc:owner",
      deviceId: "device:test-owner",
      ingressId: "turn-1",
      receivedAt: "2026-07-18T00:00:00.000Z",
    },
    contentAssets: [],
    windowInput: { t: "full", windowEpoch: 4, messages: [] },
    policy: credentialPolicy,
  };
}

describe("ConversationAssignmentAuthority", () => {
  it.each(["interactive", "advancement", "scheduler"] as const)(
    "freezes the trusted %s admission class and versioned policy snapshot",
    (admissionClass) => {
      const frozen = policy(3);
      const issuer = new ConversationAssignmentAuthority({
        signer,
        verifier,
        snapshotFor: snapshotFor(3),
        clock: () => "2026-07-18T00:00:00.000Z",
      });
      const envelope = issuer.issue(issueInput(admissionClass, frozen));
      (frozen.manifestRequires as { policyRev: number }).policyRev = 99;
      (frozen.permissionSnapshot as { snapshotVersion: number }).snapshotVersion = 99;

      expect(envelope.resourceLease.admissionClass).toBe(admissionClass);
      expect(envelope.manifest.requires.policyRev).toBe(3);
      expect(envelope.permissionLease.snapshotVersion).toBe(3);
      expect(envelope.resourceLease.budget).toEqual({
        maxCalls: 30,
        maxTokens: 3_000,
      });
      expect(envelope.permissionLease.expiry).toBe("2026-07-18T00:01:00.000Z");
      expect(envelope.resourceLease.expiry).toBe("2026-07-18T00:01:00.000Z");
      expect(envelope.capabilities[0]?.expiry).toBe("2026-07-18T00:01:00.000Z");
      expect(envelope.capabilities[0]?.resources).toEqual([
        "conversation:conversation-1",
      ]);
    },
  );

  it("changes only newly issued credentials when the authority policy advances", () => {
    const first = new ConversationAssignmentAuthority({
      signer,
      verifier,
      snapshotFor: snapshotFor(1),
      clock: () => "2026-07-18T00:00:00.000Z",
    }).issue(issueInput("interactive", policy(1)));
    const second = new ConversationAssignmentAuthority({
      signer,
      verifier,
      snapshotFor: snapshotFor(2),
      clock: () => "2026-07-18T00:00:00.000Z",
    }).issue({
      ...issueInput("interactive", policy(2), {
        assignmentId: "assignment-2",
        attempt: 2,
      }),
    });

    expect(first.manifest.requires.policyRev).toBe(1);
    expect(first.permissionLease.snapshotVersion).toBe(1);
    expect(second.manifest.requires.policyRev).toBe(2);
    expect(second.permissionLease.snapshotVersion).toBe(2);
  });

  it("rejects an incompatible target before issuing assignment credentials", () => {
    let signatureCount = 0;
    const issuer = new ConversationAssignmentAuthority({
      signer: {
        sign(schemaId, version, payload) {
          signatureCount += 1;
          return signer.sign(schemaId, version, payload);
        },
      },
      verifier,
      snapshotFor: snapshotFor(2),
      clock: () => "2026-07-18T00:00:00.000Z",
    });

    expect(() => issuer.issue(issueInput("interactive", policy(3)))).toThrow(
      ManifestSelectionError,
    );
    expect(signatureCount).toBe(0);
  });

  it("rejects a credential policy that exceeds the permission lease TTL", () => {
    const issuer = new ConversationAssignmentAuthority({
      signer,
      verifier,
      snapshotFor: snapshotFor(3),
      clock: () => "2026-07-18T00:00:00.000Z",
    });
    const oversized = {
      ...policy(3),
      credentialTtlMs: 24 * 60 * 60 * 1_000 + 1,
    };

    expect(() => issuer.issue(issueInput("interactive", oversized))).toThrow(
      "Conversation assignment credential policy is invalid",
    );
  });

  it("issues a job capability for only the owning task resource", () => {
    const credentialPolicy = policy(3);
    const delivery = { kind: "none" as const };
    const envelope = new JobAssignmentAuthority({
      signer,
      verifier,
      snapshotFor: snapshotFor(3),
      clock: () => "2026-07-18T00:00:00.000Z",
    }).issue({
      assignmentId: "job-assignment-1",
      executorId: "executor:local",
      anchorEpoch: 7,
      attempt: 1,
      occurrence: {
        taskId: "task-1",
        jobRunId: "job-run-1",
        scheduledFor: "2026-07-18T00:00:00.000Z",
        taskRevision: 1,
        deliveryPlan: {
          delivery,
          planDigest: jobDeliveryPlanDigest(delivery),
        },
        state: "queued",
      },
      definition: {
        taskId: "task-1",
        taskRevision: 1,
        state: "enabled",
        definition: {
          kind: "user",
          spec: {
            name: "Daily review",
            enabled: true,
            priority: "normal",
            schedule: { kind: "interval", everyMs: 60_000 },
            action: { kind: "agent-turn", prompt: "review" },
          },
        },
      },
      instruction: { kind: "agent-turn", prompt: "review" },
      environment: {},
      resourceLease: jobAssignmentResourceLease(credentialPolicy),
      policy: credentialPolicy,
    });

    expect(envelope.capabilities[0]?.resources).toEqual(["task:task-1"]);
  });
});

function assignmentResourceLease(input: {
  readonly assignmentId: string;
  readonly attempt: number;
  readonly admissionClass: AssignmentResourceLease["admissionClass"];
  readonly budget: AssignmentResourceLease["budget"];
}): AssignmentResourceLease<"conversation"> {
  const payload = {
    v: 1 as const,
    reservationId: `reservation:${input.assignmentId}`,
    admissionClass: input.admissionClass,
    workload: { kind: "run" as const, id: "run-1", attempt: input.attempt },
    scopeBinding: {
      kind: "conversation" as const,
      conversationId: "conversation-1",
      ownerEpoch: 7,
    },
    audience: { executorId: "executor:local" },
    budget: { ...input.budget },
    domain: { kind: "anchor" as const, anchorEpoch: 1 },
    delegation: {
      executorId: "executor:local",
      maxDepth: 1,
      maxBudget: { ...input.budget },
    },
    activation: { kind: "assignment" as const, assignmentId: input.assignmentId },
    issuedAt: "2026-07-18T00:00:00.000Z",
    expiry: "2026-07-18T00:01:00.000Z",
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: signer.sign("ResourceLease", 1, withDigest),
  };
}

function jobAssignmentResourceLease(
  credentialPolicy: ConversationAssignmentCredentialPolicy,
): AssignmentResourceLease<"job"> {
  const payload = {
    v: 1 as const,
    reservationId: "reservation:job-assignment-1",
    admissionClass: "scheduler" as const,
    workload: { kind: "job" as const, id: "job-run-1", attempt: 1 },
    scopeBinding: { kind: "job" as const, taskId: "task-1", anchorEpoch: 7 },
    audience: { executorId: "executor:local" },
    budget: { ...credentialPolicy.budget },
    domain: { kind: "anchor" as const, anchorEpoch: 7 },
    delegation: {
      executorId: "executor:local",
      maxDepth: 1,
      maxBudget: { ...credentialPolicy.budget },
    },
    activation: {
      kind: "assignment" as const,
      assignmentId: "job-assignment-1",
    },
    issuedAt: "2026-07-18T00:00:00.000Z",
    expiry: "2026-07-18T00:01:00.000Z",
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: signer.sign("ResourceLease", 1, withDigest),
  };
}
