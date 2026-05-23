/**
 * MCP `tools/call` 结果 → 知行 ToolResult 的转换。
 *
 * MCP 返回的 content 是多模态块数组（text / image / audio / resource / resource_link），
 * 而知行 ToolResult.content 是单一字符串。这里拼接文本块、把非文本块降级为占位标记
 * （当前不内联二进制 / 资源），并透传 isError。纯函数，便于独立单测。
 */

import type { ToolResult } from "@zhixing/core";

/** 只取我们消费的字段；结构与 SDK 的 CallToolResult 兼容（SDK 类型字段更多）。 */
export interface McpCallOutcome {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  toolResult?: unknown;
}

export function toToolResult(outcome: McpCallOutcome): ToolResult {
  const isError = outcome.isError === true;

  if (Array.isArray(outcome.content)) {
    const text = outcome.content
      .map((item) =>
        item.type === "text" && typeof item.text === "string"
          ? item.text
          : `[${item.type} content omitted]`,
      )
      .join("\n");
    return { content: text, isError };
  }

  // 不带标准 content 的兼容返回：序列化 toolResult 兜底。
  if (outcome.toolResult !== undefined) {
    return { content: safeStringify(outcome.toolResult), isError };
  }

  return { content: "", isError };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
