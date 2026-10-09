import type { ConversationBodyCursor } from '@zhixing/core/contracts';
import type { TranscriptBodyCursor } from '@zhixing/core/transcript';
import type { TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import { sliceBodyNodes } from '@zhixing/terminal-ui/body-model';
import { HistoryBodyRangeCache } from './body-projection.js';

/** Only a source already read from durable history can enter the cold tier.
 * Live output, notices and unpersisted tool presentations have no such locator. */
export type DisplayReplaySource = { readonly conversationId: string; readonly length: number; readonly markdown: boolean } & (
  { readonly kind: 'owner'; readonly cursor: ConversationBodyCursor; readonly runId: string } |
  { readonly kind: 'shard'; readonly cursor: TranscriptBodyCursor });
export interface DisplayReplayRecord {
  readonly replay: DisplayReplaySource;
  readonly blockId: string; readonly groupId?: string; readonly role: string;
  readonly contentOffset: number; readonly length: number; readonly final: boolean;
  readonly digest: string;
}

/** Independent parser owner: a cold page read must not contend with the parser
 * which is currently producing an append inside the display queue. */
export class TerminalDisplayReplay {
  readonly #parser = new HistoryBodyRangeCache();
  constructor(readonly source: (source: DisplayReplaySource, offset: number) => Promise<string>) {}
  close(): void { this.#parser.close(); }
  async read(record: DisplayReplayRecord): Promise<TerminalDisplaySegment> {
    const { replay, blockId, groupId, role, contentOffset, length, final } = record;
    const end = contentOffset + length;
    // Even a fully cached parser range must revalidate source visibility. A
    // clear/delete can retire an unchanged immutable line or artifact.
    const verified = await this.source(replay, contentOffset);
    const read = (offset: number) => offset === contentOffset ? Promise.resolve(verified) : this.source(replay, offset);
    const base = { blockId, groupId, role, contentOffset, final };
    if (!replay.markdown) {
      let text = '';
      while (text.length < length) {
        const part = await read(contentOffset + text.length);
        if (!part) throw Error('terminal-display-replay-short');
        text += part.slice(0, length - text.length);
      }
      return { ...base, text, body: { version: 1, revision: 1, kind: 'plain', end: final, context: { nodes: [{
        kind: 'paragraph', origin: 0, from: contentOffset, to: end,
        anchor: contentOffset === 0 && role !== 'user' && role !== 'thinking', runs: [{ from: contentOffset, to: end, text, style: 0 }],
      }] } } };
    }
    const key = JSON.stringify({ ...replay, cursor: { ...replay.cursor, offset: 0 } });
    let result = await this.#parser.read(key, replay.length, read, end);
    while (!result.ready) result = await this.#parser.read(key, replay.length, read, end);
    const items = [...result.items].reverse().filter(item => item.contentOffset < end && item.contentOffset + item.text.length > contentOffset);
    if (!items.length || items[0]!.contentOffset > contentOffset) throw Error('terminal-display-replay-range');
    const text = items.map(item => item.text.slice(Math.max(0, contentOffset - item.contentOffset), end - item.contentOffset)).join('');
    const nodes = sliceBodyNodes(items.flatMap(item => item.body.context.nodes), contentOffset, end);
    return { ...base, text, body: { version: 1, revision: 1, kind: 'markdown', end: final, context: { nodes } } };
  }
}
