import type {
  ArtifactRef,
  ExecutionRef,
  InteractionDisplay,
  StreamConsumerAuth,
  StreamFrame,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  streamConsumerKey,
  StreamFrameVerifier,
  materializeInteractionDisplayBytes,
  validateInteractionDisplay,
  validateStreamConsumerAuth,
  validateStreamSubscribe,
  type StreamVerifierCheckpoint,
  type InlineInteractionDisplay,
} from "@zhixing/core/protocol";
import {
  StreamConsumerDegradedError,
  StreamHistoryUnavailableError,
} from "@zhixing/executor/assignment-stream-spool";
import type { AssignmentStreamClient } from "./assignment-stream-mesh.js";

export type AssignmentStreamPath = "direct" | "relay";

export interface AssignmentStreamPathConnection
  extends AssignmentStreamClient {
  close?(reason?: Error): void | Promise<void>;
}

export interface AssignmentStreamPathConnector {
  open(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
    readonly consumer: StreamConsumerAuth;
    readonly signal: AbortSignal;
  }): Promise<AssignmentStreamPathConnection>;
}

export interface AssignmentStreamPathManagerOptions {
  readonly assignmentId: string;
  readonly ref: ExecutionRef;
  readonly consumer: StreamConsumerAuth;
  readonly direct: AssignmentStreamPathConnector;
  /**
   * 中继路径连接器。只有第一方 surface 会话持有双路径(直连 executor 与
   * 经 owner/anchor 中继);渠道宿主与 job owner-relay 自身就坐在 owner
   * 位置,不存在第二条拓扑路径——省略本字段即诚实的单路径形态,失败
   * 只在 direct 上有界重试,绝不伪造双路径。
   */
  readonly relay?: AssignmentStreamPathConnector;
  readonly adoptFrame: (
    frame: StreamFrame,
    checkpoint: StreamVerifierCheckpoint,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly initialCheckpoint?: StreamVerifierCheckpoint;
  readonly maxPathAttempts?: number;
  readonly onPathsUnavailable?: (input: {
    readonly checkpoint: StreamVerifierCheckpoint;
    readonly failures: readonly Error[];
    readonly signal: AbortSignal;
  }) => void | Promise<void>;
  readonly onConsumerDegraded?: (input: {
    readonly checkpoint: StreamVerifierCheckpoint;
    readonly signal: AbortSignal;
  }) => void | Promise<void>;
}

export interface AssignmentStreamPollResult {
  readonly path: AssignmentStreamPath;
  readonly accepted: number;
  readonly checkpoint: StreamVerifierCheckpoint;
}

export class AssignmentStreamPathUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssignmentStreamPathUnavailableError";
  }
}

export class AssignmentStreamPathsUnavailableError extends AggregateError {
  constructor(errors: readonly Error[]) {
    super(errors, "All assignment stream paths are unavailable");
    this.name = "AssignmentStreamPathsUnavailableError";
  }
}

interface ActivePath {
  readonly path: AssignmentStreamPath;
  readonly generation: number;
  readonly controller: AbortController;
  readonly connection: AssignmentStreamPathConnection;
  resumeAcknowledged: boolean;
}

class SupersededAssignmentStreamPathError extends Error {}

export class AssignmentStreamPathManager {
  readonly #assignmentId: string;
  readonly #ref: ExecutionRef;
  #consumer: StreamConsumerAuth;
  readonly #connectors: {
    readonly direct: AssignmentStreamPathConnector;
    readonly relay?: AssignmentStreamPathConnector;
  };
  readonly #adoptFrame: AssignmentStreamPathManagerOptions["adoptFrame"];
  readonly #maxPathAttempts: number;
  readonly #onPathsUnavailable:
    | AssignmentStreamPathManagerOptions["onPathsUnavailable"]
    | undefined;
  readonly #onConsumerDegraded:
    | AssignmentStreamPathManagerOptions["onConsumerDegraded"]
    | undefined;
  #active: ActivePath | undefined;
  #generation = 0;
  #nextPath: AssignmentStreamPath = "direct";
  #polling = false;
  #verifier: StreamFrameVerifier;
  #closedReason: Error | undefined;

  constructor(options: AssignmentStreamPathManagerOptions) {
    const request = validateStreamSubscribe({
      v: 1,
      assignmentId: options.assignmentId,
      ref: options.ref,
      consumer: options.consumer,
      afterSeq: options.initialCheckpoint?.lastSeq ?? 0,
    });
    if (
      options.initialCheckpoint !== undefined &&
      (options.initialCheckpoint.assignmentId !== request.assignmentId ||
        canonicalize(options.initialCheckpoint.ref) !== canonicalize(request.ref))
    ) {
      throw new TypeError(
        "Initial stream checkpoint does not bind the managed assignment",
      );
    }
    const maxPathAttempts = options.maxPathAttempts ?? 3;
    if (!Number.isSafeInteger(maxPathAttempts) || maxPathAttempts < 1) {
      throw new TypeError(
        "Assignment stream path attempts must be a positive safe integer",
      );
    }
    this.#assignmentId = request.assignmentId;
    this.#ref = request.ref;
    this.#consumer = request.consumer;
    this.#connectors = {
      direct: options.direct,
      ...(options.relay ? { relay: options.relay } : {}),
    };
    this.#adoptFrame = options.adoptFrame;
    this.#maxPathAttempts = maxPathAttempts;
    this.#onPathsUnavailable = options.onPathsUnavailable;
    this.#onConsumerDegraded = options.onConsumerDegraded;
    this.#verifier = new StreamFrameVerifier(
      options.initialCheckpoint ?? {
        assignmentId: request.assignmentId,
        ref: request.ref,
      },
    );
  }

  get path(): AssignmentStreamPath | undefined {
    return this.#active?.path;
  }

  checkpoint(): StreamVerifierCheckpoint {
    return this.#verifier.checkpoint();
  }

  async poll(signal: AbortSignal = new AbortController().signal): Promise<
    AssignmentStreamPollResult
  > {
    if (this.#polling) {
      throw new TypeError(
        "Assignment stream path manager permits only one active poll",
      );
    }
    this.#polling = true;
    const failures: Error[] = [];
    let accepted = 0;
    try {
      while (failures.length < this.#maxPathAttempts) {
        if (this.#closedReason) throw this.#closedReason;
        signal.throwIfAborted();
        let attempted: ActivePath | undefined;
        try {
          const active =
            this.#active ?? (await this.#open(this.#nextPath, signal));
          attempted = active;
          await this.#resume(active, signal);
          if (!this.#isCurrent(active)) continue;

          const checkpoint = this.#verifier.checkpoint();
          const frames = await active.connection.subscribe(
            {
              v: 1,
              assignmentId: this.#assignmentId,
              ref: this.#ref,
              consumer: this.#consumer,
              afterSeq: checkpoint.lastSeq,
            },
            combineSignals(signal, active.controller.signal),
          );
          if (!this.#isCurrent(active)) continue;

          for (const frame of frames) {
            if (!this.#isCurrent(active)) break;
            const before = this.#verifier.checkpoint();
            const disposition = this.#verifier.accept(frame);
            const after = this.#verifier.checkpoint();
            if (disposition === "accepted") {
              try {
                await this.#adoptFrame(frame, after, signal);
              } catch (error) {
                this.#verifier = new StreamFrameVerifier(before);
                throw error;
              }
              accepted += 1;
            }
            if (!this.#isCurrent(active)) break;
            await active.connection.acknowledge(
              {
                v: 1,
                assignmentId: this.#assignmentId,
                consumer: this.#consumer,
                ackSeq: after.lastSeq,
              },
              combineSignals(signal, active.controller.signal),
            );
          }
          if (!this.#isCurrent(active)) continue;
          return {
            path: active.path,
            accepted,
            checkpoint: this.#verifier.checkpoint(),
          };
        } catch (error) {
          if (this.#closedReason) throw this.#closedReason;
          if (signal.aborted) throw signal.reason;
          if (error instanceof SupersededAssignmentStreamPathError) continue;
          if (attempted !== undefined && !this.#isCurrent(attempted)) {
            continue;
          }
          if (error instanceof StreamConsumerDegradedError) {
            const checkpoint = this.#verifier.checkpoint();
            await this.#invalidate(error);
            await this.#onConsumerDegraded?.({ checkpoint, signal });
            throw error;
          }
          if (!(error instanceof AssignmentStreamPathUnavailableError)) {
            throw error;
          }
          failures.push(error);
          const failedPath = this.#active?.path ?? this.#nextPath;
          await this.#invalidate(error);
          this.#nextPath = this.#alternateTo(failedPath);
        }
      }

      const checkpoint = this.#verifier.checkpoint();
      await this.#onPathsUnavailable?.({
        checkpoint,
        failures,
        signal,
      });
      throw new AssignmentStreamPathsUnavailableError(failures);
    } finally {
      this.#polling = false;
    }
  }

  async fallbackToRelay(): Promise<void> {
    if (!this.#connectors.relay) {
      throw new TypeError(
        "Assignment stream consumer has no relay path to fall back to",
      );
    }
    await this.#select("relay");
  }

  async restoreDirect(): Promise<void> {
    await this.#select("direct");
  }

  async updateConsumerAuth(consumerInput: StreamConsumerAuth): Promise<void> {
    const consumer = validateStreamConsumerAuth(consumerInput);
    if (streamConsumerKey(consumer) !== streamConsumerKey(this.#consumer)) {
      throw new TypeError(
        "Replacement stream authorization changes the logical consumer",
      );
    }
    if (canonicalize(consumer) === canonicalize(this.#consumer)) return;
    this.#consumer = consumer;
    await this.#invalidate(
      new Error("Assignment stream authorization changed"),
    );
  }

  async materializeInteractionDisplay(
    displayInput: InteractionDisplay,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<InlineInteractionDisplay> {
    const display = validateInteractionDisplay(displayInput);
    if (!("ref" in display)) return display;
    const bytes = await this.#readArtifact(display.ref, signal);
    return materializeInteractionDisplayBytes(display, bytes);
  }

  async close(reason = new Error("Assignment stream path manager closed")): Promise<void> {
    this.#closedReason = reason;
    await this.#invalidate(reason);
  }

  #alternateTo(failedPath: AssignmentStreamPath): AssignmentStreamPath {
    if (failedPath === "direct" && this.#connectors.relay) return "relay";
    return "direct";
  }

  async #open(
    path: AssignmentStreamPath,
    signal: AbortSignal,
  ): Promise<ActivePath> {
    const connector = this.#connectors[path];
    if (!connector) {
      throw new AssignmentStreamPathUnavailableError(
        `${path} assignment stream path is not configured`,
      );
    }
    const generation = ++this.#generation;
    const controller = new AbortController();
    let connection: AssignmentStreamPathConnection;
    try {
      connection = await connector.open({
        assignmentId: this.#assignmentId,
        ref: this.#ref,
        consumer: this.#consumer,
        signal: combineSignals(signal, controller.signal),
      });
    } catch (error) {
      controller.abort(error);
      if (generation !== this.#generation) {
        throw new SupersededAssignmentStreamPathError();
      }
      throw error;
    }
    if (generation !== this.#generation) {
      const reason = new Error("Assignment stream connection was superseded");
      controller.abort(reason);
      await connection.close?.(reason);
      throw new SupersededAssignmentStreamPathError();
    }
    const active: ActivePath = {
      path,
      generation,
      controller,
      connection,
      resumeAcknowledged: false,
    };
    this.#active = active;
    return active;
  }

  async #resume(active: ActivePath, signal: AbortSignal): Promise<void> {
    if (active.resumeAcknowledged) return;
    const checkpoint = this.#verifier.checkpoint();
    if (checkpoint.lastSeq > 0) {
      await active.connection.acknowledge(
        {
          v: 1,
          assignmentId: this.#assignmentId,
          consumer: this.#consumer,
          ackSeq: checkpoint.lastSeq,
        },
        combineSignals(signal, active.controller.signal),
      );
    }
    if (this.#isCurrent(active)) active.resumeAcknowledged = true;
  }

  async #select(path: AssignmentStreamPath): Promise<void> {
    this.#nextPath = path;
    await this.#invalidate(
      new Error(`Assignment stream path changed to ${path}`),
    );
  }

  async #readArtifact(
    ref: ArtifactRef,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const result = new Uint8Array(ref.bytes);
    let offset = 0;
    while (offset < ref.bytes) {
      let failures = 0;
      let range:
        | Awaited<
            ReturnType<
              NonNullable<AssignmentStreamPathConnection["readArtifact"]>
            >
          >
        | undefined;
      while (!range && failures < this.#maxPathAttempts) {
        signal.throwIfAborted();
        let active: ActivePath | undefined;
        try {
          active = this.#active ?? (await this.#open(this.#nextPath, signal));
          if (!active.connection.readArtifact) {
            throw new TypeError(
              "Assignment stream path cannot read retained artifacts",
            );
          }
          range = await active.connection.readArtifact(
            {
              v: 1,
              assignmentId: this.#assignmentId,
              consumer: this.#consumer,
              ref,
              offset,
              limit: Math.min(64 * 1024, ref.bytes - offset),
            },
            combineSignals(signal, active.controller.signal),
          );
        } catch (error) {
          if (
            !(error instanceof AssignmentStreamPathUnavailableError) ||
            (active && !this.#isCurrent(active))
          ) {
            throw error;
          }
          failures += 1;
          const failedPath = active?.path ?? this.#nextPath;
          await this.#invalidate(error);
          this.#nextPath = this.#alternateTo(failedPath);
        }
      }
      if (!range) {
        throw new AssignmentStreamPathsUnavailableError([]);
      }
      if (
        range.offset !== offset ||
        range.bytes.byteLength === 0 ||
        offset + range.bytes.byteLength > ref.bytes
      ) {
        throw new TypeError("Assignment stream artifact range did not advance");
      }
      result.set(range.bytes, offset);
      offset += range.bytes.byteLength;
      if (range.complete !== (offset === ref.bytes)) {
        throw new TypeError(
          "Assignment stream artifact completion does not match its reference",
        );
      }
    }
    return result;
  }

  async #invalidate(reason: unknown): Promise<void> {
    const active = this.#active;
    this.#active = undefined;
    this.#generation += 1;
    if (!active) return;
    active.controller.abort(reason);
    try {
      await active.connection.close?.(asError(reason));
    } catch {
      // Closing a superseded transport must not replace the stream failure.
    }
  }

  #isCurrent(active: ActivePath): boolean {
    return (
      this.#active === active &&
      active.generation === this.#generation &&
      !active.controller.signal.aborted
    );
  }
}

function combineSignals(
  left: AbortSignal,
  right: AbortSignal,
): AbortSignal {
  return AbortSignal.any([left, right]);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * 把连接的传输层失败统一映射为路径不可用,使路径管理器能据此切换或
 * 有界重试。协议语义错误(严格校验拒绝、消费方降级、历史不可用)与
 * 调用方主动取消原样上抛——它们不是"这条路走不通",换路径也不会好。
 */
export function mapConnectionTransportFailures(
  connection: AssignmentStreamPathConnection,
  label: string,
): AssignmentStreamPathConnection {
  const wrap = async <T>(
    signal: AbortSignal | undefined,
    operate: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operate();
    } catch (error) {
      if (
        signal?.aborted ||
        error instanceof TypeError ||
        error instanceof StreamConsumerDegradedError ||
        error instanceof StreamHistoryUnavailableError ||
        error instanceof AssignmentStreamPathUnavailableError
      ) {
        throw error;
      }
      throw new AssignmentStreamPathUnavailableError(
        `${label} assignment stream path failed`,
        { cause: error },
      );
    }
  };
  return {
    subscribe: (request, signal) =>
      wrap(signal, () => connection.subscribe(request, signal)),
    acknowledge: (ack, signal) =>
      wrap(signal, () => connection.acknowledge(ack, signal)),
    ...(connection.readArtifact
      ? {
          readArtifact: (request, signal) =>
            wrap(signal, () => {
              const read = connection.readArtifact;
              if (!read) {
                throw new TypeError(
                  "Assignment stream connection lost artifact reads",
                );
              }
              return read.call(connection, request, signal);
            }),
        }
      : {}),
    ...(connection.close
      ? { close: (reason?: Error) => connection.close?.(reason) }
      : {}),
  };
}
