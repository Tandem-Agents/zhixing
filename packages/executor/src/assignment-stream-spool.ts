import { open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  collectArtifactRefs,
  type ArtifactStore,
  type ProjectionCursor,
  type ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import {
  type AgentYield,
  type ArtifactRef,
  type ExecutionRef,
  type InteractionDisplay,
  type IsoTime,
  type SessionEventProjection,
  type StreamAck,
  type StreamConsumerAuth,
  type StreamFrame,
  type StreamSubscribe,
} from "@zhixing/core/contracts";
import {
  StreamDigestChain,
  StreamFrameVerifier,
  byteDigest,
  canonicalize,
  materializeStreamDataPayload,
  prepareStreamDataPayload,
  streamConsumerKey,
  streamLogicalFrameDigest,
  validateStreamAck,
  validateStreamFrame,
  validateStreamSubscribe,
  type StreamDataFramePayload,
  type StreamFrameMeta,
  type StreamFrameProducer,
  type StreamVerifierCheckpoint,
} from "@zhixing/core/protocol";
import {
  SerialTaskQueue,
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing/core/persistence";

export const DEFAULT_ASSIGNMENT_STREAM_SPOOL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ASSIGNMENT_STREAM_RECLAIM_DELAY_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_STREAM_READ_BATCH_FRAMES = 256;
export const DEFAULT_STREAM_READ_BATCH_BYTES = 512 * 1024;
export const MAX_ASSIGNMENT_STREAM_FRAME_BYTES =
  DEFAULT_STREAM_READ_BATCH_BYTES;

const STREAM = "assignment:stream";
const TOMBSTONE_VERSION = 1;

export interface AssignmentStreamSpoolOptions {
  readonly capacityBytes?: number;
  readonly clock?: () => IsoTime;
  readonly reclaimDelayMs?: number;
  readonly removeRetiredArtifact?: (
    store: FileArtifactStore,
    ref: ArtifactRef,
  ) => Promise<void>;
}

export interface AppendStreamFrameInput {
  readonly assignmentId: string;
  readonly ref: ExecutionRef;
  readonly payload: StreamDataFramePayload;
  readonly meta?: StreamFrameMeta;
  readonly signal?: AbortSignal;
  readonly sourceId?: string;
}

export interface SubscribeStreamInput {
  readonly request: StreamSubscribe;
  readonly streamEpoch: number;
  readonly expiresAt?: IsoTime;
  readonly maxFrames?: number;
  readonly maxBytes?: number;
}

export interface StreamSpoolSnapshot {
  readonly assignmentId: string;
  readonly ref: ExecutionRef;
  readonly lastSeq: number;
  readonly finalSeq?: number;
  readonly retainedBytes: number;
  readonly prunedThrough: number;
  readonly terminal: boolean;
  readonly reclaimAfter?: IsoTime;
  readonly consumers: readonly {
    readonly key: string;
    readonly kind: StreamConsumerAuth["kind"];
    readonly ackSeq: number;
    readonly offeredSeq: number;
    readonly degraded: boolean;
    readonly qualified: boolean;
    readonly streamEpoch: number;
    readonly expiresAt?: IsoTime;
  }[];
}

export class AssignmentStreamWriter implements StreamFrameProducer {
  readonly #spool: AssignmentStreamSpool;
  readonly #assignmentId: string;
  readonly #ref: ExecutionRef;

  private constructor(
    spool: AssignmentStreamSpool,
    assignmentId: string,
    ref: ExecutionRef,
  ) {
    this.#spool = spool;
    this.#assignmentId = assignmentId;
    this.#ref = clone(ref);
  }

  static async open(
    spool: AssignmentStreamSpool,
    assignmentId: string,
    ref: ExecutionRef,
  ): Promise<AssignmentStreamWriter> {
    await spool.open(assignmentId, ref);
    return new AssignmentStreamWriter(spool, assignmentId, ref);
  }

  appendYield(
    value: AgentYield,
    meta: StreamFrameMeta = {},
    signal?: AbortSignal,
    sourceId?: string,
  ): Promise<StreamFrame> {
    return this.append(
      { kind: "agent-yield", yield: value },
      meta,
      signal,
      sourceId,
    );
  }

  appendEvent(
    value: SessionEventProjection,
    meta: StreamFrameMeta = {},
    signal?: AbortSignal,
    sourceId?: string,
  ): Promise<StreamFrame> {
    return this.append(
      { kind: "agent-event", event: value },
      meta,
      signal,
      sourceId,
    );
  }

  appendInteractionRequested(
    value: {
      readonly requestId: string;
      readonly toolName: string;
      readonly display: InteractionDisplay;
      readonly issuedAt: IsoTime;
      readonly ttlMs: number;
      readonly expiresAt: IsoTime;
    },
    meta: StreamFrameMeta = {},
    signal?: AbortSignal,
    sourceId?: string,
  ): Promise<StreamFrame> {
    return this.append(
      {
        kind: "interaction",
        event: { t: "requested", ...value },
      },
      meta,
      signal,
      sourceId,
    );
  }

  appendInteractionFinished(
    value: {
      readonly requestId: string;
      readonly outcome: "allowed" | "denied" | "cancelled" | "expired";
    },
    meta: StreamFrameMeta = {},
    signal?: AbortSignal,
    sourceId?: string,
  ): Promise<StreamFrame> {
    return this.append(
      {
        kind: "interaction",
        event: { t: "finished", ...value },
      },
      meta,
      signal,
      sourceId,
    );
  }

  finalize(
    meta: StreamFrameMeta = {},
    signal?: AbortSignal,
  ): Promise<StreamFrame> {
    return this.#spool.finalizeProduced({
      assignmentId: this.#assignmentId,
      ref: this.#ref,
      meta,
      signal,
    });
  }

  async final(
    meta: StreamFrameMeta = {},
    signal?: AbortSignal,
  ): Promise<{ readonly finalSeq: number; readonly streamDigest: string }> {
    const frame = await this.finalize(meta, signal);
    if (frame.payload.kind !== "provisional-final") {
      throw new TypeError("Stream writer finalized without a final frame");
    }
    return {
      finalSeq: frame.payload.finalSeq,
      streamDigest: frame.payload.streamDigest,
    };
  }

  append(
    payload: StreamDataFramePayload,
    meta: StreamFrameMeta = {},
    signal?: AbortSignal,
    sourceId?: string,
  ): Promise<StreamFrame> {
    return this.#spool.appendProduced({
      assignmentId: this.#assignmentId,
      ref: this.#ref,
      payload,
      meta,
      signal,
      sourceId,
    });
  }
}

interface StoredFrame {
  readonly seq: number;
  readonly ref: ArtifactRef;
  readonly logicalDigest: string;
  readonly contentRefs: readonly ArtifactRef[];
}

interface ConsumerState {
  readonly key: string;
  readonly kind: StreamConsumerAuth["kind"];
  ackSeq: number;
  offeredSeq: number;
  degraded: boolean;
  qualified: boolean;
  streamEpoch: number;
  expiresAt?: IsoTime;
}

interface RetainedArtifactState {
  readonly ref: ArtifactRef;
  count: number;
}

interface StoredArtifactIdentity {
  readonly artifactDigest: string;
  readonly artifactBytes: number;
}

interface SpoolProjection {
  readonly assignmentId: string;
  ref?: ExecutionRef;
  capacityBytes?: number;
  verifier?: StreamVerifierCheckpoint;
  readonly frames: Map<number, StoredFrame>;
  readonly consumers: Map<string, ConsumerState>;
  readonly pendingInteractions: Set<string>;
  readonly sourceFrames: Map<
    string,
    { readonly seq: number; readonly logicalDigest: string }
  >;
  readonly artifacts: Map<string, RetainedArtifactState>;
  readonly pendingDeletes: Map<string, ArtifactRef>;
  retainedBytes: number;
  prunedThrough: number;
  terminal: boolean;
  reclaimAfter?: IsoTime;
  reclaimed: boolean;
}

type SpoolRecord =
  | {
      readonly t: "opened";
      readonly assignmentId: string;
      readonly ref: ExecutionRef;
      readonly capacityBytes: number;
      readonly verifier: StreamVerifierCheckpoint;
    }
  | {
      readonly t: "frame";
      readonly seq: number;
      readonly frame: StoredArtifactIdentity;
      readonly logicalDigest: string;
      readonly contentRefs: readonly StoredArtifactIdentity[];
      readonly verifier: StreamVerifierCheckpoint;
      readonly sourceId?: string;
      readonly interaction?:
        | { readonly t: "requested"; readonly requestId: string }
        | { readonly t: "finished"; readonly requestId: string };
    }
  | {
      readonly t: "consumer-qualified";
      readonly key: string;
      readonly kind: StreamConsumerAuth["kind"];
      readonly expiresAt?: IsoTime;
    }
  | { readonly t: "consumer-revoked"; readonly key: string }
  | {
      readonly t: "connection";
      readonly key: string;
      readonly streamEpoch: number;
    }
  | {
      readonly t: "offered";
      readonly key: string;
      readonly offeredSeq: number;
    }
  | {
      readonly t: "ack";
      readonly key: string;
      readonly ackSeq: number;
    }
  | { readonly t: "degraded"; readonly key: string }
  | {
      readonly t: "pruned";
      readonly throughSeq: number;
      readonly artifacts: readonly StoredArtifactIdentity[];
    }
  | {
      readonly t: "deleted";
      readonly deletions: readonly StoredArtifactIdentity[];
    }
  | { readonly t: "terminal"; readonly finalSeq: number }
  | { readonly t: "reclaim-armed"; readonly reclaimAfter: IsoTime }
  | { readonly t: "reclaim-disarmed"; readonly key: string }
  | { readonly t: "reclaimed" };

interface CachedProjection {
  readonly state: SpoolProjection;
  readonly cursor: ProjectionCursor;
}

interface AssignmentHandle {
  readonly assignmentId: string;
  readonly directory: string;
  readonly frames: FileArtifactStore;
  readonly log: FileAuthorityCommitLog;
  readonly queue: SerialTaskQueue;
  readonly waiters: Set<() => void>;
  cache?: CachedProjection;
  cleanupComplete: boolean;
}

type AppendAttempt =
  | { readonly kind: "appended"; readonly frame: StreamFrame }
  | { readonly kind: "full" }
  | { readonly kind: "retry" };

export class StreamSpoolCapacityError extends Error {
  constructor(
    readonly frameBytes: number,
    readonly capacityBytes: number,
  ) {
    super(
      `Stream frame requires ${frameBytes} bytes but spool capacity is ${capacityBytes}`,
    );
    this.name = "StreamSpoolCapacityError";
  }
}

export class StreamFrameSizeError extends Error {
  constructor(
    readonly frameBytes: number,
    readonly maxFrameBytes: number,
  ) {
    super(
      `Stream frame requires ${frameBytes} bytes but the maximum is ${maxFrameBytes}`,
    );
    this.name = "StreamFrameSizeError";
  }
}

export class StreamHistoryUnavailableError extends Error {
  constructor(
    readonly requestedAfterSeq: number,
    readonly prunedThrough: number,
  ) {
    super(
      `Stream history through ${prunedThrough} was reclaimed before requested sequence ${requestedAfterSeq}`,
    );
    this.name = "StreamHistoryUnavailableError";
  }
}

export class StreamConsumerDegradedError extends Error {
  constructor(readonly consumerKey: string) {
    super(
      `Stream consumer ${consumerKey} exceeded its retention window and must use terminal reconciliation`,
    );
    this.name = "StreamConsumerDegradedError";
  }
}

/**
 * Per-assignment durable spool. Frame bodies are content-addressed files while
 * ordering, chain checkpoints, ACKs and reclamation are one append-only state machine.
 */
export class AssignmentStreamSpool {
  readonly #rootDir: string;
  readonly #sourceArtifacts: ArtifactStore;
  readonly #capacityBytes: number;
  readonly #clock: () => IsoTime;
  readonly #reclaimDelayMs: number;
  readonly #removeRetiredArtifact: NonNullable<
    AssignmentStreamSpoolOptions["removeRetiredArtifact"]
  >;
  readonly #handles = new Map<string, AssignmentHandle>();

  constructor(
    rootDir: string,
    sourceArtifacts: ArtifactStore,
    options: AssignmentStreamSpoolOptions = {},
  ) {
    this.#rootDir = path.resolve(rootDir);
    this.#sourceArtifacts = sourceArtifacts;
    this.#capacityBytes =
      options.capacityBytes ?? DEFAULT_ASSIGNMENT_STREAM_SPOOL_BYTES;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#reclaimDelayMs =
      options.reclaimDelayMs ?? DEFAULT_ASSIGNMENT_STREAM_RECLAIM_DELAY_MS;
    this.#removeRetiredArtifact =
      options.removeRetiredArtifact ??
      ((store, ref) => rm(store.pathFor(ref), { force: true }));
    assertPositiveInteger(this.#capacityBytes, "Stream spool capacity");
    assertPositiveInteger(this.#reclaimDelayMs, "Stream reclaim delay");
  }

  async open(
    assignmentId: string,
    ref: ExecutionRef,
  ): Promise<StreamSpoolSnapshot> {
    const handle = this.#handle(assignmentId);
    return handle.queue.run(async () => {
      await this.#assertNotReclaimed(handle);
      const result = await this.#transact(handle, (state) => {
        if (state.ref !== undefined) {
          assertSameExecution(state, ref);
          return { kind: "return", value: undefined };
        }
        const verifier = new StreamDigestChain(assignmentId).checkpoint();
        return {
          kind: "append",
          entries: [
            record({
              t: "opened",
              assignmentId,
              ref: clone(ref),
              capacityBytes: this.#capacityBytes,
              verifier: {
                assignmentId,
                ref: clone(ref),
                streamEpoch: 1,
                lastSeq: 0,
                ...verifier,
              },
            }),
          ],
          value: undefined,
        };
      });
      await this.#cleanupOrphanFrames(handle, result.state);
      await this.#drainPendingDeletes(handle);
      return snapshotOf(await this.#select(handle));
    });
  }

  async beginConnection(
    assignmentId: string,
    ref: ExecutionRef,
    consumer: StreamConsumerAuth,
  ): Promise<number> {
    await this.open(assignmentId, ref);
    const handle = this.#handle(assignmentId);
    return handle.queue.run(async () => {
      const result = await this.#transact(handle, (state) => {
        assertOpen(state);
        assertSameExecution(state, ref);
        const key = streamConsumerKey(consumer);
        const current = requireQualifiedConsumer(state, key);
        if (current.kind !== consumer.kind) {
          throw new TypeError("Stream connection consumer kind is inconsistent");
        }
        const streamEpoch = current.streamEpoch + 1;
        return {
          kind: "append",
          entries: [record({ t: "connection", key, streamEpoch })],
          value: streamEpoch,
        };
      });
      return result.value;
    });
  }

  async qualifyConsumer(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
    readonly consumer: StreamConsumerAuth;
    readonly expiresAt?: IsoTime;
  }): Promise<StreamSpoolSnapshot> {
    await this.open(input.assignmentId, input.ref);
    if (input.expiresAt !== undefined) assertCanonicalTime(input.expiresAt);
    if (
      input.consumer.kind === "owner-relay" &&
      input.expiresAt !== undefined
    ) {
      throw new TypeError("Owner relay stream consumers do not expire");
    }
    if (
      input.consumer.kind === "surface-ticket" &&
      input.expiresAt === undefined
    ) {
      throw new TypeError("Surface stream authorization requires a stable expiry");
    }
    const handle = this.#handle(input.assignmentId);
    return handle.queue.run(async () => {
      const key = streamConsumerKey(input.consumer);
      const result = await this.#transact(handle, (state) => {
        assertOpen(state);
        assertSameExecution(state, input.ref);
        const current = state.consumers.get(key);
        if (
          current?.qualified &&
          current.kind === input.consumer.kind &&
          current.expiresAt === input.expiresAt
        ) {
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [
            record({
              t: "consumer-qualified",
              key,
              kind: input.consumer.kind,
              ...(input.expiresAt === undefined
                ? {}
                : { expiresAt: input.expiresAt }),
            }),
            ...(state.reclaimAfter === undefined ||
            (current?.degraded ?? false) ||
            (state.verifier?.finalSeq !== undefined &&
              (current?.ackSeq ?? 0) >= state.verifier.finalSeq)
              ? []
              : [record({ t: "reclaim-disarmed" as const, key })]),
          ],
          value: undefined,
        };
      });
      return snapshotOf(result.state);
    });
  }

  async revokeConsumer(input: {
    readonly assignmentId: string;
    readonly consumer: StreamConsumerAuth;
  }): Promise<StreamSpoolSnapshot> {
    const handle = this.#handle(input.assignmentId);
    return handle.queue.run(async () => {
      await this.#assertNotReclaimed(handle);
      const key = streamConsumerKey(input.consumer);
      const before = await this.#select(handle);
      const current = before.consumers.get(key);
      if (!current?.qualified) return snapshotOf(before);
      const projected = cloneProjection(before);
      projected.consumers.get(key)!.qualified = false;
      const throughSeq = retentionFloor(projected);
      const retired = framesThrough(before, throughSeq);
      const artifacts = artifactsReleasedByFrames(before, retired);
      const result = await this.#transact(handle, () => ({
        kind: "append",
        entries: [
          record({ t: "consumer-revoked", key }),
          ...(throughSeq > before.prunedThrough
            ? [
                record({
                  t: "pruned" as const,
                  throughSeq,
                  artifacts: artifacts.map(storedArtifactIdentity),
                }),
              ]
            : []),
        ],
        value: undefined,
      }), artifacts);
      await this.#drainPendingDeletes(handle);
      return snapshotOf(result.state);
    });
  }

  async append(input: AppendStreamFrameInput): Promise<StreamFrame> {
    await this.open(input.assignmentId, input.ref);
    const handle = this.#handle(input.assignmentId);
    try {
      const prepared = await prepareStreamDataPayload(
        input.payload,
        this.#sourceArtifacts,
        handle.frames,
      );
      for (;;) {
        throwIfAborted(input.signal);
        const attempt = await handle.queue.run(() =>
          this.#tryAppend(handle, input, prepared),
        );
        if (attempt.kind === "appended") return attempt.frame;
        if (attempt.kind === "retry") continue;
        await this.#waitForCapacity(handle, input.signal);
      }
    } catch (error) {
      await handle.queue.run(async () => {
        const state = await this.#select(handle);
        await this.#cleanupOrphanFrames(handle, state, true);
      });
      throw error;
    }
  }

  /**
   * Appends producer output independently from consumer connection epochs.
   */
  async appendProduced(
    input: AppendStreamFrameInput,
  ): Promise<StreamFrame> {
    return this.append(input);
  }

  async finalize(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
    readonly meta?: StreamFrameMeta;
    readonly signal?: AbortSignal;
  }): Promise<StreamFrame> {
    await this.open(input.assignmentId, input.ref);
    const handle = this.#handle(input.assignmentId);
    try {
      for (;;) {
        throwIfAborted(input.signal);
        const state = await handle.queue.run(() => this.#select(handle));
        assertOpen(state);
        if (state.verifier!.finalSeq !== undefined) {
          return this.#readFrame(
            handle,
            state.frames.get(state.verifier!.finalSeq)!,
            state.verifier!.streamEpoch,
          );
        }
        const chain = new StreamDigestChain(input.assignmentId, state.verifier);
        const final = chain.final();
        const attempt = await handle.queue.run(() =>
          this.#tryAppend(handle, {
            ...input,
            payload: {
              kind: "provisional-final",
              finalSeq: final.finalSeq,
              streamDigest: final.streamDigest,
            } as never,
          }, {
            payload: {
              kind: "provisional-final",
              finalSeq: final.finalSeq,
              streamDigest: final.streamDigest,
            } as never,
            references: [],
          }),
        );
        if (attempt.kind === "appended") return attempt.frame;
        if (attempt.kind === "retry") continue;
        await this.#waitForCapacity(handle, input.signal);
      }
    } catch (error) {
      await handle.queue.run(async () => {
        const state = await this.#select(handle);
        await this.#cleanupOrphanFrames(handle, state, true);
      });
      throw error;
    }
  }

  async finalizeProduced(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
    readonly meta?: StreamFrameMeta;
    readonly signal?: AbortSignal;
  }): Promise<StreamFrame> {
    return this.finalize(input);
  }

  async subscribe(input: SubscribeStreamInput): Promise<readonly StreamFrame[]> {
    const request = validateStreamSubscribe(input.request);
    assertPositiveInteger(input.streamEpoch, "Stream delivery epoch");
    const maxFrames =
      input.maxFrames ?? DEFAULT_STREAM_READ_BATCH_FRAMES;
    const maxBytes = input.maxBytes ?? DEFAULT_STREAM_READ_BATCH_BYTES;
    assertPositiveInteger(maxFrames, "Stream read frame limit");
    assertPositiveInteger(maxBytes, "Stream read byte limit");
    if (
      maxFrames > DEFAULT_STREAM_READ_BATCH_FRAMES ||
      maxBytes > DEFAULT_STREAM_READ_BATCH_BYTES
    ) {
      throw new RangeError("Stream read batch exceeds its bounded maximum");
    }
    if (input.expiresAt !== undefined) assertCanonicalTime(input.expiresAt);

    const handle = this.#handle(request.assignmentId);
    return handle.queue.run(async () => {
      await this.#assertNotReclaimed(handle);
      await this.#drainPendingDeletes(handle);
      const selected = await this.#transact(handle, (state) => {
        assertOpen(state);
        assertSameExecution(state, request.ref);
        const key = streamConsumerKey(request.consumer);
        const current = requireQualifiedConsumer(state, key);
        if (input.streamEpoch !== current.streamEpoch) {
          throw new TypeError("Stream subscription uses a fenced connection epoch");
        }
        if (current.kind !== request.consumer.kind) {
          throw new TypeError("Stream subscription consumer kind is inconsistent");
        }
        if (current.degraded) {
          throw new StreamConsumerDegradedError(key);
        }
        const ackSeq = current.ackSeq;
        if (request.afterSeq !== ackSeq) {
          throw new TypeError(
            "Stream subscription must resume from the durable consumer ACK",
          );
        }
        if (request.afterSeq < state.prunedThrough) {
          throw new StreamHistoryUnavailableError(
            request.afterSeq,
            state.prunedThrough,
          );
        }
        if (input.expiresAt !== current.expiresAt) {
          throw new TypeError(
            "Stream subscription expiry differs from its durable qualification",
          );
        }

        const frames: StoredFrame[] = [];
        let bytes = 0;
        for (const stored of [...state.frames.values()].sort(
          (left, right) => left.seq - right.seq,
        )) {
          if (stored.seq <= request.afterSeq) continue;
          if (
            frames.length > 0 &&
            (frames.length >= maxFrames || bytes + stored.ref.bytes > maxBytes)
          ) {
            break;
          }
          frames.push(stored);
          bytes += stored.ref.bytes;
        }
        const offeredSeq = frames.at(-1)?.seq ?? request.afterSeq;
        const entries = [
          ...(offeredSeq > current.offeredSeq
            ? [record({ t: "offered" as const, key, offeredSeq })]
            : []),
          ...(state.reclaimAfter !== undefined &&
          current.ackSeq < (state.verifier!.finalSeq ?? Number.MAX_SAFE_INTEGER)
            ? [record({ t: "reclaim-disarmed" as const, key })]
            : []),
        ];
        return entries.length === 0
          ? { kind: "return", value: frames }
          : { kind: "append", entries, value: frames };
      });

      const frames: StreamFrame[] = [];
      for (const stored of selected.value) {
        frames.push(await this.#readFrame(handle, stored, input.streamEpoch));
      }
      return frames;
    });
  }

  async acknowledge(
    input: StreamAck,
    streamEpoch: number,
  ): Promise<StreamSpoolSnapshot> {
    const ack = validateStreamAck(input);
    assertPositiveInteger(streamEpoch, "Stream acknowledgment epoch");
    const handle = this.#handle(ack.assignmentId);
    return handle.queue.run(async () => {
      await this.#assertNotReclaimed(handle);
      await this.#drainPendingDeletes(handle);
      const before = await this.#select(handle);
      const candidateReferences = artifactsReleasedByFrames(
        before,
        [...before.frames.values()],
      );
      await this.#transact(handle, (state, at) => {
        const key = streamConsumerKey(ack.consumer);
        const consumer = requireQualifiedConsumer(state, key);
        if (
          consumer.kind !== ack.consumer.kind ||
          streamEpoch !== consumer.streamEpoch
        ) {
          throw new TypeError("Stream acknowledgment uses a fenced connection epoch");
        }
        if (ack.ackSeq > consumer.offeredSeq) {
          throw new TypeError("Stream acknowledgment exceeds the durable offer");
        }
        if (ack.ackSeq < consumer.ackSeq) {
          throw new TypeError("Stream acknowledgment moves its waterline backward");
        }
        if (ack.ackSeq === consumer.ackSeq) {
          return { kind: "return", value: undefined };
        }

        const projected = cloneProjection(state);
        projected.consumers.get(key)!.ackSeq = ack.ackSeq;
        const throughSeq = retentionFloor(projected);
        if (throughSeq > projected.prunedThrough) {
          projected.prunedThrough = throughSeq;
        }
        const retired = framesThrough(state, throughSeq);
        const artifacts = artifactsReleasedByFrames(state, retired);
        return {
          kind: "append",
          entries: [
            record({ t: "ack", key, ackSeq: ack.ackSeq }),
            ...(throughSeq > state.prunedThrough
              ? [
                  record({
                    t: "pruned" as const,
                    throughSeq,
                    artifacts: artifacts.map(storedArtifactIdentity),
                  }),
                ]
              : []),
            ...(projected.terminal &&
            projected.reclaimAfter === undefined &&
            canArmReclaim(projected)
              ? [
                  record({
                    t: "reclaim-armed" as const,
                    reclaimAfter: new Date(
                      Date.parse(at) + this.#reclaimDelayMs,
                    ).toISOString(),
                  }),
                ]
              : []),
          ],
          value: undefined,
        };
      }, candidateReferences);
      await this.#drainPendingDeletes(handle);
      return snapshotOf(await this.#select(handle));
    });
  }

  async markTerminal(
    assignmentId: string,
    finalSeq: number,
  ): Promise<StreamSpoolSnapshot> {
    const handle = this.#handle(assignmentId);
    return handle.queue.run(async () => {
      await this.#assertNotReclaimed(handle);
      await this.#drainPendingDeletes(handle);
      const result = await this.#transact(handle, (state, at) => {
        assertOpen(state);
        if (state.verifier!.finalSeq !== finalSeq) {
          throw new TypeError("Terminal stream sequence does not match its final frame");
        }
        if (state.terminal) return { kind: "return", value: undefined };
        const projected = cloneProjection(state);
        projected.terminal = true;
        const entries: ReturnType<typeof record>[] = [
          record({ t: "terminal", finalSeq }),
        ];
        if (canArmReclaim(projected)) {
          entries.push(
            record({
              t: "reclaim-armed",
              reclaimAfter: new Date(
                Date.parse(at) + this.#reclaimDelayMs,
              ).toISOString(),
            }),
          );
        }
        return { kind: "append", entries, value: undefined };
      });
      return snapshotOf(result.state);
    });
  }

  async reclaimDue(
    assignmentId: string,
    now: IsoTime = this.#clock(),
  ): Promise<boolean> {
    assertCanonicalTime(now);
    const handle = this.#handle(assignmentId);
    return handle.queue.run(async () => {
      if (await this.#isTombstoned(handle)) {
        await rm(handle.directory, { recursive: true, force: true });
        this.#handles.delete(assignmentId);
        return true;
      }
      let state = await this.#select(handle);
      assertOpen(state);
      if (state.reclaimed) {
        await this.#writeTombstone(handle);
        await rm(handle.directory, { recursive: true, force: true });
        this.#handles.delete(assignmentId);
        return true;
      }
      if (
        state.terminal &&
        state.reclaimAfter === undefined &&
        canArmReclaim(state)
      ) {
        const armed = await this.#transact(handle, (_state, at) => ({
          kind: "append",
          entries: [
            record({
              t: "reclaim-armed",
              reclaimAfter: new Date(
                Date.parse(at) + this.#reclaimDelayMs,
              ).toISOString(),
            }),
          ],
          value: undefined,
        }));
        state = armed.state;
      }
      if (
        state.reclaimAfter === undefined ||
        Date.parse(state.reclaimAfter) > Date.parse(now)
      ) {
        return false;
      }
      await this.#transact(handle, () => ({
        kind: "append",
        entries: [record({ t: "reclaimed" })],
        value: undefined,
      }));
      await this.#writeTombstone(handle);
      await rm(handle.directory, { recursive: true, force: true });
      this.#handles.delete(assignmentId);
      return true;
    });
  }

  async snapshot(assignmentId: string): Promise<StreamSpoolSnapshot> {
    const handle = this.#handle(assignmentId);
    return handle.queue.run(async () => {
      await this.#assertNotReclaimed(handle);
      await this.#drainPendingDeletes(handle);
      return snapshotOf(await this.#select(handle));
    });
  }

  async retainedArtifactReferences(
    assignmentId: string,
  ): Promise<readonly ArtifactRef[]> {
    const handle = this.#handle(assignmentId);
    return handle.queue.run(async () => {
      await this.#assertNotReclaimed(handle);
      await this.#drainPendingDeletes(handle);
      const state = await this.#select(handle);
      return collectArtifactRefs(
        [...state.frames.values()].map((frame) => frame.contentRefs),
      );
    });
  }

  async readRetainedArtifact(
    assignmentId: string,
    ref: ArtifactRef,
  ): Promise<Uint8Array> {
    assertDigest(ref.digest, "Stream content artifact digest");
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
      throw new TypeError("Stream content artifact byte count is invalid");
    }
    const handle = this.#handle(assignmentId);
    return handle.queue.run(async () => {
      await this.#assertNotReclaimed(handle);
      await this.#drainPendingDeletes(handle);
      const state = await this.#select(handle);
      const retained = collectArtifactRefs(
        [...state.frames.values()].map((frame) => frame.contentRefs),
      );
      if (
        !retained.some(
          (candidate) =>
            candidate.digest === ref.digest &&
            candidate.bytes === ref.bytes,
        )
      ) {
        throw new TypeError(
          "Stream content artifact is not retained by this assignment",
        );
      }
      return handle.frames.get(ref);
    });
  }

  async #tryAppend(
    handle: AssignmentHandle,
    input:
      | AppendStreamFrameInput
      | (Omit<AppendStreamFrameInput, "payload"> & {
          readonly payload: StreamFrame["payload"];
        }),
    prepared: {
      readonly payload: StreamFrame["payload"];
      readonly references: readonly ArtifactRef[];
    },
  ): Promise<AppendAttempt> {
    await this.#reconcileRetention(handle);
    const state = await this.#select(handle);
    assertOpen(state);
    assertSameExecution(state, input.ref);
    if (input.sourceId !== undefined) {
      assertIdentifier(input.sourceId, "Stream source identity");
      const existingSource = state.sourceFrames.get(input.sourceId);
      if (existingSource !== undefined) {
        const existing = validateStreamFrame({
          v: 1,
          ref: clone(input.ref),
          assignmentId: input.assignmentId,
          streamEpoch: state.verifier!.streamEpoch,
          seq: existingSource.seq,
          payload: clone(prepared.payload),
          meta: clone(input.meta ?? {}),
        });
        if (
          streamLogicalFrameDigest(existing) !== existingSource.logicalDigest
        ) {
          throw new TypeError(
            "Stream source identity has conflicting logical content",
          );
        }
        return { kind: "appended", frame: existing };
      }
    }
    if (state.verifier!.finalSeq !== undefined) {
      throw new TypeError("Cannot append after the provisional final");
    }

    const seq = state.verifier!.lastSeq + 1;
    const frame = validateStreamFrame({
      v: 1,
      ref: clone(input.ref),
      assignmentId: input.assignmentId,
      streamEpoch: state.verifier!.streamEpoch,
      seq,
      payload: clone(prepared.payload),
      meta: clone(input.meta ?? {}),
    });
    if (
      frame.payload.kind === "provisional-final" &&
      frame.payload.finalSeq !== seq
    ) {
      return { kind: "retry" };
    }
    const contentRefs = collectArtifactRefs(prepared.references);
    for (const ref of contentRefs) {
      if (!(await handle.frames.has(ref))) {
        throw new TypeError(
          `Stream frame references an unavailable artifact: ${ref.digest}`,
        );
      }
    }

    const bytes = Buffer.from(canonicalize(frame), "utf8");
    if (bytes.byteLength > MAX_ASSIGNMENT_STREAM_FRAME_BYTES) {
      throw new StreamFrameSizeError(
        bytes.byteLength,
        MAX_ASSIGNMENT_STREAM_FRAME_BYTES,
      );
    }
    const storedRef = await handle.frames.put(bytes);
    const retainedRefs = collectArtifactRefs([storedRef, ...contentRefs]);
    const requiredBytes = additionalRetainedBytes(state, retainedRefs);
    if (requiredBytes > state.capacityBytes!) {
      throw new StreamSpoolCapacityError(
        requiredBytes,
        state.capacityBytes!,
      );
    }
    if (state.retainedBytes + requiredBytes > state.capacityBytes!) {
      return { kind: "full" };
    }

    const logicalDigest = streamLogicalFrameDigest(frame);
    const verifier = advanceVerifier(state.verifier!, frame);
    const result = await this.#transact(handle, (current) => {
      assertOpen(current);
      if (
        current.verifier!.lastSeq !== state.verifier!.lastSeq
      ) {
        return { kind: "return", value: false };
      }
      const currentRequired = additionalRetainedBytes(current, retainedRefs);
      if (current.retainedBytes + currentRequired > current.capacityBytes!) {
        return { kind: "return", value: false };
      }
      const entries: ReturnType<typeof record>[] = [
        record({
          t: "frame",
          seq,
          frame: storedArtifactIdentity(storedRef),
          logicalDigest,
          contentRefs: contentRefs.map(storedArtifactIdentity),
          verifier,
          ...(input.sourceId === undefined
            ? {}
            : { sourceId: input.sourceId }),
          ...(frame.payload.kind === "interaction"
            ? {
                interaction: {
                  t: frame.payload.event.t,
                  requestId: frame.payload.event.requestId,
                },
              }
            : {}),
        }),
      ];
      for (const consumer of slowSurfaceConsumers(current, retainedRefs)) {
        entries.push(record({ t: "degraded", key: consumer.key }));
      }
      return { kind: "append", entries, value: true };
    }, retainedRefs);
    if (
      !result.value &&
      ![...result.state.frames.values()].some(
        (stored) => stored.ref.digest === storedRef.digest,
      )
    ) {
      await rm(handle.frames.pathFor(storedRef), { force: true });
    }
    return result.value
      ? { kind: "appended", frame }
      : { kind: "retry" };
  }

  async #reconcileRetention(handle: AssignmentHandle): Promise<void> {
    await this.#drainPendingDeletes(handle);
    const before = await this.#select(handle);
    if (before.ref === undefined) return;
    const candidateReferences = artifactsReleasedByFrames(
      before,
      [...before.frames.values()],
    );
    await this.#transact(handle, (state) => {
      const projected = cloneProjection(state);
      const degraded = slowSurfaceConsumers(projected, []);
      for (const consumer of degraded) consumer.degraded = true;
      const throughSeq = retentionFloor(projected);
      if (degraded.length === 0 && throughSeq <= state.prunedThrough) {
        return { kind: "return", value: undefined };
      }
      const retired = framesThrough(state, throughSeq);
      const artifacts = artifactsReleasedByFrames(state, retired);
      return {
        kind: "append",
        entries: [
          ...degraded.map((consumer) =>
            record({ t: "degraded" as const, key: consumer.key }),
          ),
          ...(throughSeq > state.prunedThrough
            ? [
                record({
                  t: "pruned" as const,
                  throughSeq,
                  artifacts: artifacts.map(storedArtifactIdentity),
                }),
              ]
            : []),
        ],
        value: undefined,
      };
    }, candidateReferences);
    await this.#drainPendingDeletes(handle);
  }

  async #readFrame(
    handle: AssignmentHandle,
    stored: StoredFrame,
    streamEpoch: number,
  ): Promise<StreamFrame> {
    const bytes = await handle.frames.get(stored.ref);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch (error) {
      throw new TypeError("Stored stream frame is not valid JSON", {
        cause: error,
      });
    }
    const storedFrame = validateStreamFrame(parsed);
    if (
      canonicalize(storedFrame) !== Buffer.from(bytes).toString("utf8") ||
      streamLogicalFrameDigest(storedFrame) !== stored.logicalDigest
    ) {
      throw new TypeError("Stored stream frame is not canonical logical content");
    }
    if (storedFrame.payload.kind !== "provisional-final") {
      await materializeStreamDataPayload(storedFrame.payload, handle.frames);
    }
    return validateStreamFrame({ ...storedFrame, streamEpoch });
  }

  async #select(handle: AssignmentHandle): Promise<SpoolProjection> {
    const result = await this.#transact(handle, () => ({
      kind: "return",
      value: undefined,
    }));
    return result.state;
  }

  async #transact<Value>(
    handle: AssignmentHandle,
    decide: (
      state: SpoolProjection,
      at: IsoTime,
    ) => ProjectionTransactionDecision<SpoolRecord, Value>,
    candidateReferences: readonly ArtifactRef[] = [],
  ) {
    const cached = handle.cache;
    const result = await handle.log.transactProjection<
      SpoolProjection,
      SpoolRecord,
      Value
    >(
      cached === undefined
        ? emptyProjection(handle.assignmentId)
        : cloneProjection(cached.state),
      reduceSpoolRecord,
      (state, context) => decide(state, context.at),
      {
        stream: STREAM,
        ...(candidateReferences.length === 0
          ? {}
          : { candidateReferences }),
        ...(cached === undefined ? {} : { cursor: cached.cursor }),
      },
    );
    handle.cache = { state: result.state, cursor: result.cursor };
    return result;
  }

  #handle(assignmentId: string): AssignmentHandle {
    assertIdentifier(assignmentId, "Stream assignmentId");
    const current = this.#handles.get(assignmentId);
    if (current !== undefined) return current;
    const key = assignmentKey(assignmentId);
    const directory = path.join(this.#rootDir, "assignments", key);
    const frames = new FileArtifactStore(path.join(directory, "frames"));
    const handle: AssignmentHandle = {
      assignmentId,
      directory,
      frames,
      log: new FileAuthorityCommitLog(path.join(directory, "index"), frames, {
        clock: this.#clock,
      }),
      queue: new SerialTaskQueue(),
      waiters: new Set(),
      cleanupComplete: false,
    };
    this.#handles.set(assignmentId, handle);
    return handle;
  }

  async #assertNotReclaimed(handle: AssignmentHandle): Promise<void> {
    if (
      (await this.#isTombstoned(handle)) ||
      (await this.#select(handle)).reclaimed
    ) {
      throw new TypeError("Assignment stream spool was permanently reclaimed");
    }
  }

  async #isTombstoned(handle: AssignmentHandle): Promise<boolean> {
    const tombstone = this.#tombstonePath(handle.assignmentId);
    try {
      const file = await open(tombstone, "r");
      await file.close();
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async #cleanupOrphanFrames(
    handle: AssignmentHandle,
    state: SpoolProjection,
    force = false,
  ): Promise<void> {
    if (handle.cleanupComplete && !force) return;
    const indexArtifacts = collectArtifactRefs(await handle.log.readAll());
    const retained = new Set(
      [
        ...[...state.artifacts.values()].map((artifact) => artifact.ref),
        ...state.pendingDeletes.values(),
        ...indexArtifacts,
      ].map((ref) => ref.digest.slice("sha256:".length)),
    );
    const root = path.join(handle.frames.rootDir, "sha256");
    const prefixes = await readdir(root, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      },
    );
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue;
      const directory = path.join(root, prefix.name);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isFile() &&
          /^[a-f0-9]{64}$/u.test(entry.name) &&
          !retained.has(entry.name)
        ) {
          await rm(path.join(directory, entry.name), { force: true });
        }
      }
      await rm(directory, { recursive: false }).catch(() => undefined);
    }
    handle.cleanupComplete = true;
  }

  async #drainPendingDeletes(handle: AssignmentHandle): Promise<void> {
    const before = await this.#select(handle);
    const pending = [...before.pendingDeletes.values()];
    if (pending.length === 0) return;
    for (const ref of pending) {
      await this.#removeRetiredArtifact(handle.frames, ref);
    }
    await this.#transact(handle, (state) => {
      const stillPending = pending.filter(
        (ref) => state.pendingDeletes.get(ref.digest)?.bytes === ref.bytes,
      );
      return stillPending.length === 0
        ? { kind: "return", value: undefined }
        : {
            kind: "append",
            entries: [
              record({
                t: "deleted",
                deletions: stillPending.map(storedArtifactIdentity),
              }),
            ],
            value: undefined,
          };
    });
    this.#notifyCapacity(handle);
  }

  async #waitForCapacity(
    handle: AssignmentHandle,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        handle.waiters.delete(onCapacity);
        signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onCapacity = () => finish();
      const onAbort = () => finish(signal?.reason ?? new Error("Aborted"));
      const timer = setTimeout(onCapacity, 250);
      handle.waiters.add(onCapacity);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #notifyCapacity(handle: AssignmentHandle): void {
    for (const notify of [...handle.waiters]) notify();
  }

  async #writeTombstone(handle: AssignmentHandle): Promise<void> {
    const directory = path.join(this.#rootDir, "tombstones");
    await ensureDurableDirectory(directory);
    const target = this.#tombstonePath(handle.assignmentId);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(
      temporary,
      canonicalize({
        v: TOMBSTONE_VERSION,
        assignmentId: handle.assignmentId,
        reclaimedAt: this.#clock(),
      }),
      { encoding: "utf8", flag: "wx", flush: true },
    );
    await rename(temporary, target);
    await syncDirectory(directory);
  }

  #tombstonePath(assignmentId: string): string {
    return path.join(
      this.#rootDir,
      "tombstones",
      `${assignmentKey(assignmentId)}.json`,
    );
  }
}

function reduceSpoolRecord(
  state: SpoolProjection,
  logical: { readonly body: unknown },
  envelope: { readonly at: IsoTime },
): SpoolProjection {
  const body = validateSpoolRecord(logical.body);
  if (state.reclaimed) {
    throw corruptSpool("Stream record follows permanent reclamation");
  }
  switch (body.t) {
    case "opened": {
      if (state.ref !== undefined || body.assignmentId !== state.assignmentId) {
        throw corruptSpool("Stream open record is inconsistent");
      }
      const expectedVerifier: StreamVerifierCheckpoint = {
        assignmentId: body.assignmentId,
        ref: clone(body.ref),
        streamEpoch: 1,
        lastSeq: 0,
        ...new StreamDigestChain(body.assignmentId).checkpoint(),
      };
      if (canonicalize(body.verifier) !== canonicalize(expectedVerifier)) {
        throw corruptSpool("Stream open checkpoint is inconsistent");
      }
      state.ref = clone(body.ref);
      state.capacityBytes = body.capacityBytes;
      state.verifier = clone(body.verifier);
      return state;
    }
    case "frame": {
      assertOpen(state);
      if (state.verifier!.finalSeq !== undefined || state.terminal) {
        throw corruptSpool("Stream frame follows the provisional final");
      }
      const frameRef = validateStoredArtifactIdentities(
        [body.frame],
        "Stored frame",
      )[0]!;
      assertDigest(body.logicalDigest, "Stored logical frame digest");
      if (
        body.seq !== state.verifier!.lastSeq + 1 ||
        body.verifier.lastSeq !== body.seq ||
        body.verifier.assignmentId !== state.assignmentId ||
        canonicalize(body.verifier.ref) !== canonicalize(state.ref) ||
        body.verifier.streamEpoch !== state.verifier!.streamEpoch
      ) {
        throw corruptSpool("Stored stream frame checkpoint is inconsistent");
      }
      assertDigest(body.verifier.head, "Stored stream chain head");
      assertDigest(
        body.verifier.lastLogicalDigest,
        "Stored stream frame logical digest",
      );
      if (body.verifier.lastLogicalDigest !== body.logicalDigest) {
        throw corruptSpool("Stored stream frame digest binding is inconsistent");
      }
      const dataDelta =
        body.verifier.dataFrames - state.verifier!.dataFrames;
      if (
        (body.verifier.finalSeq === undefined && dataDelta !== 1) ||
        (body.verifier.finalSeq !== undefined &&
          (dataDelta !== 0 || body.verifier.finalSeq !== body.seq))
      ) {
        throw corruptSpool("Stored stream chain checkpoint is inconsistent");
      }
      const contentRefs = validateStoredArtifactIdentities(
        body.contentRefs,
        "Stored stream content references",
      );
      state.frames.set(body.seq, {
        seq: body.seq,
        ref: frameRef,
        logicalDigest: body.logicalDigest,
        contentRefs,
      });
      if (body.sourceId !== undefined) {
        assertIdentifier(body.sourceId, "Stream source identity");
        if (state.sourceFrames.has(body.sourceId)) {
          throw corruptSpool("Stream source identity is duplicated");
        }
        state.sourceFrames.set(body.sourceId, {
          seq: body.seq,
          logicalDigest: body.logicalDigest,
        });
      }
      for (const ref of collectArtifactRefs([
        frameRef,
        ...contentRefs,
      ])) {
        retainArtifact(state, ref);
      }
      if (body.interaction?.t === "requested") {
        if (state.pendingInteractions.has(body.interaction.requestId)) {
          throw corruptSpool("Interaction request is duplicated in the stream");
        }
        state.pendingInteractions.add(body.interaction.requestId);
      } else if (body.interaction?.t === "finished") {
        if (!state.pendingInteractions.delete(body.interaction.requestId)) {
          throw corruptSpool(
            "Interaction completion has no matching stream request",
          );
        }
      }
      state.verifier = clone(body.verifier);
      return state;
    }
    case "consumer-qualified": {
      assertOpen(state);
      const current = state.consumers.get(body.key);
      if (current !== undefined && current.kind !== body.kind) {
        throw corruptSpool("Stream consumer kind changed");
      }
      state.consumers.set(body.key, {
        key: body.key,
        kind: body.kind,
        ackSeq: current?.ackSeq ?? 0,
        offeredSeq: current?.offeredSeq ?? 0,
        degraded: current?.degraded ?? false,
        qualified: true,
        streamEpoch: current?.streamEpoch ?? 0,
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
      });
      return state;
    }
    case "consumer-revoked": {
      const consumer = requireConsumer(state, body.key);
      if (!consumer.qualified) {
        throw corruptSpool("Stream consumer was already revoked");
      }
      consumer.qualified = false;
      return state;
    }
    case "connection": {
      const consumer = requireReplayQualifiedConsumer(state, body.key);
      if (
        !consumer.qualified ||
        body.streamEpoch !== consumer.streamEpoch + 1
      ) {
        throw corruptSpool("Stream consumer epoch is not contiguous");
      }
      consumer.streamEpoch = body.streamEpoch;
      return state;
    }
    case "offered": {
      const consumer = requireReplayQualifiedConsumer(state, body.key);
      if (
        consumer.degraded ||
        body.offeredSeq < consumer.offeredSeq ||
        body.offeredSeq > state.verifier!.lastSeq
      ) {
        throw corruptSpool("Stream offer waterline is invalid");
      }
      consumer.offeredSeq = body.offeredSeq;
      return state;
    }
    case "ack": {
      const consumer = requireReplayQualifiedConsumer(state, body.key);
      if (
        body.ackSeq < consumer.ackSeq ||
        body.ackSeq > consumer.offeredSeq
      ) {
        throw corruptSpool("Stream ACK waterline is invalid");
      }
      consumer.ackSeq = body.ackSeq;
      return state;
    }
    case "degraded": {
      const consumer = requireReplayQualifiedConsumer(state, body.key);
      if (
        consumer.kind !== "surface-ticket" ||
        !consumer.qualified ||
        consumer.degraded
      ) {
        throw corruptSpool("Stream consumer degradation is inconsistent");
      }
      consumer.degraded = true;
      return state;
    }
    case "pruned":
      if (
        body.throughSeq <= state.prunedThrough ||
        body.throughSeq > state.verifier!.lastSeq ||
        body.throughSeq > retentionFloor(state)
      ) {
        throw corruptSpool("Stream prune waterline is invalid");
      }
      const retired = framesThrough(state, body.throughSeq);
      const expectedArtifacts = artifactsReleasedByFrames(state, retired);
      const recordedArtifacts = validateStoredArtifactIdentities(
        body.artifacts,
        "Stored stream prune artifacts",
      );
      if (canonicalize(recordedArtifacts) !== canonicalize(expectedArtifacts)) {
        throw corruptSpool("Stream prune artifact release set is inconsistent");
      }
      for (const [seq, frame] of state.frames) {
        if (seq > body.throughSeq) continue;
        state.frames.delete(seq);
        for (const ref of collectArtifactRefs([frame.ref, ...frame.contentRefs])) {
          releaseArtifact(state, ref);
        }
      }
      for (const ref of recordedArtifacts) {
        state.pendingDeletes.set(ref.digest, ref);
      }
      state.prunedThrough = body.throughSeq;
      return state;
    case "deleted": {
      const artifacts = validateStoredArtifactIdentities(
        body.deletions,
        "Stored stream deletions",
      );
      for (const ref of artifacts) {
        const pending = state.pendingDeletes.get(ref.digest);
        if (pending?.bytes !== ref.bytes) {
          throw corruptSpool("Stream deletion names no pending artifact");
        }
        state.pendingDeletes.delete(ref.digest);
        state.retainedBytes -= ref.bytes;
      }
      return state;
    }
    case "terminal":
      if (
        state.terminal ||
        state.verifier?.finalSeq === undefined ||
        body.finalSeq !== state.verifier.finalSeq
      ) {
        throw corruptSpool("Stream terminal record is inconsistent");
      }
      state.terminal = true;
      return state;
    case "reclaim-armed":
      if (
        !state.terminal ||
        state.reclaimAfter !== undefined ||
        !canArmReclaim(state) ||
        Date.parse(body.reclaimAfter) <= Date.parse(envelope.at)
      ) {
        throw corruptSpool("Stream reclamation was armed in an invalid state");
      }
      state.reclaimAfter = body.reclaimAfter;
      return state;
    case "reclaim-disarmed":
      const disarmingConsumer = requireReplayQualifiedConsumer(state, body.key);
      if (
        state.reclaimAfter === undefined ||
        state.verifier?.finalSeq === undefined ||
        disarmingConsumer.degraded ||
        disarmingConsumer.ackSeq >= state.verifier.finalSeq
      ) {
        throw corruptSpool("Stream reclamation disarm record is inconsistent");
      }
      state.reclaimAfter = undefined;
      return state;
    case "reclaimed":
      if (
        state.reclaimAfter === undefined ||
        !canArmReclaim(state) ||
        Date.parse(envelope.at) < Date.parse(state.reclaimAfter) ||
        state.pendingDeletes.size > 0
      ) {
        throw corruptSpool("Stream reclamation record is inconsistent");
      }
      state.reclaimed = true;
      return state;
  }
}

function validateSpoolRecord(value: unknown): SpoolRecord {
  assertPlainObject(value, "Stream spool record");
  switch (value.t) {
    case "opened":
      assertExactKeys(
        value,
        ["assignmentId", "capacityBytes", "ref", "t", "verifier"],
        "Stream open record",
      );
      assertIdentifier(value.assignmentId, "Stream assignmentId");
      assertPositiveInteger(value.capacityBytes, "Stream spool capacity");
      validateVerifierCheckpoint(value.verifier, "Stream open checkpoint");
      return value as unknown as SpoolRecord;
    case "frame":
      assertExactKeys(
        value,
        [
          "contentRefs",
          "frame",
          ...(Object.hasOwn(value, "interaction") ? ["interaction"] : []),
          "logicalDigest",
          "seq",
          ...(Object.hasOwn(value, "sourceId") ? ["sourceId"] : []),
          "t",
          "verifier",
        ],
        "Stream frame record",
      );
      assertPositiveInteger(value.seq, "Stored stream frame sequence");
      validateStoredArtifactIdentities([value.frame], "Stored frame");
      validateStoredArtifactIdentities(
        value.contentRefs,
        "Stored stream content references",
      );
      assertDigest(value.logicalDigest, "Stored logical frame digest");
      validateVerifierCheckpoint(value.verifier, "Stored stream checkpoint");
      if (value.sourceId !== undefined) {
        assertIdentifier(value.sourceId, "Stream source identity");
      }
      if (value.interaction !== undefined) {
        validateStoredInteraction(value.interaction);
      }
      return value as unknown as SpoolRecord;
    case "consumer-qualified":
      assertExactKeys(
        value,
        [
          ...(Object.hasOwn(value, "expiresAt") ? ["expiresAt"] : []),
          "key",
          "kind",
          "t",
        ],
        "Stream consumer qualification record",
      );
      validateStoredConsumer(value.key, value.kind, value.expiresAt);
      return value as unknown as SpoolRecord;
    case "consumer-revoked":
    case "degraded":
      assertExactKeys(value, ["key", "t"], "Stream consumer record");
      assertIdentifier(value.key, "Stream consumer key");
      return value as unknown as SpoolRecord;
    case "connection":
      assertExactKeys(
        value,
        ["key", "streamEpoch", "t"],
        "Stream connection record",
      );
      assertIdentifier(value.key, "Stream consumer key");
      assertPositiveInteger(value.streamEpoch, "Stream connection epoch");
      return value as unknown as SpoolRecord;
    case "offered":
      assertExactKeys(
        value,
        ["key", "offeredSeq", "t"],
        "Stream offer record",
      );
      assertIdentifier(value.key, "Stream consumer key");
      assertNonNegativeInteger(value.offeredSeq, "Stream offer waterline");
      return value as unknown as SpoolRecord;
    case "ack":
      assertExactKeys(value, ["ackSeq", "key", "t"], "Stream ACK record");
      assertIdentifier(value.key, "Stream consumer key");
      assertNonNegativeInteger(value.ackSeq, "Stream ACK waterline");
      return value as unknown as SpoolRecord;
    case "pruned":
      assertExactKeys(
        value,
        ["artifacts", "t", "throughSeq"],
        "Stream prune record",
      );
      assertPositiveInteger(value.throughSeq, "Stream prune waterline");
      validateStoredArtifactIdentities(
        value.artifacts,
        "Stored stream prune artifacts",
      );
      return value as unknown as SpoolRecord;
    case "deleted":
      assertExactKeys(
        value,
        ["deletions", "t"],
        "Stream deletion record",
      );
      if (!Array.isArray(value.deletions) || value.deletions.length === 0) {
        throw corruptSpool("Stream deletion record is empty");
      }
      validateStoredArtifactIdentities(
        value.deletions,
        "Stored stream deletions",
      );
      return value as unknown as SpoolRecord;
    case "terminal":
      assertExactKeys(value, ["finalSeq", "t"], "Stream terminal record");
      assertPositiveInteger(value.finalSeq, "Stream terminal sequence");
      return value as unknown as SpoolRecord;
    case "reclaim-armed":
      assertExactKeys(
        value,
        ["reclaimAfter", "t"],
        "Stream reclaim arm record",
      );
      assertCanonicalTime(value.reclaimAfter);
      return value as unknown as SpoolRecord;
    case "reclaim-disarmed":
      assertExactKeys(value, ["key", "t"], "Stream reclamation disarm record");
      assertIdentifier(value.key, "Stream consumer key");
      return value as unknown as SpoolRecord;
    case "reclaimed":
      assertExactKeys(value, ["t"], "Stream reclamation record");
      return value as unknown as SpoolRecord;
    default:
      throw corruptSpool("Unknown stream spool record kind");
  }
}

function validateVerifierCheckpoint(
  value: unknown,
  label: string,
): StreamVerifierCheckpoint {
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    [
      "assignmentId",
      "dataFrames",
      ...(Object.hasOwn(value, "finalSeq") ? ["finalSeq"] : []),
      "head",
      ...(Object.hasOwn(value, "lastLogicalDigest")
        ? ["lastLogicalDigest"]
        : []),
      "lastSeq",
      "ref",
      "streamEpoch",
    ],
    label,
  );
  const checkpoint = new StreamFrameVerifier(
    value as unknown as StreamVerifierCheckpoint,
  ).checkpoint();
  if (canonicalize(checkpoint) !== canonicalize(value)) {
    throw corruptSpool(`${label} is not canonical`);
  }
  return checkpoint;
}

function validateStoredInteraction(value: unknown): void {
  assertPlainObject(value, "Stored stream interaction");
  if (value.t !== "requested" && value.t !== "finished") {
    throw corruptSpool("Stored stream interaction kind is invalid");
  }
  assertExactKeys(
    value,
    ["requestId", "t"],
    "Stored stream interaction",
  );
  assertIdentifier(value.requestId, "Stored interaction requestId");
}

function validateStoredConsumer(
  key: unknown,
  kind: unknown,
  expiresAt: unknown,
): void {
  assertIdentifier(key, "Stream consumer key");
  if (kind === "surface-ticket") {
    if (!key.startsWith("surface:") || expiresAt === undefined) {
      throw corruptSpool("Surface stream consumer qualification is invalid");
    }
    assertCanonicalTime(expiresAt);
    return;
  }
  if (kind === "owner-relay") {
    if (!key.startsWith("owner-relay:") || expiresAt !== undefined) {
      throw corruptSpool("Owner relay stream consumer qualification is invalid");
    }
    return;
  }
  throw corruptSpool("Stream consumer kind is invalid");
}

function emptyProjection(assignmentId: string): SpoolProjection {
  return {
    assignmentId,
    frames: new Map(),
    consumers: new Map(),
    pendingInteractions: new Set(),
    sourceFrames: new Map(),
    artifacts: new Map(),
    pendingDeletes: new Map(),
    retainedBytes: 0,
    prunedThrough: 0,
    terminal: false,
    reclaimed: false,
  };
}

function cloneProjection(state: SpoolProjection): SpoolProjection {
  return {
    assignmentId: state.assignmentId,
    ...(state.ref === undefined ? {} : { ref: clone(state.ref) }),
    ...(state.capacityBytes === undefined
      ? {}
      : { capacityBytes: state.capacityBytes }),
    ...(state.verifier === undefined
      ? {}
      : { verifier: clone(state.verifier) }),
    frames: new Map(
      [...state.frames].map(([seq, frame]) => [seq, clone(frame)]),
    ),
    consumers: new Map(
      [...state.consumers].map(([key, consumer]) => [
        key,
        { ...consumer },
      ]),
    ),
    pendingInteractions: new Set(state.pendingInteractions),
    sourceFrames: new Map(
      [...state.sourceFrames].map(([sourceId, source]) => [
        sourceId,
        { ...source },
      ]),
    ),
    artifacts: new Map(
      [...state.artifacts].map(([digest, artifact]) => [
        digest,
        { ref: clone(artifact.ref), count: artifact.count },
      ]),
    ),
    pendingDeletes: new Map(
      [...state.pendingDeletes].map(([digest, ref]) => [
        digest,
        clone(ref),
      ]),
    ),
    retainedBytes: state.retainedBytes,
    prunedThrough: state.prunedThrough,
    terminal: state.terminal,
    ...(state.reclaimAfter === undefined
      ? {}
      : { reclaimAfter: state.reclaimAfter }),
    reclaimed: state.reclaimed,
  };
}

function advanceVerifier(
  checkpoint: StreamVerifierCheckpoint,
  frame: StreamFrame,
): StreamVerifierCheckpoint {
  const logicalDigest = streamLogicalFrameDigest(frame);
  if (frame.payload.kind === "provisional-final") {
    return {
      ...checkpoint,
      finalSeq: frame.seq,
      lastSeq: frame.seq,
      lastLogicalDigest: logicalDigest,
    };
  }
  const chain = new StreamDigestChain(frame.assignmentId, checkpoint);
  const seq = chain.append(frame.payload, frame.meta);
  if (seq !== frame.seq) {
    throw new TypeError("Stream frame sequence does not match its chain");
  }
  return {
    assignmentId: frame.assignmentId,
    ref: clone(frame.ref),
    streamEpoch: frame.streamEpoch,
    lastSeq: frame.seq,
    lastLogicalDigest: logicalDigest,
    ...chain.checkpoint(),
  };
}

function slowSurfaceConsumers(
  state: SpoolProjection,
  additionalRefs: readonly ArtifactRef[],
): ConsumerState[] {
  if (state.capacityBytes === undefined) return [];
  const threshold = state.capacityBytes / 2;
  return [...state.consumers.values()].filter((consumer) => {
    if (
      consumer.kind !== "surface-ticket" ||
      !consumer.qualified ||
      consumer.degraded
    ) {
      return false;
    }
    const lagRefs = new Map<string, ArtifactRef>();
    for (const frame of state.frames.values()) {
      if (frame.seq <= consumer.ackSeq) continue;
      for (const ref of collectArtifactRefs([frame.ref, ...frame.contentRefs])) {
        lagRefs.set(ref.digest, ref);
      }
    }
    for (const ref of additionalRefs) lagRefs.set(ref.digest, ref);
    const lagBytes = [...lagRefs.values()].reduce(
      (total, ref) => total + ref.bytes,
      0,
    );
    return lagBytes > threshold;
  });
}

function retentionFloor(state: SpoolProjection): number {
  const active = [...state.consumers.values()].filter((consumer) => {
    return consumer.qualified && !consumer.degraded;
  });
  if (
    state.ref?.execution === "job" &&
    !active.some((consumer) => consumer.kind === "owner-relay")
  ) {
    return state.prunedThrough;
  }
  if (active.length === 0) {
    if (state.consumers.size === 0) return state.prunedThrough;
    return state.verifier?.lastSeq ?? state.prunedThrough;
  }
  return Math.max(
    state.prunedThrough,
    Math.min(...active.map((consumer) => consumer.ackSeq)),
  );
}

function canArmReclaim(state: SpoolProjection): boolean {
  const finalSeq = state.verifier?.finalSeq;
  if (!state.terminal || finalSeq === undefined) return false;
  const valid = [...state.consumers.values()].filter(
    (consumer) => consumer.qualified && !consumer.degraded,
  );
  if (state.ref?.execution === "job") {
    const relay = valid.find((consumer) => consumer.kind === "owner-relay");
    const surfacesComplete = valid
      .filter((consumer) => consumer.kind === "surface-ticket")
      .every((consumer) => consumer.ackSeq >= finalSeq);
    if (!surfacesComplete) {
      return false;
    }
    if (relay?.ackSeq === finalSeq) return true;
    return state.pendingInteractions.size === 0;
  }
  return valid.every((consumer) => consumer.ackSeq >= finalSeq);
}

function framesThrough(
  state: SpoolProjection,
  throughSeq: number,
): StoredFrame[] {
  return [...state.frames.values()].filter(
    (frame) => frame.seq <= throughSeq,
  );
}

function validateStoredArtifactIdentities(
  value: unknown,
  label: string,
): ArtifactRef[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw corruptSpool(`${label} are not a dense array`);
  }
  const decoded = value.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !==
        "artifactBytes,artifactDigest"
    ) {
      throw corruptSpool(`${label} contain an invalid identity`);
    }
    const deletion = entry as {
      readonly artifactDigest?: unknown;
      readonly artifactBytes?: unknown;
    };
    assertDigest(deletion.artifactDigest, `${label} digest`);
    if (
      !Number.isSafeInteger(deletion.artifactBytes) ||
      (deletion.artifactBytes as number) < 0
    ) {
      throw corruptSpool(`${label} byte count is invalid`);
    }
    return {
      digest: deletion.artifactDigest,
      bytes: deletion.artifactBytes as number,
    };
  });
  const normalized = collectArtifactRefs(decoded);
  if (canonicalize(normalized) !== canonicalize(decoded)) {
    throw corruptSpool(`${label} are not canonical`);
  }
  return normalized;
}

function storedArtifactIdentity(ref: ArtifactRef): StoredArtifactIdentity {
  return {
    artifactDigest: ref.digest,
    artifactBytes: ref.bytes,
  };
}

function retainArtifact(state: SpoolProjection, ref: ArtifactRef): void {
  const pending = state.pendingDeletes.get(ref.digest);
  if (pending !== undefined) {
    throw corruptSpool("Stream frame reused an artifact pending deletion");
  }
  const current = state.artifacts.get(ref.digest);
  if (current !== undefined) {
    if (current.ref.bytes !== ref.bytes) {
      throw corruptSpool("Stream artifact digest has inconsistent byte counts");
    }
    current.count += 1;
    return;
  }
  state.artifacts.set(ref.digest, { ref: clone(ref), count: 1 });
  state.retainedBytes += ref.bytes;
}

function releaseArtifact(state: SpoolProjection, ref: ArtifactRef): void {
  const current = state.artifacts.get(ref.digest);
  if (current?.ref.bytes !== ref.bytes || current.count <= 0) {
    throw corruptSpool("Stream prune released an unretained artifact");
  }
  current.count -= 1;
  if (current.count === 0) state.artifacts.delete(ref.digest);
}

function additionalRetainedBytes(
  state: SpoolProjection,
  refs: readonly ArtifactRef[],
): number {
  return collectArtifactRefs(refs).reduce(
    (total, ref) =>
      total +
      (state.artifacts.has(ref.digest) || state.pendingDeletes.has(ref.digest)
        ? 0
        : ref.bytes),
    0,
  );
}

function artifactsReleasedByFrames(
  state: SpoolProjection,
  frames: readonly StoredFrame[],
): ArtifactRef[] {
  const decrements = new Map<string, number>();
  const refs = new Map<string, ArtifactRef>();
  for (const frame of frames) {
    for (const ref of collectArtifactRefs([frame.ref, ...frame.contentRefs])) {
      refs.set(ref.digest, ref);
      decrements.set(ref.digest, (decrements.get(ref.digest) ?? 0) + 1);
    }
  }
  return [...refs.values()]
    .filter((ref) => {
      const current = state.artifacts.get(ref.digest);
      if (
        current?.ref.bytes !== ref.bytes ||
        current.count < (decrements.get(ref.digest) ?? 0)
      ) {
        throw corruptSpool("Stream prune artifact accounting is inconsistent");
      }
      return current.count === decrements.get(ref.digest);
    })
    .sort((left, right) => left.digest.localeCompare(right.digest));
}

function snapshotOf(state: SpoolProjection): StreamSpoolSnapshot {
  assertOpen(state);
  return {
    assignmentId: state.assignmentId,
    ref: clone(state.ref!),
    lastSeq: state.verifier!.lastSeq,
    ...(state.verifier!.finalSeq === undefined
      ? {}
      : { finalSeq: state.verifier!.finalSeq }),
    retainedBytes: state.retainedBytes,
    prunedThrough: state.prunedThrough,
    terminal: state.terminal,
    ...(state.reclaimAfter === undefined
      ? {}
      : { reclaimAfter: state.reclaimAfter }),
    consumers: [...state.consumers.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((consumer) => ({ ...consumer })),
  };
}

function assertOpen(
  state: SpoolProjection,
): asserts state is SpoolProjection & {
  ref: ExecutionRef;
  capacityBytes: number;
  verifier: StreamVerifierCheckpoint;
} {
  if (
    state.ref === undefined ||
    state.capacityBytes === undefined ||
    state.verifier === undefined
  ) {
    throw new TypeError("Assignment stream spool is not open");
  }
}

function assertSameExecution(
  state: SpoolProjection,
  ref: ExecutionRef,
): void {
  if (state.ref === undefined || canonicalize(state.ref) !== canonicalize(ref)) {
    throw new TypeError("Assignment stream spool belongs to another execution");
  }
}

function requireConsumer(
  state: SpoolProjection,
  key: string,
): ConsumerState {
  const consumer = state.consumers.get(key);
  if (consumer === undefined) {
    throw corruptSpool("Stream record names an unknown consumer");
  }
  return consumer;
}

function requireQualifiedConsumer(
  state: SpoolProjection,
  key: string,
): ConsumerState {
  const consumer = state.consumers.get(key);
  if (consumer === undefined || !consumer.qualified) {
    throw new TypeError("Stream consumer is not durably qualified");
  }
  return consumer;
}

function requireReplayQualifiedConsumer(
  state: SpoolProjection,
  key: string,
): ConsumerState {
  const consumer = state.consumers.get(key);
  if (consumer === undefined || !consumer.qualified) {
    throw corruptSpool("Stream record names an unavailable consumer");
  }
  return consumer;
}

function record(body: SpoolRecord): {
  readonly stream: string;
  readonly body: SpoolRecord;
} {
  return { stream: STREAM, body };
}

function assignmentKey(assignmentId: string): string {
  return byteDigest(Buffer.from(assignmentId, "utf8")).slice("sha256:".length);
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 480) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertPositiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertCanonicalTime(value: unknown): asserts value is IsoTime {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("Timestamp must be canonical ISO time");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }
}

function corruptSpool(message: string): TypeError {
  return new TypeError(`Corrupt assignment stream spool: ${message}`);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
