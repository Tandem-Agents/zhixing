import { describe, expect, it, vi } from "vitest";
import { BackupRecoveryCurrentRemovalApplicationService } from "./application.js";

function fixture() {
  const context = {
    homeId: "home-1",
    anchorEpoch: 7,
    trustHeadDigest: "trust-7",
    recoveryRootPublicKey: "root-public",
    recoveryBackupPublicKey: "backup-public",
  };
  const identity = {
    rootKeyId: "root-key",
    backupKeyId: "backup-key",
    rootPublicKey: "root-public",
    backupPublicKey: "backup-public",
  };
  const mechanism = {
    hasCheckpointOwner: vi.fn(() => true),
    readStatus: vi.fn(async () => ({
      state: "recoverable" as const,
      fullBackupReady: true,
      checkpointId: "checkpoint-old",
      targetId: "target-1",
      upToLsn: 11,
    })),
    readContext: vi.fn(async () => context),
    decodeCurrentPackage: vi.fn(() => ({ package: "secret-root", identity })),
    bindingDigest: vi.fn((input: unknown) => `generation:${JSON.stringify(input)}`),
    forceCheckpoint: vi.fn(async (requestId: string) => ({
      checkpoint: `checkpoint:${requestId}`,
      checkpointId: `id:${requestId}`,
      envelopeDigest: `digest:${requestId}`,
      upToLsn: requestId.includes("final") ? 42 : 12,
    })),
    verifyCheckpoint: vi.fn(async ({ checkpoint }: { readonly checkpoint: string }) => ({
      targetId: "target-1",
      checkpointId: checkpoint.replace("checkpoint:", "id:"),
      envelopeDigest: checkpoint.replace("checkpoint:", "digest:"),
      evidence: `verified:${checkpoint}`,
    })),
  };
  return {
    application: new BackupRecoveryCurrentRemovalApplicationService(mechanism),
    mechanism,
    context,
    identity,
  };
}

describe("BackupRecoveryCurrentRemovalApplicationService", () => {
  it("owns package/root/generation binding and both checkpoint permissions", async () => {
    const f = fixture();
    const status = await f.application.readiness();
    expect(Object.isFrozen(status)).toBe(true);
    expect(status).toEqual({
      state: "recoverable",
      fullBackupReady: true,
      checkpointId: "checkpoint-old",
      targetId: "target-1",
      upToLsn: 11,
    });

    const initial = await f.application.prepareBegin({ recoveryPackage: "package" });
    expect(Object.isFrozen(initial.binding)).toBe(true);
    await expect(initial.verifyCheckpoint({ requestId: "operation:pre" }))
      .resolves.toBe("verified:checkpoint:operation:pre");
    const confirmed = await f.application.prepareConfirm({
      recoveryPackage: "package",
      binding: initial.binding,
    });
    await expect(confirmed.verifyCheckpoint({
      requestId: "operation:final",
      minimumUpToLsn: 40,
    })).resolves.toBe("verified:checkpoint:operation:final");
    expect(f.mechanism.bindingDigest).toHaveBeenCalledWith({
      homeId: "home-1",
      anchorEpoch: 7,
      trustHeadDigest: "trust-7",
      targetId: "target-1",
      rootKeyId: "root-key",
      recipientKeyId: "backup-key",
    });
  });

  it("fails closed on missing owner, root drift and accepted-generation drift", async () => {
    const missing = fixture();
    missing.mechanism.hasCheckpointOwner.mockReturnValue(false);
    await expect(missing.application.prepareBegin({ recoveryPackage: "package" }))
      .rejects.toThrow("No recovery backup target is configured");

    const root = fixture();
    root.mechanism.decodeCurrentPackage.mockReturnValue({
      package: "foreign-root",
      identity: { ...root.identity, rootPublicKey: "foreign-public" },
    });
    await expect(root.application.prepareBegin({ recoveryPackage: "package" }))
      .rejects.toThrow("does not bind the current home recovery root");

    const generation = fixture();
    const permit = await generation.application.prepareBegin({ recoveryPackage: "package" });
    generation.mechanism.readContext.mockResolvedValue({
      ...generation.context,
      homeId: "foreign-home",
    });
    await expect(generation.application.prepareConfirm({
      recoveryPackage: "package",
      binding: permit.binding,
    })).rejects.toThrow("changes the accepted uninstall generation");
  });

  it("rejects checkpoint equivocation and a final checkpoint before the flush", async () => {
    const equivocation = fixture();
    equivocation.mechanism.verifyCheckpoint.mockResolvedValue({
      targetId: "foreign-target",
      checkpointId: "id:operation:pre",
      envelopeDigest: "digest:operation:pre",
      evidence: "foreign",
    });
    const initial = await equivocation.application.prepareBegin({ recoveryPackage: "package" });
    await expect(initial.verifyCheckpoint({ requestId: "operation:pre" }))
      .rejects.toThrow("does not bind the frozen target");

    const stale = fixture();
    const confirmed = await stale.application.prepareBegin({ recoveryPackage: "package" });
    await expect(confirmed.verifyCheckpoint({
      requestId: "operation:pre",
      minimumUpToLsn: 13,
    })).rejects.toThrow("does not contain the accepted-work flush");
  });
});
