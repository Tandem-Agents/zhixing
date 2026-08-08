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

type OkTransferState = Extract<ConversationTransferResult, { status: "ok" }>['state'];
type OkTransferResult<S extends OkTransferState = OkTransferState> =
  ConversationTransferResult & { readonly status: "ok"; readonly state: S };

export class ConversationTransferRejectedError extends Error {
  readonly code: Extract<ConversationTransferResult, { status: "rejected" }>['error']['code'];
  readonly retryable: boolean;

  constructor(error: Extract<ConversationTransferResult, { status: "rejected" }>['error']) {
    super(`Conversation transfer ${error.code}`);
    this.name = "ConversationTransferRejectedError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

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
        if (
          result.status !== "ok" ||
          result.state !== "frozen" ||
          !sameRef(result.ref, input.ref)
        ) {
          throw new Error("Conversation transfer probe response is not bound to the requested ref");
        }
        return true;
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
        const bytes = Buffer.from(result.data, "base64");
        const expected = Math.min(input.length, input.ref.bytes - input.offset);
        if (bytes.byteLength !== expected) {
          throw new Error("Conversation transfer range response length does not match the request");
        }
        return bytes;
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
    expectOkState(result, "prepared");
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
    const committed = expectOkState(result, "committed");
    assertCommitMatchesFrozen(committed.commit, frozen);
    return committed.commit;
  }

  async abort(abort: ConversationTransferAbort): Promise<ConversationTransferAbort> {
    const result = await this.#request({
      v: 1,
      op: "abort",
      requestId: abort.requestId,
      transferId: abort.transferId,
      abort,
    });
    const aborted = expectOkState(result, "aborted");
    if (canonicalize(aborted.abort) !== canonicalize(abort)) {
      throw new Error("Conversation transfer abort response does not match the request");
    }
    return aborted.abort;
  }

  async status(transferId: string): Promise<Extract<ConversationTransferResult, { status: "ok" }>> {
    const result = await this.#request({
      v: 1,
      op: "status",
      requestId: requestId(transferId, "status"),
      transferId,
    });
    if (result.status !== "ok") {
      throw new Error("Conversation transfer status response is invalid");
    }
    return result;
  }

  async #request(
    command: Parameters<typeof createSignedConversationTransferCommand>[0],
  ): Promise<ConversationTransferResult> {
    const response = await this.client.request(
      CONVERSATION_TRANSFER_MESH_SERVICE,
      encode(createSignedConversationTransferCommand(command, this.signer)),
    );
    const result = validateConversationTransferResult(decode(response), this.verifier);
    if (result.requestId !== command.requestId || result.transferId !== command.transferId) {
      throw new Error("Conversation transfer response does not match its originating command");
    }
    if (result.status === "rejected") {
      throw new ConversationTransferRejectedError(result.error);
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
    readonly onBackgroundError?: (error: Error) => void;
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
      try {
        if (command.op === "probe" || command.op === "read-range") {
          if (!options.source) {
            throw new Error("Conversation transfer source is unavailable");
          }
          if (command.op === "probe") {
            const exists = await options.source.readPort.probe({
              transferId: command.transferId,
              targetDeviceId: connection.peer.deviceId,
              ref: command.ref,
            });
            if (!exists) return encode(rejected(command, "not-found", false));
            return encode(okFrozen(command, command.ref));
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

        if (!options.target) {
          throw new Error("Conversation transfer target is unavailable");
        }
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
          return encode(okPrepared(command));
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
          if (options.afterCommit) {
            void options.target.committedBase(command.transferId)
              .then((base) => options.afterCommit!(base))
              .catch((error: unknown) =>
                options.onBackgroundError?.(
                  error instanceof Error ? error : new Error(String(error)),
                ),
              );
          }
          return encode(okCommitted(command, committed.commit));
        }
        if (command.op === "abort") {
          await options.target.recordAbort(command.abort);
          await options.target.cleanupAborted(command.transferId);
          const aborted = await options.target.state(command.transferId);
          if (aborted?.phase !== "aborted" || !aborted.abort) {
            throw new Error("Conversation transfer abort was not durably recorded");
          }
          return encode(okAborted(command, aborted.abort));
        }
        if (command.op === "status") {
          return encode(okForState(command, state));
        }
        throw new TypeError(`Conversation transfer operation is not valid on the target: ${command.op}`);
      } catch (error) {
        return encode(rejectedForError(command, error));
      }
    },
  });
}

function rejectedForError(
  command: { readonly requestId: string; readonly transferId: string },
  error: unknown,
): ConversationTransferResult {
  const message = error instanceof Error ? error.message : "";
  if (/peer|authorize|authenticated/iu.test(message)) {
    return rejected(command, "unauthorized", false);
  }
  if (/unavailable|not ready|closing|cancel/iu.test(message)) {
    return rejected(command, "unavailable", true);
  }
  if (error instanceof TypeError) {
    return rejected(command, "conflict", false);
  }
  return rejected(command, "unavailable", true);
}

function okPrepared(
  command: { readonly requestId: string; readonly transferId: string },
): OkTransferResult<"prepared"> {
  return {
    v: 1,
    status: "ok",
    requestId: command.requestId,
    transferId: command.transferId,
    state: "prepared",
  };
}

function okFrozen(
  command: { readonly requestId: string; readonly transferId: string },
  ref: ArtifactRef,
): OkTransferResult<"frozen"> {
  return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: "frozen", ref };
}

function okCommitted(
  command: { readonly requestId: string; readonly transferId: string },
  commit: ConversationTransferCommit,
): OkTransferResult<"committed"> {
  return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: "committed", commit };
}

function okAborted(
  command: { readonly requestId: string; readonly transferId: string },
  abort: ConversationTransferAbort,
): OkTransferResult<"aborted"> {
  return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: "aborted", abort };
}

function okForState(
  command: { readonly requestId: string; readonly transferId: string },
  state: NonNullable<Awaited<ReturnType<ConversationTransferTarget["state"]>>>,
): OkTransferResult {
  if (state.phase === "prepared") return okPrepared(command);
  if (state.phase === "frozen" || state.phase === "imported") {
    if (!state.manifest) throw new Error("Conversation transfer state is missing its manifest");
    return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: state.phase, ref: state.manifest };
  }
  if (state.phase === "committed" || state.phase === "tombstoned") {
    if (!state.commit) throw new Error("Conversation transfer state is missing its commit");
    return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: state.phase, commit: state.commit };
  }
  if (!state.abort) throw new Error("Conversation transfer state is missing its abort");
  return okAborted(command, state.abort);
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

function expectOkState<S extends OkTransferState>(
  result: ConversationTransferResult,
  state: S,
): OkTransferResult<S> {
  if (result.status !== "ok" || result.state !== state) {
    throw new Error(`Conversation transfer did not reach ${state}`);
  }
  return result as OkTransferResult<S>;
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.digest === right.digest && left.bytes === right.bytes;
}

function assertCommitMatchesFrozen(
  commit: ConversationTransferCommit,
  frozen: FrozenConversationTransfer,
): void {
  const manifest = frozen.manifest;
  if (
    commit.transferId !== manifest.transferId ||
    commit.conversationId !== manifest.conversationId ||
    commit.sourceDeviceId !== manifest.sourceDeviceId ||
    commit.targetDeviceId !== manifest.targetDeviceId ||
    commit.sourceOwnerEpoch !== manifest.sourceOwnerEpoch ||
    commit.nextOwnerEpoch !== manifest.nextOwnerEpoch ||
    commit.checkpointDigest !== frozen.manifestRef.digest
  ) {
    throw new Error("Conversation transfer commit response does not match the frozen transfer");
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
