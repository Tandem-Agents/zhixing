import type { LogSource } from "../logging/contracts.js";
import { observationRefs } from "../logging/producer.js";

export function productObservationRefs(input: unknown) {
  return observationRefs(input).concat(observationRefs(
    input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "request")?.value : undefined,
  )).concat(observationRefs(input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "turnIdentity")?.value : undefined)).slice(0, 8);
}

/** Transport-independent application invocation, never a second commit authority. */
export const PRODUCT_API_LOG_SOURCE: LogSource = {
  id: "product-api", version: 1,
  events: {
    requested: { message: "产品应用调用开始", level: "info", tier: "critical", fields: { action: "text", kind: "text" } },
    returned: { message: "产品应用调用已返回", level: "info", tier: "critical", fields: { action: "text", duration: "number", facts: { items: "text", maxItems: 32 } } },
    failed: { message: "产品应用调用失败", level: "error", tier: "critical", fields: { action: "text", duration: "number", error: "text" } },
  },
};
