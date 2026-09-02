import { createHash } from "node:crypto";
import path from "node:path";
import { access } from "node:fs/promises";
import { FileArtifactStore } from "@zhixing/core/authority";
import type { ArtifactRef } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { projectAssignmentArtifactReceiver } from "./assignment-artifact-receiver.js";
import { createAssignmentArtifactReceiverInfrastructure } from "./assignment-artifact-receiver-infrastructure.js";

describe("Assignment artifact receiver boundary", () => {
  it("projects only the required readonly durable-prefix capabilities", async () => {
    const progress = vi.fn(async () => ({ receivedBytes: 0, complete: false }));
    const append = vi.fn(async () => ({ receivedBytes: 1, complete: false }));
    const receiver = projectAssignmentArtifactReceiver({ progress, append });
    const ref = artifactRef(Buffer.from("ab"));

    expect(Object.keys(receiver)).toEqual(["progress", "append"]);
    expect(Object.isFrozen(receiver)).toBe(true);
    await receiver.progress(ref);
    await receiver.append(ref, 0, Uint8Array.of(0x61));
    expect(progress).toHaveBeenCalledWith(ref);
    expect(append).toHaveBeenCalledWith(ref, 0, Uint8Array.of(0x61));
    expect(() => Reflect.apply(
      projectAssignmentArtifactReceiver,
      undefined,
      [{}],
    )).toThrow(
      "requires progress and append",
    );
  });

  it("keeps a byte-equal prefix across Host reconstruction and finalizes into P06 CAS", async () => {
    const zhixingHome = await createTempDir("assignment-artifact-receiver");
    const artifacts = new FileArtifactStore(path.join(zhixingHome, "authority-artifacts"));
    const bytes = Buffer.from("assignment-artifact-over-mesh");
    const ref = artifactRef(bytes);
    const first = createAssignmentArtifactReceiverInfrastructure({
      zhixingHome,
      artifacts,
    });

    await expect(first.append(ref, 0, bytes.subarray(0, 9))).resolves.toEqual({
      receivedBytes: 9,
      complete: false,
    });
    const partialPath = path.join(
      zhixingHome,
      "distributed-runtime",
      "mesh-artifact-partials",
      `${ref.digest.slice("sha256:".length)}.${ref.bytes}.part`,
    );
    await expect(access(partialPath)).resolves.toBeUndefined();

    const restarted = createAssignmentArtifactReceiverInfrastructure({
      zhixingHome,
      artifacts,
    });
    await expect(restarted.progress(ref)).resolves.toEqual({
      receivedBytes: 9,
      complete: false,
    });
    await expect(restarted.append(ref, 10, bytes.subarray(10, 11))).rejects.toThrow(
      "does not continue the durable prefix",
    );
    await expect(restarted.append(ref, 0, Buffer.from("different"))).rejects.toThrow(
      "differs from the durable prefix",
    );
    await expect(restarted.append(ref, 0, bytes.subarray(0, 9))).resolves.toEqual({
      receivedBytes: 9,
      complete: false,
    });
    await expect(restarted.append(ref, 9, bytes.subarray(9))).resolves.toEqual({
      receivedBytes: ref.bytes,
      complete: true,
    });
    await expect(artifacts.get(ref)).resolves.toEqual(bytes);
    await expect(access(partialPath)).rejects.toMatchObject({ code: "ENOENT" });

    const corruptRef: ArtifactRef = {
      digest: `sha256:${"f".repeat(64)}`,
      bytes: 7,
    };
    await expect(
      restarted.append(corruptRef, 0, Buffer.from("corrupt")),
    ).rejects.toThrow("does not match its declared reference");
    await expect(restarted.progress(corruptRef)).resolves.toEqual({
      receivedBytes: 0,
      complete: false,
    });
  });
});

function artifactRef(bytes: Uint8Array): ArtifactRef {
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}
