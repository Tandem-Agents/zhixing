import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { Socket } from "node:net";
import type {
  DeviceIdentity,
  HomeTrustEvent,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  Signature,
} from "@zhixing/core/contracts";
import { validateMeshEndpointDescriptor } from "./bootstrap.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import { validateDeviceTrustRoot, verifyDeviceSignature } from "./device-identity.js";
import type { TrustedMeshPeer } from "./handshake.js";
import { assertRecoveryCommit, type DisasterRecoveryCommitProof } from "./recovery-commit.js";
import { encodeX25519PublicKey, importEncodedPublicKey } from "./recovery-root.js";
import {
  applyTrustEventWithHistory,
  homeTrustEventDigest,
  replayTrustChain,
  type HistoricalHomeTrustRecord,
  type TrustProjection,
} from "./trust-chain.js";

/**
 * 家级发现交换：已撤销的移除 target、离线后回来的成员，只凭耐久的家级秘密在中继上找到现任值班设备。
 * 会话钥由双方临时 X25519 与家级秘密共同派生，中继既看不到内容也无法居中；服务端先出示从客户端
 * 基点起的信任后缀与现任 issuer key 对本次会话的签名，客户端验过之后才发后续内容，最后在同一条连接上
 * 进入 mesh TLS。只开放这一条窄交换，不承载任何授权：成员资格与移除授权仍由 TLS 之后的入口裁决。
 * 后缀没有总量上限：每次会话按预算发送，超出时在签名记录边界截断并告知未完；客户端把逐条验过原签名的前缀
 * 作为进度保存，下次以进度点为第一候选、从该点的投影接着验，直到拿到完整后缀与证明。
 */
export type HomeDiscoveryPurpose = "member" | "terminal";

export { assertRecoveryCommit, type DisasterRecoveryCommitProof } from "./recovery-commit.js";

export interface HomeTrustChainPoint {
  readonly seq: number;
  readonly eventDigest: string;
}

export interface HomeDiscoveryPage {
  readonly events: readonly HomeTrustEvent[];
  readonly record?: HomeTrustRecord | HistoricalHomeTrustRecord;
  /** 这一页里每条灾备转移的根签 commit（自证，随页下发）。 */
  readonly recoveryCommits?: readonly DisasterRecoveryCommitProof[];
}

/** 服务端每次会话的发送预算；超出后在下一个签名记录边界截断。 */
export interface HomeDiscoveryBudget {
  readonly events: number;
  readonly commits: number;
}

/**
 * 发现客户端读本机信任链的端口：只按键读所需的点——链头、候选点、起点投影、与后缀重叠的序号、
 * 分叉之后的本机旧分支段——不整读本机链。
 */
export interface HomeDiscoveryLocalChain {
  readonly head: HomeTrustChainPoint;
  eventAt(seq: number): Promise<HomeTrustEvent | undefined>;
  eventByDigest(digest: string): Promise<HomeTrustEvent | undefined>;
  /** 本机链上某点的投影（存储侧有界：最近快照加少量重放；可以不含已撤销的历史设备）。 */
  projectionAt(point: HomeTrustChainPoint): Promise<TrustProjection>;
  /** seq 之时已撤销的设备（按键读）；验证时事件引用到、投影里没有的历史设备由它补齐。 */
  revokedMemberAt(deviceId: string, seq: number): Promise<TrustProjection["members"][number] | undefined>;
}

/** 内存里的本机链：测试与本就持有完整事件数组的调用方用。 */
export function localChainOfEvents(events: readonly HomeTrustEvent[]): HomeDiscoveryLocalChain {
  const last = events.at(-1);
  if (!last) throw new TypeError("Home discovery requires a local trust chain");
  return {
    head: { seq: last.seq, eventDigest: homeTrustEventDigest(last) },
    eventAt: async (seq) => events[seq],
    eventByDigest: async (digest) => events.find((event) => homeTrustEventDigest(event) === digest),
    projectionAt: async (point) => {
      const at = events[point.seq];
      if (!at || homeTrustEventDigest(at) !== point.eventDigest) throw new TypeError("Trust point is not on the local chain");
      return replayTrustChain(events.slice(0, point.seq + 1));
    },
    revokedMemberAt: async (deviceId, seq) => replayTrustChain(events.slice(0, seq + 1)).members
      .find((member) => member.device.deviceId === deviceId && member.state === "revoked"),
  };
}

/** 续做点：上次未完会话已验到的点与该点投影（本机耐久的已验证进度）；分叉时带公共祖先。 */
export interface HomeDiscoveryResumePoint {
  readonly point: HomeTrustChainPoint;
  readonly projection: TrustProjection;
  readonly ancestor?: HomeTrustChainPoint;
}

export interface HomeDiscoveryProof {
  readonly v: 1;
  readonly purpose: HomeDiscoveryPurpose;
  readonly homeId: string;
  readonly transcript: string;
  readonly from: HomeTrustChainPoint;
  readonly head: HomeTrustChainPoint;
  readonly anchorEpoch: number;
  readonly issuer: TrustedMeshPeer;
  readonly endpoint?: MeshEndpointDescriptor;
  readonly signature: Signature;
}

/** 本次会话逐条验过原签名的后缀：分页原样保留，供成员按组导入、按页暂存或记为进度。 */
export interface VerifiedHomeDiscoverySuffix {
  readonly transcript: string;
  readonly from: HomeTrustChainPoint;
  readonly pages: readonly HomeDiscoveryPage[];
  /** 本次会话末尾的投影（完整时即服务端链头的投影）。 */
  readonly projection: TrustProjection;
  /** 服务端链在本机链之外另起一支：ancestor 是最后一个公共点。 */
  readonly forked: boolean;
  readonly ancestor?: HomeTrustChainPoint;
  /** 本次会话各页的灾备 commit。 */
  readonly recoveryCommits: readonly DisasterRecoveryCommitProof[];
}

/** 未完会话：只有已验证进度，没有现任证明，不能进入 TLS。 */
export interface VerifiedHomeDiscoveryProgress extends VerifiedHomeDiscoverySuffix {
  readonly complete: false;
}

/** 完整会话：后缀到服务端链头，证明已按链头投影的现任 issuer key 验过。 */
export interface VerifiedHomeDiscovery extends VerifiedHomeDiscoverySuffix {
  readonly complete: true;
  readonly issuer: TrustedMeshPeer;
  readonly endpoint?: MeshEndpointDescriptor;
}

export interface HomeDiscoveryClientSession {
  readonly verified: VerifiedHomeDiscovery | VerifiedHomeDiscoveryProgress;
  /** terminal 用途：把恢复证据交给已验证的服务端；服务端拒绝时抛出它给出的原因。 */
  sendEvidence(evidence: unknown): Promise<void>;
  /** 结束发现交换，交回原始 socket，调用方随即在其上发起 mesh TLS。 */
  upgrade(): Promise<Socket>;
  close(): void;
}

/** 已验明的现任拒收了出示的证据：reason 是服务端给出的稳定类别（领域状态或通用拒绝）。 */
export class HomeDiscoveryRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`Home discovery evidence was refused: ${reason}`);
    this.name = "HomeDiscoveryRefusedError";
  }
}

export interface HomeDiscoverySigner {
  readonly deviceId: string;
  sign(schemaId: string, version: number, payload: unknown): Signature;
}

export interface HomeDiscoveryServerPorts {
  readonly homeId: string;
  /** 客户端候选点里第一个落在本机链上的点；都不在返回 undefined。 */
  findBase(points: readonly HomeTrustChainPoint[]): Promise<HomeTrustChainPoint | undefined>;
  /** 从 from 起的下一页；complete 表示这一页已到本机当前链头。 */
  page(from: HomeTrustChainPoint): Promise<HomeDiscoveryPage & { readonly complete: boolean }>;
  /** 本机作为现任 issuer 的证明材料；签名由这里给出的 signer（现任 issuer key）完成。 */
  issuer(): Promise<{
    readonly peer: TrustedMeshPeer;
    readonly endpoint?: MeshEndpointDescriptor;
    readonly anchorEpoch: number;
    readonly signer: HomeDiscoverySigner;
  }>;
  /** 本机链上某条灾备转移的根签 commit（来自本机或前任的安装记录）；没有返回 undefined。 */
  recoveryCommit(transition: HomeTrustEvent): Promise<DisasterRecoveryCommitProof | undefined>;
  /** terminal 用途的恢复证据：验证并耐久后返回；拒绝时抛出。 */
  acceptEvidence?(input: { readonly evidence: unknown; readonly transcript: string }): Promise<void>;
}

const PROTOCOL_DOMAIN = "zhixing:home-discovery:v1";
const NONCE_BYTES = 32;
const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_BUDGET: HomeDiscoveryBudget = { events: 4096, commits: 64 };
/** 客户端单次会话最多接收的帧字节：大于预算加一个签名记录组，只防对端无界下发，不是后缀总量上限。 */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_BASE_POINTS = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const GCM_TAG_BYTES = 16;

/** 客户端连上中继（或直连）后调用：完成握手、取回并验证继任证明，验过才返回会话。 */
export async function openHomeDiscovery(input: {
  readonly socket: Socket;
  readonly purpose: HomeDiscoveryPurpose;
  readonly secret: string;
  /** 本机信任链端口：给出候选点、取起点投影并判断分叉，只按键读所需的点。 */
  readonly local: HomeDiscoveryLocalChain;
  /** 上次未完会话的已验证进度：作为第一候选，服务端认出时从它的投影接着验。 */
  readonly resume?: HomeDiscoveryResumePoint;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<HomeDiscoveryClientSession> {
  const deadline = deadlineSignal(input.signal, input.timeoutMs);
  const frames = new DiscoveryFrames(input.socket, deadline.signal);
  try {
    const headEvent = await input.local.eventAt(input.local.head.seq);
    if (!headEvent || homeTrustEventDigest(headEvent) !== input.local.head.eventDigest) {
      throw new TypeError("Home discovery requires a local trust chain");
    }
    const homeId = headEvent.homeId;
    const ephemeral = generateKeyPairSync("x25519");
    const clientHello = {
      v: 1,
      t: "discovery-hello",
      purpose: input.purpose,
      publicKey: encodeX25519PublicKey(ephemeral.publicKey),
      nonce: randomBytes(NONCE_BYTES).toString("base64url"),
    } as const;
    await frames.sendPlain(clientHello);
    const serverHello = asServerHello(await frames.receivePlain());
    const keys = deriveSessionKeys({
      privateKey: ephemeral.privateKey,
      peerPublicKey: serverHello.publicKey,
      secret: input.secret,
      purpose: input.purpose,
      client: clientHello,
      server: serverHello,
    });
    frames.useKeys(keys.clientToServer, keys.serverToClient, "client");
    const transcript = transcriptDigest(input.purpose, clientHello, serverHello);
    const local = await localChainPoints(input.local);
    const points = input.resume ? [input.resume.point, ...local.slice(0, MAX_BASE_POINTS - 1)] : local;
    await frames.send({ t: "base", homeId, points });

    const pages: HomeDiscoveryPage[] = [];
    let from: HomeTrustChainPoint | undefined;
    for (;;) {
      const message = await frames.receive();
      if (message.t === "error") throw new Error(`Home discovery was refused: ${String(message.message)}`);
      if (frames.receivedBytes > MAX_SESSION_BYTES) throw new TypeError("Home discovery session exceeds its receive bound");
      if (message.t === "proof" || message.t === "more") {
        if (!from) throw new TypeError("Home discovery result arrived before its base");
        const resume = input.resume && canonicalize(input.resume.point) === canonicalize(from) ? input.resume : undefined;
        const suffix = await verifyHomeDiscoverySuffix({ transcript, local: input.local, from, pages, ...(resume ? { resume } : {}) });
        if (message.t === "more") {
          // 未完会话：截断点必须正是验到的位置；只交出已验证进度，不进入 TLS
          if (pages.length === 0 || canonicalize(chainPoint(message.head)) !== canonicalize(suffix.projection.chainHead)) {
            throw new TypeError("Home discovery stopped without progress");
          }
          deadline.dispose();
          input.socket.destroy();
          return progressSession(Object.freeze({ ...suffix, complete: false as const }));
        }
        const verified = verifyHomeDiscoveryProof({
          purpose: input.purpose,
          localHead: input.local.head,
          suffix,
          proof: validateProof(message.proof),
        });
        return session(frames, deadline, verified, input.purpose);
      }
      if (message.t !== "page") throw new TypeError("Home discovery message is unexpected");
      if (!from) from = chainPoint(message.from);
      const events = Array.isArray(message.events) ? message.events as HomeTrustEvent[] : undefined;
      const commits = message.recoveryCommits === undefined
        ? []
        : Array.isArray(message.recoveryCommits) ? message.recoveryCommits as unknown as DisasterRecoveryCommitProof[] : undefined;
      if (!events || !commits) throw new TypeError("Home discovery page is invalid");
      pages.push(Object.freeze({
        events: Object.freeze([...events]),
        ...(message.record !== undefined
          ? { record: message.record as HomeTrustRecord | HistoricalHomeTrustRecord }
          : {}),
        ...(commits.length > 0 ? { recoveryCommits: Object.freeze([...commits]) } : {}),
      }));
    }
  } catch (error) {
    deadline.dispose();
    input.socket.destroy();
    throw error;
  }
}

/** 当前 issuer 在发现入口上的服务端：交换结束后交回 socket，由调用方按用途进入对应的 TLS 入口。 */
export async function serveHomeDiscovery(input: {
  readonly socket: Socket;
  readonly purpose: HomeDiscoveryPurpose;
  readonly secret: string;
  readonly ports: HomeDiscoveryServerPorts;
  /** 每次会话的发送预算；缺省按协议默认值。 */
  readonly budget?: HomeDiscoveryBudget;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<Socket | undefined> {
  // 中继上的入口可能长时间等不到客户端：时限从收到客户端首帧起算，空闲等待只受调用方 signal 约束
  const idle = new AbortController();
  const onParent = () => idle.abort(input.signal!.reason);
  if (input.signal?.aborted) idle.abort(input.signal.reason);
  else input.signal?.addEventListener("abort", onParent, { once: true });
  const frames = new DiscoveryFrames(input.socket, idle.signal);
  let deadline: ReturnType<typeof deadlineSignal> | undefined;
  try {
    const first = await frames.receivePlain();
    input.signal?.removeEventListener("abort", onParent);
    deadline = deadlineSignal(input.signal, input.timeoutMs);
    frames.useSignal(deadline.signal);
    const clientHello = asClientHello(first);
    if (clientHello.purpose !== input.purpose) throw new TypeError("Home discovery purpose does not match this entry");
    const ephemeral = generateKeyPairSync("x25519");
    const serverHello = {
      v: 1,
      t: "discovery-hello",
      publicKey: encodeX25519PublicKey(ephemeral.publicKey),
      nonce: randomBytes(NONCE_BYTES).toString("base64url"),
    } as const;
    await frames.sendPlain(serverHello);
    const keys = deriveSessionKeys({
      privateKey: ephemeral.privateKey,
      peerPublicKey: clientHello.publicKey,
      secret: input.secret,
      purpose: input.purpose,
      client: clientHello,
      server: serverHello,
    });
    frames.useKeys(keys.serverToClient, keys.clientToServer, "server");
    const transcript = transcriptDigest(input.purpose, clientHello, serverHello);
    const base = await frames.receive();
    if (base.t !== "base" || base.homeId !== input.ports.homeId || !Array.isArray(base.points) ||
        base.points.length === 0 || base.points.length > MAX_BASE_POINTS) {
      await frames.send({ t: "error", message: "unknown-home" });
      throw new TypeError("Home discovery base is invalid");
    }
    const from = await input.ports.findBase(base.points.map(chainPoint));
    if (!from) {
      await frames.send({ t: "error", message: "unrelated-chain" });
      throw new Error("Home discovery base is not on this trust chain");
    }
    const budget = input.budget ?? DEFAULT_BUDGET;
    let cursor = from;
    let sentEvents = 0;
    let sentCommits = 0;
    for (;;) {
      const page = await input.ports.page(cursor);
      const recoveryCommits: DisasterRecoveryCommitProof[] = [];
      for (const event of page.events) {
        if (event.body.t !== "issuer-transition" || event.body.reason !== "disaster-recovery") continue;
        const commit = await input.ports.recoveryCommit(event);
        if (!commit) throw new Error("Home discovery chain has a disaster transition without its committed proof");
        recoveryCommits.push(commit);
      }
      await frames.send({
        t: "page",
        from: cursor,
        events: page.events,
        ...(page.record !== undefined ? { record: page.record } : {}),
        ...(recoveryCommits.length > 0 ? { recoveryCommits } : {}),
      });
      sentEvents += page.events.length;
      sentCommits += recoveryCommits.length;
      const last = page.events.at(-1);
      if (last) cursor = { seq: last.seq, eventDigest: homeTrustEventDigest(last) };
      if (page.complete) break;
      if (!last) throw new Error("Home discovery page made no progress");
      // 超出本次会话预算：只在签名记录边界截断，客户端据此按组导入或按页暂存后再来
      if (page.record !== undefined && (sentEvents >= budget.events || sentCommits >= budget.commits)) {
        await frames.send({ t: "more", head: cursor });
        frames.release();
        deadline.dispose();
        input.socket.end();
        return undefined;
      }
    }
    const issuer = await input.ports.issuer();
    await frames.send({
      t: "proof",
      proof: createHomeDiscoveryProof({
        purpose: input.purpose,
        homeId: input.ports.homeId,
        transcript,
        from,
        head: cursor,
        anchorEpoch: issuer.anchorEpoch,
        issuer: issuer.peer,
        ...(issuer.endpoint ? { endpoint: issuer.endpoint } : {}),
        signer: issuer.signer,
      }),
    });
    for (;;) {
      const message = await frames.receive();
      if (message.t === "upgrade") {
        await frames.send({ t: "upgrade-ok" });
        frames.release();
        deadline.dispose();
        return input.socket;
      }
      if (message.t === "evidence" && input.purpose === "terminal" && input.ports.acceptEvidence) {
        try {
          await input.ports.acceptEvidence({ evidence: message.evidence, transcript });
        } catch (error) {
          await frames.send({ t: "error", message: publicReason(error) });
          throw error;
        }
        await frames.send({ t: "evidence-accepted" });
        continue;
      }
      throw new TypeError("Home discovery message is not served on this entry");
    }
  } catch (error) {
    input.signal?.removeEventListener("abort", onParent);
    deadline?.dispose();
    input.socket.destroy();
    throw error;
  }
}

export function createHomeDiscoveryProof(input: {
  readonly purpose: HomeDiscoveryPurpose;
  readonly homeId: string;
  readonly transcript: string;
  readonly from: HomeTrustChainPoint;
  readonly head: HomeTrustChainPoint;
  readonly anchorEpoch: number;
  readonly issuer: TrustedMeshPeer;
  readonly endpoint?: MeshEndpointDescriptor;
  readonly signer: HomeDiscoverySigner;
}): HomeDiscoveryProof {
  const unsigned = {
    v: 1 as const,
    purpose: input.purpose,
    homeId: input.homeId,
    transcript: input.transcript,
    from: { seq: input.from.seq, eventDigest: input.from.eventDigest },
    head: { seq: input.head.seq, eventDigest: input.head.eventDigest },
    anchorEpoch: input.anchorEpoch,
    issuer: { identity: input.issuer.identity, rootCertificatePem: input.issuer.rootCertificatePem },
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
  };
  return Object.freeze({ ...unsigned, signature: input.signer.sign("HomeDiscoveryProof", 1, proofPayload(unsigned)) });
}

/**
 * 后缀验证：从本机链在起点处的投影（或本机耐久的续做点投影）逐条应用服务端后缀，每条都验原签名。
 * 分叉后第一条必须是分叉点处恢复根签的灾备转移，本机链在分叉点之后不得出现恢复根变更或域重置
 * （旧根分叉一律拒绝）；每条灾备转移都要有同页下发、绑定它的根签 commit，只 prepared 的候选过不了。
 * 从续做点接着验时分叉已定：后续事件只接在续做投影之后，不再与本机旧分支逐条比较。
 */
export async function verifyHomeDiscoverySuffix(input: {
  readonly transcript: string;
  readonly local: HomeDiscoveryLocalChain;
  readonly from: HomeTrustChainPoint;
  readonly pages: readonly HomeDiscoveryPage[];
  readonly resume?: HomeDiscoveryResumePoint;
}): Promise<VerifiedHomeDiscoverySuffix> {
  const local = input.local;
  let projection: TrustProjection;
  let ancestor: HomeTrustChainPoint | undefined;
  if (input.resume) {
    if (canonicalize(input.resume.point) !== canonicalize(input.from) ||
        canonicalize(input.resume.projection.chainHead) !== canonicalize(input.from)) {
      throw new TypeError("Home discovery resume point does not match its projection");
    }
    projection = input.resume.projection;
    ancestor = input.resume.ancestor;
  } else {
    const start = input.from.seq <= local.head.seq ? await local.eventAt(input.from.seq) : undefined;
    if (!start || start.seq !== input.from.seq || homeTrustEventDigest(start) !== input.from.eventDigest) {
      throw new TypeError("Home discovery starts outside the local trust chain");
    }
    projection = await local.projectionAt(input.from);
  }
  // 投影可以不含已撤销的历史设备：事件引用到它们时按键补入（基点：起点、或续做的分叉祖先 / 本机链头）
  const lookupSeq = input.resume
    ? input.resume.ancestor?.seq ?? Math.min(input.resume.point.seq, local.head.seq)
    : input.from.seq;
  const historical = (id: string) => local.revokedMemberAt(id, lookupSeq);
  const commits: DisasterRecoveryCommitProof[] = [];
  for (const page of input.pages) {
    const pageCommits = [...(page.recoveryCommits ?? [])];
    const used = new Set<number>();
    for (const event of page.events) {
      // 只读与后缀重叠的序号；分叉一旦确定就不再与本机旧分支比较
      const localEvent = ancestor || event.seq > local.head.seq ? undefined : await local.eventAt(event.seq);
      const digest = homeTrustEventDigest(event);
      if (localEvent && homeTrustEventDigest(localEvent) === digest) {
        projection = await applyTrustEventWithHistory(projection, event, historical);
        continue;
      }
      if (localEvent) {
        if (event.body.t !== "issuer-transition" || event.body.reason !== "disaster-recovery") {
          throw new TypeError("A forked trust chain must begin with a recovery-root disaster transition");
        }
        // 只读分叉之后的本机旧分支段
        for (let seq = event.seq; seq <= local.head.seq; seq++) {
          const item = await local.eventAt(seq);
          if (item?.body.t === "recovery-root" || item?.body.t === "domain-reset") {
            throw new TypeError("A forked trust chain under a superseded recovery root is rejected");
          }
        }
        ancestor = { seq: projection.chainHead.seq, eventDigest: projection.chainHead.eventDigest };
      }
      const before = projection;
      projection = await applyTrustEventWithHistory(projection, event, historical);
      if (event.body.t === "issuer-transition" && event.body.reason === "disaster-recovery") {
        const index = pageCommits.findIndex((commit) => commit.trustTransitionDigest === digest);
        if (index < 0 || used.has(index)) throw new TypeError("A disaster transition has no committed recovery proof");
        used.add(index);
        assertRecoveryCommit(pageCommits[index]!, event, before, projection);
      }
    }
    if (used.size !== pageCommits.length) throw new TypeError("Home discovery carries an unrelated recovery commit");
    commits.push(...pageCommits);
  }
  return Object.freeze({
    transcript: input.transcript,
    from: input.from,
    pages: input.pages,
    projection,
    forked: ancestor !== undefined,
    ...(ancestor ? { ancestor } : {}),
    recoveryCommits: Object.freeze(commits),
  });
}

/**
 * 证明验证：后缀须到服务端链头（非分叉时不得落后于本机链）；证明里的 issuer 必须是链头投影的现任 issuer
 * 设备，根证书绑定链上的设备公钥，签名按链头投影的 issuer key 验，并绑定本次会话与起止点。
 */
export function verifyHomeDiscoveryProof(input: {
  readonly purpose: HomeDiscoveryPurpose;
  readonly localHead: HomeTrustChainPoint;
  readonly suffix: VerifiedHomeDiscoverySuffix;
  readonly proof: HomeDiscoveryProof;
}): VerifiedHomeDiscovery {
  const { suffix, proof } = input;
  const projection = suffix.projection;
  if (!suffix.ancestor && projection.chainHead.seq < input.localHead.seq) {
    throw new TypeError("Home discovery server is behind this device's trust chain");
  }
  const { signature, ...unsigned } = proof;
  if (
    proof.purpose !== input.purpose ||
    proof.transcript !== suffix.transcript ||
    proof.homeId !== projection.homeId ||
    canonicalize(proof.from) !== canonicalize(suffix.from) ||
    canonicalize(proof.head) !== canonicalize(projection.chainHead) ||
    proof.anchorEpoch !== projection.anchorEpoch
  ) {
    throw new TypeError("Home discovery proof does not bind this session and chain");
  }
  const issuerMember = projection.members.find((member) =>
    member.device.deviceId === projection.issuer.deviceId && member.state === "active");
  if (!issuerMember || canonicalize(issuerMember.device) !== canonicalize(proof.issuer.identity)) {
    throw new TypeError("Home discovery proof does not name the chain's current issuer device");
  }
  validateDeviceTrustRoot(proof.issuer.identity, proof.issuer.rootCertificatePem);
  if (proof.endpoint && proof.endpoint.deviceId !== projection.issuer.deviceId) {
    throw new TypeError("Home discovery endpoint does not belong to the current issuer");
  }
  const issuerPublicKey = projection.issuer.issuerPublicKey ??
    (projection.issuer.issuerKeyId === issuerMember.device.deviceId ? issuerMember.device.publicKey : undefined);
  if (!issuerPublicKey) throw new TypeError("Home discovery chain has no current issuer public key");
  verifyDeviceSignature(
    { ...issuerMember.device, deviceId: projection.issuer.issuerKeyId, publicKey: issuerPublicKey } as DeviceIdentity,
    "HomeDiscoveryProof",
    1,
    proofPayload(unsigned),
    signature,
  );
  return Object.freeze({
    ...suffix,
    complete: true as const,
    issuer: proof.issuer,
    ...(proof.endpoint ? { endpoint: proof.endpoint } : {}),
  });
}

/** 基点候选（经本机链端口按键读至多 64 个点）：本机链头，再按 1、2、4…向前，最后是创世。 */
export async function localChainPoints(local: HomeDiscoveryLocalChain): Promise<readonly HomeTrustChainPoint[]> {
  const points: HomeTrustChainPoint[] = [local.head];
  for (const seq of candidateSeqs(local.head.seq).slice(1)) {
    const event = await local.eventAt(seq);
    if (!event || event.seq !== seq) throw new TypeError("Home discovery local chain is missing a candidate point");
    points.push({ seq, eventDigest: homeTrustEventDigest(event) });
  }
  return points;
}

function candidateSeqs(head: number): number[] {
  const seqs: number[] = [];
  for (let step = 0, seq = head; seq > 0 && seqs.length < MAX_BASE_POINTS - 1; step = step === 0 ? 1 : step * 2) {
    seq = head - step;
    if (seq <= 0) break;
    seqs.push(seq);
  }
  seqs.push(0);
  return seqs;
}

/** 未完会话：连接已关闭，只交出已验证进度。 */
function progressSession(verified: VerifiedHomeDiscoveryProgress): HomeDiscoveryClientSession {
  const incomplete = () => Promise.reject(new TypeError("Home discovery session is incomplete; continue from its progress"));
  return Object.freeze({
    verified,
    sendEvidence: incomplete,
    upgrade: incomplete,
    close() {},
  });
}

function session(
  frames: DiscoveryFrames,
  deadline: ReturnType<typeof deadlineSignal>,
  verified: VerifiedHomeDiscovery,
  purpose: HomeDiscoveryPurpose,
): HomeDiscoveryClientSession {
  return Object.freeze({
    verified,
    async sendEvidence(evidence: unknown) {
      if (purpose !== "terminal") throw new TypeError("Only terminal discovery carries recovery evidence");
      await frames.send({ t: "evidence", evidence });
      const reply = await frames.receive();
      if (reply.t === "error") throw new HomeDiscoveryRefusedError(String(reply.message));
      if (reply.t !== "evidence-accepted") throw new TypeError("Home discovery evidence reply is invalid");
    },
    async upgrade() {
      await frames.send({ t: "upgrade" });
      const reply = await frames.receive();
      if (reply.t !== "upgrade-ok") throw new TypeError("Home discovery upgrade was not acknowledged");
      frames.release();
      deadline.dispose();
      return frames.socket;
    },
    close() {
      deadline.dispose();
      frames.socket.destroy();
    },
  });
}

function proofPayload(unsigned: Omit<HomeDiscoveryProof, "signature">): unknown {
  return {
    v: unsigned.v,
    purpose: unsigned.purpose,
    homeId: unsigned.homeId,
    transcript: unsigned.transcript,
    from: unsigned.from,
    head: unsigned.head,
    anchorEpoch: unsigned.anchorEpoch,
    issuerDigest: protocolDigest("TrustedMeshPeer", 1, unsigned.issuer),
    ...(unsigned.endpoint ? { endpointDigest: protocolDigest("MeshEndpointDescriptor", 1, unsigned.endpoint) } : {}),
  };
}

function validateProof(value: unknown): HomeDiscoveryProof {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.issuer) || !isRecord(value.issuer.identity) ||
      typeof value.issuer.rootCertificatePem !== "string" || !isRecord(value.signature)) {
    throw new TypeError("Home discovery proof is invalid");
  }
  const allowed = new Set(["v", "purpose", "homeId", "transcript", "from", "head", "anchorEpoch", "issuer", "endpoint", "signature"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TypeError("Home discovery proof has unknown fields");
  if ((value.purpose !== "member" && value.purpose !== "terminal") || typeof value.homeId !== "string" ||
      typeof value.transcript !== "string" || typeof value.anchorEpoch !== "number") {
    throw new TypeError("Home discovery proof fields are invalid");
  }
  return Object.freeze({
    v: 1,
    purpose: value.purpose,
    homeId: value.homeId,
    transcript: value.transcript,
    from: chainPoint(value.from),
    head: chainPoint(value.head),
    anchorEpoch: value.anchorEpoch,
    issuer: { identity: value.issuer.identity as unknown as DeviceIdentity, rootCertificatePem: value.issuer.rootCertificatePem },
    ...(value.endpoint !== undefined ? { endpoint: validateMeshEndpointDescriptor(value.endpoint) } : {}),
    signature: value.signature as unknown as Signature,
  });
}

function chainPoint(value: unknown): HomeTrustChainPoint {
  if (!isRecord(value) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0 ||
      typeof value.eventDigest !== "string" || Object.keys(value).length !== 2) {
    throw new TypeError("Home discovery chain point is invalid");
  }
  return { seq: value.seq as number, eventDigest: value.eventDigest };
}

interface Hello {
  readonly v: 1;
  readonly t: "discovery-hello";
  readonly publicKey: string;
  readonly nonce: string;
}

function asClientHello(value: Record<string, unknown>): Hello & { readonly purpose: HomeDiscoveryPurpose } {
  const hello = asHello(value, ["nonce", "publicKey", "purpose", "t", "v"]);
  if (value.purpose !== "member" && value.purpose !== "terminal") throw new TypeError("Home discovery purpose is invalid");
  return { ...hello, purpose: value.purpose };
}

function asServerHello(value: Record<string, unknown>): Hello {
  return asHello(value, ["nonce", "publicKey", "t", "v"]);
}

function asHello(value: Record<string, unknown>, keys: readonly string[]): Hello {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize(keys) || value.v !== 1 || value.t !== "discovery-hello" ||
      typeof value.publicKey !== "string" || typeof value.nonce !== "string" ||
      Buffer.from(value.nonce, "base64url").byteLength !== NONCE_BYTES) {
    throw new TypeError("Home discovery hello is invalid");
  }
  return { v: 1, t: "discovery-hello", publicKey: value.publicKey, nonce: value.nonce };
}

function transcriptDigest(purpose: HomeDiscoveryPurpose, client: Hello, server: Hello): string {
  return protocolDigest("HomeDiscoveryTranscript", 1, {
    purpose,
    client: { publicKey: client.publicKey, nonce: client.nonce },
    server: { publicKey: server.publicKey, nonce: server.nonce },
  });
}

function deriveSessionKeys(input: {
  readonly privateKey: import("node:crypto").KeyObject;
  readonly peerPublicKey: string;
  readonly secret: string;
  readonly purpose: HomeDiscoveryPurpose;
  readonly client: Hello;
  readonly server: Hello;
}): { readonly clientToServer: Buffer; readonly serverToClient: Buffer } {
  const shared = diffieHellman({
    privateKey: input.privateKey,
    publicKey: importEncodedPublicKey(input.peerPublicKey, "x25519"),
  });
  const salt = Buffer.from(input.secret, "base64url");
  if (salt.byteLength !== 32) throw new TypeError("Home discovery secret is invalid");
  const info = Buffer.from(canonicalize({
    domain: PROTOCOL_DOMAIN,
    purpose: input.purpose,
    client: { publicKey: input.client.publicKey, nonce: input.client.nonce },
    server: { publicKey: input.server.publicKey, nonce: input.server.nonce },
  }), "utf8");
  const okm = Buffer.from(hkdfSync("sha256", shared, salt, info, 64));
  shared.fill(0);
  return { clientToServer: okm.subarray(0, 32), serverToClient: okm.subarray(32, 64) };
}

/** 长度前缀帧：握手两帧明文，其后每帧 AES-256-GCM，各方向独立计数作 nonce；只按精确长度读，交回 socket 时不残留字节。 */
class DiscoveryFrames {
  #sendKey: Buffer | undefined;
  #receiveKey: Buffer | undefined;
  #role: "client" | "server" | undefined;
  #sent = 0;
  #received = 0;
  /** 已收到的帧字节（含握手），供单会话接收上限判断。 */
  receivedBytes = 0;

  constructor(readonly socket: Socket, private signal: AbortSignal) {}

  useSignal(signal: AbortSignal): void {
    this.signal = signal;
  }

  useKeys(sendKey: Buffer, receiveKey: Buffer, role: "client" | "server"): void {
    this.#sendKey = sendKey;
    this.#receiveKey = receiveKey;
    this.#role = role;
  }

  release(): void {
    this.#sendKey?.fill(0);
    this.#receiveKey?.fill(0);
    this.#sendKey = undefined;
    this.#receiveKey = undefined;
  }

  async sendPlain(value: unknown): Promise<void> {
    await this.#write(Buffer.from(canonicalize(value), "utf8"));
  }

  async receivePlain(): Promise<Record<string, unknown>> {
    return parse(await this.#read());
  }

  async send(value: unknown): Promise<void> {
    if (!this.#sendKey || !this.#role) throw new TypeError("Home discovery session keys are not established");
    const direction = this.#role === "client" ? "c2s" : "s2c";
    const nonce = counterNonce(this.#sent++);
    const cipher = createCipheriv("aes-256-gcm", this.#sendKey, nonce);
    cipher.setAAD(Buffer.from(`${PROTOCOL_DOMAIN}:${direction}`, "utf8"));
    const sealed = Buffer.concat([
      cipher.update(Buffer.from(canonicalize(value), "utf8")),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    await this.#write(sealed);
  }

  async receive(): Promise<Record<string, unknown>> {
    if (!this.#receiveKey || !this.#role) throw new TypeError("Home discovery session keys are not established");
    const direction = this.#role === "client" ? "s2c" : "c2s";
    const sealed = await this.#read();
    if (sealed.byteLength < GCM_TAG_BYTES) throw new TypeError("Home discovery frame is truncated");
    const decipher = createDecipheriv("aes-256-gcm", this.#receiveKey, counterNonce(this.#received++));
    decipher.setAAD(Buffer.from(`${PROTOCOL_DOMAIN}:${direction}`, "utf8"));
    decipher.setAuthTag(sealed.subarray(sealed.byteLength - GCM_TAG_BYTES));
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.byteLength - GCM_TAG_BYTES)), decipher.final()]);
    } catch {
      throw new Error("Home discovery frame failed authentication");
    }
    return parse(plain);
  }

  async #write(payload: Buffer): Promise<void> {
    if (payload.byteLength > MAX_FRAME_BYTES) throw new TypeError("Home discovery frame exceeds its bound");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength);
    const signal = this.signal;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(asError(signal.reason));
        return;
      }
      // 对端不读时写回调可能一直不来：取消即拆掉连接并返回，不在写侧永久挂起
      const onAbort = () => {
        this.socket.destroy();
        reject(asError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.socket.write(Buffer.concat([header, payload]), (error) => {
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async #read(): Promise<Buffer> {
    const header = await readExactly(this.socket, 4, this.signal);
    const length = header.readUInt32BE(0);
    if (length === 0 || length > MAX_FRAME_BYTES) throw new TypeError("Home discovery frame length is invalid");
    this.receivedBytes += 4 + length;
    return readExactly(this.socket, length, this.signal);
  }
}

function counterNonce(counter: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(counter, 8);
  return nonce;
}

function parse(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Home discovery frame is not JSON");
  }
  if (!isRecord(value) || typeof value.t !== "string") throw new TypeError("Home discovery frame is invalid");
  return value;
}

async function readExactly(socket: Socket, length: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  while (received < length) {
    if (signal.aborted) throw asError(signal.reason);
    // 先取出缓冲里已有的全部字节：只到达一部分时也要消费掉，否则 readable 会立即再触发而空转占满事件循环
    const chunk = socket.read() as Buffer | null;
    if (chunk) {
      const need = length - received;
      if (chunk.byteLength > need) {
        chunks.push(chunk.subarray(0, need));
        // 多读的字节退回缓冲：交回 socket 进入 TLS 时边界精确
        socket.unshift(chunk.subarray(need));
        received = length;
        break;
      }
      chunks.push(chunk);
      received += chunk.byteLength;
      continue;
    }
    if (socket.readableEnded || socket.destroyed) throw new Error("Home discovery connection closed");
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(asError(signal.reason));
        return;
      }
      const cleanup = () => {
        socket.removeListener("readable", onReadable);
        socket.removeListener("end", onClose);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onReadable = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Home discovery connection closed")); };
      const onAbort = () => { cleanup(); reject(asError(signal.reason)); };
      socket.once("readable", onReadable);
      socket.once("end", onClose);
      socket.once("error", onError);
      socket.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  return Buffer.concat(chunks, length);
}

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Home discovery timed out")), timeoutMs);
  timer.unref?.();
  const onParent = () => controller.abort(parent!.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParent, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

function publicReason(error: unknown): string {
  // 领域声明的稳定类别（短小写标识）原样回给客户端；其余只回稳定类别，不把服务端内部细节带给对端
  const declared = (error as { readonly publicReason?: unknown } | null | undefined)?.publicReason;
  if (typeof declared === "string" && /^[a-z][a-z0-9-]{1,47}$/u.test(declared)) return declared;
  const message = error instanceof Error ? error.message : "";
  return /conflict|aborted|cancel/iu.test(message) ? "evidence-conflict" : "evidence-rejected";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
