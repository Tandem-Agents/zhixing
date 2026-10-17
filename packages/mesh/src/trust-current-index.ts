import type { CommitEnvelope, DeviceIdentity, HomeTrustEvent, HomeTrustRecord, JsonValue } from "@zhixing/core/contracts";
import {
  createDurableProjectionOverlay, DurableProjectionRecordBindingError,
  type AuthorityCommitLog, type DurableLogCheckpoint, type DurableProjectionReadContext,
  type RebuildableDurableProjectionIndex,
} from "@zhixing/core/authority";
import { canonicalize, protocolDigest } from "./canonical.js";
import { applyTrustEvent, initializeTrustChain, verifyHomeTrustRecord, type TrustProjection } from "./trust-chain.js";

export const CURRENT_TRUST_PROJECTION_ID = "home-current-trust";
type Member = TrustProjection["members"][number];
interface MemberRow { readonly member: Member; readonly reset: number; readonly ordinal: number }
/** 最新一份已核验签名信任记录在 WAL 中的精确位置；完整记录按需读这一帧，不重放信任链。 */
interface RecordLocator {
  readonly checkpoint: DurableLogCheckpoint;
  readonly entry: number;
  readonly digest: string;
}
interface Head {
  readonly genesis: DurableLogCheckpoint;
  readonly projection: Omit<TrustProjection, "members">;
  readonly count: number;
  readonly reset: number;
  readonly recordHead?: TrustProjection["chainHead"];
  readonly record?: RecordLocator;
}
export interface VerifiedTrustIdentity {
  readonly identity: DeviceIdentity;
  /** First committed registration of this public identity in this source. */
  readonly firstSeen: DurableLogCheckpoint;
}
/** A verified current view deliberately carries no signature for a shortened
 * member list. Complete signed records remain available through explicit audit. */
export interface CurrentTrustProjection extends TrustProjection {
  readonly members: readonly Member[];
}
const HEAD = "trust/head";
const memberKey = (id: string) => "trust/member/" + id;
const identityKey = (id: string) => "trust/identity/" + id;
const activePrefix = (reset: number) => "trust/active/" + reset + "/";
function invalid(): DurableProjectionRecordBindingError { return new DurableProjectionRecordBindingError("Current trust projection binding is invalid"); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function readHead(value: unknown): Head | undefined {
  if (value === undefined) return;
  if (!object(value) || !object(value.genesis) || !Number.isSafeInteger(value.genesis.lsn) || !object(value.projection) || !Number.isSafeInteger(value.count) || (value.count as number) < 1 ||
      !Number.isSafeInteger(value.reset) || (value.reset as number) < 0 ||
      typeof value.projection.homeId !== "string" || !object(value.projection.chainHead) || !object(value.projection.issuer)) throw invalid();
  if (value.record !== undefined && (!object(value.record) || !object(value.record.checkpoint) ||
      !Number.isSafeInteger(value.record.checkpoint.lsn) || (value.record.checkpoint.lsn as number) < 1 ||
      !Number.isSafeInteger(value.record.entry) || (value.record.entry as number) < 0 || typeof value.record.digest !== "string")) throw invalid();
  return value as unknown as Head;
}
function readMember(id: string, value: unknown, reset: number): MemberRow | undefined {
  if (value === undefined) return;
  if (!object(value) || !object(value.member) || !object(value.member.device) || value.member.device.deviceId !== id ||
      !Array.isArray(value.member.roles) || !["active", "revoked", "pending-reenroll"].includes(value.member.state as string) ||
      !Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0 || !Number.isSafeInteger(value.reset) ||
      (value.reset as number) < 0 || (value.reset as number) > reset) throw invalid();
  const row = value as unknown as MemberRow;
  return row.reset < reset && row.member.state === "active"
    ? { ...row, member: { ...row.member, state: "pending-reenroll" } } : row;
}
function write(changes: Map<string, JsonValue | undefined>, key: string, value: unknown): void {
  changes.set(key, value as JsonValue);
}
async function rememberIdentity(view: DurableProjectionReadContext, changes: Map<string, JsonValue | undefined>,
  identity: DeviceIdentity, firstSeen: DurableLogCheckpoint): Promise<void> {
  const prior = await view.get(identityKey(identity.deviceId));
  if (prior !== undefined) {
    const registered = decodeTrustIdentity(identity.deviceId, prior);
    if (registered.identity.publicKey !== identity.publicKey) throw new TypeError("Trust key identity cannot be replaced");
    return;
  }
  write(changes, identityKey(identity.deviceId), { identity, firstSeen });
}
export function decodeTrustIdentity(keyId: string, value: unknown): VerifiedTrustIdentity {
  if (!object(value) || !object(value.identity) || value.identity.deviceId !== keyId || typeof value.identity.publicKey !== "string" ||
      !object(value.firstSeen) || typeof value.firstSeen.logId !== "string" || !Number.isSafeInteger(value.firstSeen.lsn) ||
      (value.firstSeen.lsn as number) < 1 || !Number.isSafeInteger(value.firstSeen.frameEndOffset) || typeof value.firstSeen.prefixDigest !== "string") throw invalid();
  return value as unknown as VerifiedTrustIdentity;
}

export function currentTrustIndex(log: AuthorityCommitLog): RebuildableDurableProjectionIndex {
  return log.durableProjection({ projectionId: CURRENT_TRUST_PROJECTION_ID, reducerVersion: 1, authenticated: true,
    inputs: { streams: ["trust"] },
    async reduce(envelope, current, source) {
      const changes = new Map<string, JsonValue | undefined>();
      const view = createDurableProjectionOverlay(current, changes);
      for (const [position, entry] of envelope.entries.entries()) {
        if (entry.stream !== "trust") continue;
        if (!object(entry.body)) throw new TypeError("Trust stream record is invalid");
        const body = entry.body;
        let head = readHead(await view.get(HEAD));
        if (body.t === "home-trust-event") {
          const event = body.event as unknown as HomeTrustEvent;
          if (!object(event) || !object(event.body)) throw new TypeError("Trust event is invalid");
          let next: TrustProjection;
          const touched = new Map<string, MemberRow>();
          if (!head) {
            next = initializeTrustChain(event);
            head = { projection: omitMembers(next), count: 0, reset: 0, genesis: source.checkpoint };
          } else {
            const ids = new Set([head.projection.issuer.deviceId]);
            switch (event.body.t) {
              case "enroll": ids.add(event.body.device.deviceId); break;
              case "reenroll": case "role-change": case "revoke": ids.add(event.body.deviceId); break;
              case "domain-reset": ids.add(event.body.coSign.deviceId); break;
              case "issuer-transition": ids.add(event.body.toDeviceId); break;
            }
            for (const id of ids) {
              const row = readMember(id, await view.get(memberKey(id)), head.reset);
              if (row) touched.set(id, row);
            }
            // Existing chain validation needs only issuer, target and co-signer.
            // Domain reset is represented by one generation, not H member edits.
            next = applyTrustEvent({ ...head.projection, members: [...touched.values()].map(row => row.member) }, event);
          }
          const reset = head.reset + Number(event.body.t === "domain-reset");
          let count = head.count;
          for (const member of next.members) {
            const old = touched.get(member.device.deviceId);
            if (old && reset === head.reset && canonicalize(old.member) === canonicalize(member)) continue;
            if (old && old.member.state === "active") changes.set(activePrefix(head.reset) + member.device.deviceId, undefined);
            const ordinal = old?.ordinal ?? count++;
            write(changes, memberKey(member.device.deviceId), { member, ordinal, reset });
            if (member.state === "active") write(changes, activePrefix(reset) + member.device.deviceId, member.device.deviceId);
            await rememberIdentity(view, changes, member.device, source.checkpoint);
          }
          if (next.issuer.issuerPublicKey) {
            const issuer = next.members.find(member => member.device.deviceId === next.issuer.deviceId);
            if (!issuer) throw invalid();
            await rememberIdentity(view, changes, { ...issuer.device, deviceId: next.issuer.issuerKeyId,
              publicKey: next.issuer.issuerPublicKey }, source.checkpoint);
          }
          write(changes, HEAD, { projection: omitMembers(next), count, reset, genesis: head.genesis,
            ...(head.recordHead ? { recordHead: head.recordHead } : {}) });
        } else if (body.t === "home-trust-record") {
          if (!head || !object(body.record) || !Array.isArray(body.record.members)) throw new TypeError("Trust record has no valid chain");
          const record = body.record as unknown as HomeTrustRecord;
          if (record.members.length !== head.count) throw new TypeError("Trust record member set does not match its chain");
          const members: Member[] = [];
          for (let ordinal = 0; ordinal < record.members.length; ordinal++) {
            const declared = record.members[ordinal]!;
            const row = readMember(declared.device.deviceId, await view.get(memberKey(declared.device.deviceId)), head.reset);
            if (!row || row.ordinal !== ordinal || canonicalize(row.member) !== canonicalize(declared)) throw new TypeError("Trust record member does not match its chain");
            members.push(row.member);
          }
          verifyHomeTrustRecord(record, { ...head.projection, members });
          write(changes, HEAD, { ...head, recordHead: head.projection.chainHead,
            record: { checkpoint: source.checkpoint, entry: position, digest: protocolDigest("HomeTrustRecord", 1, record) } });
        } else throw new TypeError("Trust stream record type is unsupported");
      }
      return [...changes].map(([key, value]) => value === undefined ? { kind: "tombstone" as const, key } : { kind: "put" as const, key, value });
    },
  });
}
function omitMembers(projection: TrustProjection): Omit<TrustProjection, "members"> {
  const { members: _members, ...head } = projection; return head;
}

/** Must run inside one selected projection read/transaction boundary. */
export async function readCurrentTrust(view: DurableProjectionReadContext): Promise<CurrentTrustProjection | undefined> {
  const head = readHead(await view.get(HEAD));
  if (!head) return;
  if (!head.recordHead || canonicalize(head.recordHead) !== canonicalize(head.projection.chainHead)) throw new Error("Home trust projection record is missing or stale");
  const members: Member[] = [];
  const prefix = activePrefix(head.reset);
  let continuation: string | undefined;
  do {
    const page = await view.scan({ gte: prefix, lt: prefix + "\uffff" }, 256, continuation);
    for (const entry of page.entries) {
      if (typeof entry.value !== "string" || entry.key !== prefix + entry.value) throw invalid();
      const row = readMember(entry.value, await view.get(memberKey(entry.value)), head.reset);
      if (!row || row.member.state !== "active") throw invalid();
      members.push(row.member);
    }
    continuation = page.continuation;
  } while (continuation);
  return { ...head.projection, members };
}
/**
 * 当前签名信任记录（含已撤销成员，与旧整链读取返回同一份记录）：按索引定位精确读取一帧并核对摘要。
 * 没有信任链时为 undefined；记录缺失或落后于链头时与旧实现同样拒绝。
 */
export async function readCurrentTrustRecord(view: DurableProjectionReadContext,
  readEnvelopeAt: (checkpoint: DurableLogCheckpoint) => Promise<CommitEnvelope<JsonValue>>): Promise<HomeTrustRecord | undefined> {
  const head = readHead(await view.get(HEAD));
  if (!head) return;
  if (!head.record || !head.recordHead || canonicalize(head.recordHead) !== canonicalize(head.projection.chainHead)) {
    throw new Error("Home trust projection record is missing or stale");
  }
  const envelope = await readEnvelopeAt(head.record.checkpoint);
  const entry = envelope.entries[head.record.entry];
  const body = entry?.body;
  if (entry?.stream !== "trust" || !object(body) || body.t !== "home-trust-record" || !object(body.record) ||
      protocolDigest("HomeTrustRecord", 1, body.record) !== head.record.digest) throw invalid();
  return body.record as unknown as HomeTrustRecord;
}

export async function readTrustIdentity(view: DurableProjectionReadContext, keyId: string,
  before?: DurableLogCheckpoint): Promise<VerifiedTrustIdentity | undefined> {
  const value = await view.get(identityKey(keyId));
  if (value === undefined) return;
  const registered = decodeTrustIdentity(keyId, value);
  if (before && (registered.firstSeen.logId !== before.logId || registered.firstSeen.lsn > before.lsn)) return;
  return registered;
}

export async function readTrustGenesis(view: DurableProjectionReadContext): Promise<DurableLogCheckpoint | undefined> {
  return readHead(await view.get(HEAD))?.genesis;
}
