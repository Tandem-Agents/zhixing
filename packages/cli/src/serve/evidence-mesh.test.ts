import type {
  EvidenceHandlerPort,
  EvidenceRequest,
  ResourceLease,
  Signature,
} from "@zhixing/core/contracts";
import {
  createSignedEvidenceBundle,
  createSignedEvidenceRequest,
  evidenceRequestDigest,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { SecureMeshConnection } from "@zhixing/mesh";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type {
  MeshServiceDefinition,
  MeshServiceRegistry,
} from "@zhixing/mesh/service-registry";
import { describe, expect, it, vi } from "vitest";
import { EvidenceMeshClient, registerEvidenceMeshService } from "./evidence-mesh.js";

const NOW = "2026-08-03T00:00:00.000Z";
const EXPIRY = "2026-08-03T01:00:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-digest",
      keyId: "device-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

describe("evidence adapters", () => {
  it.each(["in-process", "mesh"] as const)(
    "uses the same signed request and result contract through %s",
    async (adapter) => {
      const input = request();
      const result = {
        kind: "bundle" as const,
        bundle: createSignedEvidenceBundle(
          {
            v: 1,
            requestId: input.requestId,
            requestDigest: evidenceRequestDigest(input),
            observation: {
              observedAt: NOW,
              preStateFingerprint: `sha256:${"a".repeat(64)}`,
              postStateFingerprint: `sha256:${"a".repeat(64)}`,
              consistent: true,
            },
            items: [{
              kind: "log",
              locator: { paths: ["logs/run.log"] },
              contentDigest: `sha256:${"b".repeat(64)}`,
              summary: "passed",
              source: "independent",
            }],
            executorId: "executor-a",
          },
          identity,
        ),
      };
      const collect = vi.fn(async () => result);
      const handler: EvidenceHandlerPort = { collect };
      const port = adapter === "in-process" ? handler : meshPort(handler);
      const abort = new AbortController().signal;

      await expect(port.collect(input, abort)).resolves.toEqual(result);
      expect(collect).toHaveBeenCalledWith(input, abort);
    },
  );

  it("rejects non-canonical mesh responses", async () => {
    const client: MeshServiceClient = {
      request: async () => Buffer.from('{ "kind": "capability-gap" }', "utf8"),
    };
    await expect(
      new EvidenceMeshClient(client, identity).collect(
        request(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("not canonical");
  });
});

function meshPort(handler: EvidenceHandlerPort): EvidenceHandlerPort {
  let definition: MeshServiceDefinition | undefined;
  const registry = {
    register(serviceId: string, next: MeshServiceDefinition) {
      expect(serviceId).toBe("advancement.evidence.collect");
      definition = next;
      return () => {};
    },
  } as MeshServiceRegistry;
  registerEvidenceMeshService(
    registry,
    handler,
    identity,
    (deviceId) => deviceId === "owner-a",
  );
  const owner = connection("owner-a");
  expect(definition?.authorize?.(owner)).toBe(true);
  expect(definition?.authorize?.(connection("intruder"))).toBe(false);
  const client: MeshServiceClient = {
    request(serviceId, payload, signal) {
      expect(serviceId).toBe("advancement.evidence.collect");
      return definition!.handler(
        payload,
        owner,
        signal ?? new AbortController().signal,
      );
    },
  };
  return new EvidenceMeshClient(client, identity);
}

function request(): EvidenceRequest {
  return createSignedEvidenceRequest(
    {
      v: 1,
      requestId: "request-a",
      reviewId: "review-a",
      runId: "run-a",
      conversationId: "conversation-a",
      ownerEpoch: 3,
      executorId: "executor-a",
      workspace: { bindingRef: "workspace-a", workspaceBindingRevision: 7 },
      items: [{ kind: "log", locator: { paths: ["logs/run.log"] } }],
      lease: childLease(),
      issuedAt: NOW,
      expiry: EXPIRY,
    },
    identity,
    identity,
  );
}

function childLease(): ResourceLease {
  const payload = {
    v: 1 as const,
    reservationId: "evidence-lease-a",
    parentId: "review-lease-a",
    parentDigest: protocolDigest("ResourceLease", 1, { id: "review-lease-a" }),
    admissionClass: "advancement" as const,
    workload: { kind: "evidence" as const, id: "request-a", attempt: 1 },
    scopeBinding: {
      kind: "conversation" as const,
      conversationId: "conversation-a",
      ownerEpoch: 3,
    },
    audience: { executorId: "executor-a" },
    budget: { maxCalls: 1 },
    domain: { kind: "anchor" as const, anchorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: identity.sign("ResourceLease", 1, withDigest),
  };
}

function connection(deviceId: string): SecureMeshConnection {
  return {
    peer: { deviceId, publicKey: "test-public-key" },
  } as unknown as SecureMeshConnection;
}
