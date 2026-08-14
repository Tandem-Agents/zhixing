import { describe, expect, it } from "vitest";
import { byteDigest, canonicalize, protocolDigest } from "./canonical.js";
import { DURABLE_SCHEMA_INVENTORY } from "./durable-schema.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";
import {
  PROGRAM_ARTIFACT_LIMITS,
  assertProgramArtifactArchiveBytes,
  STABLE_RELEASE_TARGETS,
  assertReleaseAdvance,
  assertStableReleaseBinding,
  createSignedReleaseManifest,
  createSignedStableReleaseIndex,
  compareReleaseSemver,
  decodeProgramArtifact,
  programArtifactStorageBudget,
  validateProgramUpdateReceipt,
  validateReleaseManifest,
  validateStableReleaseIndex,
  type ReleaseManifest,
  type UnsignedReleaseManifest,
} from "./release.js";

const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const signer: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return { alg: "test-digest", keyId: "release-key", sig: protocolDigest(schemaId, version, payload) };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

describe("stable release protocol", () => {
  it("strictly validates a signed manifest and immutable exact target index", () => {
    const manifests = STABLE_RELEASE_TARGETS.map((target) => signedManifest(target));
    const bytes = manifests.map((manifest) => Buffer.from(canonicalize(manifest), "utf8"));
    const index = createSignedStableReleaseIndex({
      v: 1,
      channel: "stable",
      releaseVersion: "1.0.0",
      releaseSequence: "1",
      keyId: "release-key",
      targets: STABLE_RELEASE_TARGETS.map((target, index) => ({
        target,
        manifest: {
          url: `https://release.example/${target}.json`,
          digest: byteDigest(bytes[index]!),
          bytes: bytes[index]!.byteLength,
        },
        artifactUrl: `https://release.example/${target}.tar.zst`,
      })),
    }, signer);
    expect(validateStableReleaseIndex(index, signer)).toEqual(index);
    expect(assertStableReleaseBinding(index, "linux-x64", bytes[3]!, signer)).toEqual(manifests[3]);
    expect(() => validateStableReleaseIndex({ ...index, debug: true }, signer)).toThrow("unknown");
    expect(() => createSignedStableReleaseIndex({
      ...withoutSignature(index),
      targets: withoutSignature(index).targets.slice(0, 4),
    }, signer)).toThrow("exact target set");
    expect(() => createSignedStableReleaseIndex({
      ...withoutSignature(index),
      targets: withoutSignature(index).targets.map((entry, entryIndex) => entryIndex === 0
        ? { ...entry, artifactUrl: "http://release.example/file" }
        : entry),
    }, signer)).toThrow("HTTPS");
  });

  it("rejects signature, canonical-byte and cross-binding drift", () => {
    const manifest = signedManifest("linux-x64");
    expect(() => validateReleaseManifest({ ...manifest, keyId: "other" }, signer)).toThrow("signature key");
    const canonical = Buffer.from(canonicalize(manifest), "utf8");
    const spaced = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const index = createSignedStableReleaseIndex({
      v: 1,
      channel: "stable",
      releaseVersion: "1.0.0",
      releaseSequence: "1",
      keyId: "release-key",
      targets: STABLE_RELEASE_TARGETS.map((target) => ({
        target,
        manifest: { url: `https://release.example/${target}.json`, digest: DIGEST, bytes: 1 },
        artifactUrl: `https://release.example/${target}.tar.zst`,
      })),
    }, signer);
    const bound = { ...index, targets: index.targets.map((entry) => entry.target === "linux-x64"
      ? { ...entry, manifest: { ...entry.manifest, digest: byteDigest(canonical), bytes: canonical.byteLength } }
      : entry) };
    expect(assertStableReleaseBinding(bound, "linux-x64", canonical, signer)).toEqual(manifest);
    expect(() => assertStableReleaseBinding(bound, "linux-x64", spaced, signer)).toThrow("bytes do not match");
  });

  it("requires SemVer and release sequence to advance together while exact replay is idempotent", () => {
    const current = signedManifest("linux-x64");
    expect(assertReleaseAdvance(current, current)).toBe("replay");
    expect(assertReleaseAdvance(current, signedManifest("linux-x64", { releaseVersion: "1.1.0", releaseSequence: "2" }))).toBe("advance");
    expect(() => assertReleaseAdvance(current, signedManifest("linux-x64", { releaseVersion: "1.1.0", releaseSequence: "1" }))).toThrow("strictly advance");
    expect(() => assertReleaseAdvance(current, signedManifest("linux-x64", { releaseVersion: "1.0.0", releaseSequence: "2" }))).toThrow("strictly advance");
  });

  it("uses canonical SemVer 2.0 precedence without numeric precision loss or build ordering", () => {
    expect(compareReleaseSemver("9007199254740993.0.0", "9007199254740992.999999999999999999999.999")).toBeGreaterThan(0);
    expect(compareReleaseSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    expect(compareReleaseSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareReleaseSemver("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareReleaseSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareReleaseSemver("1.0.0+build.1", "1.0.0+build.999")).toBe(0);
    expect(() => validateReleaseManifest(signedManifest("linux-x64", {
      releaseVersion: "1.0.0-alpha.01",
    }))).toThrow("canonical SemVer");
  });

  it("accepts only legal atomic update receipt combinations", () => {
    expect(validateProgramUpdateReceipt({
      v: 1, currentManifestDigest: DIGEST, target: "linux-x64", phase: "idle", notice: "none",
    }).phase).toBe("idle");
    expect(validateProgramUpdateReceipt({
      v: 1, currentManifestDigest: DIGEST, candidateManifestDigest: OTHER_DIGEST,
      target: "linux-x64", phase: "handed-off", operationId: "upgrade-1",
      notice: "failed-safe", code: "network-unavailable", action: "retry-update",
    }).operationId).toBe("upgrade-1");
    expect(() => validateProgramUpdateReceipt({
      v: 1, currentManifestDigest: DIGEST, target: "linux-x64", phase: "idle", operationId: "wrong", notice: "none",
    })).toThrow("operationId");
    expect(() => validateProgramUpdateReceipt({
      v: 1, currentManifestDigest: DIGEST, target: "linux-x64", phase: "downloading", notice: "failed-safe",
      code: "network-unavailable", action: "restore-previous",
    })).toThrow();
  });

  it("strictly decodes a canonical file-only program artifact", () => {
    const file = Buffer.from("#!/usr/bin/env node\n", "utf8");
    const artifact = {
      v: 1,
      target: "linux-x64",
      releaseVersion: "1.2.3",
      files: [{
        path: "bin/zz",
        mode: 0o755,
        digest: byteDigest(file),
        bytes: file.byteLength,
        data: file.toString("base64url"),
      }],
    } as const;
    const bytes = Buffer.from(canonicalize(artifact), "utf8");
    expect(decodeProgramArtifact(bytes)).toEqual(artifact);
    expect(() => decodeProgramArtifact(Buffer.from(canonicalize({
      ...artifact,
      files: [{ ...artifact.files[0], path: "../escape" }],
    }), "utf8"))).toThrow("path");
    expect(() => decodeProgramArtifact(Buffer.from(canonicalize({
      ...artifact,
      files: [{ ...artifact.files[0], data: Buffer.from("tampered").toString("base64url") }],
    }), "utf8"))).toThrow("binding");
  });

  it("shares one finite archive, expansion and storage budget", () => {
    expect(assertProgramArtifactArchiveBytes(PROGRAM_ARTIFACT_LIMITS.maxArchiveBytes))
      .toBe(PROGRAM_ARTIFACT_LIMITS.maxArchiveBytes);
    expect(() => assertProgramArtifactArchiveBytes(PROGRAM_ARTIFACT_LIMITS.maxArchiveBytes + 1))
      .toThrow("supported release limit");
    expect(programArtifactStorageBudget({ archiveBytes: 1024, expandedBytes: 2048, installationBytes: 512 }))
      .toBe(1024 + 2048 + 512 + PROGRAM_ARTIFACT_LIMITS.storageHeadroomBytes);
    expect(() => programArtifactStorageBudget({
      archiveBytes: 1024,
      expandedBytes: PROGRAM_ARTIFACT_LIMITS.maxExpandedBytes + 1,
    })).toThrow("expanded bytes");
    expect(() => programArtifactStorageBudget({
      archiveBytes: 1024,
      expandedBytes: 2048,
      installationBytes: PROGRAM_ARTIFACT_LIMITS.maxInstallationSurfaceBytes + 1,
    })).toThrow("installation surface");
  });
});

function signedManifest(
  target: (typeof STABLE_RELEASE_TARGETS)[number],
  patch: Partial<UnsignedReleaseManifest> = {},
): ReleaseManifest {
  return createSignedReleaseManifest({
    v: 1,
    releaseVersion: "1.0.0",
    releaseSequence: "1",
    channel: "stable",
    target,
    nodeVersion: "22.18.0",
    sourceTreeDigest: DIGEST,
    packageGraphDigest: OTHER_DIGEST,
    artifact: { digest: DIGEST, bytes: 42 },
    protocolRange: { readMin: "1", readMax: "1", writeVersion: "1" },
    durableSchemas: DURABLE_SCHEMA_INVENTORY,
    minimumRollbackVersion: "1.0.0",
    keyId: "release-key",
    ...patch,
  }, signer);
}

function withoutSignature<T extends { signature: unknown }>(value: T): Omit<T, "signature"> {
  const { signature: _signature, ...rest } = value;
  return rest;
}
