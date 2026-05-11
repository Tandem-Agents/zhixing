/**
 * 新段首条 user message 拼接 —— 纯函数。
 *
 * 段切换后新段的起始 messages：
 *   [{
 *     role: "user",
 *     content: [{
 *       type: "text",
 *       text: <previous-segment-summary>...</previous-segment-summary>
 *             <recent-turns>...上一段最后 N 轮 raw 叙述...</recent-turns>
 *     }]
 *   }]
 *
 * 时序设计：段切换发生在 turn 边界（assistant 输出完成后），此时用户还没发
 * 新消息。compose 输出的是新段起始 messages；用户下次输入时 agent-loop 自然
 * append 新 user message —— LLM 看到的是连续两条 user message，语义上与
 * "单一 user message 含两个 content block"等价。
 *
 * 字符串叙述化 vs 多 content block：recent-turns 中的 user / assistant /
 * tool_use / tool_result 不再以原生 block 形态存在，而是以文本叙述形式塞进
 * <recent-turns> 标签。失去 block 结构但保留语义信息——这是"段切换把历史
 * 压缩为文本叙述"的本意。
 *
 * 空 summary 兜底：facts/state/active 任一为空时仍渲染空标签，让 LLM 看到
 * 结构（"这部分没什么可说的"），而不是缺标签让 LLM 误以为格式错误。
 */

import type { ContentBlock, Message } from "../../types/messages.js";
import type { ParsedSummary } from "./types.js";

export interface ComposeInput {
  readonly summary: ParsedSummary;
  /** 上一段保留的最后 N 轮 raw 消息（user/assistant 配对完整） */
  readonly recentTurns: readonly Message[];
}

export function composeNewSegmentMessages(input: ComposeInput): Message[] {
  const summaryBlock = renderSummary(input.summary);
  const recentTurnsBlock = renderRecentTurns(input.recentTurns);
  const text = `${summaryBlock}\n\n${recentTurnsBlock}`;
  return [
    {
      role: "user",
      content: [{ type: "text", text }],
    },
  ];
}

// ─── 摘要渲染 ───

function renderSummary(summary: ParsedSummary): string {
  return [
    "<previous-segment-summary>",
    `  <facts>${summary.facts}</facts>`,
    `  <state>${summary.state}</state>`,
    `  <active>${summary.active}</active>`,
    "</previous-segment-summary>",
  ].join("\n");
}

// ─── 最近 turns 叙述化 ───

function renderRecentTurns(messages: readonly Message[]): string {
  if (messages.length === 0) {
    return "<recent-turns></recent-turns>";
  }
  const lines: string[] = ["<recent-turns>"];
  for (const m of messages) {
    lines.push(renderMessageLine(m));
  }
  lines.push("</recent-turns>");
  return lines.join("\n");
}

function renderMessageLine(message: Message): string {
  const blocks = message.content.map(renderBlock).filter((s) => s !== "");
  const body = blocks.length === 0 ? "" : blocks.join(" ");
  return `[${message.role}] ${body}`;
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return `[thinking] ${block.thinking}`;
    case "tool_use": {
      const args = safeStringify(block.input);
      return `[tool_use ${block.name}(${args})]`;
    }
    case "tool_result": {
      const prefix = block.isError
        ? `[tool_result ${block.toolUseId} error]`
        : `[tool_result ${block.toolUseId}]`;
      return `${prefix} ${block.content}`;
    }
    case "image": {
      const src =
        block.source.type === "url" ? block.source.url : "<base64-elided>";
      return `[image ${src}]`;
    }
  }
}

/** 工具入参 JSON 化。超大对象 / 循环引用兜底为占位 —— 不破坏拼装。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}
