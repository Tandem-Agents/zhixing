import type { DurableLogCheckpoint } from '../authority/interfaces.js';
import type { MessageInputIdentity } from '../types/messages.js';
import type { ConversationStatusNotice, FinalFrame } from './protocol.js';
import type { TokenUsage } from '../types/llm.js';

/** Commit metadata is separate from replaying the committed body. This is a
 * read projection of the commit, not a fabricated AgentResult. */
export interface ConversationCommitSummary {
  readonly runIndex: number;
  readonly usage?: TokenUsage;
  readonly navigation?: { readonly kind: 'enter'; readonly sceneId: string } | { readonly kind: 'exit' } |
    { readonly kind: 'set_workdir'; readonly sceneId: string; readonly workspace: { readonly deviceId: string; readonly bindingRef: string } | null };
  readonly handedOff: boolean;
  readonly conflict: boolean;
  /** Absent on older commits: recovery must conservatively inspect them. */
  readonly controlRecovery?: boolean;
}
export interface ConversationCompletionPage {
  readonly conversationId: string;
  readonly runId: string;
  readonly ownerEpoch: number;
  readonly commitRevision?: number;
  readonly summary?: ConversationCommitSummary;
}
export interface ConversationContextPage {
  readonly text?: string;
  readonly turnCount: number;
  readonly preparing?: { readonly bytes: number; readonly total: number };
}
/** Coordinates in an immutable committed body; no presentation tokens cross
 * this boundary. Offsets count source UTF-16 code units, never screen rows. */
export interface ConversationBodyCursor {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly clearId?: string;
  readonly revision: number;
  readonly message: number;
  readonly block: number;
  readonly offset: number;
}
export interface ConversationBodyFragment {
  readonly cursor: ConversationBodyCursor;
  readonly runId: string;
  readonly runIndex: number;
  readonly message: number;
  readonly block: number;
  readonly role: string;
  readonly type: string;
  readonly toolId?: string;
  readonly isError?: boolean;
  readonly text: string;
  readonly offset: number;
  readonly length: number;
  readonly final: boolean;
}
export interface ConversationBodyPage {
  readonly fragments: readonly ConversationBodyFragment[];
  readonly cursor?: ConversationBodyCursor;
  readonly hasMore: boolean;
  readonly reset: boolean;
  readonly preparing?: { readonly bytes: number; readonly total: number };
}

/** A read position in the original conversation authority, never a delivery
 * acknowledgement. The caller commits it only after consuming the page. */
export interface ConversationControlCursor {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly clearedThroughLsn: number;
  readonly clearId?: string;
  readonly baseId?: string;
  readonly baseItem: number;
  /** Completed runs through this revision are owned by the ordinary history
   * view. Failed/uncommitted source inputs are still recovered from the log. */
  readonly historyThroughCommitRevision?: number;
  readonly upper: DurableLogCheckpoint;
  /** Boundary before the envelope currently being consumed. */
  readonly after: DurableLogCheckpoint;
  readonly item: number;
}
export type ConversationControlFact =
  | { readonly kind: 'status'; readonly notice: ConversationStatusNotice; readonly communication: boolean }
  | { readonly kind: 'input'; readonly cursor: ConversationInputCursor }
  | { readonly kind: 'final'; readonly frame: FinalFrame };
export interface ConversationControlPage {
  readonly facts: readonly ConversationControlFact[];
  readonly cursor: ConversationControlCursor;
  readonly hasMore: boolean;
  readonly reset: boolean;
}
export interface ConversationInputCursor {
  readonly conversationId: string;
  readonly runId: string;
  readonly ownerEpoch: number;
  readonly clearedThroughLsn: number;
  readonly clearId?: string;
  readonly baseId?: string;
  readonly imported?: true;
  readonly inputKey?: string;
  readonly upper: DurableLogCheckpoint;
  readonly position: number;
  readonly part: number;
  readonly offset: number;
  readonly contentOffset: number;
}
/** The same textual input projection used by observed-input display, split
 * before transport. Source identity and absolute text position survive paging. */
export interface ConversationInputFragment {
  readonly identity: MessageInputIdentity;
  readonly text: string;
  readonly contentOffset: number;
  readonly final: boolean;
}
export interface ConversationInputPage {
  readonly input?: ConversationInputFragment;
  readonly cursor: ConversationInputCursor;
  readonly hasMore: boolean;
  readonly reset: boolean;
}
export type ConversationRecoveryRequest =
  | { readonly mode: 'context'; readonly conversationId: string }
  | { readonly mode: 'body-page'; readonly conversationId: string; readonly cursor?: ConversationBodyCursor; readonly direction?: 'forward' | 'reverse'; readonly runId?: string }
  | { readonly mode: 'completion'; readonly conversationId: string; readonly runId: string; readonly ownerEpoch?: number }
  | { readonly mode: 'control-page'; readonly conversationId: string; readonly cursor?: ConversationControlCursor; readonly historyRunIds?: readonly string[] }
  | { readonly mode: 'input-page'; readonly conversationId: string; readonly runId: string; readonly cursor?: ConversationInputCursor };
export type ConversationRecoveryPage = ConversationControlPage | ConversationInputPage | ConversationCompletionPage | ConversationBodyPage | ConversationContextPage;
