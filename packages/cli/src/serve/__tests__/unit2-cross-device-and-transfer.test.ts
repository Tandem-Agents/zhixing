import { describe, expect, it, vi } from "vitest";
import type { Signature } from "@zhixing-ai/core/contracts";
import {
  assertPrefixedUlid,
  canonicalize,
  createSignedConversationTransferCommand,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  ConversationTransferMeshClient,
  registerConversationTransferMeshService,
} from "../conversation-transfer-mesh.js";
import { deriveLocalConversationTransferAttemptIdentity } from "../local-conversation-transfer-identity.js";
import {
  executorSupportsCrossDeviceV2,
  projectConversationCapabilitiesForDevice,
} from "../workscene-runtime-projection.js";

const CONV_ID = "local-execdev1-01ARZ3NDEKTSV4RRFFQ69G5FAV";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device-source",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.sig !== signer.sign(schemaId, version, payload).sig) {
      throw new TypeError("Signature mismatch");
    }
  },
};

describe("Unit 2 cross-device capability & transfer retry identity", () => {
  it("detects cross-device v2 executor capability and preserves or strips tools accordingly", () => {
    expect(executorSupportsCrossDeviceV2({ tools: ["skill_read", "runtime_inspect"] })).toBe(true);
    expect(executorSupportsCrossDeviceV2({ tools: ["load_skill", "read"] })).toBe(false);
    expect(executorSupportsCrossDeviceV2({ tools: ["skill_read"] })).toBe(false);

    const profile = {
      tools: [
        "read",
        "skill_read",
        "skill_save",
        "skill_admit",
        "skill_materialize",
        "extension_validate",
        "runtime_inspect",
      ],
      mcpServers: [],
      providerIds: [],
    };
    const baseCapabilities = {
      tools: [
        "read",
        "skill_read",
        "skill_save",
        "skill_admit",
        "skill_materialize",
        "extension_validate",
        "runtime_inspect",
      ],
      mcpServers: [],
    };
    const v2Projection = projectConversationCapabilitiesForDevice({
      profile,
      ownerDeviceId: "anchor-1",
      executorDeviceId: "exec-v2",
      supportsCrossDeviceV2: true,
      capabilities: baseCapabilities,
    });
    expect(v2Projection.tools).toEqual(
      expect.arrayContaining([
        "skill_read",
        "skill_save",
        "skill_admit",
        "skill_materialize",
        "extension_validate",
        "runtime_inspect",
      ]),
    );

    const v1Projection = projectConversationCapabilitiesForDevice({
      profile,
      ownerDeviceId: "anchor-1",
      executorDeviceId: "exec-v1",
      supportsCrossDeviceV2: false,
      capabilities: baseCapabilities,
    });
    expect(v1Projection.tools).toEqual(["load_skill", "read"]);
  });

  it("probes { v: 2, op: capabilities }, returns false only on legacy protocol rejections, and rethrows network errors", async () => {
    let handler: ((payload: Uint8Array, connection: unknown, signal: AbortSignal) => Promise<Uint8Array>) | undefined;
    const registry = {
      register: vi.fn((_name: string, service: { handler: typeof handler }) => {
        handler = service.handler;
        return () => {};
      }),
    };
    registerConversationTransferMeshService(registry as never, {
      target: {} as never,
      signer,
      verifier,
      authorizePeer: () => true,
    });

    const v2Client = new ConversationTransferMeshClient(
      {
        request: async (_service: string, payload: Uint8Array) =>
          await handler!(payload, { peer: { deviceId: "exec-1" } }, new AbortController().signal),
      } as never,
      signer,
      verifier,
    );
    await expect(v2Client.supportsV2InputSources()).resolves.toBe(true);

    const legacyClient = new ConversationTransferMeshClient(
      {
        request: vi.fn(async () => {
          throw new Error("Conversation transfer command version is invalid");
        }),
      } as never,
      signer,
      verifier,
    );
    await expect(legacyClient.supportsV2InputSources()).resolves.toBe(false);

    const networkFailureClient = new ConversationTransferMeshClient(
      {
        request: vi.fn(async () => {
          throw new Error("Mesh transport disconnected");
        }),
      } as never,
      signer,
      verifier,
    );
    await expect(networkFailureClient.supportsV2InputSources()).rejects.toThrow(
      "Mesh transport disconnected",
    );

    const { MeshProtocolError } = await import("@zhixing-ai/mesh/errors");
    const wireLegacyClient = new ConversationTransferMeshClient(
      {
        request: vi.fn(async () => {
          throw new MeshProtocolError("service-failed", "Mesh service failed");
        }),
      } as never,
      signer,
      verifier,
    );
    await expect(wireLegacyClient.supportsV2InputSources()).resolves.toBe(false);

    const wireClosedClient = new ConversationTransferMeshClient(
      {
        request: vi.fn(async () => {
          throw new MeshProtocolError("connection-closed", "Mesh request channel is closed");
        }),
      } as never,
      signer,
      verifier,
    );
    await expect(wireClosedClient.supportsV2InputSources()).rejects.toMatchObject({
      code: "connection-closed",
    });

    const malformedPayloadClient = new ConversationTransferMeshClient(
      {
        request: vi.fn(async () => Buffer.from(canonicalize({ v: 1, status: "ok" }), "utf8")),
      } as never,
      signer,
      verifier,
    );
    await expect(malformedPayloadClient.supportsV2InputSources()).resolves.toBe(false);
  });

  it("derives deterministic transferIds across initial, aborted-retry, resume, and completed states", () => {
    const initial = deriveLocalConversationTransferAttemptIdentity({
      conversationId: CONV_ID,
      sourceDeviceId: "exec-1",
      targetDeviceId: "anchor-1",
      sourceOwnerEpoch: 1,
      states: [],
    });
    expect(initial?.kind).toBe("new");
    if (initial?.kind !== "new") throw new Error("Expected new attempt");
    expect(initial.attempt.transferId).toBe("xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(initial.attempt.requestId).toBe(`adopt:${CONV_ID}`);

    const retryA = deriveLocalConversationTransferAttemptIdentity({
      conversationId: CONV_ID,
      sourceDeviceId: "exec-1",
      targetDeviceId: "anchor-1",
      sourceOwnerEpoch: 1,
      states: [
        {
          phase: "aborted",
          identity: {
            transferId: initial.attempt.transferId,
            requestId: initial.attempt.requestId,
            conversationId: CONV_ID,
            targetDeviceId: "anchor-1",
          },
        },
      ],
    });
    const retryB = deriveLocalConversationTransferAttemptIdentity({
      conversationId: CONV_ID,
      sourceDeviceId: "exec-1",
      targetDeviceId: "anchor-1",
      sourceOwnerEpoch: 1,
      states: [
        {
          phase: "aborted",
          identity: {
            transferId: initial.attempt.transferId,
            requestId: initial.attempt.requestId,
            conversationId: CONV_ID,
            targetDeviceId: "anchor-1",
          },
        },
      ],
    });
    expect(retryA?.kind).toBe("new");
    if (retryA?.kind !== "new" || retryB?.kind !== "new") throw new Error("Expected retry attempt");
    expect(retryA.attempt.transferId).toMatch(/^xfer-[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(retryA.attempt.transferId).not.toBe(initial.attempt.transferId);
    expect(() =>
      assertPrefixedUlid(retryA.attempt.transferId, "xfer-", "retry transferId"),
    ).not.toThrow();
    const { t: _omitTag, ...prepareWireFields } = retryA.attempt.prepared({
      deviceId: "exec-1",
      ownerEpoch: 1,
    });
    expect(() =>
      createSignedConversationTransferCommand(
        { op: "prepare", ...prepareWireFields },
        signer,
      ),
    ).not.toThrow();
    expect(retryA.attempt.requestId).toMatch(new RegExp(`^adopt:${CONV_ID}:r2:[0-9a-f]{12}$`, "u"));
    expect(retryA.attempt.transferId).toBe(retryB.attempt.transferId);
    expect(retryA.attempt.requestId).toBe(retryB.attempt.requestId);

    const resumed = deriveLocalConversationTransferAttemptIdentity({
      conversationId: CONV_ID,
      sourceDeviceId: "exec-1",
      targetDeviceId: "anchor-1",
      sourceOwnerEpoch: 1,
      states: [
        {
          phase: "aborted",
          identity: {
            transferId: initial.attempt.transferId,
            requestId: initial.attempt.requestId,
            conversationId: CONV_ID,
            targetDeviceId: "anchor-1",
          },
        },
        {
          phase: "prepared",
          identity: {
            transferId: retryA.attempt.transferId,
            requestId: retryA.attempt.requestId,
            conversationId: CONV_ID,
            targetDeviceId: "anchor-1",
          },
        },
      ],
    });
    expect(resumed?.kind).toBe("resume");
    if (resumed?.kind !== "resume") throw new Error("Expected resume attempt");
    expect(resumed.attempt.transferId).toBe(retryA.attempt.transferId);

    const completed = deriveLocalConversationTransferAttemptIdentity({
      conversationId: CONV_ID,
      sourceDeviceId: "exec-1",
      targetDeviceId: "anchor-1",
      sourceOwnerEpoch: 1,
      states: [
        {
          phase: "committed",
          identity: {
            transferId: retryA.attempt.transferId,
            requestId: retryA.attempt.requestId,
            conversationId: CONV_ID,
            targetDeviceId: "anchor-1",
          },
        },
      ],
    });
    expect(completed?.kind).toBe("completed");
  });
});
