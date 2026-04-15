/**
 * TypeaheadEvent —— 发给 EventBus 的事件类型
 *
 * spec §5.9 / §8.3 规定的可观测语义：broker 的所有关键状态转换都进 EventBus，
 * 用于审计、telemetry、未来的 Smart LLM 分诊前置过滤等。
 *
 * 命名和 confirmation:* 同构（Phase 1 confirmation 已落地此模式）。
 */

import type { AcceptResult, SuggestionItem, TriggerMatch } from "./types.js";

// ─── 事件类型枚举 ───

export type TypeaheadEventType =
  | "typeahead:session-started"
  | "typeahead:session-ended"
  | "typeahead:trigger-detected"
  | "typeahead:trigger-cleared"
  | "typeahead:query-started"
  | "typeahead:query-completed"
  | "typeahead:query-aborted"
  | "typeahead:provider-error"
  | "typeahead:suggestion-accepted";

// ─── 事件 payload ───

interface EventBase {
  readonly type: TypeaheadEventType;
  readonly sessionId: string;
  readonly timestamp: number;
}

export interface SessionStartedEvent extends EventBase {
  readonly type: "typeahead:session-started";
}

export interface SessionEndedEvent extends EventBase {
  readonly type: "typeahead:session-ended";
  readonly reason: "cancelled" | "accepted" | "replaced";
}

export interface TriggerDetectedEvent extends EventBase {
  readonly type: "typeahead:trigger-detected";
  readonly providerId: string;
  readonly trigger: TriggerMatch;
}

export interface TriggerClearedEvent extends EventBase {
  readonly type: "typeahead:trigger-cleared";
  readonly previousProviderId: string | null;
}

export interface QueryStartedEvent extends EventBase {
  readonly type: "typeahead:query-started";
  readonly providerId: string;
  readonly query: string;
}

export interface QueryCompletedEvent extends EventBase {
  readonly type: "typeahead:query-completed";
  readonly providerId: string;
  readonly query: string;
  readonly suggestionCount: number;
  readonly queryMs: number;
}

export interface QueryAbortedEvent extends EventBase {
  readonly type: "typeahead:query-aborted";
  readonly providerId: string;
  readonly query: string;
}

export interface ProviderErrorEvent extends EventBase {
  readonly type: "typeahead:provider-error";
  readonly providerId: string;
  readonly error: { readonly name: string; readonly message: string };
}

export interface SuggestionAcceptedEvent extends EventBase {
  readonly type: "typeahead:suggestion-accepted";
  readonly providerId: string;
  readonly item: Pick<SuggestionItem, "id" | "providerId" | "displayText">;
  readonly result: AcceptResult;
}

export type TypeaheadEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | TriggerDetectedEvent
  | TriggerClearedEvent
  | QueryStartedEvent
  | QueryCompletedEvent
  | QueryAbortedEvent
  | ProviderErrorEvent
  | SuggestionAcceptedEvent;

/**
 * Typeahead 事件 sink —— broker 持有一个 sink 来发射事件。
 * 通常由 CLI 或测试注入一个 EventBus 适配器。
 */
export type TypeaheadEventSink = (event: TypeaheadEvent) => void;

/** 不发事件的 sink（测试 / 独立使用时用） */
export const noopEventSink: TypeaheadEventSink = () => {};
