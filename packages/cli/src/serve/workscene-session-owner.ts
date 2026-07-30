import { rm } from "node:fs/promises";
import {
  getWorkSceneDir,
  parseConversationId,
  WORKSCENE_CONVERSATION_PREFIX,
  worksceneConversationId,
} from "@zhixing/core";
import type { ConversationManager } from "@zhixing/owner-kernel";
import type { ConversationDirectory } from "@zhixing/server";

export interface WorksceneSessionOwnerOptions {
  readonly conversations: () => ConversationManager | null;
  readonly directory: ConversationDirectory;
  readonly authority: () =>
    | {
        touchWorksceneSession(input: {
          conversationId: string;
          sceneId: string;
          requestId: string;
          at: string;
        }): Promise<{ readonly revision: number; readonly at: string }>;
        deleteWorksceneSession(input: {
          conversationId: string;
          sceneId: string;
          requestId: string;
          at: string;
        }): Promise<
          { readonly revision: number; readonly at: string } | undefined
        >;
      }
    | undefined;
  readonly runCleanupStep: <T>(
    resourceIdentity: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

/**
 * Single owner for workscene-scoped conversation identity and activity facts.
 *
 * Workscene management callers never open ConversationRepository themselves.
 * The scope encoded by the global conversation id is checked at every entry,
 * making scene ownership immutable after session creation.
 */
export class WorksceneSessionOwner {
  readonly #conversations: () => ConversationManager | null;
  readonly #directory: ConversationDirectory;
  readonly #authority: WorksceneSessionOwnerOptions["authority"];
  readonly #runCleanupStep: WorksceneSessionOwnerOptions["runCleanupStep"];

  constructor(options: WorksceneSessionOwnerOptions) {
    this.#conversations = options.conversations;
    this.#directory = options.directory;
    this.#authority = options.authority;
    this.#runCleanupStep = options.runCleanupStep;
  }

  async enter(
    sceneId: string,
    observerId: string,
    options: { recordActivity?: boolean; requestId: string },
  ): Promise<string> {
    const conversationId = worksceneConversationId(sceneId, "primary");
    this.#assertSceneConversation(sceneId, conversationId);
    const at = new Date().toISOString();
    let committedAt = at;
    if (options.recordActivity !== false) {
      committedAt = await this.#recordAuthority(
        sceneId,
        conversationId,
        options.requestId,
        at,
      );
    }
    await this.#directory.ensure(conversationId);
    if (options.recordActivity !== false) {
      await this.#directory.touch(conversationId, committedAt);
    }
    const manager = this.#conversations();
    if (manager) {
      await manager.getOrCreate(conversationId);
      if (
        !manager.addObserver(conversationId, observerId, {
          allowInactive: true,
        })
      ) {
        throw worksceneBusy(
          `Workscene ${sceneId} is being changed; try again later`,
        );
      }
    }
    return conversationId;
  }

  async record(
    sceneId: string,
    conversationId: string,
    requestId: string,
    at: string,
  ): Promise<void> {
    this.#assertSceneConversation(sceneId, conversationId);
    if (!(await this.#directory.exists(conversationId))) {
      throw new Error("Workscene conversation does not exist");
    }
    const committedAt = await this.#recordAuthority(
      sceneId,
      conversationId,
      requestId,
      at,
    );
    await this.#directory.touch(conversationId, committedAt);
  }

  async quiesce(sceneId: string): Promise<() => void> {
    const manager = this.#conversations();
    return manager
      ? manager.quiescePrefix(
          `${WORKSCENE_CONVERSATION_PREFIX}${sceneId}:`,
        )
      : () => {};
  }

  async removeScene(
    sceneId: string,
    conversationIds: readonly string[],
  ): Promise<void> {
    const at = new Date().toISOString();
    for (const conversationId of conversationIds) {
      this.#assertSceneConversation(sceneId, conversationId);
      const authority = this.#authority();
      if (!authority) {
        throw new Error("Workscene session authority is unavailable");
      }
      await authority.deleteWorksceneSession({
        conversationId,
        sceneId,
        requestId: `workscene-delete:${sceneId}:${conversationId}`,
        at,
      });
      await this.#runCleanupStep(
        `conversation:${conversationId}`,
        () => this.#directory.remove(conversationId),
      );
    }
    await this.#runCleanupStep(`workscene:${sceneId}`, () =>
      rm(getWorkSceneDir(sceneId), { recursive: true, force: true }),
    );
  }

  async #recordAuthority(
    sceneId: string,
    conversationId: string,
    requestId: string,
    at: string,
  ): Promise<string> {
    const authority = this.#authority();
    if (!authority) {
      throw new Error("Workscene session authority is unavailable");
    }
    const receipt = await authority.touchWorksceneSession({
      conversationId,
      sceneId,
      requestId,
      at,
    });
    return receipt.at;
  }

  #assertSceneConversation(sceneId: string, conversationId: string) {
    const parsed = parseConversationId(conversationId);
    if (
      parsed.scope.kind !== "workscene" ||
      parsed.scope.sceneId !== sceneId
    ) {
      throw Object.assign(
        new TypeError("Conversation does not belong to the workscene"),
        { code: "WORKSCENE_INPUT" },
      );
    }
    return parsed;
  }
}

function worksceneBusy(message: string): Error {
  return Object.assign(new Error(message), {
    name: "WorksceneBusyError",
    code: "WORKSCENE_BUSY",
  });
}
