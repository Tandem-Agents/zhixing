/** Stable keyset pagination over durable metadata. Body and runtime state do
 * not participate in ordering, so a running request cannot reshuffle a page. */
import { protocolDigest } from '../protocol/canonical.js';
import { isLocalConversationId, WORKSCENE_CONVERSATION_PREFIX } from './scope-id.js';

export type ConversationDirectoryScopeKind = 'main' | 'workscene' | 'channel' | 'local';
export interface ConversationDirectoryCursor { readonly lastActiveAt: string; readonly conversationId: string }
export interface ConversationDirectoryPageRequest {
  readonly limit: number;
  readonly after?: ConversationDirectoryCursor;
  readonly query?: string;
  readonly scopeFilter?: 'main' | 'channel';
  readonly includeVersion?: boolean;
}
export type ConversationDirectorySourceVersion =
  | {
      readonly kind: 'indexed';
      readonly epoch: number;
      readonly revision: string;
      readonly pendingDigest?: string;
    }
  | {
      readonly kind: 'direct';
      readonly entriesDigest: string;
    };

export function classifyConversationDirectoryScope(conversationId: string): ConversationDirectoryScopeKind {
  if (conversationId.startsWith(WORKSCENE_CONVERSATION_PREFIX)) {
    const rest = conversationId.slice(WORKSCENE_CONVERSATION_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep > 0 && sep < rest.length - 1) return 'workscene';
  }
  if (isLocalConversationId(conversationId)) return 'local';
  if (/^[^:]+:(?:thread|group|dm):/u.test(conversationId)) return 'channel';
  return 'main';
}

export function computeDirectoryEntriesDigest(
  entries: readonly { readonly canonicalKey: string; readonly lastActiveAt: string; readonly name: string }[],
): string {
  const ordered = [...entries]
    .map(item => ({ canonicalKey: item.canonicalKey, lastActiveAt: item.lastActiveAt, name: item.name }))
    .sort((a, b) => compareDirectoryKeys(
      { conversationId: a.canonicalKey, lastActiveAt: a.lastActiveAt },
      { conversationId: b.canonicalKey, lastActiveAt: b.lastActiveAt },
    ));
  return protocolDigest('ConversationDirectoryDirectView', 1, { entries: ordered });
}

export function assertDirectoryPage(input: ConversationDirectoryPageRequest): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
      (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256)) ||
      (input.scopeFilter !== undefined && input.scopeFilter !== 'main' && input.scopeFilter !== 'channel') ||
      (input.includeVersion !== undefined && typeof input.includeVersion !== 'boolean') ||
      (input.after !== undefined && (!input.after || typeof input.after.conversationId !== 'string' ||
        !input.after.conversationId.length || input.after.conversationId.length > 1024 ||
        typeof input.after.lastActiveAt !== 'string' || !Number.isFinite(Date.parse(input.after.lastActiveAt))))) throw Error('conversation-directory-page');
}
export function compareDirectoryKeys(a: ConversationDirectoryCursor, b: ConversationDirectoryCursor): number {
  return Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) || (a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0);
}
/** Holds at most limit + 1 records even when the backing directory is large. */
export class ConversationDirectoryPageCollector<T extends ConversationDirectoryCursor & { readonly name: string }> {
  readonly entries: T[] = [];
  constructor(readonly request: ConversationDirectoryPageRequest) { assertDirectoryPage(request); }
  add(record: T): void {
    const { after, query, limit, scopeFilter } = this.request;
    if (scopeFilter && classifyConversationDirectoryScope(record.conversationId) !== scopeFilter) return;
    if (after && compareDirectoryKeys(record, after) <= 0) return;
    if (query && !`${record.conversationId} ${record.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return;
    if (this.entries.length > limit && compareDirectoryKeys(record, this.entries.at(-1)!) >= 0) return;
    this.entries.push(record); this.entries.sort(compareDirectoryKeys); this.entries.length = Math.min(this.entries.length, limit + 1);
  }
  result(): { readonly records: readonly T[]; readonly next?: ConversationDirectoryCursor } {
    const records = this.entries.slice(0, this.request.limit), last = records.at(-1);
    return { records, ...(this.entries.length > records.length && last ? { next: { conversationId: last.conversationId, lastActiveAt: last.lastActiveAt } } : {}) };
  }
}
