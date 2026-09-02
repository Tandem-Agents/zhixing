import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssemblyUnits } from "../access-surfaces.js";
import type { AssemblyContext } from "../access-surface.js";
import {
  LocalConversationOwnerAssembly,
  verifyLocalConversationFinal,
} from "../local-conversation-owner.js";
import { PROFILES } from "../profile.js";
import { StartupRollback } from "../startup-rollback.js";
import { AssemblyLifecycleContributions } from "../assembly-lifecycle.js";

const unit = createAssemblyUnits({}).find(
  (candidate) => candidate.name === "local-conversation-owner",
)!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local conversation owner production surface", () => {
  it("is an internal core unit immediately after the anchor conversation owner", () => {
    const names = createAssemblyUnits({}).map((candidate) => candidate.name);
    expect(PROFILES.full.surfaces).not.toContain("local-conversation-owner");
    expect(unit.kind).toBe("core");
    expect(unit.phase).toBe("pre-server");
    expect(names.indexOf("local-conversation-owner")).toBe(
      names.indexOf("conversation") + 1,
    );
  });

  it("creates exactly one owner for executor topologies and closes it through rollback", async () => {
    const events: string[] = [];
    const assembly = {
      start: vi.fn(async () => {
        events.push("start");
      }),
      close: vi.fn(async () => {
        events.push("close");
      }),
    } as unknown as LocalConversationOwnerAssembly;
    const create = vi
      .spyOn(LocalConversationOwnerAssembly, "create")
      .mockResolvedValue(assembly);
    const rollback = new StartupRollback();
    const ctx = context(["anchor", "executor"], rollback);

    await unit.setup(ctx);
    expect(create).toHaveBeenCalledTimes(1);
    expect(ctx.localConversationOwner).toBe(assembly);
    expect(events).toEqual(["start"]);
    await expect(unit.setup(ctx)).rejects.toThrow("already assembled");
    await rollback.rollback();
    expect(events).toEqual(["start", "close"]);
  });

  it("does not construct an owner when the executor role is absent", async () => {
    const create = vi.spyOn(LocalConversationOwnerAssembly, "create");
    const ctx = context(["anchor"], new StartupRollback());
    await unit.setup(ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.localConversationOwner).toBeUndefined();
  });

  it("starts with the durable lifecycle gate before conversation recovery", async () => {
    const assembly = {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as LocalConversationOwnerAssembly;
    vi.spyOn(LocalConversationOwnerAssembly, "create").mockResolvedValue(assembly);
    const ctx = context(["executor"], new StartupRollback());
    ctx.startupLifecycle = {
      kind: "removal",
      artifactReady: true,
      recoverAcceptedWork: true,
      alreadySettled: false,
      delivery: {
        operationId: "removal-startup",
        sources: [],
        deliveries: [],
        sealed: false,
      },
    };

    await unit.setup(ctx);

    expect(assembly.start).toHaveBeenCalledWith({
      lifecycle: {
        operationId: "removal-startup",
        kind: "removal",
        recoverAcceptedWork: true,
        alreadySettled: false,
      },
    });
    await ctx.startupRollback.rollback();
  });

  it("accepts only a final frame that is already present in authoritative history", async () => {
    const frame = {
      v: 1,
      t: "FinalFrame",
      conversationId: "local:device-abcdefgh:01J00000000000000000000000",
      runId: "run-final",
      commitRevision: 7,
      digest: `sha256:${"a".repeat(64)}`,
    } as const;
    const finalHistory = vi.fn(async () => [{ frame }]);
    const valid = { finalHistory } as never;
    await expect(verifyLocalConversationFinal(valid, frame)).resolves.toBeUndefined();
    expect(finalHistory).toHaveBeenCalledWith(frame.conversationId, 6);

    const absent = { finalHistory: vi.fn(async () => []) } as never;
    await expect(verifyLocalConversationFinal(absent, frame)).rejects.toThrow(
      "not present in authoritative history",
    );
  });
});

function context(
  enabledRoles: readonly ("anchor" | "executor")[],
  startupRollback: StartupRollback,
): AssemblyContext {
  const executorResources = {
    finalizeLocalAssignment: async () => ({ reportDigest: "sha256:" + "a".repeat(64), upToUsageSeq: 0 }),
    reclaimExpired: vi.fn(async () => 0),
    snapshot: vi.fn(async () => ({ reservations: new Map() })),
  };
  return {
    enabledRoles,
    authorityRuntime: {
      localDomainId: "local:device-abcdefgh",
      localOwnerEpoch: 1,
      localGovernorEpoch: 1,
      deviceId: "device-abcdefgh",
      executorId: "executor-local",
      signer: {},
      verifier: {},
      executorLog: {},
      artifacts: {},
      localControlAdmission: {},
      executorCapabilities: {},
      executorResourceGovernor: executorResources,
      permissionSnapshotFor: () => undefined,
      prepareLocalConversationAssignment: async () => ({}),
      validateConversationRuntimeBinding: () => undefined,
      preflightLocalConversationEnvironment: async () => undefined,
      releaseLocalConversationEnvironmentPreflight: () => undefined,
      validateLocalConversationManifest: () => undefined,
    },
    executorRoleModule: {
      ConversationAssignmentLedger: class {},
      InProcessAssignmentSubmission: class {},
    },
    assignmentRuntimeFactory: {},
    durableInteractions: {},
    executorDataPlane: {},
    evidenceHandler: {},
    config: {},
    startupRollback,
    lifecycleContributions: new AssemblyLifecycleContributions(startupRollback),
  } as unknown as AssemblyContext;
}
