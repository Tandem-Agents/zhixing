import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_BRIDGE_TARGETS, assertCheckpointBridgeHost, checkpointBridgeArtifactDirectory, checkpointBridgeTarget, verifyCheckpointBridgeArtifact } from "../checkpoint-bridge-artifact.js";

describe("checkpoint native delivery", () => {
  it.each(CHECKPOINT_BRIDGE_TARGETS)("verifies $id without loading a foreign binary", async (target) => {
    const root = await createTempDir("native-delivery");
    const directory = checkpointBridgeArtifactDirectory(root, target);
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.from("artifact-fixture");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
    await writeFile(path.join(directory, target.file), bytes);
    const descriptor = {
      schemaVersion: 1, os: target.os, arch: target.arch, packageVersion: "0.1.0", file: target.file,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const save = async (value: unknown) => writeFile(path.join(directory, "descriptor.json"), JSON.stringify(value));
    await save(descriptor);
    expect(verifyCheckpointBridgeArtifact(root, target)).toBe(path.join(directory, target.file));
    for (const invalid of [null, [], {}, { ...descriptor, os: "other" }, { ...descriptor, arch: "other" },
      { ...descriptor, packageVersion: "0.0.0" }, { ...descriptor, file: "../other" },
      { ...descriptor, bytes: 0 }, { ...descriptor, sha256: "0".repeat(64) }, { ...descriptor, extra: true }]) {
      await save(invalid);
      expect(() => verifyCheckpointBridgeArtifact(root, target)).toThrow("与当前包不匹配");
    }
    await save(descriptor);
    await writeFile(path.join(directory, target.file), "tampered");
    expect(() => verifyCheckpointBridgeArtifact(root, target)).toThrow("与当前包不匹配");
  });

  it("rejects absent artifacts and undeclared targets", async () => {
    expect(() => checkpointBridgeTarget("freebsd", "x64")).toThrow("尚未提供");
    const root = await createTempDir("native-absent");
    expect(() => verifyCheckpointBridgeArtifact(root, checkpointBridgeTarget())).toThrow("缺失");
  });

  it("does not treat musl or an older glibc as a compatible native ABI", () => {
    const target = checkpointBridgeTarget("linux", "x64");
    for (const version of [undefined, "", "invalid", "2.34"]) {
      expect(() => assertCheckpointBridgeHost(target, version)).toThrow("glibc 2.35");
    }
    for (const version of ["2.35", "2.39", "3.0"]) expect(() => assertCheckpointBridgeHost(target, version)).not.toThrow();
    expect(() => assertCheckpointBridgeHost(checkpointBridgeTarget("darwin", "arm64"))).not.toThrow();
  });
});
