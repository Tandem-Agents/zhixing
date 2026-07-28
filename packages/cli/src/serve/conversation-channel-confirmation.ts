import type {
  ChannelResponderRef,
  ConversationChannelChallengeToken,
  DataPlaneTicket,
  ExecutionRef,
  InteractionDisplay,
  StreamFrame,
} from "@zhixing/core/contracts";
import type { ConfirmationDecision } from "@zhixing/core";
import {
  assertDataPlaneTicketActiveAt,
  assertDataPlaneTicketBinding,
  assertDataPlaneTicketUse,
  canonicalize,
  validateDataPlaneTicket,
  type ProtocolSignatureVerifier,
  type InlineInteractionDisplay,
  type StreamVerifierCheckpoint,
} from "@zhixing/core/protocol";
import type {
  ConversationChannelFrameAdoption,
} from "@zhixing/owner-kernel";
import {
  AssignmentStreamPathManager,
  type AssignmentStreamPathConnector,
  type AssignmentStreamPollResult,
} from "./assignment-stream-path-manager.js";

type ConversationExecutionRef = Extract<
  ExecutionRef,
  { readonly execution: "conversation" }
>;

export interface ConversationChannelJournal {
  adoptConversationChannelFrame(
    frame: StreamFrame,
  ): Promise<ConversationChannelFrameAdoption>;
  authorizeConversationChannelCallback(input: {
    readonly token: ConversationChannelChallengeToken;
    readonly responder: ChannelResponderRef;
    readonly at?: string;
  }): Promise<{
    readonly assignmentId: string;
    readonly interactionRequestId: string;
  }>;
}

export interface ConversationChannelInteractionResolver {
  resolve(input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly ticketId: string;
    readonly surfacePrincipal: string;
    readonly decision: Extract<
      ConfirmationDecision,
      { readonly kind: "allow-once" | "deny" }
    >;
  }): Promise<boolean>;
}

export interface ConversationChannelHostOptions {
  readonly assignmentId: string;
  readonly ref: ConversationExecutionRef;
  readonly ticket: DataPlaneTicket;
  readonly verifier: ProtocolSignatureVerifier;
  readonly journal: ConversationChannelJournal;
  readonly resolver: ConversationChannelInteractionResolver;
  /**
   * 渠道宿主坐在 owner/anchor 位置,只有一条到 executor 的真实路径
   * (本地进程内或 owner↔executor 连接)——不存在也不伪造第二条中继。
   */
  readonly connector: AssignmentStreamPathConnector;
  readonly now?: () => string;
  readonly initialCheckpoint?: StreamVerifierCheckpoint;
  readonly maxPathAttempts?: number;
  readonly onConsumerDegraded?: ConstructorParameters<
    typeof AssignmentStreamPathManager
  >[0]["onConsumerDegraded"];
}

/**
 * Owns the channel surface's local ticket while channel callbacks carry only
 * their signed challenge. Stream adoption is completed before the path manager
 * advances the executor ACK.
 */
export class ConversationChannelHost {
  #ticket: Extract<DataPlaneTicket, { readonly kind: "run-interact" }>;
  readonly #journal: ConversationChannelJournal;
  readonly #resolver: ConversationChannelInteractionResolver;
  readonly #now: () => string;
  readonly #manager: AssignmentStreamPathManager;

  constructor(options: ConversationChannelHostOptions) {
    const ticket = validateDataPlaneTicket(options.ticket, options.verifier);
    assertDataPlaneTicketUse(ticket, "interact");
    if (ticket.kind !== "run-interact") {
      throw new TypeError(
        "Conversation channel confirmation requires an interaction ticket",
      );
    }
    assertDataPlaneTicketBinding(ticket, {
      assignmentId: options.assignmentId,
      ref: options.ref,
      executorId: ticket.executorId,
      surfacePrincipal: ticket.surfacePrincipal,
    });
    this.#now = options.now ?? (() => new Date().toISOString());
    assertDataPlaneTicketActiveAt(ticket, this.#now());
    this.#ticket = ticket;
    this.#journal = options.journal;
    this.#resolver = options.resolver;
    this.#manager = new AssignmentStreamPathManager({
      assignmentId: options.assignmentId,
      ref: options.ref,
      consumer: {
        kind: "surface-ticket",
        ticketId: ticket.ticketId,
      },
      direct: options.connector,
      ...(options.initialCheckpoint
        ? { initialCheckpoint: options.initialCheckpoint }
        : {}),
      ...(options.maxPathAttempts === undefined
        ? {}
        : { maxPathAttempts: options.maxPathAttempts }),
      ...(options.onConsumerDegraded === undefined
        ? {}
        : { onConsumerDegraded: options.onConsumerDegraded }),
      adoptFrame: async (frame) => {
        if (
          frame.payload.kind === "interaction" &&
          frame.payload.event.t === "requested"
        ) {
          await this.#manager.materializeInteractionDisplay(
            frame.payload.event.display,
          );
        }
        await this.#journal.adoptConversationChannelFrame(frame);
      },
    });
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
    readonly token: ConversationChannelChallengeToken;
    readonly responder: ChannelResponderRef;
    readonly decision: Extract<
      ConfirmationDecision,
      { readonly kind: "allow-once" | "deny" }
    >;
    readonly at?: string;
  }): Promise<boolean> {
    const at = input.at ?? this.#now();
    assertDataPlaneTicketActiveAt(this.#ticket, at);
    const authorized = await this.#journal.authorizeConversationChannelCallback({
      token: input.token,
      responder: input.responder,
      at,
    });
    if (authorized.assignmentId !== this.#ticket.assignmentId) {
      throw new TypeError(
        "Conversation channel callback belongs to a different assignment",
      );
    }
    return this.#resolver.resolve({
      assignmentId: authorized.assignmentId,
      requestId: authorized.interactionRequestId,
      ticketId: this.#ticket.ticketId,
      surfacePrincipal: this.#ticket.surfacePrincipal,
      decision: input.decision,
    });
  }

  async rotateTicket(
    ticketInput: DataPlaneTicket,
    verifier: ProtocolSignatureVerifier,
  ): Promise<void> {
    const ticket = validateDataPlaneTicket(ticketInput, verifier);
    assertDataPlaneTicketUse(ticket, "interact");
    if (
      ticket.kind !== "run-interact" ||
      ticket.assignmentId !== this.#ticket.assignmentId ||
      canonicalize(ticket.ref) !== canonicalize(this.#ticket.ref) ||
      ticket.executorId !== this.#ticket.executorId ||
      ticket.surfacePrincipal !== this.#ticket.surfacePrincipal
    ) {
      throw new TypeError(
        "Replacement channel ticket changes the interaction authority",
      );
    }
    if (ticket.ticketId !== this.#ticket.ticketId) {
      throw new TypeError(
        "Replacing a channel ticket requires a new logical host",
      );
    }
    assertDataPlaneTicketActiveAt(ticket, this.#now());
    this.#ticket = ticket;
    await this.#manager.updateConsumerAuth({
      kind: "surface-ticket",
      ticketId: ticket.ticketId,
    });
  }

  close(reason?: Error): Promise<void> {
    return this.#manager.close(reason);
  }
}
