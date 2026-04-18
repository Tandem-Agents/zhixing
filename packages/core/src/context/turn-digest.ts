/**
 * TurnDigest — 零 LLM 成本的 Turn 轨迹摘要
 *
 * 规格引用：context-architecture.md §3.5 (TurnDigest)
 *
 * 设计原则：
 * - 纯机械提取：从 Turn 数据中提取结构化摘要，不调模型
 * - 系统行为：Agent Loop 每轮自动生成，AI 不可跳过
 * - 注入 Layer 3：为被淘汰的老 Turn 保留线索（"面包屑轨迹"）
 * - 与 task.update / recall_history 三层互补，各司其职
 */

import type { Turn, ToolCallRecord } from "../transcript/types.js";

// ─── 类型 ───

export interface TurnDigest {
  readonly turnIndex: number;
  readonly userMessagePreview: string;
  readonly toolCalls: readonly string[];
  readonly filesModified: readonly string[];
  readonly outcome: "success" | "error" | "interrupted";
}

// ─── 常量 ───

export const DIGEST_PREVIEW_CHARS = 80;
export const MAX_DIGEST_COUNT = 30;

// ─── 提取 ───

/**
 * 从持久化的 Turn 中机械提取摘要。
 *
 * 提取内容：
 * - 用户消息前 80 字符
 * - 工具调用列表（含文件名/命令预览）
 * - 被修改的文件列表（仅 mutation 工具）
 * - 结果（成功/错误）
 */
export function extractTurnDigest(turn: Turn): TurnDigest {
  const userText = turn.userMessage.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const preview =
    userText.length <= DIGEST_PREVIEW_CHARS
      ? userText
      : userText.slice(0, DIGEST_PREVIEW_CHARS) + "…";

  const records = turn.toolCalls ?? [];

  return {
    turnIndex: turn.turnIndex,
    userMessagePreview: preview,
    toolCalls: records.map(formatToolRecord),
    filesModified: extractModifiedFiles(records),
    outcome: records.some((tc) => tc.isError) ? "error" : "success",
  };
}

// ─── 格式化 ───

/**
 * 将 TurnDigest 数组格式化为 Layer 3 注入的轨迹文本。
 *
 * 超过 MAX_DIGEST_COUNT 时，最早的一批合并为分组摘要。
 */
export function formatDigestTrail(digests: readonly TurnDigest[]): string {
  if (digests.length === 0) return "";

  if (digests.length <= MAX_DIGEST_COUNT) {
    return "[轨迹]\n" + digests.map(formatSingleDigest).join("\n");
  }

  const overflowCount = digests.length - MAX_DIGEST_COUNT + 1;
  const merged = digests.slice(0, overflowCount);
  const kept = digests.slice(overflowCount);

  return (
    "[轨迹]\n" +
    [formatGroupSummary(merged), ...kept.map(formatSingleDigest)].join("\n")
  );
}

// ─── 内部辅助 ───

const MUTATION_TOOLS = new Set(["edit", "write", "notebook_edit"]);

function formatToolRecord(tc: ToolCallRecord): string {
  const filePath = tc.input.file_path as string | undefined;
  if (filePath) return `${tc.name}(${shortPath(filePath)})`;

  if (tc.name === "bash") {
    const cmd = (tc.input.command as string | undefined) ?? "";
    const preview = cmd.slice(0, 30).replace(/\n.*/s, "").trim();
    if (preview) return `bash(${preview})`;
  }

  return tc.name;
}

function extractModifiedFiles(records: ToolCallRecord[]): string[] {
  const files = new Set<string>();
  for (const tc of records) {
    if (!MUTATION_TOOLS.has(tc.name)) continue;
    const fp = tc.input.file_path as string | undefined;
    if (fp) files.add(fp);
  }
  return [...files];
}

function formatSingleDigest(d: TurnDigest): string {
  const parts: string[] = [`T${d.turnIndex}: "${d.userMessagePreview}"`];

  if (d.toolCalls.length > 0) {
    parts.push(` → ${summarizeToolCalls(d.toolCalls)}`);
  }

  if (d.outcome === "error") {
    parts.push(" → 错误");
  }

  return parts.join("");
}

function summarizeToolCalls(calls: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(", ");
}

function formatGroupSummary(digests: readonly TurnDigest[]): string {
  const first = digests[0]!.turnIndex;
  const last = digests[digests.length - 1]!.turnIndex;
  const allFiles = new Set(digests.flatMap((d) => [...d.filesModified]));
  return `T${first}-T${last}: ${digests.length} 轮${allFiles.size > 0 ? `，${allFiles.size} 文件修改` : ""}`;
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}
