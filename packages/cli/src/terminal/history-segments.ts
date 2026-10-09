import type { RunRecordWithRef } from '@zhixing/core/transcript';
import type { ContentBlock } from '@zhixing/core/types';
import type { BodyFragmentMetadata } from '@zhixing/terminal-ui/body-model';
import type { TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import { projectBodyHistory } from './body-projection.js';

export interface TerminalHistorySegment {
  readonly blockId: string;
  readonly groupId?: string;
  readonly contentOffset: number;
  readonly role: string;
  readonly text: string;
  readonly final: boolean;
}

function historyIdentity(block: ContentBlock, role: string, run: string, message: number) {
  const tool = block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.toolUseId : undefined;
  return { role: block.type === 'thinking' ? 'thinking' : block.type === 'tool_use' ? 'tool' :
    block.type === 'tool_result' ? (block.isError ? 'tool-error' : 'tool') : role,
    groupId: tool ? `${run}:tool:${tool}` : `${run}:${message}:${block.type === 'thinking' ? 'thinking' : role}` };
}

/** Iterate original strings without whole-page concatenation, whitespace
 * replacement or UTF-8 materialization. Offsets remain original UTF-16 offsets. */
export function* textFragments(text: string, bytes = 32 * 1024): Generator<{ text: string; offset: number; final: boolean }> {
  if (!Number.isSafeInteger(bytes) || bytes < 4) throw Error('Invalid terminal fragment budget.');
  const stride = Math.floor(bytes / 3);
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + stride);
    const previous = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    // The conservative three-byte stride is only a starting point. Pack the
    // remaining UTF-8 capacity instead of tripling ASCII/mixed-text IO calls.
    let used = Buffer.byteLength(text.slice(offset, end));
    while (end < text.length) {
      const code = text.charCodeAt(end), following = text.charCodeAt(end + 1);
      const pair = code >= 0xd800 && code <= 0xdbff && following >= 0xdc00 && following <= 0xdfff;
      const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (used + size > bytes) break;
      used += size; end += pair ? 2 : 1;
    }
    yield { text: text.slice(offset, end), offset, final: end === text.length };
    offset = end;
  }
}

/** Existing transcript pages remain the history authority. This is a bounded
 * display projection, not another transcript store or a fixed-record tail. */
export function* projectHistorySegments(runsNewestFirst: readonly RunRecordWithRef[]): Generator<TerminalHistorySegment> {
  for (let index = runsNewestFirst.length - 1; index >= 0; index--) {
    const { record, shardId } = runsNewestFirst[index]!;
    for (let messageIndex = 0; messageIndex < record.messages.length; messageIndex++) {
      const message = record.messages[messageIndex]!;
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex]!;
        const blockId = `${shardId}:${record.runIndex}:${messageIndex}:${blockIndex}`;
        const tail = block.type === 'thinking' ? historyThinkingTail(block.thinking) : undefined;
        const text = block.type === 'text' ? block.text : block.type === 'thinking' ? tail!.text :
          block.type === 'tool_use' ? block.name : block.type === 'tool_result' ? block.content : '[图像材料]';
        if (typeof text !== 'string') continue;
        for (const part of textFragments(text)) yield { blockId, ...historyIdentity(block, message.role, `${shardId}:${record.runIndex}`, messageIndex), text: part.text, contentOffset: (tail?.offset ?? 0) + part.offset, final: part.final };
      }
    }
  }
}

/** Newest content first for a prepend-only disk index. It never builds an array
 * of fragments for one long block, and offsets keep their original identity. */
export function* projectHistorySegmentsReverse(runsNewestFirst: readonly RunRecordWithRef[]): Generator<TerminalHistorySegment> {
  const stride = Math.floor(32 * 1024 / 3);
  for (const { record, shardId } of runsNewestFirst) {
    for (let messageIndex = record.messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = record.messages[messageIndex]!;
      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = message.content[blockIndex]!;
        const blockId = `${shardId}:${record.runIndex}:${messageIndex}:${blockIndex}`;
        const tail = block.type === 'thinking' ? historyThinkingTail(block.thinking) : undefined;
        const text = block.type === 'text' ? block.text : block.type === 'thinking' ? tail!.text :
          block.type === 'tool_use' ? block.name : block.type === 'tool_result' ? block.content : '[图像材料]';
        if (typeof text !== 'string') continue;
        for (let end = text.length; end > 0;) {
          let start = Math.max(0, end - stride);
          if (start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff &&
            text.charCodeAt(start - 1) >= 0xd800 && text.charCodeAt(start - 1) <= 0xdbff) start--;
          yield { blockId, ...historyIdentity(block, message.role, `${shardId}:${record.runIndex}`, messageIndex), text: text.slice(start, end), contentOffset: (tail?.offset ?? 0) + start, final: end === text.length };
          end = start;
        }
      }
    }
  }
}

/** Preserve the authoritative source and ordering while resolving Markdown
 * with the same parser and logical EOF used by the live producer. The caller
 * owns the single bounded parser workspace for this entire iterator. */
export interface TerminalHistoryPosition { readonly blockId: string; readonly contentOffset: number }
export async function* projectRenderedHistoryReverse(runsNewestFirst: readonly RunRecordWithRef[], before?: TerminalHistoryPosition): AsyncGenerator<TerminalDisplaySegment> {
  let reached = before === undefined;
  for (const { record, shardId } of runsNewestFirst) {
    for (let messageIndex = record.messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = record.messages[messageIndex]!;
      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = message.content[blockIndex]!;
        const blockId = `${shardId}:${record.runIndex}:${messageIndex}:${blockIndex}`;
        if (!reached) {
          if (blockId !== before!.blockId) continue;
          reached = true;
          if (before!.contentOffset === 0) continue;
        }
        const tail = block.type === 'thinking' ? historyThinkingTail(block.thinking) : undefined;
        const text = block.type === 'text' ? block.text : block.type === 'thinking' ? tail!.text :
          block.type === 'tool_use' ? block.name : block.type === 'tool_result' ? block.content : '[图像材料]';
        if (typeof text !== 'string') continue;
        const kind = block.type === 'text' && message.role === 'assistant' ? 'markdown' : 'plain';
        for await (const item of projectBodyHistory(text, kind, 'reverse')) {
          const contentOffset = (tail?.offset ?? 0) + item.contentOffset;
          if (blockId === before?.blockId && contentOffset >= before.contentOffset) continue;
          if (blockId === before?.blockId && contentOffset + item.text.length > before.contentOffset) throw Error('terminal-history-position-changed');
          yield { blockId, contentOffset, ...historyIdentity(block, message.role, `${shardId}:${record.runIndex}`, messageIndex), text: item.text,
            final: item.body.end, body: tail ? shiftThinkingBody(item.body, tail.offset) : item.body };
        }
      }
    }
  }
  if (!reached) throw Error('terminal-history-position-missing');
}

/** History remains authoritative; only the bounded display tail is materialized. */
export function historyThinkingTail(text: string): { text: string; offset: number } {
  let offset = Math.max(0, text.length - 8192);
  if (offset && /[\udc00-\udfff]/u.test(text[offset]!)) offset++;
  return { text: text.slice(offset), offset };
}
function shiftThinkingBody(body: BodyFragmentMetadata, offset: number): BodyFragmentMetadata {
  return { ...body, context: { nodes: body.context.nodes.map(node => ({ ...node,
    from: node.from + offset, to: node.to + offset,
    ...(node.origin === undefined ? {} : { origin: node.origin + offset }),
    runs: node.runs.map(run => ({ ...run, from: run.from + offset, to: run.to + offset })),
  })) } };
}
