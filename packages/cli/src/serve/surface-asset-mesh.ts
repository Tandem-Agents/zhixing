import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import {
  DEFAULT_ARTIFACT_CHUNK_BYTES,
  assertCanonicalArtifactRefs,
  validateArtifactReadResponse,
  validateArtifactReceiveProgress,
  type SurfaceAssetCoordinator,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  SurfaceAssetGrant,
} from "@zhixing/core/contracts";
import {
  assertSurfaceAssetGrantIssueBinding,
  canonicalize,
  validateSurfaceAssetGrant,
  validateSurfaceAssetGrantIssueBinding,
  type ProtocolSignatureVerifier,
  type SurfaceAssetGrantIssueBinding,
  type SurfaceAssetGrantOperationBinding,
} from "@zhixing/core/protocol";
import type {
  MeshServiceRegistry,
  SecureMeshConnection,
} from "@zhixing/mesh";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";

export const SURFACE_ASSET_SERVICE = "surface.assets";

type SurfaceAssetIssueRequest = {
  readonly v: 1;
  readonly t: "issue";
} & SurfaceAssetGrantIssueBinding;

type SurfaceAssetRequest =
  | SurfaceAssetIssueRequest
  | {
      readonly v: 1;
      readonly t: "probe";
      readonly grant: SurfaceAssetGrant;
      readonly ref: ArtifactRef;
    }
  | {
      readonly v: 1;
      readonly t: "append";
      readonly grant: SurfaceAssetGrant;
      readonly ref: ArtifactRef;
      readonly offset: number;
      readonly bytes: string;
    }
  | {
      readonly v: 1;
      readonly t: "read";
      readonly grant: SurfaceAssetGrant;
      readonly ref: ArtifactRef;
      readonly offset: number;
      readonly limit: number;
    };

export interface SurfaceAssetMeshServiceOptions {
  readonly coordinator: SurfaceAssetCoordinator | (() => SurfaceAssetCoordinator);
  readonly verifier: ProtocolSignatureVerifier;
  readonly surfacePrincipalFor: (connection: SecureMeshConnection) => string;
  readonly authorizePeer?: (deviceId: string) => boolean;
}

export function registerSurfaceAssetMeshService(
  registry: MeshServiceRegistry,
  options: SurfaceAssetMeshServiceOptions,
): () => void {
  return registry.register(SURFACE_ASSET_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    ...(options.authorizePeer
      ? {
          authorize: (connection: SecureMeshConnection) =>
            options.authorizePeer!(connection.peer.deviceId),
        }
      : {}),
    handler: createSurfaceAssetMeshServiceHandler(options),
  });
}

export function createSurfaceAssetMeshServiceHandler(
  options: SurfaceAssetMeshServiceOptions,
) {
  return async (
    payload: Uint8Array,
    connection: SecureMeshConnection,
    signal: AbortSignal,
  ): Promise<Uint8Array> => {
    signal.throwIfAborted();
    const request = decodeRequest(payload, options.verifier);
    const principal = options.surfacePrincipalFor(connection);
    const coordinator = typeof options.coordinator === "function"
      ? options.coordinator()
      : options.coordinator;
    if (request.t === "issue") {
      const grant =
        request.kind === "asset-upload"
          ? await coordinator.issue({
              kind: "asset-upload",
              scope: request.scope,
              surfacePrincipal: principal,
              requestId: request.requestId,
              assets: request.assets,
              payloadDigest: request.payloadDigest,
            })
          : await coordinator.issue({
              kind: "asset-download",
              scope: request.scope,
              surfacePrincipal: principal,
              requestId: request.requestId,
              assets: request.assets,
            });
      return encode({ v: 1, t: "grant", grant });
    }
    const use: SurfaceAssetGrantOperationBinding =
      request.grant.kind === "asset-upload"
        ? {
            kind: "asset-upload",
            scope: request.grant.scope,
            surfacePrincipal: principal,
            payloadDigest: request.grant.payloadDigest,
          }
        : {
            kind: "asset-download",
            scope: request.grant.scope,
            surfacePrincipal: principal,
          };
    if (request.t === "probe") {
      const progress = await coordinator.probe(
        request.grant,
        use,
        request.ref,
      );
      return encode({ v: 1, t: "progress", ...progress });
    }
    if (request.t === "append") {
      const progress = await coordinator.append(
        request.grant,
        use,
        request.ref,
        request.offset,
        Buffer.from(request.bytes, "base64"),
      );
      return encode({ v: 1, t: "progress", ...progress });
    }
    const bytes = await coordinator.read(
      request.grant,
      use,
      request.ref,
      request.offset,
      request.limit,
    );
    return encode({
      v: 1,
      t: "bytes",
      bytes: Buffer.from(bytes).toString("base64"),
    });
  };
}

export class SurfaceAssetMeshClient {
  constructor(
    private readonly client: MeshServiceClient,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  async issue(
    request: SurfaceAssetGrantIssueBinding,
    signal?: AbortSignal,
  ): Promise<SurfaceAssetGrant> {
    const binding = validateSurfaceAssetGrantIssueBinding(request);
    const response = decodeJson(
      await this.client.request(
        SURFACE_ASSET_SERVICE,
        encode({ v: 1, t: "issue", ...binding }),
        signal,
      ),
    );
    assertObject(response, "Surface asset grant response");
    assertKeys(response, ["grant", "t", "v"]);
    if (response.v !== 1 || response.t !== "grant") {
      throw new TypeError("Surface asset grant response is invalid");
    }
    const grant = validateSurfaceAssetGrant(response.grant, this.verifier);
    assertSurfaceAssetGrantIssueBinding(grant, binding);
    return grant;
  }

  async probe(
    grant: SurfaceAssetGrant,
    ref: ArtifactRef,
    signal?: AbortSignal,
  ): Promise<{ readonly receivedBytes: number; readonly complete: boolean }> {
    return this.#progress({ v: 1, t: "probe", grant, ref }, signal);
  }

  async append(
    grant: SurfaceAssetGrant,
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ readonly receivedBytes: number; readonly complete: boolean }> {
    return this.#progress(
      {
        v: 1,
        t: "append",
        grant,
        ref,
        offset,
        bytes: Buffer.from(bytes).toString("base64"),
      },
      signal,
    );
  }

  async read(
    grant: SurfaceAssetGrant,
    ref: ArtifactRef,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > DEFAULT_ARTIFACT_CHUNK_BYTES
    ) {
      throw new RangeError("Surface asset read limit is outside its bound");
    }
    const response = decodeJson(
      await this.client.request(
        SURFACE_ASSET_SERVICE,
        encode({ v: 1, t: "read", grant, ref, offset, limit }),
        signal,
      ),
    );
    assertObject(response, "Surface asset read response");
    assertKeys(response, ["bytes", "t", "v"]);
    if (
      response.v !== 1 ||
      response.t !== "bytes" ||
      typeof response.bytes !== "string"
    ) {
      throw new TypeError("Surface asset read response is invalid");
    }
    if (Buffer.from(response.bytes, "base64").toString("base64") !== response.bytes) {
      throw new TypeError("Surface asset read response encoding is invalid");
    }
    const bytes = Buffer.from(response.bytes, "base64");
    return validateArtifactReadResponse(bytes, ref, offset, limit);
  }

  async #progress(
    request: Extract<SurfaceAssetRequest, { t: "probe" | "append" }>,
    signal?: AbortSignal,
  ): Promise<{ readonly receivedBytes: number; readonly complete: boolean }> {
    const response = decodeJson(
      await this.client.request(
        SURFACE_ASSET_SERVICE,
        encode(request),
        signal,
      ),
    );
    assertObject(response, "Surface asset progress response");
    assertKeys(response, ["complete", "receivedBytes", "t", "v"]);
    if (
      response.v !== 1 ||
      response.t !== "progress" ||
      typeof response.complete !== "boolean" ||
      !Number.isSafeInteger(response.receivedBytes) ||
      (response.receivedBytes as number) < 0
    ) {
      throw new TypeError("Surface asset progress response is invalid");
    }
    return validateArtifactReceiveProgress(
      {
        complete: response.complete,
        receivedBytes: response.receivedBytes,
      },
      request.ref,
    );
  }
}

function decodeRequest(
  payload: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): SurfaceAssetRequest {
  const value = decodeJson(payload);
  assertObject(value, "Surface asset request");
  if (value.v !== 1 || typeof value.t !== "string") {
    throw new TypeError("Surface asset request is invalid");
  }
  if (value.t === "issue") {
    const { t: _, v: __, ...rawBinding } = value;
    return {
      v: 1,
      t: "issue",
      ...validateSurfaceAssetGrantIssueBinding(rawBinding),
    };
  }
  if (value.t === "probe" || value.t === "append" || value.t === "read") {
    assertKeys(
      value,
      value.t === "probe"
        ? ["grant", "ref", "t", "v"]
        : value.t === "append"
          ? ["bytes", "grant", "offset", "ref", "t", "v"]
          : ["grant", "limit", "offset", "ref", "t", "v"],
    );
    const grant = validateSurfaceAssetGrant(value.grant, verifier);
    assertCanonicalArtifactRefs(
      [value.ref as ArtifactRef],
      "Surface asset request ref",
    );
    if (
      value.t !== "probe" &&
      (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0)
    ) {
      throw new TypeError("Surface asset request offset is invalid");
    }
    if (
      value.t === "append" &&
      (typeof value.bytes !== "string" ||
        Buffer.from(value.bytes, "base64").toString("base64") !== value.bytes ||
        Buffer.byteLength(value.bytes, "base64") >
          DEFAULT_ARTIFACT_CHUNK_BYTES)
    ) {
      throw new TypeError("Surface asset chunk encoding is invalid");
    }
    if (
      value.t === "read" &&
      (!Number.isSafeInteger(value.limit) ||
        (value.limit as number) <= 0 ||
        (value.limit as number) > DEFAULT_ARTIFACT_CHUNK_BYTES)
    ) {
      throw new TypeError("Surface asset read limit is invalid");
    }
    return { ...value, grant } as unknown as SurfaceAssetRequest;
  }
  throw new TypeError("Surface asset request type is invalid");
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function decodeJson(payload: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) {
    throw new TypeError("Surface asset payload is not canonical JSON");
  }
  return value;
}

function assertObject(
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

function assertKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
    canonicalize([...keys].sort())
  ) {
    throw new TypeError("Surface asset fields are incomplete or unknown");
  }
}
