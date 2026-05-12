/**
 * renderTaskList 纯函数渲染契约测试 —— /tasklist 命令的详细视图输出。
 */

import { describe, it, expect } from "vitest";
import type { TaskListState } from "@zhixing/core";
import { stripAnsi } from "../../tui/index.js";
import { renderTaskList } from "../tasklist-render.js";

function task(
  id: string,
  content: string,
  status: "pending" | "in_progress" | "completed",
) {
  return { id, content, status };
}

describe("renderTaskList", () => {
  it("null state → 单行友好提示", () => {
    const lines = renderTaskList(null);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain("任务列表为空");
  });

  it("空 items → 单行友好提示", () => {
    const lines = renderTaskList({ items: [] });
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain("任务列表为空");
  });

  it("含三态混合 → 标题 + 分隔线 + 序号 + icon + 内容", () => {
    const state: TaskListState = {
      items: [
        task("a", "实现 task_list cli 命令", "in_progress"),
        task("b", "写文档", "pending"),
        task("c", "测试", "pending"),
        task("d", "调研", "completed"),
      ],
    };
    const visible = renderTaskList(state).map(stripAnsi);

    expect(visible).toEqual([
      "任务列表 · 4 项 · 1 进行 · 2 待办 · 1 已完成",
      "─".repeat(33),
      "   1. ● 实现 task_list cli 命令",
      "   2. ○ 写文档",
      "   3. ○ 测试",
      "   4. ✓ 调研",
    ]);
  });

  it("单任务 → 序号 1（无前导空格挤压）", () => {
    const state: TaskListState = {
      items: [task("a", "唯一任务", "pending")],
    };
    const visible = renderTaskList(state).map(stripAnsi);
    expect(visible[2]).toBe("   1. ○ 唯一任务");
  });

  it("超过 9 项：序号宽度仍正确对齐", () => {
    const state: TaskListState = {
      items: Array.from({ length: 12 }, (_, i) =>
        task(`t${i}`, `task-${i}`, "pending"),
      ),
    };
    const visible = renderTaskList(state).map(stripAnsi);
    // 序号 1-9 前补一空格保持两位宽度；10/11/12 自然占两位
    expect(visible[2]).toBe("   1. ○ task-0");
    expect(visible[11]).toBe("  10. ○ task-9");
    expect(visible[13]).toBe("  12. ○ task-11");
  });

  it("标题反映三态分布", () => {
    const state: TaskListState = {
      items: [
        task("a", "x", "in_progress"),
        task("b", "y", "in_progress"),
        task("c", "z", "completed"),
      ],
    };
    const header = stripAnsi(renderTaskList(state)[0]!);
    expect(header).toBe("任务列表 · 3 项 · 2 进行 · 0 待办 · 1 已完成");
  });

  it("全 pending 也显示（与 tail 的'全 completed 隐藏'语义不同）", () => {
    const state: TaskListState = {
      items: [task("a", "p1", "pending"), task("b", "p2", "pending")],
    };
    const lines = renderTaskList(state);
    expect(lines.length).toBeGreaterThan(1);
    expect(stripAnsi(lines[0]!)).toContain("2 项 · 0 进行 · 2 待办");
  });

  it("全 completed 也显示完整列表（/tasklist 是查询命令，不像 tail 那样隐藏）", () => {
    const state: TaskListState = {
      items: [
        task("a", "done-1", "completed"),
        task("b", "done-2", "completed"),
      ],
    };
    const lines = renderTaskList(state);
    expect(lines.length).toBe(4);
    expect(stripAnsi(lines[2]!)).toBe("   1. ✓ done-1");
  });
});
