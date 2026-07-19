import { describe, expect, it } from "vitest";
import { protocolDigest, type ProtocolSigner } from "@zhixing/core/protocol";
import type { Signature } from "@zhixing/core/contracts";
import {
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
      permissionSnapshotVersion: revision,
    },
    permissionSnapshot: {
      version: revision,
      digest: protocolDigest("TrustRuleSnapshot", 1, { revision }),
    },
    budget: { maxCalls: revision * 10, maxTokens: revision * 1_000 },
    localGovernorEpoch: revision,
  };
}

function issueInput(
  admissionClass: ConversationAssignmentIssueInput["admissionClass"],
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
  };
}

describe("TransitionConversationAssignmentIssuer", () => {
  it.each(["interactive", "advancement", "scheduler"] as const)(
    "freezes the trusted %s admission class and versioned policy snapshot",
    (admissionClass) => {
      const frozen = policy(3);
      const issuer = new TransitionConversationAssignmentIssuer({
        signer,
        localDomainId: "local:device-test",
        clock: () => "2026-07-18T00:00:00.000Z",
        policy: frozen,
      });
      frozen.manifestRequires.policyRev = 99;
      frozen.permissionSnapshot.version = 99;

      const envelope = issuer.issue(issueInput(admissionClass));

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
    const input = issueInput("interactive");
    const first = new TransitionConversationAssignmentIssuer({
      signer,
      localDomainId: "local:device-test",
      clock: () => "2026-07-18T00:00:00.000Z",
      policy: policy(1),
    }).issue(input);
    const second = new TransitionConversationAssignmentIssuer({
      signer,
      localDomainId: "local:device-test",
      clock: () => "2026-07-18T00:00:00.000Z",
      policy: policy(2),
    }).issue({ ...input, assignmentId: "assignment-2", attempt: 2 });

    expect(first.manifest.requires.policyRev).toBe(1);
    expect(first.permissionLease.snapshotVersion).toBe(1);
    expect(second.manifest.requires.policyRev).toBe(2);
    expect(second.permissionLease.snapshotVersion).toBe(2);
  });
});
