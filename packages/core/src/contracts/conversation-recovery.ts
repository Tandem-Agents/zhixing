import type { DurableLogCheckpoint } from '../authority/interfaces.js';
import type { MessageInputIdentity } from '../types/messages.js';
import type { ConversationStatusNotice, FinalFrame } from './protocol.js';

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
  | { readonly mode: 'control-page'; readonly conversationId: string; readonly cursor?: ConversationControlCursor; readonly historyRunIds?: readonly string[] }
  | { readonly mode: 'input-page'; readonly conversationId: string; readonly runId: string; readonly cursor?: ConversationInputCursor };
export type ConversationRecoveryPage = ConversationControlPage | ConversationInputPage;
