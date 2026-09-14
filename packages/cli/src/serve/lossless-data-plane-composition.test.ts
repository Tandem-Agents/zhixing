import { describe, expect, it, vi } from "vitest";
import { recoverChannelInteractions } from "./access-surfaces.js";
import { JobStatusDirectory } from "./job-status-directory.js";
import {
  createConversationLosslessDataPlaneAssemblyHandle,
  createLosslessDataPlaneComposition,
} from "./lossless-data-plane-composition.js";

describe("lossless data-plane static Channel composition", () => {
  it("recovers only a configured Channel after the coordinator has been supplied", async () => {
    const recover = vi.fn(async () => {});
    const channelCoordinator = { recover } as never;
    await expect(recoverChannelInteractions({} as never)).rejects.toThrow("complete S6 graph");
    await recoverChannelInteractions({
      channelMechanism: { kind: "absent", reason: "not-configured" },
      channelCoordinator,
    });
    expect(recover).not.toHaveBeenCalled();
    await recoverChannelInteractions({
      channelMechanism: { kind: "available", channels: {}, conversationProduct: {} } as never,
      channelCoordinator,
      startupLifecycle: { recoverAcceptedWork: false } as never,
    });
    expect(recover).not.toHaveBeenCalled();
    await recoverChannelInteractions({
      channelMechanism: { kind: "available", channels: {}, conversationProduct: {} } as never,
      channelCoordinator,
    });
    expect(recover).toHaveBeenCalledOnce();
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
