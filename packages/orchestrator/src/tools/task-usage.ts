/**
 * parseTaskUsageFromMessages —— 从会话消息中解析 Task 工具的 <usage> trailer。
 *
 * Task trailer 是 orchestrator 侧 Task 工具生产的文本协议，解析也必须留在
 * 运行体侧。server 只接收结构化结果，CLI / 飞书等接入面只做展示，避免多
 * 接入面各自理解工具私有格式。
 */

import type { Message } from "@zhixing/core";

export interface TaskUsageEntry {
  /** Task 工具调用顺序索引(1-based,按消息中出现顺序)。 */
  readonly index: number;
  /** Task 工具入参 description；缺失时为空串。 */
  readonly description: string;
  /** 子 agent 总 token(input + output,不含 cache 维度)。 */
  readonly tokens: number;
  /** 成功路径的子工具调用数；failed/aborted 可缺省。 */
  readonly toolUses?: number;
  /** 子 dispatch 持续时间(ms)。 */
  readonly durationMs?: number;
  /** 子 agent id 前缀，供审计追踪。 */
  readonly subId?: string;
  readonly status: "succeeded" | "failed" | "aborted";
}

const USAGE_REGEX =
  /<usage>tokens:\s*(\d+)(?:,\s*tool_uses:\s*(\d+))?,\s*duration_ms:\s*(\d+),\s*sub_id:\s*([0-9a-f]+)<\/usage>/;

const FAILED_PREFIX = /^\[Task "[^"]*" failed(?:\s*\([^)]*\))?:/;
const ABORTED_PREFIX = /^\[Task "[^"]*" aborted:/;

export function parseTaskUsageFromMessages(
  messages: readonly Message[],
): TaskUsageEntry[] {
  const taskCalls = new Map<string, { description: string; order: number }>();
  let nextOrder = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use" || block.name !== "Task") continue;
      const desc =
        typeof block.input?.description === "string"
          ? block.input.description
          : "";
      taskCalls.set(block.id, { description: desc, order: nextOrder });
      nextOrder++;
    }
  }

  if (taskCalls.size === 0) return [];

  const entries: TaskUsageEntry[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const taskCall = taskCalls.get(block.toolUseId);
      if (!taskCall) continue;

      const usageMatch = USAGE_REGEX.exec(block.content);
      if (!usageMatch) continue;

      const status: TaskUsageEntry["status"] = FAILED_PREFIX.test(
        block.content,
      )
        ? "failed"
        : ABORTED_PREFIX.test(block.content)
          ? "aborted"
          : "succeeded";

      entries.push({
        index: taskCall.order + 1,
        description: taskCall.description,
        tokens: Number.parseInt(usageMatch[1]!, 10),
        toolUses:
          usageMatch[2] !== undefined
            ? Number.parseInt(usageMatch[2], 10)
            : undefined,
        durationMs: Number.parseInt(usageMatch[3]!, 10),
        subId: usageMatch[4],
        status,
      });
    }
  }

  entries.sort((a, b) => a.index - b.index);
  return entries;
}
