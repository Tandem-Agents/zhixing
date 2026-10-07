import { stripVTControlCharacters } from 'node:util';
import { stripPresentationFromAgentYield, type AgentYield } from '@zhixing/core/loop';
import type { FileDiffPresentationArtifact, SubAgentResultPresentationArtifact, SessionEventProjection } from '@zhixing/core/types';
import type { TurnContext } from '@zhixing/core/types';
import { validateAgentYield, validateSessionEventProjection } from '@zhixing/core/protocol';

export type SessionPresentationProfile = 'default' | 'bounded-v1';
export const SESSION_PROCESS_METHOD = 'session.process';
export const PROCESS_WIRE_BYTES = 192 * 1024;
export const PROCESS_ARTIFACT_BYTES = 128 * 1024;
export interface SessionProcessSource {
  readonly conversationId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly assignmentId?: string;
  readonly streamEpoch?: number;
  readonly sourceSeq: number;
  readonly lineage?: string;
  readonly turnOrigin?: TurnContext['turnOrigin'];
  /** Host-local monotonic admission time; display eligibility, not fact identity. */
  readonly observedAt?: number;
}
export type SessionPresentationArtifact = (FileDiffPresentationArtifact | SubAgentResultPresentationArtifact) & {
  readonly wireTruncated?: boolean;
};
/** Observer projection, deliberately NOT a StreamFrame or an ACK/digest source. */
export interface SessionProcessProjection {
  readonly version: 1;
  readonly source: SessionProcessSource;
  readonly payload:
    | { readonly kind: 'yield'; readonly delta: AgentYield; readonly artifact?: SessionPresentationArtifact }
    | { readonly kind: 'event'; readonly event: SessionEventProjection }
    | { readonly kind: 'closed' }
    | { readonly kind: 'gap'; readonly reason: string };
  readonly truncated?: boolean;
}

/** Reject before copying/stringifying an unbounded graph. Limits measure encoded bytes. */
export function boundedProcessValue<T>(value: T, maximum = PROCESS_WIRE_BYTES): T {
  let left = maximum;
  const seen = new Set<object>();
  const walk = (item: unknown, depth: number): void => {
    if (depth > 24) throw Error('process-projection-depth');
    if (item === undefined) return;
    if (typeof item === 'string') {
      if (item.length > left || Buffer.byteLength(item) > left) throw Error('process-projection-capacity');
      left -= Buffer.byteLength(JSON.stringify(item));
    } else if (item && typeof item === 'object') {
      if (seen.has(item)) throw Error('process-projection-cycle');
      seen.add(item); left -= 2;
      for (const key in item) if (Object.hasOwn(item, key)) {
        walk(key, depth + 1); left -= 2; walk((item as Record<string, unknown>)[key], depth + 1);
      }
      seen.delete(item);
    } else {
      if (typeof item === 'number' && !Number.isFinite(item)) throw Error('process-projection-number');
      if (typeof item !== 'number' && typeof item !== 'boolean' && item !== null) throw Error('process-projection-value');
      left -= 24;
    }
    if (left < 0) throw Error('process-projection-capacity');
  };
  walk(value, 0); return value;
}

export function processText(value: string, bytes: number): string {
  if (bytes < 2) return '';
  let text = stripVTControlCharacters(value.slice(0, bytes)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ');
  while (Buffer.byteLength(JSON.stringify(text)) > bytes) text = text.slice(0, Math.floor(text.length * 0.8));
  if (/[\ud800-\udbff]$/u.test(text)) text = text.slice(0, -1);
  return text;
}

/** Only the two approved artifacts, copied field-by-field with independent display budgets. */
export function projectSessionArtifact(input: unknown, toolCallId: string): SessionPresentationArtifact | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  if (value.kind === 'sub-agent-result') {
    if (value.toolCallId !== toolCallId || typeof value.subAgentId !== 'string' || value.subAgentId.length > 512 || typeof value.description !== 'string' ||
        !['succeeded', 'failed', 'aborted'].includes(String(value.status))) return;
    const usage = value.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
    if (!usage || !finite(usage.inputTokens) || !finite(usage.outputTokens) || !finite(value.durationMs) || !finite(value.toolUses)) return;
    let left = 2048, truncated = value.wireTruncated === true;
    const diagnostic = (s: string) => { const p = processText(s, Math.max(0, left)); left -= Buffer.byteLength(JSON.stringify(p)); truncated ||= p !== s; return p; };
    // Preserve the terminal cause before optional diagnostic detail exhausts
    // the shared budget. Reprojection must retain the original clip marker.
    const error = typeof value.errorOrAbortReason === 'string' ? diagnostic(value.errorOrAbortReason) : undefined;
    const diagnostics: string[] = [];
    if (Array.isArray(value.diagnostics)) for (const line of value.diagnostics) {
      if (typeof line !== 'string') continue;
      if (left <= 16 || diagnostics.length >= 16) { truncated = true; break; }
      diagnostics.push(diagnostic(line));
    }
    const description = processText(value.description, 1024);
    const result: SessionPresentationArtifact = { kind: 'sub-agent-result', toolCallId, subAgentId: value.subAgentId,
      description, status: value.status as 'succeeded' | 'failed' | 'aborted',
      durationMs: value.durationMs, toolUses: value.toolUses, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      ...(error ? { errorOrAbortReason: error } : {}), ...(diagnostics.length ? { diagnostics } : {}),
      ...(truncated || description !== value.description ? { wireTruncated: true } : {}) };
    return boundedProcessValue(result, PROCESS_ARTIFACT_BYTES);
  }
  if (value.kind !== 'file-diff' || typeof value.path !== 'string' ||
      !['created', 'modified', 'deleted', 'overwritten'].includes(String(value.operation)) || !Array.isArray(value.hunks)) return;
  const stats = value.changeStats as FileDiffPresentationArtifact['changeStats'];
  if (!stats || (stats.kind !== 'unavailable' && (stats.kind !== 'exact' || !finite(stats.addedLines) || !finite(stats.removedLines)))) return;
  const result: FileDiffPresentationArtifact & { wireTruncated?: boolean } = { kind: 'file-diff', path: processText(value.path, 2048),
    operation: value.operation as FileDiffPresentationArtifact['operation'],
    changeStats: stats.kind === 'unavailable' ? { kind: 'unavailable', reason: 'input-too-large' } : { kind: 'exact', addedLines: stats.addedLines, removedLines: stats.removedLines },
    hunks: [], truncated: value.truncated === true || value.wireTruncated === true || processText(value.path, 2048) !== value.path };
  let count = 0, bytes = 4096;
  for (const raw of value.hunks) {
    if (result.hunks.length >= 6 || count >= 300) { result.truncated = result.wireTruncated = true; break; }
    if (!raw || !Array.isArray(raw.lines) || ![raw.oldStart, raw.oldLines, raw.newStart, raw.newLines].every(finite)) return;
    const hunk: FileDiffPresentationArtifact['hunks'][number] = { oldStart: raw.oldStart, oldLines: raw.oldLines, newStart: raw.newStart, newLines: raw.newLines, lines: [] };
    for (const line of raw.lines) {
      if (hunk.lines.length >= 80 || count >= 300 || bytes > PROCESS_ARTIFACT_BYTES - 2048) { result.truncated = result.wireTruncated = true; break; }
      if (!line || typeof line.content !== 'string') return;
      const content = processText(line.content, 1024);
      if (content !== line.content) result.truncated = result.wireTruncated = true;
      if (line.type === 'added' && finite(line.newLineNumber)) hunk.lines.push({ type: 'added', newLineNumber: line.newLineNumber, content });
      else if (line.type === 'removed' && finite(line.oldLineNumber)) hunk.lines.push({ type: 'removed', oldLineNumber: line.oldLineNumber, content });
      else if (line.type === 'context' && finite(line.oldLineNumber) && finite(line.newLineNumber)) hunk.lines.push({ type: 'context', oldLineNumber: line.oldLineNumber, newLineNumber: line.newLineNumber, content });
      else return;
      count++; bytes += Buffer.byteLength(JSON.stringify(hunk.lines.at(-1))) + 128;
    }
    result.hunks.push(hunk);
  }
  return boundedProcessValue(result, PROCESS_ARTIFACT_BYTES);
}

export function projectProcessYield(source: SessionProcessSource, delta: AgentYield): SessionProcessProjection {
  const artifact = delta.type === 'tool_end' ? projectSessionArtifact(delta.result.presentation, delta.id) : undefined;
  let projected = stripPresentationFromAgentYield(delta), truncated = false;
  if (projected.type === 'thinking_delta') {
    let tail = projected.thinking.slice(-8192);
    if (/^[\udc00-\udfff]/u.test(tail)) tail = tail.slice(1);
    const thinking = processText(tail, 32 * 1024);
    truncated = thinking !== projected.thinking;
    projected = { type: 'thinking_delta', thinking };
  }
  if (projected.type === 'tool_start') {
    const input: Record<string, unknown> = {};
    for (const key of ['path', 'file_path', 'command', 'pattern', 'url', 'name', 'description', 'action', 'conversationId']) {
      const value = projected.input[key];
      if (typeof value === 'string') input[key] = processText(value, 512);
    }
    projected = { type: 'tool_start', id: projected.id, name: projected.name, input };
  }
  if (projected.type === 'tool_end') {
    const content = processText(projected.result.content, 24 * 1024); truncated = content !== projected.result.content;
    projected = { type: 'tool_end', id: projected.id, name: projected.name, duration: projected.duration,
      result: { content,
        ...(projected.result.isError === undefined ? {} : { isError: projected.result.isError }),
        ...(projected.result.committedToUser === undefined ? {} : { committedToUser: projected.result.committedToUser }),
      } };
  }
  const result: SessionProcessProjection = { version: 1, source, payload: { kind: 'yield', delta: projected, ...(artifact ? { artifact } : {}) }, ...(truncated ? { truncated: true } : {}) };
  return boundedProcessValue(result);
}

/** Existing diagnostic events keep their semantic fields; free text is display
 * bounded before serialization. No invented lifecycle or successful outcome. */
export function projectProcessEvent(event: SessionEventProjection): SessionEventProjection {
  let result: SessionEventProjection = event;
  switch (event.event) {
    case 'retry:exhausted': result = { ...event, payload: { ...event.payload, lastError: processText(event.payload.lastError, 2048) } }; break;
    case 'segment:transition_failed': result = { ...event, payload: { ...event.payload, error: processText(event.payload.error, 2048) } }; break;
    case 'segment:emergency_floor': result = { ...event, payload: { ...event.payload, error: processText(event.payload.error, 2048) } }; break;
    case 'lifecycle:hook_failed': result = { ...event, payload: { ...event.payload, error: processText(event.payload.error, 2048) } }; break;
    case 'lifecycle:warning': result = { ...event, payload: { ...event.payload, message: processText(event.payload.message, 2048) } }; break;
    case 'tool:child_start': result = { ...event, payload: { ...event.payload, label: processText(event.payload.label, 1024) } }; break;
  }
  return boundedProcessValue(result, 64 * 1024);
}

export function processForProfile(value: SessionProcessProjection, profile: SessionPresentationProfile): SessionProcessProjection {
  validateSessionProcessProjection(value);
  if (value.payload.kind !== 'yield') return value;
  const delta = stripPresentationFromAgentYield(value.payload.delta);
  const artifact = profile === 'bounded-v1' && delta.type === 'tool_end' ? projectSessionArtifact(value.payload.artifact, delta.id) : undefined;
  return { ...value, payload: { kind: 'yield', delta, ...(artifact ? { artifact } : {}) } };
}

export function validateSessionProcessProjection(input: unknown): asserts input is SessionProcessProjection {
  boundedProcessValue(input);
  if (!input || typeof input !== 'object') throw Error('process-projection-shape');
  const value = input as SessionProcessProjection;
  const exact = (item: object, keys: readonly string[]) => {
    for (const key in item) if (Object.hasOwn(item, key) && !keys.includes(key)) throw Error('process-projection-field');
  };
  exact(value, ['version', 'source', 'payload', 'truncated']);
  if (value.version !== 1 || !value.source || !value.payload || typeof value.payload !== 'object') throw Error('process-projection-shape');
  exact(value.source, ['conversationId', 'turnId', 'runId', 'assignmentId', 'streamEpoch', 'sourceSeq', 'lineage', 'turnOrigin', 'observedAt']);
  for (const key of ['conversationId', 'turnId', 'runId', 'assignmentId', 'lineage'] as const) {
    const id = value.source[key]; if (id !== undefined && (typeof id !== 'string' || !id || id.length > 1024)) throw Error('process-source-identity');
  }
  if (!value.source.conversationId || (!value.source.runId && !value.source.turnId) ||
      !Number.isSafeInteger(value.source.sourceSeq) || value.source.sourceSeq < 0 ||
      (value.source.streamEpoch !== undefined && (!Number.isSafeInteger(value.source.streamEpoch) || value.source.streamEpoch < 0)) ||
      (value.source.observedAt !== undefined && !finite(value.source.observedAt))) throw Error('process-source-identity');
  if ((value.source.assignmentId === undefined) !== (value.source.streamEpoch === undefined) ||
      (value.source.assignmentId !== undefined && value.source.runId === undefined)) throw Error('process-assignment-identity');
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') throw Error('process-projection-truncation');
  switch (value.payload.kind) {
    case 'yield':
      exact(value.payload, ['kind', 'delta', 'artifact']);
      // This DTO is already bounded above; a materialized observer value is
      // not an inline canonical frame and must not be externalized again.
      validateAgentYield(value.payload.delta);
      break;
    case 'event':
      exact(value.payload, ['kind', 'event']); validateSessionEventProjection(value.payload.event); break;
    case 'closed': exact(value.payload, ['kind']); break;
    case 'gap':
      exact(value.payload, ['kind', 'reason']);
      if (typeof value.payload.reason !== 'string' || value.payload.reason.length > 1024) throw Error('process-gap-reason');
      break;
    default: throw Error('process-projection-kind');
  }
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
