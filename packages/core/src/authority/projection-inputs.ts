import type { LogicalRecord } from "../contracts/index.js";
import type { DurableProjectionInputs } from "./durable-projection-index.js";

const FAMILIES = new Set(["run:", "job:", "transfer:", "intent:", "assignment:", "executor:", "session-activity:"]);

/** Freeze declarations so an application cannot change replay membership after registration. */
export function freezeProjectionInputs(inputs: DurableProjectionInputs | undefined): DurableProjectionInputs | undefined {
  if (inputs === undefined) return undefined;
  const streams = [...new Set(inputs.streams ?? [])].sort();
  const families = [...new Set(inputs.families ?? [])].sort();
  if (streams.length + families.length === 0 ||
      streams.some(stream => typeof stream !== "string" || !stream.length) ||
      families.some(family => !FAMILIES.has(family))) {
    throw new TypeError("Durable projection requires complete, nonempty WAL source declarations");
  }
  return Object.freeze({ streams: Object.freeze(streams), families: Object.freeze(families) });
}

export function projectionConsumes(inputs: DurableProjectionInputs | undefined, entries: readonly LogicalRecord<unknown>[]): boolean {
  return inputs === undefined || entries.some(entry =>
    inputs.streams?.includes(entry.stream) || inputs.families?.some(family => entry.stream.startsWith(family)));
}
