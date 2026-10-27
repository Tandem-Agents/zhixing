import type { AuthorityCommitLog, DurableProjectionMutation, DurableProjectionReadContext } from "@zhixing/core/authority";
import type { DeviceRole, HomeTrustEvent, JsonValue } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import {
  applyTrustEventWithHistory,
  createSignedTrustEvent,
  homeTrustEventDigest,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import type { CurrentIssuerDeviceRemovalAuthority } from "./device-removal.js";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

/**
 * 旧分支独有事实的上报：成员在合法灾备后接续当前权威分支时，本机旧分支上可能有新链没有的撤销或降权
 * （旧值班设备在最后一份检查点之后做的）。它们不随换视图悄悄解除：成员把旧分支原签名事件按有界批次交给现任，
 * 现任从本机链的公共祖先投影逐条验原签名，按（上报者、祖先）记已处理进度，事实耐久后即生效为准入限制并按
 * 既有的移除与角色合同收束。成员按现任答复的进度推进本机确认水位，只重投未确认的批次。
 */
export const SUPERSEDED_TRUST_STREAM = "superseded-trust";
export const SUPERSEDED_TRUST_PROJECTION_ID = "superseded-trust-v1";
export const SUPERSEDED_TRUST_REPORT_SERVICE_ID = "trust.superseded-branch";
/** 单批上报的事件上限：成员按它分批，现任拒收更大的批。 */
export const SUPERSEDED_TRUST_REPORT_BATCH = 256;

type ChainPoint = { readonly seq: number; readonly eventDigest: string };

export interface SupersededTrustFact {
  readonly deviceId: string;
  readonly event: HomeTrustEvent;
  readonly reportedBy: string;
  readonly ancestor: ChainPoint;
  /** 降权事实：这次变更拿掉的、公共祖先上已有的角色（旧分支自己加上又拿掉的不算）。 */
  readonly removedRoles?: readonly DeviceRole[];
}

/** 现任对（上报者、祖先）已处理到的旧分支位置、该点的旧分支投影与祖先处各成员的角色。 */
interface ReportProgress {
  readonly through: ChainPoint;
  readonly projection: TrustProjection;
  readonly ancestorRoles: Readonly<Record<string, readonly DeviceRole[]>>;
}

interface ReportRecord extends ReportProgress {
  readonly v: 1;
  readonly t: "superseded-trust-report";
  readonly reportedBy: string;
  readonly ancestor: ChainPoint;
  /** 旧分支身份：首条旧事件的摘要。 */
  readonly branch: string;
  readonly facts: readonly SupersededTrustFact[];
}

/** 现任已按既有合同把这条事实体现在本机链上（撤销已提交、降权已提交或设备已不是 active）。 */
interface ResolvedRecord {
  readonly v: 1;
  readonly t: "superseded-trust-resolved";
  readonly eventDigest: string;
}

/**
 * 成员侧的一条待上报：分支发布之前写下（接续标识、祖先、被取代的旧分支链头、旧分支首条摘要作分支身份），
 * 连同本机在旧分支上被拿掉的祖先角色（自身降权）——它们在发布前就生效为本机准入限制，换视图到现任确认之间
 * 不恢复。确认水位随现任答复推进；覆盖到某条自身降权即解除它，到旧分支链头即移出待办。
 */
interface PendingRecord {
  readonly v: 1;
  readonly t: "superseded-trust-pending";
  readonly adoptionId: string;
  readonly ancestor: ChainPoint;
  readonly superseded: ChainPoint;
  readonly branch: string;
  readonly self: readonly SupersededTrustFact[];
}

/** 成员侧：现任确认已处理到的旧分支位置（本机确认水位）。 */
interface AckedRecord {
  readonly v: 1;
  readonly t: "superseded-trust-acked";
  readonly adoptionId: string;
  readonly through: ChainPoint;
}

export interface PendingSupersededReport {
  readonly adoptionId: string;
  readonly ancestor: ChainPoint;
  readonly superseded: ChainPoint;
  readonly branch: string;
  readonly self: readonly SupersededTrustFact[];
  readonly acked: ChainPoint;
}

type ReportLog = Pick<AuthorityCommitLog, "durableProjection" | "transactDurableProjection">;

const deviceDigest = (deviceId: string) => protocolDigest("SupersededTrustDevice", 1, { deviceId }).slice("sha256:".length);
const deviceScope = (deviceId: string) => `report/${deviceDigest(deviceId)}/`;
const factKey = (fact: Pick<SupersededTrustFact, "deviceId" | "event">) => deviceScope(fact.deviceId) + homeTrustEventDigest(fact.event);
/** 尚未收束的事实：在本机生效为准入限制，收束记录写入后删除。读取随未收束数。 */
const openKey = (eventDigest: string) => `open/${eventDigest}`;
/** 现任侧进度：按（上报者、祖先、旧分支身份）——同一成员从同一祖先先后被取代的不同旧分支各自续做。 */
const progressKey = (reportedBy: string, ancestorDigest: string, branch: string) =>
  `progress/${deviceDigest(reportedBy)}/${ancestorDigest}/${branch}`;
const pendingKey = (adoptionId: string) => `pending/${adoptionId}`;

export function registerSupersededTrustReportIndex(log: Pick<ReportLog, "durableProjection">): void {
  log.durableProjection({
    projectionId: SUPERSEDED_TRUST_PROJECTION_ID,
    reducerVersion: 4,
    authenticated: true,
    inputs: { streams: [SUPERSEDED_TRUST_STREAM] },
    reduce: async (envelope, current) => {
      const changes: DurableProjectionMutation[] = [];
      const overlay = new Map<string, JsonValue | undefined>();
      const read = async (key: string) => overlay.has(key) ? overlay.get(key) : current.get(key);
      const put = (key: string, value: JsonValue | undefined) => {
        overlay.set(key, value);
        changes.push(value === undefined ? { kind: "tombstone", key } : { kind: "put", key, value });
      };
      for (const entry of envelope.entries) {
        if (entry.stream !== SUPERSEDED_TRUST_STREAM) continue;
        const record = entry.body as unknown as ReportRecord | ResolvedRecord | AckedRecord | PendingRecord;
        if (record?.v === 1 && record.t === "superseded-trust-resolved" && typeof record.eventDigest === "string") {
          put(openKey(record.eventDigest), undefined);
          continue;
        }
        if (record?.v === 1 && record.t === "superseded-trust-pending" && typeof record.adoptionId === "string" &&
            record.ancestor && record.superseded && typeof record.branch === "string" && Array.isArray(record.self)) {
          const pending: PendingSupersededReport = {
            adoptionId: record.adoptionId, ancestor: record.ancestor, superseded: record.superseded,
            branch: record.branch, self: record.self, acked: record.ancestor,
          };
          // 同一接续重放写入时保留已推进的水位
          if (await read(pendingKey(record.adoptionId)) === undefined) put(pendingKey(record.adoptionId), pending as unknown as JsonValue);
          continue;
        }
        if (record?.v === 1 && record.t === "superseded-trust-acked" && typeof record.adoptionId === "string" && record.through) {
          const pending = await read(pendingKey(record.adoptionId)) as unknown as PendingSupersededReport | undefined;
          if (!pending) continue;
          // 确认到旧分支链头即移出待办；历史证据（旧分支事件）在信任索引里独立保留
          put(pendingKey(record.adoptionId), record.through.seq >= pending.superseded.seq
            ? undefined
            : { ...pending, acked: record.through } as unknown as JsonValue);
          continue;
        }
        if (!record || record.v !== 1 || record.t !== "superseded-trust-report" || !Array.isArray(record.facts) ||
            typeof record.reportedBy !== "string" || !record.ancestor || typeof record.branch !== "string" ||
            !record.through || !record.projection) {
          throw new TypeError("Superseded trust report record is invalid");
        }
        const progress: ReportProgress = { through: record.through, projection: record.projection, ancestorRoles: record.ancestorRoles };
        put(progressKey(record.reportedBy, record.ancestor.eventDigest, record.branch), progress as unknown as JsonValue);
        for (const fact of record.facts) {
          put(factKey(fact), fact as unknown as JsonValue);
          put(openKey(homeTrustEventDigest(fact.event)), fact as unknown as JsonValue);
        }
      }
      return changes;
    },
  });
}

/** 现任验上报所需的本机链读取：都按摘要精确定位、按键读，不整读信任流。 */
export interface SupersededTrustChainPort {
  /** 本机链上某点的投影；不在本机链上返回 undefined。 */
  projectionAt(point: ChainPoint): Promise<TrustProjection | undefined>;
  eventByDigest(digest: string): Promise<HomeTrustEvent | undefined>;
  /** seq 之时已撤销的设备：祖先投影不含已撤销的历史设备，旧分支事件引用到它们时按键补入。 */
  revokedMemberAt(deviceId: string, seq: number): Promise<TrustProjection["members"][number] | undefined>;
}

/**
 * 现任记录一批上报：批次须从现任对（上报者、祖先、旧分支）已处理到的位置接着（首批即祖先，须在本机链上，首条
 * 正是声明的旧分支首条、确与本机链分叉），逐条应用验过原签名；记录针对公共祖先上已有成员的撤销与拿掉祖先角色的
 * 降权（含上报者自身的降权）——旧分支独有的配对、提权及其后续变化不并入。进度与事实在同一次提交里写下；落后的
 * 重投与越过的批只答复现任进度，不重复记事实。返回本批新记的事实数与现任已处理到的位置。
 */
export async function recordSupersededTrustReport(
  log: ReportLog,
  input: {
    readonly reportedBy: string;
    readonly ancestor: ChainPoint;
    readonly branch: string;
    readonly from: ChainPoint;
    readonly events: readonly HomeTrustEvent[];
  },
  chain: SupersededTrustChainPort,
): Promise<{ readonly recorded: number; readonly through: ChainPoint }> {
  if (input.events.length === 0 || input.events.length > SUPERSEDED_TRUST_REPORT_BATCH) {
    throw new TypeError("Superseded trust report batch is out of bounds");
  }
  registerSupersededTrustReportIndex(log);
  const key = progressKey(input.reportedBy, input.ancestor.eventDigest, input.branch);
  const ancestor = { seq: input.ancestor.seq, eventDigest: input.ancestor.eventDigest };
  const stored = (await log.transactDurableProjection(SUPERSEDED_TRUST_PROJECTION_ID, async (view: DurableProjectionReadContext) => ({
    kind: "return" as const,
    value: await view.get(key),
  }))).value as unknown as ReportProgress | undefined;
  const start = stored?.through ?? ancestor;
  if (canonicalize(input.from) !== canonicalize(start)) return { recorded: 0, through: start };
  let projection: TrustProjection;
  let ancestorRoles: Readonly<Record<string, readonly DeviceRole[]>>;
  if (stored) {
    ({ projection, ancestorRoles } = stored);
  } else {
    const base = await chain.projectionAt(ancestor);
    if (!base) throw new Error("Superseded trust report does not start on this trust chain");
    const first = input.events[0]!;
    if (first.seq !== ancestor.seq + 1 || homeTrustEventDigest(first) !== input.branch) {
      throw new Error("Superseded trust report does not start its declared branch");
    }
    const onChain = await chain.eventByDigest(homeTrustEventDigest(first));
    if (onChain && onChain.seq === first.seq) throw new Error("Superseded trust report is not a fork of this trust chain");
    projection = base;
    ancestorRoles = Object.fromEntries(base.members.map((member) => [member.device.deviceId, member.roles]));
  }
  const facts: SupersededTrustFact[] = [];
  for (const event of input.events) {
    const before = projection;
    projection = await applyTrustEventWithHistory(projection, event, (id) => chain.revokedMemberAt(id, ancestor.seq));
    const body = event.body;
    if (body.t !== "revoke" && body.t !== "role-change") continue;
    const rolesAtAncestor = ancestorRoles[body.deviceId];
    // 上报者自身的降权同样记录（它在接续后不得恢复被拿掉的祖先角色）；旧分支上才配对的设备不并入
    if (!rolesAtAncestor) continue;
    if (body.t === "revoke") {
      facts.push(Object.freeze({ deviceId: body.deviceId, event, reportedBy: input.reportedBy, ancestor }));
      continue;
    }
    const previous = before.members.find((member) => member.device.deviceId === body.deviceId)?.roles ?? [];
    const removedRoles = previous.filter((role) => rolesAtAncestor.includes(role) && !body.roles.includes(role));
    if (removedRoles.length > 0) {
      facts.push(Object.freeze({ deviceId: body.deviceId, event, reportedBy: input.reportedBy, ancestor, removedRoles }));
    }
  }
  const through = { seq: projection.chainHead.seq, eventDigest: projection.chainHead.eventDigest };
  type Result = { readonly recorded: number; readonly through: ChainPoint };
  return (await log.transactDurableProjection<JsonValue, Result>(SUPERSEDED_TRUST_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    // 同一上报者并发的同一批：另一条已先提交时以它的进度答复
    const current = (await view.get(key) as unknown as ReportProgress | undefined)?.through ?? ancestor;
    if (canonicalize(current) !== canonicalize(start)) return { kind: "return", value: { recorded: 0, through: current } };
    const fresh: SupersededTrustFact[] = [];
    for (const fact of facts) if (await view.get(factKey(fact)) === undefined) fresh.push(fact);
    const record: ReportRecord = {
      v: 1, t: "superseded-trust-report", reportedBy: input.reportedBy, ancestor, branch: input.branch, through, projection, ancestorRoles, facts: fresh,
    };
    return {
      kind: "append",
      entries: [{ stream: SUPERSEDED_TRUST_STREAM, body: record as unknown as JsonValue }],
      value: { recorded: fresh.length, through },
    };
  })).value;
}
/** 某台设备在被取代的旧分支上的撤销与角色变更（按事件摘要排序），供现任呈现与按既有合同处置。 */
export async function readSupersededTrustFacts(log: ReportLog, deviceId: string): Promise<readonly SupersededTrustFact[]> {
  registerSupersededTrustReportIndex(log);
  return (await log.transactDurableProjection(SUPERSEDED_TRUST_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    const facts: SupersededTrustFact[] = [];
    let continuation: string | undefined;
    const scope = deviceScope(deviceId);
    do {
      const page = await view.scan({ gte: scope, lt: scope + "￿" }, 256, continuation);
      for (const { value } of page.entries) facts.push(value as unknown as SupersededTrustFact);
      continuation = page.continuation;
    } while (continuation);
    return { kind: "return" as const, value: facts };
  })).value;
}

/** 尚未收束的旧分支否定事实（全部设备）；读取随未收束数。 */
export async function readOpenSupersededTrustFacts(log: ReportLog): Promise<readonly SupersededTrustFact[]> {
  registerSupersededTrustReportIndex(log);
  return (await log.transactDurableProjection(SUPERSEDED_TRUST_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    const facts: SupersededTrustFact[] = [];
    let continuation: string | undefined;
    do {
      const page = await view.scan({ gte: "open/", lt: "open/\uffff" }, 256, continuation);
      for (const { value } of page.entries) facts.push(value as unknown as SupersededTrustFact);
      continuation = page.continuation;
    } while (continuation);
    return { kind: "return" as const, value: facts };
  })).value;
}

async function markSupersededTrustResolved(log: ReportLog, eventDigest: string): Promise<void> {
  registerSupersededTrustReportIndex(log);
  await log.transactDurableProjection<JsonValue, void>(SUPERSEDED_TRUST_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    if (await view.get(openKey(eventDigest)) === undefined) return { kind: "return", value: undefined };
    const record: ResolvedRecord = { v: 1, t: "superseded-trust-resolved", eventDigest };
    return { kind: "append", entries: [{ stream: SUPERSEDED_TRUST_STREAM, body: record as unknown as JsonValue }], value: undefined };
  });
}

interface RestrictableTrust {
  readonly issuer: { readonly deviceId: string };
  readonly members: readonly { readonly device: { readonly deviceId: string }; readonly roles: readonly DeviceRole[]; readonly state: string }[];
}

/**
 * 把未收束的否定事实叠加到 trust 上：旧分支撤销 → 该设备视为已撤销；旧分支降权 → 去掉被拿掉的祖先角色。
 * 只减不加：旧分支的配对与提权从不经由这里生效。现任自身不受约束：根签名的灾备提交已取代旧分支对它的处置。
 */
export function restrictTrustBySupersededFacts<T extends RestrictableTrust>(
  record: T,
  facts: readonly SupersededTrustFact[],
): T {
  if (facts.length === 0) return record;
  const byDevice = new Map<string, SupersededTrustFact[]>();
  for (const fact of facts) byDevice.set(fact.deviceId, [...(byDevice.get(fact.deviceId) ?? []), fact]);
  return {
    ...record,
    members: record.members.map((member) => {
      const own = byDevice.get(member.device.deviceId);
      if (!own || member.device.deviceId === record.issuer.deviceId || member.state === "revoked") return member;
      if (own.some((fact) => fact.event.body.t === "revoke")) return { ...member, state: "revoked" };
      const removed = new Set(own.flatMap((fact) => fact.removedRoles ?? []));
      const roles = member.roles.filter((role) => !removed.has(role));
      return roles.length === member.roles.length ? member : { ...member, roles };
    }),
  } as T;
}

type RemovalPort = Pick<
  CurrentIssuerDeviceRemovalAuthority,
  "acceptForDevice" | "commitLost" | "operationForTarget" | "publicStateForTarget"
>;

/**
 * 现任侧的旧分支否定事实治理：未收束事实先在 trust 进入控制面处生效为准入限制，再由现任按既有合同自动收束——
 * 撤销（或降到不剩角色）按失联移除合同接受并推进，本机链上提交撤销；降权由 issuer 追加只减不加的 role-change。
 * 本机链体现之后写收束记录，限制随之解除；之后同一设备若经既有合同重新入网，不再被这条旧事实挡住。
 */
export class SupersededTrustGovernance {
  /** 现任侧尚未收束的事实（本机是现任时由收束器处理）。 */
  #open: readonly SupersededTrustFact[] = [];
  /** 本机自身在旧分支上被降、现任尚未确认收到的角色（由上报确认解除）。 */
  #self: readonly SupersededTrustFact[] = [];
  #running: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(private readonly options: {
    readonly store: FileMeshBootstrapStore;
    /** 本机是现任时的移除权威与 issuer 密钥；不是现任时为空：不收束，限制照常生效。 */
    readonly removal: () => RemovalPort | undefined;
    readonly issuerKey: () => DeviceKey | undefined;
    /** 限制变化之后：让控制面按最新 trust 重算。 */
    readonly reconcile: () => Promise<void>;
    readonly now?: () => string;
    readonly onError?: (error: Error) => void;
  }) {}

  /** 控制面在 trust 进入处同步调用：叠加已载入的未收束事实。 */
  readonly apply = <T extends RestrictableTrust>(record: T): T =>
    restrictTrustBySupersededFacts(record, [...this.#open, ...this.#self]);

  /** 载入未收束事实；控制面启动前调用，使限制从第一份 trust 起生效。读取随未收束数。 */
  async load(): Promise<void> {
    const log = this.options.store.authorityLog();
    // 现任侧未收束的事实，加上本机在旧分支上被降、现任尚未确认收到的自身角色
    const self = (await readPendingSupersededReports(log))
      .flatMap((pending) => pending.self.filter((fact) => fact.event.seq > pending.acked.seq));
    this.#open = await readOpenSupersededTrustFacts(log);
    this.#self = self;
  }

  /** 本机状态变化之后（例如上报得到确认）：重载限制并让控制面按它重算。 */
  async refresh(): Promise<void> {
    await this.load();
    await this.options.reconcile();
  }

  /** 新事实记录之后：限制先生效（返回前控制面已按它重算），再排队收束。 */
  async onRecorded(): Promise<void> {
    await this.load();
    await this.options.reconcile();
    this.resume();
  }

  /** 启动后、新事实记录后、移除守卫解除后：排队收束全部未收束事实（串行、可重入）。 */
  resume(): void {
    if (this.#stopped || this.#open.length === 0) return;
    this.#running = this.#running.then(() => this.#resolve()).catch((error: unknown) => {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#running;
  }

  /** 等当前排队的收束结束。 */
  settled(): Promise<void> {
    return this.#running;
  }

  async #resolve(): Promise<void> {
    const removal = this.options.removal();
    const issuerKey = this.options.issuerKey();
    if (this.#stopped || !removal || !issuerKey) return;
    // 只收束现任侧记下的事实；本机自身降权的待上报项由上报确认解除
    const log = this.options.store.authorityLog();
    for (const fact of await readOpenSupersededTrustFacts(log)) {
      if (this.#stopped) return;
      const current = await this.options.store.loadCurrentTrust();
      if (!current || current.issuer.issuerKeyId !== issuerKey.deviceId) return;
      if (await this.#reflect(fact, current, removal, issuerKey)) {
        await markSupersededTrustResolved(log, homeTrustEventDigest(fact.event));
      }
    }
    await this.load();
    await this.options.reconcile();
  }

  /** 让一条事实体现在本机链上；返回 false 表示暂不能收束，限制继续生效。 */
  async #reflect(
    fact: SupersededTrustFact,
    current: NonNullable<Awaited<ReturnType<FileMeshBootstrapStore["loadCurrentTrust"]>>>,
    removal: RemovalPort,
    issuerKey: DeviceKey,
  ): Promise<boolean> {
    const member = current.members.find((candidate) =>
      candidate.device.deviceId === fact.deviceId && candidate.state === "active");
    // 已不是 active 成员（本机链已体现），或是现任自身：没有要提交的
    if (!member || member.device.deviceId === current.issuer.deviceId) return true;
    const keep = member.roles.filter((role) => !(fact.removedRoles ?? []).includes(role));
    if (fact.event.body.t === "revoke" || keep.length === 0) {
      const digest = homeTrustEventDigest(fact.event);
      const operationId = `superseded-${digest.slice("sha256:".length, "sha256:".length + 32)}`;
      const latest = await removal.operationForTarget(fact.deviceId);
      if (latest) {
        const phase = (await removal.publicStateForTarget(fact.deviceId))?.phase;
        const settled = phase === "removed" || phase === "cancelled";
        // 该设备另有进行中的移除：等它结束（守卫解除时重试）；本次收束被手动取消：限制保留，交现任处置
        if (latest.operationId !== operationId ? !settled : phase === "cancelled") return false;
      }
      if (latest?.operationId !== operationId) {
        await removal.acceptForDevice({ requestId: `superseded:${operationId}`, operationId, targetDeviceId: fact.deviceId });
      }
      await removal.commitLost(operationId);
      return true;
    }
    if (keep.length < member.roles.length) {
      await this.options.store.appendTrustEvent({
        event: createSignedTrustEvent({
          current,
          body: { t: "role-change", deviceId: fact.deviceId, roles: keep },
          at: this.options.now?.() ?? new Date().toISOString(),
          signer: issuerKey,
        }),
        issuerKey,
      });
    }
    return true;
  }
}

/** 现任侧服务：请求方取自已认证连接的对端；授权由调用方给出（本机是现任、对端是 active 成员）。 */
export function registerSupersededTrustReportService(
  services: MeshServiceRegistry,
  input: {
    readonly store: FileMeshBootstrapStore;
    readonly authorize: (deviceId: string) => boolean;
    /** 新事实记录之后：让限制生效并排队收束。 */
    readonly onRecorded?: () => Promise<void>;
  },
): () => void {
  const chain: SupersededTrustChainPort = {
    projectionAt: (point) => input.store.trustProjectionAt(point),
    eventByDigest: (digest) => input.store.trustEventByDigest(digest),
    revokedMemberAt: (deviceId, seq) => input.store.revokedTrustMemberAt(deviceId, seq),
  };
  return services.register(SUPERSEDED_TRUST_REPORT_SERVICE_ID, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => input.authorize(connection.peer.deviceId),
    handler: async (payload, connection) => {
      const request = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;
      if (!request || request.v !== 1 || !Array.isArray(request.events) || typeof request.branch !== "string" ||
          canonicalize(Object.keys(request).sort()) !== canonicalize(["ancestor", "branch", "events", "from", "v"])) {
        throw new TypeError("Superseded trust report request is invalid");
      }
      const result = await recordSupersededTrustReport(input.store.authorityLog(), {
        reportedBy: connection.peer.deviceId,
        ancestor: chainPoint(request.ancestor),
        branch: request.branch,
        from: chainPoint(request.from),
        events: request.events as HomeTrustEvent[],
      }, chain);
      if (result.recorded > 0) await input.onRecorded?.();
      return Buffer.from(canonicalize({ v: 1, recorded: result.recorded, through: result.through }), "utf8");
    },
  });
}

/** 成员侧：分支发布之前写下待上报项（含本机自身降权）；同一接续重放写入不重置水位。 */
export async function recordSupersededTrustPending(
  log: ReportLog,
  input: Omit<PendingRecord, "v" | "t">,
): Promise<void> {
  registerSupersededTrustReportIndex(log);
  const record: PendingRecord = { v: 1, t: "superseded-trust-pending", ...input };
  await log.transactDurableProjection<JsonValue, void>(SUPERSEDED_TRUST_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    if (await view.get(pendingKey(input.adoptionId)) !== undefined) return { kind: "return", value: undefined };
    return { kind: "append", entries: [{ stream: SUPERSEDED_TRUST_STREAM, body: record as unknown as JsonValue }], value: undefined };
  });
}

/** 成员侧：仍待上报的接续（只读待办目录，读取随待办数，与已结束的历史接续无关）。 */
export async function readPendingSupersededReports(log: ReportLog): Promise<readonly PendingSupersededReport[]> {
  registerSupersededTrustReportIndex(log);
  return (await log.transactDurableProjection(SUPERSEDED_TRUST_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    const pending: PendingSupersededReport[] = [];
    let continuation: string | undefined;
    do {
      const page = await view.scan({ gte: "pending/", lt: "pending/\uffff" }, 256, continuation);
      for (const { value } of page.entries) pending.push(value as unknown as PendingSupersededReport);
      continuation = page.continuation;
    } while (continuation);
    return { kind: "return" as const, value: pending };
  })).value;
}

async function recordSupersededTrustAck(log: ReportLog, adoptionId: string, through: ChainPoint): Promise<void> {
  registerSupersededTrustReportIndex(log);
  const record: AckedRecord = { v: 1, t: "superseded-trust-acked", adoptionId, through };
  await log.transactDurableProjection<JsonValue, void>(SUPERSEDED_TRUST_PROJECTION_ID, async () => ({
    kind: "append",
    entries: [{ stream: SUPERSEDED_TRUST_STREAM, body: record as unknown as JsonValue }],
    value: undefined,
  }));
}

/**
 * 成员侧：连上现任时上报待办目录里的接续。只访问待办项：按键核分支已发布（未发布的暂跳过），从确认水位之后
 * 按键范围读至多一批原签名事件交给现任，按现任答复的进度推进水位（现任进度为准：落后时据此回退重投），
 * 到旧分支链头即移出待办。只重投未确认的批次。
 */
export async function reportSupersededTrust(
  store: FileMeshBootstrapStore,
  client: MeshServiceClient,
  batch: number = SUPERSEDED_TRUST_REPORT_BATCH,
): Promise<void> {
  const log = store.authorityLog();
  for (const pending of await readPendingSupersededReports(log)) {
    if (!(await store.trustBranchAdopted(pending.adoptionId))) continue;
    let through = pending.acked;
    // 现任答复的位置必须是这条旧分支上的点（祖先或旧分支事件）
    const onBranch = async (point: ChainPoint) => {
      if (canonicalize(point) === canonicalize(pending.ancestor)) return true;
      if (point.seq <= pending.ancestor.seq || point.seq > pending.superseded.seq) return false;
      const [event] = await store.supersededTrustEvents(pending.adoptionId, point.seq - 1, 1);
      return event?.seq === point.seq && homeTrustEventDigest(event) === point.eventDigest;
    };
    while (through.seq < pending.superseded.seq) {
      const events = await store.supersededTrustEvents(pending.adoptionId, through.seq, batch);
      if (events[0]?.seq !== through.seq + 1) throw new Error("Superseded trust branch is missing events to report");
      const reply = JSON.parse(Buffer.from(await client.request(
        SUPERSEDED_TRUST_REPORT_SERVICE_ID,
        Buffer.from(canonicalize({ v: 1, ancestor: pending.ancestor, branch: pending.branch, from: through, events }), "utf8"),
      )).toString("utf8")) as Record<string, unknown>;
      const next = chainPoint(reply.through);
      if (canonicalize(next) === canonicalize(through) || !(await onBranch(next))) {
        throw new Error("Superseded trust report made no progress");
      }
      await recordSupersededTrustAck(log, pending.adoptionId, next);
      through = next;
    }
  }
}

function chainPoint(value: unknown): ChainPoint {
  const point = value as Partial<ChainPoint> | undefined;
  if (!point || typeof point !== "object" || !Number.isSafeInteger(point.seq) || (point.seq as number) < 0 ||
      typeof point.eventDigest !== "string" || Object.keys(point).length !== 2) {
    throw new TypeError("Superseded trust report chain point is invalid");
  }
  return { seq: point.seq as number, eventDigest: point.eventDigest };
}
