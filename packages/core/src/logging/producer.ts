import type { LogRecordPort, LogRef } from "./contracts.js";

/** Call only in a recorder projection. Fixed identity fields, no getters or body copy. */
export function observationRefs(value: unknown): LogRef[] {
  if (!value || typeof value !== "object") return [];
  const refs: LogRef[] = [];
  for (const [field, kind] of [
    ["requestId", "request"], ["conversationId", "conversation"], ["runId", "run"],
    ["jobRunId", "run"], ["taskId", "task"], ["turnId", "turn"], ["transferId", "transfer"], ["messageId", "message"], ["assignmentId", "assignment"], ["operationId", "operation"],
    ["deliveryId", "delivery"], ["itemId", "delivery"], ["toolCallId", "toolCall"],
  ]) {
    const id = Object.getOwnPropertyDescriptor(value, field!)?.value;
    if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(id)) refs.push({ kind: kind!, id });
    if (refs.length === 8) break;
  }
  return refs;
}

/** Projection remains inside the actual recorder's exception and admission boundary. */
export function withLogRefs(port: LogRecordPort | undefined, refs: readonly LogRef[]): LogRecordPort | undefined {
  if (!port) return undefined;
  return { record: (input) => port.record(() => {
    const draft = typeof input === "function" ? input() : input;
    return { ...draft, refs: [...refs, ...(draft.refs ?? []).filter((ref) => !refs.some((bound) => bound.kind === ref.kind && bound.id === ref.id))] };
  }) };
}
