import { describe, expect, it } from "vitest";
import {
  createSignedTrustRuleSnapshot,
  protocolDigest,
  type ExecutorCapabilitySnapshot,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { Signature } from "@zhixing/core/contracts";
import {
  ManifestSelectionError,
  TransitionConversationAssignmentIssuer,
  type ConversationAssignmentIssueInput,
  type TransitionConversationCredentialPolicy,
} from "../conversation-transition-authority.js";

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

function policy(revision: number): TransitionConversationCredentialPolicy {
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
    localGovernorEpoch: revision,
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
  admissionClass: ConversationAssignmentIssueInput["admissionClass"],
  credentialPolicy = policy(3),
): ConversationAssignmentIssueInput {
  return {
    runId: "run-1",
    assignmentId: "assignment-1",
    executorId: "executor:local",
    conversationId: "conversation-1",
    ownerEpoch: 7,
    baseRevision: 3,
    attempt: 1,
    admissionClass,
    ingress: {
      kind: "first-party",
      surfacePrincipal: "rpc:owner",
      deviceId: "device:test-owner",
      ingressId: "turn-1",
      receivedAt: "2026-07-18T00:00:00.000Z",
    },
    windowInput: { t: "full", windowEpoch: 4, messages: [] },
    policy: credentialPolicy,
  };
}

describe("TransitionConversationAssignmentIssuer", () => {
  it.each(["interactive", "advancement", "scheduler"] as const)(
    "freezes the trusted %s admission class and versioned policy snapshot",
    (admissionClass) => {
      const frozen = policy(3);
      const issuer = new TransitionConversationAssignmentIssuer({
        signer,
        verifier,
        localDomainId: "local:device-test",
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
    },
  );

  it("changes only newly issued credentials when the authority policy advances", () => {
    const first = new TransitionConversationAssignmentIssuer({
      signer,
      verifier,
      localDomainId: "local:device-test",
      snapshotFor: snapshotFor(1),
      clock: () => "2026-07-18T00:00:00.000Z",
    }).issue(issueInput("interactive", policy(1)));
    const second = new TransitionConversationAssignmentIssuer({
      signer,
      verifier,
      localDomainId: "local:device-test",
      snapshotFor: snapshotFor(2),
      clock: () => "2026-07-18T00:00:00.000Z",
    }).issue({
      ...issueInput("interactive", policy(2)),
      assignmentId: "assignment-2",
      attempt: 2,
    });

    expect(first.manifest.requires.policyRev).toBe(1);
    expect(first.permissionLease.snapshotVersion).toBe(1);
    expect(second.manifest.requires.policyRev).toBe(2);
    expect(second.permissionLease.snapshotVersion).toBe(2);
  });

  it("rejects an incompatible target before issuing assignment credentials", () => {
    let signatureCount = 0;
    const issuer = new TransitionConversationAssignmentIssuer({
      signer: {
        sign(schemaId, version, payload) {
          signatureCount += 1;
          return signer.sign(schemaId, version, payload);
        },
      },
      verifier,
      localDomainId: "local:device-test",
      snapshotFor: snapshotFor(2),
      clock: () => "2026-07-18T00:00:00.000Z",
    });

    expect(() => issuer.issue(issueInput("interactive", policy(3)))).toThrow(
      ManifestSelectionError,
    );
    expect(signatureCount).toBe(0);
  });

  it("rejects a credential policy that exceeds the permission lease TTL", () => {
    const issuer = new TransitionConversationAssignmentIssuer({
      signer,
      verifier,
      localDomainId: "local:device-test",
      snapshotFor: snapshotFor(3),
      clock: () => "2026-07-18T00:00:00.000Z",
    });
    const oversized = {
      ...policy(3),
      credentialTtlMs: 24 * 60 * 60 * 1_000 + 1,
    };

    expect(() => issuer.issue(issueInput("interactive", oversized))).toThrow(
      "Transition credential policy is invalid",
    );
  });
});
