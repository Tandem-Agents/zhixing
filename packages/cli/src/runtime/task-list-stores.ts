/**
 * task_list 持久化层实现 —— TaskListStore 接口的具体后端。
 *
 * 两种实现：
 *   - `ConversationRepoTaskListStore`（cli REPL 模式）：落盘到 conversation
 *     meta.json 的 taskListState 字段。与 `ConversationRepository` 的其它字段
 *     操作共用 per-id 锁 + atomic write，保跨字段并发安全。
 *   - `InMemoryTaskListStore`（cli serve 模式过渡）：进程内 Map 持有。serve 模式
 *     当前没有 conversation meta 持久化路径，先用内存 store 让机制就位；待 serve
 *     模式接入 conversation meta（独立 PR）后切换到 `ConversationRepoTaskListStore`。
 *
 * 选择哪一种：装配方（`cli/repl.ts` / `cli/serve/command.ts`）按场景决定，注入
 * 给 `createBuiltinExtraToolsAssembly()`。
 */

import type { IConversationRepository, TaskListState } from "@zhixing/core";
import type { TaskListStore } from "@zhixing/tools-builtin";

// ─── cli REPL 模式 ───

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

// ─── cli serve 模式（过渡） ───

/**
 * 内存 store —— serve 模式过渡方案。
 *
 * 适用场景：cli serve 启动的 daemon。serve 模式当前没有 conversation meta
 * 持久化层（不用 `ConversationRepository`），无处落盘。先用内存 store 让 task_list
 * 工具机制就位；进程重启 state 丢失是已知限制。
 *
 * **后续升级路径**（标注，独立 PR）：
 *   1. serve 模式接入 `ConversationRepository`（lazy ensure conversation meta 文件）
 *   2. serve 顶层切换到 `ConversationRepoTaskListStore`
 *   3. 删除本类（或保留作为单测 fixture）
 *
 * 与"用户主对话"完全隔离 —— REPL 和 serve 是独立 cli 进程，各自持有自己的
 * store 实例，cache 互不影响。
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
