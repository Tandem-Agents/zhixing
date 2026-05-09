/**
 * recall_history 工具 — 取回历史 turn / tool_use 的原始内容
 *
 * 设计动机：
 *   视图层 ToolResultAnchorStage 把历史 tool_result 锚化成简短结构化文本
 *  （如 `[read foo.ts, 1235 lines]`），数据层 tier-compressor 还会做字符截断。
 *   LLM 大多数情况下重调工具拿原文（read 重读 / grep 重搜成本极低），但少数
 *   场景重调不可行：文件已删 / web_fetch 内容已变 / tier-compressor T4 把
 *   tool_use input 也截断了。这时调 recall_history 取磁盘当前状态。
 *
 * 输入（二选一）：
 *   - turnRange: { start, end }  按 turn index（1-based，含端点）取整轮
 *   - toolUseId: string          按 tool_use id 精确取单次工具调用记录
 *
 * 输出形态：
 *   - 当前磁盘状态的人读 + LLM 读友好文本
 *   - compact frontier 之前的 turn 已被压缩成 marker.summary，不可恢复 raw
 *   - frontier 之后的 turn 完整 raw（受 transcript 体积约束）
 *
 * 依赖注入：
 *   工具不依赖 orchestrator —— 通过 RecallHistoryDeps 接收 transcriptStore
 *   loadRaw 与 conversationId provider，由装配方桥接。
 */

import type {
  CompactMarker,
  RawTranscript,
  ToolDefinition,
  ToolResult,
  Turn,
} from "@zhixing/core";

const MAX_RESULT_CHARS = 50_000;

export interface RecallHistoryDeps {
  /** 加载磁盘原始结构。输入 conversationId，输出 RawTranscript。 */
  loadRaw: (conversationId: string) => Promise<RawTranscript>;
  /**
   * 取当前 conversation id；ephemeral / 无 conversation 上下文返 undefined。
   * 工具检测到 undefined 时返回友好的"非对话场景"错误，不做兜底（避免编造）。
   */
  getConversationId: () => string | undefined;
}

export function createRecallHistoryTool(
  deps: RecallHistoryDeps,
): ToolDefinition {
  return {
    name: "recall_history",
    description:
      "Recall raw historical content from the current conversation transcript. " +
      "Use this when a tool result was anchored or truncated and you need the original. " +
      "Prefer re-running the original tool (re-read file / re-run grep) when feasible — " +
      "this tool reads the on-disk transcript snapshot, which loses content older than the " +
      "compact frontier. Two input modes: `turnRange` for whole turns by 1-based index, " +
      "or `toolUseId` for a single tool call.",
    inputSchema: {
      type: "object",
      properties: {
        turnRange: {
          type: "object",
          description:
            "Inclusive range of turn indices (1-based) to recall. " +
            "Indexes outside frontier or transcript bounds are reported, not silently dropped.",
          properties: {
            start: { type: "number", description: "First turn index (inclusive)" },
            end: { type: "number", description: "Last turn index (inclusive)" },
          },
          required: ["start", "end"],
        },
        toolUseId: {
          type: "string",
          description:
            "Exact tool_use id to look up. Returns the matching tool call record " +
            "(name / input / result / isError) regardless of which turn it lived in.",
        },
      },
    },

    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    subAgentSafe: true,
    maxResultChars: MAX_RESULT_CHARS,

    async call(input): Promise<ToolResult> {
      const parsed = parseInput(input as Record<string, unknown>);
      if (parsed.kind === "error") {
        return { content: parsed.message, isError: true };
      }

      const conversationId = deps.getConversationId();
      if (!conversationId) {
        return {
          content:
            "recall_history is only available inside a persisted conversation. " +
            "The current run has no conversation id (e.g. ephemeral one-shot / scheduled task).",
          isError: true,
        };
      }

      let raw: RawTranscript;
      try {
        raw = await deps.loadRaw(conversationId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Failed to load transcript ${conversationId}: ${message}`,
          isError: true,
        };
      }

      if (parsed.kind === "toolUseId") {
        return formatToolUseLookup(parsed.toolUseId, raw);
      }
      return formatTurnRange(parsed.range, raw);
    },
  };
}

// ─── 输入解析 ───

type ParsedInput =
  | { kind: "error"; message: string }
  | { kind: "turnRange"; range: { start: number; end: number } }
  | { kind: "toolUseId"; toolUseId: string };

function parseInput(input: Record<string, unknown>): ParsedInput {
  const turnRange = input.turnRange;
  const toolUseId = input.toolUseId;
  const hasRange = turnRange !== undefined && turnRange !== null;
  const hasId = typeof toolUseId === "string" && toolUseId.length > 0;

  if (hasRange && hasId) {
    return {
      kind: "error",
      message:
        "recall_history accepts exactly one of `turnRange` or `toolUseId`, not both.",
    };
  }
  if (!hasRange && !hasId) {
    return {
      kind: "error",
      message:
        "recall_history requires either `turnRange: { start, end }` or `toolUseId: <string>`.",
    };
  }

  if (hasId) {
    return { kind: "toolUseId", toolUseId: toolUseId as string };
  }

  // turnRange 校验
  const range = turnRange as Record<string, unknown>;
  const start = range.start;
  const end = range.end;
  if (typeof start !== "number" || typeof end !== "number") {
    return {
      kind: "error",
      message: "`turnRange.start` and `turnRange.end` must both be numbers.",
    };
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return {
      kind: "error",
      message: "`turnRange.start` and `turnRange.end` must be finite numbers.",
    };
  }
  const startInt = Math.floor(start);
  const endInt = Math.floor(end);
  if (startInt < 1 || endInt < 1) {
    return {
      kind: "error",
      message: "`turnRange` indices are 1-based; start/end must be >= 1.",
    };
  }
  if (endInt < startInt) {
    return {
      kind: "error",
      message: "`turnRange.end` must be >= `turnRange.start`.",
    };
  }
  return { kind: "turnRange", range: { start: startInt, end: endInt } };
}

// ─── 格式化：toolUseId 查找 ───

function formatToolUseLookup(
  toolUseId: string,
  raw: RawTranscript,
): ToolResult {
  // ToolCallRecord.id 是 tool_use 协议层 id 的直接持久化（buildRecord 写入 use.id）。
  // 直接 record.id === toolUseId 比较，无需位置/内容反推，并行同参 tool_use 也
  // 自动正确区分。老 transcript（id 字段引入前）record.id 为 undefined，与任何
  // LLM 提供的 toolUseId 字符串都不等 —— 自然返 not found，与"已 compact 不可达"
  // 语义对等。
  for (const turn of raw.turns) {
    for (const call of turn.toolCalls ?? []) {
      if (call.id !== undefined && call.id === toolUseId) {
        return {
          content: renderToolCallRecord(turn.turnIndex, call.id, call),
        };
      }
    }
  }

  // 未找到：区分"已被 compact"与"id 错 / 老格式 transcript"两种成因
  const frontierNote = raw.compactBefore
    ? ` Note: ${raw.compactBefore.turnsCompacted} earlier turn(s) were compacted ` +
      "and their tool_use ids are no longer reachable on disk."
    : "";
  return {
    content:
      `Tool use id "${toolUseId}" not found in current transcript.` + frontierNote,
    isError: true,
  };
}

function renderToolCallRecord(
  turnIndex: number,
  toolUseId: string,
  call: { name: string; input: Record<string, unknown>; result: string; isError?: boolean },
): string {
  const status = call.isError ? "error" : "ok";
  return [
    `=== Tool call (turn ${turnIndex}, id ${toolUseId}, ${status}) ===`,
    `tool: ${call.name}`,
    `input: ${JSON.stringify(call.input)}`,
    "",
    "result:",
    call.result,
  ].join("\n");
}

// ─── 格式化：turnRange ───

function formatTurnRange(
  range: { start: number; end: number },
  raw: RawTranscript,
): ToolResult {
  const sections: string[] = [];

  if (raw.turns.length === 0) {
    return {
      content: buildEmptyTranscriptNote(raw.compactBefore, range),
    };
  }

  const firstAvailable = raw.turns[0]!.turnIndex;
  const lastAvailable = raw.turns[raw.turns.length - 1]!.turnIndex;

  // 范围与磁盘可达区间求交
  const effectiveStart = Math.max(range.start, firstAvailable);
  const effectiveEnd = Math.min(range.end, lastAvailable);

  // 范围完全在 frontier 之前
  if (range.end < firstAvailable) {
    return {
      content: buildOutOfRangeNote(range, raw.compactBefore, firstAvailable, lastAvailable),
      isError: true,
    };
  }

  // 范围完全在磁盘 turn 之后（用户传了不存在的 turn index）
  if (range.start > lastAvailable) {
    return {
      content:
        `Turn range ${range.start}-${range.end} is beyond the last persisted turn ` +
        `(${lastAvailable}). The transcript currently has turns ${firstAvailable}-${lastAvailable}.`,
      isError: true,
    };
  }

  // 头部：若请求超过 frontier 之前，提示用户 frontier 之前的内容仅可见 summary
  if (raw.compactBefore && range.start < firstAvailable) {
    sections.push(buildCompactSummaryHeader(raw.compactBefore, range.start, firstAvailable - 1));
  }

  // 命中区间内的 turns
  for (const turn of raw.turns) {
    if (turn.turnIndex < effectiveStart || turn.turnIndex > effectiveEnd) continue;
    sections.push(renderTurn(turn));
  }

  // 尾部：若请求超过磁盘最后一个 turn，提示截断（理论上 effectiveEnd 已限边界，不会触达）
  if (range.end > lastAvailable) {
    sections.push(
      `\n[Note: requested up to turn ${range.end}, transcript currently ends at ${lastAvailable}.]`,
    );
  }

  return { content: sections.join("\n\n") };
}

function buildCompactSummaryHeader(
  compact: CompactMarker,
  requestedStart: number,
  beforeFrontier: number,
): string {
  return [
    `=== Turns ${requestedStart}-${beforeFrontier} (compacted, raw not available) ===`,
    `${compact.turnsCompacted} earlier turn(s) were compacted into the frontier summary below.`,
    "",
    compact.summary,
  ].join("\n");
}

function buildEmptyTranscriptNote(
  compact: CompactMarker | null,
  range: { start: number; end: number },
): string {
  if (compact) {
    return [
      `No turns persisted after the compact frontier. ` +
        `Requested range ${range.start}-${range.end} fell entirely within the compacted region.`,
      "",
      `=== Frontier summary (${compact.turnsCompacted} turns compacted) ===`,
      compact.summary,
    ].join("\n");
  }
  return `Transcript has no turns yet. Requested range ${range.start}-${range.end} cannot be satisfied.`;
}

function buildOutOfRangeNote(
  range: { start: number; end: number },
  compact: CompactMarker | null,
  firstAvailable: number,
  lastAvailable: number,
): string {
  const compactNote = compact
    ? ` ${compact.turnsCompacted} earlier turn(s) were compacted; their raw content is no longer on disk. ` +
      `Frontier summary:\n\n${compact.summary}`
    : ` No compact frontier exists; turn ${range.start} simply doesn't exist.`;
  return (
    `Turn range ${range.start}-${range.end} is entirely before the first persisted turn ` +
    `(${firstAvailable}). Persisted turns: ${firstAvailable}-${lastAvailable}.${compactNote}`
  );
}

function renderTurn(turn: Turn): string {
  const lines: string[] = [];
  lines.push(`=== Turn ${turn.turnIndex} (${turn.timestamp}) ===`);
  lines.push(`user: ${extractMessageText(turn.userMessage)}`);
  lines.push(`assistant: ${extractMessageText(turn.assistantMessage)}`);

  if (turn.toolCalls && turn.toolCalls.length > 0) {
    lines.push("tools:");
    for (const call of turn.toolCalls) {
      const status = call.isError ? "error" : "ok";
      lines.push(`  - ${call.name}(${JSON.stringify(call.input)}) → [${status}]`);
      // 单工具 result 行内截断（避免 anchor 化前的 raw 把整个 turn 撑爆）；
      // 完整内容靠 toolUseId 模式查询。
      const resultPreview = truncateInline(call.result, 400);
      lines.push(`    ${resultPreview}`);
    }
  }
  return lines.join("\n");
}

function extractMessageText(msg: import("@zhixing/core").Message): string {
  const texts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "tool_use") {
      texts.push(`<tool_use ${block.name}(${JSON.stringify(block.input)})>`);
    } else if (block.type === "tool_result") {
      texts.push(`<tool_result ${block.toolUseId}>`);
    }
  }
  return texts.join(" ");
}

function truncateInline(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [+${text.length - max} chars truncated; query by toolUseId for full]`;
}
