import type { ConversationBodyCursor, TranscriptToolFacts } from '@zhixing/core/contracts';
import type { TranscriptBodyCursor } from '@zhixing/core/transcript';
import type { TerminalDisplaySegment } from '@zhixing/terminal-ui/protocol';
import { sliceBodyNodes } from '@zhixing/terminal-ui/body-model';
import { HistoryBodyRangeCache } from './body-projection.js';
import { formatHistoryToolCard } from '../tool-card-format.js';

/** Only a source already read from durable history can enter the cold tier.
 * Live output, notices and unpersisted tool presentations have no such locator. */
export type DisplayReplaySource = { readonly conversationId: string; readonly length: number; readonly markdown: boolean } & (
  { readonly kind: 'owner'; readonly cursor: ConversationBodyCursor; readonly runId: string } |
  { readonly kind: 'shard'; readonly cursor: TranscriptBodyCursor } |
  /** 工具卡片由结果块的有界事实派生：绑定结果块坐标、配对调用的位置与格式版本，回放时重读并按当前格式重建 */
  ({ readonly kind: 'tool'; readonly format: number; readonly call?: { readonly message: number; readonly block: number } } & (
    { readonly via: 'owner'; readonly cursor: ConversationBodyCursor; readonly runId: string } |
    { readonly via: 'shard'; readonly cursor: TranscriptBodyCursor })));
export type ToolReplaySource = Extract<DisplayReplaySource, { kind: 'tool' }>;
export interface DisplayReplayRecord {
  readonly replay: DisplayReplaySource;
  readonly blockId: string; readonly groupId?: string; readonly role: string;
  readonly contentOffset: number; readonly length: number; readonly final: boolean;
  readonly digest: string;
}

/** 历史工具卡片的显示段：纯文本、整段一次给出。 */
export function toolCardSegment(base: { readonly blockId: string; readonly groupId?: string }, facts: TranscriptToolFacts): TerminalDisplaySegment {
  const card = formatHistoryToolCard(facts), text = card.text;
  return { ...base, role: card.failed ? 'tool-error' : 'tool', text, contentOffset: 0, final: true,
    body: { version: 1, revision: 1, kind: 'plain', end: true, context: { nodes: [{ kind: 'paragraph', origin: 0, from: 0, to: text.length,
      anchor: true, runs: [{ from: 0, to: text.length, text, style: 0 }] }] } } };
}

/** Independent parser owner: a cold page read must not contend with the parser
 * which is currently producing an append inside the display queue. */
export class TerminalDisplayReplay {
  readonly #parser = new HistoryBodyRangeCache();
  constructor(readonly source: (source: DisplayReplaySource, offset: number) => Promise<string>,
    readonly tool?: (source: ToolReplaySource) => Promise<TranscriptToolFacts>) {}
  close(): void { this.#parser.close(); }
  async read(record: DisplayReplayRecord): Promise<TerminalDisplaySegment> {
    const { replay, blockId, groupId, role, contentOffset, length, final } = record;
    if (replay.kind === 'tool') {
      // 重读结果块即复核可见性（清空、删除后报失效）；配对调用的位置不符说明来源已变
      if (!this.tool) throw Error('terminal-display-replay-tool-unavailable');
      const facts = await this.tool(replay);
      const call = facts.kind === 'result' ? facts.call : undefined;
      if ((replay.call?.message ?? -1) !== (call?.message ?? -1) || (replay.call?.block ?? -1) !== (call?.block ?? -1))
        throw Error('terminal-display-replay-source-changed');
      return toolCardSegment({ blockId, ...(groupId ? { groupId } : {}) }, facts);
    }
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
