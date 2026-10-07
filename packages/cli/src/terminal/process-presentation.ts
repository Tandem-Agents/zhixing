import type { AgentYield } from '@zhixing/core/loop';
import type { SessionPresentationArtifact } from '@zhixing/rpc/session-wire';
import { processText } from '@zhixing/rpc/session-wire';
import { formatBatchDetailLine, formatBatchSummary, formatToolHeader, formatToolResult, formatToolDuration,
  type BatchEventSnapshot } from '../tool-card-format.js';
export { getToolRenderStrategy } from '../tool-render-strategy.js';

export interface ProcessBlock { readonly blockId: string; readonly role: 'thinking' | 'tool' | 'tool-action' | 'tool-error' | 'tool-diff' | 'process'; readonly text: string }
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
  return `◆ ${failed ? '未完成 · ' : sideEffect ? '已修改 · ' : ''}${formatToolHeader(event.name, event.input)}\n  ${formatToolResult(event.name, event.result, event.duration)}${event.truncated ? '（结果片段）' : ''}`;
}
export function processBatch(events: readonly ProcessToolSnapshot[]): string {
  const omitted = Math.max(0, events.length - 3);
  return `◆ ${formatBatchSummary(events)}${omitted ? '\n  ⋮ ' + omitted + ' 项已折叠' : ''}\n${events.slice(-3).map(e => '  ' + formatBatchDetailLine(e) + (e.truncated ? '（结果片段）' : '')).join('\n')}`;
}
export function processArtifactText(artifact: SessionPresentationArtifact): string {
  if (artifact.kind === 'sub-agent-result') {
    const status = { succeeded: '完成', failed: '失败', aborted: '已停止' }[artifact.status];
    return [`◆ 子任务${status} · [${artifact.subAgentId}] · ${artifact.description}`,
      `  ${formatToolDuration(artifact.durationMs)} · 输入 ${artifact.usage.inputTokens} / 输出 ${artifact.usage.outputTokens} · ${artifact.toolUses} 次工具`,
      ...(artifact.errorOrAbortReason ? [`  ${artifact.errorOrAbortReason}`] : []),
      ...(artifact.diagnostics ?? []).map(s => `  ${s}`),
      ...(artifact.wireTruncated ? ['  诊断展示已截断'] : [])].join('\n');
  }
  const count = artifact.changeStats.kind === 'exact'
    ? `+${artifact.changeStats.addedLines} −${artifact.changeStats.removedLines}` : '增删行数不可用';
  const verb = { created: '已新建', modified: '已修改', deleted: '已删除', overwritten: '已覆盖' }[artifact.operation];
  const lines = [`◆ ${verb} ${artifact.path} · ${count}`];
  for (const h of artifact.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const line of h.lines) lines.push(line.type === 'added' ? `+ ${line.newLineNumber}  ${line.content}`
      : line.type === 'removed' ? `-    ${line.content}` : `  ${line.newLineNumber}  ${line.content}`);
  }
  if (artifact.truncated || artifact.wireTruncated) lines.push('… 差异展示已截断');
  return lines.join('\n');
}
