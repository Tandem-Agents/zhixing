import type {
  ImmediateRootResourceLease,
  ResourceLease,
  WorkspaceProbeRequest,
} from "@zhixing/core/contracts";
import type { WorkspaceProbePort } from "@zhixing/core/environment";
import {
  createSignedEnvironmentControlGrant,
  createSignedWorkspaceProbeResult,
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
import {
  EnvironmentProbeMeshClient,
  registerEnvironmentProbeMeshService,
} from "./environment-probe-mesh.js";

const NOW = "2026-07-30T00:00:00.000Z";
const EXPIRY = "2026-07-30T00:05:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
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

describe("environment probe adapters", () => {
  it.each(["in-process", "mesh"] as const)(
    "uses the same path-free request and signed result contract through %s",
    async (adapter) => {
      const request = probeRequest();
      const probe = vi.fn(async () =>
        createSignedWorkspaceProbeResult(
          {
            v: 1,
            requestId: request.requestId,
            bindingRef: request.bindingRef,
            workspaceBindingRevision: 3,
            probe: "directory",
            executorId: "executor-a",
          },
          identity,
        ),
      );
      const port: WorkspaceProbePort =
        adapter === "in-process"
          ? { probe }
          : meshPort({ probe });

      const abort = new AbortController().signal;
      await expect(port.probe(request, abort)).resolves.toMatchObject({
        requestId: "probe-a",
        bindingRef: "workspace-a",
        workspaceBindingRevision: 3,
        probe: "directory",
        executorId: "executor-a",
      });
      expect(probe).toHaveBeenCalledWith(
        request,
        abort,
      );
      expect(JSON.stringify(request)).not.toMatch(/[A-Z]:\\\\|absolutePath/iu);
    },
  );
});

function meshPort(probe: WorkspaceProbePort): WorkspaceProbePort {
  let definition: MeshServiceDefinition | undefined;
  const registry = {
    register(serviceId: string, next: MeshServiceDefinition) {
      expect(serviceId).toBe("environment.probe");
      definition = next;
      return () => {};
    },
  } as MeshServiceRegistry;
  registerEnvironmentProbeMeshService(
    registry,
    probe,
    identity,
    (deviceId) => deviceId === "owner-a",
  );
  const owner = connection("owner-a");
  const intruder = connection("intruder");
  expect(definition?.authorize?.(owner)).toBe(true);
  expect(definition?.authorize?.(intruder)).toBe(false);
  const client: MeshServiceClient = {
    request(serviceId, payload, signal) {
      expect(serviceId).toBe("environment.probe");
      return definition!.handler(
        payload,
        owner,
        signal ?? new AbortController().signal,
      );
    },
  };
  return new EnvironmentProbeMeshClient(client, identity);
}

function probeRequest(): WorkspaceProbeRequest {
  const lease = immediateLease("probe-a");
  const grant = createSignedEnvironmentControlGrant(
    {
      v: 1,
      grantId: "environment-grant-a",
      deviceId: "device-a",
      bindingRef: "workspace-a",
      methods: ["environment.probe"],
      requestId: "probe-a",
      resourceLeaseDigest: lease.digest,
      issuedAt: NOW,
      expiry: EXPIRY,
    },
    identity,
  );
  return {
    v: 1,
    requestId: "probe-a",
    deviceId: "device-a",
    bindingRef: "workspace-a",
    grant,
    resourceLease: lease,
    at: NOW,
  };
}

function immediateLease(requestId: string): ImmediateRootResourceLease {
  const payload: Omit<ResourceLease, "digest" | "signature"> = {
    v: 1,
    reservationId: `reservation-${requestId}`,
    admissionClass: "interactive",
    workload: { kind: "control", id: requestId, attempt: 1 },
    scopeBinding: { kind: "control", subject: requestId },
    audience: { executorId: "executor-a" },
    budget: { maxCalls: 1 },
    domain: { kind: "local", localDomainId: "device-a", localGovernorEpoch: 1 },
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
  } as ImmediateRootResourceLease;
}

function connection(deviceId: string): SecureMeshConnection {
  return {
    peer: { deviceId, publicKey: "test-public-key" },
  } as unknown as SecureMeshConnection;
}
