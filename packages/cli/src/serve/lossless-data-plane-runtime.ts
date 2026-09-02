import type {
  ChannelChallengeAction,
  ChannelChallengeMessage,
  DeliveryResult,
} from "@zhixing/core";
import type {
  ConversationChannelChallengeToken,
  DataPlaneTicket,
  ExecutionRef,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  type ProtocolSignatureVerifier,
  type StreamVerifierCheckpoint,
} from "@zhixing/core/protocol";
import {
  ChannelChallengeOutbox,
  type ConversationRunJournal,
} from "@zhixing/owner-kernel";
import {
  AssignmentStreamPathManager,
  AssignmentStreamPathsUnavailableError,
  AssignmentStreamPathUnavailableError,
  mapConnectionTransportFailures,
  type AssignmentStreamPath,
  type AssignmentStreamPathConnector,
  type AssignmentStreamPathManagerOptions,
  type AssignmentStreamPollResult,
} from "./assignment-stream-path-manager.js";
import {
  ConversationChannelHost,
} from "./conversation-channel-confirmation.js";
import {
  ConversationInteractionRuntimeUnavailableError,
} from "./durable-conversation-interactions.js";
import {
  JobOwnerRelay,
  type JobChannelInteractionResolver,
  type JobOwnerRelayJournal,
} from "./job-owner-relay.js";
import type { AssignmentStreamClient } from "./assignment-stream-mesh.js";
import type { AssignmentDataPlaneTargetDirectory } from "./assignment-data-plane-topology.js";

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
}

export interface LosslessDataPlaneSession {
  close(reason?: Error): Promise<void>;
}

export interface FirstPartySurfaceSession extends LosslessDataPlaneSession {
  readonly path: AssignmentStreamPath | undefined;
  start(): void;
  poll(signal?: AbortSignal): Promise<AssignmentStreamPollResult>;
  restoreDirect(): Promise<void>;
  checkpoint(): StreamVerifierCheckpoint;
  waitForSeq(seq: number, signal?: AbortSignal): Promise<void>;
}

export interface FirstPartySurfaceSessionInput {
  readonly executorId: string;
  readonly assignmentId: string;
  readonly ref: ExecutionRef;
  readonly ticket: DataPlaneTicket;
  readonly surfacePrincipal: string;
  readonly adoptFrame: AssignmentStreamPathManagerOptions["adoptFrame"];
  readonly initialCheckpoint?: StreamVerifierCheckpoint;
  readonly maxPathAttempts?: number;
  readonly onConsumerDegraded?: AssignmentStreamPathManagerOptions["onConsumerDegraded"];
  readonly onPathsUnavailable?: AssignmentStreamPathManagerOptions["onPathsUnavailable"];
}

export interface JobOwnerRelayInput {
  readonly executorId: string;
  readonly assignmentId: string;
  readonly ref: JobRef;
  readonly controlLeaseId: string;
  readonly journal: JobOwnerRelayJournal;
  readonly resolver: JobChannelInteractionResolver;
}

/** Finite signed-challenge effect required by the lossless interaction plane. */
export interface ChannelChallengeDeliveryPort {
  supports(channelId: string): boolean;
  sendChallenge(message: ChannelChallengeMessage): Promise<DeliveryResult>;
}

/**
 * Product composition root for the S6 data plane.
 *
 * It keeps logical interaction ownership above transport selection: local and
 * mesh endpoints implement the same stream/ticket contracts, while channel
 * callbacks can only reach the executor through a signed owner-issued ticket.
 */
export class LosslessDataPlaneRuntime {
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #targets: AssignmentDataPlaneTargetDirectory;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #sessions = new Set<LosslessDataPlaneSession>();
  readonly #byChallenge = new Map<string, ConversationChannelSession>();
  #channelChallenges: ChannelChallengeDeliveryPort | undefined;
  #closed = false;

  constructor(options: {
    readonly verifier: ProtocolSignatureVerifier;
    readonly targets: AssignmentDataPlaneTargetDirectory;
    readonly onError?: (error: Error) => void;
  }) {
    this.#verifier = options.verifier;
    this.#targets = options.targets;
    this.#onError = options.onError;
  }

  bindChannelChallenges(channelChallenges: ChannelChallengeDeliveryPort): void {
    if (this.#channelChallenges && this.#channelChallenges !== channelChallenges) {
      throw new Error("Lossless data plane is already bound to another channel challenge port");
    }
    this.#channelChallenges = channelChallenges;
  }

  async openConversationChannel(
    input: ConversationChannelSessionInput,
  ): Promise<LosslessDataPlaneSession> {
    if (this.#closed) throw new Error("Lossless data plane is closed");
    if (!this.#channelChallenges) {
      throw new Error("Channel data plane is not fully assembled");
    }
    const endpoint = this.#targets.targetForExecutor(input.executorId);
    await endpoint.acceptTicket(input.ticket);
    const host = new ConversationChannelHost({
      assignmentId: input.assignmentId,
      ref: input.ref,
      ticket: input.ticket,
      verifier: this.#verifier,
      journal: input.journal,
      resolver: {
        resolve: async (answer) => {
          await endpoint.answerChannel({
            assignmentId: answer.assignmentId,
            requestId: answer.requestId,
            ticketId: answer.ticketId,
            surfacePrincipal: answer.surfacePrincipal,
            decision: answer.decision,
          });
          return true;
        },
      },
      connector: this.#ownerPathConnector(input.executorId),
    });
    const session = new ConversationChannelSession({
      host,
      journal: input.journal,
      resolveNoInteractiveSurface: (requestId) =>
        endpoint.resolveNoInteractiveSurface({
          assignmentId: input.assignmentId,
          requestId,
        }),
      channelChallenges: this.#channelChallenges,
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

  async createJobOwnerRelay(input: JobOwnerRelayInput): Promise<JobOwnerRelay> {
    if (this.#closed) throw new Error("Lossless data plane is closed");
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
      connector: this.#ownerPathConnector(input.executorId),
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

  /**
   * owner/anchor 位置到 executor 的唯一真实路径:本地 executor 走进程内
   * 端点,远程走 owner↔executor 连接;建连与流中传输失败统一映射为
   * 路径不可用,交由路径管理器有界重连。渠道宿主与 job owner-relay 只
   * 持这一条路径——它们自身即中继点,不伪造第二条拓扑。
   */
  #ownerPathConnector(executorId: string): AssignmentStreamPathConnector {
    const resolve = (): AssignmentStreamClient => {
      return this.#targets.targetForExecutor(executorId).ownerStream();
    };
    return {
      async open() {
        let client: AssignmentStreamClient;
        try {
          client = resolve();
        } catch (error) {
          throw new AssignmentStreamPathUnavailableError(
            "owner assignment stream path is unavailable",
            { cause: error },
          );
        }
        return mapConnectionTransportFailures(client, "owner");
      },
    };
  }

  /**
   * 第一方 surface 会话的双路径:direct 以本会话自己的端点直连 executor,
   * relay 经 owner 转发段走同一 executor——两条链路组件互相独立、可独立
   * 失败与恢复;subscribe/ack/readArtifact 携同一 surface-ticket 消费身份,
   * 授权与水位跨路径不变。
   */
  async openFirstPartySurfaceSession(
    input: FirstPartySurfaceSessionInput,
  ): Promise<FirstPartySurfaceSession> {
    if (this.#closed) throw new Error("Lossless data plane is closed");
    if (input.ticket.surfacePrincipal !== input.surfacePrincipal) {
      throw new TypeError(
        "First-party surface session principal differs from its ticket",
      );
    }
    const endpoint = this.#targets.targetForExecutor(input.executorId);
    await endpoint.acceptTicket(input.ticket);
    const consumer = {
      kind: "surface-ticket" as const,
      ticketId: input.ticket.ticketId,
    };
    const manager = new AuthenticatedFirstPartySurfaceAdapter({
      assignmentId: input.assignmentId,
      ref: input.ref,
      consumer,
      direct: this.#firstPartyDirectConnector(
        input.executorId,
        input.surfacePrincipal,
      ),
      relay: this.#ownerForwardConnector(input.executorId),
      adoptFrame: input.adoptFrame,
      ...(input.initialCheckpoint
        ? { initialCheckpoint: input.initialCheckpoint }
        : {}),
      ...(input.maxPathAttempts === undefined
        ? {}
        : { maxPathAttempts: input.maxPathAttempts }),
      ...(input.onConsumerDegraded === undefined
        ? {}
        : { onConsumerDegraded: input.onConsumerDegraded }),
      ...(input.onPathsUnavailable === undefined
        ? {}
        : { onPathsUnavailable: input.onPathsUnavailable }),
    }).manager;
    const session = new ManagedFirstPartySurfaceSession({
      manager,
      onClosed: () => this.#sessions.delete(session),
      onError: this.#onError,
    });
    this.#sessions.add(session);
    return session;
  }

  #firstPartyDirectConnector(
    executorId: string,
    surfacePrincipal: string,
  ): AssignmentStreamPathConnector {
    const runtime = this;
    return {
      async open() {
        let client: AssignmentStreamClient | undefined;
        try {
          client = runtime.#targets
            .targetForExecutor(executorId)
            .directSurfaceStream(surfacePrincipal);
        } catch (error) {
          throw new AssignmentStreamPathUnavailableError(
            "direct assignment stream path is unavailable",
            { cause: error },
          );
        }
        if (!client) {
          throw new AssignmentStreamPathUnavailableError(
            "direct assignment stream path is unavailable",
          );
        }
        return mapConnectionTransportFailures(client, "direct");
      },
    };
  }

  /**
   * 第一方 relay 的 owner 转发段:请求原样携 surface 消费身份经 owner 的
   * executor 路径转发。转发段随本 runtime 关闭而失效,是独立于 direct 的
   * 真实失败面。
   */
  #ownerForwardConnector(executorId: string): AssignmentStreamPathConnector {
    const runtime = this;
    const ownerPath = this.#ownerPathConnector(executorId);
    return {
      async open(request) {
        if (runtime.#closed) {
          throw new AssignmentStreamPathUnavailableError(
            "relay assignment stream path is closed",
          );
        }
        if (request.consumer.kind !== "surface-ticket") {
          throw new TypeError(
            "Owner stream forwarding serves surface consumers only",
          );
        }
        const upstream = await ownerPath.open(request);
        const forward = async <T>(operate: () => Promise<T>): Promise<T> => {
          if (runtime.#closed) {
            throw new AssignmentStreamPathUnavailableError(
              "relay assignment stream path is closed",
            );
          }
          return operate();
        };
        return mapConnectionTransportFailures(
          {
            subscribe: (subscribeRequest, signal) =>
              forward(() => upstream.subscribe(subscribeRequest, signal)),
            acknowledge: (ack, signal) =>
              forward(() => upstream.acknowledge(ack, signal)),
            ...(upstream.readArtifact
              ? {
                  readArtifact: (readRequest, signal) =>
                    forward(() => {
                      const read = upstream.readArtifact;
                      if (!read) {
                        throw new TypeError(
                          "Owner stream forwarding lost artifact reads",
                        );
                      }
                      return read.call(upstream, readRequest, signal);
                    }),
                }
              : {}),
            ...(upstream.close
              ? { close: (reason?: Error) => upstream.close?.(reason) }
              : {}),
          },
          "relay",
        );
      },
    };
  }
}

class ConversationChannelSession implements LosslessDataPlaneSession {
  readonly #host: ConversationChannelHost;
  readonly #journal: ConversationRunJournal;
  readonly #resolveNoInteractiveSurface: (requestId: string) => Promise<void>;
  readonly #channelChallenges: ChannelChallengeDeliveryPort;
  readonly #onChallenge: (challengeId: string) => void;
  readonly #onClosed: (challengeIds: ReadonlySet<string>) => void;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #controller = new AbortController();
  readonly #challengeIds = new Set<string>();
  #running: Promise<void> | undefined;

  constructor(options: {
    readonly host: ConversationChannelHost;
    readonly journal: ConversationRunJournal;
    readonly resolveNoInteractiveSurface: (requestId: string) => Promise<void>;
    readonly channelChallenges: ChannelChallengeDeliveryPort;
    readonly onChallenge: (challengeId: string) => void;
    readonly onClosed: (challengeIds: ReadonlySet<string>) => void;
    readonly onError?: (error: Error) => void;
  }) {
    this.#host = options.host;
    this.#journal = options.journal;
    this.#resolveNoInteractiveSurface = options.resolveNoInteractiveSurface;
    this.#channelChallenges = options.channelChallenges;
    this.#onChallenge = options.onChallenge;
    this.#onClosed = options.onClosed;
    this.#onError = options.onError;
  }

  start(): void {
    if (this.#running) return;
    this.#running = this.#run().catch((error) => {
      if (!this.#controller.signal.aborted) {
        const failure = asError(error);
        this.#onError?.(failure);
      }
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
          if (!this.#channelChallenges.supports(input.token.route.channelId)) {
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
          const result = await this.#channelChallenges.sendChallenge({
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
            try {
              await this.#failClosed(failure.challengeId);
            } catch (error) {
              if (
                error instanceof ConversationInteractionRuntimeUnavailableError
              ) {
                this.#onError?.(error);
                continue;
              }
              throw error;
            }
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
    await this.#resolveNoInteractiveSurface(
      challenge.prepared.token.interactionRequestId,
    );
  }
}

/**
 * One authenticated first-party surface owns one path manager. The owner
 * runtime may supply the relay capability, but it cannot mutate the surface's
 * selected path, verifier checkpoint or ACK state.
 */
class AuthenticatedFirstPartySurfaceAdapter {
  readonly manager: AssignmentStreamPathManager;

  constructor(options: AssignmentStreamPathManagerOptions) {
    this.manager = new AssignmentStreamPathManager(options);
  }
}

class ManagedFirstPartySurfaceSession implements FirstPartySurfaceSession {
  readonly #manager: AssignmentStreamPathManager;
  readonly #onClosed: () => void;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #controller = new AbortController();
  readonly #waiters = new Set<{
    readonly seq: number;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly cleanup: () => void;
  }>();
  #running: Promise<void> | undefined;
  #acknowledgedSeq: number;
  #closed = false;

  constructor(options: {
    readonly manager: AssignmentStreamPathManager;
    readonly onClosed: () => void;
    readonly onError?: (error: Error) => void;
  }) {
    this.#manager = options.manager;
    this.#onClosed = options.onClosed;
    this.#onError = options.onError;
    this.#acknowledgedSeq = options.manager.checkpoint().lastSeq;
  }

  get path(): AssignmentStreamPath | undefined {
    return this.#manager.path;
  }

  start(): void {
    if (this.#running) return;
    this.#running = this.#run().catch((error) => {
      const failure = asError(error);
      this.#rejectWaiters(failure);
      if (!this.#controller.signal.aborted) this.#onError?.(failure);
    });
  }

  async poll(signal?: AbortSignal): Promise<AssignmentStreamPollResult> {
    const result = await this.#manager.poll(signal);
    this.#observed(result.checkpoint.lastSeq);
    return result;
  }

  restoreDirect(): Promise<void> {
    return this.#manager.restoreDirect();
  }

  checkpoint(): StreamVerifierCheckpoint {
    return this.#manager.checkpoint();
  }

  waitForSeq(seq: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError("Assignment stream wait sequence is invalid");
    }
    if (this.#acknowledgedSeq >= seq) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.#waiters.delete(waiter);
        reject(signal?.reason ?? new Error("Assignment stream wait aborted"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const waiter = { seq, resolve, reject, cleanup };
      this.#waiters.add(waiter);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #observed(seq: number): void {
    this.#acknowledgedSeq = Math.max(this.#acknowledgedSeq, seq);
    for (const waiter of [...this.#waiters]) {
      if (seq < waiter.seq) continue;
      this.#waiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve();
    }
  }

  async close(reason?: Error): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closed = reason ?? new Error("First-party surface session closed");
    if (!this.#controller.signal.aborted) this.#controller.abort(closed);
    for (const waiter of this.#waiters) {
      waiter.cleanup();
      waiter.reject(closed);
    }
    this.#waiters.clear();
    await this.#manager.close(closed);
    await this.#running;
    this.#onClosed();
  }

  async #run(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      try {
        const result = await this.poll(this.#controller.signal);
        if (result.accepted > 0) continue;
      } catch (error) {
        if (this.#controller.signal.aborted) throw error;
        if (!(error instanceof AssignmentStreamPathsUnavailableError)) {
          throw error;
        }
        this.#onError?.(error);
      }
      if (!this.#controller.signal.aborted) {
        await delay(IDLE_POLL_MS, this.#controller.signal);
      }
    }
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      waiter.cleanup();
      waiter.reject(error);
    }
    this.#waiters.clear();
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
