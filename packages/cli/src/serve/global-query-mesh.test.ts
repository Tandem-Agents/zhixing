import type {
  AuthorityCapability,
  GlobalReadResult,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import {
  canonicalize,
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
import { createAssignmentGlobalQueryPort } from "./assignment-schedule-stager.js";
import {
  MeshAssignmentGlobalQueryPort,
  registerGlobalQueryMeshService,
} from "./global-query-mesh.js";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "anchor-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    expect(signature).toEqual(this.sign(schemaId, version, payload));
  },
};

describe("GlobalQuery mesh strict boundary", () => {
  it("uses the same public query/result predicate for the local topology", async () => {
    const read = vi.fn(async () => ({
      kind: "workscene-get" as const,
      scene: {
        id: "scene-2",
        revision: 1,
        name: "wrong",
        createdAt: "2026-08-05T00:00:00.000Z",
        lastActiveAt: "2026-08-05T00:00:00.000Z",
      },
    }));
    const port = createAssignmentGlobalQueryPort({
      state: { read } as unknown as GlobalStatePort,
      capability: capability(),
      anchorEpoch: 1,
    });
    await expect(port.read({ kind: "workscene-get", sceneId: "scene-1" }))
      .rejects.toThrow(/bound/u);

    const accessorQuery = Object.defineProperty({}, "kind", {
      enumerable: true,
      get: () => "workscene-list",
    });
    await expect(port.read(accessorQuery as never)).rejects.toThrow(/accessor/u);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("uses the public query/result predicate before server encode and after client decode", async () => {
    const valid = meshPort(async () => ({ kind: "workscene-get", scene: null }));
    await expect(valid.read({ kind: "workscene-get", sceneId: "scene-1" }))
      .resolves.toEqual({ kind: "workscene-get", scene: null });

    const wrongServerIdentity = meshPort(async () => ({
      kind: "workscene-get",
      scene: {
        id: "scene-2",
        revision: 1,
        name: "wrong",
        createdAt: "2026-08-05T00:00:00.000Z",
        lastActiveAt: "2026-08-05T00:00:00.000Z",
      },
    }));
    await expect(wrongServerIdentity.read({ kind: "workscene-get", sceneId: "scene-1" }))
      .rejects.toThrow(/bound/u);

    const maliciousClient: MeshServiceClient = {
      async request() {
        return Buffer.from(canonicalize({
          kind: "workscene-get",
          scene: {
            id: "scene-1",
            revision: 1,
            name: "leak",
            createdAt: "2026-08-05T00:00:00.000Z",
            lastActiveAt: "2026-08-05T00:00:00.000Z",
            path: "C:\\secret",
          },
        }), "utf8");
      },
    };
    await expect(
      new MeshAssignmentGlobalQueryPort(maliciousClient, capability(), 1)
        .read({ kind: "workscene-get", sceneId: "scene-1" }),
    ).rejects.toThrow(/fields/u);
  });
});

function meshPort(
  read: (query: Parameters<GlobalStatePort["read"]>[0]) => Promise<GlobalReadResult>,
): MeshAssignmentGlobalQueryPort {
  let definition: MeshServiceDefinition | undefined;
  const registry = {
    register(serviceId: string, next: MeshServiceDefinition) {
      expect(serviceId).toBe("authority.global.read");
      definition = next;
      return () => {};
    },
  } as MeshServiceRegistry;
  registerGlobalQueryMeshService(
    registry,
    { read } as unknown as GlobalStatePort,
    identity,
    (deviceId) => deviceId === "executor-device" ? "executor-a" : undefined,
  );
  const peer = {
    peer: { deviceId: "executor-device", publicKey: "test-key" },
  } as unknown as SecureMeshConnection;
  const client: MeshServiceClient = {
    request(_serviceId, payload, signal) {
      return definition!.handler(
        payload,
        peer,
        signal ?? new AbortController().signal,
      );
    },
  };
  return new MeshAssignmentGlobalQueryPort(client, capability(), 1);
}

function capability(): AuthorityCapability<"conversation"> {
  const payload = {
    v: 1 as const,
    capId: "cap-a",
    executorId: "executor-a",
    scope: { execution: "conversation" as const, conversationId: "conversation-a" },
    ownerEpoch: 1,
    methods: ["global.read" as const],
    resources: ["conversation:conversation-a" as const],
    assignmentId: "assignment-a",
    issuedAt: "2099-01-01T00:00:00.000Z",
    expiry: "2099-01-01T00:05:00.000Z",
  };
  return {
    ...payload,
    signature: identity.sign("AuthorityCapability", 1, payload),
  };
}
