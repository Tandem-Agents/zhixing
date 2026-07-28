import type { ChannelRegistry } from "@zhixing/core";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import {
  ChannelInteractionCoordinator,
  JobRelayObligationDirectory,
} from "./channel-interaction-coordinator.js";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";
import type { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import type { JobStatusDirectory } from "./job-status-directory.js";
import { LosslessDataPlaneRuntime } from "./lossless-data-plane-runtime.js";
import type { MeshRuntimeAssembly } from "./mesh-runtime-assembly.js";

export interface LosslessDataPlaneCompositionOptions {
  readonly authority: AuthorityRuntimeStack;
  readonly local?: ExecutorDataPlaneRuntime;
  readonly mesh: () => MeshRuntimeAssembly | undefined;
  readonly interactions: DurableConversationInteractionObserver;
  readonly protocol: Pick<ConversationProtocolRuntime, "bindLosslessDataPlane">;
  readonly channels: () => ChannelRegistry | undefined;
  readonly jobStatus: JobStatusDirectory;
  readonly onDataPlaneError?: (error: Error) => void;
  readonly onCoordinatorError?: (error: Error) => void;
}

export interface LosslessDataPlaneComposition {
  readonly runtime: LosslessDataPlaneRuntime;
  readonly coordinator: ChannelInteractionCoordinator;
  readonly jobRelayObligations: JobRelayObligationDirectory;
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
  const runtime = new LosslessDataPlaneRuntime({
    authority: options.authority,
    ...(options.local ? { local: options.local } : {}),
    mesh: options.mesh,
    interactions: options.interactions,
    ...(options.onDataPlaneError
      ? { onError: options.onDataPlaneError }
      : {}),
  });
  const jobRelayObligations = new JobRelayObligationDirectory();
  const coordinator = new ChannelInteractionCoordinator({
    dataPlane: runtime,
    channels: options.channels,
    jobRelays: jobRelayObligations,
    jobStatus: options.jobStatus,
    ...(options.onCoordinatorError
      ? { onError: options.onCoordinatorError }
      : {}),
  });
  options.protocol.bindLosslessDataPlane(coordinator);
  let closing: Promise<void> | undefined;

  return {
    runtime,
    coordinator,
    jobRelayObligations,
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
