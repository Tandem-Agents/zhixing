import { describe, expect, it, vi } from "vitest";
import type { Signature, TransferRecord } from "@zhixing/core/contracts";
import {
  canonicalize,
  createSignedConversationTransferCommand,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  ConversationTransferMeshClient,
  ConversationTransferRejectedError,
  registerConversationTransferMeshService,
} from "../conversation-transfer-mesh.js";

const TRANSFER_ID = "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV";
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

describe("conversation transfer mesh", () => {
  it("preserves structured retryability and rejects response correlation drift", async () => {
    const request = vi.fn(async (_service: string, payload: Uint8Array) => {
      const command = JSON.parse(Buffer.from(payload).toString("utf8")) as {
        requestId: string;
        transferId: string;
      };
      return Buffer.from(canonicalize({
        v: 1,
        status: "rejected",
        requestId: command.requestId,
        transferId: command.transferId,
        error: { code: "unavailable", retryable: true },
      }));
    });
    const client = new ConversationTransferMeshClient(
      { request } as never,
      signer,
      verifier,
    );

    const rejected = client.prepare(prepared());
    await expect(rejected).rejects.toBeInstanceOf(ConversationTransferRejectedError);
    await expect(rejected).rejects.toMatchObject({ retryable: true, code: "unavailable" });

    request.mockImplementationOnce(async (_service: string, payload: Uint8Array) => {
      const command = JSON.parse(Buffer.from(payload).toString("utf8")) as {
        transferId: string;
      };
      return Buffer.from(canonicalize({
        v: 1,
        status: "ok",
        requestId: "wrong-request",
        transferId: command.transferId,
        state: "prepared",
      }));
    });
    await expect(client.prepare(prepared())).rejects.toThrow(
      "does not match its originating command",
    );
  });

  it("maps a stable target conflict to a non-retryable signed-command result", async () => {
    let handler: ((payload: Uint8Array, connection: unknown, signal: AbortSignal) => Promise<Uint8Array>) | undefined;
    const registry = {
      register: vi.fn((_name: string, service: { handler: typeof handler }) => {
        handler = service.handler;
        return () => {};
      }),
    };
    registerConversationTransferMeshService(registry as never, {
      target: {
        prepare: vi.fn(async () => {
          throw new TypeError("Conversation transfer target already has this conversation");
        }),
      } as never,
      signer,
      verifier,
      clientFor: () => { throw new Error("unexpected client"); },
      authorizePeer: () => true,
    });
    const command = createSignedConversationTransferCommand({
      v: 1,
      op: "prepare",
      requestId: "request-1",
      transferId: TRANSFER_ID,
      sourceDeviceId: "device-source",
      targetDeviceId: "device-target",
      conversationId: "local-device-source-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceOwnerEpoch: 1,
      nextOwnerEpoch: 2,
    }, signer);

    const response = await handler!(
      Buffer.from(canonicalize(command)),
      { peer: { deviceId: "device-source" } },
      new AbortController().signal,
    );
    expect(JSON.parse(Buffer.from(response).toString("utf8"))).toEqual({
      v: 1,
      status: "rejected",
      requestId: "request-1",
      transferId: TRANSFER_ID,
      error: { code: "conflict", retryable: false },
    });
  });
});

function prepared(): Extract<TransferRecord, { t: "prepared" }> {
  return {
    v: 1,
    t: "prepared",
    requestId: "request-1",
    transferId: TRANSFER_ID,
    sourceDeviceId: "device-source",
    targetDeviceId: "device-target",
    conversationId: "local-device-source-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceOwnerEpoch: 1,
    nextOwnerEpoch: 2,
  };
}
