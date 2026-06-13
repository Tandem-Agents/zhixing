/**
 * task-list-actions 测试 —— /task new·done 的宿主侧动作语义。
 *
 * 锁住:
 *   - add / done 都经 service.mutate 返回写后权威快照
 *   - 参数缺失 / 未找到 / 已完成时不写,返回当前快照和用户可读文案
 *   - done 的 token 优先按 /tasklist 1-based 序号解析,再退化为 id 前缀
 */

import { describe, expect, it } from "vitest";
import type { TaskItem, TaskListState } from "@zhixing/core";
import {
  applyTaskListAction,
  type TaskListMutator,
} from "../task-list-actions.js";

function item(
  id: string,
  content: string,
  status: TaskItem["status"] = "pending",
): TaskItem {
  return { id, content, status };
}

function makeService(initial: readonly TaskItem[] = []) {
  let state: TaskListState = { items: [...initial] };
  const writes: TaskListState[] = [];
  const service: TaskListMutator = {
    getAllTasks: () => state.items,
    async mutate(_conversationId, mutator) {
      state = { items: [...mutator(state.items)] };
      writes.push(state);
      return state;
    },
  };
  return { service, writes, get state() { return state; } };
}

describe("applyTaskListAction", () => {
  it("add:追加 pending 任务并返回写后快照", async () => {
    const h = makeService([item("a", "已有")]);

    const result = await applyTaskListAction(h.service, "conv-1", {
      kind: "add",
      content: "写周报",
    });

    expect(result.ok).toBe(true);
    expect(result.taskList?.items).toHaveLength(2);
    expect(result.taskList?.items[1]).toMatchObject({
      content: "写周报",
      status: "pending",
    });
    expect(h.writes).toHaveLength(1);
  });

  it("add:空白内容不写并返回当前快照", async () => {
    const h = makeService([item("a", "已有")]);

    const result = await applyTaskListAction(h.service, "conv-1", {
      kind: "add",
      content: "   ",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("/task new");
    expect(result.taskList).toEqual({ items: [item("a", "已有")] });
    expect(h.writes).toHaveLength(0);
  });

  it("done:优先按 1-based 序号完成任务", async () => {
    const h = makeService([item("a", "第一个"), item("b", "第二个")]);

    const result = await applyTaskListAction(h.service, "conv-1", {
      kind: "done",
      token: " 2 ",
    });

    expect(result.ok).toBe(true);
    expect(result.taskList?.items[0]?.status).toBe("pending");
    expect(result.taskList?.items[1]?.status).toBe("completed");
  });

  it("done:序号无效时按唯一 id 前缀匹配", async () => {
    const h = makeService([
      item("abc-111", "整理材料"),
      item("def-222", "发邮件"),
    ]);

    const result = await applyTaskListAction(h.service, "conv-1", {
      kind: "done",
      token: "def",
    });

    expect(result.ok).toBe(true);
    expect(result.taskList?.items[1]?.status).toBe("completed");
  });

  it("done:缺 token / 未找到 / 已完成均不写", async () => {
    const h = makeService([item("a", "已做", "completed")]);

    await expect(
      applyTaskListAction(h.service, "conv-1", { kind: "done", token: "" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      applyTaskListAction(h.service, "conv-1", { kind: "done", token: "x" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      applyTaskListAction(h.service, "conv-1", { kind: "done", token: "1" }),
    ).resolves.toMatchObject({ ok: false });

    expect(h.writes).toHaveLength(0);
  });
});
