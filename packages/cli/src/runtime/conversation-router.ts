/**
 * 对话仓储路由核 —— 工作模式下 task_list / 段切换持久化的单一路由决策点。
 *
 * 问题背景：`builtinExtraTools`(含 TaskListService)与 `segmentDeps` 在 REPL
 * bootstrap 时一次性装配并跨 reload 持久，二者都在构造期绑定到主项目的
 * `ConversationRepository`。进入工作模式后，task_list 与段切换元数据必须落到
 * 工作场景独立的 conversation meta，而非主项目——但这两个消费者实例已无法重建。
 *
 * 解法：在它们与具体 repo 之间插一层 `IConversationRepository` 代理，所有方法
 * 透传到当前 `active` 目标。模式切换事务在 turn 边界 `setActive` 切换目标，
 * 两个消费者无感知、无需重建。
 *
 * 路由策略是「按当前活跃模式」而非「按 conversationId 推断」：applyModeSwitch
 * 把 active repo 与 active ConversationRuntimeState 在同一原子事务里同步切换，
 * 任意时刻在跑的 conversationId 必与 active repo 同域，故无需跨 scope 的 convId
 * 冲突检测（刻意不做，避免过度抽象）。
 */

import type {
  Conversation,
  CreateConversationOptions,
  IConversationRepository,
  SegmentMeta,
  TaskListState,
} from "@zhixing/core";

export class RoutingConversationRepository
  implements IConversationRepository
{
  private active: IConversationRepository;

  constructor(initial: IConversationRepository) {
    this.active = initial;
  }

  /** 切换路由目标 —— 由 applyModeSwitch 在 turn 边界原子事务内调用。 */
  setActive(target: IConversationRepository): void {
    this.active = target;
  }

  list(opts?: { includeArchived?: boolean }): Promise<Conversation[]> {
    return this.active.list(opts);
  }

  get(id: string): Promise<Conversation | null> {
    return this.active.get(id);
  }

  create(opts: CreateConversationOptions): Promise<Conversation> {
    return this.active.create(opts);
  }

  rename(id: string, name: string): Promise<Conversation> {
    return this.active.rename(id, name);
  }

  archive(id: string, archived: boolean): Promise<Conversation> {
    return this.active.archive(id, archived);
  }

  delete(id: string): Promise<void> {
    return this.active.delete(id);
  }

  ensureDefault(): Promise<Conversation> {
    return this.active.ensureDefault();
  }

  findLatest(): Promise<string | null> {
    return this.active.findLatest();
  }

  touch(id: string): Promise<void> {
    return this.active.touch(id);
  }

  clearViewLayerState(id: string): Promise<void> {
    return this.active.clearViewLayerState(id);
  }

  updateTaskListState(
    id: string,
    state: TaskListState | undefined,
  ): Promise<void> {
    return this.active.updateTaskListState(id, state);
  }

  appendSegmentMeta(id: string, meta: SegmentMeta): Promise<void> {
    return this.active.appendSegmentMeta(id, meta);
  }
}
