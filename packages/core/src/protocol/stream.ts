import { TextDecoder } from "node:util";
import { collectArtifactRefs } from "../authority/artifact-references.js";
import type { ArtifactStore } from "../authority/interfaces.js";
import type {
  ArtifactRef,
  ExecutionRef,
  StreamAck,
  StreamConsumerAuth,
  StreamFrame,
  StreamSubscribe,
} from "../contracts/index.js";
import { MAX_INLINE_STREAM_ITEM_BYTES } from "../contracts/index.js";
import {
  isProjectedPassthroughEvent,
  type SessionEventProjection,
} from "../types/agent-events.js";
import type { AgentYield } from "../loop/types.js";
import type { TokenUsage } from "../types/llm.js";
import type { Digest } from "../types/distributed.js";
import { byteDigest, canonicalize, protocolDigest } from "./canonical.js";
import {
  materializeInteractionDisplay,
  validateInteractionDisplay,
} from "./interaction-display.js";
import { assertProtocolIdentifier } from "./validation.js";
import { validateMessage } from "./values.js";

export type StreamDataFramePayload = Exclude<
  StreamFrame["payload"],
  { readonly kind: "provisional-final" }
>;

export type StreamFrameMeta = StreamFrame["meta"];

export interface PreparedStreamDataPayload {
  readonly payload: StreamDataFramePayload;
  readonly references: readonly ArtifactRef[];
}

/** Producer boundary shared by in-memory digesting and durable stream spools. */
export interface StreamFrameAppender {
  append(
    payload: StreamDataFramePayload,
    meta?: StreamFrameMeta,
    signal?: AbortSignal,
    sourceId?: string,
  ): unknown | Promise<unknown>;
}

/** Complete producer boundary shared by digest-only and durable stream writers. */
export interface StreamFrameProducer extends StreamFrameAppender {
  final(
    meta?: StreamFrameMeta,
    signal?: AbortSignal,
  ):
    | { readonly finalSeq: number; readonly streamDigest: string }
    | Promise<{ readonly finalSeq: number; readonly streamDigest: string }>;
}

/**
 * Freezes one producer value into the representation used by the durable
 * stream. Semantic validation always precedes externalization.
 */
export async function prepareStreamDataPayload(
  input: StreamDataFramePayload,
  sourceArtifacts: ArtifactStore,
  targetArtifacts: ArtifactStore = sourceArtifacts,
): Promise<PreparedStreamDataPayload> {
  const payload = snapshot(input, "Stream data payload");
  assertPlainObject(payload, "Stream frame payload");

  let prepared: StreamDataFramePayload;
  switch (payload.kind) {
    case "agent-yield":
      assertExactKeys(payload, ["kind", "yield"], "Agent yield stream payload");
      prepared = {
        kind: "agent-yield",
        yield: await prepareStreamItem(
          payload.yield,
          validateAgentYield,
          "Agent yield",
          sourceArtifacts,
          targetArtifacts,
        ),
      };
      break;
    case "agent-event":
      assertExactKeys(payload, ["event", "kind"], "Agent event stream payload");
      prepared = {
        kind: "agent-event",
        event: await prepareStreamItem(
          payload.event,
          validateSessionEventProjection,
          "Agent event",
          sourceArtifacts,
          targetArtifacts,
        ),
      };
      break;
    case "interaction":
      validateStreamDataPayload(payload);
      if (payload.event.t === "requested" && "ref" in payload.event.display) {
        await materializeInteractionDisplay(payload.event.display, sourceArtifacts);
      }
      prepared = payload;
      break;
    default:
      throw new TypeError("Stream data payload kind is invalid");
  }

  const references = collectArtifactRefs(prepared);
  for (const ref of references) {
    if (await targetArtifacts.has(ref)) continue;
    const bytes = await sourceArtifacts.get(ref);
    const copied = await targetArtifacts.put(bytes);
    if (copied.digest !== ref.digest || copied.bytes !== ref.bytes) {
      throw new TypeError("Stream artifact copy changed its content identity");
    }
  }
  validateStreamDataPayload(prepared);
  return { payload: prepared, references };
}

/**
 * Reads every externally represented value and revalidates its canonical
 * bytes and semantic type. The frozen payload itself is not rewritten.
 */
export async function materializeStreamDataPayload(
  input: StreamDataFramePayload,
  artifacts: ArtifactStore,
): Promise<StreamDataFramePayload> {
  const payload = validateStreamDataPayload(input);
  if (payload.kind === "agent-yield" && "ref" in payload.yield) {
    await materializeStreamItem(
      payload.yield.ref,
      validateAgentYield,
      "Agent yield",
      artifacts,
    );
  } else if (payload.kind === "agent-event" && "ref" in payload.event) {
    await materializeStreamItem(
      payload.event.ref,
      validateSessionEventProjection,
      "Agent event",
      artifacts,
    );
  } else if (
    payload.kind === "interaction" &&
    payload.event.t === "requested" &&
    "ref" in payload.event.display
  ) {
    await materializeInteractionDisplay(payload.event.display, artifacts);
  }
  return payload;
}

export interface StreamDigestCheckpoint {
  readonly dataFrames: number;
  readonly head: Digest;
}

export interface StreamVerifierCheckpoint extends StreamDigestCheckpoint {
  readonly assignmentId: string;
  readonly finalSeq?: number;
  readonly lastLogicalDigest?: Digest;
  readonly lastSeq: number;
  readonly ref: ExecutionRef;
  readonly streamEpoch: number;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function streamDigestSeed(assignmentId: string): Digest {
  assertProtocolIdentifier(assignmentId, "Stream assignmentId");
  return byteDigest(
    Buffer.concat([
      Buffer.from("zhixing:stream:v1", "utf8"),
      Buffer.from(assignmentId, "utf8"),
    ]),
  );
}

export function advanceStreamDigest(
  previous: Digest,
  seq: number,
  payload: StreamDataFramePayload,
  meta: StreamFrameMeta,
): Digest {
  assertDigest(previous, "Previous stream digest");
  assertPositiveInteger(seq, "Stream data sequence");
  validateStreamDataPayloadSemantics(payload, false);
  validateStreamFrameMeta(meta);
  return byteDigest(
    Buffer.concat([
      Buffer.from(previous.slice("sha256:".length), "hex"),
      Buffer.from(canonicalize({ seq, payload, meta }), "utf8"),
    ]),
  );
}

/** Canonical stream-chain implementation shared by producers and replay validators. */
export class StreamDigestChain {
  readonly #assignmentId: string;
  #head: Digest;
  #dataFrames = 0;

  constructor(
    assignmentId: string,
    checkpoint?: StreamDigestCheckpoint,
  ) {
    this.#assignmentId = assignmentId;
    if (checkpoint === undefined) {
      this.#head = streamDigestSeed(assignmentId);
      return;
    }
    assertNonNegativeInteger(
      checkpoint.dataFrames,
      "Stream checkpoint data frame count",
    );
    assertDigest(checkpoint.head, "Stream checkpoint digest");
    this.#dataFrames = checkpoint.dataFrames;
    this.#head = checkpoint.head;
  }

  append(payload: StreamDataFramePayload, meta: StreamFrameMeta = {}): number {
    const seq = this.#dataFrames + 1;
    this.#head = advanceStreamDigest(this.#head, seq, payload, meta);
    this.#dataFrames = seq;
    return seq;
  }

  final(): { readonly finalSeq: number; readonly streamDigest: Digest } {
    return {
      finalSeq: this.#dataFrames + 1,
      streamDigest: this.#head,
    };
  }

  get assignmentId(): string {
    return this.#assignmentId;
  }

  checkpoint(): StreamDigestCheckpoint {
    return {
      dataFrames: this.#dataFrames,
      head: this.#head,
    };
  }
}

/**
 * Stateful receiver guard for contiguous replay, epoch fencing and final-frame
 * reconciliation. Its checkpoint is durable consumer state, not connection state.
 */
export class StreamFrameVerifier {
  readonly #assignmentId: string;
  readonly #ref: ExecutionRef;
  readonly #chain: StreamDigestChain;
  #finalSeq: number | undefined;
  #lastLogicalDigest: Digest | undefined;
  #lastSeq: number;
  #streamEpoch: number;

  constructor(
    input: {
      readonly assignmentId: string;
      readonly ref: ExecutionRef;
    } | StreamVerifierCheckpoint,
  ) {
    assertProtocolIdentifier(input.assignmentId, "Stream assignmentId");
    validateExecutionRef(input.ref);
    this.#assignmentId = input.assignmentId;
    this.#ref = snapshot(input.ref, "Stream execution reference");
    if ("lastSeq" in input) {
      assertNonNegativeInteger(input.lastSeq, "Stream verifier sequence");
      assertNonNegativeInteger(
        input.dataFrames,
        "Stream verifier data frame count",
      );
      if (
        (input.finalSeq === undefined && input.lastSeq !== input.dataFrames) ||
        (input.finalSeq !== undefined &&
          (input.finalSeq !== input.lastSeq ||
            input.finalSeq !== input.dataFrames + 1))
      ) {
        throw new TypeError("Stream verifier final sequence is inconsistent");
      }
      if (
        input.lastSeq > 0 &&
        input.lastLogicalDigest === undefined
      ) {
        throw new TypeError("Stream verifier checkpoint is missing its last frame digest");
      }
      if (input.lastLogicalDigest !== undefined) {
        assertDigest(
          input.lastLogicalDigest,
          "Stream verifier last frame digest",
        );
      }
      assertNonNegativeInteger(input.streamEpoch, "Stream verifier epoch");
      if (input.lastSeq > 0 && input.streamEpoch === 0) {
        throw new TypeError("Non-empty stream verifier checkpoint requires an epoch");
      }
      this.#chain = new StreamDigestChain(input.assignmentId, input);
      this.#lastSeq = input.lastSeq;
      this.#streamEpoch = input.streamEpoch;
      this.#finalSeq = input.finalSeq;
      this.#lastLogicalDigest = input.lastLogicalDigest;
    } else {
      this.#chain = new StreamDigestChain(input.assignmentId);
      this.#lastSeq = 0;
      this.#streamEpoch = 0;
    }
  }

  accept(frameInput: unknown): "accepted" | "duplicate" {
    const frame = validateStreamFrame(frameInput);
    if (
      frame.assignmentId !== this.#assignmentId ||
      canonicalize(frame.ref) !== canonicalize(this.#ref)
    ) {
      throw new TypeError("Stream frame belongs to a different execution");
    }
    if (frame.streamEpoch < this.#streamEpoch) {
      throw new TypeError("Stream frame belongs to a fenced connection epoch");
    }

    const logicalDigest = streamLogicalFrameDigest(frame);
    if (
      frame.seq === this.#lastSeq &&
      logicalDigest === this.#lastLogicalDigest
    ) {
      this.#streamEpoch = frame.streamEpoch;
      return "duplicate";
    }
    if (this.#finalSeq !== undefined) {
      throw new TypeError("Stream frame follows the provisional final");
    }
    if (frame.seq !== this.#lastSeq + 1) {
      throw new TypeError("Stream frame sequence is not contiguous");
    }

    if (frame.payload.kind === "provisional-final") {
      const expected = this.#chain.final();
      if (
        frame.seq !== expected.finalSeq ||
        frame.payload.finalSeq !== frame.seq ||
        frame.payload.streamDigest !== expected.streamDigest
      ) {
        throw new TypeError("Provisional final does not match the stream chain");
      }
      this.#finalSeq = frame.seq;
    } else {
      const appended = this.#chain.append(frame.payload, frame.meta);
      if (appended !== frame.seq) {
        throw new TypeError("Stream data sequence does not match its digest chain");
      }
    }
    this.#lastSeq = frame.seq;
    this.#streamEpoch = frame.streamEpoch;
    this.#lastLogicalDigest = logicalDigest;
    return "accepted";
  }

  checkpoint(): StreamVerifierCheckpoint {
    return {
      assignmentId: this.#assignmentId,
      ref: snapshot(this.#ref, "Stream execution reference"),
      streamEpoch: this.#streamEpoch,
      lastSeq: this.#lastSeq,
      ...this.#chain.checkpoint(),
      ...(this.#lastLogicalDigest === undefined
        ? {}
        : { lastLogicalDigest: this.#lastLogicalDigest }),
      ...(this.#finalSeq === undefined ? {} : { finalSeq: this.#finalSeq }),
    };
  }
}

export function validateStreamFrame(input: unknown): StreamFrame {
  const frame = snapshot(input, "Stream frame") as StreamFrame;
  assertPlainObject(frame, "Stream frame");
  assertExactKeys(
    frame,
    ["assignmentId", "meta", "payload", "ref", "seq", "streamEpoch", "v"],
    "Stream frame",
  );
  assertVersion(frame.v, "Stream frame");
  validateExecutionRef(frame.ref);
  assertProtocolIdentifier(frame.assignmentId, "Stream assignmentId");
  assertPositiveInteger(frame.streamEpoch, "Stream epoch");
  assertPositiveInteger(frame.seq, "Stream sequence");
  validateStreamFrameMeta(frame.meta);
  if (frame.payload.kind === "provisional-final") {
    validateProvisionalFinal(frame.payload);
  } else {
    validateStreamDataPayload(frame.payload);
  }
  return frame;
}

export function validateStreamSubscribe(input: unknown): StreamSubscribe {
  const request = snapshot(input, "Stream subscribe") as StreamSubscribe;
  assertPlainObject(request, "Stream subscribe");
  assertExactKeys(
    request,
    ["afterSeq", "assignmentId", "consumer", "ref", "v"],
    "Stream subscribe",
  );
  assertVersion(request.v, "Stream subscribe");
  validateExecutionRef(request.ref);
  assertProtocolIdentifier(request.assignmentId, "Stream assignmentId");
  validateStreamConsumerAuth(request.consumer);
  assertNonNegativeInteger(request.afterSeq, "Stream subscription sequence");
  return request;
}

export function validateStreamAck(input: unknown): StreamAck {
  const ack = snapshot(input, "Stream acknowledgment") as StreamAck;
  assertPlainObject(ack, "Stream acknowledgment");
  assertExactKeys(
    ack,
    ["ackSeq", "assignmentId", "consumer", "v"],
    "Stream acknowledgment",
  );
  assertVersion(ack.v, "Stream acknowledgment");
  assertProtocolIdentifier(ack.assignmentId, "Stream assignmentId");
  validateStreamConsumerAuth(ack.consumer);
  assertNonNegativeInteger(ack.ackSeq, "Stream acknowledgment sequence");
  return ack;
}

export function validateStreamConsumerAuth(
  input: unknown,
): StreamConsumerAuth {
  assertPlainObject(input, "Stream consumer authorization");
  if (input.kind === "surface-ticket") {
    assertExactKeys(
      input,
      ["kind", "ticketId"],
      "Surface stream consumer authorization",
    );
    assertProtocolIdentifier(input.ticketId, "Stream ticketId");
    return input as StreamConsumerAuth;
  }
  if (input.kind === "owner-relay") {
    assertExactKeys(
      input,
      ["authority", "controlLeaseId", "kind"],
      "Owner relay stream consumer authorization",
    );
    assertProtocolIdentifier(input.controlLeaseId, "Stream controlLeaseId");
    validateJobAuthorityRef(input.authority);
    return input as StreamConsumerAuth;
  }
  throw new TypeError("Stream consumer authorization kind is invalid");
}

/** Stable identity of a logical consumer; rotating relay leases do not reset ACK state. */
export function streamConsumerKey(consumer: StreamConsumerAuth): string {
  validateStreamConsumerAuth(consumer);
  return consumer.kind === "surface-ticket"
    ? `surface:${consumer.ticketId}`
    : `owner-relay:${consumer.authority.taskId}:${consumer.authority.anchorEpoch}`;
}

export function streamLogicalFrameDigest(frame: StreamFrame): Digest {
  const value = validateStreamFrame(frame);
  return protocolDigest(
    "StreamLogicalFrame",
    1,
    {
      assignmentId: value.assignmentId,
      meta: value.meta,
      payload: value.payload,
      ref: value.ref,
      seq: value.seq,
      v: value.v,
    },
  );
}

export function assertStreamFinalReconciliation(
  frameInput: unknown,
  streamFinal: unknown,
): void {
  const frame = validateStreamFrame(frameInput);
  if (frame.payload.kind !== "provisional-final") {
    throw new TypeError("Stream reconciliation requires a provisional final frame");
  }
  assertPlainObject(streamFinal, "Sealed stream final");
  assertExactKeys(
    streamFinal,
    ["finalSeq", "streamDigest"],
    "Sealed stream final",
  );
  assertPositiveInteger(streamFinal.finalSeq, "Sealed stream final sequence");
  assertDigest(streamFinal.streamDigest, "Sealed stream digest");
  if (
    frame.seq !== frame.payload.finalSeq ||
    frame.payload.finalSeq !== streamFinal.finalSeq ||
    frame.payload.streamDigest !== streamFinal.streamDigest
  ) {
    throw new TypeError(
      "Provisional final and sealed stream final do not reconcile",
    );
  }
}

export function validateStreamDataPayload(
  input: unknown,
): StreamDataFramePayload {
  return validateStreamDataPayloadSemantics(input, true);
}

function validateStreamDataPayloadSemantics(
  input: unknown,
  enforceInlineBudget: boolean,
): StreamDataFramePayload {
  const payload = snapshot(input, "Stream data payload") as StreamDataFramePayload;
  assertPlainObject(payload, "Stream frame payload");
  switch (payload.kind) {
    case "agent-yield":
      assertExactKeys(payload, ["kind", "yield"], "Agent yield stream payload");
      if (isArtifactBackedStreamValue(payload.yield)) {
        validateArtifactBackedStreamValue(payload.yield);
      } else {
        validateAgentYield(payload.yield);
        if (enforceInlineBudget) {
          assertInlineStreamItemBudget(payload.yield, "Agent yield");
        }
      }
      return payload;
    case "agent-event":
      assertExactKeys(payload, ["event", "kind"], "Agent event stream payload");
      if (isArtifactBackedStreamValue(payload.event)) {
        validateArtifactBackedStreamValue(payload.event);
      } else {
        validateSessionEventProjection(payload.event);
        if (enforceInlineBudget) {
          assertInlineStreamItemBudget(payload.event, "Agent event");
        }
      }
      return payload;
    case "interaction":
      assertExactKeys(payload, ["event", "kind"], "Interaction stream payload");
      validateInteractionEvent(payload.event);
      return payload;
    default:
      throw new TypeError("Stream data payload kind is invalid");
  }
}

async function prepareStreamItem<T extends AgentYield | SessionEventProjection>(
  input: T | { readonly ref: ArtifactRef },
  validate: (value: T) => void,
  label: string,
  sourceArtifacts: ArtifactStore,
  targetArtifacts: ArtifactStore,
): Promise<T | { readonly ref: ArtifactRef }> {
  if (isArtifactBackedStreamValue(input)) {
    validateArtifactBackedStreamValue(input);
    const materialized = await materializeStreamItem(
      input.ref as ArtifactRef,
      validate,
      label,
      sourceArtifacts,
    );
    const copied = await targetArtifacts.put(materialized.bytes);
    if (
      copied.digest !== input.ref.digest ||
      copied.bytes !== input.ref.bytes
    ) {
      throw new TypeError(`${label} artifact copy changed its content identity`);
    }
    return { ref: copied };
  }

  validate(input as T);
  const bytes = Buffer.from(canonicalize(input), "utf8");
  if (bytes.byteLength <= MAX_INLINE_STREAM_ITEM_BYTES) {
    return snapshot(input as T, label);
  }
  return { ref: await targetArtifacts.put(bytes) };
}

async function materializeStreamItem<T>(
  ref: ArtifactRef,
  validate: (value: T) => void,
  label: string,
  artifacts: ArtifactStore,
): Promise<{ readonly value: T; readonly bytes: Uint8Array }> {
  const bytes = await artifacts.get(ref);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} artifact is not valid UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`${label} artifact is not valid JSON`);
  }
  validate(parsed as T);
  if (canonicalize(parsed) !== text) {
    throw new TypeError(`${label} artifact is not canonical JSON`);
  }
  if (Buffer.byteLength(text, "utf8") <= MAX_INLINE_STREAM_ITEM_BYTES) {
    throw new TypeError(`${label} artifact must exceed the inline budget`);
  }
  return { value: parsed as T, bytes };
}

function assertInlineStreamItemBudget(value: unknown, label: string): void {
  if (
    Buffer.byteLength(canonicalize(value), "utf8") >
    MAX_INLINE_STREAM_ITEM_BYTES
  ) {
    throw new TypeError(`${label} must be externalized above its inline budget`);
  }
}

function isArtifactBackedStreamValue(
  value: AgentYield | SessionEventProjection | { readonly ref: unknown },
): value is { readonly ref: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "ref")
  );
}

function validateArtifactBackedStreamValue(
  value: { readonly ref: unknown },
): void {
  assertPlainObject(value, "Artifact-backed stream value");
  assertExactKeys(value, ["ref"], "Artifact-backed stream value");
  validateStreamArtifactRef(value.ref);
}

function validateStreamArtifactRef(value: unknown): void {
  assertPlainObject(value, "Stream artifact reference");
  assertExactKeys(value, ["bytes", "digest"], "Stream artifact reference");
  assertDigest(value.digest, "Stream artifact digest");
  assertNonNegativeInteger(value.bytes, "Stream artifact byte count");
}

function validateProvisionalFinal(
  payload: Extract<
    StreamFrame["payload"],
    { readonly kind: "provisional-final" }
  >,
): void {
  assertPlainObject(payload, "Provisional final stream payload");
  assertExactKeys(
    payload,
    ["finalSeq", "kind", "streamDigest"],
    "Provisional final stream payload",
  );
  assertPositiveInteger(payload.finalSeq, "Provisional final sequence");
  assertDigest(payload.streamDigest, "Provisional final stream digest");
}

function validateAgentYield(value: AgentYield): void {
  assertPlainObject(value, "Agent yield");
  switch (value.type) {
    case "text_delta":
      assertExactKeys(value, ["text", "type"], "Text delta yield");
      assertString(value.text, "Text delta");
      return;
    case "thinking_block_start":
    case "thinking_block_end":
      assertExactKeys(value, ["type"], "Thinking boundary yield");
      return;
    case "thinking_delta":
      assertExactKeys(value, ["thinking", "type"], "Thinking delta yield");
      assertString(value.thinking, "Thinking delta");
      return;
    case "assistant_message":
      assertExactKeys(value, ["message", "type"], "Assistant message yield");
      validateMessage(value.message, "Assistant message yield");
      return;
    case "tool_start":
      assertExactKeys(value, ["id", "input", "name", "type"], "Tool start yield");
      assertProtocolIdentifier(value.id, "Tool invocation id");
      assertProtocolIdentifier(value.name, "Tool name");
      assertPlainObject(value.input, "Tool input");
      canonicalize(value.input);
      return;
    case "tool_end":
      assertExactKeys(
        value,
        ["duration", "id", "name", "result", "type"],
        "Tool end yield",
      );
      assertProtocolIdentifier(value.id, "Tool invocation id");
      assertProtocolIdentifier(value.name, "Tool name");
      assertNonNegativeFinite(value.duration, "Tool duration");
      assertPlainObject(value.result, "Tool result");
      canonicalize(value.result);
      return;
    case "turn_complete":
      assertExactKeys(value, ["turnCount", "type", "usage"], "Turn complete yield");
      assertPositiveInteger(value.turnCount, "Turn count");
      validateTokenUsage(value.usage);
      return;
    default:
      throw new TypeError("Agent yield type is invalid");
  }
}

function validateSessionEventProjection(value: SessionEventProjection): void {
  assertPlainObject(value, "Session event projection");
  assertExactKeys(value, ["event", "payload"], "Session event projection");
  assertPlainObject(value.payload, "Session event projection payload");
  if (isProjectedPassthroughEvent(value.event)) {
    validateProjectedPassthroughPayload(value.event, value.payload);
    return;
  }
  if (value.event === "llm:request_start") {
    assertExactKeys(
      value.payload,
      ["hasTools", "messageCount", "model"],
      "LLM request projection",
    );
    assertProtocolIdentifier(value.payload.model, "LLM request model");
    assertNonNegativeInteger(value.payload.messageCount, "LLM request message count");
    if (typeof value.payload.hasTools !== "boolean") {
      throw new TypeError("LLM request hasTools must be boolean");
    }
    return;
  }
  if (value.event === "segment:new_started") {
    assertExactKeys(
      value.payload,
      ["bufferTurns", "segmentId", "tokensAfter", "tokensBefore"],
      "Segment projection",
    );
    assertProtocolIdentifier(value.payload.segmentId, "Segment id");
    assertNonNegativeInteger(value.payload.bufferTurns, "Segment buffer turns");
    assertNonNegativeInteger(value.payload.tokensBefore, "Segment tokens before");
    assertNonNegativeInteger(value.payload.tokensAfter, "Segment tokens after");
    return;
  }
  throw new TypeError("Session event projection is not wire-visible");
}

function validateProjectedPassthroughPayload(
  event: string,
  payload: Record<string, unknown>,
): void {
  switch (event) {
    case "agent:run_start":
      assertExactKeys(payload, ["prompt"], event);
      assertString(payload.prompt, "Agent prompt");
      return;
    case "agent:run_end":
      assertExactKeys(
        payload,
        [
          "duration",
          ...(payload.error === undefined ? [] : ["error"]),
          ...(payload.errorType === undefined ? [] : ["errorType"]),
          "reason",
          "usage",
        ],
        event,
      );
      assertOneOf(
        payload.reason,
        ["completed", "max_turns", "aborted", "error"],
        "Agent run end reason",
      );
      assertNonNegativeFinite(payload.duration, "Agent run duration");
      validateTokenUsage(payload.usage as TokenUsage);
      if (payload.error !== undefined) assertString(payload.error, "Agent error");
      if (payload.errorType !== undefined) {
        validateAgentErrorType(payload.errorType);
      }
      return;
    case "context:tokens_snapshot":
      assertExactKeys(payload, ["totalTokens", "turnCount"], event);
      assertNonNegativeInteger(payload.totalTokens, "Context token total");
      assertNonNegativeInteger(payload.turnCount, "Context turn count");
      return;
    case "retry:attempt":
      assertExactKeys(
        payload,
        ["attempt", "delayMs", "errorType", "maxRetries", "willRetry"],
        event,
      );
      validateAgentErrorType(payload.errorType);
      assertPositiveInteger(payload.attempt, "Retry attempt");
      assertNonNegativeInteger(payload.maxRetries, "Retry maximum");
      assertNonNegativeFinite(payload.delayMs, "Retry delay");
      assertBoolean(payload.willRetry, "Retry decision");
      return;
    case "retry:success":
      assertExactKeys(
        payload,
        ["attemptsTaken", "errorType", "totalDelayMs"],
        event,
      );
      validateAgentErrorType(payload.errorType);
      assertPositiveInteger(payload.attemptsTaken, "Retry attempts taken");
      assertNonNegativeFinite(payload.totalDelayMs, "Retry total delay");
      return;
    case "retry:exhausted":
      assertExactKeys(
        payload,
        ["errorType", "lastError", "totalAttempts"],
        event,
      );
      validateAgentErrorType(payload.errorType);
      assertPositiveInteger(payload.totalAttempts, "Retry total attempts");
      assertString(payload.lastError, "Retry last error");
      return;
    case "segment:transition_start":
      assertExactKeys(
        payload,
        [
          ...(payload.conversationId === undefined
            ? []
            : ["conversationId"]),
          "currentTokens",
          "reason",
          "segmentId",
        ],
        event,
      );
      if (payload.conversationId !== undefined) {
        assertProtocolIdentifier(payload.conversationId, "Conversation id");
      }
      assertProtocolIdentifier(payload.segmentId, "Segment id");
      assertOneOf(
        payload.reason,
        ["optimal-exceeded", "risk-exceeded"],
        "Segment transition reason",
      );
      assertNonNegativeInteger(payload.currentTokens, "Segment current tokens");
      return;
    case "segment:emergency_floor":
      assertExactKeys(
        payload,
        [
          "droppedTurns",
          "error",
          "segmentId",
          "tokensAfter",
          "tokensBefore",
        ],
        event,
      );
      assertProtocolIdentifier(payload.segmentId, "Segment id");
      assertString(payload.error, "Segment error");
      assertNonNegativeInteger(payload.droppedTurns, "Dropped turns");
      assertNonNegativeInteger(payload.tokensBefore, "Tokens before");
      assertNonNegativeInteger(payload.tokensAfter, "Tokens after");
      return;
    case "segment:transition_failed":
      assertExactKeys(
        payload,
        ["error", "retriesExhausted", "segmentId"],
        event,
      );
      assertProtocolIdentifier(payload.segmentId, "Segment id");
      assertString(payload.error, "Segment error");
      assertBoolean(payload.retriesExhausted, "Segment retries exhausted");
      return;
    case "interrupt:warn":
      assertExactKeys(
        payload,
        ["chunksReceived", "elapsedMs", "kind", "timeoutMs"],
        event,
      );
      if (payload.kind !== "idle-timeout-warn") {
        throw new TypeError("Interrupt warning kind is invalid");
      }
      assertNonNegativeInteger(payload.chunksReceived, "Received chunks");
      assertNonNegativeFinite(payload.elapsedMs, "Interrupt elapsed time");
      assertNonNegativeFinite(payload.timeoutMs, "Interrupt timeout");
      return;
    case "interrupt:fired":
      assertExactKeys(
        payload,
        [
          ...(payload.exitDelayMs === undefined ? [] : ["exitDelayMs"]),
          "interruptedTurnIndex",
          "reason",
          "toolGraceMs",
        ],
        event,
      );
      assertNonNegativeInteger(
        payload.interruptedTurnIndex,
        "Interrupted turn index",
      );
      assertNonNegativeFinite(payload.toolGraceMs, "Tool grace duration");
      if (payload.exitDelayMs !== undefined) {
        assertNonNegativeFinite(payload.exitDelayMs, "Interrupt exit delay");
      }
      validateAbortReason(payload.reason, 0);
      return;
    case "security:steward_review":
      assertExactKeys(
        payload,
        ["confidence", "decision", "operation", "reason", "tool"],
        event,
      );
      assertProtocolIdentifier(payload.tool, "Security tool");
      assertString(payload.operation, "Security operation");
      assertOneOf(
        payload.decision,
        ["safe", "needs-confirm", "escalate"],
        "Security steward decision",
      );
      assertString(payload.reason, "Security steward reason");
      assertUnitInterval(payload.confidence, "Security steward confidence");
      return;
    case "security:rule_sedimented":
      validateRuleSedimentedPayload(payload);
      return;
    case "lifecycle:hook_failed":
      assertExactKeys(payload, ["error", "hookId", "phase"], event);
      assertProtocolIdentifier(payload.hookId, "Lifecycle hook id");
      validateLifecyclePhase(payload.phase);
      assertString(payload.error, "Lifecycle hook error");
      return;
    case "lifecycle:warning":
      assertExactKeys(
        payload,
        ["hookId", "message", "phase", "runtimeId", "windowIndex"],
        event,
      );
      assertProtocolIdentifier(payload.hookId, "Lifecycle hook id");
      validateLifecyclePhase(payload.phase);
      assertString(payload.message, "Lifecycle warning");
      assertNonNegativeInteger(payload.windowIndex, "Lifecycle window index");
      assertProtocolIdentifier(payload.runtimeId, "Lifecycle runtime id");
      return;
    case "lifecycle:prompt_rebuilt":
      assertExactKeys(payload, ["reason"], event);
      assertOneOf(
        payload.reason,
        ["segment-transition", "compact"],
        "Prompt rebuild reason",
      );
      return;
    case "orchestration:validation_failed":
      assertExactKeys(
        payload,
        [
          ...(payload.definitionId === undefined ? [] : ["definitionId"]),
          "issues",
          "runId",
        ],
        event,
      );
      assertProtocolIdentifier(payload.runId, "Orchestration run id");
      if (payload.definitionId !== undefined) {
        assertProtocolIdentifier(
          payload.definitionId,
          "Orchestration definition id",
        );
      }
      assertDenseArray(payload.issues, "Orchestration validation issues");
      for (const issue of payload.issues) {
        assertPlainObject(issue, "Orchestration validation issue");
        assertExactKeys(issue, ["code", "message", "path"], "Validation issue");
        assertString(issue.path, "Validation issue path");
        assertProtocolIdentifier(issue.code, "Validation issue code");
        assertString(issue.message, "Validation issue message");
      }
      return;
    case "orchestration:run_start":
      assertExactKeys(
        payload,
        ["definitionId", "maxParallel", "nodeCount", "runId"],
        event,
      );
      validateOrchestrationIdentity(payload);
      assertNonNegativeInteger(payload.nodeCount, "Orchestration node count");
      assertPositiveInteger(payload.maxParallel, "Orchestration parallel limit");
      return;
    case "orchestration:node_start":
      assertExactKeys(
        payload,
        ["definitionId", "nodeId", "nodeKind", "runId"],
        event,
      );
      validateOrchestrationIdentity(payload);
      assertProtocolIdentifier(payload.nodeId, "Orchestration node id");
      if (payload.nodeKind !== "agent") {
        throw new TypeError("Orchestration node kind is invalid");
      }
      return;
    case "orchestration:node_end":
      validateOrchestrationEnd(payload, true);
      return;
    case "orchestration:run_end":
      validateOrchestrationEnd(payload, false);
      return;
    default:
      throw new TypeError("Projected passthrough event validator is missing");
  }
}

function validateRuleSedimentedPayload(payload: Record<string, unknown>): void {
  assertExactKeys(
    payload,
    [
      "contextId",
      "contributors",
      "operation",
      "pattern",
      "ruleId",
      "scope",
      "tool",
    ],
    "security:rule_sedimented",
  );
  assertProtocolIdentifier(payload.tool, "Security tool");
  assertString(payload.operation, "Security operation");
  assertPlainObject(payload.pattern, "Security rule pattern");
  assertExactKeys(
    payload.pattern,
    ["argument", "tool"],
    "Security rule pattern",
  );
  assertProtocolIdentifier(payload.pattern.tool, "Security pattern tool");
  assertString(payload.pattern.argument, "Security pattern argument");
  assertOneOf(
    payload.scope,
    ["session", "context", "global", "builtin"],
    "Security permission scope",
  );
  validatePermissionContext(payload.contextId);
  assertProtocolIdentifier(payload.ruleId, "Security rule id");
  assertDenseArray(payload.contributors, "Security rule contributors");
  for (const contribution of payload.contributors) {
    assertPlainObject(contribution, "Security rule contribution");
    assertExactKeys(
      contribution,
      ["origin", "timestamp"],
      "Security rule contribution",
    );
    assertOneOf(
      contribution.origin,
      ["user", "steward"],
      "Security contribution origin",
    );
    assertNonNegativeFinite(
      contribution.timestamp,
      "Security contribution timestamp",
    );
  }
}

function validatePermissionContext(value: unknown): void {
  assertPlainObject(value, "Permission context");
  if (value.kind === "main") {
    assertExactKeys(value, ["kind"], "Main permission context");
    return;
  }
  if (value.kind === "workspace") {
    assertExactKeys(value, ["hash", "kind"], "Workspace permission context");
    assertProtocolIdentifier(value.hash, "Workspace context hash");
    return;
  }
  if (value.kind === "scene") {
    assertExactKeys(value, ["kind", "sceneId"], "Scene permission context");
    assertProtocolIdentifier(value.sceneId, "Scene context id");
    return;
  }
  throw new TypeError("Permission context kind is invalid");
}

function validateAbortReason(value: unknown, depth: number): void {
  if (value === null) return;
  if (depth > 8) throw new TypeError("Abort reason nesting exceeds its limit");
  assertPlainObject(value, "Abort reason");
  if (value.kind === "user-cancel") {
    assertExactKeys(value, ["kind", "pressedAt", "source"], "User abort reason");
    assertOneOf(
      value.source,
      ["esc", "ctrl-c", "sigint", "rpc"],
      "User abort source",
    );
    assertNonNegativeFinite(value.pressedAt, "Abort press time");
    return;
  }
  if (value.kind === "idle-timeout") {
    assertExactKeys(
      value,
      ["chunksReceived", "elapsedSinceLastChunkMs", "kind", "timeoutMs"],
      "Idle timeout reason",
    );
    assertNonNegativeInteger(value.chunksReceived, "Received chunks");
    assertNonNegativeFinite(
      value.elapsedSinceLastChunkMs,
      "Elapsed since last chunk",
    );
    assertNonNegativeFinite(value.timeoutMs, "Idle timeout");
    return;
  }
  if (value.kind === "parent-abort") {
    assertExactKeys(value, ["kind", "parentReason"], "Parent abort reason");
    validateAbortReason(value.parentReason, depth + 1);
    return;
  }
  if (value.kind === "external") {
    assertExactKeys(
      value,
      value.origin === undefined ? ["kind"] : ["kind", "origin"],
      "External abort reason",
    );
    if (value.origin !== undefined) {
      assertString(value.origin, "External abort origin");
    }
    return;
  }
  throw new TypeError("Abort reason kind is invalid");
}

function validateOrchestrationIdentity(
  payload: Record<string, unknown>,
): void {
  assertProtocolIdentifier(payload.runId, "Orchestration run id");
  assertProtocolIdentifier(
    payload.definitionId,
    "Orchestration definition id",
  );
}

function validateOrchestrationEnd(
  payload: Record<string, unknown>,
  node: boolean,
): void {
  assertExactKeys(
    payload,
    [
      "definitionId",
      "durationMs",
      ...(payload.error === undefined ? [] : ["error"]),
      ...(payload.errorType === undefined ? [] : ["errorType"]),
      ...(node ? ["nodeId"] : []),
      "runId",
      "status",
      ...(payload.usage === undefined ? [] : ["usage"]),
    ],
    node ? "orchestration:node_end" : "orchestration:run_end",
  );
  validateOrchestrationIdentity(payload);
  if (node) assertProtocolIdentifier(payload.nodeId, "Orchestration node id");
  assertOneOf(
    payload.status,
    node
      ? ["completed", "failed", "aborted", "skipped"]
      : ["completed", "failed", "aborted"],
    "Orchestration status",
  );
  assertNonNegativeFinite(payload.durationMs, "Orchestration duration");
  if (payload.usage !== undefined) validateTokenUsage(payload.usage as TokenUsage);
  if (payload.error !== undefined) {
    assertString(payload.error, "Orchestration error");
  }
  if (payload.errorType !== undefined) {
    assertString(payload.errorType, "Orchestration error type");
  }
}

function validateAgentErrorType(value: unknown): void {
  assertOneOf(
    value,
    [
      "rate_limit",
      "timeout",
      "network",
      "context_overflow",
      "auth",
      "invalid_request",
      "provider_error",
      "tool_error",
      "aborted",
      "unknown",
    ],
    "Agent error type",
  );
}

function validateLifecyclePhase(value: unknown): void {
  assertOneOf(
    value,
    ["onWindowOpen", "onBeforeRun", "onAfterRun", "onWindowClose"],
    "Lifecycle phase",
  );
}

function validateInteractionEvent(
  value: Extract<
    StreamDataFramePayload,
    { readonly kind: "interaction" }
  >["event"],
): void {
  assertPlainObject(value, "Interaction stream event");
  if (value.t === "requested") {
    assertExactKeys(
      value,
      [
        "display",
        "expiresAt",
        "issuedAt",
        "requestId",
        "t",
        "toolName",
        "ttlMs",
      ],
      "Interaction request stream event",
    );
    assertProtocolIdentifier(value.requestId, "Interaction requestId");
    assertProtocolIdentifier(value.toolName, "Interaction tool name");
    validateInteractionDisplay(value.display);
    assertCanonicalTime(value.issuedAt, "Interaction issuedAt");
    assertCanonicalTime(value.expiresAt, "Interaction expiresAt");
    assertPositiveInteger(value.ttlMs, "Interaction TTL");
    if (Date.parse(value.expiresAt) - Date.parse(value.issuedAt) !== value.ttlMs) {
      throw new TypeError("Interaction expiry does not match its TTL");
    }
    return;
  }
  if (value.t === "finished") {
    assertExactKeys(
      value,
      ["outcome", "requestId", "t"],
      "Interaction completion stream event",
    );
    assertProtocolIdentifier(value.requestId, "Interaction requestId");
    if (
      value.outcome !== "allowed" &&
      value.outcome !== "denied" &&
      value.outcome !== "cancelled" &&
      value.outcome !== "expired"
    ) {
      throw new TypeError("Interaction outcome is invalid");
    }
    return;
  }
  throw new TypeError("Interaction stream event kind is invalid");
}

function validateStreamFrameMeta(value: StreamFrameMeta): void {
  assertPlainObject(value, "Stream frame metadata");
  assertExactKeys(
    value,
    [
      ...(value.lineage === undefined ? [] : ["lineage"]),
      ...(value.turnOrigin === undefined ? [] : ["turnOrigin"]),
    ],
    "Stream frame metadata",
  );
  if (value.lineage !== undefined) {
    assertProtocolIdentifier(value.lineage, "Stream lineage");
  }
  if (value.turnOrigin !== undefined) validateTurnOrigin(value.turnOrigin);
}

function validateExecutionRef(value: ExecutionRef): void {
  assertPlainObject(value, "Stream execution reference");
  if (value.execution === "conversation") {
    assertExactKeys(
      value,
      ["conversationId", "execution", "ownerEpoch", "runId"],
      "Conversation execution reference",
    );
    assertProtocolIdentifier(value.runId, "Stream runId");
    assertProtocolIdentifier(value.conversationId, "Stream conversationId");
    assertNonNegativeInteger(value.ownerEpoch, "Stream owner epoch");
    return;
  }
  if (value.execution === "job") {
    assertExactKeys(
      value,
      ["anchorEpoch", "execution", "jobRunId", "taskId"],
      "Job execution reference",
    );
    assertProtocolIdentifier(value.jobRunId, "Stream jobRunId");
    assertProtocolIdentifier(value.taskId, "Stream taskId");
    assertPositiveInteger(value.anchorEpoch, "Stream anchor epoch");
    return;
  }
  throw new TypeError("Stream execution reference kind is invalid");
}

function validateJobAuthorityRef(value: unknown): void {
  assertPlainObject(value, "Stream owner relay authority");
  assertExactKeys(
    value,
    ["anchorEpoch", "execution", "taskId"],
    "Stream owner relay authority",
  );
  if (value.execution !== "job") {
    throw new TypeError("Stream owner relay authority must be job-scoped");
  }
  assertProtocolIdentifier(value.taskId, "Stream owner relay taskId");
  assertPositiveInteger(value.anchorEpoch, "Stream owner relay anchor epoch");
}

function validateTurnOrigin(value: NonNullable<StreamFrameMeta["turnOrigin"]>): void {
  assertPlainObject(value, "Stream turn origin");
  assertExactKeys(
    value,
    [
      "channel",
      ...(value.surface === undefined ? [] : ["surface"]),
      ...(value.target === undefined ? [] : ["target"]),
      ...(value.triggeredBy === undefined ? [] : ["triggeredBy"]),
    ],
    "Stream turn origin",
  );
  assertProtocolIdentifier(value.channel, "Stream turn origin channel");
  if (value.triggeredBy !== undefined) {
    assertProtocolIdentifier(value.triggeredBy, "Stream turn origin trigger");
  }
  if (value.target !== undefined) {
    assertPlainObject(value.target, "Stream turn origin target");
    assertExactKeys(
      value.target,
      [
        "channelId",
        ...(value.target.threadId === undefined ? [] : ["threadId"]),
        "to",
      ],
      "Stream turn origin target",
    );
    assertProtocolIdentifier(value.target.channelId, "Stream target channel");
    assertProtocolIdentifier(value.target.to, "Stream target recipient");
    if (value.target.threadId !== undefined) {
      assertProtocolIdentifier(value.target.threadId, "Stream target thread");
    }
  }
  if (value.surface !== undefined) {
    assertPlainObject(value.surface, "Stream turn origin surface");
    assertExactKeys(
      value.surface,
      value.surface.capabilities === undefined ? [] : ["capabilities"],
      "Stream turn origin surface",
    );
    if (value.surface.capabilities !== undefined) {
      assertPlainObject(value.surface.capabilities, "Stream surface capabilities");
      assertExactKeys(
        value.surface.capabilities,
        value.surface.capabilities.postTurnControl === undefined
          ? []
          : ["postTurnControl"],
        "Stream surface capabilities",
      );
      if (
        value.surface.capabilities.postTurnControl !== undefined &&
        typeof value.surface.capabilities.postTurnControl !== "boolean"
      ) {
        throw new TypeError("Stream postTurnControl capability must be boolean");
      }
    }
  }
}

function validateTokenUsage(value: TokenUsage): void {
  assertPlainObject(value, "Token usage");
  assertExactKeys(
    value,
    [
      ...(value.cacheReadTokens === undefined ? [] : ["cacheReadTokens"]),
      ...(value.cacheWriteTokens === undefined ? [] : ["cacheWriteTokens"]),
      "inputTokens",
      "outputTokens",
      ...(value.totalInputTokens === undefined ? [] : ["totalInputTokens"]),
    ],
    "Token usage",
  );
  assertNonNegativeInteger(value.inputTokens, "Input tokens");
  assertNonNegativeInteger(value.outputTokens, "Output tokens");
  if (value.totalInputTokens !== undefined) {
    assertNonNegativeInteger(value.totalInputTokens, "Total input tokens");
  }
  if (value.cacheReadTokens !== undefined) {
    assertNonNegativeInteger(value.cacheReadTokens, "Cache read tokens");
  }
  if (value.cacheWriteTokens !== undefined) {
    assertNonNegativeInteger(value.cacheWriteTokens, "Cache write tokens");
  }
}

function assertVersion(value: unknown, label: string): asserts value is 1 {
  if (value !== 1) throw new TypeError(`${label} version must be 1`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function assertBoolean(
  value: unknown,
  label: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
}

function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertDenseArray(
  value: unknown,
  label: string,
): asserts value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.keys(value).length !== value.length
  ) {
    throw new TypeError(`${label} must be a dense array`);
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

function assertNonNegativeFinite(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
}

function assertUnitInterval(
  value: unknown,
  label: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new TypeError(`${label} must be between zero and one`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertCanonicalTime(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
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

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, {
      cause: error,
    });
  }
}
