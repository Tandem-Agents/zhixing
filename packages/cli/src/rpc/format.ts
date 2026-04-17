/**
 * RPC 输出格式化
 *
 * 核心格式：
 * - 默认：缩进 2 空格的 JSON，部分字段 chalk 染色（method 名、taskId 等）
 * - --raw：单行紧凑 JSON，机器可读
 * - 错误：红色头 + 详情缩进
 *
 * 设计要点：
 * - 染色仅作用于 stdout 是 TTY 时（chalk 自动检测）
 * - 流式 delta 单独走 formatDelta，避免每次都 stringify 整个对象
 */

import chalk from "chalk";

export function formatResult(result: unknown, raw: boolean): string {
  if (raw) return JSON.stringify(result);
  if (result === undefined) return chalk.dim("(no result)");
  if (result === null) return chalk.dim("null");
  return JSON.stringify(result, null, 2);
}

export function formatError(code: number, message: string, data?: unknown): string {
  const head = chalk.red(`✗ Error [${code}]`) + " " + message;
  if (data === undefined) return head;
  const detail =
    typeof data === "object"
      ? JSON.stringify(data, null, 2)
      : String(data);
  return head + "\n" + chalk.dim(indent(detail, 2));
}

export function formatNotificationHeader(method: string): string {
  return chalk.cyan("◆ ") + chalk.bold(method);
}

export function formatNotificationParams(params: unknown, raw: boolean): string {
  if (raw) return JSON.stringify(params);
  if (params === undefined || params === null) return "";
  return chalk.dim(JSON.stringify(params, null, 2));
}

/**
 * 流式 delta 的轻量格式化——只渲染人类关心的字段。
 * - text_delta → 直接打印文本（无前缀）
 * - tool_start → 灰色一行 "→ tool_name"
 * - tool_end → 状态色 ✓/✗
 * - 其他 → 不打印（避免噪音）
 */
export function formatStreamDelta(delta: unknown): string | null {
  if (!delta || typeof delta !== "object") return null;
  const d = delta as { type?: string };

  if (d.type === "text_delta") {
    return (delta as { text: string }).text;
  }

  if (d.type === "tool_start") {
    const t = delta as { name: string; input?: Record<string, unknown> };
    const inputStr = t.input ? chalk.dim(` ${JSON.stringify(t.input).slice(0, 80)}`) : "";
    return "\n" + chalk.cyan(`→ ${t.name}`) + inputStr + "\n";
  }

  if (d.type === "tool_end") {
    const t = delta as { duration: number; result?: { isError?: boolean } };
    const ok = !t.result?.isError;
    const mark = ok ? chalk.green("✓") : chalk.red("✗");
    return chalk.dim(`  ${mark} ${t.duration}ms\n`);
  }

  // 其他事件不打印（assistant_message / turn_complete 等都从 result 拿到）
  return null;
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
