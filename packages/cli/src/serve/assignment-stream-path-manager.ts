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
import { StreamConsumerDegradedError } from "@zhixing/executor/assignment-stream-spool";
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
  readonly relay: AssignmentStreamPathConnector;
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
  readonly #connectors: Readonly<
    Record<AssignmentStreamPath, AssignmentStreamPathConnector>
  >;
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
      relay: options.relay,
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
          this.#nextPath = failedPath === "direct" ? "relay" : "direct";
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

  async #open(
    path: AssignmentStreamPath,
    signal: AbortSignal,
  ): Promise<ActivePath> {
    const generation = ++this.#generation;
    const controller = new AbortController();
    let connection: AssignmentStreamPathConnection;
    try {
      connection = await this.#connectors[path].open({
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
          this.#nextPath = failedPath === "direct" ? "relay" : "direct";
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
