import type { CredentialExposureRecord, JsonValue } from "@zhixing/core/contracts";
import {
  DurableProjectionRecordBindingError, createDurableProjectionOverlay,
  type AuthorityCommitLog, type DurableProjectionReadContext, type DurableProjectionMutation,
} from "@zhixing/core/authority";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { projectCredentialExposures } from "./credential-exposure.js";

export const CREDENTIAL_EXPOSURE_PROJECTION_ID = "credential-exposures-v1";
type State = CredentialExposureRecord["state"];
interface Route {
  readonly bindingId: string; readonly service: string; readonly mask: number;
  readonly deviceId: string | null;
  readonly principal: string | null; readonly tenant: string | null; readonly scopes: readonly string[] | null;
}
interface Totals { total: number; compromised: number; active: number }
export function exposureProjectionKey(record: CredentialExposureRecord): string {
  return "exposure:" + protocolDigest("CredentialExposureIndex", 1, [record.deviceId, record.bindingId,
    record.service, record.principalFingerprint ?? "", record.tenant ?? "", ...(record.scopes ?? [])]);
}
function invalid(): DurableProjectionRecordBindingError {
  return new DurableProjectionRecordBindingError("Credential exposure index binding is invalid");
}
export function readExposureProjection(key: string, value: unknown): CredentialExposureRecord | undefined {
  if (value === undefined) return;
  try {
    const record = projectCredentialExposures([value as CredentialExposureRecord]).records[0]!;
    if (exposureProjectionKey(record) !== key) throw invalid();
    return record;
  } catch { throw invalid(); }
}
function routeKey(route: Route): string { return "route/" + protocolDigest("CredentialExposureRoute", 1, route); }
/** 同一绑定、同一服务在全部设备与状态的记录里最大的修订号：一行聚合，轮换据此取下一修订号。 */
function revisionKey(bindingId: string, service: string): string {
  return "revision/" + protocolDigest("CredentialExposureBindingRevision", 1, [bindingId, service]);
}
function readRevision(bindingId: string, service: string, value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "bindingId,revision,service" ||
      value.bindingId !== bindingId || value.service !== service ||
      typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) throw invalid();
  return value.revision;
}
/** 修订号聚合的精确读取；没有带修订号的记录为 0。 */
export async function readExposureBindingRevision(current: DurableProjectionReadContext,
  bindingId: string, service: string): Promise<number> {
  return readRevision(bindingId, service, await current.get(revisionKey(bindingId, service)));
}
function routes(record: CredentialExposureRecord): Route[] {
  return Array.from({ length: 16 }, (_, n) => ({ bindingId: record.bindingId, service: record.service,
    mask: n % 8, deviceId: n < 8 ? null : record.deviceId,
    principal: (n & 1) ? record.principalFingerprint ?? null : null,
    tenant: (n & 2) ? record.tenant ?? null : null,
    scopes: (n & 4) ? record.scopes ?? [] : null,
  }));
}
function readTotals(route: Route, value: JsonValue | undefined): Totals {
  if (value === undefined) return { total: 0, active: 0, compromised: 0 };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "active,compromised,route,total" ||
      canonicalize(value.route) !== canonicalize(route)) throw invalid();
  const { total, active, compromised } = value;
  if (![total, active, compromised].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ||
      (active as number) + (compromised as number) > (total as number)) throw invalid();
  return { total: total as number, active: active as number, compromised: compromised as number };
}
export interface ExposureIndexSelection {
  readonly state: State; readonly deviceId?: string; readonly bindingId?: string; readonly service?: string;
}
function statePrefix(selection: ExposureIndexSelection): string {
  if (selection.bindingId !== undefined || selection.service !== undefined) {
    if (selection.deviceId === undefined || selection.bindingId === undefined || selection.service === undefined) throw new TypeError("Exposure binding selection is incomplete");
    return "state/" + selection.state + "/binding/" + protocolDigest("CredentialExposureBinding", 1,
      [selection.deviceId, selection.bindingId, selection.service]) + "/";
  }
  return selection.deviceId === undefined ? "state/" + selection.state + "/all/" :
    "state/" + selection.state + "/device/" + protocolDigest("CredentialExposureDevice", 1, selection.deviceId) + "/";
}
function secondaryKeys(record: CredentialExposureRecord): string[] {
  const exact = exposureProjectionKey(record);
  return [
    statePrefix({ state: record.state }) + exact,
    statePrefix({ state: record.state, deviceId: record.deviceId }) + exact,
    statePrefix({ state: record.state, deviceId: record.deviceId, bindingId: record.bindingId, service: record.service }) + exact,
  ];
}
async function upsert(record: CredentialExposureRecord, current: DurableProjectionReadContext,
  changes: Map<string, JsonValue | undefined>): Promise<void> {
  const view = createDurableProjectionOverlay(current, changes);
  const key = exposureProjectionKey(record);
  const prior = readExposureProjection(key, await view.get(key));
  const next = projectCredentialExposures(prior ? [prior, record] : [record]).records[0]!;
  if (prior) for (const key of secondaryKeys(prior)) changes.set(key, undefined);
  for (const key of secondaryKeys(next)) changes.set(key, exposureProjectionKey(next));
  changes.set(key, next as unknown as JsonValue);
  // 修订号只增不减（归约拒绝同一身份回退，写者都带上或原样复制修订号）：取历来最大即当前最大
  const revision = next.bindingRevision ?? 0;
  if (revision > 0) {
    const aggregate = revisionKey(next.bindingId, next.service);
    if (revision > readRevision(next.bindingId, next.service, await view.get(aggregate))) {
      changes.set(aggregate, { bindingId: next.bindingId, service: next.service, revision });
    }
  }
  const priorRoutes = prior && routes(prior);
  for (const [index, route] of routes(next).entries()) {
    if (priorRoutes && canonicalize(priorRoutes[index]) !== canonicalize(route)) throw invalid();
    const key = routeKey(route);
    const value = await view.get(key);
    if (prior && value === undefined) throw invalid();
    const totals = readTotals(route, value);
    if (!prior) totals.total++;
    totals.active += Number(next.state === "active") - Number(prior?.state === "active");
    totals.compromised += Number(next.state === "compromised") - Number(prior?.state === "compromised");
    if (!Number.isSafeInteger(totals.total) || totals.active < 0 || totals.compromised < 0 ||
        totals.active + totals.compromised > totals.total) throw invalid();
    changes.set(key, { route, ...totals } as unknown as JsonValue);
  }
}
function mutations(changes: ReadonlyMap<string, JsonValue | undefined>): DurableProjectionMutation[] {
  return [...changes].map(([key, value]) => value === undefined ? { kind: "tombstone", key } : { kind: "put", key, value });
}
export function credentialExposureIndex(log: AuthorityCommitLog) {
  return log.durableProjection<CredentialExposureRecord>({
    projectionId: CREDENTIAL_EXPOSURE_PROJECTION_ID, reducerVersion: 3, authenticated: true,
    inputs: { streams: ["exposure"] },
    reduce: async (envelope, current) => {
      const changes = new Map<string, JsonValue | undefined>();
      for (const entry of envelope.entries) {
        if (entry.stream !== "exposure") continue;
        const record = projectCredentialExposures([entry.body]).records[0]!;
        await upsert(record, current, changes);
      }
      return mutations(changes);
    },
  });
}
export async function readExposureRecords(current: DurableProjectionReadContext,
  selection?: ExposureIndexSelection): Promise<CredentialExposureRecord[]> {
  const prefix = selection ? statePrefix(selection) : "exposure:";
  const records: CredentialExposureRecord[] = [];
  let continuation: string | undefined;
  do {
    const page = await current.scan({ gte: prefix, lt: prefix + "\uffff" }, 128, continuation);
    for (const entry of page.entries) {
      const key = selection ? entry.value : entry.key;
      if (typeof key !== "string") throw invalid();
      const record = readExposureProjection(key, selection ? await current.get(key) : entry.value);
      if (!record || (selection && (entry.key !== prefix + key || record.state !== selection.state ||
          (selection.deviceId !== undefined && record.deviceId !== selection.deviceId) ||
          (selection.bindingId !== undefined && record.bindingId !== selection.bindingId) ||
          (selection.service !== undefined && record.service !== selection.service)))) throw invalid();
      records.push(record);
    }
    continuation = page.continuation;
  } while (continuation);
  return projectCredentialExposures(records).records.slice();
}
export async function assertIndexedCredentialRoute(current: DurableProjectionReadContext, input: {
  readonly deviceId: string; readonly bindingId: string; readonly service: string;
  readonly principalFingerprint?: string; readonly tenant?: string; readonly scopes?: readonly string[];
}): Promise<void> {
  const route: Route = { bindingId: input.bindingId, service: input.service, deviceId: null,
    mask: Number(input.principalFingerprint !== undefined) + 2 * Number(input.tenant !== undefined) + 4 * Number(input.scopes !== undefined),
    principal: input.principalFingerprint ?? null, tenant: input.tenant ?? null, scopes: input.scopes ?? null,
  };
  const all = readTotals(route, await current.get(routeKey(route)));
  const localRoute = { ...route, deviceId: input.deviceId };
  const local = readTotals(localRoute, await current.get(routeKey(localRoute)));
  if (local.total > all.total || local.active > all.active || local.compromised > all.compromised) throw invalid();
  if (all.total > 0 && (all.compromised > 0 || local.active === 0)) {
    throw new Error("Credential binding is blocked until the affected account is rotated");
  }
}
