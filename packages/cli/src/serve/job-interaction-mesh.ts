import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import type { ChannelInteractionGrant } from "@zhixing/core/contracts";
import {
  canonicalize,
  validateChannelInteractionGrant,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type {
  MeshServiceRegistry,
  SecureMeshConnection,
} from "@zhixing/mesh";
import {
  JobInteractionRuntimeUnavailableError,
  type JobInteractionGrantPort,
} from "./durable-job-interactions.js";

/**
 * job 交互答复的独立 mesh 面:承载渠道 grant 与无应答解决的跨机转交。
 * 与 conversation 的 surface-ticket 服务刻意分离——两域凭证在类型与
 * 路由上互不可达,grant 的密码学鉴权仍由 executor 账本完成。
 */
export const JOB_INTERACTION_SERVICE = "assignment.job-interaction";

type JobInteractionServiceRequest =
  | {
      readonly v: 1;
      readonly t: "deliver-grant";
      readonly grant: ChannelInteractionGrant;
    }
  | {
      readonly v: 1;
      readonly t: "resolve-non-interactive";
      readonly assignmentId: string;
      readonly requestId: string;
    };

type JobInteractionServiceResponse =
  | { readonly v: 1; readonly t: "ok" }
  | {
      readonly v: 1;
      readonly t: "runtime-unavailable";
      readonly assignmentId: string;
      readonly requestId: string;
    };

export interface JobInteractionServiceOptions {
  readonly answers: JobInteractionGrantPort;
  readonly verifier: ProtocolSignatureVerifier;
  readonly authorizeOwner: (
    connection: SecureMeshConnection,
    assignmentId: string,
  ) => boolean;
  readonly authorizePeer?: (deviceId: string) => boolean;
}

export function registerJobInteractionService(
  registry: MeshServiceRegistry,
  options: JobInteractionServiceOptions,
): () => void {
  return registry.register(JOB_INTERACTION_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    ...(options.authorizePeer
      ? {
          authorize: (connection: SecureMeshConnection) =>
            options.authorizePeer!(connection.peer.deviceId),
        }
      : {}),
    handler: createJobInteractionServiceHandler(options),
  });
}

export function createJobInteractionServiceHandler(
  options: JobInteractionServiceOptions,
): (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array> {
  return async (payload, connection, signal) => {
    signal.throwIfAborted();
    const request = decodeRequest(payload, options.verifier);
    const identity =
      request.t === "deliver-grant"
        ? {
            assignmentId: request.grant.assignmentId,
            requestId: request.grant.interactionRequestId,
          }
        : {
            assignmentId: request.assignmentId,
            requestId: request.requestId,
          };
    if (!options.authorizeOwner(connection, identity.assignmentId)) {
      throw new Error("Job interaction relay requires the assignment owner");
    }
    try {
      if (request.t === "deliver-grant") {
        await options.answers.deliverGrant(request.grant);
      } else {
        await options.answers.resolveNoInteractiveSurface({
          assignmentId: request.assignmentId,
          requestId: request.requestId,
        });
      }
    } catch (error) {
      if (error instanceof JobInteractionRuntimeUnavailableError) {
        return encode({
          v: 1,
          t: "runtime-unavailable",
          assignmentId: identity.assignmentId,
          requestId: identity.requestId,
        } satisfies JobInteractionServiceResponse);
      }
      throw error;
    }
    signal.throwIfAborted();
    return encode({ v: 1, t: "ok" } satisfies JobInteractionServiceResponse);
  };
}

/** owner 侧的渠道答复转交客户端；surface ticket 走数据面 operations router。 */
export class JobInteractionMeshClient implements JobInteractionGrantPort {
  constructor(private readonly client: MeshServiceClient) {}

  async deliverGrant(
    grant: ChannelInteractionGrant,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#send({ v: 1, t: "deliver-grant", grant }, signal);
  }

  async resolveNoInteractiveSurface(
    input: {
      readonly assignmentId: string;
      readonly requestId: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#send({ v: 1, t: "resolve-non-interactive", ...input }, signal);
  }

  async #send(
    request: JobInteractionServiceRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const expected =
      request.t === "deliver-grant"
        ? {
            assignmentId: request.grant.assignmentId,
            requestId: request.grant.interactionRequestId,
          }
        : {
            assignmentId: request.assignmentId,
            requestId: request.requestId,
          };
    const response = decodeJson(
      await this.client.request(
        JOB_INTERACTION_SERVICE,
        encode(request),
        signal,
      ),
    );
    if (!isPlainObject(response) || response.v !== 1) {
      throw new TypeError("Job interaction service response is invalid");
    }
    if (
      response.t === "runtime-unavailable" &&
      Object.keys(response).length === 4 &&
      typeof response.assignmentId === "string" &&
      typeof response.requestId === "string" &&
      response.assignmentId === expected.assignmentId &&
      response.requestId === expected.requestId
    ) {
      throw new JobInteractionRuntimeUnavailableError(
        "Executor job interaction runtime is not yet restored",
      );
    }
    if (response.t === "runtime-unavailable") {
      throw new TypeError(
        "Job interaction service response does not bind the request",
      );
    }
    if (response.t !== "ok" || Object.keys(response).length !== 2) {
      throw new TypeError("Job interaction service response is invalid");
    }
  }
}

function decodeRequest(
  payload: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): JobInteractionServiceRequest {
  const value = decodeJson(payload);
  if (!isPlainObject(value) || value.v !== 1 || typeof value.t !== "string") {
    throw new TypeError("Job interaction service request is invalid");
  }
  if (value.t === "deliver-grant") {
    assertKeys(value, ["grant", "t", "v"]);
    return {
      v: 1,
      t: "deliver-grant",
      grant: validateChannelInteractionGrant(value.grant, verifier),
    };
  }
  if (value.t === "resolve-non-interactive") {
    assertKeys(value, ["assignmentId", "requestId", "t", "v"]);
    assertIdentifier(value.assignmentId, "Job interaction assignment id");
    assertIdentifier(value.requestId, "Job interaction request id");
    return value as unknown as JobInteractionServiceRequest;
  }
  throw new TypeError("Job interaction service request type is invalid");
}

function encode(input: unknown): Uint8Array {
  return Buffer.from(canonicalize(input), "utf8");
}

function decodeJson(payload: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  const parsed = JSON.parse(text) as unknown;
  if (canonicalize(parsed) !== text) {
    throw new TypeError("Job interaction payload is not canonical JSON");
  }
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
    canonicalize([...keys].sort())
  ) {
    throw new TypeError("Job interaction service fields are incomplete or unknown");
  }
}

function assertIdentifier(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 480) {
    throw new TypeError(`${label} is invalid`);
  }
}
