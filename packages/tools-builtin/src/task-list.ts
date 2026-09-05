/** task_list Agent binding: schema, validation and product presentation only. */

import type { TaskItem, TaskListState } from "@zhixing/core/conversation";
import type { ToolDefinition, ToolResult } from "@zhixing/core";
import {
  ConversationApplicationError,
  type ConversationTaskListToolApplication,
  type ConversationTaskListToolItemDraft,
} from "@zhixing/core/conversation/application";

/** Agent binding: schema/presentation only; Conversation owns the command. */
export function createTaskListTool(
  getConversationId: () => string | undefined,
  application: ConversationTaskListToolApplication,
): ToolDefinition {
  return {
      name: "task_list",
      description: TASK_LIST_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description:
              "The complete task list after this update. Each call REPLACES the entire list — include all tasks you want to keep, not just the changed ones.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Optional stable identifier for this task. Reuse the same id across set() calls to update an existing task; omit for new tasks (a uuid will be assigned).",
                },
                content: {
                  type: "string",
                  description:
                    "Short task description (≤ 80 chars). Use imperative form, e.g., 'Read src/index.ts'.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description:
                    "Task state. Keep ONE in_progress at a time. Use 'completed' once done — do not delete completed tasks within the same conversation segment.",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["items"],
      },
      isReadOnly: false,
      isParallelSafe: false,
      needsPermission: false,
      async call(input, ctx): Promise<ToolResult> {
        // ─── Step 1: ephemeral 拒绝 ───
        // 一次性 run（定时任务等 ephemeral）的 ALS 中 conversationId === undefined，
        // task_list 无 conversation 绑定可落 —— 拒绝调用且不改 state，避免污染
        // 其他 conversation 的 cache（PR-C1 审查 Bug-1）。
        const conversationId = getConversationId();
        if (!conversationId) {
          return {
            content:
              "task_list is unavailable in this run: no conversation context bound. " +
              "This tool only works in persistent conversations — not in one-shot runs " +
              "(ephemeral) or scheduled task executions.",
            isError: true,
          };
        }

        // ─── Step 2: 输入校验 + normalize ───
        const validated = validateAndNormalize(input);
        if (!validated.ok) {
          return { content: validated.error, isError: true };
        }

        try {
          const result = await application.replace({
            conversationId,
            toolCallId: ctx.toolCallId,
            items: validated.items,
          });
          return {
            content: `${renderSummary(result.taskList)}\nThis update will take effect when the current turn completes successfully.`,
          };
        } catch (err) {
          if (
            err instanceof ConversationApplicationError &&
            (err.reason === "task-list-operation-required" ||
              err.reason === "task-list-assignment-required")
          ) {
            return { content: err.message, isError: true };
          }
          return {
            content: `Failed to prepare task list update: ${err instanceof Error ? err.message : String(err)}.`,
            isError: true,
          };
        }
      },
    };
}

// ─── 工具描述 ───

const TASK_LIST_TOOL_DESCRIPTION =
  "Maintain a structured task list to plan and track multi-step work in this conversation.\n\n" +
  "Use this when the user gives you a non-trivial task that requires multiple steps, " +
  "or when you want to communicate a plan to the user.\n\n" +
  "Single action `set(items)`: replaces the entire task list with the provided items. " +
  "Each item has: content (description), status (pending | in_progress | completed), " +
  "and an optional stable id (for tracking the same task across set() calls).\n\n" +
  "Guidelines:\n" +
  "- Keep AT MOST ONE task in_progress at a time — finish or pause before starting the next.\n" +
  "- Each set() REPLACES the full list. To keep a task, include it again with its existing id.\n" +
  "- Use 'completed' to mark finished tasks; do not delete them within the same segment.\n" +
  "- Skip the tool for trivial single-step tasks — it's overhead for the user.\n" +
  "- This tool requires a persistent conversation context. It is unavailable in one-shot runs " +
  "(ephemeral) and scheduled task executions; calls in those contexts will fail with an error.";

// ─── 输入校验 + normalize ───

type TaskItemInput = {
  id?: string;
  content: string;
  status: TaskItem["status"];
};

const VALID_STATUSES: ReadonlySet<TaskItem["status"]> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

type ValidationResult =
  | { ok: true; items: ConversationTaskListToolItemDraft[] }
  | { ok: false; error: string };

function validateAndNormalize(
  input: Record<string, unknown>,
): ValidationResult {
  const rawItems = input.items;
  if (!Array.isArray(rawItems)) {
    return { ok: false, error: "Invalid input: 'items' must be an array." };
  }

  const normalized: ConversationTaskListToolItemDraft[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i] as TaskItemInput | undefined;
    if (!raw || typeof raw !== "object") {
      return {
        ok: false,
        error: `Invalid input: items[${i}] must be an object.`,
      };
    }
    if (typeof raw.content !== "string" || raw.content.trim() === "") {
      return {
        ok: false,
        error: `Invalid input: items[${i}].content must be a non-empty string.`,
      };
    }
    if (!VALID_STATUSES.has(raw.status)) {
      return {
        ok: false,
        error: `Invalid input: items[${i}].status must be one of "pending" | "in_progress" | "completed".`,
      };
    }
    normalized.push({
      ...(typeof raw.id === "string" && raw.id !== ""
        ? { id: raw.id }
        : {}),
      content: raw.content,
      status: raw.status,
    });
  }

  return { ok: true, items: normalized };
}

// ─── 工具结果渲染 ───

function renderSummary(state: TaskListState): string {
  if (state.items.length === 0) {
    return "Task list cleared (0 items).";
  }
  const counts = countByStatus(state.items);
  const lines = state.items.map((t, i) => {
    const mark =
      t.status === "completed"
        ? "[x]"
        : t.status === "in_progress"
          ? "[~]"
          : "[ ]";
    return `${i + 1}. ${mark} ${t.content}`;
  });
  return [
    `Task list updated (${state.items.length} items: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed):`,
    ...lines,
  ].join("\n");
}

function countByStatus(items: readonly TaskItem[]): {
  pending: number;
  inProgress: number;
  completed: number;
} {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of items) {
    if (t.status === "pending") pending++;
    else if (t.status === "in_progress") inProgress++;
    else if (t.status === "completed") completed++;
  }
  return { pending, inProgress, completed };
}
