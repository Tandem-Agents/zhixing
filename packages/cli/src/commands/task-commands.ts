/**
 * task_list cli 命令组 —— /tasklist 与 /task 子命令。
 *
 * 命令注册方式：通过 factory 直接写入 typeahead 的 `tRegistry` + `CommandDispatcher`，
 * 不走 legacy `slashCommands` 字典 + REPL_COMMANDS 桥接 —— 命令模块的现代路径。
 *
 * 子命令解析：/task 顶层命令 + rest 文本，handler 内识别 `new` / `done` 关键字，
 * 或退化为 shortcut（无关键字时视为 `/task new <rest>`）。
 *
 * /task done <token>：token 优先按 1-based index 解析（与 /tasklist 序号一一对应），
 * 失败再按 UUID 前缀匹配。
 *
 * 反馈：所有变更命令成功后写一行 dim 灰确认（"✓ 添加 / 完成 ..."）到 scroll region。
 * 失败转 friendly error 文本，不抛错。
 */

import { randomUUID } from "node:crypto";
import type {
  CommandHandlerContext,
  CommandHandlerResult,
  ICommandRegistry,
  TaskItem,
} from "@zhixing/core";
import type { TaskListService } from "@zhixing/tools-builtin";
import type { CommandDispatcher } from "../command-dispatcher.js";
import { renderTaskList } from "../task-tail/index.js";
import { tone } from "../tui/index.js";

export interface TaskCommandWriter {
  line(text: string): void;
}

export interface TaskCommandsOptions {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly service: TaskListService;
  /**
   * 取当前活跃 conversation id —— 应与 TaskTail 同源（来自 cli REPL state.conversationId）。
   * 缺失时命令返回 ephemeral 友好提示。
   */
  readonly getConversationId: () => string | null | undefined;
  readonly writer: TaskCommandWriter;
}

const EPHEMERAL_REJECT_MESSAGE =
  "任务列表在一次性 run / 定时任务中不可用 —— 仅在持久化对话中工作。";

const TASK_USAGE_HINT =
  "用法：/task new <内容> · /task done <序号或 id> · /task <内容>（new 简写）";

export function registerTaskCommands(opts: TaskCommandsOptions): void {
  opts.registry.register({
    id: "tasklist:repl",
    name: "tasklist",
    description: "查看当前对话的任务列表",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });
  opts.dispatcher.registerHandler("tasklist:repl", async () =>
    handleTasklist(opts),
  );

  opts.registry.register({
    id: "task:repl",
    name: "task",
    description: "管理任务（new <内容> / done <序号或 id>）",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });
  opts.dispatcher.registerHandler("task:repl", async (ctx) =>
    handleTask(ctx, opts),
  );
}

async function handleTasklist(
  opts: TaskCommandsOptions,
): Promise<CommandHandlerResult> {
  const convId = opts.getConversationId();
  if (!convId) {
    opts.writer.line(tone.dim(EPHEMERAL_REJECT_MESSAGE));
    return {};
  }
  for (const line of renderTaskList(opts.service.getCached(convId))) {
    opts.writer.line(line);
  }
  return {};
}

async function handleTask(
  ctx: CommandHandlerContext,
  opts: TaskCommandsOptions,
): Promise<CommandHandlerResult> {
  const convId = opts.getConversationId();
  if (!convId) {
    opts.writer.line(tone.dim(EPHEMERAL_REJECT_MESSAGE));
    return {};
  }

  const rest = String(ctx.args._rest ?? "").trim();
  if (!rest) {
    opts.writer.line(tone.dim(TASK_USAGE_HINT));
    return {};
  }

  const sub = parseSubcommand(rest);
  switch (sub.kind) {
    case "new":
      await addPending(convId, sub.content, opts);
      return {};
    case "done":
      await markDone(convId, sub.token, opts);
      return {};
  }
}

type ParsedSubcommand =
  | { kind: "new"; content: string }
  | { kind: "done"; token: string };

function parseSubcommand(rest: string): ParsedSubcommand {
  const firstSpaceIdx = rest.search(/\s/);
  const firstToken = firstSpaceIdx === -1 ? rest : rest.slice(0, firstSpaceIdx);
  const remainder =
    firstSpaceIdx === -1 ? "" : rest.slice(firstSpaceIdx + 1).trim();

  if (firstToken === "new") {
    return { kind: "new", content: remainder };
  }
  if (firstToken === "done") {
    return { kind: "done", token: remainder };
  }
  // shortcut：无关键字 → 视为 /task new <rest>
  return { kind: "new", content: rest };
}

async function addPending(
  convId: string,
  content: string,
  opts: TaskCommandsOptions,
): Promise<void> {
  if (!content) {
    opts.writer.line(tone.dim("用法：/task new <内容>"));
    return;
  }
  try {
    await opts.service.mutate(convId, (curr) => [
      ...curr,
      { id: randomUUID(), content, status: "pending" },
    ]);
    opts.writer.line(tone.dim(`✓ 添加："${content}"`));
  } catch (err) {
    opts.writer.line(tone.error(`✗ 添加失败：${errorMessage(err)}`));
  }
}

async function markDone(
  convId: string,
  token: string,
  opts: TaskCommandsOptions,
): Promise<void> {
  if (!token) {
    opts.writer.line(tone.dim("用法：/task done <序号或 id>"));
    return;
  }
  const items = opts.service.getAllTasks(convId);
  const target = locateTarget(items, token);
  if (!target) {
    opts.writer.line(
      tone.dim(`未找到任务："${token}"。使用 /tasklist 查看当前列表。`),
    );
    return;
  }
  if (target.status === "completed") {
    opts.writer.line(tone.dim(`任务已是 completed 状态："${target.content}"`));
    return;
  }
  try {
    await opts.service.mutate(convId, (curr) =>
      curr.map((t) =>
        t.id === target.id ? { ...t, status: "completed" } : t,
      ),
    );
    opts.writer.line(tone.dim(`✓ 完成："${target.content}"`));
  } catch (err) {
    opts.writer.line(tone.error(`✗ 完成失败：${errorMessage(err)}`));
  }
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
