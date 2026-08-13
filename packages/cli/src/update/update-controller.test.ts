import { generateKeyPairSync, sign } from "node:crypto";
import { DURABLE_SCHEMA_INVENTORY, canonicalize, byteDigest, createSignedReleaseManifest, createSignedStableReleaseIndex, protocolBytes, type ProgramArtifact, type ProtocolSigner, type ReleaseManifest, type StableReleaseTarget } from "@zhixing/core/protocol";
import type { Signature } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { ProgramStore } from "./program-store.js";
import { createReleaseVerifier } from "./release-verifier.js";
import { projectProgramUpdate, StableUpdateController } from "./update-controller.js";

const keyPair = generateKeyPairSync("ed25519");
const keyId = "stable-release-test";
const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "ed25519",
      keyId,
      sig: sign(null, protocolBytes(schemaId, version, payload), keyPair.privateKey).toString("base64url"),
    };
  },
};
const verifier = createReleaseVerifier({
  keyId,
  publicKeySpki: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
});

describe("stable program update", () => {
  it("stages one signed candidate, projects it visibly and restores the verified previous version", async () => {
    const root = await createTempDir("program-update");
    const target = "linux-x64" as const;
    const store = new ProgramStore(root, target);
    const current = release(target, "1.0.0", "1", "current");
    const currentManifestBytes = bytes(current.manifest);
    await store.stage(current.manifest, currentManifestBytes, current.artifactBytes);
    await store.activateStaged(current.manifest, byteDigest(currentManifestBytes));

    const candidate = release(target, "1.1.0", "2", "candidate");
    const candidateManifestBytes = bytes(candidate.manifest);
    const index = createSignedStableReleaseIndex({
      v: 1,
      channel: "stable",
      releaseVersion: candidate.manifest.releaseVersion,
      releaseSequence: candidate.manifest.releaseSequence,
      keyId,
      targets: targetRows(target, candidate.manifest, candidateManifestBytes),
    }, signer);
    const documents = new Map([
      ["https://release.example/stable.json", bytes(index)],
      ["https://release.example/linux-x64/manifest.json", candidateManifestBytes],
    ]);
    const controller = new StableUpdateController({
      store,
      verifier,
      indexUrl: "https://release.example/stable.json",
      fetchDocument: async (url) => {
        const document = documents.get(url);
        if (!document) throw new Error("missing test document");
        return document;
      },
      downloadArtifact: async () => candidate.artifactBytes,
    });
    const staged = await controller.check();
    expect(projectProgramUpdate(staged, "1.1.0")).toMatchObject({
      visible: true,
      state: "awaiting-safe-point",
      message: "将在当前工作完成后更新",
    });
    const pointer = await store.activateStaged(candidate.manifest, byteDigest(candidateManifestBytes));
    expect(pointer.current.releaseVersion).toBe("1.1.0");
    expect(pointer.previous?.releaseVersion).toBe("1.0.0");
    const restored = await controller.restorePrevious();
    expect(projectProgramUpdate(restored)).toMatchObject({ state: "restored" });
    expect((await store.loadPointer())?.current.releaseVersion).toBe("1.0.0");
  });

  it("keeps the current version and emits one stable action when candidate bytes are invalid", async () => {
    const root = await createTempDir("program-update-fail-safe");
    const target = "linux-x64" as const;
    const store = new ProgramStore(root, target);
    const current = release(target, "1.0.0", "1", "current");
    const currentManifestBytes = bytes(current.manifest);
    await store.stage(current.manifest, currentManifestBytes, current.artifactBytes);
    await store.activateStaged(current.manifest, byteDigest(currentManifestBytes));
    const candidate = release(target, "1.1.0", "2", "candidate");
    const candidateManifestBytes = bytes(candidate.manifest);
    const index = createSignedStableReleaseIndex({
      v: 1,
      channel: "stable",
      releaseVersion: "1.1.0",
      releaseSequence: "2",
      keyId,
      targets: targetRows(target, candidate.manifest, candidateManifestBytes),
    }, signer);
    const controller = new StableUpdateController({
      store,
      verifier,
      indexUrl: "https://release.example/stable.json",
      fetchDocument: async (url) => url.endsWith("stable.json") ? bytes(index) : candidateManifestBytes,
      downloadArtifact: async () => Buffer.from("tampered"),
    });
    const outcome = await controller.checkFailSafe();
    expect(outcome).toMatchObject({ notice: "failed-safe", code: "artifact-mismatch", action: "retry-update" });
    expect((await store.loadPointer())?.current.releaseVersion).toBe("1.0.0");
  });

  it("preserves a durable handed-off operation when the local response is lost", async () => {
    const root = await createTempDir("program-update-handoff-loss");
    const target = "linux-x64" as const;
    const store = new ProgramStore(root, target);
    const current = release(target, "1.0.0", "1", "current");
    const currentManifestBytes = bytes(current.manifest);
    await store.stage(current.manifest, currentManifestBytes, current.artifactBytes);
    await store.activateStaged(current.manifest, byteDigest(currentManifestBytes));
    const candidate = release(target, "1.1.0", "2", "candidate");
    const candidateManifestBytes = bytes(candidate.manifest);
    const index = createSignedStableReleaseIndex({
      v: 1,
      channel: "stable",
      releaseVersion: "1.1.0",
      releaseSequence: "2",
      keyId,
      targets: targetRows(target, candidate.manifest, candidateManifestBytes),
    }, signer);
    const controller = new StableUpdateController({
      store,
      verifier,
      indexUrl: "https://release.example/stable.json",
      fetchDocument: async (url) => url.endsWith("stable.json") ? bytes(index) : candidateManifestBytes,
      downloadArtifact: async () => candidate.artifactBytes,
      handoffStaged: async (candidateManifestDigest) => {
        await store.writeReceipt({
          v: 1,
          currentManifestDigest: byteDigest(currentManifestBytes),
          target,
          candidateManifestDigest,
          phase: "handed-off",
          operationId: "upgrade-response-lost",
          notice: "none",
        });
        throw new Error("response lost");
      },
    });
    await expect(controller.checkFailSafe()).resolves.toMatchObject({
      phase: "handed-off",
      operationId: "upgrade-response-lost",
      notice: "none",
    });
  });
});

function release(target: StableReleaseTarget, version: string, sequence: string, content: string) {
  const file = Buffer.from(content, "utf8");
  const artifact: ProgramArtifact = {
    v: 1,
    target,
    releaseVersion: version,
    files: [{ path: "bin/zz", mode: 0o755, digest: byteDigest(file), bytes: file.byteLength, data: file.toString("base64url") }],
  };
  const artifactBytes = Buffer.from(canonicalize(artifact), "utf8");
  const manifest = createSignedReleaseManifest({
    v: 1,
    releaseVersion: version,
    releaseSequence: sequence,
    channel: "stable",
    target,
    nodeVersion: "22.18.0",
    sourceTreeDigest: `sha256:${"1".repeat(64)}`,
    packageGraphDigest: `sha256:${"2".repeat(64)}`,
    artifact: { digest: byteDigest(artifactBytes), bytes: artifactBytes.byteLength },
    protocolRange: { readMin: "1", readMax: "1", writeVersion: "1" },
    durableSchemas: DURABLE_SCHEMA_INVENTORY,
    minimumRollbackVersion: "1.0.0",
    keyId,
  }, signer);
  return { manifest, artifactBytes };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

function targetRows(
  actualTarget: StableReleaseTarget,
  manifest: ReleaseManifest,
  manifestBytes: Uint8Array,
) {
  return (["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"] as const).map((target) => ({
    target,
    manifest: {
      url: target === actualTarget
        ? "https://release.example/linux-x64/manifest.json"
        : `https://release.example/${target}/manifest.json`,
      digest: target === actualTarget ? byteDigest(manifestBytes) : manifest.artifact.digest,
      bytes: target === actualTarget ? manifestBytes.byteLength : manifest.artifact.bytes,
    },
    artifactUrl: `https://release.example/${target}/artifact.json`,
  }));
}
