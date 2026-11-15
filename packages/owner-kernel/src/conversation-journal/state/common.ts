import { Buffer } from "node:buffer";
import type { IsoTime, LogicalRecord } from "@zhixing-ai/core/contracts";
import { canonicalize } from "@zhixing-ai/core/protocol";
import type {
  ConversationRunInternalRecord,
  ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import type { ConversationCommitLogRecord } from "../contracts.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepReadonly<V>>
      : T extends readonly (infer U)[]
        ? readonly DeepReadonly<U>[]
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

export function runStream(conversationId: string): string {
  return `run:${conversationId}`;
}

export function runRecord(
  conversationId: string,
  body: ConversationRunJournalRecord | ConversationRunInternalRecord,
): LogicalRecord<ConversationCommitLogRecord> {
  return { stream: runStream(conversationId), body };
}

export function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}

export function withoutSignature<T extends { signature: unknown }>(
  value: T,
): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return payload;
}

export function canonicalTime(value: IsoTime, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export type TaggedConversationRunJournalRecord = Extract<
  ConversationRunJournalRecord,
  { t: string }
>;

export function isTaggedRecord<Tag extends TaggedConversationRunJournalRecord["t"]>(
  value: unknown,
  tag: Tag,
): value is Extract<TaggedConversationRunJournalRecord, { t: Tag }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "t" in value &&
    value.t === tag
  );
}
