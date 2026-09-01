import fs from "node:fs/promises";
import path from "node:path";
import {
  fromSafePathSegment,
  getWorkSceneConversationsRoot,
  getWorkScenesRoot,
  toSafePathSegment,
} from "@zhixing/core";
import {
  ConversationRepository,
  conversationsDir,
  parseConversationId,
  type Conversation,
  type ConversationScope,
  type SegmentMeta,
  type TaskListState,
} from "@zhixing/core/conversation";
import type {
  ConversationCommittedViewStorage,
  ConversationDirectoryStorage,
} from "@zhixing/core/conversation/application";
import {
  buildStartupBootstrap,
  createTokenEstimator,
} from "@zhixing/core/context";
import {
  ShardedTranscriptStore,
  SnapshotStore,
  countRuns,
  createReadOnlyTranscriptSource,
  readRunsReverse,
  runRetentionSweep,
  type RetentionSweepReport,
  type RunRecordWithRef,
} from "@zhixing/core/transcript";
import type { ConversationManagerCallbacks } from "@zhixing/owner-kernel";
import type { TaskListStore } from "@zhixing/tools-builtin";
import { RoutedConversationRepoTaskListStore } from "../runtime/task-list-stores.js";
import { createConversationDirectory } from "./conversation-directory.js";
import type { NamerConversationRepo } from "./turn-maintenance.js";
import type { WorksceneConversationStorageRemovalPort } from "./workscene-storage-removal.js";

type ConversationRuntimeStoragePort = Readonly<
  Required<
    Pick<
      ConversationManagerCallbacks,
      | "loadHistory"
      | "initTranscript"
      | "appendRun"
      | "appendCommittedRun"
      | "writeSnapshot"
    >
  >
>;

type ConversationDirectoryPort = ReturnType<typeof createConversationDirectory>;

export interface ConversationStorageInfrastructure {
  readonly directory: ConversationDirectoryPort;
  readonly runtime: ConversationRuntimeStoragePort;
  readonly committedViews: ConversationCommittedViewStorage;
  readonly taskLists: TaskListStore;
  readonly naming: NamerConversationRepo;
  readonly maintenance: Readonly<{
    runRetentionSweep(): Promise<RetentionSweepReport>;
    isConversationDataAlive(directoryName: string): Promise<boolean>;
  }>;
}

interface ScopeStorage {
  readonly repo: ConversationRepository;
  readonly transcript: ShardedTranscriptStore;
  readonly snapshots: SnapshotStore;
}

/**
 * The single Host infrastructure adapter for live Conversation persistence.
 * Every returned role is finite; no consumer receives the physical scope,
 * repository, transcript store, snapshot store, or path resolver.
 */
export function createConversationStorageInfrastructure(input: Readonly<{
  optimalMaxTokens: number;
  worksceneConversationStorageRemoval: WorksceneConversationStorageRemovalPort;
  clearTaskListCache?: (conversationId: string) => void;
}>): ConversationStorageInfrastructure {
  const user = createScopeStorage({ kind: "user" });
  const workscenes = new Map<string, ScopeStorage>();

  const routeConversation = (conversationId: string) => {
    const { scope, localId } = parseConversationId(conversationId);
    if (scope.kind === "user") return { ...user, localId };
    let storage = workscenes.get(scope.sceneId);
    if (!storage) {
      storage = createScopeStorage(scope);
      workscenes.set(scope.sceneId, storage);
    }
    return { ...storage, localId };
  };

  const directory = createConversationDirectory({
    user,
    routeConversation,
    worksceneConversationStorageRemoval:
      input.worksceneConversationStorageRemoval,
    ...(input.clearTaskListCache
      ? { clearTaskListCache: input.clearTaskListCache }
      : {}),
  });

  const runtime: ConversationRuntimeStoragePort = Object.freeze({
    async loadHistory(conversationId) {
      const storage = routeConversation(conversationId);
      const turnCount = await countRuns(storage.transcript, storage.localId);
      if (turnCount === 0) return undefined;
      const bootstrap = await buildStartupBootstrap({
        conversationId: storage.localId,
        store: storage.transcript,
        snapshots: storage.snapshots,
        capability: { optimalMaxTokens: input.optimalMaxTokens },
        estimator: createTokenEstimator(),
      });
      return { bootstrap, turnCount };
    },
    async initTranscript(conversationId) {
      const storage = routeConversation(conversationId);
      await storage.transcript.init(storage.localId);
    },
    async appendRun(conversationId, record) {
      const storage = routeConversation(conversationId);
      return storage.transcript.appendRunRecord(storage.localId, record);
    },
    async appendCommittedRun(conversationId, record) {
      const storage = routeConversation(conversationId);
      return storage.transcript.appendCommittedRunRecord(
        storage.localId,
        record,
      );
    },
    async writeSnapshot(conversationId, snapshot) {
      const storage = routeConversation(conversationId);
      await storage.snapshots.write(storage.localId, snapshot);
    },
  });

  const committedViews: ConversationCommittedViewStorage = Object.freeze({
    async persistTaskList(conversationId: string, state: TaskListState) {
      const storage = routeConversation(conversationId);
      await storage.repo.updateTaskListState(storage.localId, state);
    },
    async appendSegment(conversationId: string, segment: SegmentMeta) {
      const storage = routeConversation(conversationId);
      await storage.repo.appendSegmentMeta(storage.localId, segment);
    },
  });

  const naming: NamerConversationRepo = Object.freeze({
    get: (conversationId: string) => user.repo.get(conversationId),
    rename: (conversationId: string, name: string) =>
      user.repo.rename(conversationId, name),
  });

  const maintenance = Object.freeze({
    async runRetentionSweep() {
      return runRetentionSweep({ roots: await collectConversationRoots() });
    },
    async isConversationDataAlive(directoryName: string) {
      const conversationId = fromSafePathSegment(directoryName);
      const { scope, localId } = parseConversationId(conversationId);
      try {
        const info = await fs.stat(
          path.join(conversationsDir(scope), toSafePathSegment(localId)),
        );
        return info.isDirectory();
      } catch {
        return false;
      }
    },
  });

  return Object.freeze({
    directory,
    runtime,
    committedViews,
    taskLists: new RoutedConversationRepoTaskListStore((conversationId) => {
      const storage = routeConversation(conversationId);
      return { repo: storage.repo, localId: storage.localId };
    }),
    naming,
    maintenance,
  });
}

/**
 * Read-only degraded-mode adapter. It intentionally exposes only the same
 * Conversation history projection consumed by the Surface and never creates a
 * writable repository or transcript store.
 */
export function createReadOnlyConversationStorage(): Pick<
  ConversationDirectoryStorage,
  "list" | "readHistory"
> {
  const root = conversationsDir({ kind: "user" });
  const transcript = createReadOnlyTranscriptSource(root);
  return Object.freeze({
    async list() {
      let entries: string[];
      try {
        entries = await fs.readdir(root);
      } catch {
        return [];
      }
      const conversations: Conversation[] = [];
      for (const entry of entries) {
        const meta = await readJson<Conversation>(path.join(root, entry, "meta.json"));
        if (!meta || meta.archived) continue;
        if (
          typeof meta.id !== "string" ||
          typeof meta.name !== "string" ||
          typeof meta.lastActiveAt !== "string"
        ) {
          continue;
        }
        conversations.push(meta);
      }
      return conversations
        .sort(
          (a, b) =>
            new Date(b.lastActiveAt).getTime() -
            new Date(a.lastActiveAt).getTime(),
        )
        .map((conversation) => Object.freeze({
          conversationId: conversation.id,
          name: conversation.name,
          createdAt:
            typeof conversation.createdAt === "string"
              ? conversation.createdAt
              : conversation.lastActiveAt,
          lastActiveAt: conversation.lastActiveAt,
        }));
    },
    async readHistory(conversationId, options) {
      const runs: RunRecordWithRef[] = [];
      let hasMore = false;
      for await (const item of readRunsReverse(transcript, conversationId, {
        before: options.before,
      })) {
        if (runs.length >= options.limit) {
          hasMore = true;
          break;
        }
        runs.push(item);
      }
      return { runs, hasMore };
    },
  });
}

function createScopeStorage(scope: ConversationScope): ScopeStorage {
  const root = conversationsDir(scope);
  return Object.freeze({
    repo: new ConversationRepository(scope),
    transcript: new ShardedTranscriptStore(root),
    snapshots: new SnapshotStore(root),
  });
}

async function collectConversationRoots(): Promise<string[]> {
  const roots = [conversationsDir({ kind: "user" })];
  try {
    const entries = await fs.readdir(getWorkScenesRoot(), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        roots.push(getWorkSceneConversationsRoot(entry.name));
      }
    }
  } catch {
    // A missing workscene root is a valid empty storage domain.
  }
  return roots;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
