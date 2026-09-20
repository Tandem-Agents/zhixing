import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { assertArtifactRef, validateArtifactReceiveProgress, type ArtifactStore, type FileResumableArtifactReceiver } from "@zhixing/core/authority";
import type { ArtifactRef } from "@zhixing/core/contracts";
import type { MeshServiceClient } from "@zhixing/mesh";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { ExtensionManagementRequest } from "@zhixing/core/extensions/contracts";
import type { ExtensionManagementTransport } from "./extension-tools.js";

const SERVICE = "extensions.management";
const MAX_CANDIDATE_BYTES = 24 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf8"));

export function registerExtensionManagementMesh(input: {
  registry: MeshServiceRegistry; authorizePeer(id: string): boolean; management: ExtensionManagementTransport;
  artifacts: Pick<ArtifactStore, "get">;
  receiver: Pick<FileResumableArtifactReceiver, "progress" | "append">;
}) {
  return input.registry.register(SERVICE, { access: "write", availability: "negotiated-version",
    authorize: connection => input.authorizePeer(connection.peer.deviceId),
    handler: async (payload, _connection, signal) => {
      try {
        signal.throwIfAborted();
        const wire = decode(payload);
        if (wire?.v !== 1) throw new Error("扩展管理协议无效");
        let request: ExtensionManagementRequest;
        if (wire.t === "source") {
          if (typeof wire.id !== "string" || !Number.isSafeInteger(wire.offset) || wire.offset < 0) throw new Error("源码请求无效");
          const result = await input.management.invoke({ action: "candidate", id: wire.id });
          const bytes = encode(result.snapshot.candidate);
          if (bytes.length > MAX_CANDIDATE_BYTES || wire.offset > bytes.length) throw new Error("源码体积无效");
          return encode({ v: 1, ok: true, result: { digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
            bytes: bytes.subarray(wire.offset, wire.offset + CHUNK_BYTES).toString("base64"), targetDeviceId: result.targetDeviceId } });
        } else if (wire.t === "candidate") {
          assertArtifactRef(wire.ref);
          if (wire.ref.bytes < 1 || wire.ref.bytes > MAX_CANDIDATE_BYTES || typeof wire.id !== "string" || !Number.isSafeInteger(wire.revision)) throw new Error("候选传输无效");
          const status = await input.management.invoke({ action: "status" });
          const operation = status.snapshot.operations?.find(op => op.id === wire.id);
          if (!operation || operation.revision !== wire.revision || !["preparing", "blocked"].includes(operation.phase)) throw new Error("接入操作已变化");
          signal.throwIfAborted();
          if (wire.step === "probe") return encode({ v: 1, ok: true, result: await input.receiver.progress(wire.ref) });
          if (wire.step === "append") {
            if (typeof wire.bytes !== "string" || wire.bytes.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw new Error("分块超限");
            const bytes = Buffer.from(wire.bytes, "base64");
            if (bytes.toString("base64") !== wire.bytes) throw new Error("分块编码无效");
            return encode({ v: 1, ok: true, result: await input.receiver.append(wire.ref, wire.offset, bytes) });
          }
          if (wire.step !== "connect") throw new Error("未知传输动作");
          request = { action: "connect", id: wire.id, expectedRevision: wire.revision, candidate: decode(await input.artifacts.get(wire.ref)) };
        } else {
          if (wire.t !== undefined || !wire.request || Object.keys(wire).sort().join(",") !== "request,v") throw new Error("扩展管理协议无效");
          request = wire.request as ExtensionManagementRequest;
          if (["connect", "candidate"].includes(request.action)) throw new Error("候选必须经有界分块传输");
        }
        signal.throwIfAborted();
        const result = await input.management.invoke(request);
        return encode({ v: 1, ok: true, result });
      } catch { return encode({ v: 1, ok: false, error: "目标设备未接纳操作，请查询原操作状态，不要重复创建请求" }); }
    } });
}
export function createMeshExtensionManagement(client: () => MeshServiceClient): ExtensionManagementTransport {
  return { invoke: async request => {
    // Pin one target for the whole transfer; owner changes require a fresh query.
    const target = client();
    const call = async (wire: unknown) => {
      const response = decode(await target.request(SERVICE, encode(wire)));
      if (response?.v !== 1 || response.ok !== true) throw new Error(response?.error ?? "扩展管理响应无效");
      return response.result;
    };
    if (request.action === "candidate") {
      const chunks: Buffer[] = []; let offset = 0; let digest = ""; let size = 0; let targetDeviceId = "";
      do {
        const result = await call({ v: 1, t: "source", id: request.id, offset });
        if (!Number.isSafeInteger(result.size) || result.size < 1 || result.size > MAX_CANDIDATE_BYTES || typeof result.bytes !== "string" || result.bytes.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
            (offset && (digest !== result.digest || size !== result.size))) throw new Error("原版本源码在传输期间变化");
        digest = result.digest; size = result.size; targetDeviceId = result.targetDeviceId;
        const bytes = Buffer.from(result.bytes, "base64");
        if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString("base64") !== result.bytes || offset + bytes.length > size) throw new Error("源码分块无效");
        chunks.push(bytes); offset += bytes.length;
      } while (offset < size);
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("源码摘要不匹配");
      return { snapshot: { instances: [], candidate: decode(bytes) }, targetDeviceId };
    }
    if (request.action !== "connect") return call({ v: 1, request });
    const bytes = encode(request.candidate);
    if (bytes.length > MAX_CANDIDATE_BYTES) throw new Error("候选体积超限");
    const ref: ArtifactRef = { digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length };
    const envelope = { v: 1, t: "candidate", id: request.id, revision: request.expectedRevision, ref };
    let progress = validateArtifactReceiveProgress(await call({ ...envelope, step: "probe" }), ref);
    while (!progress.complete) {
      const offset = progress.receivedBytes;
      const next = validateArtifactReceiveProgress(await call({ ...envelope, step: "append", offset,
        bytes: bytes.subarray(offset, offset + CHUNK_BYTES).toString("base64") }), ref);
      if (!next.complete && next.receivedBytes <= offset) throw new Error("候选传输未取得进展");
      progress = next;
    }
    return call({ ...envelope, step: "connect" });
  } };
}
