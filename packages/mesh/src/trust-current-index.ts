import type { CommitEnvelope, DeviceIdentity, HomeTrustEvent, HomeTrustRecord, JsonValue } from "@zhixing/core/contracts";
import {
  createDurableProjectionOverlay, DurableProjectionRecordBindingError,
  type AuthorityCommitLog, type DurableLogCheckpoint, type DurableProjectionReadContext,
  type RebuildableDurableProjectionIndex,
  type VerifiedAnchorTenure,
} from "@zhixing/core/authority";
import { canonicalize, protocolDigest } from "./canonical.js";
import {
  applyTrustEvent, homeTrustEventDigest, homeTrustRecordDigest, initializeTrustChain, verifyHistoricalHomeTrustRecord,
  verifyHomeTrustRecord, type HistoricalHomeTrustRecord, type TrustProjection,
} from "./trust-chain.js";

export const CURRENT_TRUST_PROJECTION_ID = "home-current-trust";
type Member = TrustProjection["members"][number];
interface MemberRow { readonly member: Member; readonly reset: number; readonly ordinal: number }
/** 最新一份已核验签名信任记录在 WAL 中的精确位置；完整记录按需读这一帧，不重放信任链。 */
interface RecordLocator {
  readonly checkpoint: DurableLogCheckpoint;
  readonly entry: number;
  readonly digest: string;
  readonly v: 1 | 2;
}
interface Head {
  readonly genesis: DurableLogCheckpoint;
  readonly projection: Omit<TrustProjection, "members">;
  /** 全部登记过的成员数（成员行序号与 v1 历史帧用） */
  readonly count: number;
  /** 当前 reset 代 active 目录的成员数：v2 快照与当前视图按它闭合 */
  readonly active: number;
  readonly reset: number;
  readonly recordHead?: TrustProjection["chainHead"];
  readonly record?: RecordLocator;
  /** 链上已核验过的最新快照版本；出现 v2 之后不再接受 v1 */
  readonly recordVersion?: 1 | 2;
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
      !Number.isSafeInteger(value.active) || (value.active as number) < 1 || (value.active as number) > (value.count as number) ||
      !Number.isSafeInteger(value.reset) || (value.reset as number) < 0 ||
      (value.recordVersion !== undefined && value.recordVersion !== 1 && value.recordVersion !== 2) ||
      typeof value.projection.homeId !== "string" || !Number.isSafeInteger(value.projection.anchorEpoch) || (value.projection.anchorEpoch as number) < 1 || !object(value.projection.chainHead) || !object(value.projection.issuer)) throw invalid();
  if (value.record !== undefined && (!object(value.record) || !object(value.record.checkpoint) ||
      !Number.isSafeInteger(value.record.checkpoint.lsn) || (value.record.checkpoint.lsn as number) < 1 ||
      !Number.isSafeInteger(value.record.entry) || (value.record.entry as number) < 0 || typeof value.record.digest !== "string" ||
      (value.record.v !== 1 && value.record.v !== 2))) throw invalid();
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
  return log.durableProjection({ projectionId: CURRENT_TRUST_PROJECTION_ID, reducerVersion: 4, authenticated: true,
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
            head = { projection: omitMembers(next), count: 0, active: 0, reset: 0, genesis: source.checkpoint };
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
          // active 计数只算当前 reset 代的目录：换代后从 0 起，旧代的 active 行读出即为待重新配对
          let active = reset === head.reset ? head.active : 0;
          for (const member of next.members) {
            const old = touched.get(member.device.deviceId);
            if (old && reset === head.reset && canonicalize(old.member) === canonicalize(member)) continue;
            if (old && old.member.state === "active") {
              changes.set(activePrefix(head.reset) + member.device.deviceId, undefined);
              if (reset === head.reset) active -= 1;
            }
            const ordinal = old?.ordinal ?? count++;
            write(changes, memberKey(member.device.deviceId), { member, ordinal, reset });
            if (member.state === "active") {
              write(changes, activePrefix(reset) + member.device.deviceId, member.device.deviceId);
              active += 1;
            }
            await rememberIdentity(view, changes, member.device, source.checkpoint);
          }
          if (next.issuer.issuerPublicKey) {
            const issuer = next.members.find(member => member.device.deviceId === next.issuer.deviceId);
            if (!issuer) throw invalid();
            await rememberIdentity(view, changes, { ...issuer.device, deviceId: next.issuer.issuerKeyId,
              publicKey: next.issuer.issuerPublicKey }, source.checkpoint);
          }
          write(changes, HEAD, { projection: omitMembers(next), count, active, reset, genesis: head.genesis,
            ...(head.recordHead ? { recordHead: head.recordHead } : {}),
            ...(head.recordVersion ? { recordVersion: head.recordVersion } : {}) });
          write(changes, 'trust/event/' + String(event.seq).padStart(16, '0'), event);
          // 事件摘要 → 序号：需要某条原信任事件的地方按摘要精确读这一条，不整读信任流。
          write(changes, eventDigestKey(homeTrustEventDigest(event)), event.seq);
          if (event.body.t === 'genesis' || event.body.t === 'issuer-transition') {
            write(changes, 'trust/tenure/' + String(next.anchorEpoch).padStart(16, '0'), {
              homeId: next.homeId, anchorEpoch: next.anchorEpoch, deviceId: next.issuer.deviceId,
              chainHead: next.chainHead, checkpoint: source.checkpoint,
            });
            write(changes, 'trust/tenure-at/' + String(Number.MAX_SAFE_INTEGER - envelope.lsn).padStart(16, '0'), next.anchorEpoch);
          }
        } else if (body.t === "home-trust-record") {
          if (!head || !object(body.record) || !Array.isArray(body.record.members)) throw new TypeError("Trust record has no valid chain");
          let record: HomeTrustRecord | HistoricalHomeTrustRecord;
          if (body.record.v === 2) {
            // 当前快照：只按 active 目录与 active 计数闭合，读取随当前成员数
            record = body.record as unknown as HomeTrustRecord;
            verifyHomeTrustRecord(record, { ...head.projection, members: await readActiveMembers(view, head) });
          } else if (body.record.v === 1) {
            // 权威历史帧：按原规则与同一位置的全部成员逐序号核对；链上出现 v2 之后不再接受
            if (head.recordVersion === 2) throw new TypeError("Trust record v1 cannot follow a current snapshot");
            const historical = body.record as unknown as HistoricalHomeTrustRecord;
            if (historical.members.length !== head.count) throw new TypeError("Trust record member set does not match its chain");
            const members: Member[] = [];
            for (let ordinal = 0; ordinal < historical.members.length; ordinal++) {
              const declared = historical.members[ordinal]!;
              const row = readMember(declared.device.deviceId, await view.get(memberKey(declared.device.deviceId)), head.reset);
              if (!row || row.ordinal !== ordinal || canonicalize(row.member) !== canonicalize(declared)) throw new TypeError("Trust record member does not match its chain");
              members.push(row.member);
            }
            verifyHistoricalHomeTrustRecord(historical, { ...head.projection, members });
            record = historical;
          } else throw new TypeError("Trust record version is unsupported");
          const locator = { checkpoint: source.checkpoint, entry: position, digest: homeTrustRecordDigest(record), v: record.v };
          write(changes, HEAD, { ...head, recordHead: head.projection.chainHead, recordVersion: record.v, record: locator });
          write(changes, 'trust/record/' + String(record.chainHead.seq).padStart(16, '0'), locator);
        } else throw new TypeError("Trust stream record type is unsupported");
      }
      return [...changes].map(([key, value]) => value === undefined ? { kind: "tombstone" as const, key } : { kind: "put" as const, key, value });
    },
  });
}
function omitMembers(projection: TrustProjection): Omit<TrustProjection, "members"> {
  const { members: _members, ...head } = projection; return head;
}

export type { VerifiedAnchorTenure } from '@zhixing/core/authority';
/** A single historical point from the already verified chain, never a replay. */
export async function readAnchorTenureAt(view: DurableProjectionReadContext, checkpoint: DurableLogCheckpoint): Promise<VerifiedAnchorTenure | undefined> {
  const head = readHead(await view.get(HEAD));
  if (!head || head.genesis.logId !== checkpoint.logId || head.genesis.lsn > checkpoint.lsn) return;
  const p = 'trust/tenure-at/';
  const page = await view.scan({ gte: p + String(Number.MAX_SAFE_INTEGER - checkpoint.lsn).padStart(16, '0'), lt: p + '\uffff' }, 1);
  const epoch = page.entries[0]?.value;
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 1) throw invalid();
  const tenure = await view.get('trust/tenure/' + String(epoch).padStart(16, '0')) as unknown as VerifiedAnchorTenure | undefined;
  if (!tenure || tenure.anchorEpoch !== epoch || tenure.homeId !== head.projection.homeId || tenure.checkpoint.logId !== checkpoint.logId || tenure.checkpoint.lsn > checkpoint.lsn) throw invalid();
  return tenure;
}

export async function readCurrentAnchorTenure(view: DurableProjectionReadContext): Promise<VerifiedAnchorTenure | undefined> {
  const head = readHead(await view.get(HEAD));
  if (!head) return;
  if (!head.recordHead || canonicalize(head.recordHead) !== canonicalize(head.projection.chainHead)) throw new Error('Home trust projection record is missing or stale');
  const tenure = await view.get('trust/tenure/' + String(head.projection.anchorEpoch).padStart(16, '0')) as unknown as VerifiedAnchorTenure | undefined;
  if (!tenure || tenure.anchorEpoch !== head.projection.anchorEpoch || tenure.deviceId !== head.projection.issuer.deviceId) throw invalid();
  return { ...tenure, chainHead: head.projection.chainHead };
}

/** 当前 reset 代 active 目录列出的成员，按键读各自的成员行；数目必须等于 head 的 active 计数。读取随当前成员数。 */
async function readActiveMembers(view: DurableProjectionReadContext, head: Head): Promise<Member[]> {
  const members: Member[] = [];
  const prefix = activePrefix(head.reset);
  let continuation: string | undefined;
  do {
    const page = await view.scan({ gte: prefix, lt: prefix + "￿" }, 256, continuation);
    for (const entry of page.entries) {
      if (typeof entry.value !== "string" || entry.key !== prefix + entry.value) throw invalid();
      const row = readMember(entry.value, await view.get(memberKey(entry.value)), head.reset);
      if (!row || row.member.state !== "active") throw invalid();
      members.push(row.member);
    }
    continuation = page.continuation;
  } while (continuation);
  if (members.length !== head.active) throw invalid();
  return members;
}

function eventDigestKey(digest: string): string {
  return "trust/event-digest/" + digest;
}

/** 按事件摘要精确读一条已入链的信任事件：两次按键读，摘要不符即视为投影损坏。 */
export async function readTrustEventByDigest(view: DurableProjectionReadContext, digest: string): Promise<HomeTrustEvent | undefined> {
  const seq = await view.get(eventDigestKey(digest));
  if (seq === undefined) return undefined;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) throw invalid();
  const event = await view.get('trust/event/' + String(seq).padStart(16, '0')) as unknown as HomeTrustEvent | undefined;
  if (!event || !object(event) || event.seq !== seq || homeTrustEventDigest(event) !== digest) throw invalid();
  return event;
}

export async function readCurrentTrustMember(view: DurableProjectionReadContext, deviceId: string): Promise<Member | undefined> {
  const head = readHead(await view.get(HEAD));
  return head ? readMember(deviceId, await view.get(memberKey(deviceId)), head.reset)?.member : undefined;
}

/** Incomplete suffixes are verified chain progress, not a ready trust view. */
export async function readVerifiedTrustProgress(view: DurableProjectionReadContext) {
  const head = readHead(await view.get(HEAD));
  const complete = !!head?.recordHead && canonicalize(head.recordHead) === canonicalize(head.projection.chainHead);
  return head ? { homeId: head.projection.homeId, chainHead: head.projection.chainHead, complete,
    // 链头已闭合但只由 v1 历史帧闭合：需要从值班设备取回同一链头的 v2 快照
    currentRecord: complete && head.record?.v === 2,
    ...(head.recordHead ? { completeHead: head.recordHead } : {}) } : undefined;
}

export async function readTrustReconciliationPage(view: DurableProjectionReadContext,
  readEnvelopeAt: (checkpoint: DurableLogCheckpoint) => Promise<CommitEnvelope<JsonValue>>,
  input: { homeId: string; chainHead: HomeTrustRecord['chainHead']; through?: HomeTrustRecord['chainHead']; needRecord?: boolean }) {
  const head = readHead(await view.get(HEAD));
  if (!head || head.projection.homeId !== input.homeId || !head.recordHead) throw new Error('Trust reconciliation has no complete matching home');
  // Stop at an original signed record boundary. The receiver publishes the
  // complete group atomically; transport pages never become partial trust.
  const nextRecord = input.chainHead.seq < head.recordHead.seq && !input.through
    ? (await view.scan({ gte: 'trust/record/' + String(input.chainHead.seq + 1).padStart(16, '0'),
      lt: 'trust/record/\uffff' }, 1)).entries[0] : undefined;
  const nextSeq = nextRecord ? Number(nextRecord.key.slice('trust/record/'.length)) : undefined;
  const eventAt = async (seq: number) => {
    const event = await view.get('trust/event/' + String(seq).padStart(16, '0')) as unknown as HomeTrustEvent | undefined;
    if (!event || event.seq !== seq || event.homeId !== input.homeId) throw invalid();
    return event;
  };
  const digest = (event: HomeTrustEvent) => { const { signature: _, ...body } = event; return protocolDigest('HomeTrustEvent', 1, body); };
  const target = input.through ?? (nextSeq === undefined ? head.recordHead : {
    seq: nextSeq, eventDigest: digest(await eventAt(nextSeq)),
  });
  const latest = head.recordHead;
  if (target.seq > head.recordHead.seq || digest(await eventAt(target.seq)) !== target.eventDigest) throw new TypeError('Requested trust target is not a verified prefix');
  if (input.chainHead.seq > target.seq) return { target, latest, events: [] as HomeTrustEvent[], done: true };
  if (digest(await eventAt(input.chainHead.seq)) !== input.chainHead.eventDigest) throw new TypeError('Peer trust prefix conflicts with its signed history');
  const events: HomeTrustEvent[] = [];
  for (let seq = input.chainHead.seq + 1; seq <= target.seq && events.length < 16; seq++) events.push(await eventAt(seq));
  const done = (events.at(-1)?.seq ?? input.chainHead.seq) === target.seq;
  // 组边界上的原始签名快照；较早的边界可能是 v1 历史帧，接收方的归约器按版本核对
  let record: HomeTrustRecord | HistoricalHomeTrustRecord | undefined;
  if (done && (events.length || input.needRecord)) {
    const locator = await view.get('trust/record/' + String(target.seq).padStart(16, '0')) as unknown as RecordLocator | undefined;
    if (!locator) throw new Error('Signed trust record for the requested prefix is unavailable');
    const envelope = await readEnvelopeAt(locator.checkpoint), entry = envelope.entries[locator.entry];
    if (entry?.stream !== 'trust' || !object(entry.body) || entry.body.t !== 'home-trust-record' || !object(entry.body.record) ||
        entry.body.record.v !== locator.v ||
        homeTrustRecordDigest(entry.body.record as unknown as HomeTrustRecord | HistoricalHomeTrustRecord) !== locator.digest) throw invalid();
    record = entry.body.record as unknown as HomeTrustRecord | HistoricalHomeTrustRecord;
  }
  return { target, latest, events, done, ...(record ? { record } : {}) };
}

/** Must run inside one selected projection read/transaction boundary. */
export async function readCurrentTrust(view: DurableProjectionReadContext): Promise<CurrentTrustProjection | undefined> {
  const head = readHead(await view.get(HEAD));
  if (!head) return;
  if (!head.recordHead || canonicalize(head.recordHead) !== canonicalize(head.projection.chainHead)) throw new Error("Home trust projection record is missing or stale");
  return { ...head.projection, members: await readActiveMembers(view, head) };
}
/** 链头只由 v1 历史帧闭合、还没有当前快照时的错误；值班设备补签或对齐取回同一链头的 v2 之后消失。 */
export const LEGACY_TRUST_RECORD_MESSAGE = "Home trust record predates the current snapshot format";

/**
 * 一次性接续：链头只由 v1 历史帧闭合时，由当前签发者为同一链头补签 v2 快照。
 * 只读当前视图（链头与 active 目录），已有当前快照时返回 undefined。
 */
export async function readLegacyClosedTrust(view: DurableProjectionReadContext): Promise<CurrentTrustProjection | undefined> {
  const head = readHead(await view.get(HEAD));
  if (!head?.record || head.record.v === 2 || !head.recordHead ||
      canonicalize(head.recordHead) !== canonicalize(head.projection.chainHead)) return undefined;
  return { ...head.projection, members: await readActiveMembers(view, head) };
}

/**
 * 当前签名信任记录（v2，只列 active 成员）：按索引定位精确读取一帧并核对摘要。
 * 没有信任链时为 undefined；记录缺失或落后于链头时拒绝；链头只由 v1 历史帧闭合时拒绝。
 */
export async function readCurrentTrustRecord(view: DurableProjectionReadContext,
  readEnvelopeAt: (checkpoint: DurableLogCheckpoint) => Promise<CommitEnvelope<JsonValue>>): Promise<HomeTrustRecord | undefined> {
  const head = readHead(await view.get(HEAD));
  if (!head) return;
  if (!head.record || !head.recordHead || canonicalize(head.recordHead) !== canonicalize(head.projection.chainHead)) {
    throw new Error("Home trust projection record is missing or stale");
  }
  if (head.record.v !== 2) throw new Error(LEGACY_TRUST_RECORD_MESSAGE);
  const envelope = await readEnvelopeAt(head.record.checkpoint);
  const entry = envelope.entries[head.record.entry];
  const body = entry?.body;
  if (entry?.stream !== "trust" || !object(body) || body.t !== "home-trust-record" || !object(body.record) ||
      body.record.v !== 2 || homeTrustRecordDigest(body.record as unknown as HomeTrustRecord) !== head.record.digest) throw invalid();
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
