import type {
  ChannelChallengeAction,
  ChannelRegistry,
} from "@zhixing/core";
import { isChallengeChannel } from "@zhixing/core";
import type {
  DataPlaneTicket,
  ChannelInteractionGrant,
  ExecutionRef,
} from "@zhixing/core/contracts";
import {
  ChannelChallengeOutbox,
  channelSurfacePrincipal,
  type ConversationRunJournal,
  type ChannelChallengeOutboxStore,
} from "@zhixing/owner-kernel";
import { canonicalize } from "@zhixing/core/protocol";
import type {
  ConversationChannelSessionInput,
  LosslessDataPlaneRuntime,
  LosslessDataPlaneSession,
} from "./lossless-data-plane-runtime.js";
import type {
  JobStatusDirectory,
  JobStatusSource,
} from "./job-status-directory.js";
import type {
  JobOwnerRelay,
  JobOwnerRelayJournal,
} from "./job-owner-relay.js";

const IDLE_POLL_MS = 100;

type JobRef = Extract<ExecutionRef, { readonly execution: "job" }>;

/** job 渠道义务的耐久事实源:relay 游标 + challenge outbox + grant 签发。 */
export interface JobChannelObligationJournal
  extends JobOwnerRelayJournal,
    ChannelChallengeOutboxStore,
    JobStatusSource {}

export interface JobRelayOpening {
  readonly assignmentId: string;
  readonly ref: JobRef;
  readonly executorId: string;
  readonly controlLeaseId: string;
  readonly journal: JobChannelObligationJournal;
  /** grant 的 executor 转交半边:进程内走 ledger 提交链、跨机走 mesh。 */
  readonly deliverGrant: (grant: ChannelInteractionGrant) => Promise<void>;
  /** 无合法应答面时通知 executor fail-closed 自动解决。 */
  readonly resolveNoInteractiveSurface: (input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }) => Promise<void>;
}

/**
 * job owner 的开放中继义务目录。目录只保存当前进程的装配引用；义务事实
 * 仍在各 JobJournal，job owner 重建 journal 后必须重新登记，协调器随后
 * 统一 recover。这样第 26 单元只提供任务发现，不会再造 relay 生命周期。
 */
export class JobRelayObligationDirectory {
  readonly #openings = new Map<string, JobRelayOpening>();

  register(opening: JobRelayOpening): () => void {
    if (this.#openings.has(opening.assignmentId)) {
      throw new Error("Job relay assignment is already registered");
    }
    this.#openings.set(opening.assignmentId, opening);
    return once(() => {
      if (this.#openings.get(opening.assignmentId) === opening) {
        this.#openings.delete(opening.assignmentId);
      }
    });
  }

  async listOpen(): Promise<readonly JobRelayOpening[]> {
    return [...this.#openings.values()].sort((left, right) =>
      left.assignmentId.localeCompare(right.assignmentId, "en-US"),
    );
  }
}

export interface ChannelInteractionCoordinatorOptions {
  readonly dataPlane: Pick<
    LosslessDataPlaneRuntime,
    | "openConversationChannel"
    | "openFirstPartySurfaceSession"
    | "createJobOwnerRelay"
    | "handleChallengeAction"
  >;
  readonly channels: () => ChannelRegistry | undefined;
  /** job owner 从耐久 JobJournal 重建并登记的开放义务；不得缺省。 */
  readonly jobRelays: JobRelayObligationDirectory;
  readonly jobStatus: JobStatusDirectory;
  readonly now?: () => string;
  readonly onError?: (error: Error) => void;
}

/**
 * owner 作用域唯一的渠道交互长期所有者。
 *
 * 义务的事实源永远是权威日志(conversation run 流与 job 流的
 * prepared/cursor/granted/closed 记录);本协调器的注册表只是路由投影,
 * 崩溃后由 recover() 与会话重建恢复。渠道 callback 从这里进入:活跃义务
 * 命中即路由,耐久裁决完成后才向平台确认;两域凭证在类型与路由上互不
 * 可达——conversation token 走 surface-ticket 会话,job token 走 grant 链。
 */
export class ChannelInteractionCoordinator {
  readonly #dataPlane: ChannelInteractionCoordinatorOptions["dataPlane"];
  readonly #channels: ChannelInteractionCoordinatorOptions["channels"];
  readonly #jobRelays: JobRelayObligationDirectory;
  readonly #jobStatus: JobStatusDirectory;
  readonly #now: () => string;
  readonly #jobStatusSources = new Map<
    string,
    {
      readonly source: JobStatusSource;
      readonly unregister: () => void;
      count: number;
    }
  >();
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #conversations = new Map<string, LosslessDataPlaneSession>();
  readonly #jobs = new Map<string, JobChannelSession>();
  #closed = false;

  constructor(options: ChannelInteractionCoordinatorOptions) {
    this.#dataPlane = options.dataPlane;
    this.#channels = options.channels;
    this.#jobRelays = options.jobRelays;
    this.#jobStatus = options.jobStatus;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onError = options.onError;
  }

  /** conversation 渠道义务的幂等采用:同 assignment 复用活跃会话。 */
  async openConversationChannel(
    input: ConversationChannelSessionInput,
  ): Promise<LosslessDataPlaneSession> {
    if (this.#closed) throw new Error("Channel interaction coordinator is closed");
    const existing = this.#conversations.get(input.assignmentId);
    if (existing) return existing;
    const opened = await this.#dataPlane.openConversationChannel(input);
    const session: LosslessDataPlaneSession = {
      close: async (reason?: Error) => {
        this.#conversations.delete(input.assignmentId);
        await opened.close(reason);
      },
    };
    this.#conversations.set(input.assignmentId, session);
    return session;
  }

  /**
   * conversation 渠道会话只由 run journal 的未关闭 challenge 与票据事实
   * 重建；不得依赖崩溃前的 broker/session 引用。一个 assignment 的多个
   * pending challenge 共用同一 opening。
   */
  async recoverConversationChannels(
    journal: ConversationRunJournal,
  ): Promise<number> {
    if (this.#closed) return 0;
    const [pending, facts] = await Promise.all([
      journal.pendingChannelChallenges(),
      journal.dataPlaneTicketFacts(),
    ]);
    const revoked = new Set(facts.revokedTicketIds);
    const openings = new Map<
      string,
      { readonly ticket: DataPlaneTicket; readonly ref: Extract<ExecutionRef, {
        readonly execution: "conversation";
      }> }
    >();
    for (const item of pending) {
      const prepared = item.prepared;
      if (prepared.ref.execution !== "conversation") {
        throw new TypeError(
          "Conversation challenge recovery received a non-conversation reference",
        );
      }
      const expectedSurface = channelSurfacePrincipal(prepared.responder);
      const ticket = facts.issued.find(
        (candidate) =>
          candidate.kind === "run-interact" &&
          candidate.assignmentId === prepared.assignmentId &&
          !revoked.has(candidate.ticketId) &&
          candidate.surfacePrincipal === expectedSurface &&
          canonicalize(candidate.ref) === canonicalize(prepared.ref),
      );
      if (!ticket) {
        throw new Error(
          "Pending conversation challenge has no active durable interaction ticket",
        );
      }
      const existing = openings.get(prepared.assignmentId);
      if (
        existing &&
        (existing.ticket.ticketId !== ticket.ticketId ||
          canonicalize(existing.ref) !== canonicalize(prepared.ref))
      ) {
        throw new Error(
          "One conversation assignment has conflicting recovered channel openings",
        );
      }
      openings.set(prepared.assignmentId, {
        ticket,
        ref: prepared.ref,
      });
    }
    let recovered = 0;
    for (const [assignmentId, opening] of openings) {
      await this.openConversationChannel({
        executorId: opening.ticket.executorId,
        assignmentId,
        ref: opening.ref,
        ticket: opening.ticket,
        journal,
      });
      recovered += 1;
    }
    return recovered;
  }

  openFirstPartySurfaceSession(
    input: Parameters<LosslessDataPlaneRuntime["openFirstPartySurfaceSession"]>[0],
  ): ReturnType<LosslessDataPlaneRuntime["openFirstPartySurfaceSession"]> {
    if (this.#closed) {
      return Promise.reject(
        new Error("Channel interaction coordinator is closed"),
      );
    }
    return this.#dataPlane.openFirstPartySurfaceSession(input);
  }

  /** job 渠道义务的幂等采用:同 assignment 复用活跃 relay 会话。 */
  async openJobRelay(opening: JobRelayOpening): Promise<LosslessDataPlaneSession> {
    if (this.#closed) throw new Error("Channel interaction coordinator is closed");
    const existing = this.#jobs.get(opening.assignmentId);
    if (existing) return existing;
    const releaseStatus = this.#retainJobStatusSource(opening);
    const session = new JobChannelSession({
      opening,
      dataPlane: this.#dataPlane,
      channels: this.#channels,
      now: this.#now,
      onClosed: () => {
        this.#jobs.delete(opening.assignmentId);
        releaseStatus();
      },
      onError: this.#onError,
    });
    this.#jobs.set(opening.assignmentId, session);
    try {
      await session.start();
    } catch (error) {
      this.#jobs.delete(opening.assignmentId);
      releaseStatus();
      throw error;
    }
    return session;
  }

  /**
   * job owner 的唯一生产登记入口。登记与活跃会话采用成对所有权；动态
   * 新建任务无需等待下一次启动恢复，关闭后也不会留下可枚举的幽灵义务。
   */
  async registerJobRelay(
    opening: JobRelayOpening,
  ): Promise<LosslessDataPlaneSession> {
    const unregister = this.#jobRelays.register(opening);
    try {
      const active = await this.openJobRelay(opening);
      return {
        close: onceAsync(async (reason?: Error) => {
          try {
            await active.close(reason);
          } finally {
            unregister();
          }
        }),
      };
    } catch (error) {
      unregister();
      throw error;
    }
  }

  /**
   * 渠道 callback 的唯一可等待入口:耐久裁决完成后才返回,平台据此确认;
   * 同键重复 callback 由耐久层回放原结果。未命中活跃义务即拒绝——义务
   * 仍在权威日志里,恢复完成后的重投可以处理,绝不吞掉。
   */
  async handleChallengeAction(action: ChannelChallengeAction): Promise<void> {
    if (this.#closed) throw new Error("Channel interaction coordinator is closed");
    if (action.token.ref.execution === "job") {
      const session = this.#jobs.get(action.token.assignmentId);
      if (!session) {
        throw new Error("Channel callback does not bind an active job obligation");
      }
      await session.resolveCallback(action);
      return;
    }
    await this.#dataPlane.handleChallengeAction(action);
  }

  /** 启动恢复:按已登记的耐久 job 开放义务重建 relay 会话(幂等)。 */
  async recover(): Promise<void> {
    if (this.#closed) return;
    const openings = await this.#jobRelays.listOpen();
    for (const opening of openings) {
      if (this.#closed) return;
      try {
        await this.openJobRelay(opening);
      } catch (error) {
        this.#onError?.(asError(error));
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const sessions = [
      ...this.#conversations.values(),
      ...this.#jobs.values(),
    ];
    this.#conversations.clear();
    this.#jobs.clear();
    await Promise.allSettled(
      sessions.map((session) =>
        session.close(new Error("Channel interaction coordinator is stopping")),
      ),
    );
  }

  #retainJobStatusSource(opening: JobRelayOpening): () => void {
    const taskId = opening.ref.taskId;
    const existing = this.#jobStatusSources.get(taskId);
    if (existing) {
      if (existing.source !== opening.journal) {
        throw new Error(
          "One task cannot bind multiple active job status authorities",
        );
      }
      existing.count += 1;
      return once(() => this.#releaseJobStatusSource(taskId, existing));
    }
    const entry = {
      source: opening.journal,
      unregister: this.#jobStatus.register(taskId, opening.journal),
      count: 1,
    };
    this.#jobStatusSources.set(taskId, entry);
    return once(() => this.#releaseJobStatusSource(taskId, entry));
  }

  #releaseJobStatusSource(
    taskId: string,
    entry: {
      readonly source: JobStatusSource;
      readonly unregister: () => void;
      count: number;
    },
  ): void {
    if (this.#jobStatusSources.get(taskId) !== entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.#jobStatusSources.delete(taskId);
    entry.unregister();
  }
}

/**
 * 单个定时 job 的渠道会话:owner-relay 耐久续流 + challenge outbox 发送 +
 * callback→grant 链。pending/finished 权威唯一在 executor assignment 流;
 * 这里的全部状态都是权威日志的投影,重启由协调器 recover() 重建。
 */
class JobChannelSession implements LosslessDataPlaneSession {
  readonly #opening: JobRelayOpening;
  readonly #channels: ChannelInteractionCoordinatorOptions["channels"];
  readonly #onClosed: () => void;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #controller = new AbortController();
  readonly #dataPlane: ChannelInteractionCoordinatorOptions["dataPlane"];
  readonly #now: () => string;
  #relay: JobOwnerRelay | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(options: {
    readonly opening: JobRelayOpening;
    readonly dataPlane: ChannelInteractionCoordinatorOptions["dataPlane"];
    readonly channels: ChannelInteractionCoordinatorOptions["channels"];
    readonly now: () => string;
    readonly onClosed: () => void;
    readonly onError?: (error: Error) => void;
  }) {
    this.#opening = options.opening;
    this.#dataPlane = options.dataPlane;
    this.#channels = options.channels;
    this.#now = options.now;
    this.#onClosed = options.onClosed;
    this.#onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#relay = await this.#dataPlane.createJobOwnerRelay({
      executorId: this.#opening.executorId,
      assignmentId: this.#opening.assignmentId,
      ref: this.#opening.ref,
      controlLeaseId: this.#opening.controlLeaseId,
      journal: this.#opening.journal,
      resolver: {
        resolveNoInteractiveSurface: (input) =>
          this.#opening.resolveNoInteractiveSurface(input),
        resolveGrant: (grant) => this.#opening.deliverGrant(grant),
      },
    });
    this.#running = this.#run().catch((error) => {
      if (!this.#controller.signal.aborted) this.#onError?.(asError(error));
    });
  }

  /**
   * job callback:验证与 grant 的耐久裁决在 relay 内完成(grant 恰一次
   * 写入,重复回放同一 grant),随后经注入的转交半边交给 executor;转交
   * 失败上抛让平台重投,已写 grant 保证重投只回放。
   */
  async resolveCallback(action: ChannelChallengeAction): Promise<void> {
    const relay = this.#relay;
    if (!relay) throw new Error("Job owner relay is not started");
    if (action.token.ref.execution !== "job") {
      throw new TypeError("Job channel session received a conversation token");
    }
    await relay.resolveCallback({
      token: action.token as Parameters<
        JobOwnerRelay["resolveCallback"]
      >[0]["token"],
      responder: action.responder,
      decision: action.decision,
    });
  }

  async close(reason?: Error): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(
        reason ?? new Error("Job channel session closed"),
      );
    }
    this.#onClosed();
    await this.#relay?.close(reason);
    await this.#running;
  }

  async #run(): Promise<void> {
    const outbox = new ChannelChallengeOutbox({
      store: this.#opening.journal,
      now: this.#now,
      sender: {
        send: async (input) => {
          const registry = this.#channels();
          const adapter = registry?.get(input.token.route.channelId);
          if (!adapter || !isChallengeChannel(adapter)) {
            throw new Error(
              `Channel does not support signed challenges: ${input.token.route.channelId}`,
            );
          }
          const relay = this.#relay;
          if (!relay) throw new Error("Job owner relay is not started");
          const renderedDisplay =
            "title" in input.display
              ? input.display
              : await relay.materializeInteractionDisplay(
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
            throw new Error(
              result.error ?? "Channel rejected the signed challenge",
            );
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
    const relay = this.#relay;
    if (!relay) throw new Error("Job owner relay is not started");
    while (!this.#controller.signal.aborted) {
      try {
        const result = await relay.poll(this.#controller.signal);
        const drained = await outbox.drain(this.#controller.signal);
        for (const failure of drained.failures) {
          this.#onError?.(failure.error);
        }
        if (result.accepted > 0 || drained.delivered > 0) continue;
      } catch (error) {
        if (this.#controller.signal.aborted) throw error;
        this.#onError?.(asError(error));
      }
      if (!this.#controller.signal.aborted) {
        await delay(IDLE_POLL_MS, this.#controller.signal);
      }
    }
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}

function onceAsync(
  action: (reason?: Error) => Promise<void>,
): (reason?: Error) => Promise<void> {
  let running: Promise<void> | undefined;
  return (reason?: Error) => {
    running ??= action(reason);
    return running;
  };
}
