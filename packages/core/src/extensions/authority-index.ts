import type { AuthorityCommitLog } from "../authority/interfaces.js";
import {
  createDurableProjectionOverlay, DurableProjectionRecordBindingError,
  type DurableProjectionReadContext, type DurableProjectionMutation,
} from "../authority/durable-projection-index.js";
import type { JsonValue } from "../contracts/index.js";
import { protocolDigest } from "../protocol/canonical.js";
import { extensionOperationActive, validateExtensionBinding, type ExtensionInstance, type ExtensionOperation } from "./contracts.js";

export const EXTENSION_INDEX_ID = "extension-current-state";
export interface ExtensionIndexState {
  instances: ReadonlyMap<string, ExtensionInstance>; operations: ReadonlyMap<string, ExtensionOperation>;
}
export type ExtensionAuthorityRecord = { readonly kind: "extension-instance"; readonly instance: ExtensionInstance } |
  { readonly kind: "extension-operation"; readonly operation: ExtensionOperation };
interface Row<T> { value: T; lsn: number; ordinal: number }
export interface ExtensionReadSet { readonly operationId?: string; readonly instanceId?: string; readonly exclusiveKey?: string }
const identity = (value: string) => protocolDigest("ExtensionIndexIdentity", 1, value);
const instanceKey = (id: string) => "instance/" + identity(id);
const operationKey = (id: string) => "operation/" + identity(id);
const activePrefix = (id: string) => "active/" + identity(id) + "/";
const latestKey = (id: string) => "latest/" + identity(id);
const exclusiveKey = (key: string) => "exclusive/" + identity(key);
const order = (row: Row<unknown>) => row.lsn.toString().padStart(16, "0") + "/" + row.ordinal.toString().padStart(10, "0") + "/";
const needsWork = (value: ExtensionOperation) => extensionOperationActive(value) ||
  ((value.phase !== "verifying" || !value.verification) && value.notifiedRevision !== value.revision);
function invalid(): DurableProjectionRecordBindingError {
  return new DurableProjectionRecordBindingError("Extension index identity is invalid");
}
function instance(value: unknown): ExtensionInstance {
  const v = value as ExtensionInstance;
  if (!v || typeof v.id !== "string" || !v.id || !Number.isSafeInteger(v.revision) || v.revision < 1 ||
      typeof v.enabled !== "boolean" || !["stopped", "starting", "running", "blocked"].includes(v.phase) ||
      (v.generation !== null && typeof v.generation !== "string")) throw invalid();
  validateExtensionBinding(v.binding);
  return { ...v, intentRevision: v.intentRevision ?? 1 };
}
function operation(value: unknown): ExtensionOperation {
  const v = value as ExtensionOperation;
  if (!v || typeof v.id !== "string" || !v.id || typeof v.instanceId !== "string" || !v.instanceId ||
      !Number.isSafeInteger(v.revision) || v.revision < 1 ||
      !["preparing", "configuration", "verifying", "ready", "blocked", "cancelled"].includes(v.phase)) throw invalid();
  return v;
}
function row<T extends ExtensionInstance | ExtensionOperation>(value: unknown, id: string,
  validate: (value: unknown) => T): Row<T> | undefined {
  if (value === undefined) return;
  const r = value as Row<T>;
  if (!r || typeof r !== "object" || Object.keys(r).sort().join(",") !== "lsn,ordinal,value" ||
      !Number.isSafeInteger(r.lsn) || r.lsn < 1 || !Number.isSafeInteger(r.ordinal) || r.ordinal < 0) throw invalid();
  let validated: T;
  try { validated = validate(r.value); } catch { throw invalid(); }
  if (validated.id !== id) throw invalid();
  return { ...r, value: validated };
}
async function readInstance(current: DurableProjectionReadContext, id: string) {
  return row(await current.get(instanceKey(id)), id, instance);
}
async function readOperation(current: DurableProjectionReadContext, id: string) {
  return row(await current.get(operationKey(id)), id, operation);
}
export async function readExtensionInstance(current: DurableProjectionReadContext, id: string): Promise<ExtensionInstance | undefined> {
  const found = await readInstance(current, id); return found && structuredClone(found.value);
}
export async function readExtensionOperation(current: DurableProjectionReadContext, id: string): Promise<ExtensionOperation | undefined> {
  const found = await readOperation(current, id); return found && structuredClone(found.value);
}
async function scan(current: DurableProjectionReadContext, prefix: string) {
  const values: { key: string; value: JsonValue }[] = [];
  let continuation: string | undefined;
  do {
    const page = await current.scan({ gte: prefix, lt: prefix + "\uffff" }, 64, continuation);
    values.push(...page.entries); continuation = page.continuation;
  } while (continuation);
  return values;
}
async function pointers(current: DurableProjectionReadContext, prefix: string, target?: string) {
  const values: Row<ExtensionOperation>[] = [];
  for (const entry of await scan(current, prefix)) {
    if (typeof entry.value !== "string") throw invalid();
    const found = await readOperation(current, entry.value);
    if (!found || (target !== undefined && found.value.instanceId !== target) ||
        entry.key !== prefix + order(found) + identity(found.value.id)) throw invalid();
    values.push(found);
  }
  return values;
}
export function extensionIndex(log: AuthorityCommitLog) {
  return log.durableProjection<ExtensionAuthorityRecord>({
    projectionId: EXTENSION_INDEX_ID, reducerVersion: 1, authenticated: true, inputs: { streams: ["extensions"] },
    reduce: async (envelope, current) => {
      const changes = new Map<string, JsonValue | undefined>();
      const view = createDurableProjectionOverlay(current, changes);
      for (const [ordinal, entry] of envelope.entries.entries()) {
        if (entry.stream !== "extensions") continue;
        if (entry.body.kind === "extension-instance") {
          const value = instance(entry.body.instance);
          const prior = await readInstance(view, value.id);
          if (prior?.value.enabled && prior.value.binding.exclusiveKey) changes.set(exclusiveKey(prior.value.binding.exclusiveKey), undefined);
          if (value.enabled && value.binding.exclusiveKey) {
            const key = exclusiveKey(value.binding.exclusiveKey), owner = await view.get(key);
            if (owner !== undefined && owner !== value.id) throw new Error("Exclusive extension resource is already claimed");
            changes.set(key, value.id);
          }
          changes.set(instanceKey(value.id), { value, lsn: prior?.lsn ?? envelope.lsn, ordinal: prior?.ordinal ?? ordinal } as unknown as JsonValue);
        } else if (entry.body.kind === "extension-operation") {
          const value = operation(entry.body.operation);
          const prior = await readOperation(view, value.id);
          if (prior && prior.value.instanceId !== value.instanceId) throw invalid();
          const next = { value, lsn: prior?.lsn ?? envelope.lsn, ordinal: prior?.ordinal ?? ordinal };
          const suffix = order(next) + identity(value.id);
          changes.set(operationKey(value.id), next as unknown as JsonValue);
          changes.set(activePrefix(value.instanceId) + suffix, extensionOperationActive(value) ? value.id : undefined);
          changes.set("work/" + suffix, needsWork(value) ? value.id : undefined);
          if (!prior) changes.set(latestKey(value.instanceId), value.id);
        } else throw new Error("Invalid extension authority record");
      }
      return [...changes].map(([key, value]): DurableProjectionMutation => value === undefined ?
        { kind: "tombstone", key } : { kind: "put", key, value });
    },
  });
}
export async function readExtensionState(current: DurableProjectionReadContext, set: ExtensionReadSet): Promise<ExtensionIndexState> {
  const instances = new Map<string, ExtensionInstance>(), operations = new Map<string, ExtensionOperation>();
  const selected = set.operationId && await readOperation(current, set.operationId);
  if (selected) operations.set(selected.value.id, selected.value);
  const id = set.instanceId ?? (selected ? selected.value.instanceId : undefined);
  if (id !== undefined) {
    const found = await readInstance(current, id);
    if (found) {
      instances.set(id, found.value);
      const admission = found.value.admission?.operationId;
      if (admission) {
        const admitted = await readOperation(current, admission);
        if (!admitted || admitted.value.instanceId !== id) throw invalid();
        operations.set(admission, admitted.value);
      }
    }
    for (const active of await pointers(current, activePrefix(id), id)) {
      if (!extensionOperationActive(active.value)) throw invalid();
      operations.set(active.value.id, active.value);
    }
    for (const key of new Set([set.exclusiveKey, found?.value.binding.exclusiveKey,
      ...[...operations.values()].map(operation => operation.previous?.binding.exclusiveKey)])) {
      if (!key) continue;
      const owner = await current.get(exclusiveKey(key));
      if (owner === undefined) continue;
      if (typeof owner !== "string") throw invalid();
      const claimed = await readInstance(current, owner);
      if (!claimed?.value.enabled || claimed.value.binding.exclusiveKey !== key) throw invalid();
      instances.set(owner, claimed.value);
    }
  }
  return { instances, operations };
}
export async function readExtensionSnapshot(current: DurableProjectionReadContext, includeHistory: boolean): Promise<ExtensionIndexState> {
  const instanceRows: Row<ExtensionInstance>[] = [], operationRows = new Map<string, Row<ExtensionOperation>>();
  for (const entry of await scan(current, "instance/")) {
    const value = (entry.value as unknown as Row<ExtensionInstance>)?.value;
    const found = row(entry.value, value?.id, instance);
    if (!found || entry.key !== instanceKey(found.value.id)) throw invalid();
    instanceRows.push(found);
  }
  if (includeHistory) {
    for (const entry of await scan(current, "operation/")) {
      const value = (entry.value as unknown as Row<ExtensionOperation>)?.value;
      const found = row(entry.value, value?.id, operation);
      if (!found || entry.key !== operationKey(found.value.id)) throw invalid();
      operationRows.set(found.value.id, found);
    }
  } else {
    for (const found of instanceRows) {
      for (const active of await pointers(current, activePrefix(found.value.id), found.value.id)) {
        if (!extensionOperationActive(active.value)) throw invalid();
        operationRows.set(active.value.id, active);
      }
      const id = await current.get(latestKey(found.value.id));
      if (id !== undefined) {
        if (typeof id !== "string") throw invalid();
        const latest = await readOperation(current, id);
        if (!latest || latest.value.instanceId !== found.value.id) throw invalid();
        operationRows.set(id, latest);
      }
      const admission = found.value.admission?.operationId;
      if (admission && !operationRows.has(admission)) {
        const admitted = await readOperation(current, admission);
        if (!admitted || admitted.value.instanceId !== found.value.id) throw invalid();
        operationRows.set(admission, admitted);
      }
    }
  }
  const compare = (a: Row<unknown>, b: Row<unknown>) => a.lsn - b.lsn || a.ordinal - b.ordinal;
  return { instances: new Map(instanceRows.sort(compare).map(r => [r.value.id, r.value])),
    operations: new Map([...operationRows.values()].sort(compare).map(r => [r.value.id, r.value])) };
}
export async function readExtensionInstances(current: DurableProjectionReadContext): Promise<readonly ExtensionInstance[]> {
  const rows: Row<ExtensionInstance>[] = [];
  for (const entry of await scan(current, "instance/")) {
    const value = (entry.value as unknown as Row<ExtensionInstance>)?.value;
    const found = row(entry.value, value?.id, instance);
    if (!found || entry.key !== instanceKey(found.value.id)) throw invalid();
    rows.push(found);
  }
  return rows.sort((a, b) => a.lsn - b.lsn || a.ordinal - b.ordinal).map(r => structuredClone(r.value));
}
export async function latestExtensionOperation(current: DurableProjectionReadContext, instanceId: string) {
  const id = await current.get(latestKey(instanceId));
  if (id === undefined) return;
  if (typeof id !== "string") throw invalid();
  const found = await readOperation(current, id);
  if (!found || found.value.instanceId !== instanceId) throw invalid();
  return structuredClone(found.value);
}
export async function extensionWorkPage(current: DurableProjectionReadContext, after?: string, limit = 64) {
  const page = await current.scan({ ...(after ? { gt: after } : { gte: "work/" }), lt: "work/\uffff" }, limit);
  const operations: ExtensionOperation[] = [];
  for (const entry of page.entries) {
    if (typeof entry.value !== "string") throw invalid();
    const found = await readOperation(current, entry.value);
    if (!found || !needsWork(found.value) || entry.key !== "work/" + order(found) + identity(found.value.id)) throw invalid();
    operations.push(found.value);
  }
  return { operations, ...(page.continuation ? { after: page.entries.at(-1)!.key } : {}) };
}
