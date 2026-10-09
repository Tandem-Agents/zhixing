import type { AgentYield } from '@zhixing/core/loop';
import type { SessionPresentationArtifact } from '@zhixing/rpc/session-wire';
import { processText } from '@zhixing/rpc/session-wire';
import { formatBatchDetailLine, formatBatchSummary, formatToolHeader, formatToolResult, formatToolDuration,
  type BatchEventSnapshot } from '../tool-card-format.js';
export { getToolRenderStrategy } from '../tool-render-strategy.js';

export interface ProcessBlock { readonly blockId: string; readonly role: 'thinking' | 'tool' | 'tool-action' | 'tool-error' | 'tool-diff' | 'process'; readonly text: string;
  readonly lines?: readonly { from: number; to: number; decoration?: string }[];
  readonly spans?: readonly { from: number; to: number; semantic: 'added' | 'removed' | 'meta' }[] }
export interface ProcessToolSnapshot extends BatchEventSnapshot { readonly truncated?: boolean }
/** Keep only target fields used by the existing pure card formatter. */
export function processToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['path', 'file_path', 'command', 'pattern', 'url', 'name', 'description', 'action', 'conversationId']) {
    if (typeof input[key] === 'string') result[key] = processText(input[key], 512);
  }
  return result;
}
export function processToolSnapshot(event: Extract<AgentYield, { type: 'tool_end' }>, input: Record<string, unknown>): ProcessToolSnapshot {
  const content = processText(event.result.content, 4096);
  return { name: event.name, input, duration: event.duration,
    result: { content, isError: event.result.isError }, ...(content !== event.result.content ? { truncated: true } : {}) };
}
export function processToolSummary(event: ProcessToolSnapshot, failed = false, sideEffect = false): string {
  return `${failed ? '未完成 · ' : sideEffect ? '已修改 · ' : ''}${formatToolHeader(event.name, event.input)}\n${formatToolResult(event.name, event.result, event.duration)}${event.truncated ? '（结果片段）' : ''}`;
}
export function processBatch(events: readonly ProcessToolSnapshot[]): string {
  const omitted = Math.max(0, events.length - 3);
  return `${formatBatchSummary(events)}${omitted ? '\n⋮ ' + omitted + ' 项已折叠' : ''}\n${events.slice(-3).map(e => formatBatchDetailLine(e) + (e.truncated ? '（结果片段）' : '')).join('\n')}`;
}
export function processArtifactText(artifact: SessionPresentationArtifact): string {
  if (artifact.kind === 'sub-agent-result') {
    const status = { succeeded: '完成', failed: '失败', aborted: '已停止' }[artifact.status];
    return [`子任务${status} · [${artifact.subAgentId}] · ${artifact.description}`,
      `${formatToolDuration(artifact.durationMs)} · 输入 ${artifact.usage.inputTokens} / 输出 ${artifact.usage.outputTokens} · ${artifact.toolUses} 次工具`,
      ...(artifact.errorOrAbortReason ? [artifact.errorOrAbortReason] : []),
      ...(artifact.diagnostics ?? []),
      ...(artifact.wireTruncated ? ['诊断展示已截断'] : [])].join('\n');
  }
  const count = artifact.changeStats.kind === 'exact'
    ? `+${artifact.changeStats.addedLines} −${artifact.changeStats.removedLines}` : '增删行数不可用';
  const verb = { created: '已新建', modified: '已修改', deleted: '已删除', overwritten: '已覆盖' }[artifact.operation];
  const lines = [`${verb} ${artifact.path} · ${count}`];
  for (const h of artifact.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const line of h.lines) lines.push(line.content);
  }
  if (artifact.truncated || artifact.wireTruncated) lines.push('… 差异展示已截断');
  return lines.join('\n');
}

/** Gutter is projection metadata; the cached source and clipboard keep code only. */
export function processArtifactLines(artifact: SessionPresentationArtifact): ProcessBlock['lines'] {
  if (artifact.kind !== 'file-diff') return undefined;
  const decorations: (string | undefined)[] = [undefined];
  const digits = Math.max(1, ...artifact.hunks.flatMap(h => h.lines.map(l => String(l.type === 'removed' ? l.oldLineNumber : l.newLineNumber).length)));
  for (const hunk of artifact.hunks) {
    decorations.push(undefined);
    for (const line of hunk.lines) decorations.push(`${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '} ${String(line.type === 'removed' ? line.oldLineNumber : line.newLineNumber).padStart(digits)}  `);
  }
  let from = 0;
  return processArtifactText(artifact).split('\n').map((line, index) => {
    const value = { from, to: from + line.length + 1, decoration: decorations[index] };
    from = value.to; return value;
  });
}

/** Diff tone comes from the structured artifact, never from user text that
 * happens to start with a plus/minus character in the renderer. */
export function processArtifactSpans(artifact: SessionPresentationArtifact): ProcessBlock['spans'] {
  if (artifact.kind !== 'file-diff') return undefined;
  const kinds: Array<'added' | 'removed' | 'meta' | undefined> = ['meta'];
  for (const hunk of artifact.hunks) { kinds.push('meta'); for (const line of hunk.lines) kinds.push(line.type === 'added' || line.type === 'removed' ? line.type : undefined); }
  const spans: NonNullable<ProcessBlock['spans']>[number][] = []; let offset = 0;
  processArtifactText(artifact).split('\n').forEach((text, i) => { if (kinds[i]) spans.push({ from: offset, to: offset + text.length, semantic: kinds[i]! }); offset += text.length + 1; });
  return spans;
}
