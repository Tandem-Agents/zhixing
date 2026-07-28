import type {
  ChannelChallengeAction,
  ChannelRegistry,
  IConfirmationBroker,
} from "@zhixing/core";
import { isChallengeChannel } from "@zhixing/core";
import type {
  ConversationChannelChallengeToken,
  DataPlaneTicket,
  ExecutionRef,
} from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import {
  ChannelChallengeOutbox,
  type ConversationRunJournal,
} from "@zhixing/owner-kernel";
import {
  AssignmentStreamPathUnavailableError,
  type AssignmentStreamPathConnector,
} from "./assignment-stream-path-manager.js";
import {
  ConversationChannelHost,
} from "./conversation-channel-confirmation.js";
import type { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";
import type { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import {
  JobOwnerRelay,
  type JobChannelInteractionResolver,
  type JobOwnerRelayJournal,
} from "./job-owner-relay.js";
import type { MeshRuntimeAssembly } from "./mesh-runtime-assembly.js";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import type { AssignmentStreamClient } from "./assignment-stream-mesh.js";

const IDLE_POLL_MS = 100;

type ConversationRef = Extract<
  ExecutionRef,
  { readonly execution: "conversation" }
>;
type JobRef = Extract<ExecutionRef, { readonly execution: "job" }>;

export interface ConversationChannelSessionInput {
  readonly executorId: string;
  readonly assignmentId: string;
  readonly ref: ConversationRef;
  readonly ticket: DataPlaneTicket;
  readonly journal: ConversationRunJournal;
  readonly broker: IConfirmationBroker;
}

export interface LosslessDataPlaneSession {
  close(reason?: Error): Promise<void>;
}

/**
 * Product composition root for the S6 data plane.
 *
 * It keeps logical interaction ownership above transport selection: local and
 * mesh endpoints implement the same stream/ticket contracts, while channel
 * callbacks can only reach the executor through a signed owner-issued ticket.
 */
export class LosslessDataPlaneRuntime {
  readonly #authority: AuthorityRuntimeStack;
  readonly #local: ExecutorDataPlaneRuntime | undefined;
  readonly #mesh: () => MeshRuntimeAssembly | undefined;
  readonly #interactions: DurableConversationInteractionObserver;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #sessions = new Set<ConversationChannelSession>();
  readonly #byChallenge = new Map<string, ConversationChannelSession>();
  #channels: ChannelRegistry | undefined;
  #closed = false;

  constructor(options: {
    readonly authority: AuthorityRuntimeStack;
    readonly local?: ExecutorDataPlaneRuntime;
    readonly mesh: () => MeshRuntimeAssembly | undefined;
    readonly interactions: DurableConversationInteractionObserver;
    readonly onError?: (error: Error) => void;
  }) {
    this.#authority = options.authority;
    this.#local = options.local;
    this.#mesh = options.mesh;
    this.#interactions = options.interactions;
    this.#onError = options.onError;
  }

  bindChannels(channels: ChannelRegistry): void {
    if (this.#channels && this.#channels !== channels) {
      throw new Error("Lossless data plane is already bound to another channel registry");
    }
    this.#channels = channels;
  }

  async openConversationChannel(
    input: ConversationChannelSessionInput,
  ): Promise<LosslessDataPlaneSession> {
    if (this.#closed) throw new Error("Lossless data plane is closed");
    if (!this.#channels) {
      throw new Error("Channel data plane is not fully assembled");
    }
    const endpoint = this.#endpoint(input.executorId);
    await endpoint.accept(input.ticket);
    const connectors = this.#connectors(input.executorId);
    const host = new ConversationChannelHost({
      assignmentId: input.assignmentId,
      ref: input.ref,
      ticket: input.ticket,
      verifier: this.#authority.verifier,
      journal: input.journal,
      resolver: {
        resolve: async (answer) => {
          await endpoint.answer({
            assignmentId: answer.assignmentId,
            requestId: answer.requestId,
            ticketId: answer.ticketId,
            surfacePrincipal: answer.surfacePrincipal,
            decision:
              answer.decision.kind === "allow-once"
                ? { allowed: true }
                : {
                    allowed: false,
                    ...("reason" in answer.decision &&
                    typeof answer.decision.reason === "string"
                      ? { reason: answer.decision.reason }
                      : {}),
                  },
            broker: input.broker,
          });
          return true;
        },
      },
      ...connectors,
    });
    const session = new ConversationChannelSession({
      host,
      journal: input.journal,
      broker: input.broker,
      channels: this.#channels,
      onChallenge: (challengeId) => {
        const current = this.#byChallenge.get(challengeId);
        if (current && current !== session) {
          throw new Error("Channel challenge is owned by another active session");
        }
        this.#byChallenge.set(challengeId, session);
      },
      onClosed: (challengeIds) => {
        for (const challengeId of challengeIds) {
          if (this.#byChallenge.get(challengeId) === session) {
            this.#byChallenge.delete(challengeId);
          }
        }
        this.#sessions.delete(session);
      },
      onError: this.#onError,
    });
    this.#sessions.add(session);
    session.start();
    return session;
  }

  async createJobOwnerRelay(input: {
    readonly executorId: string;
    readonly assignmentId: string;
    readonly ref: JobRef;
    readonly controlLeaseId: string;
    readonly journal: JobOwnerRelayJournal;
    readonly resolver: JobChannelInteractionResolver;
  }): Promise<JobOwnerRelay> {
    if (this.#closed) throw new Error("Lossless data plane is closed");
    const connectors = this.#connectors(input.executorId);
    return JobOwnerRelay.create({
      assignmentId: input.assignmentId,
      ref: input.ref,
      consumer: {
        kind: "owner-relay",
        authority: {
          execution: "job",
          taskId: input.ref.taskId,
          anchorEpoch: input.ref.anchorEpoch,
        },
        controlLeaseId: input.controlLeaseId,
      },
      journal: input.journal,
      resolver: input.resolver,
      ...connectors,
    });
  }

  async handleChallengeAction(action: ChannelChallengeAction): Promise<void> {
    const session = this.#byChallenge.get(action.token.challengeId);
    if (!session) {
      throw new Error("Channel callback does not bind an active challenge");
    }
    await session.resolve(action);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const sessions = [...this.#sessions];
    await Promise.allSettled(
      sessions.map((session) =>
        session.close(new Error("Lossless data plane is stopping"))),
    );
    this.#sessions.clear();
    this.#byChallenge.clear();
  }

  #endpoint(executorId: string): {
    readonly accept: (ticket: DataPlaneTicket) => Promise<void>;
    readonly answer: (input: {
      readonly assignmentId: string;
      readonly requestId: string;
      readonly ticketId: string;
      readonly surfacePrincipal: string;
      readonly decision: { readonly allowed: boolean; readonly reason?: string };
      readonly broker: IConfirmationBroker;
    }) => Promise<void>;
  } {
    if (executorId === this.#authority.executorId) {
      const local = this.#local;
      if (!local) throw new Error("Local executor data plane is unavailable");
      return {
        accept: (ticket) => local.tickets.accept(ticket).then(() => undefined),
        answer: async (input) => {
          await local.tickets.authorizeOwnerPresentedSurface(
            input.ticketId,
            "interact",
            input.assignmentId,
          );
          const resolved = await this.#interactions.resolveWithSurfaceTicket(
            input.broker,
            {
              assignmentId: input.assignmentId,
              requestId: input.requestId,
              ticketId: input.ticketId,
              surfacePrincipal: input.surfacePrincipal,
              decision: input.decision.allowed
                ? { kind: "allow-once" }
                : {
                    kind: "deny",
                    ...(input.decision.reason
                      ? { reason: input.decision.reason }
                      : {}),
                  },
            },
          );
          if (!resolved) {
            throw new Error("Channel interaction is no longer pending");
          }
        },
      };
    }
    const remote = this.#mesh()?.dataPlaneForExecutor(executorId);
    if (!remote) throw new Error("Remote executor data plane is unavailable");
    return {
      accept: (ticket) => remote.tickets.accept(ticket),
      answer: (input) =>
        remote.tickets.answerChannel({
          assignmentId: input.assignmentId,
          requestId: input.requestId,
          ticketId: input.ticketId,
          surfacePrincipal: input.surfacePrincipal,
          decision: input.decision.allowed
            ? { kind: "allow-once" }
            : {
                kind: "deny",
                ...(input.decision.reason
                  ? { reason: input.decision.reason }
                  : {}),
              },
        }),
    };
  }

  #connectors(executorId: string): {
    readonly direct: AssignmentStreamPathConnector;
    readonly relay: AssignmentStreamPathConnector;
  } {
    const open = (): AssignmentStreamClient => {
      if (executorId === this.#authority.executorId) {
        const local = this.#local;
        if (!local) throw new Error("Local executor data plane is unavailable");
        return local.ownerStreamClient(this.#authority.deviceId);
      }
      const remote = this.#mesh()?.dataPlaneForExecutor(executorId);
      if (!remote) throw new Error("Remote executor data plane is unavailable");
      return remote.stream;
    };
    const connector = (label: "direct" | "relay"): AssignmentStreamPathConnector => ({
      async open() {
        try {
          return open();
        } catch (error) {
          throw new AssignmentStreamPathUnavailableError(
            `${label} assignment stream path is unavailable`,
            { cause: error },
          );
        }
      },
    });
    return {
      direct: connector("direct"),
      relay: connector("relay"),
    };
  }
}

class ConversationChannelSession implements LosslessDataPlaneSession {
  readonly #host: ConversationChannelHost;
  readonly #journal: ConversationRunJournal;
  readonly #broker: IConfirmationBroker;
  readonly #channels: ChannelRegistry;
  readonly #onChallenge: (challengeId: string) => void;
  readonly #onClosed: (challengeIds: ReadonlySet<string>) => void;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #controller = new AbortController();
  readonly #challengeIds = new Set<string>();
  #running: Promise<void> | undefined;

  constructor(options: {
    readonly host: ConversationChannelHost;
    readonly journal: ConversationRunJournal;
    readonly broker: IConfirmationBroker;
    readonly channels: ChannelRegistry;
    readonly onChallenge: (challengeId: string) => void;
    readonly onClosed: (challengeIds: ReadonlySet<string>) => void;
    readonly onError?: (error: Error) => void;
  }) {
    this.#host = options.host;
    this.#journal = options.journal;
    this.#broker = options.broker;
    this.#channels = options.channels;
    this.#onChallenge = options.onChallenge;
    this.#onClosed = options.onClosed;
    this.#onError = options.onError;
  }

  start(): void {
    if (this.#running) return;
    this.#running = this.#run().catch((error) => {
      if (!this.#controller.signal.aborted) this.#onError?.(asError(error));
    });
  }

  async resolve(action: ChannelChallengeAction): Promise<void> {
    const pending = await this.#journal.pendingChannelChallenges();
    const challenge = pending.find(
      (item) => item.prepared.token.challengeId === action.token.challengeId,
    );
    if (
      !challenge ||
      canonicalize(challenge.prepared.token) !== canonicalize(action.token)
    ) {
      throw new Error("Channel callback token differs from the durable challenge");
    }
    if (action.token.ref.execution !== "conversation") {
      throw new Error("Conversation channel received a job challenge");
    }
    const token = action.token as ConversationChannelChallengeToken;
    await this.#host.resolveCallback({
      token,
      responder: action.responder,
      decision: action.decision.allowed
        ? { kind: "allow-once" }
        : {
            kind: "deny",
            ...(action.decision.reason
              ? { reason: action.decision.reason }
              : {}),
          },
    });
  }

  async close(reason?: Error): Promise<void> {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(reason ?? new Error("Channel session closed"));
    }
    await this.#host.close(reason);
    await this.#running;
  }

  async #run(): Promise<void> {
    const outbox = new ChannelChallengeOutbox({
      store: this.#journal,
      sender: {
        send: async (input) => {
          const adapter = this.#channels.get(input.token.route.channelId);
          if (!adapter || !isChallengeChannel(adapter)) {
            throw new NonInteractiveChannelError(
              `Channel does not support signed challenges: ${input.token.route.channelId}`,
            );
          }
          const renderedDisplay =
            "title" in input.display
              ? input.display
              : await this.#host.materializeInteractionDisplay(
                  input.display,
                  input.signal,
                );
          const result = await adapter.sendChallenge({
            challengeId: input.challengeId,
            token: input.token,
            responder: input.responder,
            toolName: input.toolName,
            display: input.display,
            renderedDisplay,
          });
          if (!result.success) {
            const error =
              result.error ?? "Channel rejected the signed challenge";
            throw result.retryable
              ? new Error(error)
              : new NonInteractiveChannelError(error);
          }
          return {
            acceptedAt: new Date().toISOString(),
            ...(result.messageId
              ? {
                  platformMessage: {
                    channelId: input.token.route.channelId,
                    messageId: result.messageId,
                    ...(input.token.route.threadId
                      ? { threadId: input.token.route.threadId }
                      : {}),
                  },
                }
              : {}),
          };
        },
      },
    });
    try {
      while (!this.#controller.signal.aborted) {
        const result = await this.#host.poll(this.#controller.signal);
        const pending = await this.#journal.pendingChannelChallenges();
        for (const item of pending) {
          const challengeId = item.prepared.token.challengeId;
          this.#challengeIds.add(challengeId);
          this.#onChallenge(challengeId);
        }
        const drained = await outbox.drain(this.#controller.signal);
        for (const failure of drained.failures) {
          this.#onError?.(failure.error);
          if (failure.error instanceof NonInteractiveChannelError) {
            await this.#failClosed(failure.challengeId);
          }
        }
        if (result.accepted === 0) {
          await delay(IDLE_POLL_MS, this.#controller.signal);
        }
      }
    } finally {
      this.#onClosed(this.#challengeIds);
    }
  }

  async #failClosed(challengeId: string): Promise<void> {
    const pending = await this.#journal.pendingChannelChallenges();
    const challenge = pending.find(
      (item) => item.prepared.token.challengeId === challengeId,
    );
    if (!challenge) return;
    const resolve = this.#broker.resolveNonInteractiveDurably;
    if (!resolve) {
      throw new Error(
        "Channel confirmation broker cannot durably fail closed",
      );
    }
    await resolve.call(
      this.#broker,
      challenge.prepared.token.interactionRequestId,
    );
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

class NonInteractiveChannelError extends Error {}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
