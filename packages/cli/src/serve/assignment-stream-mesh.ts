import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import type {
  IsoTime,
  StreamAck,
  StreamConsumerAuth,
  StreamFrame,
  StreamSubscribe,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  streamConsumerKey,
  validateStreamAck,
  validateStreamConsumerAuth,
  validateStreamFrame,
  validateStreamSubscribe,
} from "@zhixing/core/protocol";
import {
  DEFAULT_STREAM_READ_BATCH_BYTES,
  DEFAULT_STREAM_READ_BATCH_FRAMES,
  StreamConsumerDegradedError,
  StreamHistoryUnavailableError,
  type AssignmentStreamSpool,
} from "@zhixing/executor/assignment-stream-spool";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type {
  MeshServiceRegistry,
  SecureMeshConnection,
} from "@zhixing/mesh";

export const ASSIGNMENT_STREAM_SERVICE = "assignment.stream";

export interface AssignmentStreamAuthorizationRequest {
  readonly operation: "subscribe" | "ack";
  readonly assignmentId: string;
  readonly consumer: StreamConsumerAuth;
  readonly connection: SecureMeshConnection;
  readonly signal: AbortSignal;
}

export interface AssignmentStreamServiceOptions {
  readonly spool: AssignmentStreamSpool;
  readonly authorize: (
    request: AssignmentStreamAuthorizationRequest,
  ) =>
    | { readonly expiresAt?: IsoTime }
    | Promise<{ readonly expiresAt?: IsoTime }>;
  readonly authorizePeer?: (deviceId: string) => boolean;
  readonly maxFrames?: number;
  readonly maxBytes?: number;
}

type StreamServiceRequest =
  | {
      readonly v: 1;
      readonly t: "subscribe";
      readonly request: StreamSubscribe;
    }
  | {
      readonly v: 1;
      readonly t: "ack";
      readonly ack: StreamAck;
    };

type StreamServiceResponse =
  | {
      readonly v: 1;
      readonly t: "frames";
      readonly frames: readonly StreamFrame[];
    }
  | {
      readonly v: 1;
      readonly t: "acked";
      readonly assignmentId: string;
      readonly consumer: StreamConsumerAuth;
      readonly ackSeq: number;
    }
  | {
      readonly v: 1;
      readonly t: "consumer-degraded";
      readonly assignmentId: string;
      readonly consumer: StreamConsumerAuth;
    }
  | {
      readonly v: 1;
      readonly t: "history-unavailable";
      readonly assignmentId: string;
      readonly consumer: StreamConsumerAuth;
      readonly requestedAfterSeq: number;
      readonly prunedThrough: number;
    };

export function registerAssignmentStreamService(
  registry: MeshServiceRegistry,
  options: AssignmentStreamServiceOptions,
): () => void {
  return registry.register(ASSIGNMENT_STREAM_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    ...(options.authorizePeer === undefined
      ? {}
      : {
          authorize: (connection: SecureMeshConnection) =>
            options.authorizePeer!(connection.peer.deviceId),
        }),
    handler: createAssignmentStreamServiceHandler(options),
  });
}

export function createAssignmentStreamServiceHandler(
  options: AssignmentStreamServiceOptions,
): (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  const maxFrames = options.maxFrames ?? DEFAULT_STREAM_READ_BATCH_FRAMES;
  const maxBytes = options.maxBytes ?? DEFAULT_STREAM_READ_BATCH_BYTES;
  assertPositiveInteger(maxFrames, "Stream service frame limit");
  assertPositiveInteger(maxBytes, "Stream service byte limit");
  if (
    maxFrames > DEFAULT_STREAM_READ_BATCH_FRAMES ||
    maxBytes > DEFAULT_STREAM_READ_BATCH_BYTES
  ) {
    throw new RangeError("Stream service batch exceeds its bounded maximum");
  }
  const epochs = new WeakMap<
    SecureMeshConnection,
    Map<string, Promise<number>>
  >();

  const epochFor = (
    connection: SecureMeshConnection,
    assignmentId: string,
    consumer: StreamConsumerAuth,
    ref?: StreamSubscribe["ref"],
  ): Promise<number> => {
    let connectionEpochs = epochs.get(connection);
    if (connectionEpochs === undefined) {
      connectionEpochs = new Map();
      epochs.set(connection, connectionEpochs);
    }
    const cacheKey = `${assignmentId}\u0000${streamConsumerKey(consumer)}`;
    let epoch = connectionEpochs.get(cacheKey);
    if (epoch === undefined) {
      const created = (async () => {
        const executionRef =
          ref ?? (await options.spool.snapshot(assignmentId)).ref;
        return options.spool.beginConnection(
          assignmentId,
          executionRef,
          consumer,
        );
      })();
      epoch = created.catch((error) => {
        if (connectionEpochs?.get(cacheKey) === epoch) {
          connectionEpochs.delete(cacheKey);
        }
        throw error;
      });
      connectionEpochs.set(cacheKey, epoch);
    }
    return epoch;
  };

  return async (payload, connection, signal) => {
    signal.throwIfAborted();
    const request = decodeRequest(payload);
    if (request.t === "subscribe") {
      const authorization = await options.authorize({
        operation: "subscribe",
        assignmentId: request.request.assignmentId,
        consumer: request.request.consumer,
        connection,
        signal,
      });
      signal.throwIfAborted();
      if (
        request.request.consumer.kind === "surface-ticket" &&
        authorization.expiresAt === undefined
      ) {
        throw new TypeError("Surface stream authorization must carry expiry");
      }
      const streamEpoch = await epochFor(
        connection,
        request.request.assignmentId,
        request.request.consumer,
        request.request.ref,
      );
      try {
        const frames = await options.spool.subscribe({
          request: request.request,
          streamEpoch,
          ...(authorization.expiresAt === undefined
            ? {}
            : { expiresAt: authorization.expiresAt }),
          maxFrames,
          maxBytes,
        });
        return encode({ v: 1, t: "frames", frames });
      } catch (error) {
        if (error instanceof StreamConsumerDegradedError) {
          return encode({
            v: 1,
            t: "consumer-degraded",
            assignmentId: request.request.assignmentId,
            consumer: request.request.consumer,
          });
        }
        if (error instanceof StreamHistoryUnavailableError) {
          return encode({
            v: 1,
            t: "history-unavailable",
            assignmentId: request.request.assignmentId,
            consumer: request.request.consumer,
            requestedAfterSeq: error.requestedAfterSeq,
            prunedThrough: error.prunedThrough,
          });
        }
        throw error;
      }
    }

    await options.authorize({
      operation: "ack",
      assignmentId: request.ack.assignmentId,
      consumer: request.ack.consumer,
      connection,
      signal,
    });
    signal.throwIfAborted();
    const streamEpoch = await epochFor(
      connection,
      request.ack.assignmentId,
      request.ack.consumer,
    );
    await options.spool.acknowledge(request.ack, streamEpoch);
    return encode({
      v: 1,
      t: "acked",
      assignmentId: request.ack.assignmentId,
      consumer: request.ack.consumer,
      ackSeq: request.ack.ackSeq,
    });
  };
}

export class AssignmentStreamMeshClient {
  constructor(private readonly client: MeshServiceClient) {}

  async subscribe(
    requestInput: StreamSubscribe,
    signal?: AbortSignal,
  ): Promise<readonly StreamFrame[]> {
    const request = validateStreamSubscribe(requestInput);
    const response = decodeResponse(
      await this.client.request(
        ASSIGNMENT_STREAM_SERVICE,
        encode({ v: 1, t: "subscribe", request }),
        signal,
      ),
    );
    if (response.t === "acked") {
      throw new TypeError("Stream service returned an ACK to a subscription");
    }
    if (response.t !== "frames") {
      if (
        response.assignmentId !== request.assignmentId ||
        canonicalize(response.consumer) !== canonicalize(request.consumer)
      ) {
        throw new TypeError("Stream terminal response does not bind the subscription");
      }
      if (response.t === "consumer-degraded") {
        throw new StreamConsumerDegradedError(
          streamConsumerKey(request.consumer),
        );
      }
      if (
        response.requestedAfterSeq !== request.afterSeq
      ) {
        throw new TypeError("Stream history response does not bind the subscription");
      }
      throw new StreamHistoryUnavailableError(
        response.requestedAfterSeq,
        response.prunedThrough,
      );
    }
    let expectedSeq = request.afterSeq + 1;
    for (const frame of response.frames) {
      if (
        frame.assignmentId !== request.assignmentId ||
        canonicalize(frame.ref) !== canonicalize(request.ref) ||
        frame.seq !== expectedSeq
      ) {
        throw new TypeError(
          "Stream service response does not bind the subscription",
        );
      }
      expectedSeq += 1;
    }
    return response.frames;
  }

  async acknowledge(
    ackInput: StreamAck,
    signal?: AbortSignal,
  ): Promise<void> {
    const ack = validateStreamAck(ackInput);
    const response = decodeResponse(
      await this.client.request(
        ASSIGNMENT_STREAM_SERVICE,
        encode({ v: 1, t: "ack", ack }),
        signal,
      ),
    );
    if (
      response.t !== "acked" ||
      response.assignmentId !== ack.assignmentId ||
      canonicalize(response.consumer) !== canonicalize(ack.consumer) ||
      response.ackSeq !== ack.ackSeq
    ) {
      throw new TypeError(
        "Stream service acknowledgment does not bind the request",
      );
    }
  }
}

function decodeRequest(payload: Uint8Array): StreamServiceRequest {
  const value = decode(payload);
  assertPlainObject(value, "Stream service request");
  if (value.v !== 1) {
    throw new TypeError("Stream service request version is invalid");
  }
  if (value.t === "subscribe") {
    assertExactKeys(value, ["request", "t", "v"], "Stream subscribe request");
    return {
      v: 1,
      t: "subscribe",
      request: validateStreamSubscribe(value.request),
    };
  }
  if (value.t === "ack") {
    assertExactKeys(value, ["ack", "t", "v"], "Stream ACK request");
    return { v: 1, t: "ack", ack: validateStreamAck(value.ack) };
  }
  throw new TypeError("Stream service request kind is invalid");
}

function decodeResponse(payload: Uint8Array): StreamServiceResponse {
  const value = decode(payload);
  assertPlainObject(value, "Stream service response");
  if (value.v !== 1) {
    throw new TypeError("Stream service response version is invalid");
  }
  if (value.t === "frames") {
    assertExactKeys(value, ["frames", "t", "v"], "Stream frame response");
    if (!Array.isArray(value.frames) || Object.keys(value.frames).length !== value.frames.length) {
      throw new TypeError("Stream frame response must contain a dense array");
    }
    return {
      v: 1,
      t: "frames",
      frames: value.frames.map(validateStreamFrame),
    };
  }
  if (value.t === "acked") {
    assertExactKeys(
      value,
      ["ackSeq", "assignmentId", "consumer", "t", "v"],
      "Stream ACK response",
    );
    assertNonEmptyString(value.assignmentId, "Stream assignmentId");
    if (!Number.isSafeInteger(value.ackSeq) || (value.ackSeq as number) < 0) {
      throw new TypeError("Stream ACK response sequence is invalid");
    }
    return {
      v: 1,
      t: "acked",
      assignmentId: value.assignmentId,
      consumer: validateStreamConsumerAuth(value.consumer),
      ackSeq: value.ackSeq as number,
    };
  }
  if (value.t === "consumer-degraded") {
    assertExactKeys(
      value,
      ["assignmentId", "consumer", "t", "v"],
      "Stream degraded response",
    );
    assertNonEmptyString(value.assignmentId, "Stream assignmentId");
    return {
      v: 1,
      t: "consumer-degraded",
      assignmentId: value.assignmentId,
      consumer: validateStreamConsumerAuth(value.consumer),
    };
  }
  if (value.t === "history-unavailable") {
    assertExactKeys(
      value,
      [
        "assignmentId",
        "consumer",
        "prunedThrough",
        "requestedAfterSeq",
        "t",
        "v",
      ],
      "Stream history response",
    );
    assertNonEmptyString(value.assignmentId, "Stream assignmentId");
    assertNonNegativeInteger(
      value.requestedAfterSeq,
      "Stream requested sequence",
    );
    assertNonNegativeInteger(value.prunedThrough, "Stream pruned sequence");
    return {
      v: 1,
      t: "history-unavailable",
      assignmentId: value.assignmentId,
      consumer: validateStreamConsumerAuth(value.consumer),
      requestedAfterSeq: value.requestedAfterSeq,
      prunedThrough: value.prunedThrough,
    };
  }
  throw new TypeError("Stream service response kind is invalid");
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function decode(payload: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (error) {
    throw new TypeError("Stream service payload is not valid UTF-8", {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TypeError("Stream service payload is not valid JSON", {
      cause: error,
    });
  }
  if (canonicalize(value) !== text) {
    throw new TypeError("Stream service payload is not canonical JSON");
  }
  return value;
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

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
