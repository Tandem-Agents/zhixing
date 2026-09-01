/**
 * ConversationDirectory 持久层实现 —— 用真实 repo + transcript(临时 home)锁
 * 与 server 契约的对齐:不存在的表达(rename null / remove false)、倒读分页
 * 的 hasMore 探测与游标续读、读容错(未知对话空页)。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  ConversationRepository,
  ShardedTranscriptStore,
  conversationsDir,
  extractFirstText,
  parseConversationId,
  type ConversationScope,
  worksceneConversationId,
} from "@zhixing/core";
import {
  ConversationDirectoryApplicationService,
  createConversationIdentityLifecycleApplication,
  projectConversationDelete,
} from "@zhixing/core/conversation/application";
import {
  ConversationManager,
  type RuntimeFactory,
  type SessionRuntime,
} from "@zhixing/owner-kernel";
import { createAnchorConversationClearCommitPort } from "../conversation-clear-binding.js";
import {
  createAnchorConversationDeleteCommitPort,
  createAnchorConversationDeleteProjectionPort,
} from "../conversation-delete-binding.js";
import { createConversationDirectory } from "../conversation-directory.js";
import { createWorksceneStorageCleanup } from "../workscene-storage-cleanup.js";

let originalHome: string | undefined;
let directory: ReturnType<typeof createConversationDirectory>;
let repo: ConversationRepository;
let transcript: ShardedTranscriptStore;

beforeEach(async () => {
  const tmp = await createTempDir("conv-dir");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmp;
  repo = new ConversationRepository({ kind: "user" });
  transcript = new ShardedTranscriptStore(conversationsDir({ kind: "user" }));
  directory = createConversationDirectory({
    user: { repo, transcript },
    routeConversation: (conversationId) => ({
      repo,
      transcript,
      localId: parseConversationId(conversationId).localId,
    }),
    worksceneStorageCleanup: createWorksceneStorageCleanup(),
  });
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = originalHome;
});

function record(text: string) {
  return {
    timestamp: new Date().toISOString(),
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `re:${text}` }] },
    ],
  };
}

describe("conversation directory(持久层实现)", () => {
  it("rename:不存在返回 null;存在改名后 list 可见", async () => {
    expect(await directory.rename("ghost", "x")).toBeNull();

    const created = await repo.create({ name: "原名" });
    const renamed = await directory.rename(created.id, "新名");
    expect(renamed?.name).toBe("新名");
    const list = await directory.list();
    expect(list.find((c) => c.conversationId === created.id)?.name).toBe("新名");
  });

  it("deleteStoredConversation:不存在返回 false;存在删除后盘上消失", async () => {
    expect(await directory.exists("ghost")).toBe(false);
    expect(await directory.deleteStoredConversation("ghost")).toBe(false);

    const created = await repo.create({ name: "待删" });
    expect(await directory.exists(created.id)).toBe(true);
    expect(await directory.deleteStoredConversation(created.id)).toBe(true);
    expect(await repo.get(created.id)).toBeNull();
    expect(await directory.exists(created.id)).toBe(false);
  });

  it("create:meta + transcript 壳一并建,身份即刻进列表", async () => {
    const created = await directory.create();
    expect(created.name).toBe(created.conversationId);
    expect(await directory.exists(created.conversationId)).toBe(true);
    const list = await directory.list();
    expect(list.some((c) => c.conversationId === created.conversationId)).toBe(true);
    // transcript 壳已建——倒读空页而非异常
    expect(await directory.readHistory(created.conversationId, { limit: 5 })).toEqual({
      runs: [],
      hasMore: false,
    });
  });

  it("ensure:显式 id 建 meta + transcript 壳,渠道会话进入 user 列表", async () => {
    const id = "dm:feishu:ou_xxx";

    const ensured = await directory.ensure(id);
    expect(ensured.id).toBe(id);
    expect(ensured.name).toBe(id);
    expect(await directory.exists(id)).toBe(true);
    expect((await directory.list()).some((c) => c.conversationId === id)).toBe(true);
    expect(await directory.readHistory(id, { limit: 5 })).toEqual({
      runs: [],
      hasMore: false,
    });

    const second = await directory.ensure(id);
    expect(second).toEqual(ensured);
    expect((await directory.list()).filter((c) => c.conversationId === id)).toHaveLength(1);
  });

  it("exists:meta-only 或 transcript-only 任一持久事实都视为存在", async () => {
    const metaOnly = await repo.create({ name: "meta-only" });
    await transcript.init("transcript-only");

    expect(await directory.exists(metaOnly.id)).toBe(true);
    expect(await directory.exists("transcript-only")).toBe(true);
  });

  it("runtime storage application creates user shell but only a transcript for workscene", async () => {
    const sceneScope: ConversationScope = {
      kind: "workscene",
      sceneId: "scene-lifecycle",
    };
    const sceneRepo = new ConversationRepository(sceneScope);
    const sceneTranscript = new ShardedTranscriptStore(
      conversationsDir(sceneScope),
    );
    const routedDirectory = createConversationDirectory({
      user: { repo, transcript },
      worksceneStorageCleanup: createWorksceneStorageCleanup(),
      routeConversation: (conversationId) => {
        const { scope, localId } = parseConversationId(conversationId);
        return {
          repo: scope.kind === "workscene" ? sceneRepo : repo,
          transcript:
            scope.kind === "workscene" ? sceneTranscript : transcript,
          localId,
        };
      },
    });
    const lifecycle = createConversationIdentityLifecycleApplication({
      exists: (conversationId) => routedDirectory.exists(conversationId),
      create: async () => (await routedDirectory.create()).conversationId,
      ensure: async (conversationId) => {
        await routedDirectory.ensure(conversationId);
      },
      ensureTranscript: (conversationId) =>
        routedDirectory.ensureTranscript(conversationId),
    });
    const worksceneConversation = worksceneConversationId(
      sceneScope.sceneId,
      "runtime-conversation",
    );

    await lifecycle.initializeRuntimeStorage("user-runtime");
    await lifecycle.initializeRuntimeStorage(worksceneConversation);
    await lifecycle.initializeRuntimeStorage(worksceneConversation);

    expect(await repo.get("user-runtime")).not.toBeNull();
    expect(await transcript.exists("user-runtime")).toBe(true);
    expect(await sceneRepo.get("runtime-conversation")).toBeNull();
    expect(await routedDirectory.exists(worksceneConversation)).toBe(true);
  });

  it("touch:不存在返回 null;存在返回最新 meta", async () => {
    expect(await directory.touch("ghost")).toBeNull();
    const created = await repo.create({ name: "活跃" });
    const touched = await directory.touch(created.id);
    expect(touched?.id).toBe(created.id);
  });

  it("clear:transcript 清空事件落盘(倒读遇之即止)+ task_list cache 钩子;不存在 false", async () => {
    const clearedCache: string[] = [];
    const dir = createConversationDirectory({
      user: { repo, transcript },
      routeConversation: (conversationId) => ({
        repo,
        transcript,
        localId: parseConversationId(conversationId).localId,
      }),
      worksceneStorageCleanup: createWorksceneStorageCleanup(),
      clearTaskListCache: (id) => clearedCache.push(id),
    });

    expect(await dir.clearStoredView("ghost")).toBe(false);

    const created = await repo.create({ name: "待清" });
    await transcript.init(created.id);
    await transcript.appendRunRecord(created.id, record("清空前"));

    expect(await dir.clearStoredView(created.id)).toBe(true);
    expect(clearedCache).toEqual([created.id]);
    // 清空事件之后倒读不再见旧内容
    expect(await dir.readHistory(created.id, { limit: 5 })).toEqual({
      runs: [],
      hasMore: false,
    });
  });

  it("legacy clear binding:未知身份保持 NOT_FOUND 且零目录/正文/通知副作用", async () => {
    const manager = new ConversationManager(
      {
        create: async () => {
          throw new Error("runtime must not be created while clearing a missing id");
        },
      } satisfies RuntimeFactory,
      { idleCheckIntervalMs: 999_999 },
    );
    const facts: string[] = [];
    const application = new ConversationDirectoryApplicationService({
      storage: directory,
      clear: createAnchorConversationClearCommitPort({
        conversations: manager,
        directory,
        publishFact: (fact) => facts.push(fact.conversationId),
      }),
    });

    try {
      await expect(application.clear({
        kind: "clear",
        conversationId: "ghost",
        caller: { kind: "host", component: "test" },
      })).rejects.toMatchObject({ code: "not-found" });
      expect(await directory.exists("ghost")).toBe(false);
      expect(await repo.get("ghost")).toBeNull();
      expect(await transcript.exists("ghost")).toBe(false);
      expect(facts).toEqual([]);
    } finally {
      await manager.disposeAll();
    }
  });

  it("legacy delete binding:提交后发布一次事实并保持未知身份零副作用", async () => {
    const manager = new ConversationManager(
      {
        create: async () => { throw new Error("runtime must not be created by delete"); },
      } satisfies RuntimeFactory,
      { idleCheckIntervalMs: 999_999 },
    );
    const facts: string[] = [];
    const application = new ConversationDirectoryApplicationService({
      storage: directory,
      delete: createAnchorConversationDeleteCommitPort({
        conversations: manager,
        storage: directory,
        publishFact: (fact) => facts.push(fact.conversationId),
      }),
    });
    const created = await directory.create();

    try {
      await expect(application.delete({
        kind: "delete",
        conversationId: created.conversationId,
        caller: { kind: "host", component: "test" },
      })).resolves.toMatchObject({ deleted: true });
      expect(await directory.exists(created.conversationId)).toBe(false);
      expect(facts).toEqual([created.conversationId]);

      await expect(application.delete({
        kind: "delete",
        conversationId: "ghost",
        caller: { kind: "host", component: "test" },
      })).rejects.toMatchObject({ code: "not-found" });
      expect(await directory.exists("ghost")).toBe(false);
      expect(facts).toEqual([created.conversationId]);
    } finally {
      await manager.disposeAll();
    }
  });

  it("legacy delete binding:锁内刚激活的 runtime-only 身份成功删除并发布一次事实", async () => {
    let releaseRuntime!: (runtime: SessionRuntime) => void;
    const runtimeReady = new Promise<SessionRuntime>((resolve) => {
      releaseRuntime = resolve;
    });
    let markFactoryEntered!: () => void;
    const factoryEntered = new Promise<void>((resolve) => {
      markFactoryEntered = resolve;
    });
    let disposeCalls = 0;
    const runtime = {
      sessionId: "runtime-only",
      run: async function* () {
        throw new Error("run is not used by delete");
      },
      abort: () => false,
      dispose: async () => {
        disposeCalls += 1;
      },
    } as unknown as SessionRuntime;
    const manager = new ConversationManager(
      {
        create: async () => {
          markFactoryEntered();
          return runtimeReady;
        },
      } satisfies RuntimeFactory,
      { idleCheckIntervalMs: 999_999 },
    );
    const facts: string[] = [];
    const application = new ConversationDirectoryApplicationService({
      storage: directory,
      delete: createAnchorConversationDeleteCommitPort({
        conversations: manager,
        storage: directory,
        publishFact: (fact) => facts.push(fact.conversationId),
      }),
    });

    try {
      const activation = manager.getOrCreate("runtime-only");
      await factoryEntered;
      const deletion = application.delete({
        kind: "delete",
        conversationId: "runtime-only",
        caller: { kind: "host", component: "test" },
      });
      releaseRuntime(runtime);
      await activation;

      await expect(deletion).resolves.toMatchObject({ deleted: true });
      expect(await directory.exists("runtime-only")).toBe(false);
      expect(facts).toEqual(["runtime-only"]);
      expect(disposeCalls).toBe(1);
    } finally {
      releaseRuntime(runtime);
      await manager.disposeAll();
    }
  });

  it("durable delete projects storage before strict lifecycle cleanup and replays dependencies", async () => {
    const manager = new ConversationManager(
      { create: async () => { throw new Error("runtime must not be created by delete"); } },
      { idleCheckIntervalMs: 999_999 },
    );
    const created = await directory.create();
    let cancelAttempts = 0;
    const removedData: string[] = [];
    const facts: string[] = [];
    const projection = createAnchorConversationDeleteProjectionPort({
      conversations: manager,
      storage: directory,
      related: {
        cancelDependentLifecycle: async () => {
          if (++cancelAttempts === 1) throw new Error("retry advancement");
        },
        removeDependentData: async (conversationId) => {
          removedData.push(conversationId);
        },
      },
    });
    const project = () => projectConversationDelete({
      conversationId: created.conversationId,
      operationId: "delete-recovery-1",
      deletionAlreadyCommitted: true,
      dependentFailure: "propagate" as const,
      projection,
      publishFact: (fact) => { facts.push(fact.operationId); },
    });

    try {
      await expect(project()).rejects.toThrow("retry advancement");
      expect(await directory.exists(created.conversationId)).toBe(false);
      expect(facts).toEqual(["delete-recovery-1"]);
      await expect(project()).resolves.toMatchObject({ kind: "conversation-deleted" });
      expect(facts).toEqual(["delete-recovery-1"]);
      expect(cancelAttempts).toBe(2);
      expect(removedData).toEqual([created.conversationId]);
    } finally {
      await manager.disposeAll();
    }
  });

  it("clear:workscene 全域 id 走共享 routed repo,清理 local meta 的 task_list", async () => {
    const sceneScope: ConversationScope = { kind: "workscene", sceneId: "scene-a" };
    const sceneRepo = new ConversationRepository(sceneScope);
    const sceneTranscript = new ShardedTranscriptStore(conversationsDir(sceneScope));
    const created = await sceneRepo.create({ name: "场景对话" });
    const globalId = worksceneConversationId(sceneScope.sceneId, created.id);
    await sceneTranscript.init(created.id);
    await sceneTranscript.appendRunRecord(created.id, record("场景清空前"));
    await sceneRepo.updateTaskListState(created.id, {
      items: [{ id: "s1", content: "scene task", status: "pending" }],
    });
    const clearedCache: string[] = [];
    const dir = createConversationDirectory({
      user: { repo, transcript },
      worksceneStorageCleanup: createWorksceneStorageCleanup(),
      routeConversation: (conversationId) => {
        const { scope, localId } = parseConversationId(conversationId);
        if (scope.kind === "workscene") {
          return { repo: sceneRepo, transcript: sceneTranscript, localId };
        }
        return { repo, transcript, localId };
      },
      clearTaskListCache: (id) => clearedCache.push(id),
    });

    expect(await dir.clearStoredView(globalId)).toBe(true);

    expect((await sceneRepo.get(created.id))?.taskListState).toBeUndefined();
    expect(clearedCache).toEqual([globalId]);
    expect(await dir.readHistory(globalId, { limit: 5 })).toEqual({
      runs: [],
      hasMore: false,
    });
  });

  it("readHistory:倒序分页、hasMore 探测、游标续读;未知对话空页", async () => {
    for (const t of ["一", "二", "三"]) {
      await transcript.appendRunRecord("c3", record(t));
    }

    const page1 = await directory.readHistory("c3", { limit: 2 });
    expect(page1.runs).toHaveLength(2);
    expect(extractFirstText(page1.runs[0]!.record.messages[0]!)).toBe("三");
    expect(extractFirstText(page1.runs[1]!.record.messages[0]!)).toBe("二");
    expect(page1.hasMore).toBe(true);

    const last = page1.runs[1]!;
    const page2 = await directory.readHistory("c3", {
      limit: 2,
      before: { shardId: last.shardId, runIndex: last.record.runIndex },
    });
    expect(page2.runs).toHaveLength(1);
    expect(extractFirstText(page2.runs[0]!.record.messages[0]!)).toBe("一");
    expect(page2.hasMore).toBe(false);

    expect(await directory.readHistory("nope", { limit: 5 })).toEqual({
      runs: [],
      hasMore: false,
    });
  });
});
