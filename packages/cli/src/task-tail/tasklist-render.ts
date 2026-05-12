/**
 * `/tasklist` 详细视图渲染 —— 纯函数。
 *
 * 输出多行字符串数组（每行喂给 cliWriter.line）。包含：
 *   - 标题行（任务总数 + 三态分布统计）
 *   - 分隔线
 *   - 任务列表（1-based 序号 + 状态 icon + 内容）
 *
 * 状态 icon 圆形系：● in_progress（brand 青绿）/ ○ pending（dim）/ ✓ completed（green）。
 * 序号与 `/task done <idx>` 一一对应，让用户通过命令引用具体任务。
 *
 * 空 / null state 返回友好提示行，引导用户通过 LLM 或 /task new 创建任务。
 */

import type { TaskItem, TaskListState } from "@zhixing/core";
import { tone } from "../tui/index.js";

const ICON_IN_PROGRESS = "●";
const ICON_PENDING = "○";
const ICON_COMPLETED = "✓";

const SEPARATOR_WIDTH = 33;
const SEPARATOR = "─".repeat(SEPARATOR_WIDTH);

export function renderTaskList(state: TaskListState | null): readonly string[] {
  if (!state || state.items.length === 0) {
    return [
      tone.dim(
        "任务列表为空。LLM 调用 task_list 工具或用 /task new <内容> 创建任务。",
      ),
    ];
  }

  const items = state.items;
  const total = items.length;
  const inProgress = items.filter((t) => t.status === "in_progress").length;
  const pending = items.filter((t) => t.status === "pending").length;
  const completed = items.filter((t) => t.status === "completed").length;

  const header =
    `任务列表 · ${total} 项 · ${inProgress} 进行 · ` +
    `${pending} 待办 · ${completed} 已完成`;

  const lines: string[] = [tone.bold(header), tone.dim(SEPARATOR)];

  for (let i = 0; i < items.length; i++) {
    const t = items[i]!;
    const idx = String(i + 1).padStart(2, " ");
    lines.push(`  ${idx}. ${renderIcon(t.status)} ${t.content}`);
  }

  return lines;
}

function renderIcon(status: TaskItem["status"]): string {
  switch (status) {
    case "in_progress":
      return tone.brand(ICON_IN_PROGRESS);
    case "pending":
      return tone.dim(ICON_PENDING);
    case "completed":
      return tone.success(ICON_COMPLETED);
  }
}
