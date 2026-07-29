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
  pendingChannelGrantDeliveries(): Promise<
    readonly ChannelInteractionGrant[]
  >;
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
  /**
   * job owner-relay 自身就是 owner 消费者,到 executor 只有一条真实路径
   * (本地进程内或 owner↔executor 连接)——不存在也不伪造第二条中继。
   */
  readonly connector: AssignmentStreamPathConnector;
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
  #grantDrain: Promise<number> | undefined;

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
      direct: options.connector,
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

  async poll(signal?: AbortSignal): Promise<AssignmentStreamPollResult> {
    await this.#drainGrantDeliveries();
    const result = await this.#manager.poll(signal);
    await this.#drainGrantDeliveries();
    return result;
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

  async #drainGrantDeliveries(): Promise<number> {
    if (this.#grantDrain) return this.#grantDrain;
    const running = (async () => {
      const pending = await this.#journal.pendingChannelGrantDeliveries();
      for (const grant of pending) {
        await this.#resolver.resolveGrant(grant);
      }
      return pending.length;
    })();
    this.#grantDrain = running;
    try {
      return await running;
    } finally {
      if (this.#grantDrain === running) this.#grantDrain = undefined;
    }
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
