/**
 * 任务区单行摘要渲染 —— 纯函数。
 *
 * 输出"纯任务文本"，不含分隔符前缀（分隔符由 chrome 协议在拼接到状态行时绘制）。
 * 空列表 / 全完成 / state=null 返回空字符串 → ScreenController 不渲染 tail 行。
 *
 * 显示策略：
 *   - 有 in_progress：显示第一个 in_progress 内容；多个时附 `+N` 标注越界
 *   - 无 in_progress 但有 pending：显示 "<N> 个任务待办" 提示
 *   - 全 completed：返回空（列表"事实关闭"）
 *
 * 视觉层级：任务名 default 色（主信息），进度 dim 灰（附加信息）。
 */

import type { TaskListState } from "@zhixing/core";
import { tone } from "../tui/index.js";

export function renderTaskTail(state: TaskListState | null): string {
  if (!state || state.items.length === 0) return "";

  const items = state.items;
  const inProgress = items.filter((t) => t.status === "in_progress");
  const pending = items.filter((t) => t.status === "pending").length;
  const completed = items.filter((t) => t.status === "completed").length;
  const total = items.length;

  if (inProgress.length === 0 && pending === 0) return "";

  let main: string;
  if (inProgress.length === 0) {
    main = `${pending} 个任务待办`;
  } else if (inProgress.length === 1) {
    main = inProgress[0]!.content;
  } else {
    main = `${inProgress[0]!.content} ${tone.dim(`+${inProgress.length - 1}`)}`;
  }

  return `${main} ${tone.dim(`(${completed}/${total})`)}`;
}
