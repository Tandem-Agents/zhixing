import type {
  ChannelInteractionGrant,
  ChannelResponderRef,
  InteractionDisplay,
  JobChannelChallengeToken,
  StreamConsumerAuth,
  StreamFrame,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  type InlineInteractionDisplay,
  validateStreamConsumerAuth,
  type StreamVerifierCheckpoint,
} from "@zhixing/core/protocol";
import type {
  JobChannelChallengePreparation,
  JobChannelRelayAdoption,
} from "@zhixing/owner-kernel";
import {
  AssignmentStreamPathManager,
  type AssignmentStreamPathConnector,
  type AssignmentStreamPollResult,
} from "./assignment-stream-path-manager.js";

type JobExecutionRef = Extract<
  import("@zhixing/core/contracts").ExecutionRef,
  { readonly execution: "job" }
>;
type OwnerRelayAuth = Extract<
  StreamConsumerAuth,
  { readonly kind: "owner-relay" }
>;

export interface JobOwnerRelayJournal {
  channelRelayCheckpoint(
    assignmentId: string,
  ): Promise<StreamVerifierCheckpoint | undefined>;
  adoptChannelRelayFrame(input: {
    readonly frame: StreamFrame;
    readonly checkpoint: StreamVerifierCheckpoint;
  }): Promise<JobChannelRelayAdoption>;
  prepareChannelRelayRequest(
    frame: StreamFrame,
  ): Promise<JobChannelChallengePreparation>;
  grantChannelChallenge(input: {
    readonly token: JobChannelChallengeToken;
    readonly responder: ChannelResponderRef;
    readonly decision: {
      readonly allowed: boolean;
      readonly reason?: string;
    };
    readonly at?: string;
  }): Promise<ChannelInteractionGrant>;
}

export interface JobChannelInteractionResolver {
  resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void>;
  resolveGrant(grant: ChannelInteractionGrant): Promise<void>;
}

export interface JobOwnerRelayOptions {
  readonly assignmentId: string;
  readonly ref: JobExecutionRef;
  readonly consumer: OwnerRelayAuth;
  readonly journal: JobOwnerRelayJournal;
  readonly resolver: JobChannelInteractionResolver;
  readonly direct: AssignmentStreamPathConnector;
  readonly relay: AssignmentStreamPathConnector;
  readonly maxPathAttempts?: number;
  readonly onPathsUnavailable?: ConstructorParameters<
    typeof AssignmentStreamPathManager
  >[0]["onPathsUnavailable"];
}

export class JobOwnerRelay {
  readonly #ref: JobExecutionRef;
  readonly #journal: JobOwnerRelayJournal;
  readonly #resolver: JobChannelInteractionResolver;
  readonly #manager: AssignmentStreamPathManager;

  private constructor(
    ref: JobExecutionRef,
    journal: JobOwnerRelayJournal,
    resolver: JobChannelInteractionResolver,
    manager: AssignmentStreamPathManager,
  ) {
    this.#ref = ref;
    this.#journal = journal;
    this.#resolver = resolver;
    this.#manager = manager;
  }

  static async create(options: JobOwnerRelayOptions): Promise<JobOwnerRelay> {
    const consumer = validateOwnerRelay(options.consumer, options.ref);
    const initialCheckpoint = await options.journal.channelRelayCheckpoint(
      options.assignmentId,
    );
    const manager = new AssignmentStreamPathManager({
      assignmentId: options.assignmentId,
      ref: options.ref,
      consumer,
      direct: options.direct,
      relay: options.relay,
      ...(initialCheckpoint ? { initialCheckpoint } : {}),
      ...(options.maxPathAttempts === undefined
        ? {}
        : { maxPathAttempts: options.maxPathAttempts }),
      ...(options.onPathsUnavailable === undefined
        ? {}
        : { onPathsUnavailable: options.onPathsUnavailable }),
      async adoptFrame(frame, checkpoint) {
        let prepared:
          | Extract<JobChannelChallengePreparation, { readonly kind: "prepared" }>["prepared"]
          | undefined;
        if (
          frame.payload.kind === "interaction" &&
          frame.payload.event.t === "requested"
        ) {
          const preparation =
            await options.journal.prepareChannelRelayRequest(frame);
          if (preparation.kind === "prepared") {
            await manager.materializeInteractionDisplay(
              frame.payload.event.display,
            );
            prepared = preparation.prepared;
          } else {
            await options.resolver.resolveNoInteractiveSurface({
              assignmentId: frame.assignmentId,
              requestId: frame.payload.event.requestId,
            });
          }
        }
        await options.journal.adoptChannelRelayFrame({
          frame,
          checkpoint,
          ...(prepared ? { prepared } : {}),
        });
      },
    });
    return new JobOwnerRelay(
      options.ref,
      options.journal,
      options.resolver,
      manager,
    );
  }

  checkpoint(): StreamVerifierCheckpoint {
    return this.#manager.checkpoint();
  }

  poll(signal?: AbortSignal): Promise<AssignmentStreamPollResult> {
    return this.#manager.poll(signal);
  }

  materializeInteractionDisplay(
    display: InteractionDisplay,
    signal?: AbortSignal,
  ): Promise<InlineInteractionDisplay> {
    return this.#manager.materializeInteractionDisplay(display, signal);
  }

  async resolveCallback(input: {
    readonly token: JobChannelChallengeToken;
    readonly responder: ChannelResponderRef;
    readonly decision: {
      readonly allowed: boolean;
      readonly reason?: string;
    };
    readonly at?: string;
  }): Promise<ChannelInteractionGrant> {
    const grant = await this.#journal.grantChannelChallenge(input);
    await this.#resolver.resolveGrant(grant);
    return grant;
  }

  async rotateControlLease(controlLeaseId: string): Promise<void> {
    const consumer = validateOwnerRelay(
      {
        kind: "owner-relay",
        authority: {
          execution: "job",
          taskId: this.#ref.taskId,
          anchorEpoch: this.#ref.anchorEpoch,
        },
        controlLeaseId,
      },
      this.#ref,
    );
    await this.#manager.updateConsumerAuth(consumer);
  }

  close(reason?: Error): Promise<void> {
    return this.#manager.close(reason);
  }
}

function validateOwnerRelay(
  input: OwnerRelayAuth,
  ref: JobExecutionRef,
): OwnerRelayAuth {
  const consumer = validateStreamConsumerAuth(input);
  if (
    consumer.kind !== "owner-relay" ||
    canonicalize(consumer.authority) !==
      canonicalize({
        execution: "job",
        taskId: ref.taskId,
        anchorEpoch: ref.anchorEpoch,
      })
  ) {
    throw new TypeError(
      "Owner relay authorization does not bind the job authority",
    );
  }
  return consumer;
}
