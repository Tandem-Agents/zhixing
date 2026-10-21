import fs from "node:fs/promises";
import path from "node:path";
import { fromSafePathSegment, toSafePathSegment } from "@zhixing/core/paths";
import { getWorkSceneConversationsRoot, getWorkScenesRoot } from "@zhixing/core/workscene";
import {
  ConversationRepository,
  readConversationDirectoryPage,
  readConversationDirectory,
  prepareConversationDirectory,
  conversationsDir,
  parseConversationId,
  type ConversationScope,
  type SegmentMeta,
  type TaskListState,
} from "@zhixing/core/conversation";
import type {
  ConversationCommittedViewStorage,
  ConversationDirectoryStorage,
  TaskListStore,
} from "@zhixing/core/conversation/application";
import {
  buildStartupBootstrap,
  createTokenEstimator,
  readBootstrapRunViews,
} from "@zhixing/core/context";
import {
  ShardedTranscriptStore,
  SnapshotStore,
  createReadOnlyTranscriptSource,
  TranscriptByteReader,
  readRunsReverse,
  runRetentionSweep,
  type RetentionSweepReport,
  type RunRecordWithRef,
} from "@zhixing/core/transcript";
import type { ConversationRuntimeStoragePort } from "./access-surface.js";
import { createConversationDirectory } from "./conversation-directory.js";
import type { NamerConversationRepo } from "./turn-maintenance.js";
import type { WorksceneConversationStorageRemovalPort } from "./workscene-storage-removal.js";

type ConversationDirectoryPort = ReturnType<typeof createConversationDirectory>;

export interface ConversationStorageInfrastructure {
  readonly directory: ConversationDirectoryPort;
  readonly runtime: ConversationRuntimeStoragePort;
  readonly committedViews: ConversationCommittedViewStorage;
  readonly taskLists: Pick<TaskListStore, "load">;
  readonly naming: NamerConversationRepo;
  readonly maintenance: Readonly<{
    prepareDirectory(signal?: AbortSignal): Promise<void>;
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
  zhixingHome: string;
  optimalMaxTokens: number;
  worksceneConversationStorageRemoval: WorksceneConversationStorageRemovalPort;
  clearTaskListCache?: (conversationId: string) => void;
}>): ConversationStorageInfrastructure {
  const zhixingHome = input.zhixingHome;
  const user = createScopeStorage({ kind: "user" }, zhixingHome);
  const workscenes = new Map<string, ScopeStorage>();

  const routeConversation = (conversationId: string) => {
    const { scope, localId } = parseConversationId(conversationId);
    if (scope.kind === "user") return { ...user, localId };
    let storage = workscenes.get(scope.sceneId);
    if (!storage) {
      storage = createScopeStorage(scope, zhixingHome);
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
    async loadHistory(conversationId, committedTurnCount) {
      if (committedTurnCount !== undefined &&
          (!Number.isSafeInteger(committedTurnCount) || committedTurnCount < 0)) {
        throw new TypeError("Committed conversation turn count is invalid");
      }
      if (committedTurnCount === 0) return undefined;
      const storage = routeConversation(conversationId);
      const { scope } = parseConversationId(conversationId);
      const reader = new TranscriptByteReader(path.join(conversationsDir(scope, zhixingHome), toSafePathSegment(storage.localId), 'transcript'),
        path.join(zhixingHome, 'cache', 'transcript-read-index'));
      try {
        // Production already has the count in the owner's current read model.
        // Enumerating every JSONL record just to count it makes the first send
        // grow with history, and an append changes every slice cache identity.
        let turnCount = committedTurnCount ?? 0;
        if (committedTurnCount === undefined) {
          for await (const _ of reader.records()) turnCount++;
        }
        if (!turnCount) return undefined;
        // Legacy-only callers discover clear during the count pass. With owner
        // metadata, the existing snapshot reader uses its persisted clear index;
        // a durable clear has count zero until its first post-clear commit.
        const clearBoundary = committedTurnCount === undefined
          ? { lastClearAt: reader.lastClearAt } : undefined;
        const bootstrap = await buildStartupBootstrap({
          conversationId: storage.localId,
          store: storage.transcript,
          snapshots: storage.snapshots,
          capability: { optimalMaxTokens: input.optimalMaxTokens },
          estimator: createTokenEstimator(),
          runs: readBootstrapRunViews(reader),
          ...(clearBoundary ? { clearBoundary } : {}),
        });
        return { bootstrap, turnCount };
      } finally { await reader.close(); }
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
    prepareDirectory: (signal?: AbortSignal) => prepareConversationDirectory(conversationsDir({ kind: 'user' }, zhixingHome), signal),
    async runRetentionSweep() {
      return runRetentionSweep({ roots: await collectConversationRoots(zhixingHome) });
    },
    async isConversationDataAlive(directoryName: string) {
      const conversationId = fromSafePathSegment(directoryName);
      const { scope, localId } = parseConversationId(conversationId);
      try {
        const info = await fs.stat(
          path.join(conversationsDir(scope, zhixingHome), toSafePathSegment(localId)),
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
    taskLists: { load: async (conversationId: string) => {
      const storage = routeConversation(conversationId);
      return (await storage.repo.get(storage.localId))?.taskListState;
    } },
    naming,
    maintenance,
  });
}

/**
 * Read-only degraded-mode adapter. It intentionally exposes only the same
 * Conversation history projection consumed by the Surface and never creates a
 * writable repository or transcript store.
 */
export function createReadOnlyConversationStorage(zhixingHome: string, signal?: AbortSignal): Pick<
  ConversationDirectoryStorage,
  "list" | "listPage" | "readHistory"
> & { openBodyReader(conversationId: string): TranscriptByteReader } {
  const root = conversationsDir({ kind: "user" }, zhixingHome);
  const transcript = createReadOnlyTranscriptSource(root);
  return Object.freeze({
    openBodyReader(conversationId: string) {
      const { scope, localId } = parseConversationId(conversationId);
      const directory = path.join(conversationsDir(scope, zhixingHome), toSafePathSegment(localId), 'transcript');
      return new TranscriptByteReader(directory, path.join(zhixingHome, 'cache', 'transcript-read-index'));
    },
    async listPage(input: import('@zhixing/core/conversation/application').ConversationDirectoryPageRequest) {
      const page = await readConversationDirectoryPage(root, input, undefined, signal);
      return { records: page.records.map(item => ({ conversationId: item.id, name: item.name, createdAt: typeof item.createdAt === 'string' ? item.createdAt : item.lastActiveAt, lastActiveAt: item.lastActiveAt })), next: page.next };
    },
    async list() {
      return (await readConversationDirectory(root))
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

function createScopeStorage(scope: ConversationScope, zhixingHome: string): ScopeStorage {
  const root = conversationsDir(scope, zhixingHome);
  return Object.freeze({
    repo: new ConversationRepository(scope, zhixingHome),
    transcript: new ShardedTranscriptStore(root),
    snapshots: new SnapshotStore(root),
  });
}

async function collectConversationRoots(zhixingHome: string): Promise<string[]> {
  const roots = [conversationsDir({ kind: "user" }, zhixingHome)];
  try {
    const entries = await fs.readdir(getWorkScenesRoot(zhixingHome), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        roots.push(getWorkSceneConversationsRoot(entry.name, zhixingHome));
      }
    }
  } catch {
    // A missing workscene root is a valid empty storage domain.
  }
  return roots;
}
