import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalConversationOwner, type CreateLocalConversationOwnerInput } from "../access-surfaces.js";
import { createConversationCommunicationAssemblyHandle } from "../conversation-tools.js";
import {
  LocalConversationOwnerAssembly,
  verifyLocalConversationFinal,
} from "../local-conversation-owner.js";
import { StartupRollback } from "../startup-rollback.js";
import { AssemblyLifecycleContributions } from "../assembly-lifecycle.js";


afterEach(() => {
  vi.restoreAllMocks();
});

describe("local conversation owner production surface", () => {

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

    const owner = await createLocalConversationOwner(Object.freeze(ctx));
    expect(create).toHaveBeenCalledTimes(1);
    expect(owner).toBe(assembly);
    expect(ctx).not.toHaveProperty("localConversationOwner");
    expect(events).toEqual([]);
    await rollback.rollback();
    expect(events).toEqual(["close"]);
  });

  it("rejects missing execution dependencies before creating a local owner", async () => {
    const create = vi.spyOn(LocalConversationOwnerAssembly, "create");
    await expect(createLocalConversationOwner({} as never)).rejects.toThrow("requires authority");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not recover a pending tool call before communication binding and retains the lifecycle gate", async () => {
    const communication = createConversationCommunicationAssemblyHandle();
    const invoke = vi.fn(async () => ({ conversations: [], partial: false }));
    const assembly = {
      start: vi.fn(async () => { await communication.port.invoke("recovered", { action: "discover" }); }),
      close: vi.fn(async () => undefined),
    } as unknown as LocalConversationOwnerAssembly;
    vi.spyOn(LocalConversationOwnerAssembly, "create").mockResolvedValue(assembly);
    const ctx = context(["executor"], new StartupRollback());
    const startupLifecycle = {
      kind: "executor-removal",
      artifactReady: true,
      recoverAcceptedWork: true,
      alreadySettled: false,
      delivery: {
        operationId: "removal-startup",
        sources: [],
        deliveries: [],
        sealed: false,
      },
    } as const;

    const owner = await createLocalConversationOwner(ctx);
    await Promise.resolve();
    expect(assembly.start).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    communication.bind({ invoke });
    await owner.start({ lifecycle: {
      operationId: startupLifecycle.delivery.operationId,
      kind: startupLifecycle.kind,
      recoverAcceptedWork: startupLifecycle.recoverAcceptedWork,
      alreadySettled: startupLifecycle.alreadySettled,
    } });
    expect(invoke).toHaveBeenCalledTimes(1);

    expect(assembly.start).toHaveBeenCalledWith({
      lifecycle: {
        operationId: "removal-startup",
        kind: "executor-removal",
        recoverAcceptedWork: true,
        alreadySettled: false,
      },
    });
    await ctx.lifecycleContributionsRollback.rollback();
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
): CreateLocalConversationOwnerInput & { lifecycleContributionsRollback: StartupRollback } {
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
    lifecycleContributionsRollback: startupRollback,
    meshBootstrap: { mode: "single-machine" },
    advancementConfiguration: {},
    lifecycleContributions: new AssemblyLifecycleContributions(startupRollback),
  } as unknown as CreateLocalConversationOwnerInput & { lifecycleContributionsRollback: StartupRollback };
}
