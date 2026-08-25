import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { createTempDir } from "@zhixing/test-utils";
import {
  loadDisasterRecoveryPostInstallReceipt,
  recordDisasterRecoveryPostInstallReceipt,
  waitForDisasterRecoveryPostInstallReceipt,
  type DisasterInstalledAuthorityGeneration,
} from "./disaster-recovery-installation.js";

describe("disaster recovery post-install receipt", () => {
  it("durably binds one installed generation to its participants and six-kind read-back", async () => {
    const root = await createTempDir("disaster-recovery-receipt");
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority"),
      new FileArtifactStore(path.join(root, "artifacts")),
    );
    const generation = installedGeneration();
    const participants = ["runtime-epoch", "scheduler", "conversation", "delivery"];
    const readBack = [
      { kind: "assignment" as const, id: "assignment-1", disposition: "current-owner" as const },
      { kind: "intent" as const, id: "intent-1", disposition: "current-owner" as const },
      { kind: "interaction" as const, id: "interaction-1", disposition: "current-owner" as const },
      { kind: "confirmation" as const, id: "confirmation-1", disposition: "current-owner" as const },
      { kind: "final" as const, id: "final-1", disposition: "terminal" as const },
      { kind: "delivery" as const, id: "delivery-1", disposition: "current-owner" as const },
    ];

    const receipt = await recordDisasterRecoveryPostInstallReceipt({
      log,
      generation,
      participants,
      readBack,
    });
    expect(await loadDisasterRecoveryPostInstallReceipt({ log, generation })).toEqual(receipt);
    expect(await waitForDisasterRecoveryPostInstallReceipt({
      log,
      generation,
      timeoutMs: 100,
    })).toEqual(receipt);
    expect(await recordDisasterRecoveryPostInstallReceipt({
      log,
      generation,
      participants,
      readBack,
    })).toEqual(receipt);
    await expect(recordDisasterRecoveryPostInstallReceipt({
      log,
      generation,
      participants: [...participants, "late-participant"],
      readBack,
    })).rejects.toThrow(/conflicts/u);
  });
});

function installedGeneration(): DisasterInstalledAuthorityGeneration {
  return {
    mode: "disaster-recovery",
    transferId: "xfer-01KXPWTM80BYB4SH423EJT1C70",
    commitDigest: `sha256:${"1".repeat(64)}`,
    baseDigest: `sha256:${"2".repeat(64)}`,
    sourceHead: {
      logId: "source-log",
      lsn: 7,
      frameEndOffset: 700,
      prefixDigest: `sha256:${"3".repeat(64)}`,
    },
    targetLogId: "target-log",
    installLsn: 8,
    anchorEpoch: 2,
    trustEpoch: 3,
    trustChainHead: {
      seq: 4,
      eventDigest: `sha256:${"4".repeat(64)}`,
    },
  };
}
