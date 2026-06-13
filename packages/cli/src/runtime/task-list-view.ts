/**
 * TaskListViewCache —— task_list 状态的接入面只读视图缓存。
 *
 * 数据源是宿主的会话级变更组播(session.changed change:"taskList",turn 内
 * 工具写入即推送):cli 不再持有 TaskListService 写实例,屏底任务区(TaskTail)
 * 与 /tasklist 命令读此缓存。消费面与 TaskListService 的订阅窄面同形
 * (subscribe / getCached),TaskTail 零改挂接。
 */

import type { TaskListState } from "@zhixing/core";

export interface TaskListViewEvent {
  readonly conversationId: string;
  readonly state: TaskListState | null;
}

export class TaskListViewCache {
  private readonly states = new Map<string, TaskListState | null>();
  private readonly subscribers = new Set<(event: TaskListViewEvent) => void>();

  /** 喂入一次宿主推送的状态快照(null = 已清空)。 */
  apply(conversationId: string, state: TaskListState | null): void {
    this.states.set(conversationId, state);
    for (const listener of [...this.subscribers]) {
      try {
        listener({ conversationId, state });
      } catch {
        // 订阅者错误隔离——视图缓存不被渲染层异常传染
      }
    }
  }

  getCached(conversationId: string): TaskListState | null {
    return this.states.get(conversationId) ?? null;
  }

  subscribe(listener: (event: TaskListViewEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
}
