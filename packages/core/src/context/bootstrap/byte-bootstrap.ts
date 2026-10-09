import type { ContentBlock, Message } from '../../types/messages.js';
import type { TranscriptByteReader } from '../../transcript/shard/byte-reader.js';
import type { StartupRunProjection } from './build-startup-bootstrap.js';

/** Context-only views. Small runs keep their exact messages; oversized runs
 * retain the original intent and final four messages for the existing budget
 * clamp. These views are never exposed as transcript records or persisted. */
export async function* readBootstrapRunViews(reader: TranscriptByteReader): AsyncGenerator<StartupRunProjection> {
  for await (const source of reader.records()) {
    const { json, ref, runIndex } = source;
    const messages = await json.node(ref, ['messages']);
    if (messages?.kind !== 'array') throw Error('bootstrap-messages');
    if (messages.hi - messages.lo <= 384 * 1024) {
      yield { record: { runIndex, messages: await json.value(ref, ['messages'], 384 * 1024) as Message[] } };
      continue;
    }
    const projected: Message[] = [];
    const indices = [...new Set([0, ...Array.from({ length: Math.min(4, messages.units) }, (_, i) => messages.units - Math.min(4, messages.units) + i)])];
    for (const m of indices) {
      const keys = ['messages', m], content = await json.node(ref, [...keys, 'content']);
      const role = await json.value(ref, [...keys, 'role'], 128);
      if (content?.kind !== 'array' || role !== 'user' && role !== 'assistant') throw Error('bootstrap-message');
      const blocks: ContentBlock[] = []; let remaining = 48 * 1024;
      // Preserve both intent and conclusion even if one message contains many
      // large blocks; never spend the entire budget on its first block.
      const blockIndices = [...new Set([
        ...Array.from({ length: Math.min(8, content.units) }, (_, i) => i),
        ...Array.from({ length: Math.min(8, content.units) }, (_, i) => content.units - Math.min(8, content.units) + i),
      ])];
      for (const [position, b] of blockIndices.entries()) {
        if (position > 0 && b !== blockIndices[position - 1]! + 1) blocks.push({ type: 'text', text: '〔中间内容已省略〕' });
        const key = [...keys, 'content', b], type = await json.value(ref, [...key, 'type'], 128);
        const field = type === 'text' ? 'text' : type === 'tool_result' ? 'content' : type === 'tool_use' ? 'name' : undefined;
        if (!field) continue;
        const node = await json.node(ref, [...key, field]);
        if (node?.kind !== 'string') throw Error('bootstrap-text');
        const cap = Math.min(remaining, type === 'tool_result' ? 200 : type === 'tool_use' ? 1024 : Math.floor(remaining / (blockIndices.length - position)));
        const range = async (offset: number, length: number) => {
          let value = '';
          while (value.length < length && offset + value.length < node.units) {
            const part = await json.textRange(ref, node, offset + value.length);
            if (!part.text.length) throw Error('bootstrap-short-read');
            value += part.text.slice(0, length - value.length);
          }
          // A selected source range can cut through a UTF-16 surrogate pair.
          return value.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/gu, '');
        };
        const text = node.units <= cap || type !== 'text' ? await range(0, Math.min(node.units, cap)) :
          await range(0, Math.floor(cap / 2)) + '\n〔内容过长已截断，完整原文在对话历史中〕\n' + await range(node.units - Math.floor(cap / 2), Math.floor(cap / 2));
        remaining -= text.length;
        if (type === 'text') blocks.push({ type, text });
        else if (type === 'tool_result') blocks.push({ type, content: text, toolUseId: String(await json.value(ref, [...key, 'toolUseId'], 4096)) });
        else blocks.push({ type: 'tool_use', name: text, id: String(await json.value(ref, [...key, 'id'], 4096)), input: {} });
      }
      projected.push({ role, content: blocks });
    }
    if (messages.units > indices.length) projected.splice(1, 0, { role: 'assistant', content: [{ type: 'text', text: '〔本轮过长，中间过程已省略，完整原文在对话历史中〕' }] });
    yield { record: { runIndex, messages: projected }, oversized: true };
  }
}
