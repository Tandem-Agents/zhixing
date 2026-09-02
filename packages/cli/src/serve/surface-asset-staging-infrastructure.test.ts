import { createHash } from "node:crypto";
import path from "node:path";
import { access } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import type { ArtifactRef } from "@zhixing/core/contracts";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createSurfaceAssetStagingInfrastructure } from "./surface-asset-staging-infrastructure.js";

describe("Surface asset staging infrastructure", () => {
  it("binds the canonical temporary, presence, and partial roots behind finite ports", async () => {
    const distributedRoot = await createTempDir("surface-asset-staging");
    const staging = createSurfaceAssetStagingInfrastructure({ distributedRoot });
    const bytes = Buffer.from("surface-asset-staging");
    const ref: ArtifactRef = {
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      bytes: bytes.byteLength,
    };

    expect(Object.keys(staging)).toEqual([
      "temporaryArtifacts",
      "upload",
      "recovery",
      "presence",
    ]);
    expect(Object.isFrozen(staging)).toBe(true);
    await staging.presence.mark(ref, "surface:one");
    await staging.upload.append(ref, 0, bytes.subarray(0, 4));
    await expect(staging.recovery.progress(ref)).resolves.toEqual({
      receivedBytes: 4,
      complete: false,
    });

    const cursor = staging.recovery.openPartialReferenceCursor();
    await expect(cursor.next(8)).resolves.toEqual({
      references: [ref],
      done: true,
    });
    await cursor.close();
    await staging.upload.append(ref, 4, bytes.subarray(4));
    await expect(staging.temporaryArtifacts.get(ref)).resolves.toEqual(bytes);
    await expect(staging.presence.has(ref)).resolves.toBe(true);
    await expect(
      access(path.join(distributedRoot, "surface-asset-partials")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(distributedRoot, "surface-asset-temporary", ".presence")),
    ).resolves.toBeUndefined();
  });

  it("serves command-only checkpoint retention through the same physical composition", async () => {
    const home = await createTempDir("surface-asset-checkpoint-retention");
    const store = new FileMeshBootstrapStore(home);

    const snapshot = await store
      .checkpointRetention()
      .checkpointRetentionSnapshot();
    expect(Object.keys(snapshot.sourceHeads)).toHaveLength(1);
    expect(Object.values(snapshot.sourceHeads)[0]?.lsn).toBe(0);
    await store.stopStorageMaintenance();
  });
});
