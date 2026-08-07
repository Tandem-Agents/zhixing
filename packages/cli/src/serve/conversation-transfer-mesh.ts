import type {
  ArtifactRef,
  ConversationTransferAbort,
  ConversationTransferCommit,
  ConversationTransferResult,
  TransferRecord,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  createSignedConversationTransferCommand,
  protocolDigest,
  validateConversationTransferCommand,
  validateConversationTransferResult,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  ConversationTransferSource,
  ConversationTransferTarget,
  type ConversationTransferReadPort,
  type FrozenConversationTransfer,
} from "@zhixing/owner-kernel";

export const CONVERSATION_TRANSFER_MESH_SERVICE = "conversation.transfer";

export class ConversationTransferMeshClient {
  readonly readPort: ConversationTransferReadPort;

  constructor(
    private readonly client: MeshServiceClient,
    private readonly signer: ProtocolSigner,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {
    this.readPort = Object.freeze({
      probe: async (input: Parameters<ConversationTransferReadPort["probe"]>[0]) => {
        const result = await this.#request({
          v: 1,
          op: "probe",
          requestId: requestId(input.transferId, `probe:${input.ref.digest}`),
          transferId: input.transferId,
          ref: input.ref,
        });
        return result.status === "ok";
      },
      readRange: async (
        input: Parameters<ConversationTransferReadPort["readRange"]>[0],
      ) => {
        const result = await this.#request({
          v: 1,
          op: "read-range",
          requestId: requestId(
            input.transferId,
            `range:${input.ref.digest}:${input.offset}:${input.length}`,
          ),
          transferId: input.transferId,
          ref: input.ref,
          offset: input.offset,
          length: input.length,
        });
        if (
          result.status !== "range" ||
          result.offset !== input.offset ||
          canonicalize(result.ref) !== canonicalize(input.ref)
        ) {
          throw new Error("Conversation transfer range response is incomplete");
        }
        return Buffer.from(result.data, "base64");
      },
    });
  }

  async prepare(record: Extract<TransferRecord, { t: "prepared" }>): Promise<void> {
    const result = await this.#request({
      v: 1,
      op: "prepare",
      requestId: record.requestId,
      transferId: record.transferId,
      sourceDeviceId: record.sourceDeviceId,
      targetDeviceId: record.targetDeviceId,
      conversationId: record.conversationId,
      sourceOwnerEpoch: record.sourceOwnerEpoch,
      nextOwnerEpoch: record.nextOwnerEpoch,
    });
    assertOk(result, "prepared");
  }

  async importAndCommit(frozen: FrozenConversationTransfer): Promise<ConversationTransferCommit> {
    const result = await this.#request({
      v: 1,
      op: "freeze",
      requestId: frozen.manifest.requestId,
      transferId: frozen.manifest.transferId,
      manifest: frozen.manifestRef,
      proof: frozen.proof,
    });
    assertOk(result, "committed");
    if (!result.commit) throw new Error("Conversation transfer commit response is missing");
    return result.commit;
  }

  async abort(abort: ConversationTransferAbort): Promise<void> {
    const result = await this.#request({
      v: 1,
      op: "abort",
      requestId: abort.requestId,
      transferId: abort.transferId,
      abort,
    });
    assertOk(result, "aborted");
  }

  async #request(
    command: Parameters<typeof createSignedConversationTransferCommand>[0],
  ): Promise<ConversationTransferResult> {
    const response = await this.client.request(
      CONVERSATION_TRANSFER_MESH_SERVICE,
      encode(createSignedConversationTransferCommand(command, this.signer)),
    );
    const result = validateConversationTransferResult(decode(response), this.verifier);
    if (result.status === "rejected") {
      throw new Error(`Conversation transfer ${result.error.code}`);
    }
    return result;
  }
}

export function registerConversationTransferMeshService(
  registry: MeshServiceRegistry,
  options: {
    readonly source?: ConversationTransferSource;
    readonly target?: ConversationTransferTarget;
    readonly signer: ProtocolSigner;
    readonly verifier: ProtocolSignatureVerifier;
    readonly clientFor: (deviceId: string) => MeshServiceClient;
    readonly authorizePeer: (deviceId: string) => boolean;
    readonly afterCommit?: (input: Awaited<ReturnType<ConversationTransferTarget["committedBase"]>>) => Promise<void>;
  },
): () => void {
  return registry.register(CONVERSATION_TRANSFER_MESH_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => options.authorizePeer(connection.peer.deviceId),
    handler: async (payload, connection) => {
      const command = validateConversationTransferCommand(
        decode(payload),
        options.verifier,
      );
      if (command.op === "probe" || command.op === "read-range") {
        if (!options.source) throw new Error("Conversation transfer source is unavailable");
        if (command.op === "probe") {
          const exists = await options.source.readPort.probe({
            transferId: command.transferId,
            targetDeviceId: connection.peer.deviceId,
            ref: command.ref,
          });
          if (!exists) return encode(rejected(command, "not-found", false));
          return encode(ok(command, "frozen", command.ref));
        }
        const bytes = await options.source.readPort.readRange({
          transferId: command.transferId,
          targetDeviceId: connection.peer.deviceId,
          ref: command.ref,
          offset: command.offset,
          length: command.length,
        });
        return encode({
          v: 1,
          status: "range",
          requestId: command.requestId,
          transferId: command.transferId,
          ref: command.ref,
          offset: command.offset,
          data: Buffer.from(bytes).toString("base64"),
        } satisfies ConversationTransferResult);
      }
      if (!options.target) throw new Error("Conversation transfer target is unavailable");
      if (command.op === "prepare") {
        if (command.sourceDeviceId !== connection.peer.deviceId) {
          throw new TypeError("Conversation transfer peer does not match source device");
        }
        await options.target.prepare({
          v: 1,
          t: "prepared",
          requestId: command.requestId,
          transferId: command.transferId,
          sourceDeviceId: command.sourceDeviceId,
          targetDeviceId: command.targetDeviceId,
          conversationId: command.conversationId,
          sourceOwnerEpoch: command.sourceOwnerEpoch,
          nextOwnerEpoch: command.nextOwnerEpoch,
        });
        return encode(ok(command, "prepared"));
      }
      const state = await options.target.state(command.transferId);
      if (!state || state.identity.sourceDeviceId !== connection.peer.deviceId) {
        throw new TypeError("Conversation transfer peer does not own this transfer");
      }
      if (command.op === "freeze") {
        if (state.phase !== "committed" && state.phase !== "tombstoned") {
          const source = new ConversationTransferMeshClient(
            options.clientFor(connection.peer.deviceId),
            options.signer,
            options.verifier,
          );
          await options.target.import({
            transferId: command.transferId,
            manifestRef: command.manifest,
            proof: command.proof,
            source: source.readPort,
          });
        }
        const committed = await options.target.commit(command.transferId);
        await options.afterCommit?.(
          await options.target.committedBase(command.transferId),
        );
        return encode(ok(command, "committed", undefined, committed.commit));
      }
      if (command.op === "abort") {
        await options.target.recordAbort(command.abort);
        await options.target.cleanupAborted(command.transferId);
        return encode(ok(command, "aborted"));
      }
      if (command.op === "status") {
        return encode(ok(command, state.phase, state.manifest, state.commit));
      }
      throw new TypeError(`Conversation transfer operation is not valid on the target: ${command.op}`);
    },
  });
}

function ok(
  command: { readonly requestId: string; readonly transferId: string },
  state: Extract<ConversationTransferResult, { status: "ok" }>['state'],
  ref?: ArtifactRef,
  commit?: ConversationTransferCommit,
): ConversationTransferResult {
  return {
    v: 1,
    status: "ok",
    requestId: command.requestId,
    transferId: command.transferId,
    state,
    ...(ref ? { ref } : {}),
    ...(commit ? { commit } : {}),
  };
}

function rejected(
  command: { readonly requestId: string; readonly transferId: string },
  code: Extract<ConversationTransferResult, { status: "rejected" }>['error']['code'],
  retryable: boolean,
): ConversationTransferResult {
  return {
    v: 1,
    status: "rejected",
    requestId: command.requestId,
    transferId: command.transferId,
    error: { code, retryable },
  };
}

function assertOk(
  result: ConversationTransferResult,
  state: Extract<ConversationTransferResult, { status: "ok" }>['state'],
): asserts result is Extract<ConversationTransferResult, { status: "ok" }> {
  if (result.status !== "ok" || result.state !== state) {
    throw new Error(`Conversation transfer did not reach ${state}`);
  }
}

function requestId(transferId: string, suffix: string): string {
  return `xfer-read:${protocolDigest("ConversationTransferRead", 1, {
    transferId,
    suffix,
  }).slice("sha256:".length)}`;
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function decode(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) throw new TypeError("Conversation transfer payload is not canonical");
  return value;
}
