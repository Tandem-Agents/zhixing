import { describe, expect, it, vi } from "vitest";
import { JobStatusDirectory } from "./job-status-directory.js";
import { createLosslessDataPlaneComposition } from "./lossless-data-plane-composition.js";

describe("lossless data-plane static Channel composition", () => {
  it("publishes one frozen action callback only after the complete coordinator exists", async () => {
    let currentOwner = false;
    const bindLosslessDataPlane = vi.fn();
    const composition = createLosslessDataPlaneComposition({
      verifier: {} as never,
      targets: {
        targetForExecutor: () => {
          throw new Error("unused");
        },
      },
      protocol: { bindLosslessDataPlane },
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

    expect(bindLosslessDataPlane).toHaveBeenCalledWith(composition.coordinator);
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
