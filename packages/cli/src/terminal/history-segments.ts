import type { RunRecordWithRef } from '@zhixing/core/transcript';
import type { TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import { projectBodyHistory } from './body-projection.js';

export interface TerminalHistorySegment {
  readonly blockId: string;
  readonly contentOffset: number;
  readonly role: string;
  readonly text: string;
  readonly final: boolean;
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
        const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking :
          block.type === 'tool_use' ? `◆ ${block.name}` : block.type === 'tool_result' ? block.content : '[图像材料]';
        if (typeof text !== 'string') continue;
        for (const part of textFragments(text)) yield { blockId, role: message.role, text: part.text, contentOffset: part.offset, final: part.final };
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
        const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking :
          block.type === 'tool_use' ? `◆ ${block.name}` : block.type === 'tool_result' ? block.content : '[图像材料]';
        if (typeof text !== 'string') continue;
        for (let end = text.length; end > 0;) {
          let start = Math.max(0, end - stride);
          if (start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff &&
            text.charCodeAt(start - 1) >= 0xd800 && text.charCodeAt(start - 1) <= 0xdbff) start--;
          yield { blockId, role: message.role, text: text.slice(start, end), contentOffset: start, final: end === text.length };
          end = start;
        }
      }
    }
  }
}

/** Preserve the authoritative source and ordering while resolving Markdown
 * with the same parser and logical EOF used by the live producer. The caller
 * owns the single bounded parser workspace for this entire iterator. */
export async function* projectRenderedHistoryReverse(runsNewestFirst: readonly RunRecordWithRef[]): AsyncGenerator<TerminalDisplaySegment> {
  for (const { record, shardId } of runsNewestFirst) {
    for (let messageIndex = record.messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = record.messages[messageIndex]!;
      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = message.content[blockIndex]!;
        const blockId = `${shardId}:${record.runIndex}:${messageIndex}:${blockIndex}`;
        const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking :
          block.type === 'tool_use' ? `◆ ${block.name}` : block.type === 'tool_result' ? block.content : '[图像材料]';
        if (typeof text !== 'string') continue;
        const kind = block.type === 'text' && message.role === 'assistant' ? 'markdown' : 'plain';
        for await (const item of projectBodyHistory(text, kind, 'reverse')) {
          yield { blockId, contentOffset: item.contentOffset, role: message.role, text: item.text,
            final: item.body.end, body: item.body };
        }
      }
    }
  }
}
