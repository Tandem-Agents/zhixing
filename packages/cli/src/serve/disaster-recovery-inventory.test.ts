import { describe, expect, it } from "vitest";
import type { CheckpointEnvelope } from "@zhixing/core/contracts";
import type {
  InventoryRecoveryCheckpointTarget,
  RecoveryCheckpointInventoryEntry,
} from "@zhixing/mesh/checkpoint-target";
import {
  discoverDisasterRecoveryCandidates,
  selectDisasterRecoveryCandidate,
} from "./disaster-recovery-inventory.js";

describe("disaster recovery inventory", () => {
  it("projects only location/time/action state and requires an explicit multi-candidate choice", async () => {
    const older = entry("checkpoint-private-1", "backup-device:private-1", "2026-08-08T00:00:00.000Z");
    const newer = entry("checkpoint-private-2", "backup-device:private-2", "2026-08-09T00:00:00.000Z");
    const candidates = await discoverDisasterRecoveryCandidates({
      requestId: "recover-request-1",
      targets: [
        { displayName: "书房备份盘", target: target(older) },
        { displayName: "家中服务器", target: target(newer) },
      ],
    });

    expect(candidates.map((candidate) => candidate.public)).toEqual([
      { number: 1, location: "家中服务器", backedUpAt: newer.envelope.createdAt, state: "pending-verification" },
      { number: 2, location: "书房备份盘", backedUpAt: older.envelope.createdAt, state: "pending-verification" },
    ]);
    expect(JSON.stringify(candidates.map((candidate) => candidate.public))).not.toContain("checkpoint-private");
    expect(JSON.stringify(candidates.map((candidate) => candidate.public))).not.toContain("backup-device");
    expect(() => selectDisasterRecoveryCandidate(candidates)).toThrow(/多个恢复备份/);
    expect(selectDisasterRecoveryCandidate(candidates, 2).entry).toEqual(older);
    expect(() => selectDisasterRecoveryCandidate(candidates, 3)).toThrow(/序号/);
  });

  it("auto-selects the sole complete candidate and rejects an empty inventory", async () => {
    const only = entry("checkpoint-private", "backup-device:private", "2026-08-08T00:00:00.000Z");
    const candidates = await discoverDisasterRecoveryCandidates({
      requestId: "recover-request-2",
      targets: [{ displayName: "离线备份盘", target: target(only) }],
    });
    expect(selectDisasterRecoveryCandidate(candidates).entry).toEqual(only);
    expect(() => selectDisasterRecoveryCandidate([])).toThrow(/没有找到/);
  });
});

function target(...entries: RecoveryCheckpointInventoryEntry[]): InventoryRecoveryCheckpointTarget {
  return {
    targetId: entries[0]?.targetId ?? "backup-device:none",
    independenceDomain: "device:backup",
    inventory: async () => entries,
    writeDurable: async () => undefined,
    read: async () => { throw new Error("not used"); },
    retire: async () => undefined,
  };
}

function entry(checkpointId: string, targetId: string, createdAt: string): RecoveryCheckpointInventoryEntry {
  return {
    checkpointId,
    targetId,
    recipientKeyId: "sha256:recipient",
    envelope: {
      v: 1,
      t: "CheckpointEnvelope",
      checkpointId,
      createdAt,
      recipientKeyId: "sha256:recipient",
    } as unknown as CheckpointEnvelope,
  };
}
