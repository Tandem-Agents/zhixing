import { rm } from "node:fs/promises";
import path from "node:path";
import {
  FileArtifactStore,
  FileResumableArtifactReceiver,
} from "@zhixing/core/authority";
import type {
  ConversationTransferStaging,
  ConversationTransferStagingArea,
} from "@zhixing/owner-kernel";

const MAX_CONVERSATION_TRANSFER_ARTIFACT_BYTES = 512 * 1024 * 1024;
const CONVERSATION_TRANSFER_CHUNK_BYTES = 256 * 1024;
const TRANSFER_ID = /^xfer-[0-9A-HJKMNP-TV-Z]{26}$/u;

/** The sole physical composition of the P12 conversation-transfer staging family. */
export function createConversationTransferStagingInfrastructure(options: Readonly<{
  zhixingHome: string;
}>): ConversationTransferStagingArea {
  const root = path.resolve(
    options.zhixingHome,
    "distributed-runtime",
    "conversation-transfer-staging",
  );
  const transfers = new Map<string, ConversationTransferStaging>();

  return Object.freeze({
    forTransfer(transferId: string): ConversationTransferStaging {
      assertTransferId(transferId);
      const current = transfers.get(transferId);
      if (current) return current;

      const transferRoot = path.resolve(root, transferId);
      if (path.dirname(transferRoot) !== root) {
        throw new TypeError("Conversation transfer staging path escapes its root");
      }
      const store = new FileArtifactStore(path.join(transferRoot, "artifacts"));
      const receiver = new FileResumableArtifactReceiver(
        store,
        path.join(transferRoot, "partials"),
        {
          maxArtifactBytes: MAX_CONVERSATION_TRANSFER_ARTIFACT_BYTES,
          maxChunkBytes: CONVERSATION_TRANSFER_CHUNK_BYTES,
        },
      );
      const staging = Object.freeze({
        artifacts: Object.freeze({
          get: store.get.bind(store),
          readRange: store.readRange.bind(store),
          has: store.has.bind(store),
        }),
        receiver: Object.freeze({
          progress: receiver.progress.bind(receiver),
          append: receiver.append.bind(receiver),
        }),
        cleanup: async (): Promise<number> => {
          const removed = (await store.list()).length;
          await rm(transferRoot, { recursive: true, force: true });
          transfers.delete(transferId);
          return removed;
        },
      }) satisfies ConversationTransferStaging;
      transfers.set(transferId, staging);
      return staging;
    },
  });
}

function assertTransferId(transferId: string): void {
  if (!TRANSFER_ID.test(transferId)) {
    throw new TypeError("Conversation transfer staging id is invalid");
  }
}
