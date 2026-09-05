import {
  ChannelInteractionCoordinator,
  JobRelayObligationDirectory,
} from "./channel-interaction-coordinator.js";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { JobStatusDirectory } from "./job-status-directory.js";
import { LosslessDataPlaneRuntime } from "./lossless-data-plane-runtime.js";
import {
  defineChannelChallengeDeliveryProfile,
  type ChannelChallengeDeliveryProfile,
} from "./lossless-data-plane-runtime.js";
import type { AssignmentDataPlaneTargetDirectory } from "./assignment-data-plane-topology.js";
import type { ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import type { ChannelChallengeAction } from "@zhixing/core";

export interface LosslessDataPlaneCompositionOptions {
  readonly verifier: ProtocolSignatureVerifier;
  readonly targets: AssignmentDataPlaneTargetDirectory;
  readonly jobRelayObligations?: JobRelayObligationDirectory;
  readonly protocol: Pick<ConversationProtocolRuntime, "bindLosslessDataPlane">;
  readonly channelChallenges: ChannelChallengeDeliveryProfile;
  readonly isCurrentOwner: () => boolean;
  readonly jobStatus: JobStatusDirectory;
  readonly onDataPlaneError?: (error: Error) => void;
  readonly onCoordinatorError?: (error: Error) => void;
}

export interface LosslessDataPlaneComposition {
  readonly runtime: LosslessDataPlaneRuntime;
  readonly coordinator: ChannelInteractionCoordinator;
  readonly jobRelayObligations: JobRelayObligationDirectory;
  readonly onChallengeAction: (action: ChannelChallengeAction) => Promise<void>;
  close(): Promise<void>;
}

/**
 * The product composition root for the complete S6 data plane.
 *
 * Runtime, interaction ownership and durable job obligations are assembled
 * together so production and conformance cannot define different wiring.
 */
export function createLosslessDataPlaneComposition(
  options: LosslessDataPlaneCompositionOptions,
): LosslessDataPlaneComposition {
  const channelChallenges = defineChannelChallengeDeliveryProfile(
    options.channelChallenges,
  );
  const runtime = new LosslessDataPlaneRuntime({
    verifier: options.verifier,
    targets: options.targets,
    channelChallenges,
    ...(options.onDataPlaneError
      ? { onError: options.onDataPlaneError }
      : {}),
  });
  const jobRelayObligations =
    options.jobRelayObligations ?? new JobRelayObligationDirectory();
  const coordinator = new ChannelInteractionCoordinator({
    dataPlane: runtime,
    channelChallenges,
    jobRelays: jobRelayObligations,
    jobStatus: options.jobStatus,
    ...(options.onCoordinatorError
      ? { onError: options.onCoordinatorError }
      : {}),
  });
  const onChallengeAction = Object.freeze(async (action: ChannelChallengeAction) => {
    if (!options.isCurrentOwner()) {
      throw new Error("Channel interaction is not owned by this device");
    }
    await coordinator.handleChallengeAction(action);
  });
  options.protocol.bindLosslessDataPlane(coordinator);
  let closing: Promise<void> | undefined;

  return {
    runtime,
    coordinator,
    jobRelayObligations,
    onChallengeAction,
    close() {
      closing ??= (async () => {
        const failures: unknown[] = [];
        try {
          await coordinator.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await runtime.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "Lossless data-plane composition failed to close cleanly",
          );
        }
      })();
      return closing;
    },
  };
}
