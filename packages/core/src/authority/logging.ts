import type { LogRef, LogSource } from "../logging/contracts.js";
import { observationRefs } from "../logging/producer.js";
import type { LogicalRecord } from "../contracts/index.js";

export const AUTHORITY_LOG_SOURCE: LogSource = {
  id: "authority", version: 1,
  events: {
    committed: { message: "业务权威提交已耐久", level: "info", tier: "critical", fields: {
      lsn: "number", count: "number", streams: { items: "text", maxItems: 32 },
    } },
    uncertain: { message: "业务权威追加结果未确认", level: "error", tier: "critical", fields: { lsn: "number", error: "text" } },
    recovered: { message: "业务权威已恢复有效尾部", level: "info", tier: "critical", fields: { lsn: "number", incompleteTail: "boolean" } },
  },
};

/** Only stable top-level authority identities; never copies a business body. */
export function authorityObservationRefs(entries: readonly LogicalRecord<unknown>[]): LogRef[] {
  const refs: LogRef[] = [];
  for (const entry of entries.slice(0, 32)) {
    const body = entry.body;
    const occurrence = body && typeof body === "object" ? Object.getOwnPropertyDescriptor(body, "occ")?.value : undefined;
    for (const ref of [...observationRefs(body), ...observationRefs(occurrence)]) {
      if (!refs.some((item) => item.kind === ref.kind && item.id === ref.id)) refs.push(ref);
      if (refs.length === 10) return refs;
    }
  }
  return refs;
}
