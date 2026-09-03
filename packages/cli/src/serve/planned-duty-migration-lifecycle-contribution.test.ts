import { describe, expect, it, vi } from "vitest";
import type { PlannedDutyMigrationAnchorLifecycleContribution } from "./planned-duty-migration-lifecycle-contribution.js";
import {
  definePlannedDutyMigrationLifecycleContribution,
  EXECUTOR_ONLY_PLANNED_DUTY_MIGRATION_LIFECYCLE,
} from "./planned-duty-migration-lifecycle-contribution.js";

function createAnchorContribution(): PlannedDutyMigrationAnchorLifecycleContribution {
  return {
    kind: "anchor",
    checkpoint: {
      kind: "available",
      owner: {
        force: vi.fn(async () => ({ envelope: { digest: "checkpoint-digest" } })) as never,
        status: vi.fn(async () => ({ fullBackupReady: false })) as never,
      },
    },
    transfer: {
      stopAccepting: vi.fn(async () => undefined),
      drainAccepted: vi.fn(async () => undefined),
      resumeAfterAbort: vi.fn(async () => undefined),
    },
    postInstall: {
      rebindAuthorityGeneration: vi.fn(async () => undefined) as never,
      recoverScheduler: vi.fn(async (obligations) => obligations),
      recoverConversation: vi.fn(async (obligations) => obligations),
      recoverDelivery: vi.fn(async (obligations) => obligations),
      openCurrentOwnerSurfaces: vi.fn(async () => undefined),
    },
  };
}

describe("planned-duty migration lifecycle contribution", () => {
  it("freezes one exact Anchor contribution while preserving every owner handle", () => {
    const input = createAnchorContribution();
    const contribution = definePlannedDutyMigrationLifecycleContribution(input);

    expect(contribution.kind).toBe("anchor");
    expect(Object.isFrozen(contribution)).toBe(true);
    if (contribution.kind !== "anchor" || input.checkpoint.kind !== "available") return;
    expect(Object.keys(contribution).sort()).toEqual([
      "checkpoint",
      "kind",
      "postInstall",
      "transfer",
    ]);
    expect(Object.isFrozen(contribution.checkpoint)).toBe(true);
    expect(Object.isFrozen(contribution.transfer)).toBe(true);
    expect(Object.isFrozen(contribution.postInstall)).toBe(true);
    expect(contribution.checkpoint.kind).toBe("available");
    if (contribution.checkpoint.kind !== "available") return;
    expect(contribution.checkpoint.owner).toBe(input.checkpoint.owner);
    expect(contribution.transfer.stopAccepting).toBe(input.transfer.stopAccepting);
    expect(contribution.postInstall.recoverScheduler).toBe(
      input.postInstall.recoverScheduler,
    );
  });

  it("uses one explicit frozen absent profile for Executor-only", () => {
    expect(EXECUTOR_ONLY_PLANNED_DUTY_MIGRATION_LIFECYCLE).toEqual({
      kind: "absent",
      role: "executor-only",
    });
    expect(Object.isFrozen(EXECUTOR_ONLY_PLANNED_DUTY_MIGRATION_LIFECYCLE)).toBe(true);
  });

  it("rejects missing, extra, non-callable, and invalid absent profiles", () => {
    const input = createAnchorContribution();
    const { postInstall: _missing, ...missing } = input;
    expect(() => definePlannedDutyMigrationLifecycleContribution(
      missing as PlannedDutyMigrationAnchorLifecycleContribution,
    )).toThrow(/exact finite contract/u);
    expect(() => definePlannedDutyMigrationLifecycleContribution({
      ...input,
      secondOwner: {},
    } as unknown as PlannedDutyMigrationAnchorLifecycleContribution)).toThrow(
      /exact finite contract/u,
    );
    expect(() => definePlannedDutyMigrationLifecycleContribution({
      ...input,
      transfer: { ...input.transfer, drainAccepted: undefined },
    } as unknown as PlannedDutyMigrationAnchorLifecycleContribution)).toThrow(
      /effect is invalid: drainAccepted/u,
    );
    expect(() => definePlannedDutyMigrationLifecycleContribution({
      kind: "absent",
      role: "anchor",
    } as never)).toThrow(/absent profile is invalid/u);
  });
});
