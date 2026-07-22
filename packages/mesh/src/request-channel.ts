import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import {
  MeshProtocolError,
  publicMeshErrorMessage,
  type MeshErrorCode,
} from "./errors.js";
import { assertRuntimeTimerDelay } from "./runtime-time.js";
import { MeshServiceRegistry } from "./service-registry.js";
import {
  assertSecureMeshConnection,
  type SecureMeshConnection,
} from "./session.js";

export interface MeshServiceClient {
  request(
    serviceId: string,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface MeshRequestChannelOptions {
  readonly maxPayloadBytes?: number;
  readonly maxInboundRequests?: number;
  readonly maxOutboundRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly handlerTimeoutMs?: number;
  readonly requestId?: () => string;
}

type PendingRequest = {
  readonly resolve: (payload: Uint8Array) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
};

type RequestFrame = {
  readonly v: 1;
  readonly t: "request";
  readonly requestId: string;
  readonly serviceId: string;
  readonly payload: string;
};

type ResponseFrame =
  | {
      readonly v: 1;
      readonly t: "response";
      readonly requestId: string;
      readonly ok: true;
      readonly payload: string;
    }
  | {
      readonly v: 1;
      readonly t: "response";
      readonly requestId: string;
      readonly ok: false;
      readonly error: { readonly code: MeshErrorCode; readonly message: string };
    };

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_INBOUND_REQUESTS = 64;
const DEFAULT_MAX_OUTBOUND_REQUESTS = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const SERVICE_ID = /^[a-z][a-z0-9.-]{0,63}$/u;

/** Owns the sole receive loop for one authenticated mesh connection. */
export class MeshRequestChannel implements MeshServiceClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #abort = new AbortController();
  readonly #maxPayloadBytes: number;
  readonly #maxInboundRequests: number;
  readonly #maxOutboundRequests: number;
  readonly #requestTimeoutMs: number;
  readonly #handlerTimeoutMs: number;
  readonly #requestId: () => string;
  readonly #closed: Promise<void>;
  #inboundRequests = 0;
  #stopped = false;

  constructor(
    private readonly connection: SecureMeshConnection,
    private readonly registry: MeshServiceRegistry,
    options: MeshRequestChannelOptions = {},
  ) {
    assertSecureMeshConnection(connection);
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.#maxInboundRequests =
      options.maxInboundRequests ?? DEFAULT_MAX_INBOUND_REQUESTS;
    this.#maxOutboundRequests =
      options.maxOutboundRequests ?? DEFAULT_MAX_OUTBOUND_REQUESTS;
    this.#requestTimeoutMs = assertRuntimeTimerDelay(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Mesh request timeout",
    );
    this.#handlerTimeoutMs = assertRuntimeTimerDelay(
      options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
      "Mesh handler timeout",
    );
    this.#requestId = options.requestId ?? (() => `mesh-request:${randomUUID()}`);
    assertPositiveInteger(this.#maxPayloadBytes, "Maximum mesh payload bytes");
    assertPositiveInteger(this.#maxInboundRequests, "Maximum inbound mesh requests");
    assertPositiveInteger(this.#maxOutboundRequests, "Maximum outbound mesh requests");
    this.#closed = this.#receiveLoop();
  }

  get closed(): Promise<void> {
    return this.#closed;
  }

  async request(
    serviceId: string,
    payload: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (this.#stopped || this.#abort.signal.aborted) throw closedError();
    assertServiceId(serviceId);
    assertPayload(payload, this.#maxPayloadBytes);
    if (signal?.aborted) throw abortedError();
    if (this.#pending.size >= this.#maxOutboundRequests) {
      throw new MeshProtocolError(
        "resource-exhausted",
        "Mesh endpoint has too many outbound requests in flight",
      );
    }
    const requestId = this.#requestId();
    assertRequestId(requestId);
    if (this.#pending.has(requestId)) {
      throw new TypeError("Mesh request ids must be unique while in flight");
    }
    let sendSettled = false;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.cleanup();
        const error = abortedError();
        reject(error);
        if (!sendSettled) this.#stopAfterTransportFailure(error);
      };
      const onTimeout = () => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.cleanup();
        const error = timeoutError();
        reject(error);
        this.#stopAfterTransportFailure(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(onTimeout, this.#requestTimeoutMs);
      this.#pending.set(requestId, {
        resolve,
        reject,
        cleanup: () => {
          if (timeout !== undefined) clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
        },
      });
    });
    void this.connection.send(encodeFrame({
      v: 1,
      t: "request",
      requestId,
      serviceId,
      payload: Buffer.from(payload).toString("base64"),
    })).then(() => {
      sendSettled = true;
    }, (error: unknown) => {
      sendSettled = true;
      const pending = this.#pending.get(requestId);
      if (pending) {
        this.#pending.delete(requestId);
        pending.cleanup();
        pending.reject(asError(error));
      }
      this.#stopAfterTransportFailure(error);
    });
    return response;
  }

  async close(reason?: Error): Promise<void> {
    if (this.#stopped) return this.#closed;
    this.#stopped = true;
    this.#abort.abort(reason);
    await this.connection.close(reason);
    await this.#closed;
  }

  async #receiveLoop(): Promise<void> {
    try {
      while (!this.#abort.signal.aborted) {
        const frame = decodeFrame(
          await this.connection.receive(this.#abort.signal),
          this.#maxPayloadBytes,
        );
        if (frame.t === "response") {
          this.#acceptResponse(frame);
        } else {
          if (this.#inboundRequests >= this.#maxInboundRequests) {
            throw new MeshProtocolError(
              "resource-exhausted",
              "Mesh endpoint has too many inbound requests in flight",
            );
          }
          void this.#acceptRequest(frame).catch((error) => {
            this.#stopAfterTransportFailure(error);
          });
        }
      }
    } catch (error) {
      if (!this.#abort.signal.aborted) {
        await this.connection.close(asError(error));
      }
    } finally {
      this.#stopped = true;
      const error = closedError();
      for (const pending of this.#pending.values()) {
        pending.cleanup();
        pending.reject(error);
      }
      this.#pending.clear();
    }
  }

  #acceptResponse(frame: ResponseFrame): void {
    const pending = this.#pending.get(frame.requestId);
    if (!pending) return;
    this.#pending.delete(frame.requestId);
    pending.cleanup();
    if (frame.ok) {
      pending.resolve(decodePayload(frame.payload, this.#maxPayloadBytes));
    } else {
      pending.reject(new MeshProtocolError(frame.error.code, frame.error.message));
    }
  }

  async #acceptRequest(frame: RequestFrame): Promise<void> {
    this.#inboundRequests += 1;
    const controller = new AbortController();
    const onChannelAbort = () => controller.abort(abortedError());
    this.#abort.signal.addEventListener("abort", onChannelAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(timeoutError()),
      this.#handlerTimeoutMs,
    );
    try {
      let responseFrame: ResponseFrame;
      try {
        const response = await raceAbort(
          this.registry.dispatch(
            frame.serviceId,
            decodePayload(frame.payload, this.#maxPayloadBytes),
            this.connection,
            controller.signal,
          ),
          controller.signal,
        );
        assertPayload(response, this.#maxPayloadBytes);
        responseFrame = {
          v: 1,
          t: "response",
          requestId: frame.requestId,
          ok: true,
          payload: Buffer.from(response).toString("base64"),
        };
      } catch (error) {
        if (controller.signal.aborted) throw asError(controller.signal.reason);
        responseFrame = failureFrame(frame.requestId, error);
      }
      await raceAbort(
        this.connection.send(encodeFrame(responseFrame)),
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
      this.#abort.signal.removeEventListener("abort", onChannelAbort);
      this.#inboundRequests -= 1;
    }
  }

  #stopAfterTransportFailure(error: unknown): void {
    if (this.#stopped || this.#abort.signal.aborted) return;
    const failure = asError(error);
    this.#abort.abort(failure);
    void this.connection.close(failure).catch(() => undefined);
  }
}

function failureFrame(requestId: string, error: unknown): ResponseFrame {
  const code = error instanceof MeshProtocolError ? error.code : "service-failed";
  return {
    v: 1,
    t: "response",
    requestId,
    ok: false,
    error: { code, message: publicMeshErrorMessage(code) },
  };
}

function encodeFrame(frame: RequestFrame | ResponseFrame): Uint8Array {
  return Buffer.from(canonicalize(frame), "utf8");
}

function decodeFrame(bytes: Uint8Array, maxPayloadBytes: number): RequestFrame | ResponseFrame {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new MeshProtocolError("invalid-frame", "Mesh request frame is not JSON");
  }
  if (canonicalize(value) !== text || !isPlainObject(value)) {
    throw new MeshProtocolError("invalid-frame", "Mesh request frame is not canonical");
  }
  if (value.v !== 1 || (value.t !== "request" && value.t !== "response")) {
    throw new MeshProtocolError("invalid-frame", "Mesh request frame kind is invalid");
  }
  assertRequestId(value.requestId);
  if (value.t === "request") {
    assertExactKeys(value, ["payload", "requestId", "serviceId", "t", "v"]);
    assertServiceId(value.serviceId);
    assertEncodedPayload(value.payload, maxPayloadBytes);
    return value as RequestFrame;
  }
  if (value.ok === true) {
    assertExactKeys(value, ["ok", "payload", "requestId", "t", "v"]);
    assertEncodedPayload(value.payload, maxPayloadBytes);
    return value as ResponseFrame;
  }
  if (value.ok === false && isPlainObject(value.error)) {
    assertExactKeys(value, ["error", "ok", "requestId", "t", "v"]);
    assertExactKeys(value.error, ["code", "message"]);
    if (
      !isMeshErrorCode(value.error.code) ||
      value.error.message !== publicMeshErrorMessage(value.error.code)
    ) {
      throw new MeshProtocolError("invalid-frame", "Mesh response error is invalid");
    }
    return value as ResponseFrame;
  }
  throw new MeshProtocolError("invalid-frame", "Mesh response outcome is invalid");
}

function decodePayload(value: string, maxPayloadBytes: number): Uint8Array {
  assertEncodedPayload(value, maxPayloadBytes);
  return Buffer.from(value, "base64");
}

function assertEncodedPayload(value: unknown, maxPayloadBytes: number): asserts value is string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new MeshProtocolError("invalid-frame", "Mesh payload is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxPayloadBytes || decoded.toString("base64") !== value) {
    throw new MeshProtocolError("invalid-frame", "Mesh payload exceeds its limit or is not canonical");
  }
}

function assertPayload(value: unknown, maxPayloadBytes: number): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maxPayloadBytes) {
    throw new MeshProtocolError("resource-exhausted", "Mesh service payload exceeds its byte limit");
  }
}

function assertRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw new MeshProtocolError("invalid-frame", "Mesh request id is invalid");
  }
}

function assertServiceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SERVICE_ID.test(value)) {
    throw new MeshProtocolError("invalid-frame", "Mesh service id is invalid");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new MeshProtocolError("invalid-frame", "Mesh request frame contains unknown fields");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMeshErrorCode(value: unknown): value is MeshErrorCode {
  return (
    value === "invalid-frame" ||
    value === "incompatible-version" ||
    value === "identity-mismatch" ||
    value === "unauthorized-peer" ||
    value === "invalid-signature" ||
    value === "clock-skew" ||
    value === "replay-detected" ||
    value === "connection-closed" ||
    value === "service-unavailable" ||
    value === "service-failed" ||
    value === "resource-exhausted" ||
    value === "request-aborted" ||
    value === "request-timeout"
  );
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Mesh connection failed");
}

function closedError(): MeshProtocolError {
  return new MeshProtocolError("connection-closed", "Mesh request channel is closed");
}

function abortedError(): MeshProtocolError {
  return new MeshProtocolError("request-aborted", "Mesh request was aborted");
}

function timeoutError(): MeshProtocolError {
  return new MeshProtocolError("request-timeout", "Mesh request exceeded its deadline");
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(asError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    }).catch(() => undefined);
  });
}
