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
/** Current control identities only; no transcript or input body is loaded. */
export interface ConversationControlTargets {
  readonly targets: readonly { readonly runId: string; readonly state: 'queued' | 'dispatched' | 'running' | 'cancel-requested' }[];
}
/** Coordinates in an immutable committed body; no presentation tokens cross
 * this boundary. Offsets count source UTF-16 code units, never screen rows. */
export interface ConversationBodyCursor {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly clearId?: string;
  /** Present for the owner's ordered history, including uncovered durable inputs. */
  readonly history?: { readonly key: string; readonly throughLsn: number; readonly after?: true };
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
  readonly historyThroughInputLsn?: number;
  /** 首页冻结的本地权威边界（完整 checkpoint）；控制页以它为起点，跳过已由历史覆盖的部分。 */
  readonly historyThrough?: DurableLogCheckpoint;
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
  /** All inputs through this local authority boundary (and the imported base)
   * belong to the ordered history, including its not-yet-loaded older pages. */
  readonly historyThroughInputLsn?: number;
  /** 从历史边界起步时，先补发边界之前仍未结束的运行（当前集合），after 是已消费的最后一行；
   * 这一段读完后去掉此字段，再从边界扫描其后的控制事实。 */
  readonly current?: { readonly after?: string };
  readonly upper: DurableLogCheckpoint;
  /** Boundary before the envelope currently being consumed. */
  readonly after: DurableLogCheckpoint;
  readonly item: number;
}
export type ConversationControlFact =
  | { readonly kind: 'status'; readonly historyCovered?: boolean; readonly notice: ConversationStatusNotice; readonly communication: boolean; readonly continuation?: boolean; readonly commitRevision?: number }
  | { readonly kind: 'input'; readonly cursor: ConversationInputCursor }
  | { readonly kind: 'final'; readonly frame: FinalFrame };
export interface ConversationControlPage {
  readonly facts: readonly ConversationControlFact[];
  /** 本页开头属于当前集合段的事实的源顺序键（与 facts 前若干项一一对应），供调用方与精确补齐的事实按源顺序合并 */
  readonly currentOrder?: readonly string[];
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
  | { readonly mode: 'control-targets'; readonly conversationId: string }
  | { readonly mode: 'body-page'; readonly conversationId: string; readonly includeInputs?: true; readonly cursor?: ConversationBodyCursor; readonly direction?: 'forward' | 'reverse'; readonly runId?: string }
  | { readonly mode: 'completion'; readonly conversationId: string; readonly runId: string; readonly ownerEpoch?: number }
  | { readonly mode: 'control-page'; readonly conversationId: string; readonly cursor?: ConversationControlCursor; readonly historyRunIds?: readonly string[]; readonly historyThrough?: DurableLogCheckpoint }
  /** 指定运行在历史边界之前的控制事实（已不在当前集合里的终态与已提交的 final），按运行精确读取，每次至多 32 个。
   * 边界之后的事实由控制页的尾部按日志顺序给出，未结束运行由当前集合给出，这里都不重复。 */
  | { readonly mode: 'run-facts'; readonly conversationId: string; readonly runIds: readonly string[]; readonly historyThroughInputLsn: number }
  | { readonly mode: 'input-page'; readonly conversationId: string; readonly runId: string; readonly cursor?: ConversationInputCursor };
/** 按源顺序排列；order 是源顺序键（来源段、位置、条目序号），与控制页当前集合段的 currentOrder 可比较 */
export interface ConversationRunFactsPage { readonly entries: readonly { readonly order: string; readonly fact: Exclude<ConversationControlFact, { readonly kind: 'input' }> }[] }
export type ConversationRecoveryPage = ConversationControlPage | ConversationInputPage | ConversationCompletionPage | ConversationBodyPage | ConversationContextPage | ConversationControlTargets | ConversationRunFactsPage;
