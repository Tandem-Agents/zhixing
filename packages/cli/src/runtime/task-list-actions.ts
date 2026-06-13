/**
 * task_list 用户侧动作执行体 —— /task new·done 的核心逻辑。
 *
 * 宿主侧装配为 session.taskListUpdate RPC 的执行实现(写单点在宿主的
 * TaskListService);动作语义与反馈文案在此单一定义,接入面命令层只分发。
 */

import { randomUUID } from "node:crypto";
import type { TaskItem, TaskListState } from "@zhixing/core";

export type TaskListAction =
  | { kind: "add"; content: string }
  | { kind: "done"; token: string };

export interface TaskListActionResult {
  ok: boolean;
  /** 用户可读反馈(成功与失败都有——接入面原样呈现) */
  message: string;
  /** 动作后的宿主权威快照(失败时为当前快照),供发起接入面同步只读视图。 */
  taskList: TaskListState | null;
}

/** 动作执行所需的 service 窄面(宿主 TaskListService 满足) */
export interface TaskListMutator {
  getAllTasks(conversationId: string): readonly TaskItem[];
  mutate(
    conversationId: string,
    mutator: (current: readonly TaskItem[]) => readonly TaskItem[],
  ): Promise<TaskListState>;
}

function snapshot(service: TaskListMutator, conversationId: string): TaskListState {
  return { items: [...service.getAllTasks(conversationId)] };
}

export async function applyTaskListAction(
  service: TaskListMutator,
  conversationId: string,
  action: TaskListAction,
): Promise<TaskListActionResult> {
  if (action.kind === "add") {
    const content = action.content.trim();
    if (!content) {
      return {
        ok: false,
        message: "用法：/task new <内容>",
        taskList: snapshot(service, conversationId),
      };
    }
    const taskList = await service.mutate(conversationId, (curr) => [
      ...curr,
      { id: randomUUID(), content, status: "pending" },
    ]);
    return { ok: true, message: `✓ 添加："${content}"`, taskList };
  }

  // action.kind === "done"
  const token = action.token.trim();
  if (!token) {
    return {
      ok: false,
      message: "用法：/task done <序号或 id>",
      taskList: snapshot(service, conversationId),
    };
  }
  const items = service.getAllTasks(conversationId);
  const target = locateTarget(items, token);
  if (!target) {
    return {
      ok: false,
      message: `未找到任务："${token}"。使用 /tasklist 查看当前列表。`,
      taskList: snapshot(service, conversationId),
    };
  }
  if (target.status === "completed") {
    return {
      ok: false,
      message: `任务已是 completed 状态："${target.content}"`,
      taskList: snapshot(service, conversationId),
    };
  }
  const taskList = await service.mutate(conversationId, (curr) =>
    curr.map((t) => (t.id === target.id ? { ...t, status: "completed" } : t)),
  );
  return { ok: true, message: `✓ 完成："${target.content}"`, taskList };
}

function locateTarget(
  items: readonly TaskItem[],
  token: string,
): TaskItem | null {
  // 优先 1-based index（与 /tasklist 序号对应）
  if (/^\d+$/.test(token)) {
    const idx = Number.parseInt(token, 10);
    if (idx >= 1 && idx <= items.length) return items[idx - 1] ?? null;
  }
  // 退化为 UUID 前缀匹配（用户从 /tasklist 不直接看到 id，但可从工具结果复制）
  const matches = items.filter((t) => t.id.startsWith(token));
  if (matches.length === 1) return matches[0]!;
  return null;
}
