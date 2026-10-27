import type { CommitEnvelope, DeviceIdentity, HomeTrustEvent, HomeTrustRecord, JsonValue } from "@zhixing/core/contracts";
import {
  createDurableProjectionOverlay, DurableProjectionRecordBindingError,
  type AuthorityCommitLog, type DurableLogCheckpoint, type DurableProjectionReadContext,
  type RebuildableDurableProjectionIndex,
  type VerifiedAnchorTenure,
} from "@zhixing/core/authority";
import { canonicalize, protocolDigest } from "./canonical.js";
import {
  applyTrustEvent, applyTrustEventWithHistory, homeTrustEventDigest, homeTrustRecordDigest, initializeTrustChain,
  trustBranchAdoptionId, trustEventMemberIds,
  verifyHistoricalHomeTrustRecord, verifyHomeTrustRecord, type HistoricalHomeTrustRecord, type HomeTrustBranchStagedRecord,
  type TrustProjection,
} from "./trust-chain.js";
import { assertRecoveryCommit, type DisasterRecoveryCommitProof } from "./recovery-commit.js";

export const CURRENT_TRUST_PROJECTION_ID = "home-current-trust";
type Member = TrustProjection["members"][number];
/** 成员行；revokedAt 是撤销该设备的事件序号（撤销是终态，供按点判断“那时是否已撤销”）。 */
interface MemberRow { readonly member: Member; readonly reset: number; readonly ordinal: number; readonly revokedAt?: number }
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
/**
 * 完整投影快照的间隔：序号是它的整数倍的事件之后存一份（含创世）。某点的投影 = 不晚于它的最近快照
 * + 至多 SNAPSHOT_INTERVAL - 1 条按键重放，读取与链长无关。
 */
const SNAPSHOT_INTERVAL = 64;
const snapshotKey = (seq: number) => "trust/snapshot/" + String(seq).padStart(16, "0");
const memberKey = (id: string) => "trust/member/" + id;
/** 未撤销成员（active 与待重新配对）的目录：快照只按它枚举，与已撤销的历史设备数无关。 */
const liveKey = (id: string) => "trust/live/" + id;
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
      (value.reset as number) < 0 || (value.reset as number) > reset ||
      (value.revokedAt !== undefined && (!Number.isSafeInteger(value.revokedAt) || value.member.state !== "revoked"))) throw invalid();
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
  return log.durableProjection({ projectionId: CURRENT_TRUST_PROJECTION_ID, reducerVersion: 7, authenticated: true,
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
            for (const id of trustEventMemberIds(head.projection.issuer.deviceId, event)) {
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
            const revokedAt = member.state === "revoked" ? (old?.revokedAt ?? event.seq) : undefined;
            write(changes, memberKey(member.device.deviceId), { member, ordinal, reset, ...(revokedAt === undefined ? {} : { revokedAt }) });
            if (member.state === "revoked") changes.set(liveKey(member.device.deviceId), undefined);
            else write(changes, liveKey(member.device.deviceId), member.device.deviceId);
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
          if (event.seq % SNAPSHOT_INTERVAL === 0) {
            // 只按 live 目录枚举未撤销成员（旧 reset 代的 active 行读出即为待重新配对）；已撤销的历史设备不进快照
            const rows: MemberRow[] = [];
            for (const { key } of await scanAll(view, { gte: "trust/live/", lt: "trust/live/\uffff" })) {
              const id = key.slice("trust/live/".length);
              const row = readMember(id, await view.get(memberKey(id)), reset);
              if (!row || row.member.state === "revoked") throw invalid();
              rows.push(row);
            }
            rows.sort((left, right) => left.ordinal - right.ordinal);
            write(changes, snapshotKey(event.seq), { ...omitMembers(next), members: rows.map((row) => row.member) });
          }
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
        } else if (body.t === "home-trust-branch-staged") {
          await stageTrustBranch(view, changes, head, body as unknown as HomeTrustBranchStagedRecord);
        } else if (body.t === "home-trust-branch-adopted") {
          if (!head || typeof body.adoptionId !== "string" || !object(body.record)) throw new TypeError("Trust branch adoption is invalid");
          await adoptTrustBranch(view, changes, head, body.adoptionId, body.record as unknown as HomeTrustRecord, source.checkpoint, position, envelope.lsn);
        } else throw new TypeError("Trust stream record type is unsupported");
      }
      return [...changes].map(([key, value]) => value === undefined ? { kind: "tombstone" as const, key } : { kind: "put" as const, key, value });
    },
  });
}
interface BranchHead {
  readonly ancestor: TrustProjection["chainHead"];
  readonly superseded: TrustProjection["chainHead"];
  readonly ancestorEpoch: number;
  readonly projection: TrustProjection;
  readonly last: number;
  readonly resets: number;
}
const pad = (value: number) => String(value).padStart(16, "0");
const branchHeadKey = (id: string) => `trust/branch/${id}/head`;
const branchEventKey = (id: string, seq: number) => `trust/branch/${id}/event/${pad(seq)}`;
const branchSnapshotKey = (id: string, seq: number) => `trust/branch/${id}/snapshot/${pad(seq)}`;
/** 区间 (after, through] 里快照间隔的整数倍序号。 */
function snapshotSeqs(after: number, through: number): number[] {
  const seqs: number[] = [];
  for (let seq = (Math.floor(after / SNAPSHOT_INTERVAL) + 1) * SNAPSHOT_INTERVAL; seq <= through; seq += SNAPSHOT_INTERVAL) seqs.push(seq);
  return seqs;
}
/**
 * 本机链上 seq 处的投影：最近快照 + 至多 63 条按键重放。快照只含未撤销成员；重放事件引用到的、在快照之前已撤销的
 * 历史设备按键补入（状态转移校验不漏项）。读取随未撤销成员数与本次重放引用的设备，与已撤销的历史设备数无关。
 * 快照缺失即视为索引损坏，不回退整链重放。
 */
async function projectionAtSeq(view: DurableProjectionReadContext, seq: number): Promise<TrustProjection> {
  const base = seq - (seq % SNAPSHOT_INTERVAL);
  const snapshot = await view.get(snapshotKey(base)) as unknown as TrustProjection | undefined;
  if (!object(snapshot) || !object(snapshot.chainHead) || snapshot.chainHead.seq !== base) throw invalid();
  let projection: TrustProjection = snapshot;
  const historical = (id: string) => revokedMemberAt(view, id, base);
  for (let next = base + 1; next <= seq; next++) {
    projection = await applyTrustEventWithHistory(projection, await eventAtSeq(view, next), historical);
  }
  return projection;
}

/** 在 seq 之时已撤销的设备（按键读成员行）；那时未撤销或不存在返回 undefined。 */
async function revokedMemberAt(view: DurableProjectionReadContext, deviceId: string, seq: number): Promise<Member | undefined> {
  const value = await view.get(memberKey(deviceId)) as unknown as MemberRow | undefined;
  if (!object(value) || !object(value.member) || value.member.state !== "revoked") return undefined;
  return typeof value.revokedAt === "number" && value.revokedAt <= seq ? value.member : undefined;
}

/** 对外：本机链上 seq 之时已撤销的设备（供以收窄投影接着验的一方按键补齐历史成员）。 */
export async function readRevokedTrustMemberAt(view: DurableProjectionReadContext, deviceId: string, seq: number): Promise<Member | undefined> {
  return revokedMemberAt(view, deviceId, seq);
}
async function eventAtSeq(view: DurableProjectionReadContext, seq: number): Promise<HomeTrustEvent> {
  const event = await view.get("trust/event/" + pad(seq)) as unknown as HomeTrustEvent | undefined;
  if (!event || event.seq !== seq) throw invalid();
  return event;
}
async function scanAll(view: DurableProjectionReadContext, range: { gte: string; lt: string }) {
  const entries: { readonly key: string; readonly value: JsonValue }[] = [];
  let continuation: string | undefined;
  do {
    const page = await view.scan(range, 256, continuation);
    entries.push(...page.entries);
    continuation = page.continuation;
  } while (continuation);
  return entries;
}
function isDisasterTransition(event: HomeTrustEvent): boolean {
  return event.body.t === "issuer-transition" && event.body.reason === "disaster-recovery";
}

/**
 * 分页暂存：首页核祖先与被替代链头等于本机当前、确为分叉、首条为灾备转移、旧分支祖先之后没有恢复根变更或
 * 域重置，并从索引重放到祖先得到祖先处投影；每页逐条应用（验原签名），灾备转移须有绑定它的根签 commit。
 * 只写暂存键，当前视图不变。
 */
async function stageTrustBranch(view: DurableProjectionReadContext, changes: Map<string, JsonValue | undefined>,
  head: Head | undefined, staged: HomeTrustBranchStagedRecord): Promise<void> {
  if (!head?.recordHead || typeof staged.adoptionId !== "string" || !Array.isArray(staged.events) || staged.events.length === 0 ||
      !Array.isArray(staged.recoveryCommits)) throw new TypeError("Trust branch staging is invalid");
  if (canonicalize(head.projection.chainHead) !== canonicalize(staged.superseded)) {
    throw new TypeError("Trust branch staging does not supersede the current chain head");
  }
  const prior = await view.get(branchHeadKey(staged.adoptionId)) as unknown as BranchHead | undefined;
  let projection: TrustProjection;
  let last: number;
  let resets: number;
  let ancestorEpoch: number;
  if (!prior) {
    const first = staged.events[0]!;
    if (staged.ancestor.seq >= staged.superseded.seq) throw new TypeError("Trust branch staging is not a fork");
    if (homeTrustEventDigest(await eventAtSeq(view, staged.ancestor.seq)) !== staged.ancestor.eventDigest) {
      throw new TypeError("Trust branch ancestor is not on the current chain");
    }
    if (trustBranchAdoptionId(staged.ancestor, staged.superseded, homeTrustEventDigest(first)) !== staged.adoptionId) {
      throw new TypeError("Trust branch adoption id does not bind its fork");
    }
    if (first.seq !== staged.ancestor.seq + 1 || !isDisasterTransition(first) ||
        homeTrustEventDigest(await eventAtSeq(view, first.seq)) === homeTrustEventDigest(first)) {
      throw new TypeError("A forked trust chain must begin with a recovery-root disaster transition");
    }
    for (let seq = staged.ancestor.seq + 1; seq <= staged.superseded.seq; seq++) {
      const old = await eventAtSeq(view, seq);
      if (old.body.t === "recovery-root" || old.body.t === "domain-reset") {
        throw new TypeError("A forked trust chain under a superseded recovery root is rejected");
      }
    }
    // 祖先处投影：最近快照 + 至多 63 条按键重放，不从创世重放
    projection = await projectionAtSeq(view, staged.ancestor.seq);
    last = staged.ancestor.seq;
    resets = 0;
    ancestorEpoch = projection.anchorEpoch;
  } else {
    if (canonicalize(prior.ancestor) !== canonicalize(staged.ancestor) || canonicalize(prior.superseded) !== canonicalize(staged.superseded)) {
      throw new TypeError("Trust branch staging changed its fork");
    }
    ({ projection, last, resets, ancestorEpoch } = prior);
  }
  const commits = staged.recoveryCommits as readonly DisasterRecoveryCommitProof[];
  const used = new Set<number>();
  const historical = (id: string) => revokedMemberAt(view, id, staged.ancestor.seq);
  for (const event of staged.events) {
    if (event.seq !== last + 1) throw new TypeError("Trust branch staging skips or repeats an event");
    const before = projection;
    projection = await applyTrustEventWithHistory(projection, event, historical);
    if (isDisasterTransition(event)) {
      const index = commits.findIndex((commit) => commit.trustTransitionDigest === homeTrustEventDigest(event));
      if (index < 0 || used.has(index)) throw new TypeError("A disaster transition has no committed recovery proof");
      used.add(index);
      assertRecoveryCommit(commits[index]!, event, before, projection);
    }
    if (event.body.t === "domain-reset") resets += 1;
    write(changes, branchEventKey(staged.adoptionId, event.seq), event);
    if (event.seq % SNAPSHOT_INTERVAL === 0) {
      write(changes, branchSnapshotKey(staged.adoptionId, event.seq), {
        ...projection, members: projection.members.filter((member) => member.state !== "revoked"),
      });
    }
    last = event.seq;
  }
  if (used.size !== commits.length) throw new TypeError("Trust branch staging carries an unrelated recovery commit");
  write(changes, branchHeadKey(staged.adoptionId), { ancestor: staged.ancestor, superseded: staged.superseded, ancestorEpoch, projection, last, resets });
}

/**
 * 原子发布：核当前链头仍是被替代链头、新记录按暂存投影的 active 成员验过，然后在同一次提交里重写祖先之后的
 * 成员、active、事件、摘要、任期与记录各键并写链头；旧分支事件保留到 trust/superseded/<id>/，清掉暂存键。
 */
async function adoptTrustBranch(view: DurableProjectionReadContext, changes: Map<string, JsonValue | undefined>, head: Head,
  adoptionId: string, record: HomeTrustRecord, checkpoint: DurableLogCheckpoint, position: number, lsn: number): Promise<void> {
  const branch = await view.get(branchHeadKey(adoptionId)) as unknown as BranchHead | undefined;
  if (!branch) throw new TypeError("Trust branch adoption has no staged branch");
  if (canonicalize(head.projection.chainHead) !== canonicalize(branch.superseded)) {
    throw new TypeError("Trust branch adoption no longer supersedes the current chain head");
  }
  if (record.v !== 2 || canonicalize(record.chainHead) !== canonicalize(branch.projection.chainHead)) {
    throw new TypeError("Trust branch adoption requires the current signed snapshot of the staged head");
  }
  const projection = branch.projection;
  verifyHomeTrustRecord(record, { ...projection, members: projection.members.filter((member) => member.state === "active") });
  // 旧分支段：事件移到 superseded 键；旧分支上才配对的设备在新视图里不存在
  const oldEnrolled = new Set<string>();
  for (let seq = branch.ancestor.seq + 1; seq <= branch.superseded.seq; seq++) {
    const old = await eventAtSeq(view, seq);
    if (old.body.t === "enroll") oldEnrolled.add(old.body.device.deviceId);
    write(changes, `trust/superseded/${adoptionId}/${pad(seq)}`, old);
    changes.set(eventDigestKey(homeTrustEventDigest(old)), undefined);
    changes.set("trust/event/" + pad(seq), undefined);
  }
  // 投影快照随视图切换：删掉旧分支祖先之后的，搬入暂存时为新分支算好的
  for (const seq of snapshotSeqs(branch.ancestor.seq, branch.superseded.seq)) changes.set(snapshotKey(seq), undefined);
  for (const seq of snapshotSeqs(branch.ancestor.seq, projection.chainHead.seq)) {
    const snapshot = await view.get(branchSnapshotKey(adoptionId, seq));
    if (snapshot === undefined) throw invalid();
    write(changes, snapshotKey(seq), snapshot);
    changes.set(branchSnapshotKey(adoptionId, seq), undefined);
  }
  for (const { key } of await scanAll(view, { gte: "trust/record/" + pad(branch.ancestor.seq + 1), lt: "trust/record/\uffff" })) {
    changes.set(key, undefined);
  }
  for (const { key } of await scanAll(view, { gte: "trust/tenure/" + pad(branch.ancestorEpoch + 1), lt: "trust/tenure/\uffff" })) {
    changes.set(key, undefined);
  }
  for (const { key, value } of await scanAll(view, { gte: "trust/tenure-at/", lt: "trust/tenure-at/\uffff" })) {
    if (typeof value === "number" && value > branch.ancestorEpoch) changes.set(key, undefined);
  }
  // 新分支上的撤销序号（成员行的 revokedAt）
  const branchRevokedAt = new Map<string, number>();
  for (let seq = branch.ancestor.seq + 1; seq <= projection.chainHead.seq; seq++) {
    const event = await view.get(branchEventKey(adoptionId, seq)) as unknown as HomeTrustEvent | undefined;
    if (event?.body.t === "revoke") branchRevokedAt.set(event.body.deviceId, seq);
  }
  // 成员行只改写暂存投影里的成员（祖先处未撤销的全部成员、新分支动到的成员）；祖先之前已撤销的历史设备行不动
  const reset = head.reset + branch.resets;
  let active = 0;
  let count = head.count;
  for (const member of projection.members) {
    const id = member.device.deviceId;
    oldEnrolled.delete(id);
    const old = readMember(id, await view.get(memberKey(id)), head.reset);
    if (old?.member.state === "active") changes.set(activePrefix(head.reset) + id, undefined);
    const revokedAt = member.state === "revoked" ? (branchRevokedAt.get(id) ?? old?.revokedAt) : undefined;
    write(changes, memberKey(id), { member, ordinal: old?.ordinal ?? count++, reset, ...(revokedAt === undefined ? {} : { revokedAt }) });
    if (member.state === "revoked") changes.set(liveKey(id), undefined);
    else write(changes, liveKey(id), id);
    if (member.state === "active") {
      write(changes, activePrefix(reset) + id, id);
      active += 1;
    }
    await rememberIdentity(view, changes, member.device, checkpoint);
  }
  for (const id of oldEnrolled) {
    changes.set(memberKey(id), undefined);
    changes.set(liveKey(id), undefined);
    changes.set(activePrefix(head.reset) + id, undefined);
  }
  let epoch = branch.ancestorEpoch;
  for (let seq = branch.ancestor.seq + 1; seq <= projection.chainHead.seq; seq++) {
    const event = await view.get(branchEventKey(adoptionId, seq)) as unknown as HomeTrustEvent | undefined;
    if (!event || event.seq !== seq) throw invalid();
    write(changes, "trust/event/" + pad(seq), event);
    write(changes, eventDigestKey(homeTrustEventDigest(event)), seq);
    changes.set(branchEventKey(adoptionId, seq), undefined);
    if (event.body.t === "issuer-transition") {
      epoch += 1;
      const body = event.body;
      const device = projection.members.find((member) => member.device.deviceId === body.toDeviceId)?.device;
      if (!device) throw invalid();
      if (body.toIssuerPublicKey) {
        await rememberIdentity(view, changes, { ...device, deviceId: body.toIssuerKeyId, publicKey: body.toIssuerPublicKey }, checkpoint);
      }
      write(changes, "trust/tenure/" + pad(epoch), {
        homeId: projection.homeId, anchorEpoch: epoch, deviceId: body.toDeviceId,
        chainHead: { seq, eventDigest: homeTrustEventDigest(event) }, checkpoint,
      });
      write(changes, "trust/tenure-at/" + pad(Number.MAX_SAFE_INTEGER - lsn), epoch);
    }
  }
  changes.set(branchHeadKey(adoptionId), undefined);
  const locator = { checkpoint, entry: position, digest: homeTrustRecordDigest(record), v: 2 as const };
  write(changes, "trust/record/" + pad(record.chainHead.seq), locator);
  write(changes, `trust/adopted/${adoptionId}`, { ancestor: branch.ancestor, superseded: branch.superseded, head: record.chainHead });
  write(changes, HEAD, {
    projection: omitMembers(projection), count, active, reset, genesis: head.genesis,
    recordHead: record.chainHead, recordVersion: 2, record: locator,
  });
}

/** 被取代旧分支上 afterSeq 之后的至多 limit 条原签名事件（按键范围读，有界）。 */
export async function readSupersededTrustEvents(
  view: DurableProjectionReadContext,
  adoptionId: string,
  afterSeq: number,
  limit: number,
): Promise<readonly HomeTrustEvent[]> {
  const page = await view.scan(
    { gte: `trust/superseded/${adoptionId}/${pad(afterSeq + 1)}`, lt: `trust/superseded/${adoptionId}/￿` },
    limit,
  );
  return page.entries.map(({ value }) => {
    const event = value as unknown as HomeTrustEvent;
    if (!object(event) || !Number.isSafeInteger(event.seq)) throw invalid();
    return event;
  });
}

/** 本机链上某一点的投影：按摘要精确定位，再取最近快照并按键重放至多 63 条；读取与链长无关。 */
export async function readTrustProjectionAt(
  view: DurableProjectionReadContext,
  point: TrustProjection["chainHead"],
): Promise<TrustProjection | undefined> {
  const located = await readTrustEventByDigest(view, point.eventDigest);
  if (!located || located.seq !== point.seq) return undefined;
  return projectionAtSeq(view, point.seq);
}

/** 本机链上 seq 处的事件（按键读）；没有返回 undefined。 */
export async function readTrustEventAt(view: DurableProjectionReadContext, seq: number): Promise<HomeTrustEvent | undefined> {
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
  const event = await view.get("trust/event/" + pad(seq)) as unknown as HomeTrustEvent | undefined;
  if (event !== undefined && (!object(event) || event.seq !== seq)) throw invalid();
  return event;
}

/** 本机链上 afterSeq 之后的至多 limit 条事件（按键范围读，有界）。 */
export async function readTrustEventsAfter(
  view: DurableProjectionReadContext,
  afterSeq: number,
  limit: number,
): Promise<readonly HomeTrustEvent[]> {
  const page = await view.scan({ gte: "trust/event/" + pad(afterSeq + 1), lt: "trust/event/\uffff" }, limit);
  return page.entries.map(({ value }, index) => {
    const event = value as unknown as HomeTrustEvent;
    if (!object(event) || event.seq !== afterSeq + 1 + index) throw invalid();
    return event;
  });
}

/** 进行中的分支暂存：祖先、被替代链头与已暂存到的投影；没有返回 undefined。 */
export async function readStagedTrustBranch(view: DurableProjectionReadContext, adoptionId: string): Promise<{
  readonly ancestor: TrustProjection["chainHead"];
  readonly superseded: TrustProjection["chainHead"];
  readonly projection: TrustProjection;
} | undefined> {
  const branch = await view.get(branchHeadKey(adoptionId)) as unknown as BranchHead | undefined;
  if (branch === undefined) return undefined;
  if (!object(branch) || !object(branch.projection)) throw invalid();
  return { ancestor: branch.ancestor, superseded: branch.superseded, projection: branch.projection };
}

/** 分支接续的进度：已发布、已暂存到哪一条，或尚未开始；同时给出本机当前链头。 */
export async function readTrustBranchProgress(view: DurableProjectionReadContext, adoptionId?: string): Promise<{
  readonly head?: TrustProjection["chainHead"];
  readonly adopted: boolean;
  readonly stagedThrough?: number;
}> {
  const head = readHead(await view.get(HEAD));
  if (adoptionId === undefined) return { ...(head ? { head: head.projection.chainHead } : {}), adopted: false };
  const adopted = await view.get(`trust/adopted/${adoptionId}`) !== undefined;
  const branch = await view.get(branchHeadKey(adoptionId)) as unknown as BranchHead | undefined;
  return {
    ...(head ? { head: head.projection.chainHead } : {}),
    adopted,
    ...(branch ? { stagedThrough: branch.last } : {}),
  };
}

/** 带签名信任快照的 trust 流记录：普通记录，或分支发布记录。 */
function isRecordCarrier(type: unknown): boolean {
  return type === "home-trust-record" || type === "home-trust-branch-adopted";
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
    // 记录定位可能指向分支发布那条记录（它带着新链头的签名快照）
    if (entry?.stream !== 'trust' || !object(entry.body) || !isRecordCarrier(entry.body.t) || !object(entry.body.record) ||
        entry.body.record.v !== locator.v ||
        homeTrustRecordDigest(entry.body.record as unknown as HomeTrustRecord | HistoricalHomeTrustRecord) !== locator.digest) throw invalid();
    record = entry.body.record as unknown as HomeTrustRecord | HistoricalHomeTrustRecord;
  }
  return { target, latest, events, done, ...(record ? { record } : {}) };
}

/**
 * 已验信任链链头的 issuer 与任期。事件在归约时逐条验签，这里不要求签名记录已闭合：迁居源端提交后、
 * 收到目标签出的记录之前，链头已推进而记录未跟上，启动恢复仍要据此判断本机是否已交出值班。
 */
export async function readVerifiedTrustIssuer(view: DurableProjectionReadContext): Promise<{
  readonly issuer: TrustProjection["issuer"];
  readonly anchorEpoch: number;
} | undefined> {
  const head = readHead(await view.get(HEAD));
  return head ? { issuer: { ...head.projection.issuer }, anchorEpoch: head.projection.anchorEpoch } : undefined;
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
  if (entry?.stream !== "trust" || !object(body) || !isRecordCarrier(body.t) || !object(body.record) ||
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
