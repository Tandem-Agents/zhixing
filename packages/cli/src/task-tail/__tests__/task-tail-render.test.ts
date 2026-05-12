/**
 * renderTaskTail 纯函数渲染契约测试。
 *
 * 用 stripAnsi 比较可视字符，避免 chalk 染色字节锁定测试到具体颜色实现，
 * 让 tone.dim / tone.brand 等 token 升级不破坏测试。
 */

import { describe, it, expect } from "vitest";
import type { TaskListState } from "@zhixing/core";
import { stripAnsi } from "../../tui/index.js";
import { renderTaskTail } from "../task-tail-render.js";

function task(
  id: string,
  content: string,
  status: "pending" | "in_progress" | "completed",
) {
  return { id, content, status };
}

describe("renderTaskTail", () => {
  it("null state → 空字符串（chrome 不渲染 tail 行）", () => {
    expect(renderTaskTail(null)).toBe("");
  });

  it("空 items → 空字符串", () => {
    expect(renderTaskTail({ items: [] })).toBe("");
  });

  it("全 completed（无 pending 无 in_progress）→ 空字符串（列表事实关闭）", () => {
    const state: TaskListState = {
      items: [
        task("a", "done-1", "completed"),
        task("b", "done-2", "completed"),
      ],
    };
    expect(renderTaskTail(state)).toBe("");
  });

  it("单 in_progress：显示其内容 + 进度", () => {
    const state: TaskListState = {
      items: [
        task("a", "实现 task_list cli 命令", "in_progress"),
        task("b", "写文档", "pending"),
        task("c", "测试", "pending"),
        task("d", "调研", "completed"),
      ],
    };
    expect(stripAnsi(renderTaskTail(state))).toBe(
      "实现 task_list cli 命令 (1/4)",
    );
  });

  it("无 in_progress 但有 pending：显示 N 个任务待办", () => {
    const state: TaskListState = {
      items: [
        task("a", "p1", "pending"),
        task("b", "p2", "pending"),
        task("c", "p3", "pending"),
        task("d", "done", "completed"),
      ],
    };
    expect(stripAnsi(renderTaskTail(state))).toBe("3 个任务待办 (1/4)");
  });

  it("多 in_progress 越界：显示首个 + +N 后缀", () => {
    const state: TaskListState = {
      items: [
        task("a", "first", "in_progress"),
        task("b", "second", "in_progress"),
        task("c", "third", "in_progress"),
        task("d", "done", "completed"),
      ],
    };
    expect(stripAnsi(renderTaskTail(state))).toBe("first +2 (1/4)");
  });

  it("进度计数：completed=N / total=M（不计 in_progress / pending 单独）", () => {
    const state: TaskListState = {
      items: [
        task("a", "running", "in_progress"),
        task("b", "wait", "pending"),
        task("c", "x", "completed"),
        task("d", "y", "completed"),
        task("e", "z", "completed"),
      ],
    };
    expect(stripAnsi(renderTaskTail(state))).toBe("running (3/5)");
  });
});
