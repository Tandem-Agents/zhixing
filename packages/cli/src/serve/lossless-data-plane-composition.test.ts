import { describe, expect, it, vi } from "vitest";
import { createAssemblyUnits } from "./access-surfaces.js";
import type { AssemblyContext } from "./access-surface.js";
import { JobStatusDirectory } from "./job-status-directory.js";
import {
  createConversationLosslessDataPlaneAssemblyHandle,
  createLosslessDataPlaneComposition,
} from "./lossless-data-plane-composition.js";

describe("lossless data-plane static Channel composition", () => {
  it("fails the Anchor pre-server boundary when its required edge was not completed", async () => {
    const units = createAssemblyUnits({});
    expect(units.filter((unit) => unit.name === "lossless-data-plane")).toHaveLength(1);
    const recovery = units.find(
      (unit) => unit.name === "channel-interaction-recovery",
    );
    if (!recovery) throw new Error("Missing Channel interaction recovery unit");

    await expect(recovery.setup({
      enabledRoles: ["anchor"],
      channelMechanism: Object.freeze({
        kind: "absent",
        reason: "not-configured",
      }),
    } as unknown as AssemblyContext)).rejects.toThrow(/not assembled/u);
    await expect(recovery.setup({
      enabledRoles: ["executor"],
    } as unknown as AssemblyContext)).resolves.toBeUndefined();
  });

  it("requires the private assembly handle to be completed exactly once", async () => {
    const assembly = createConversationLosslessDataPlaneAssemblyHandle();
    const recoverConversationChannels = vi.fn(async () => 3);
    const port = {
      openConversationChannel: vi.fn(),
      openFirstPartySurfaceSession: vi.fn(),
      recoverConversationChannels,
    } as never;

    expect(() => assembly.assertComplete()).toThrow(/not assembled/u);
    expect(() =>
      assembly.port.recoverConversationChannels({} as never)
    ).toThrow(/not assembled/u);

    assembly.complete(port);
    await expect(
      assembly.port.recoverConversationChannels({} as never),
    ).resolves.toBe(3);
    expect(recoverConversationChannels).toHaveBeenCalledOnce();
    expect(() => assembly.complete(port)).toThrow(/already assembled/u);
  });

  it("publishes one frozen action callback only after the complete coordinator exists", async () => {
    let currentOwner = false;
    const composition = createLosslessDataPlaneComposition({
      verifier: {} as never,
      targets: {
        targetForExecutor: () => {
          throw new Error("unused");
        },
      },
      channelChallenges: Object.freeze({
        kind: "available",
        delivery: Object.freeze({
          supports: () => true,
          sendChallenge: async () => ({ success: true, retryable: false }),
        }),
      }),
      isCurrentOwner: () => currentOwner,
      jobStatus: new JobStatusDirectory(),
    });
    const handleChallengeAction = vi
      .spyOn(composition.coordinator, "handleChallengeAction")
      .mockResolvedValue(undefined);

    expect(Object.isFrozen(composition.onChallengeAction)).toBe(true);
    await expect(composition.onChallengeAction({} as never)).rejects.toThrow(
      /not owned by this device/u,
    );
    expect(handleChallengeAction).not.toHaveBeenCalled();

    currentOwner = true;
    await composition.onChallengeAction({} as never);
    expect(handleChallengeAction).toHaveBeenCalledOnce();
    await composition.close();
  });
});
