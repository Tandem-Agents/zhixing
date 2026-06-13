/**
 * task_list 持久化层实现 —— TaskListStore 接口的具体后端。
 *
 * 三种实现：
 *   - `ConversationRepoTaskListStore`：单 scope 落盘到 conversation meta.json 的
 *     taskListState 字段。与 `ConversationRepository` 的其它字段操作共用 per-id
 *     锁 + atomic write，保跨字段并发安全。
 *   - `RoutedConversationRepoTaskListStore`：按全域 conversationId 路由到所属
 *     scope repo + localId，供核心宿主持久化 user / workscene 等多接入面会话。
 *   - `InMemoryTaskListStore`：进程内 Map 持有，仅作单测 fixture / 临时无盘场景。
 *
 * 选择哪一种：装配方（`cli/repl.ts` / `cli/serve/command.ts`）按场景决定，注入
 * 给 `createBuiltinExtraToolsAssembly()`。
 */

import type { IConversationRepository, TaskListState } from "@zhixing/core";
import type { TaskListStore } from "@zhixing/tools-builtin";

// ─── 持久化 store ───

/**
 * 持久化失败异常 —— store 在 conversation 不存在 / 落盘失败时抛此错。
 *
 * service 内部捕获后回滚 cache，再上抛给工具层 → 转为 isError ToolResult。
 * LLM 收到明确错误消息，与"内存悄悄改了但磁盘没保存"的 split-brain 行为隔离。
 */
export class TaskListPersistenceError extends Error {
  readonly conversationId: string;

  constructor(message: string, conversationId: string) {
    super(message);
    this.name = "TaskListPersistenceError";
    this.conversationId = conversationId;
  }
}

/**
 * cli REPL / 持久化对话场景下的 task_list store。
 *
 * 落盘到 `Conversation.taskListState` 字段；走 `ConversationRepository` 既有
 * per-id 锁 + atomic write 协议。
 *
 * save 前显式 ensure conversation 存在 —— `updateTaskListState` 内部对不存在的
 * conversation 是 no-op（与 clearViewLayerState 对称），但 store 契约要求"持久化
 * 失败必须 throw"，所以这里显式 get 一次拦截 silent no-op。
 */
export class ConversationRepoTaskListStore implements TaskListStore {
  constructor(private readonly convRepo: IConversationRepository) {}

  async load(conversationId: string): Promise<TaskListState | undefined> {
    const conv = await this.convRepo.get(conversationId);
    return conv?.taskListState;
  }

  async save(conversationId: string, state: TaskListState): Promise<void> {
    const conv = await this.convRepo.get(conversationId);
    if (!conv) {
      throw new TaskListPersistenceError(
        `Conversation "${conversationId}" not found — cannot persist task list.`,
        conversationId,
      );
    }
    await this.convRepo.updateTaskListState(conversationId, state);
  }

  async delete(conversationId: string): Promise<void> {
    // 不存在时 updateTaskListState 自然 no-op —— delete 协议要求幂等，OK。
    await this.convRepo.updateTaskListState(conversationId, undefined);
  }
}

export interface ConversationRepoTaskListRoute {
  repo: IConversationRepository;
  /** scope 库内的 conversation id。全域 id 只在路由边界出现。 */
  localId: string;
}

/**
 * 核心宿主 task_list store。
 *
 * host 侧 conversationId 是全域键（如 `ws:<sceneId>:<localId>`），但
 * `ConversationRepository` 只认识所属 scope 内的 localId。该 store 把路由作为
 * 显式依赖注入，保证 task_list 写入、目录 clear、运行态持久化都可共享同一套
 * repo 实例与 per-id 锁，而不是各自偷建仓库导致同一 meta 并发写绕锁。
 */
export class RoutedConversationRepoTaskListStore implements TaskListStore {
  constructor(
    private readonly route: (conversationId: string) => ConversationRepoTaskListRoute,
  ) {}

  async load(conversationId: string): Promise<TaskListState | undefined> {
    const { repo, localId } = this.route(conversationId);
    const conv = await repo.get(localId);
    return conv?.taskListState;
  }

  async save(conversationId: string, state: TaskListState): Promise<void> {
    const { repo, localId } = this.route(conversationId);
    const conv = await repo.get(localId);
    if (!conv) {
      throw new TaskListPersistenceError(
        `Conversation "${conversationId}" not found — cannot persist task list.`,
        conversationId,
      );
    }
    await repo.updateTaskListState(localId, state);
  }

  async delete(conversationId: string): Promise<void> {
    const { repo, localId } = this.route(conversationId);
    await repo.updateTaskListState(localId, undefined);
  }
}

// ─── 内存 fixture ───

/**
 * 内存 store —— 仅用于单测 fixture / 临时无盘场景。
 */
export class InMemoryTaskListStore implements TaskListStore {
  private readonly states = new Map<string, TaskListState>();

  async load(conversationId: string): Promise<TaskListState | undefined> {
    return this.states.get(conversationId);
  }

  async save(conversationId: string, state: TaskListState): Promise<void> {
    this.states.set(conversationId, state);
  }

  async delete(conversationId: string): Promise<void> {
    this.states.delete(conversationId);
  }
}
