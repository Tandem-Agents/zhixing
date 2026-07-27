import { Buffer } from "node:buffer";
import type { SurfaceAssetCoordinator } from "@zhixing/core/authority";
import type {
  ArtifactRef,
  Digest,
  SurfaceAssetGrant,
  SurfaceAssetScope,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  createSignedSurfaceAssetGrant,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { SecureMeshConnection } from "@zhixing/mesh";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import { describe, expect, it, vi } from "vitest";
import {
  SURFACE_ASSET_SERVICE,
  SurfaceAssetMeshClient,
  createSurfaceAssetMeshServiceHandler,
} from "./surface-asset-mesh.js";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "owner-fixed",
      sig: protocolDigest("TestSignature", 1, { schemaId, version, payload }),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

const scope: SurfaceAssetScope = {
  domain: "conversation",
  conversationId: "conversation-fixed",
  ownerEpoch: 3,
};
const asset: ArtifactRef = {
  digest: `sha256:${"a".repeat(64)}`,
  bytes: 5,
};
const payloadDigest = `sha256:${"b".repeat(64)}` as Digest;

describe("surface asset mesh adapter", () => {
  it("derives the surface principal and preserves grant-bound transfer data", async () => {
    const issue = vi.fn(async (request: {
      readonly surfacePrincipal: string;
      readonly requestId: string;
    }) => grant(request.surfacePrincipal, request.requestId, "asset-upload"));
    const append = vi.fn(async (
      accepted: SurfaceAssetGrant,
      use: { readonly surfacePrincipal: string },
      ref: ArtifactRef,
      offset: number,
      bytes: Uint8Array,
    ) => {
      if (use.surfacePrincipal !== accepted.surfacePrincipal) {
        throw new TypeError("Surface asset grant does not bind the requested operation");
      }
      expect(ref).toEqual(asset);
      expect(offset).toBe(0);
      expect(Buffer.from(bytes).toString("utf8")).toBe("hello");
      return { receivedBytes: 5, complete: true };
    });
    const coordinator = {
      issue,
      append,
      probe: vi.fn(),
      read: vi.fn(),
    } as unknown as SurfaceAssetCoordinator;
    const handler = createSurfaceAssetMeshServiceHandler({
      coordinator,
      verifier: identity,
      surfacePrincipalFor: (connection) =>
        `surface:device:${connection.peer.deviceId}`,
    });
    const owner = new SurfaceAssetMeshClient(
      directClient(handler, connection("device-one")),
      identity,
    );

    const issued = await owner.issue({
      kind: "asset-upload",
      scope,
      requestId: "request-fixed",
      assets: [asset],
      payloadDigest,
    });
    expect(issue).toHaveBeenCalledWith({
      kind: "asset-upload",
      scope,
      surfacePrincipal: "surface:device:device-one",
      requestId: "request-fixed",
      assets: [asset],
      payloadDigest,
    });
    await expect(
      owner.append(
        issued,
        asset,
        0,
        Buffer.from("hello"),
      ),
    ).resolves.toEqual({ receivedBytes: 5, complete: true });

    const intruder = new SurfaceAssetMeshClient(
      directClient(handler, connection("device-two")),
      identity,
    );
    await expect(
      intruder.append(
        issued,
        asset,
        0,
        Buffer.from("hello"),
      ),
    ).rejects.toThrow(/does not bind/);
  });

  it("rejects a validly signed grant that belongs to another issue request", async () => {
    const client = new SurfaceAssetMeshClient(
      responding({
        v: 1,
        t: "grant",
        grant: grant("surface:device:device-one", "another-request", "asset-upload"),
      }),
      identity,
    );
    await expect(client.issue({
      kind: "asset-upload",
      scope,
      requestId: "request-fixed",
      assets: [asset],
      payloadDigest,
    })).rejects.toThrow(/does not bind/);
  });

  it("rejects impossible progress and oversized range responses", async () => {
    const upload = grant("surface:device:device-one", "request-fixed", "asset-upload");
    const impossibleProgress = new SurfaceAssetMeshClient(
      responding({
        v: 1,
        t: "progress",
        receivedBytes: asset.bytes + 1,
        complete: true,
      }),
      identity,
    );
    await expect(impossibleProgress.probe(upload, asset)).rejects.toThrow(
      /progress is invalid/,
    );

    const download = grant(
      "surface:device:device-one",
      "download-request",
      "asset-download",
    );
    const oversizedRange = new SurfaceAssetMeshClient(
      responding({
        v: 1,
        t: "bytes",
        bytes: Buffer.from("too-long").toString("base64"),
      }),
      identity,
    );
    await expect(oversizedRange.read(download, asset, 0, asset.bytes)).rejects.toThrow(
      /range response is invalid/,
    );
  });

  it("rejects invalid issue bindings before they reach either side", async () => {
    const issue = vi.fn();
    const handler = createSurfaceAssetMeshServiceHandler({
      coordinator: { issue } as unknown as SurfaceAssetCoordinator,
      verifier: identity,
      surfacePrincipalFor: (meshConnection) =>
        `surface:device:${meshConnection.peer.deviceId}`,
    });
    const service = directClient(handler, connection("device-one"));

    await expect(
      service.request(
        SURFACE_ASSET_SERVICE,
        Buffer.from(canonicalize({
          v: 1,
          t: "issue",
          kind: "unknown",
          scope,
          requestId: "request-unknown",
          assets: [asset],
        }), "utf8"),
      ),
    ).rejects.toThrow("kind is invalid");
    expect(issue).not.toHaveBeenCalled();

    const request = vi.fn();
    const client = new SurfaceAssetMeshClient(
      { request } as unknown as MeshServiceClient,
      identity,
    );
    await expect(
      client.issue({
        kind: "asset-upload",
        scope,
        requestId: "request-noncanonical",
        assets: [
          asset,
          { digest: `sha256:${"0".repeat(64)}`, bytes: 1 },
        ],
        payloadDigest,
      }),
    ).rejects.toThrow("canonical order");
    expect(request).not.toHaveBeenCalled();
  });
});

function grant(
  surfacePrincipal: string,
  requestId: string,
  kind: SurfaceAssetGrant["kind"],
): SurfaceAssetGrant {
  return createSignedSurfaceAssetGrant(
    {
      v: 1,
      grantId: "grt-01J00000000000000000000000",
      scope,
      surfacePrincipal,
      requestId,
      kind,
      assets: [asset],
      issuedAt: "2026-07-24T00:00:00.000Z",
      expiry: "2026-07-24T01:00:00.000Z",
      ...(kind === "asset-upload" ? { payloadDigest } : {}),
    } as Parameters<typeof createSignedSurfaceAssetGrant>[0],
    identity,
  );
}

function directClient(
  handler: ReturnType<typeof createSurfaceAssetMeshServiceHandler>,
  meshConnection: SecureMeshConnection,
): MeshServiceClient {
  return {
    request(serviceId, payload, signal) {
      expect(serviceId).toBe(SURFACE_ASSET_SERVICE);
      return handler(
        payload,
        meshConnection,
        signal ?? new AbortController().signal,
      );
    },
  };
}

function responding(value: unknown): MeshServiceClient {
  return {
    async request() {
      return Buffer.from(canonicalize(value), "utf8");
    },
  };
}

function connection(deviceId: string): SecureMeshConnection {
  return {
    peer: { deviceId, publicKey: "test-public-key" },
  } as unknown as SecureMeshConnection;
}
