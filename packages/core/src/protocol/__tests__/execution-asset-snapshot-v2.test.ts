import { describe, expect, it } from "vitest";
import type { Signature, WireSchemaVersion } from "../../contracts/index.js";
import {
  createSignedExecutionAssetSnapshotV2,
  protocolDigest,
  validateExecutionAssetSnapshotV2,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "../index.js";

const NOW = "2026-11-26T12:00:00.000Z";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "anchor-test",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.sig !== signer.sign(schemaId, version, payload).sig) {
      throw new TypeError("Signature mismatch");
    }
  },
};

describe("ExecutionAssetSnapshotV2 protocol", () => {
  it("registers v: 2 schema, preserves skill visibility & packageRef, and rejects tampering", () => {
    const schemaVersion: WireSchemaVersion["ExecutionAssetSnapshotV2"] = 2;
    expect(schemaVersion).toBe(2);

    const contentRef = { digest: `sha256:${"a".repeat(64)}`, bytes: 32 };
    const packageRef = { digest: `sha256:${"b".repeat(64)}`, bytes: 4096 };
    const baseEntry = {
      id: "large-multi-skill",
      name: "Large Multi Skill",
      description: "Multi-file skill package",
      source: "own" as const,
      mode: "work" as const,
      pinned: false,
      disabled: false,
      createdAt: NOW,
      usage: null,
      contentRef,
      revision: 3,
      visibility: { modelAutoIndex: false, userSlashCommand: true },
      packageRef,
    };
    const entryDigest = protocolDigest("SkillCatalogEntry", 2, baseEntry);

    const signed = createSignedExecutionAssetSnapshotV2(
      {
        snapshotRevision: 2,
        skillCatalogRevision: 4,
        skills: [
          {
            ...baseEntry,
            digest: entryDigest,
          },
        ],
        rubrics: [
          {
            id: "rubric-1",
            kind: "rubrics",
            revision: 1,
            digest: `sha256:${"c".repeat(64)}`,
          },
        ],
        promptAssets: [],
        generatedAt: NOW,
      },
      signer,
    );

    expect(signed.v).toBe(2);
    const validated = validateExecutionAssetSnapshotV2(signed, verifier);
    expect(validated.skills).toHaveLength(1);
    expect(validated.skills[0]?.visibility).toEqual({
      modelAutoIndex: false,
      userSlashCommand: true,
    });
    expect(validated.skills[0]?.packageRef).toEqual(packageRef);
    expect(validated.rubrics).toHaveLength(1);

    expect(() =>
      validateExecutionAssetSnapshotV2(
        {
          ...signed,
          snapshotRevision: 3,
        },
        verifier,
      ),
    ).toThrow("Execution asset snapshot digest is invalid");

    expect(() =>
      validateExecutionAssetSnapshotV2(
        {
          ...signed,
          signature: { ...signed.signature, sig: `sha256:${"0".repeat(64)}` },
        },
        verifier,
      ),
    ).toThrow("Signature mismatch");
  });
});
