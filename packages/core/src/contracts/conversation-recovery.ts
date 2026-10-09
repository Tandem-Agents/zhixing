import { assertProtocolIdentifier } from "../protocol/validation.js";
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

export function validateConversationCommitSummary(value: unknown): asserts value is ConversationCommitSummary {
  assertRecordKeys(value, ['runIndex', 'handedOff', 'conflict'], ['usage', 'navigation', 'controlRecovery'], 'Committed read summary');
  assertNonNegativeSafeInteger(value.runIndex, 'Committed run index');
  if (typeof value.handedOff !== 'boolean' || typeof value.conflict !== 'boolean') throw new TypeError('Committed control summary must contain boolean facts');
  if (value.controlRecovery !== undefined && typeof value.controlRecovery !== 'boolean') throw new TypeError('Committed recovery summary must be boolean');
  if (value.usage !== undefined) {
    assertRecordKeys(value.usage, ['inputTokens', 'outputTokens'], ['totalInputTokens', 'cacheReadTokens', 'cacheWriteTokens'], 'Committed usage');
    for (const [key, number] of Object.entries(value.usage)) if (number !== undefined) assertNonNegativeSafeInteger(number, `Committed usage ${key}`);
    if (value.usage.totalInputTokens !== undefined && (Number(value.usage.totalInputTokens) < Number(value.usage.inputTokens) ||
        Number(value.usage.totalInputTokens) < Number(value.usage.cacheReadTokens ?? 0) + Number(value.usage.cacheWriteTokens ?? 0))) throw new TypeError('Committed total input usage is inconsistent');
  }
  if (value.navigation !== undefined) {
    assertPlainRecord(value.navigation, 'Committed navigation');
    const nav = value.navigation;
    if (value.handedOff) throw new TypeError('Handed-off commit cannot navigate the client');
    if (nav.kind === 'exit') assertExactRecordKeys(nav, ['kind'], 'Committed navigation');
    else if (nav.kind === 'enter' || nav.kind === 'set_workdir') {
      assertExactRecordKeys(nav, nav.kind === 'enter' ? ['kind', 'sceneId'] : ['kind', 'sceneId', 'workspace'], 'Committed navigation');
      assertIdentifier(nav.sceneId, 'Committed scene');
      if (nav.kind === 'set_workdir' && nav.workspace !== null) {
        assertExactRecordKeys(nav.workspace, ['deviceId', 'bindingRef'], 'Committed workspace');
        assertIdentifier(nav.workspace.deviceId, 'Committed workspace device');
        assertIdentifier(nav.workspace.bindingRef, 'Committed workspace binding');
      }
    } else throw new TypeError('Unknown committed navigation');
  }
}

function assertRecordKeys(value: unknown, required: readonly string[], optional: readonly string[], label: string): asserts value is Record<string, unknown> {
  assertPlainRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) throw new TypeError(`${label} fields are incomplete or unknown`);
}
function assertExactRecordKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> { assertRecordKeys(value, keys, [], label); }
function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object`);
}
function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
}
function assertIdentifier(value: unknown, label: string): asserts value is string { assertProtocolIdentifier(value, label); }
