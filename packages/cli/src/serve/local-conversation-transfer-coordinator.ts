import type { AuthorityCommitLog } from "@zhixing-ai/core/authority";
import type {
  ConversationTransferAbort,
  ConversationTransferCommit,
  ConversationTransferResult,
  TransferRecord,
} from "@zhixing-ai/core/contracts";
import type {
  ConversationTransferState,
  ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import {
  ConversationTransferIncompatibleTargetError,
  ConversationTransferSource,
  listConversationTransfersFor,
  readConversationTransferState,
  type FrozenConversationTransfer,
} from "@zhixing-ai/owner-kernel/conversation-transfer";
import { ConversationTransferRejectedError } from "./conversation-transfer-mesh.js";
import { deriveLocalConversationTransferAttemptIdentity } from "./local-conversation-transfer-identity.js";

export type LocalTransferStatusResult = Extract<ConversationTransferResult, { status: "ok" }>;

export interface LocalConversationTransferClient {
  status(transferId: string): Promise<LocalTransferStatusResult>;
  prepare(record: Extract<TransferRecord, { t: "prepared" }>): Promise<void>;
  importAndCommit(frozen: FrozenConversationTransfer): Promise<ConversationTransferCommit>;
  abort(abort: ConversationTransferAbort): Promise<ConversationTransferAbort>;
}

export interface LocalConversationTransferIdentity {
  readonly deviceId: string;
  readonly ownerEpoch: number;
}

export async function queryTransferTargetStatusIfKnown(
  client: Pick<LocalConversationTransferClient, "status">,
  transferId: string,
): Promise<LocalTransferStatusResult | undefined> {
  try {
    return await client.status(transferId);
  } catch (error) {
    if (error instanceof ConversationTransferRejectedError) {
      return undefined;
    }
    throw error;
  }
}

export async function adoptLocalConversation(input: {
  readonly conversationId: string;
  readonly targetDeviceId: string;
  readonly identity: LocalConversationTransferIdentity;
  readonly source: ConversationTransferSource;
  readonly client: LocalConversationTransferClient;
  readonly executorLog: AuthorityCommitLog;
  readonly verifier: ProtocolSignatureVerifier;
}): Promise<void> {
  const { conversationId, targetDeviceId, identity, source, client, executorLog, verifier } = input;
  for (let round = 0; round < 2; round += 1) {
    const states = await listConversationTransfersFor(
      executorLog,
      verifier,
      conversationId,
    );
    const derived = deriveLocalConversationTransferAttemptIdentity({
      conversationId,
      sourceDeviceId: identity.deviceId,
      targetDeviceId,
      sourceOwnerEpoch: identity.ownerEpoch,
      states,
    });
    if (!derived || derived.kind === "completed") break;
    const prior = derived.kind === "resume" ? derived.state : undefined;
    const { transferId, requestId } = derived.attempt;
    const prepared = derived.attempt.prepared(identity);
    let restartedAfterAbort = false;
    try {
      if (prior) {
        const resumedTarget = await queryTransferTargetStatusIfKnown(client, transferId);
        if (resumedTarget?.state === "committed" || resumedTarget?.state === "tombstoned") {
          await commitFromTarget(source, transferId, resumedTarget.commit);
          break;
        }
        if (resumedTarget?.state === "aborted") {
          await source.acceptAbort(resumedTarget.abort);
          restartedAfterAbort = true;
        } else {
          await freezeAndCommit(source, client, transferId);
          break;
        }
      } else {
        const existingTarget = await queryTransferTargetStatusIfKnown(client, transferId);
        if (existingTarget === undefined) {
          try {
            await source.assertCompatibleWithTarget({ targetDeviceId, conversationId });
          } catch (compatError) {
            if (compatError instanceof ConversationTransferIncompatibleTargetError) {
              break;
            }
            throw compatError;
          }
          await client.prepare(prepared);
          await source.prepare({
            requestId,
            transferId,
            targetDeviceId,
            conversationId,
            sourceOwnerEpoch: identity.ownerEpoch,
          });
          await freezeAndCommit(source, client, transferId);
          break;
        }
        if (existingTarget.state === "aborted") {
          await source.recordPreparedForAbort(prepared);
          await source.acceptAbort(existingTarget.abort);
          restartedAfterAbort = true;
        } else if (
          existingTarget.state === "committed" ||
          existingTarget.state === "tombstoned"
        ) {
          await source.recordPreparedForAbort(prepared);
          await commitFromTarget(source, transferId, existingTarget.commit);
          break;
        } else {
          await source.prepare({
            requestId,
            transferId,
            targetDeviceId,
            conversationId,
            sourceOwnerEpoch: identity.ownerEpoch,
          });
          await freezeAndCommit(source, client, transferId);
          break;
        }
      }
    } catch (error) {
      let durable: ConversationTransferState | undefined = await readConversationTransferState(
        executorLog,
        transferId,
        verifier,
      );
      let target: LocalTransferStatusResult | undefined;
      if (!durable) {
        target = await queryTransferTargetStatusIfKnown(client, transferId);
        if (!target) {
          if (error instanceof ConversationTransferIncompatibleTargetError) break;
          throw error;
        }
        if (target.state === "aborted") {
          await source.recordPreparedForAbort(prepared);
          await source.acceptAbort(target.abort);
          restartedAfterAbort = true;
        } else if (target.state === "committed" || target.state === "tombstoned") {
          durable = await source.recordPreparedForAbort(prepared);
          await commitFromTarget(source, transferId, target.commit);
          break;
        } else {
          durable = await source.recordPreparedForAbort(prepared);
        }
      }
      if (!restartedAfterAbort) {
        target ??= await queryTransferTargetStatusIfKnown(client, transferId);
        if (target?.state === "committed" || target?.state === "tombstoned") {
          if (!durable?.manifest) {
            throw new Error("Committed transfer recovery is incomplete");
          }
          await commitFromTarget(source, transferId, target.commit);
          break;
        }
        if (target?.state === "aborted") {
          await source.acceptAbort(target.abort);
          restartedAfterAbort = true;
        } else {
          const isTerminalReject =
            error instanceof ConversationTransferIncompatibleTargetError ||
            (error instanceof ConversationTransferRejectedError && !error.retryable);
          if (!isTerminalReject) {
            throw error;
          }
          const abort = await source.prepareAbort(transferId, "target-rejected");
          const acknowledged = await client.abort(abort);
          await source.acceptAbort(acknowledged);
          break;
        }
      }
    }
    if (!restartedAfterAbort) break;
  }
}

export async function assertLocalConversationsDurablyTransferred(input: {
  readonly executorLog: AuthorityCommitLog;
  readonly verifier: ProtocolSignatureVerifier;
  readonly targetDeviceId: string;
  readonly conversationIds: readonly string[];
}): Promise<void> {
  for (const conversationId of input.conversationIds) {
    const states = await listConversationTransfersFor(
      input.executorLog,
      input.verifier,
      conversationId,
    );
    if (
      !states.some(
        (state) =>
          state.identity.conversationId === conversationId &&
          state.identity.targetDeviceId === input.targetDeviceId &&
          (state.phase === "committed" || state.phase === "tombstoned"),
      )
    ) {
      throw new Error("Device removal conversation transfer is not durably complete");
    }
  }
}

async function freezeAndCommit(
  source: ConversationTransferSource,
  client: LocalConversationTransferClient,
  transferId: string,
): Promise<void> {
  const frozen = await source.freeze(transferId);
  const commit = await client.importAndCommit(frozen);
  await source.acceptCommit({ manifest: frozen.manifest, commit });
}

async function commitFromTarget(
  source: ConversationTransferSource,
  transferId: string,
  commit: ConversationTransferCommit | undefined,
): Promise<void> {
  if (!commit) {
    throw new Error("Committed transfer recovery is incomplete");
  }
  const frozen = await source.freeze(transferId);
  await source.acceptCommit({ manifest: frozen.manifest, commit });
}
