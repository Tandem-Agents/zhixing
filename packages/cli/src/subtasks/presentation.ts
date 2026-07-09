import type { SubAgentResultPresentationArtifact } from "@zhixing/core";
import type { RuntimeSubAgentUsageEntry } from "@zhixing/server";
import { ANCHOR_SUB_AGENT } from "../output/speaker-state.js";
import { stripAnsi } from "../tui/ansi.js";
import { clampLine, stringWidth } from "../tui/line-width.js";
import { layout, tone } from "../tui/style.js";

export type SubtaskStatus = "succeeded" | "failed" | "aborted";

export interface SubtaskDisplayEntry {
  readonly index?: number;
  readonly description: string;
  readonly status: SubtaskStatus;
  readonly tokens: number;
  readonly toolUses: number;
  readonly durationMs: number;
  readonly subId?: string;
  readonly errorOrAbortReason?: string;
}

export interface RenderSubtaskLinesOptions {
  readonly columns?: number;
}

const CONTROL_OR_FORMAT = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu;

export function sanitizeVisibleText(text: string, fallback = "未命名"): string {
  const normalized = stripAnsi(text)
    .replace(CONTROL_OR_FORMAT, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function shortVisibleLabel(
  text: string,
  maxWidth: number,
  fallback = "未命名",
): string {
  const sanitized = sanitizeVisibleText(text, fallback);
  if (maxWidth <= 0) return "";
  if (stringWidth(sanitized) <= maxWidth) return sanitized;
  return stripAnsi(clampLine(sanitized, maxWidth));
}

export function toSubtaskDisplayEntry(
  artifact: SubAgentResultPresentationArtifact,
  index?: number,
): SubtaskDisplayEntry {
  return {
    index,
    description: artifact.description,
    status: artifact.status,
    tokens: artifact.usage.inputTokens + artifact.usage.outputTokens,
    toolUses: artifact.toolUses,
    durationMs: artifact.durationMs,
    subId: artifact.subAgentId.slice(0, 6),
    errorOrAbortReason: artifact.errorOrAbortReason,
  };
}

export function runtimeUsageToSubtaskDisplayEntry(
  entry: RuntimeSubAgentUsageEntry,
): SubtaskDisplayEntry {
  return {
    index: entry.index,
    description: entry.description,
    status: entry.status,
    tokens: entry.tokens,
    toolUses: entry.toolUses ?? 0,
    durationMs: entry.durationMs ?? 0,
    subId: entry.subId,
  };
}

export function renderSubtaskSummaryLines(
  entries: readonly SubtaskDisplayEntry[],
  options: RenderSubtaskLinesOptions = {},
): readonly string[] {
  if (entries.length === 0) return [];
  const columns = options.columns ?? 80;
  const lines: string[] = [fitLine(renderSubtaskAggregate(entries), columns)];
  for (const entry of entries) {
    if (entry.status === "succeeded") continue;
    lines.push(fitLine(renderSubtaskAlert(entry), columns));
  }
  return lines;
}

export function renderSubtaskUsageLines(
  entries: readonly RuntimeSubAgentUsageEntry[],
  options: RenderSubtaskLinesOptions = {},
): readonly string[] {
  if (entries.length === 0) return [];
  const columns = options.columns ?? 80;
  const displayEntries = entries.map(runtimeUsageToSubtaskDisplayEntry);
  const totalTokens = sum(displayEntries, (entry) => entry.tokens);
  const totalTools = sum(displayEntries, (entry) => entry.toolUses);
  const totalDuration = sum(displayEntries, (entry) => entry.durationMs);

  const lines: string[] = [
    fitLine(tone.dim(renderDivider(columns)), columns),
    fitLine(
      `${layout.contentPrefix}${tone.bold("子任务拆分")} ${tone.dim(`(${entries.length} 个)`)}`,
      columns,
    ),
  ];

  for (const entry of displayEntries) {
    lines.push(fitLine(renderSubtaskUsageEntry(entry), columns));
  }

  lines.push(fitLine(tone.dim(renderDivider(columns)), columns));
  lines.push(
    fitLine(
      `${layout.contentPrefix}${tone.dim("子任务总计")}     ${formatTokens(totalTokens)}${tone.dim(` · ${totalTools} 次工具调用 · ${formatDuration(totalDuration)}`)}`,
      columns,
    ),
  );
  return lines;
}

function renderSubtaskAggregate(entries: readonly SubtaskDisplayEntry[]): string {
  const succeeded = entries.filter((entry) => entry.status === "succeeded").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const aborted = entries.filter((entry) => entry.status === "aborted").length;
  const totalTokens = sum(entries, (entry) => entry.tokens);
  const totalTools = sum(entries, (entry) => entry.toolUses);
  const totalDuration = sum(entries, (entry) => entry.durationMs);
  const statusParts = [
    succeeded > 0 ? `${succeeded} 成功` : null,
    failed > 0 ? `${failed} 失败` : null,
    aborted > 0 ? `${aborted} 中止` : null,
  ].filter((part): part is string => part !== null);
  const statusText = statusParts.length > 0 ? statusParts.join(" ") : "无结果";
  return `${layout.contentPrefix}${tone.dim(ANCHOR_SUB_AGENT)} ${entries.length} 个子任务 · ${statusText} ${tone.dim(`(${formatTokens(totalTokens)} · ${totalTools} 次工具调用 · ${formatDuration(totalDuration)})`)}`;
}

function renderSubtaskAlert(entry: SubtaskDisplayEntry): string {
  const label = shortVisibleLabel(entry.description, 24);
  const statusText = entry.status === "failed" ? "失败" : "中止";
  const icon = entry.status === "failed" ? tone.warn("⚠") : tone.dim("⏵");
  const reason = entry.errorOrAbortReason
    ? ` · ${shortVisibleLabel(entry.errorOrAbortReason, 36, "未知原因")}`
    : "";
  const id = entry.subId ? ` · sub ${entry.subId}` : "";
  const index = entry.index !== undefined ? ` #${entry.index}` : "";
  return `${layout.contentPrefix}${tone.dim(ANCHOR_SUB_AGENT)} 子任务${index} ${tone.dim(label)} ${icon} ${statusText}${reason}${id} ${tone.dim(`(${formatTokens(entry.tokens)} · ${entry.toolUses} 次工具调用 · ${formatDuration(entry.durationMs)})`)}`;
}

function renderSubtaskUsageEntry(entry: SubtaskDisplayEntry): string {
  const label = shortVisibleLabel(entry.description, 28);
  const statusIcon =
    entry.status === "succeeded"
      ? tone.success("✓")
      : entry.status === "failed"
        ? tone.warn("⚠")
        : tone.dim("⏵");
  const statusLabel =
    entry.status === "succeeded"
      ? ""
      : tone.dim(` · ${entry.status === "failed" ? "失败" : "中止"}`);
  const index = entry.index !== undefined ? `#${entry.index}` : "#?";
  const subId = entry.subId ? tone.dim(` · sub ${entry.subId}`) : "";
  return `${layout.contentPrefix}${tone.dim(ANCHOR_SUB_AGENT)} ${index} ${tone.dim(label)}  ${statusIcon} ${formatTokens(entry.tokens)}${tone.dim(` · ${entry.toolUses} 次工具调用 · ${formatDuration(entry.durationMs)}`)}${statusLabel}${subId}`;
}

function fitLine(line: string, columns: number): string {
  return clampLine(line, Math.max(1, columns - 1));
}

function renderDivider(columns: number): string {
  const prefixWidth = stringWidth(layout.contentPrefix);
  const width = Math.max(8, columns - 1 - prefixWidth);
  return `${layout.contentPrefix}${"─".repeat(width)}`;
}

function sum<T>(entries: readonly T[], pick: (entry: T) => number): number {
  return entries.reduce((acc, entry) => acc + pick(entry), 0);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
