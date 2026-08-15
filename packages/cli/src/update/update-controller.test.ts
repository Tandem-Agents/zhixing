import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DURABLE_SCHEMA_INVENTORY, canonicalize, byteDigest, createSignedReleaseManifest, createSignedStableReleaseIndex, protocolBytes, type ProgramArtifact, type ProtocolSigner, type ReleaseManifest, type StableReleaseTarget } from "@zhixing/core/protocol";
import type { Signature } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { ProgramStore } from "./program-store.js";
import { commitInstallationReceipt, installProgramRelease, loadInstallationReceipt } from "./installation-receipt.js";
import { createReleaseVerifier } from "./release-verifier.js";
import { readProgramUpdateProjection } from "./runtime.js";
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
  it("installs, exactly replays and preserves a program-root-external anti-downgrade receipt", async () => {
    const directory = await createTempDir("program-install");
    const root = path.join(directory, "program with 空格");
    const receiptPath = path.join(directory, "installer-state", "installation-receipt.json");
    const first = release("linux-x64", "1.0.0", "1", "first");
    const install = () => installProgramRelease({
      store: new ProgramStore(root, "linux-x64"),
      verifier,
      manifestBytes: bytes(first.manifest),
      artifactBytes: first.artifactBytes,
      receiptPath,
    });
    await install();
    await rm(receiptPath, { force: true });
    await install();
    await install();
    expect((await loadInstallationReceipt(receiptPath))?.releaseSequence).toBe("1");

    const second = release("linux-x64", "1.1.0", "2", "second");
    await installProgramRelease({
      store: new ProgramStore(root, "linux-x64"),
      verifier,
      manifestBytes: bytes(second.manifest),
      artifactBytes: second.artifactBytes,
      receiptPath,
      handoffExisting: async (candidateManifestDigest) => {
        const store = new ProgramStore(root, "linux-x64");
        const accepted = await store.loadStagedManifest(candidateManifestDigest, verifier);
        await store.activateStaged(accepted.manifest, accepted.digest, {
          sourceManifestDigest: byteDigest(bytes(first.manifest)),
          pointerGeneration: 1,
        });
        await commitInstallationReceipt(accepted.manifest, accepted.digest, receiptPath);
        return { operationId: "upgrade:test" };
      },
      terminalTimeoutMs: 1_000,
      pollIntervalMs: 1,
    });
    await expect(readFile(path.join(root, "installer", "program-installer.js"), "utf8")).resolves.toBe("installer:first");
    await expect(readFile(path.join(root, "runtime", "node"), "utf8")).resolves.toBe("node-runtime:first");
    await rm(root, { recursive: true, force: true });
    await expect(install()).rejects.toThrow("downgrade");
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadInstallationReceipt(receiptPath))?.releaseSequence).toBe("2");
  });

  it("rejects different bytes under an installed release identity before program writes", async () => {
    const directory = await createTempDir("program-install-conflict");
    const root = path.join(directory, "program");
    const receiptPath = path.join(directory, "receipt.json");
    const accepted = release("linux-x64", "1.0.0", "1", "accepted");
    await installProgramRelease({
      store: new ProgramStore(root, "linux-x64"),
      verifier,
      manifestBytes: bytes(accepted.manifest),
      artifactBytes: accepted.artifactBytes,
      receiptPath,
    });
    await rm(root, { recursive: true, force: true });
    const conflict = release("linux-x64", "1.0.0", "1", "conflict");
    await expect(installProgramRelease({
      store: new ProgramStore(root, "linux-x64"),
      verifier,
      manifestBytes: bytes(conflict.manifest),
      artifactBytes: conflict.artifactBytes,
      receiptPath,
    })).rejects.toThrow("conflicting bytes");
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects insufficient program-volume capacity before staging a candidate", async () => {
    const root = await createTempDir("program-update-capacity");
    let available = 2n * 1024n * 1024n * 1024n;
    const store = new ProgramStore(root, "linux-x64", {
      availableBytes: async () => available,
    });
    const current = release("linux-x64", "1.0.0", "1", "current");
    const currentManifestBytes = bytes(current.manifest);
    await store.stage(current.manifest, currentManifestBytes, current.artifactBytes);
    await store.activateStaged(current.manifest, byteDigest(currentManifestBytes));
    available = 0n;

    await expect(store.ensureDownloadCapacity(1)).rejects.toThrow("enough capacity");
    expect((await store.loadPointer())?.current.releaseVersion).toBe("1.0.0");
  });

  it("rejects undeclared files and directories in an installed program version", async () => {
    const root = await createTempDir("program-update-exact-layout");
    const store = new ProgramStore(root, "linux-x64");
    const current = release("linux-x64", "1.0.0", "1", "current");
    const manifestBytes = bytes(current.manifest);
    await store.stage(current.manifest, manifestBytes, current.artifactBytes);
    const pointer = await store.activateStaged(current.manifest, byteDigest(manifestBytes));
    const program = store.programPath(pointer.current);

    await mkdir(path.join(program, "undeclared-empty"));
    await expect(store.verifyInstalled(pointer.current, verifier)).rejects.toThrow("layout read-back failed");
    await rm(path.join(program, "undeclared-empty"), { recursive: true, force: true });
    await writeFile(path.join(program, "app", "dist", "undeclared.js"), "payload");
    await expect(store.verifyInstalled(pointer.current, verifier)).rejects.toThrow("layout read-back failed");
    expect((await store.loadPointer())?.current.manifestDigest).toBe(byteDigest(manifestBytes));
  });

  it("keeps legal release identity separate from its digest-addressed program directory", async () => {
    const root = await createTempDir("program-update-storage-identity");
    const store = new ProgramStore(root, "linux-x64");
    const candidate = release("linux-x64", "1.0.0+build.1", "1", "build-metadata");
    const manifestBytes = bytes(candidate.manifest);
    const manifestDigest = byteDigest(manifestBytes);
    const directory = manifestDigest.slice("sha256:".length);

    await store.stage(candidate.manifest, manifestBytes, candidate.artifactBytes);
    const first = await store.activateStaged(candidate.manifest, manifestDigest);
    const replay = await store.activateStaged(candidate.manifest, manifestDigest);

    expect(first.current).toMatchObject({
      releaseVersion: "1.0.0+build.1",
      manifestDigest,
      directory,
    });
    expect(first.current.directory).toMatch(/^[a-f0-9]{64}$/u);
    expect(replay).toEqual(first);
    await expect(store.verifyInstalled(first.current, verifier)).resolves.toMatchObject({
      digest: manifestDigest,
      manifest: { releaseVersion: "1.0.0+build.1" },
    });
  });

  it("reads an existing safe pointer directory without migrating or rewriting it", async () => {
    const root = await createTempDir("program-update-legacy-directory");
    const pointer = {
      v: 1 as const,
      target: "linux-x64" as const,
      generation: 7,
      current: {
        releaseVersion: "0.9.0",
        releaseSequence: "9",
        manifestDigest: `sha256:${"9".repeat(64)}`,
        directory: "0.9.0_legacy-safe",
      },
    };
    const pointerBytes = Buffer.from(`${canonicalize(pointer)}\n`, "utf8");
    await writeFile(path.join(root, "current.json"), pointerBytes);

    await expect(new ProgramStore(root, "linux-x64").loadPointer()).resolves.toEqual(pointer);
    await expect(readFile(path.join(root, "current.json"))).resolves.toEqual(pointerBytes);
  });

  it("stages a verified previous version without bypassing the lifecycle pointer switch", async () => {
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
    expect(projectProgramUpdate(restored)).toMatchObject({ state: "awaiting-safe-point" });
    expect(restored).toMatchObject({
      phase: "staged",
      candidateManifestDigest: byteDigest(currentManifestBytes),
    });
    expect((await store.loadPointer())?.current.releaseVersion).toBe("1.1.0");
  });

  it("keeps an action-required notice sticky until its exact candidate changes", async () => {
    const root = await createTempDir("program-update-sticky-action");
    const target = "linux-x64" as const;
    const store = new ProgramStore(root, target);
    const current = release(target, "1.0.0", "1", "current");
    const currentBytes = bytes(current.manifest);
    await store.stage(current.manifest, currentBytes, current.artifactBytes);
    await store.activateStaged(current.manifest, byteDigest(currentBytes));
    const candidateDigest = `sha256:${"a".repeat(64)}`;
    await store.writeReceipt({
      v: 1,
      currentManifestDigest: byteDigest(currentBytes),
      target,
      candidateManifestDigest: candidateDigest,
      phase: "idle",
      notice: "action-required",
      code: "schema-incompatible",
      action: "contact-support",
    });
    const controller = new StableUpdateController({
      store,
      verifier,
      indexUrl: "https://release.example/stable.json",
      fetchDocument: async () => { throw new Error("offline"); },
    });
    await expect(controller.checkFailSafe()).resolves.toMatchObject({
      notice: "action-required",
      candidateManifestDigest: candidateDigest,
      action: "contact-support",
    });
  });

  it("consumes an updated notice only through its exact durable token", async () => {
    const root = await createTempDir("program-update-notice");
    const store = new ProgramStore(root, "linux-x64");
    const updated = {
      v: 1 as const,
      currentManifestDigest: `sha256:${"b".repeat(64)}`,
      target: "linux-x64" as const,
      phase: "idle" as const,
      notice: "updated" as const,
    };
    await store.writeReceipt(updated);
    const projection = projectProgramUpdate(updated);
    expect(projection.noticeToken).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expect(store.consumeNotice(`sha256:${"c".repeat(64)}`)).resolves.toBe(false);
    await expect(store.consumeNotice(projection.noticeToken!)).resolves.toBe(true);
    await expect(store.consumeNotice(projection.noticeToken!)).resolves.toBe(false);
    await expect(store.loadReceipt()).resolves.toMatchObject({ notice: "none" });
  });

  it("reads public update status from the verified current program facts", async () => {
    const root = await createTempDir("program-update-public-facts");
    const store = new ProgramStore(root, "linux-x64");
    const current = release("linux-x64", "1.0.0", "1", "current");
    const manifestBytes = bytes(current.manifest);
    const digest = byteDigest(manifestBytes);
    await store.stage(current.manifest, manifestBytes, current.artifactBytes);
    await store.activateStaged(current.manifest, digest);
    await store.writeReceipt({
      v: 1,
      currentManifestDigest: digest,
      target: "linux-x64",
      phase: "idle",
      notice: "updated",
    });
    const deps = {
      verifier,
      lifecycle: { state: async () => undefined },
      health: async () => ({ releaseManifestDigest: digest }) as never,
    };
    await expect(readProgramUpdateProjection(store, deps)).resolves.toMatchObject({
      state: "updated",
      message: "已更新",
    });
    await store.writeReceipt({
      v: 1,
      currentManifestDigest: `sha256:${"9".repeat(64)}`,
      target: "linux-x64",
      phase: "idle",
      notice: "updated",
    });
    await expect(readProgramUpdateProjection(store, deps)).resolves.toMatchObject({
      state: "action-required",
      code: "update-state-inconsistent",
    });
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
  const runtimeName = target === "win32-x64" ? "runtime/node.exe" : "runtime/node";
  const launcherName = target === "win32-x64" ? "bin/zz.cmd" : "bin/zz";
  const aliasName = target === "win32-x64" ? "bin/zhixing.cmd" : "bin/zhixing";
  const programFiles = [
    artifactFile(launcherName, `launcher:${content}`, 0o755),
    artifactFile(aliasName, `launcher:${content}`, 0o755),
    artifactFile(runtimeName, `node-runtime:${content}`, 0o755),
    artifactFile("installer/launch.js", `launch:${content}`, 0o644),
    artifactFile("installer/program-installer.js", `installer:${content}`, 0o644),
    artifactFile("app/package.json", "{}", 0o644),
    artifactFile("app/dist/index.js", content, 0o755),
    artifactFile("app/dist/program-installer.js", content, 0o755),
    artifactFile("program-tree-receipt.json", "{}", 0o644),
  ].sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  const artifact: ProgramArtifact = {
    v: 1,
    target,
    releaseVersion: version,
    files: programFiles,
  };
  const artifactBytes = Buffer.from(canonicalize(artifact), "utf8");
  const manifest = createSignedReleaseManifest({
    v: 1,
    releaseVersion: version,
    releaseSequence: sequence,
    channel: "stable",
    target,
    nodeVersion: "24.19.0",
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

function artifactFile(filePath: string, content: string, mode: number) {
  const file = Buffer.from(content, "utf8");
  return { path: filePath, mode, digest: byteDigest(file), bytes: file.byteLength, data: file.toString("base64url") };
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
