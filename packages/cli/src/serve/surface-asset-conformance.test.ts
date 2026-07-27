import { Buffer } from "node:buffer";
import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  type SurfaceAssetCoordinator,
} from "@zhixing/core/authority";
import type { ControlEnvelope, ControlRecord } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { createSurfaceAssetAuthority } from "./surface-asset-authority.js";
import type {
  ArtifactRef,
  Digest,
  SurfaceAssetGrant,
  SurfaceAssetScope,
} from "@zhixing/core/contracts";
import {
  byteDigest,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type SurfaceAssetGrantIssueBinding,
  type SurfaceAssetGrantOperationBinding,
} from "@zhixing/core/protocol";
import type { SecureMeshConnection } from "@zhixing/mesh";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import { describe, expect, it } from "vitest";
import {
  SURFACE_ASSET_SERVICE,
  SurfaceAssetMeshClient,
  createSurfaceAssetMeshServiceHandler,
} from "./surface-asset-mesh.js";

interface SurfaceAssetAdapter {
  issue(binding: SurfaceAssetGrantIssueBinding): Promise<SurfaceAssetGrant>;
  probe(
    grant: SurfaceAssetGrant,
    ref: ArtifactRef,
  ): Promise<{ readonly receivedBytes: number; readonly complete: boolean }>;
  append(
    grant: SurfaceAssetGrant,
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
  ): Promise<{ readonly receivedBytes: number; readonly complete: boolean }>;
  read(
    grant: SurfaceAssetGrant,
    ref: ArtifactRef,
    offset: number,
    limit: number,
  ): Promise<Uint8Array>;
}

interface ConformanceHarness {
  readonly adapter: SurfaceAssetAdapter;
  readonly events: readonly string[];
}

type AdapterFactory = (
  principal: string,
  coordinator: SurfaceAssetCoordinator,
) => SurfaceAssetAdapter;

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

const AT = "2026-07-24T00:30:00.000Z";
const UPLOAD_BYTES = Buffer.from("hello", "utf8");
// 真实协调器会校验字节与摘要一致,上传资产必须用真实内容摘要。
const asset: ArtifactRef = {
  digest: byteDigest(UPLOAD_BYTES),
  bytes: UPLOAD_BYTES.byteLength,
};
const otherAsset: ArtifactRef = {
  digest: `sha256:${"c".repeat(64)}`,
  bytes: 5,
};
const payloadDigest = `sha256:${"b".repeat(64)}` as Digest;
const principal = "surface:device:device-one";

/** 真实权威装配要落多份耐久写,复用包内既定的有界预算,不用默认 5 秒。 */
const CLI_DURABLE_IO_TEST_TIMEOUT_MS = 120_000;

const adapterFactories: readonly [string, AdapterFactory][] = [
  ["in-process", createInProcessAdapter],
  ["mesh", createMeshAdapter],
];

describe.each(adapterFactories)(
  "surface asset %s adapter conformance",
  (_name, createAdapter) => {
    it("preserves all operations, authoritative effects, and return values", async () => {
      const { coordinator, scope, visibleAsset } = await createAuthorityFixture();
      const harness = createHarness(createAdapter, principal, coordinator);
      const upload = await harness.adapter.issue({
        kind: "asset-upload",
        scope,
        requestId: "upload-request",
        assets: [asset],
        payloadDigest,
      });
      await expect(harness.adapter.probe(upload, asset)).resolves.toEqual({
        receivedBytes: 0,
        complete: false,
      });
      await expect(
        harness.adapter.append(upload, asset, 0, UPLOAD_BYTES),
      ).resolves.toEqual({ receivedBytes: 5, complete: true });

      // 下载走权威已接纳的内容:上传中的临时件不构成可见事实。
      const download = await harness.adapter.issue({
        kind: "asset-download",
        scope,
        requestId: "download-request",
        assets: [visibleAsset],
      });
      await expect(harness.adapter.read(download, visibleAsset, 1, 3))
        .resolves.toEqual(Buffer.from("isi"));
      expect(harness.events).toEqual([
        "issue:asset-upload:upload-request",
        "probe:upload-request",
        "append:upload-request:0:hello",
        "issue:asset-download:download-request",
        "read:download-request:1:3",
      ]);

      // 权威状态:同 requestId 重发只回放原授权,证明两个 adapter 都真的落到了
      // 同一份耐久事实上,而不是各自算出一个长得像的返回值。
      const replayed = await harness.adapter.issue({
        kind: "asset-upload",
        scope,
        requestId: "upload-request",
        assets: [asset],
        payloadDigest,
      });
      expect(replayed.grantId).toBe(upload.grantId);
      expect(replayed.issuedAt).toBe(upload.issuedAt);
    }, CLI_DURABLE_IO_TEST_TIMEOUT_MS);

    it("rejects principal, direction, reference, and range mismatches", async () => {
      const { coordinator, scope, visibleAsset } = await createAuthorityFixture();
      const owner = createHarness(createAdapter, principal, coordinator);
      const intruder = createHarness(
        createAdapter,
        "surface:device:device-two",
        coordinator,
      );
      const upload = await owner.adapter.issue({
        kind: "asset-upload",
        scope,
        requestId: "upload-request",
        assets: [asset],
        payloadDigest,
      });
      const download = await owner.adapter.issue({
        kind: "asset-download",
        scope,
        requestId: "download-request",
        assets: [visibleAsset],
      });

      await expect(intruder.adapter.probe(upload, asset)).rejects.toThrow(
        /does not bind/,
      );
      await expect(owner.adapter.append(download, visibleAsset, 0, Buffer.from("x")))
        .rejects.toThrow(/Download grant cannot append/);
      await expect(owner.adapter.read(upload, asset, 0, 1)).rejects.toThrow(
        /Upload grant cannot read/,
      );
      await expect(owner.adapter.probe(upload, otherAsset)).rejects.toThrow(
        /does not contain/,
      );
      // 起点等于长度是合法边界(读完),超过长度才是越界。
      await expect(
        owner.adapter.read(download, visibleAsset, visibleAsset.bytes, 1),
      ).resolves.toEqual(Buffer.alloc(0));
      await expect(
        owner.adapter.read(download, visibleAsset, visibleAsset.bytes + 1, 1),
      ).rejects.toThrow(/starts beyond its byte length/);
      await expect(owner.adapter.read(download, visibleAsset, 0, 0))
        .rejects.toThrow(/outside its bound/);
    }, CLI_DURABLE_IO_TEST_TIMEOUT_MS);
  },
);

function createHarness(
  createAdapter: AdapterFactory,
  surfacePrincipal: string,
  coordinator: SurfaceAssetCoordinator,
): ConformanceHarness & { readonly coordinator: SurfaceAssetCoordinator } {
  const events: string[] = [];
  const observed = observing(coordinator, events);
  return {
    adapter: createAdapter(surfacePrincipal, observed),
    coordinator: observed,
    events,
  };
}

/**
 * 观测装饰器 —— 只记录调用序列,全部行为透传真实协调器。
 *
 * 它是 harness 依赖,不是被测语义:两个 adapter 底下必须是同一个真实生产实例,
 * 否则比较的只是两条测试替身各自的返回值。
 */
function observing(
  coordinator: SurfaceAssetCoordinator,
  events: string[],
): SurfaceAssetCoordinator {
  return {
    issue(request) {
      events.push(`issue:${request.kind}:${request.requestId}`);
      return coordinator.issue(request);
    },
    probe(grant, use, ref) {
      events.push(`probe:${grant.requestId}`);
      return coordinator.probe(grant, use, ref);
    },
    append(grant, use, ref, offset, bytes) {
      events.push(
        `append:${grant.requestId}:${offset}:${
          Buffer.from(bytes).toString("utf8")
        }`,
      );
      return coordinator.append(grant, use, ref, offset, bytes);
    },
    read(grant, use, ref, offset, limit) {
      events.push(`read:${grant.requestId}:${offset}:${limit}`);
      return coordinator.read(grant, use, ref, offset, limit);
    },
  } as SurfaceAssetCoordinator;
}

/**
 * 真实权威装配 —— 走生产组合根 createSurfaceAssetAuthority,带真实权威日志、
 * 真实主/临时存储与真实可见性投影。
 *
 * 同时预置一条会话创建与一条带附件的 input,使 `visibleAsset` 成为该会话真正
 * 可下载的内容:真实系统里刚上传、尚未被权威记录接管的临时件本就不可下载,
 * 下载路径必须由权威事实喂出来才算走过生产语义。
 */
async function createAuthorityFixture(): Promise<{
  readonly coordinator: SurfaceAssetCoordinator;
  readonly scope: SurfaceAssetScope;
  readonly visibleAsset: ArtifactRef;
}> {
  const root = await createTempDir("surface-asset-conformance");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(root, "authority-log"),
    artifacts,
    { clock: () => AT },
  );
  const conversationId = "conversation-conformance";
  const stored = await artifacts.put(Buffer.from("visible-content", "utf8"));
  const visibleAsset: ArtifactRef = {
    digest: stored.digest,
    bytes: stored.bytes,
  };
  const envelope = (
    requestId: string,
    body: ControlEnvelope["body"],
  ): ControlEnvelope => ({
    v: 1,
    requestId,
    principal: {
      surfacePrincipal: "surface-conformance",
      deviceId: "device-conformance",
      connectionId: "connection-conformance",
    },
    at: AT,
    dependencyArtifacts: [],
    body,
    payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
      body,
      dependencyArtifacts: [],
    }),
  });
  const create = envelope("request-create-conformance", { t: "session-create" });
  await log.append<ControlRecord>([
    {
      stream: "control",
      body: { t: "received", requestId: create.requestId, envelope: create },
    },
    {
      stream: "control",
      body: {
        t: "applied",
        requestId: create.requestId,
        authorityRevision: 1,
        result: {
          v: 1,
          status: "ok",
          body: { t: "session-create", conversationId },
        },
      },
    },
  ]);
  const input = envelope("request-input-conformance", {
    t: "input",
    conversationId,
    ingress: { ingressId: "ingress-conformance", source: "first-party" },
    input: { parts: [{ type: "text", text: "attach" }] },
    attachments: [{ ...visibleAsset, kind: "file" }],
    invocation: { kind: "agent", source: "interactive" },
    ownerEpoch: 1,
  } as ControlEnvelope["body"]);
  const inputRef = await artifacts.put(
    Buffer.from(canonicalize(input), "utf8"),
  );
  await log.append<ControlRecord>([
    {
      stream: "control",
      body: {
        t: "received",
        requestId: input.requestId,
        envelope: { ref: inputRef },
      },
    },
    {
      stream: "control",
      body: {
        t: "applied",
        requestId: input.requestId,
        authorityRevision: 2,
        result: {
          v: 1,
          status: "ok",
          body: { t: "input", runId: "run-conformance", queuedPosition: 1 },
        },
      },
    },
  ]);
  const coordinator = createSurfaceAssetAuthority({
    authorityRoot: path.join(root, "authority"),
    log,
    retentionLogs: [],
    artifacts,
    signer: identity,
    verifier: identity,
    anchorEpoch: 1,
    clock: () => AT,
  });
  return {
    coordinator,
    scope: { domain: "conversation", conversationId, ownerEpoch: 1 },
    visibleAsset,
  };
}



function createInProcessAdapter(
  surfacePrincipal: string,
  coordinator: SurfaceAssetCoordinator,
): SurfaceAssetAdapter {
  return {
    issue: (binding) => coordinator.issue({ ...binding, surfacePrincipal }),
    probe: (grant, ref) =>
      coordinator.probe(grant, operationBinding(grant, surfacePrincipal), ref),
    append: (grant, ref, offset, bytes) =>
      coordinator.append(
        grant,
        operationBinding(grant, surfacePrincipal),
        ref,
        offset,
        bytes,
      ),
    read: (grant, ref, offset, limit) =>
      coordinator.read(
        grant,
        operationBinding(grant, surfacePrincipal),
        ref,
        offset,
        limit,
      ),
  };
}

function createMeshAdapter(
  surfacePrincipal: string,
  coordinator: SurfaceAssetCoordinator,
): SurfaceAssetAdapter {
  const deviceId = surfacePrincipal.slice("surface:device:".length);
  const connection = {
    peer: { deviceId, publicKey: "test-public-key" },
  } as unknown as SecureMeshConnection;
  const handler = createSurfaceAssetMeshServiceHandler({
    coordinator,
    verifier: identity,
    surfacePrincipalFor: (accepted) =>
      `surface:device:${accepted.peer.deviceId}`,
  });
  const client: MeshServiceClient = {
    request(serviceId, payload, signal) {
      expect(serviceId).toBe(SURFACE_ASSET_SERVICE);
      return handler(
        payload,
        connection,
        signal ?? new AbortController().signal,
      );
    },
  };
  return new SurfaceAssetMeshClient(client, identity);
}

function operationBinding(
  grant: SurfaceAssetGrant,
  surfacePrincipal: string,
): SurfaceAssetGrantOperationBinding {
  return grant.kind === "asset-upload"
    ? {
        kind: "asset-upload",
        scope: grant.scope,
        surfacePrincipal,
        payloadDigest: grant.payloadDigest,
      }
    : {
        kind: "asset-download",
        scope: grant.scope,
        surfacePrincipal,
      };
}
