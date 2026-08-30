import { createHash } from "node:crypto";
import {
  ConversationDirectoryApplicationService,
  type ConversationDirectoryStorage,
} from "@zhixing/core/conversation/application";
import type { AuthorityCallContext } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import type { LocalConversationOwnerPort } from "./local-conversation-owner.js";

const LOCAL_ONLY_CAPABILITIES = Object.freeze([
  "排程暂不可用",
  "旧设备上的对话暂不可修改",
  "任务推进确认将在重新连接后处理",
]);

export function createLocalConversationDirectoryApplication(input: {
  readonly owner: LocalConversationOwnerPort;
  readonly observerCount: (conversationId: string) => number;
}): ConversationDirectoryApplicationService {
  const storage: ConversationDirectoryStorage = {
    async list() {
      return Promise.all(
        (await input.owner.listConversations()).map(async (conversationId) => {
          const meta = await input.owner.sessionState.readSessionMeta(
            conversationId,
            context(`list:${conversationId}`),
          );
          return {
            conversationId,
            name: meta.name ?? "本机对话",
            createdAt: meta.lastActiveAt,
            lastActiveAt: meta.lastActiveAt,
          };
        }),
      );
    },
    async create() {
      const conversationId = await input.owner.createConversation();
      const meta = await input.owner.sessionState.readSessionMeta(
        conversationId,
        context(`create:${conversationId}`),
      );
      return {
        conversationId,
        name: meta.name ?? "本机对话",
        createdAt: meta.lastActiveAt,
        lastActiveAt: meta.lastActiveAt,
      };
    },
    async rename(conversationId, name) {
      if (!(await input.owner.listConversations()).includes(conversationId)) {
        return null;
      }
      await input.owner.mutateSession(
        conversationId,
        { kind: "session-meta", patch: { name } },
        context(localStableRequest("rename", { conversationId, name })),
      );
      const meta = await input.owner.sessionState.readSessionMeta(
        conversationId,
        context(`rename-read:${conversationId}`),
      );
      return {
        conversationId,
        name: meta.name ?? name,
        createdAt: meta.lastActiveAt,
        lastActiveAt: meta.lastActiveAt,
      };
    },
    async readHistory(conversationId, request) {
      const page = await input.owner.sessionState.readTranscriptTail(
        conversationId,
        context(`history:${conversationId}`),
        request.before,
        request.limit,
      );
      return {
        runs: [...page.records]
          .reverse()
          .map((record) => ({ record, shardId: "owner-log" })),
        hasMore: page.next !== undefined,
      };
    },
  };
  return new ConversationDirectoryApplicationService({
    storage,
    taskLists: input.owner.taskLists,
    agentTurns: input.owner.agentTurnAdmission,
    agentTurnIdentity: {
      exists: async (conversationId) =>
        (await input.owner.listConversations()).includes(conversationId),
      create: () => input.owner.createConversation(),
      ensure: (conversationId) => input.owner.ensureSession(conversationId),
    },
    resume: {
      async restoreIdentity(conversationId) {
        if (!(await input.owner.listConversations()).includes(conversationId)) {
          return null;
        }
        const meta = await input.owner.sessionState.readSessionMeta(
          conversationId,
          context(`resume:${conversationId}`),
        );
        return {
          conversationId,
          name: meta.name ?? "本机对话",
          createdAt: meta.lastActiveAt,
          lastActiveAt: meta.lastActiveAt,
        };
      },
      recoverDependentLifecycle: async () => {},
    },
    clear: {
      requiresStableOperationIdentity: true,
      createOperationIdentity: () => {
        throw new Error("Local Conversation clear requires a stable operation identity");
      },
      commit: (request) => input.owner.commitConversationClear(request),
    },
    delete: {
      requiresStableOperationIdentity: true,
      createOperationIdentity: () => {
        throw new Error("Local Conversation delete requires a stable operation identity");
      },
      commit: (request) => input.owner.commitConversationDelete(request),
    },
    runControl: {
      requiresStableCancellationIdentity: true,
      requiresAuthoritativeRunIdentity: false,
      emptyCancellationIsSuccess: true,
      createCancellationIdentity: () => {
        throw new Error(
          "Local Conversation abort requires a stable operation identity",
        );
      },
      cancel: (request) => input.owner.cancelConversationRuns(request),
      resolveUncertain: (request) =>
        input.owner.resolveConversationUncertain(request),
    },
    runtime: {
      read: (conversationId) => ({
        active: false,
        busy: false,
        observerCount: input.observerCount(conversationId),
        pendingCount: 0,
      }),
    },
    availability: {
      mode: "local-only",
      unavailableCapabilities: LOCAL_ONLY_CAPABILITIES,
    },
  });
}

function context(requestId: string): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "local-conversation-product-api" },
    requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

function localStableRequest(kind: string, payload: unknown): string {
  return `local-${kind}-${createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex")
    .slice(0, 32)}`;
}
