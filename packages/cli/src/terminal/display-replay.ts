import type { ConversationBodyCursor, ConversationRunOutcomesPage, TranscriptToolFacts } from '@zhixing-ai/core/contracts';
import type { TranscriptBodyCursor } from '@zhixing-ai/core/transcript';
import type { TerminalDisplaySegment } from '@zhixing-ai/terminal-ui/protocol';
import { sliceBodyNodes } from '@zhixing-ai/terminal-ui/body-model';
import { HistoryBodyRangeCache } from './body-projection.js';
import { formatHistoryToolCard } from '../tool-card-format.js';
import { modelFailureText } from './model-failure.js';

/** Only a source already read from durable history can enter the cold tier.
 * Live output, notices and unpersisted tool presentations have no such locator. */
export type DisplayReplaySource = { readonly conversationId: string; readonly length: number; readonly markdown: boolean } & (
  { readonly kind: 'owner'; readonly cursor: ConversationBodyCursor; readonly runId: string } |
  { readonly kind: 'shard'; readonly cursor: TranscriptBodyCursor } |
  /** 工具卡片由结果块的有界事实派生：绑定结果块坐标、配对调用的位置与格式版本，回放时重读并按当前格式重建 */
  ({ readonly kind: 'tool'; readonly format: number; readonly call?: { readonly message: number; readonly block: number } } & (
    { readonly via: 'owner'; readonly cursor: ConversationBodyCursor; readonly runId: string } |
    { readonly via: 'shard'; readonly cursor: TranscriptBodyCursor })) |
  /** 运行末尾的结果行：由读到的运行状态确定性生成，定位里只存状态与有界原因 */
  { readonly kind: 'outcome'; readonly runId: string; readonly state: RunOutcomeState; readonly reason?: string });
export type ToolReplaySource = Extract<DisplayReplaySource, { kind: 'tool' }>;
export type RunOutcomeState = ConversationRunOutcomesPage['entries'][number]['state'];

// 存储维护未放行写入：运行记录里是内部原文，给用户说清是本机存储繁忙
const STORAGE_NOT_ADMITTED = /^Storage maintenance was not admitted\b/u;

/**
 * 历史里一次运行末尾的结果行，只写已确定的结束结果（失败、过期、停止、找不到记录），用来解释为什么没有回答。
 * 已完成与无法判断不出行。排队、派发、执行、停止中、结果待确认都还会变化：它们由状态行的活动投影按权威生命周期承载，
 * 不固化成历史正文，否则读取之后就会与实际状态矛盾。
 */
export function runOutcomeText(state: RunOutcomeState, reason?: string): string | undefined {
  switch (state) {
    case 'failed': {
      const cause = reason?.trim();
      return `⚠ 这次运行未完成：${!cause ? '原因未记录' : STORAGE_NOT_ADMITTED.test(cause) ? '本机存储当时正忙于维护，运行写入未被接纳而中断。' : modelFailureText(cause)}`;
    }
    case 'expired': return '⚠ 这次运行等待过久已失效，没有执行完成。';
    case 'cancelled': return '这次运行已停止。';
    case 'missing': return '⚠ 找不到这次运行的记录。';
    default: return undefined;
  }
}

/** 结果行的显示段：纯文本、整段一次给出，与该运行同组。 */
export function runOutcomeSegment(base: { readonly blockId: string; readonly groupId?: string }, text: string): TerminalDisplaySegment {
  return { ...base, role: 'notice', text, contentOffset: 0, final: true,
    body: { version: 1, revision: 1, kind: 'plain', end: true, context: { nodes: [{ kind: 'paragraph', origin: 0, from: 0, to: text.length,
      anchor: true, runs: [{ from: 0, to: text.length, text, style: 0 }] }] } } };
}
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
    if (replay.kind === 'outcome') {
      const text = runOutcomeText(replay.state, replay.reason);
      if (!text) throw Error('terminal-display-replay-source-changed');
      return runOutcomeSegment({ blockId, ...(groupId ? { groupId } : {}) }, text);
    }
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
