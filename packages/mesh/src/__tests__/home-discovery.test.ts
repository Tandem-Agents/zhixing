import { once } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { HomeTrustEvent } from "@zhixing/core/contracts";
import { createSignedDisasterRecoveryCommit } from "@zhixing/core/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalRouteSecret } from "../bootstrap.js";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import {
  localChainOfEvents,
  openHomeDiscovery,
  serveHomeDiscovery,
  type DisasterRecoveryCommitProof,
  type HomeDiscoveryBudget,
  type HomeDiscoveryClientSession,
  type HomeDiscoveryLocalChain,
  type HomeDiscoveryPurpose,
  type HomeDiscoveryResumePoint,
  type HomeDiscoveryServerPorts,
  type VerifiedHomeDiscovery,
} from "../home-discovery.js";
import { RecoveryRoot } from "../recovery-root.js";
import {
  applyTrustEvent,
  createRecoveryRootEvent,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  homeTrustEventDigest,
  initializeTrustChain,
  replayTrustChain,
  type TrustProjection,
} from "../trust-chain.js";

const NOW = Date.parse("2026-10-27T00:00:00.000Z");
const AT = new Date(NOW).toISOString();
const DIGEST = `sha256:${"7".repeat(64)}`;

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
});

describe("home discovery exchange", () => {
  it("proves the current issuer after a migration before the client sends anything else, then hands back an exact socket", async () => {
    const home = await createHome();
    const migrated = await migrateTo(home);
    const evidence: unknown[] = [];
    const { client, server } = await exchange({
      purpose: "terminal",
      secret: home.secret,
      localEvents: home.events,
      ports: ports(migrated.events, migrated.issuer, { evidence }),
    });
    const session = await client;
    expect(session.verified.projection.issuer.deviceId).toBe(home.b.key.deviceId);
    expect(complete(session).issuer.identity.deviceId).toBe(home.b.key.deviceId);
    expect(session.verified.forked).toBe(false);
    expect(session.verified.pages.flatMap((page) => page.events)).toHaveLength(1);
    await session.sendEvidence({ claim: "accepted-receipt" });
    expect(evidence).toEqual([{ claim: "accepted-receipt" }]);
    const clientSocket = await session.upgrade();
    const serverSocket = await server;
    // 交回的 socket 上不残留发现交换的字节：两端随后写入的第一个字节就是对方读到的第一个字节
    clientSocket.write("c");
    serverSocket.write("s");
    expect((await readOne(serverSocket)).toString()).toBe("c");
    expect((await readOne(clientSocket)).toString()).toBe("s");
    clientSocket.destroy();
    serverSocket.destroy();
  });

  it("fails both sides without a shared session key when the relay or the secret differs", async () => {
    const home = await createHome();
    const migrated = await migrateTo(home);
    const evidence: unknown[] = [];
    const wrongSecret = await exchange({
      purpose: "member",
      secret: home.secret,
      clientSecret: createTerminalRouteSecret(),
      localEvents: home.events,
      ports: ports(migrated.events, migrated.issuer, { evidence }),
    });
    await expect(wrongSecret.client).rejects.toThrow(/failed authentication|closed/);
    await expect(wrongSecret.server).rejects.toThrow();

    const tampered = await exchange({
      purpose: "member",
      secret: home.secret,
      localEvents: home.events,
      ports: ports(migrated.events, migrated.issuer, { evidence }),
      tamperServerToClient: true,
    });
    await expect(tampered.client).rejects.toThrow(/failed authentication|closed/);
    await expect(tampered.server).rejects.toThrow();
    expect(evidence).toEqual([]);
  });

  it("rejects a proof that is not signed by the chain's current issuer key and never sends evidence to it", async () => {
    const home = await createHome();
    const migrated = await migrateTo(home);
    const impostor = await DeviceKey.generate({ now: () => NOW });
    const evidence: unknown[] = [];
    const forged = await exchange({
      purpose: "terminal",
      secret: home.secret,
      localEvents: home.events,
      ports: ports(migrated.events, { ...migrated.issuer, signer: impostor }, { evidence }),
    });
    await expect(forged.client).rejects.toThrow();
    await expect(forged.server).rejects.toThrow();
    expect(evidence).toEqual([]);

    // 证明里换上别的设备身份（哪怕签名钥正确）也过不了：issuer 设备必须是链上现任
    const wrongDevice = await exchange({
      purpose: "terminal",
      secret: home.secret,
      localEvents: home.events,
      ports: ports(migrated.events, {
        ...migrated.issuer,
        peer: { identity: home.e.identity, rootCertificatePem: home.e.key.rootCertificatePem },
      }, { evidence }),
    });
    await expect(wrongDevice.client).rejects.toThrow(/current issuer device/);
    await expect(wrongDevice.server).rejects.toThrow();
  });

  it("times out a frame that never completes without starving the event loop", async () => {
    const home = await createHome();
    // 恶意服务端：声明 10000 字节的帧，只发 1 个字节
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(10_000);
      socket.write(Buffer.concat([header, Buffer.from([0x7b])]));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = connect({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
    await once(client, "connect");
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    const started = Date.now();
    await expect(openHomeDiscovery({
      socket: client,
      purpose: "member",
      secret: home.secret,
      local: localChainOfEvents(home.events),
      timeoutMs: 200,
    })).rejects.toThrow(/timed out/);
    clearInterval(ticker);
    expect(Date.now() - started).toBeLessThan(1_500);
    // 等待期间事件循环照常运转
    expect(ticks).toBeGreaterThan(3);
  });

  it("completes over a relay that splits every frame into single bytes", async () => {
    const home = await createHome();
    const migrated = await migrateTo(home);
    const { client } = await exchange({
      purpose: "terminal",
      secret: home.secret,
      localEvents: home.events,
      ports: ports(migrated.events, migrated.issuer, {}),
      fragment: true,
    });
    const session = await client;
    expect(session.verified.projection.issuer.deviceId).toBe(home.b.key.deviceId);
    session.close();
  });

  it("rejects a server whose chain is behind the client's", async () => {
    const home = await createHome();
    const behind = home.events.slice(0, -1);
    const projection = replayTrustChain(behind);
    const stale = await exchange({
      purpose: "member",
      secret: home.secret,
      localEvents: home.events,
      ports: ports(behind, issuerOf(home, projection, home.a.key), {}),
    });
    await expect(stale.client).rejects.toThrow(/behind/);
    await expect(stale.server).rejects.toThrow();
  });

  it("accepts a committed disaster fork under the confirmed root and returns the common ancestor", async () => {
    const home = await createHome();
    // 本机在祖先之后多收了一条旧 issuer 的 enroll；新分支在同一位置是恢复根签的灾备转移
    const x = await device("后配的设备-X");
    const ancestorProjection = replayTrustChain(home.events);
    const localExtra = createSignedTrustEvent({
      current: ancestorProjection,
      body: { t: "enroll", device: x.identity, roles: ["executor"], pairingTranscriptDigest: DIGEST },
      at: AT,
      signer: home.a.key,
    });
    const recovered = await recoverTo(home, home.events, home.root);
    for (const purpose of ["member", "terminal"] as const) {
      const { client } = await exchange({
        purpose,
        secret: home.secret,
        localEvents: [...home.events, localExtra],
        ports: ports(recovered.events, recovered.issuer, { commits: [recovered.commit] }),
      });
      const session = await client;
      expect(session.verified.forked).toBe(true);
      expect(session.verified.ancestor).toEqual(ancestorProjection.chainHead);
      expect(session.verified.projection.issuer.deviceId).toBe(home.b.key.deviceId);
      expect(session.verified.projection.members.some((member) => member.device.deviceId === x.key.deviceId)).toBe(false);
      session.close();
    }
  });

  it("rejects disaster transitions without a committed proof and forks under a superseded root", async () => {
    const home = await createHome();
    const recovered = await recoverTo(home, home.events, home.root);
    // 只 prepared 的候选：有签名转移、没有根签 commit
    const prepared = await exchange({
      purpose: "member",
      secret: home.secret,
      localEvents: home.events,
      ports: ports(recovered.events, recovered.issuer, { commits: [] }),
    });
    await expect(prepared.client).rejects.toThrow(/refused|closed/);
    await expect(prepared.server).rejects.toThrow(/committed proof/);
    // commit 绑定的不是这条转移
    const otherCommit = createSignedDisasterRecoveryCommit({
      ...unsignedCommit(recovered.commit),
      trustTransitionDigest: DIGEST,
    }, home.root);
    const mismatched = await exchange({
      purpose: "member",
      secret: home.secret,
      localEvents: home.events,
      ports: ports(recovered.events, recovered.issuer, { commits: [otherCommit], commitFor: () => otherCommit }),
    });
    await expect(mismatched.client).rejects.toThrow(/no committed recovery proof|does not bind/);

    // 本机在祖先之后已确认恢复根轮换：用旧根签的分叉一律拒绝
    const ancestor = replayTrustChain(home.events);
    const root2 = RecoveryRoot.generate();
    const rotate = createRecoveryRootEvent({ current: ancestor, op: "rotate", candidate: root2, outerSigner: home.root, at: AT });
    const oldRoot = await exchange({
      purpose: "terminal",
      secret: home.secret,
      localEvents: [...home.events, rotate],
      ports: ports(recovered.events, recovered.issuer, { commits: [recovered.commit] }),
    });
    await expect(oldRoot.client).rejects.toThrow(/superseded recovery root/);
  });

  it("stops at a signed boundary once its session budget is spent and continues from the verified progress", async () => {
    const home = await createHome();
    const migrated = await migrateTo(home);
    const events = extend(migrated.events, migrated.issuerKey, home.e, 40);
    const issuer = issuerOf(home, replayTrustChain(events), migrated.issuerKey);
    const budget = { events: 5, commits: 64 };
    const received: HomeTrustEvent[] = [];
    let resume: HomeDiscoveryResumePoint | undefined;
    let sessions = 0;
    for (;;) {
      const { client, server } = await exchange({
        purpose: "member", secret: home.secret, localEvents: home.events,
        ports: ports(events, issuer, { recordPages: true }), budget, ...(resume ? { resume } : {}),
      });
      const session = await client;
      sessions += 1;
      received.push(...session.verified.pages.flatMap((page) => page.events));
      if (session.verified.complete) {
        session.close();
        await server.catch(() => undefined);
        break;
      }
      // 未完会话：服务端不进入 TLS，客户端只得到已验证进度，不能升级也不能出示证据
      expect(await server).toBeUndefined();
      await expect(session.upgrade()).rejects.toThrow(/incomplete/);
      await expect(session.sendEvidence({})).rejects.toThrow(/incomplete/);
      resume = { point: session.verified.projection.chainHead, projection: session.verified.projection };
    }
    // 测试端口每页 16 条、每页都是签名边界：预算 5 条时每次会话正好一页
    expect(sessions).toBe(Math.ceil((events.length - home.events.length) / 16));
    // 各会话首尾相接、无重复：拼起来正是本机之后的完整后缀
    expect(received.map((event) => event.seq)).toEqual(events.slice(home.events.length).map((event) => event.seq));
    expect(resume?.projection.chainHead.seq).toBeLessThan(events.length - 1);
  });

  it("verifies a resumed session only from a progress point that matches its own projection", async () => {
    const home = await createHome();
    const migrated = await migrateTo(home);
    const events = extend(migrated.events, migrated.issuerKey, home.e, 12);
    const issuer = issuerOf(home, replayTrustChain(events), migrated.issuerKey);
    const at = (seq: number) => replayTrustChain(events.slice(0, seq + 1));
    // 续做点与投影对不上：客户端拒绝，不拿别处的投影接着验
    const mismatched = await exchange({
      purpose: "member", secret: home.secret, localEvents: home.events, ports: ports(events, issuer, {}),
      resume: { point: at(8).chainHead, projection: at(7) },
    });
    await expect(mismatched.client).rejects.toThrow(/resume point does not match/);
    // 服务端链上没有的续做点：退回本机链候选，从本机投影完整验过
    const unknown = await exchange({
      purpose: "member", secret: home.secret, localEvents: home.events, ports: ports(events, issuer, {}),
      resume: { point: { seq: 9, eventDigest: DIGEST }, projection: { ...at(9), chainHead: { seq: 9, eventDigest: DIGEST } } },
    });
    const session = await unknown.client;
    expect(complete(session).from.seq).toBe(home.events.length - 1);
    session.close();
  });

  it("resumes a committed fork without comparing the new branch against the local superseded events", async () => {
    const home = await createHome();
    // 本机旧分支在祖先之后还有几条；新分支是灾备转移加一段延伸，同样的序号上内容都不同
    const ancestor = replayTrustChain(home.events);
    let old = ancestor;
    const localExtra: HomeTrustEvent[] = [];
    for (const roles of [["executor", "surface"], ["executor"], ["executor", "surface"]] as const) {
      const event = createSignedTrustEvent({ current: old, body: { t: "role-change", deviceId: home.e.key.deviceId, roles: [...roles] }, at: AT, signer: home.a.key });
      old = applyTrustEvent(old, event);
      localExtra.push(event);
    }
    const recovered = await recoverTo(home, home.events, home.root);
    const events = extend(recovered.events, recovered.issuerKey, home.e, 40);
    const issuer = issuerOf(home, replayTrustChain(events), recovered.issuerKey);
    const localEvents = [...home.events, ...localExtra];
    let resume: HomeDiscoveryResumePoint | undefined;
    for (let round = 0; round < 10; round++) {
      const { client } = await exchange({
        purpose: "member", secret: home.secret, localEvents,
        ports: ports(events, issuer, { commits: [recovered.commit], recordPages: true }),
        budget: { events: 2, commits: 64 }, ...(resume ? { resume } : {}),
      });
      const session = await client;
      expect(session.verified.forked).toBe(true);
      expect(session.verified.ancestor).toEqual(ancestor.chainHead);
      if (session.verified.complete) {
        expect(round).toBe(2);
        expect(session.verified.projection.chainHead).toEqual(replayTrustChain(events).chainHead);
        session.close();
        return;
      }
      resume = { point: session.verified.projection.chainHead, projection: session.verified.projection, ancestor: session.verified.ancestor! };
    }
    throw new Error("Fork discovery did not complete");
  });

  it("delivers a suffix longer than the former total cap across sessions under the default budget", async () => {
    const home = await createHome();
    const migrated = await migrateTo(home);
    const events = extend(migrated.events, migrated.issuerKey, home.e, 4_200);
    const issuer = issuerOf(home, replayTrustChain(events), migrated.issuerKey);
    let resume: HomeDiscoveryResumePoint | undefined;
    let total = 0;
    for (let round = 0; ; round++) {
      const { client } = await exchange({
        purpose: "member", secret: home.secret, localEvents: home.events,
        ports: ports(events, issuer, { recordPages: true }), ...(resume ? { resume } : {}),
      });
      const session = await client;
      total += session.verified.pages.reduce((sum, page) => sum + page.events.length, 0);
      if (session.verified.complete) {
        expect(round).toBe(1);
        session.close();
        break;
      }
      resume = { point: session.verified.projection.chainHead, projection: session.verified.projection };
    }
    expect(total).toBe(events.length - home.events.length);
  }, 120_000);
});

describe("home discovery client reads of its own chain", () => {
  it("reads a bounded set of local points regardless of how long the local chain is", async () => {
    const reads: Record<string, unknown>[] = [];
    for (const length of [200, 600]) {
      const home = await createHome();
      const migrated = await migrateTo(home);
      // 本机已有很长的链；现任只比本机多出几条
      const local = extend(migrated.events, migrated.issuerKey, home.e, length);
      const events = extend(local, migrated.issuerKey, home.e, 3);
      const counted = counting(localChainOfEvents(local));
      const { client } = await exchange({
        purpose: "member", secret: home.secret, localEvents: local, local: counted.chain,
        ports: ports(events, issuerOf(home, replayTrustChain(events), migrated.issuerKey), {}),
      });
      const session = await client;
      expect(complete(session).projection.chainHead.seq).toBe(events.length - 1);
      session.close();
      reads.push({ ...counted.counts });
    }
    // 候选点按 2 的幂取（链长翻三倍只多一两个点）、起点投影一次、重叠序号为零：与链长近乎无关
    expect(reads[1]!.projectionAt).toBe(1);
    expect(reads[0]!.projectionAt).toBe(1);
    expect(Number(reads[1]!.eventAt) - Number(reads[0]!.eventAt)).toBeLessThanOrEqual(2);
    expect(Number(reads[1]!.eventAt)).toBeLessThanOrEqual(64);
  });

  it("reads only the superseded local segment when it detects a fork", async () => {
    const home = await createHome();
    // 本机在祖先之后有 5 条旧分支事件；祖先之前很长
    const prefix = extend(home.events, home.a.key, home.e, 300);
    let old = replayTrustChain(prefix);
    const localExtra: HomeTrustEvent[] = [];
    for (let index = 0; index < 5; index++) {
      const event = createSignedTrustEvent({
        current: old, body: { t: "role-change", deviceId: home.e.key.deviceId, roles: index % 2 === 0 ? ["executor"] : ["executor", "surface"] },
        at: AT, signer: home.a.key,
      });
      old = applyTrustEvent(old, event);
      localExtra.push(event);
    }
    const recovered = await recoverTo(home, prefix, home.root);
    const counted = counting(localChainOfEvents([...prefix, ...localExtra]));
    const { client } = await exchange({
      purpose: "member", secret: home.secret, localEvents: [...prefix, ...localExtra], local: counted.chain,
      ports: ports(recovered.events, recovered.issuer, { commits: [recovered.commit] }),
    });
    const session = await client;
    expect(session.verified.forked).toBe(true);
    session.close();
    // 候选点（≤64）+ 重叠序号 + 分叉之后的本机旧分支段（5 条），不随祖先之前的 300 条增长
    expect(counted.counts.eventAt).toBeLessThanOrEqual(64 + 16 + 5);
    expect(counted.counts.projectionAt).toBe(1);
  });
});

describe("home discovery over a projection without retired history", () => {
  it("still rejects re-enrolling a long-revoked device, through the keyed history lookup", async () => {
    const home = await createHome();
    const migrated = await migrateTo(home);
    const x = await device("退役的设备-X");
    let projection = replayTrustChain(migrated.events);
    const local = [...migrated.events];
    for (const body of [
      { t: "enroll" as const, device: x.identity, roles: ["executor" as const] },
      { t: "revoke" as const, deviceId: x.key.deviceId },
    ]) {
      const event = createSignedTrustEvent({ current: projection, body, at: AT, signer: migrated.issuerKey });
      projection = applyTrustEvent(projection, event);
      local.push(event);
    }
    // 现任链在本机链头之后“重新配对”X：签名有效，但状态转移不合法
    const narrowed = (value: TrustProjection): TrustProjection => ({ ...value, members: value.members.filter((member) => member.state !== "revoked") });
    const reenroll = createSignedTrustEvent({
      current: narrowed(projection), body: { t: "enroll", device: x.identity, roles: ["executor"] }, at: AT, signer: migrated.issuerKey,
    });
    const served = ports([...local, reenroll], issuerOf(home, projection, migrated.issuerKey), {});
    // 本机投影与存储侧快照一样不带已撤销设备；历史只经 revokedMemberAt 按键可得
    const full = localChainOfEvents(local);
    const port = (history: boolean): HomeDiscoveryLocalChain => ({
      ...full,
      projectionAt: async (point) => narrowed(await full.projectionAt(point)),
      revokedMemberAt: history ? full.revokedMemberAt : async () => undefined,
    });
    const rejected = await exchange({ purpose: "member", secret: home.secret, localEvents: local, local: port(true), ports: served });
    await expect(rejected.client).rejects.toThrow(/already exists/);
    // 对照：去掉按键补入，同一后缀就会被错误接受——拒绝来自补入的历史成员
    const accepted = await exchange({ purpose: "member", secret: home.secret, localEvents: local, local: port(false), ports: served });
    const session = await accepted.client;
    expect(session.verified.projection.members.some((member) => member.device.deviceId === x.key.deviceId && member.state === "active")).toBe(true);
    session.close();
  });
});

/** 给本机链端口计数：按方法统计调用次数。 */
function counting(chain: HomeDiscoveryLocalChain) {
  const counts = { eventAt: 0, eventByDigest: 0, projectionAt: 0, revokedMemberAt: 0 };
  return {
    counts,
    chain: {
      head: chain.head,
      eventAt: (seq: number) => { counts.eventAt += 1; return chain.eventAt(seq); },
      eventByDigest: (digest: string) => { counts.eventByDigest += 1; return chain.eventByDigest(digest); },
      projectionAt: (point: Parameters<HomeDiscoveryLocalChain["projectionAt"]>[0]) => { counts.projectionAt += 1; return chain.projectionAt(point); },
      revokedMemberAt: (deviceId: string, seq: number) => { counts.revokedMemberAt += 1; return chain.revokedMemberAt(deviceId, seq); },
    } satisfies HomeDiscoveryLocalChain,
  };
}

function complete(session: HomeDiscoveryClientSession): VerifiedHomeDiscovery {
  if (!session.verified.complete) throw new Error("Home discovery session is incomplete");
  return session.verified;
}

/** 由现任 issuer key 追加 count 条角色变更（E 在 executor 与 executor+surface 间切换），造长后缀。 */
function extend(base: readonly HomeTrustEvent[], signer: DeviceKey, member: TestDevice, count: number): HomeTrustEvent[] {
  const events = [...base];
  let projection = replayTrustChain(base);
  for (let index = 0; index < count; index++) {
    const roles: ("executor" | "surface")[] = index % 2 === 0 ? ["executor", "surface"] : ["executor"];
    const event = createSignedTrustEvent({ current: projection, body: { t: "role-change", deviceId: member.key.deviceId, roles }, at: AT, signer });
    projection = applyTrustEvent(projection, event);
    events.push(event);
  }
  return events;
}

interface TestDevice {
  readonly key: DeviceKey;
  readonly identity: ReturnType<typeof enrollDeviceIdentity>;
}

interface IssuerMaterial {
  readonly peer: { readonly identity: TestDevice["identity"]; readonly rootCertificatePem: string };
  readonly anchorEpoch: number;
  readonly signer: { readonly deviceId: string; sign: DeviceKey["sign"] };
}

async function device(name: string): Promise<TestDevice> {
  const key = await DeviceKey.generate({ now: () => NOW });
  return { key, identity: enrollDeviceIdentity(key, { displayName: name, platform: "headless", enrolledAt: AT }) };
}

async function createHome() {
  const a = await device("值班电脑-A");
  const b = await device("值班电脑-B");
  const e = await device("工作电脑-E");
  const root = RecoveryRoot.generate();
  const genesis = createTrustGenesisEvent({ homeId: "home-discovery", issuer: a.identity, signer: a.key, at: AT });
  const events: HomeTrustEvent[] = [genesis];
  let projection = initializeTrustChain(genesis);
  for (const [member, roles] of [[b, ["anchor"]], [e, ["executor"]]] as const) {
    const event = createSignedTrustEvent({
      current: projection,
      body: { t: "enroll", device: member.identity, roles: [...roles], pairingTranscriptDigest: DIGEST },
      at: AT,
      signer: a.key,
    });
    events.push(event);
    projection = applyTrustEvent(projection, event);
  }
  const establish = createRecoveryRootEvent({ current: projection, op: "establish", candidate: root, outerSigner: a.key, at: AT });
  events.push(establish);
  return { a, b, e, root, events, secret: createTerminalRouteSecret() };
}

async function migrateTo(home: Awaited<ReturnType<typeof createHome>>) {
  const issuerKey = await DeviceKey.generate({ now: () => NOW });
  const current = replayTrustChain(home.events);
  const transition = createSignedTrustEvent({
    current,
    body: {
      t: "issuer-transition",
      nextTrustEpoch: current.trustEpoch + 1,
      fromIssuerKeyId: current.issuer.issuerKeyId,
      toIssuerKeyId: issuerKey.deviceId,
      toIssuerPublicKey: issuerKey.publicKey,
      toDeviceId: home.b.key.deviceId,
      reason: "migration",
      signedBy: "issuer",
    },
    at: AT,
    signer: home.a.key,
  });
  const events = [...home.events, transition];
  return { events, issuerKey, issuer: issuerOf(home, replayTrustChain(events), issuerKey) };
}

async function recoverTo(home: Awaited<ReturnType<typeof createHome>>, base: readonly HomeTrustEvent[], root: RecoveryRoot) {
  const issuerKey = await DeviceKey.generate({ now: () => NOW });
  const current = replayTrustChain(base);
  const transition = createSignedTrustEvent({
    current,
    body: {
      t: "issuer-transition",
      nextTrustEpoch: current.trustEpoch + 1,
      fromIssuerKeyId: current.issuer.issuerKeyId,
      toIssuerKeyId: issuerKey.deviceId,
      toIssuerPublicKey: issuerKey.publicKey,
      toDeviceId: home.b.key.deviceId,
      reason: "disaster-recovery",
      signedBy: "recovery-root",
    },
    at: AT,
    signer: root,
  });
  const events = [...base, transition];
  const after = replayTrustChain(events);
  const commit = createSignedDisasterRecoveryCommit({
    v: 1,
    mode: "disaster-recovery",
    transferId: "xfer-01J00000000000000000000088",
    targetDeviceId: home.b.key.deviceId,
    checkpointEnvelopeDigest: DIGEST,
    authorityCatalogDigest: DIGEST,
    trustTransitionDigest: homeTrustEventDigest(transition),
    readyProofDigest: DIGEST,
    nextAnchorEpoch: after.anchorEpoch,
    nextTrustEpoch: current.trustEpoch + 1,
    targetIssuerPublicKey: issuerKey.publicKey,
    at: AT,
  }, root);
  return { events, commit, issuerKey, issuer: issuerOf(home, after, issuerKey) };
}

function issuerOf(
  home: Awaited<ReturnType<typeof createHome>>,
  projection: TrustProjection,
  signer: DeviceKey,
): IssuerMaterial {
  const device = [home.a, home.b, home.e].find((item) => item.key.deviceId === projection.issuer.deviceId)!;
  return {
    peer: { identity: device.identity, rootCertificatePem: device.key.rootCertificatePem },
    anchorEpoch: projection.anchorEpoch,
    signer,
  };
}

function unsignedCommit(commit: DisasterRecoveryCommitProof) {
  const { signature: _signature, ...unsigned } = commit;
  return unsigned;
}

function ports(
  events: readonly HomeTrustEvent[],
  issuer: IssuerMaterial,
  options: {
    readonly evidence?: unknown[];
    readonly commits?: readonly DisasterRecoveryCommitProof[];
    readonly commitFor?: (transition: HomeTrustEvent) => DisasterRecoveryCommitProof | undefined;
    /** 每页都以签名记录收尾（服务端只在记录边界截断会话）；记录内容对发现交换不透明。 */
    readonly recordPages?: boolean;
  },
): HomeDiscoveryServerPorts {
  return {
    homeId: events[0]!.homeId,
    async findBase(points) {
      return points.find((point) => events[point.seq] && homeTrustEventDigest(events[point.seq]!) === point.eventDigest);
    },
    async page(from) {
      const next = events.slice(from.seq + 1, from.seq + 1 + 16);
      return {
        events: next,
        ...(options.recordPages ? { record: { marker: next.at(-1)?.seq } as never } : {}),
        complete: from.seq + next.length === events.length - 1,
      };
    },
    async issuer() {
      return issuer;
    },
    async recoveryCommit(transition) {
      if (options.commitFor) return options.commitFor(transition);
      return options.commits?.find((commit) => commit.trustTransitionDigest === homeTrustEventDigest(transition));
    },
    async acceptEvidence({ evidence }) {
      options.evidence?.push(evidence);
    },
  };
}

/** 一对经回环（或经篡改代理）相连的 socket，上面各跑客户端与服务端。 */
async function exchange(input: {
  readonly purpose: HomeDiscoveryPurpose;
  readonly secret: string;
  readonly clientSecret?: string;
  readonly localEvents: readonly HomeTrustEvent[];
  /** 替代默认的内存本机链（例如带读取计数的端口）。 */
  readonly local?: HomeDiscoveryLocalChain;
  readonly ports: HomeDiscoveryServerPorts;
  readonly tamperServerToClient?: boolean;
  readonly fragment?: boolean;
  readonly budget?: HomeDiscoveryBudget;
  readonly resume?: HomeDiscoveryResumePoint;
}) {
  const accepted = new Promise<Socket>((resolve) => {
    const server = createServer((socket) => resolve(socket));
    servers.push(server);
    server.listen(0, "127.0.0.1");
  });
  const target = servers.at(-1)!;
  await once(target, "listening");
  let port = (target.address() as { port: number }).port;
  if (input.tamperServerToClient) port = await tamperingProxy(port);
  if (input.fragment) port = await fragmentingProxy(port);
  const clientSocket = connect({ host: "127.0.0.1", port });
  await once(clientSocket, "connect");
  const serverSocket = await accepted;
  const server = serveHomeDiscovery({
    socket: serverSocket, purpose: input.purpose, secret: input.secret, ports: input.ports, timeoutMs: 30_000,
    ...(input.budget ? { budget: input.budget } : {}),
  });
  const client = openHomeDiscovery({
    socket: clientSocket,
    purpose: input.purpose,
    secret: input.clientSecret ?? input.secret,
    local: input.local ?? localChainOfEvents(input.localEvents),
    ...(input.resume ? { resume: input.resume } : {}),
    timeoutMs: 30_000,
  });
  // 两端失败时由各自的断言消费，这里只防止未处理拒绝
  server.catch(() => undefined);
  client.catch(() => undefined);
  return { client, server };
}

/** 中继模型：转发双向字节，但把服务端发来的第一条加密帧里的一个字节翻转。 */
async function tamperingProxy(targetPort: number): Promise<number> {
  const proxy = createServer((inbound) => {
    const outbound = connect({ host: "127.0.0.1", port: targetPort });
    inbound.pipe(outbound);
    // 逐块即时转发；hello 之后第一条加密帧的第 8 个字节经过时翻转（hello 不扣留，否则两端互等）
    let offset = 0;
    let header = Buffer.alloc(0);
    let target: number | undefined;
    outbound.on("data", (chunk: Buffer) => {
      if (target === undefined) {
        header = Buffer.concat([header, chunk]).subarray(0, 4);
        if (header.byteLength === 4) target = 4 + header.readUInt32BE(0) + 8;
      }
      if (target !== undefined && target >= offset && target < offset + chunk.byteLength) {
        chunk = Buffer.from(chunk);
        chunk[target - offset] ^= 0xff;
      }
      offset += chunk.byteLength;
      inbound.write(chunk);
    });
    const close = () => { inbound.destroy(); outbound.destroy(); };
    inbound.on("error", close);
    outbound.on("error", close);
    inbound.on("close", close);
    outbound.on("close", close);
  });
  servers.push(proxy);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return (proxy.address() as { port: number }).port;
}

/** 中继模型：双向把每一块拆成单字节逐个转发（合法交换跨任意分片都要成功）。 */
async function fragmentingProxy(targetPort: number): Promise<number> {
  const proxy = createServer((inbound) => {
    const outbound = connect({ host: "127.0.0.1", port: targetPort });
    const relay = (from: Socket, to: Socket) => {
      from.on("data", (chunk: Buffer) => {
        for (const byte of chunk) to.write(Buffer.from([byte]));
      });
    };
    relay(inbound, outbound);
    relay(outbound, inbound);
    const close = () => { inbound.destroy(); outbound.destroy(); };
    for (const socket of [inbound, outbound]) {
      socket.on("error", close);
      socket.on("close", close);
    }
  });
  servers.push(proxy);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return (proxy.address() as { port: number }).port;
}

function readOne(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunk = socket.read(1) as Buffer | null;
    if (chunk) {
      resolve(chunk);
      return;
    }
    socket.once("readable", () => {
      const next = socket.read(1) as Buffer | null;
      if (next) resolve(next);
      else reject(new Error("no byte"));
    });
  });
}
