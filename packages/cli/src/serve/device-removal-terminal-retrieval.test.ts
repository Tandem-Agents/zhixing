import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { MeshEndpointDescriptor, SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceLifecycleJournal, FileAuthorityCommitLog, FileDurableProjectionIndex } from "@zhixing/core/authority";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { createCredentialExposureRecord } from "@zhixing/mesh/credential-exposure";
import { BlindRendezvousMatcher, readBlindRendezvousHello } from "@zhixing/mesh/blind-rendezvous";
import { MeshEndpointDirectory } from "@zhixing/mesh/bootstrap";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import { MeshServiceRegistry, type MeshServiceDefinition } from "@zhixing/mesh/service-registry";
import {
  buildHomeTrustRecord,
  createSignedTrustEvent,
  CURRENT_TRUST_PROJECTION_ID,
  replayTrustChain,
} from "@zhixing/mesh/trust-chain";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import { captureFileIo, createTempDir, type FileIoSnapshot } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  CurrentIssuerDeviceRemovalAuthority,
  ExecutorRemovalTarget,
  loadOrCreateIssuerTerminalRouteSecret,
  resolveExecutorRemovalTerminalRoute,
} from "./device-removal.js";
import {
  DeviceRemovalIssuerMeshClient,
  DeviceRemovalTargetMeshClient,
  registerDeviceRemovalIssuerMeshService,
  registerDeviceRemovalTargetMeshService,
} from "./device-removal-mesh.js";
import { ExecutorRemovalRetrievalOwner, retrieveExecutorRemovalTerminal } from "./device-removal-retrieval.js";
import {
  createMeshBootstrapProjectionPorts,
  loadActiveMemberTransportPeers,
} from "./mesh-bootstrap-projection.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { createLiveTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";

const AT0 = "2026-08-12T00:00:00.000Z";
const AT1 = "2026-08-12T00:00:03.000Z";

describe("executor removal terminal retrieval through the duty device's fixed terminal entry", () => {
  it("lets two removed devices finish on their own after a relay-only duty device restarts mid-removal", async () => {
    const home = await createIssuerHome("restart");
    const relay = await startRelay();
    const devices = [await enrollTarget(home, "工作电脑-A"), await enrollTarget(home, "工作电脑-B")];
    let issuer = await startIssuer(home, relay.port);
    try {
      const removals = [];
      for (const [index, device] of devices.entries()) {
        const target = createTarget(home, device, relay.port);
        const operationId = `remove-restart-${index}`;
        const { revoked } = await driveToRevoked(home, issuer.authority, device, target.target, operationId);
        // 本机清理完成、cleanup-ready 已落盘但还没送达，值班设备就崩了
        expect(await target.target.finish(revoked)).toMatchObject({ phase: "cleanup-ready" });
        removals.push({ ...target, operationId, device });
      }
      await issuer.control.stop();

      // 两台设备在值班设备停机期间开始取回；新实例不带任何按设备的状态，只挂固定数量的终态接入
      const retrievals = removals.map((removal) => retrieveExecutorRemovalTerminal({
        target: removal.target,
        deviceKey: removal.device.key,
        verifier: home.verifier,
        operationId: removal.operationId,
        signal: AbortSignal.timeout(60_000),
        random: () => 0.1,
      }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      issuer = await startIssuer(home, relay.port);
      await Promise.all(retrievals);

      for (const removal of removals) {
        await expect(removal.target.isRetired(removal.operationId)).resolves.toBe(true);
        await expect(issuer.authority.terminal(removal.operationId)).resolves.toMatchObject({
          phase: "removed",
          targetDeviceId: removal.device.identity.deviceId,
        });
        // 本机终结之后不留本操作的终态路由副本
        expect(await removal.secrets.list("terminal-route/")).toEqual([]);
      }
      // 中继只看到接入方与请求方按角色排队；两台设备各自取回自己的那次移除
      expect(relay.hellos.filter((hello) => hello.role === "connect").length).toBeGreaterThanOrEqual(2);
    } finally {
      await issuer.control.stop();
      await relay.close();
      await home.store.stopStorageMaintenance();
    }
  }, 120_000);

  it("keeps the duty device's restart reads, resident relay entries and per-retrieval reads independent of completed removals", async () => {
    type TrustReads = { readonly trustLoads: number; readonly trustEventReads: number; readonly logReplays: number };
    const rows: {
      readonly completed: number;
      readonly startup: ProjectionReads & TrustReads & { readonly peerReads: number; readonly peerListings: number };
      readonly entries: number;
      readonly retrieval: ProjectionReads & TrustReads & { readonly peerReads: number };
      readonly replays: ProjectionReads & TrustReads;
    }[] = [];
    for (const completed of [4, 12, 48]) {
      const home = await createIssuerHome(`scale-${completed}`);
      const relay = await startRelay();
      const authority = home.authority();
      for (let index = 0; index < completed; index++) {
        await completeBySignedReceipts(home, authority, await enrollTarget(home, `old-target-${index}`), index);
      }
      const live = await enrollTarget(home, "工作电脑-live");
      let issuer = await startIssuer(home, relay.port);
      const target = createTarget(home, live, relay.port);
      const operationId = `remove-live-${completed}`;
      try {
        const { ready, revoked } = await driveToRevoked(home, issuer.authority, live, target.target, operationId);
        const cleanupReady = await target.target.finish(revoked);
        await issuer.control.stop();

        const reads = countProjectionReads();
        const peerReads = vi.spyOn(FileMeshBootstrapStore.prototype, "transportPeer");
        const peerListings = vi.spyOn(FileMeshBootstrapStore.prototype, "listTransportPeers");
        // 整条信任流的装载、按摘要精确读一条事件、日志流重放（transactProjection）分别计数
        const trustLoads = vi.spyOn(FileMeshBootstrapStore.prototype, "loadTrustEvents");
        const trustEventReads = vi.spyOn(FileMeshBootstrapStore.prototype, "trustEventByDigest");
        const logReplays = vi.spyOn(FileAuthorityCommitLog.prototype, "transactProjection");
        const trust = (): TrustReads => {
          const value = {
            trustLoads: trustLoads.mock.calls.length,
            trustEventReads: trustEventReads.mock.calls.length,
            logReplays: logReplays.mock.calls.length,
          };
          for (const spy of [trustLoads, trustEventReads, logReplays]) spy.mockClear();
          return value;
        };
        const helloMark = relay.hellos.length;
        try {
          issuer = await startIssuer(home, relay.port);
          const startup = {
            ...reads.take(),
            ...trust(),
            peerReads: peerReads.mock.calls.length,
            peerListings: peerListings.mock.calls.length,
          };
          await waitFor(() => relay.hellos.length - helloMark >= 4);
          await new Promise((resolve) => setTimeout(resolve, 200));
          const entries = relay.hellos.slice(helloMark).filter((hello) => hello.role === "accept").length;
          peerReads.mockClear();
          reads.take();
          trust();
          await retrieveExecutorRemovalTerminal({
            target: target.target,
            deviceKey: live.key,
            verifier: home.verifier,
            operationId,
            signal: AbortSignal.timeout(60_000),
            random: () => 0.1,
          });
          const retrieval = { ...reads.take(), ...trust(), peerReads: peerReads.mock.calls.length };
          // 已终结之后的重投：ready、cleanup-ready 与 terminal 查询都只按 operation 精确读
          await issuer.authority.commitReady(ready);
          await issuer.authority.commitCleanupReady(cleanupReady!);
          await issuer.authority.terminal(operationId);
          rows.push({ completed, startup, entries, retrieval, replays: { ...reads.take(), ...trust() } });
        } finally {
          reads.restore();
          for (const spy of [peerReads, peerListings, trustLoads, trustEventReads, logReplays]) spy.mockRestore();
        }
        await expect(target.target.isRetired(operationId)).resolves.toBe(true);
      } finally {
        await issuer.control.stop();
        await relay.close();
        await home.store.stopStorageMaintenance();
      }
    }
    // allow-direct-stdout：规模用例的读数输出；测试文件不是运行时输出面
    console.log("TERMINAL_RETRIEVAL_ROWS", JSON.stringify(rows));
    // 重启只读当前成员与固定入口：不枚举已终结的移除，也不枚举传输对端目录
    expect(rows.every((row) => row.startup.peerListings === 0)).toBe(true);
    expect(rows.every((row) => row.entries === 4)).toBe(true);
    // 取回与重投都不装载整条信任流、不重放日志流
    expect(rows.every(({ startup, retrieval, replays }) =>
      [startup, retrieval, replays].every((reading) => reading.trustLoads === 0 && reading.logReplays === 0))).toBe(true);
    expect(rows.map(({ startup, retrieval, replays }) => [startup, retrieval, replays]))
      .toEqual(rows.map(() => [rows[0]!.startup, rows[0]!.retrieval, rows[0]!.replays]));
  }, 600_000);

  it("finishes from every durable point that still needs the duty device", async () => {
    const home = await createIssuerHome("crash-matrix");
    const relay = await startRelay();
    const issuer = await startIssuer(home, relay.port);
    const points = ["revoked-receipt-lost", "crash-during-cleanup", "cleanup-complete-before-ready", "removed-receipt-lost"] as const;
    try {
      for (const [index, point] of points.entries()) {
        const device = await enrollTarget(home, `crash-${point}`);
        let cleanupFails = point === "crash-during-cleanup" || point === "cleanup-complete-before-ready";
        const target = createTarget(home, device, relay.port, {
          cleanup: async () => {
            if (cleanupFails) {
              cleanupFails = false;
              throw new Error("simulated crash during local cleanup");
            }
            return [{ kind: "cleanup" as const, digest: protocolDigest("TerminalRetrievalCleanup", 1, { point }) }];
          },
        });
        const operationId = `remove-crash-${index}`;
        const { revoked } = await driveToRevoked(home, issuer.authority, device, target.target, operationId);
        if (point === "crash-during-cleanup" || point === "cleanup-complete-before-ready") {
          await expect(target.target.finish(revoked)).rejects.toThrow("simulated crash");
        }
        if (point === "cleanup-complete-before-ready") {
          // 清理已推进到 cleanup-complete，cleanup-ready 还没写就崩溃
          const journal = new DeviceLifecycleJournal(target.log);
          await journal.advance(operationId, "cleanup-complete", [{
            kind: "cleanup",
            digest: protocolDigest("TerminalRetrievalCleanup", 1, { point }),
          }]);
          const state = await journal.state(operationId);
          expect(state?.phase).toBe("cleanup-complete");
          expect(state?.peerEffects.some((effect) => effect.kind === "target-cleanup-ready")).toBe(false);
        }
        if (point === "removed-receipt-lost") {
          const cleanupReady = await target.target.finish(revoked);
          await issuer.authority.commitCleanupReady(cleanupReady!);
        }
        await retrieveExecutorRemovalTerminal({
          target: target.target,
          deviceKey: device.key,
          verifier: home.verifier,
          operationId,
          signal: AbortSignal.timeout(60_000),
          random: () => 0.1,
        });
        await expect(target.target.isRetired(operationId)).resolves.toBe(true);
        await expect(issuer.authority.terminal(operationId)).resolves.toMatchObject({ phase: "removed" });
      }
    } finally {
      await issuer.control.stop();
      await relay.close();
      await home.store.stopStorageMaintenance();
    }
  }, 120_000);

  it("rejects unknown, cancelled and re-keyed removals at resolution and binds terminal commands to their operation", async () => {
    const home = await createIssuerHome("resolution");
    const authority = home.authority();
    const device = await enrollTarget(home, "工作电脑-R");
    const accepted = await authority.accept({ requestId: "request-r", operationId: "remove-r", targetName: "工作电脑-R" });
    const route = await authority.terminalRoute("remove-r");
    const transportPeer = (deviceId: string) => home.ports.transportPeers.transportPeer(deviceId);
    await expect(resolveExecutorRemovalTerminalRoute({ authority, transportPeer }, route.locator))
      .resolves.toMatchObject({ binding: "remove-r", peer: { identity: { deviceId: device.identity.deviceId } } });
    // 重复交付同一份材料
    await expect(authority.terminalRoute("remove-r")).resolves.toEqual(route);
    // 未知定位
    await expect(resolveExecutorRemovalTerminalRoute({ authority, transportPeer }, "q".repeat(52))).resolves.toBeUndefined();
    // 设备换了密钥：传输身份与冻结的代际不一致
    const rekeyed = await DeviceKey.generate();
    await expect(resolveExecutorRemovalTerminalRoute({
      authority,
      transportPeer: async () => ({
        identity: { ...device.identity, publicKey: rekeyed.publicKey },
        rootCertificatePem: rekeyed.rootCertificatePem,
      }),
    }, route.locator)).resolves.toBeUndefined();

    // 终态命令必须属于连接绑定的 operation，没有终态绑定的连接一律不放行
    const registry = new MeshServiceRegistry();
    let captured: Parameters<MeshServiceRegistry["register"]>[1] | undefined;
    const register = registry.register.bind(registry);
    registry.register = (serviceId, definition) => {
      captured = definition;
      return register(serviceId, definition);
    };
    registerDeviceRemovalIssuerMeshService(registry, {
      authority,
      authorizeTarget: (deviceId) => authority.authorizesTarget(deviceId),
      terminalOnly: true,
    });
    const peer = { deviceId: device.identity.deviceId };
    expect(await captured!.authorize?.({ peer } as never)).toBe(false);
    expect(await captured!.authorize?.({ peer, route: { kind: "terminal", binding: "remove-r" } } as never)).toBe(true);
    await expect(captured!.handler(
      Buffer.from(JSON.stringify({ v: 1, op: "terminal", operationId: "remove-other" })),
      { peer, route: { kind: "terminal", binding: "remove-r" } } as never,
      new AbortController().signal,
    )).rejects.toThrow("does not match the connection's operation");
    await expect(captured!.handler(
      Buffer.from(JSON.stringify({ v: 1, op: "accept-self", operationId: "remove-r", requestId: "x" })),
      { peer, route: { kind: "terminal", binding: "remove-r" } } as never,
      new AbortController().signal,
    )).rejects.toThrow("only accepts terminal effects");

    // 取消签发后、target 落盘中止前定位仍在：target 要经终态入口把中止回执交回来
    const target = createTarget(home, device, 1);
    await target.target.accept(accepted, route);
    const abort = await authority.abort(accepted.operationId);
    await expect(resolveExecutorRemovalTerminalRoute({ authority, transportPeer }, route.locator))
      .resolves.toMatchObject({ binding: "remove-r" });
    await authority.acceptTargetAborted(await target.target.abort(accepted.operationId, abort));
    // 中止终结后定位目录项随之删除，终态入口再也解析不到；target 侧的路由副本也删除
    await expect(resolveExecutorRemovalTerminalRoute({ authority, transportPeer }, route.locator)).resolves.toBeUndefined();
    await expect(authority.terminalRoute("remove-r")).rejects.toThrow("no live terminal route");
    expect(await target.secrets.list("terminal-route/")).toEqual([]);
    await home.store.stopStorageMaintenance();
  });

  it("refuses to become revocation-ready before the retrieval material is durable", async () => {
    const home = await createIssuerHome("guard");
    const authority = home.authority();
    const device = await enrollTarget(home, "工作电脑-G");
    const target = createTarget(home, device, 1);
    const accepted = await authority.accept({ requestId: "request-g", operationId: "remove-g", targetName: "工作电脑-G" });
    // 绕过 accept 的落盘，直接接受生命周期：没有终态路由就不得产生 revocation-ready
    const journal = new DeviceLifecycleJournal(target.log);
    await journal.accept({
      v: 1,
      kind: "executor-removal",
      requestId: "target:remove-g",
      operationId: "remove-g",
      homeId: accepted.homeId,
      targetDeviceId: accepted.targetDeviceId,
      targetMemberPublicKey: device.key.publicKey,
      targetDeviceKeyGeneration: accepted.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: accepted.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: accepted.acceptedTrustHeadDigest,
    });
    await expect(target.target.decide({
      operationId: "remove-g",
      mode: "destroy",
      currentAnchorDeviceId: home.issuer.deviceId,
    })).rejects.toThrow("no durable terminal route");
    await home.store.stopStorageMaintenance();
  });

  it("recovers a revocation-ready removal at startup without replaying trust, exposure or lifecycle history", async () => {
    const rows: {
      readonly completed: number;
      readonly resume: ProjectionReads & {
        readonly bytes: number;
        readonly trustLoads: number;
        readonly logReplays: number;
      };
      readonly io: FileIoSnapshot;
      readonly prepareIo: FileIoSnapshot;
      readonly recordBytes: number;
      readonly recordSeq: number;
    }[] = [];
    // 整条恢复（事务内读取、撤销与快照写出、写入时的归约验证）的真实文件读写，按日志与各投影目录、文件类型计
    const io = await captureFileIo(path.dirname(await createTempDir("terminal-retrieval-io")), (relative) => {
      const parts = relative.split("/");
      const projection = parts.indexOf("projections");
      if (projection >= 0) return `projection:${parts[projection + 1]}:${path.extname(relative) || parts.at(-1)}`;
      return relative.endsWith("authority.log") ? "log" : `other:${parts.at(-1)}`;
    });
    for (const completed of [4, 12, 48]) {
      const home = await createIssuerHome(`ready-restart-${completed}`, { production: true });
      const authority = home.authority();
      // 固定的当前成员：签发者、一台在世旁观者、待移除的在世目标
      await enrollTarget(home, "旁观电脑");
      // 每台旧目标都带一份外部凭据，移除时被标为 compromised：凭据暴露的历史随 K 增长
      for (let index = 0; index < completed; index++) {
        const old = await enrollTarget(home, `old-target-${index}`);
        await appendActiveExposure(home, old.identity.deviceId);
        await completeBySignedReceipts(home, authority, old, index);
      }
      const live = await enrollTarget(home, "工作电脑-ready");
      const target = createTarget(home, live, 1);
      const operationId = `remove-ready-${completed}`;
      // 目标设备有一份 active 外部凭据：撤销时照旧标为 compromised
      await appendActiveExposure(home, live.identity.deviceId);
      const accepted = await authority.accept({ requestId: `request-${operationId}`, operationId, targetName: live.identity.displayName });
      await target.target.accept(accepted, await authority.terminalRoute(operationId));
      const decision = await target.target.decide({ operationId, mode: "destroy", currentAnchorDeviceId: home.issuer.deviceId });
      if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
      // 第一次撤销事务执行前崩溃：issuer 已耐久 revocation-ready
      const transact = FileAuthorityCommitLog.prototype.transactDurableProjection;
      const crash = vi.spyOn(FileAuthorityCommitLog.prototype, "transactDurableProjection").mockImplementation(function (this: FileAuthorityCommitLog, ...args) {
        if (args[2]?.readProjectionIds?.includes(CURRENT_TRUST_PROJECTION_ID)) throw new Error("simulated crash before revocation");
        return transact.apply(this, args);
      });
      await expect(authority.commitReady(decision.receipt)).rejects.toThrow("simulated crash before revocation");
      crash.mockRestore();
      expect((await new DeviceLifecycleJournal(home.store.authorityLog()).state(operationId))?.phase).toBe("revocation-ready");

      // 值班设备冷重启：经生产入口重开（认证日志、只含当前成员的常驻验签身份），
      // 照生产启动顺序先准备运行时投影（补追关闭时尚未刷进段的日志尾部），单独计量
      const reopened = await reopenIssuerHome(home);
      const restarted = reopened.authority();
      io.reset();
      await reopened.store.authoritySources()!.prepareRuntime("runtime-prepare");
      const prepareIo = io.snapshot();
      const reads = countProjectionReads();
      const trustLoads = vi.spyOn(FileMeshBootstrapStore.prototype, "loadTrustEvents");
      const logReplays = vi.spyOn(FileAuthorityCommitLog.prototype, "transactProjection");
      let revoked: Awaited<ReturnType<typeof restarted.commitReady>>;
      try {
        io.reset();
        await restarted.resumeActive();
        const resumeIo = io.snapshot();
        rows.push({
          completed,
          resume: {
            ...reads.takeWithBytes(),
            trustLoads: trustLoads.mock.calls.length,
            logReplays: logReplays.mock.calls.length,
          },
          io: resumeIo,
          prepareIo,
          recordBytes: 0,
          recordSeq: 0,
        });
      } finally {
        reads.restore();
        trustLoads.mockRestore();
        logReplays.mockRestore();
      }
      expect((await new DeviceLifecycleJournal(reopened.store.authorityLog()).state(operationId))?.phase).toBe("revoked");
      // 新回执：撤销回执按已存事实精确取回并验签
      revoked = await restarted.commitReady(decision.receipt);
      expect(revoked.phase).toBe("revoked");
      // 新写出的快照与独立全链重放构建的记录逐字节相同（只列 active），并通过当前信任投影的校验
      const records = (await reopened.store.authorityLog().readStream("trust"))
        .map((entry) => entry.body as { readonly t?: string; readonly record?: { readonly v?: number; readonly members?: unknown[] } })
        .filter((body) => body.t === "home-trust-record");
      const written = records.at(-1)!.record!;
      const replayed = replayTrustChain(await reopened.store.loadTrustEvents());
      expect(canonicalize(written)).toBe(canonicalize(buildHomeTrustRecord(replayed, home.issuerKey)));
      expect(written.v).toBe(2);
      expect(written.members).toHaveLength(2);
      rows[rows.length - 1] = { ...rows.at(-1)!, recordBytes: Buffer.byteLength(canonicalize(written)), recordSeq: replayed.chainHead.seq };
      expect(replayed.members.find((member) => member.device.deviceId === live.identity.deviceId)?.state).toBe("revoked");
      // 当前视图与独立全链重放的 active 子集一致
      const currentView = await reopened.store.loadCurrentTrust();
      expect(currentView?.chainHead).toEqual(replayed.chainHead);
      expect(currentView?.members.map((member) => member.device.deviceId).sort())
        .toEqual(replayed.members.filter((member) => member.state === "active").map((member) => member.device.deviceId).sort());
      const exposures = await new CredentialExposureAuthority({
        deviceId: home.issuer.deviceId,
        log: reopened.store.authorityLog(),
        secretStore: home.secrets,
      }).projection();
      expect(exposures.records.filter((record) => record.deviceId === live.identity.deviceId).map((record) => record.state))
        .toEqual(["compromised"]);
      expect(exposures.records.filter((record) => record.state === "compromised")).toHaveLength(completed + 1);
      await reopened.store.stopStorageMaintenance();
    }
    // allow-direct-stdout：规模用例的读数输出；测试文件不是运行时输出面
    console.log("REVOCATION_RESUME_ROWS", JSON.stringify(rows.map(({ completed, resume, io: snapshot, prepareIo, recordBytes }) => ({
      completed, resume, recordBytes,
      io: { reads: snapshot.reads, readBytes: snapshot.readBytes, writes: snapshot.writes, writeBytes: snapshot.writeBytes,
        byCategory: snapshot.byCategory },
      prepare: { reads: prepareIo.reads, readBytes: prepareIo.readBytes, writes: prepareIo.writes, writeBytes: prepareIo.writeBytes,
        byCategory: prepareIo.byCategory },
    }))));
    // 不装载整条信任流、不重放任何日志流
    expect(rows.every(({ resume }) => resume.trustLoads === 0 && resume.logReplays === 0)).toBe(true);
    // 整条事务与写入时的归约验证，不扣除任何成员行：投影按键读与扫描行、日志读写次数与字节、
    // 写出的快照体积（扣掉链序号的位数）三档相同
    const counts = ({ resume, io: snapshot, recordBytes, recordSeq }: (typeof rows)[number]) => ({
      keys: resume.keys,
      scanned: resume.scanned,
      logReads: snapshot.byCategory.log?.reads,
      logReadBytes: snapshot.byCategory.log?.readBytes,
      logWrites: snapshot.byCategory.log?.writes,
      recordBytes: recordBytes - String(recordSeq).length,
    });
    expect(rows.map(counts)).toEqual(rows.map(() => counts(rows[0]!)));
    // 读出值的物化字节只差链序号、日志位置这类数字字段的位数
    const materialized = rows.map(({ resume }) => resume.bytes);
    expect(Math.max(...materialized) - Math.min(...materialized)).toBeLessThan(128);
    // 投影段文件的物理读取随冷开时的段布局（至多 4 个增量段加基段）波动，照实输出，不作相等断言
  }, 600_000);

  it("verifies a removed device's receipts after the duty device restarts with a cold identity cache", async () => {
    const home = await createIssuerHome("cold-identity", { production: true });
    const device = await enrollTarget(home, "工作电脑-C");
    const target = createTarget(home, device, 1);
    const operationId = "remove-cold-identity";
    const { ready, revoked } = await driveToRevoked(home, home.authority(), device, target.target, operationId);
    const cleanupReady = await target.target.finish(revoked);
    if (!cleanupReady) throw new Error("target did not produce its cleanup-ready receipt");
    // 每个回执都在一次全新的冷重开上提交：前一次补齐的身份不会替后一次遮住缺口
    const coldRestart = async () => {
      const reopened = await reopenIssuerHome({ ...home, store: current.store });
      const authority = reopened.authority();
      await authority.resumeActive();
      // 冷缓存：已撤销设备不是常驻验签身份
      expect(() => reopened.identities.identityFor(device.identity.deviceId)).toThrow("verification identity is not loaded");
      current = reopened;
      return authority;
    };
    let current: { store: FileMeshBootstrapStore } = home;
    try {
      // 目标处在清理阶段：直接交 cleanup-ready，按 keyId 从身份目录补齐后验签，写下终结
      await expect((await coldRestart()).commitCleanupReady(cleanupReady)).resolves.toMatchObject({ phase: "removed" });
      // ready 重投同样在冷缓存上补齐验签，按已存事实给出终结回执
      await expect((await coldRestart()).commitReady(ready)).resolves.toMatchObject({ phase: "removed" });
      // 补齐只回答“签名者是谁”：已撤销设备不回到当前成员，也不在当前快照里
      expect((await current.store.loadCurrentTrust())?.members.some((member) => member.device.deviceId === device.identity.deviceId))
        .toBe(false);
      expect((await current.store.loadTrustRecord())?.members.some((member) => member.device.deviceId === device.identity.deviceId))
        .toBe(false);
    } finally {
      await current.store.stopStorageMaintenance();
    }
  }, 60_000);

  it("retries a failed route-copy deletion because the local terminal is written only after it", async () => {
    const home = await createIssuerHome("delete-retry");
    const relay = await startRelay();
    const issuer = await startIssuer(home, relay.port);
    const device = await enrollTarget(home, "工作电脑-D");
    const target = createTarget(home, device, relay.port);
    const operationId = "remove-delete-retry";
    try {
      const { revoked } = await driveToRevoked(home, issuer.authority, device, target.target, operationId);
      const removed = await issuer.authority.commitCleanupReady((await target.target.finish(revoked))!);
      failNextRouteDelete(target.secrets);
      await expect(target.target.finish(removed)).rejects.toThrow("simulated secret store delete failure");
      // issuer 终态回执已耐久、本机还没终结、副本还在：剩余义务精确留在这一次操作上
      await expect(target.target.isRetired(operationId)).resolves.toBe(false);
      await expect(target.target.revokingOperation()).resolves.toBe(operationId);
      expect(await target.secrets.list("terminal-route/")).toHaveLength(1);
      // 值班设备与中继都已不在：凭耐久回执在本机重做删除与终结，不碰网络
      await issuer.control.stop();
      await relay.close();
      await retrieveExecutorRemovalTerminal({
        target: target.target,
        deviceKey: device.key,
        verifier: home.verifier,
        operationId,
        signal: AbortSignal.timeout(10_000),
        open: async () => { throw new Error("the network must not be used"); },
      });
      await expect(target.target.isRetired(operationId)).resolves.toBe(true);
      expect(await target.secrets.list("terminal-route/")).toEqual([]);
      // 重复收尾幂等
      await expect(target.target.finishFromDurableTerminal(operationId)).resolves.toBe(false);
      await expect(target.target.finish(removed)).resolves.toBeUndefined();
    } finally {
      await issuer.control.stop();
      await relay.close().catch(() => undefined);
      await home.store.stopStorageMaintenance();
    }
  }, 60_000);

  it("retries a failed route-copy deletion on cancel through the duty device's pending abort", async () => {
    const home = await createIssuerHome("abort-delete-retry");
    const authority = home.authority();
    const device = await enrollTarget(home, "工作电脑-X");
    const target = createTarget(home, device, 1);
    const accepted = await authority.accept({ requestId: "request-x", operationId: "remove-x", targetName: "工作电脑-X" });
    await target.target.accept(accepted, await authority.terminalRoute("remove-x"));
    const abort = await authority.abort("remove-x");
    failNextRouteDelete(target.secrets);
    // 删除失败时不交回中止回执：issuer 的待中止义务留着，会再送一次
    await expect(target.target.abort("remove-x", abort)).rejects.toThrow("simulated secret store delete failure");
    expect(await target.secrets.list("terminal-route/")).toHaveLength(1);
    await expect(authority.pendingAbortForTarget(device.identity.deviceId)).resolves.toMatchObject({ operationId: "remove-x" });
    const receipt = await target.target.abort("remove-x", abort);
    expect(receipt.phase).toBe("aborted");
    expect(await target.secrets.list("terminal-route/")).toEqual([]);
    await authority.acceptTargetAborted(receipt);
    await expect(authority.pendingAbortForTarget(device.identity.deviceId)).resolves.toBeUndefined();
    await home.store.stopStorageMaintenance();
  });

  it("hands an interrupted irreversible completion to the dedicated retrieval owner without a restart", async () => {
    const home = await createIssuerHome("live-handoff");
    const relay = await startRelay();
    const issuer = await startIssuer(home, relay.port);
    const device = await enrollTarget(home, "工作电脑-L");
    const target = createTarget(home, device, relay.port);
    const owner = new ExecutorRemovalRetrievalOwner({
      target: () => target.target,
      deviceKey: device.key,
      verifier: home.verifier,
    });
    const operationId = "remove-live-handoff";
    try {
      // 成员连接上的 issuer 服务：ready 送到、issuer 撤销之后成员连接断开，撤销回执丢失
      const issuerMember = new InMemoryMemberLink();
      registerDeviceRemovalIssuerMeshService(issuerMember, {
        authority: issuer.authority,
        authorizeTarget: () => true,
      });
      const targetMember = new InMemoryMemberLink();
      registerDeviceRemovalTargetMeshService(targetMember, {
        target: target.target,
        issuerFor: () => new DeviceRemovalIssuerMeshClient(
          issuerMember.client(device.identity.deviceId, (command) => command.op === "ready"),
          home.verifier,
        ),
        authorizeIssuer: () => true,
        onCompletionInterrupted: (id) => owner.schedule(id),
      });
      const targetClient = new DeviceRemovalTargetMeshClient(targetMember.client(home.issuer.deviceId));
      const accepted = await issuer.authority.accept({
        requestId: `request-${operationId}`,
        operationId,
        targetName: device.identity.displayName,
      });
      await targetClient.accept(accepted, await issuer.authority.terminalRoute(operationId));
      // 正常产品路径：issuer 发 decide，target 内联续做；回执丢失后不等重启，交给专用取回
      await expect(targetClient.decide({
        operationId,
        mode: "destroy",
        currentAnchorDeviceId: home.issuer.deviceId,
      })).rejects.toThrow("member connection closed");
      expect(owner.running).toBe(operationId);
      // 至多一个 owner：重复交接不另起
      owner.schedule(operationId);
      await owner.settled();
      await expect(target.target.isRetired(operationId)).resolves.toBe(true);
      await expect(issuer.authority.terminal(operationId)).resolves.toMatchObject({ phase: "removed" });
      expect(owner.running).toBeUndefined();
      await owner.stop();
      // 停止之后不再接手
      owner.schedule(operationId);
      expect(owner.running).toBeUndefined();
    } finally {
      await owner.stop();
      await issuer.control.stop();
      await relay.close();
      await home.store.stopStorageMaintenance();
    }
  }, 60_000);

  it.each(["direct", "blind-relay"] as const)(
    "stops a %s retrieval waiting in the handshake or on a request without retiring the removed device",
    async (transport) => {
      const home = await createIssuerHome(`stop-${transport}`);
      const relay = await startRelay();
      const anchorPort = await freePort();
      // 握手闸：issuer 按定位解析路由时挂起，客户端停在 TLS 握手里
      let gateHandshake = false;
      let handshakeWaiting = false;
      let releaseHandshake!: () => void;
      const handshakeGate = new Promise<void>((resolve) => { releaseHandshake = resolve; });
      let releaseRequest!: () => void;
      const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
      const issuer = await startIssuer(home, relay.port, {
        anchorPort,
        beforeResolve: async () => {
          if (!gateHandshake) return;
          handshakeWaiting = true;
          await handshakeGate;
        },
      });
      const device = await enrollTarget(home, `工作电脑-${transport}`);
      const target = createTarget(home, device, relay.port, {
        transports: transport === "direct"
          ? [{ kind: "direct", host: "127.0.0.1", port: anchorPort }]
          : [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: relay.port } }],
      });
      const operationId = `remove-stop-${transport}`;
      const createOwner = () => new ExecutorRemovalRetrievalOwner({
        target: () => target.target,
        deviceKey: device.key,
        verifier: home.verifier,
      });
      // 停止不等网络：等待中的握手或请求被取消，本机不写 terminal
      const stopsPromptly = async (owner: ExecutorRemovalRetrievalOwner) => {
        const outcome = await Promise.race([
          owner.stop().then(() => "stopped" as const),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3_000)),
        ]);
        expect(outcome).toBe("stopped");
        expect(owner.running).toBeUndefined();
        await expect(target.target.isRetired(operationId)).resolves.toBe(false);
      };
      try {
        await driveToRevoked(home, issuer.authority, device, target.target, operationId);

        gateHandshake = true;
        const inHandshake = createOwner();
        inHandshake.schedule(operationId);
        await waitFor(() => handshakeWaiting);
        await stopsPromptly(inHandshake);
        gateHandshake = false;
        releaseHandshake();

        // 请求闸：issuer 收到 cleanup-ready 后挂起，客户端停在请求等待里
        const commitCleanupReady = issuer.authority.commitCleanupReady.bind(issuer.authority);
        let requestWaiting = false;
        const gated = vi.spyOn(issuer.authority, "commitCleanupReady").mockImplementation(async (receipt) => {
          requestWaiting = true;
          await requestGate;
          return commitCleanupReady(receipt);
        });
        const onRequest = createOwner();
        onRequest.schedule(operationId);
        await waitFor(() => requestWaiting);
        await stopsPromptly(onRequest);
        releaseRequest();
        // 对端放行后 issuer 写下 removed，已停止的取回不再写本机 terminal
        const deadline = Date.now() + 10_000;
        while (!(await issuer.authority.terminal(operationId))) {
          if (Date.now() >= deadline) throw new Error("released cleanup-ready did not reach removed");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await expect(target.target.isRetired(operationId)).resolves.toBe(false);
        gated.mockRestore();

        // 停止之后由新的取回 owner 照常走完
        const resumed = createOwner();
        resumed.schedule(operationId);
        await resumed.settled();
        await expect(target.target.isRetired(operationId)).resolves.toBe(true);
        await expect(issuer.authority.terminal(operationId)).resolves.toMatchObject({ phase: "removed" });
        await resumed.stop();
      } finally {
        releaseHandshake();
        releaseRequest();
        await issuer.control.stop();
        await relay.close();
        await home.store.stopStorageMaintenance();
      }
    },
    60_000,
  );
});

interface Device {
  readonly key: DeviceKey;
  readonly identity: ReturnType<typeof enrollDeviceIdentity>;
}

/**
 * 值班设备的 home。production 时走生产入口：经统一 home 权威入口打开、带缓存完整性密钥（认证日志），
 * 值班侧验签用权威入口自己的验签器（身份按 keyId 从当前信任投影按需解析）。
 */
async function createIssuerHome(label: string, options: { readonly production?: boolean } = {}) {
  const home = await createTempDir(`terminal-retrieval-${label}`);
  const issuerKey = await DeviceKey.generate();
  const issuer = enrollDeviceIdentity(issuerKey, { displayName: "值班电脑", platform: "headless", enrolledAt: AT0 });
  const secrets = new MemorySecretStore();
  const store = options.production
    ? await FileMeshBootstrapStore.open(home, issuerKey, { secretStore: secrets })
    : new FileMeshBootstrapStore(home, issuerKey);
  await store.initializeLocalHome({ key: issuerKey, identity: issuer, roles: ["anchor"], homeId: "home-terminal", at: AT0 });
  const identities = new Map([[issuer.deviceId, issuer] as const]);
  const testVerifier = createLiveTrustedDeviceProtocolVerifier((deviceId) => identities.get(deviceId));
  const verifier = options.production ? store.authoritySources()!.verifier : testVerifier;
  const ports = createMeshBootstrapProjectionPorts(store);
  return {
    home,
    store,
    ports,
    issuerKey,
    issuer,
    identities,
    verifier,
    secrets,
    authority: () => new CurrentIssuerDeviceRemovalAuthority({
      store,
      issuerKey,
      secretStore: secrets,
      verifier,
      isReachable: () => false,
      now: () => AT1,
      // 生产在信任提交后经对齐刷新常驻验签身份：已撤销成员转入有界的历史条目
      ...(options.production ? { onTrustCommitted: async () => { await store.loadCurrentTrust(); } } : {}),
    }),
  };
}

type IssuerHome = Awaited<ReturnType<typeof createIssuerHome>>;

/** 值班设备冷重启：关闭存储后经生产入口重开，常驻验签身份只剩当前成员。 */
async function reopenIssuerHome(home: IssuerHome) {
  await home.store.stopStorageMaintenance();
  const store = await FileMeshBootstrapStore.open(home.home, home.issuerKey, { secretStore: home.secrets });
  const verifier = store.authoritySources()!.verifier;
  return {
    store,
    verifier,
    identities: store.authoritySources()!.identities,
    authority: () => new CurrentIssuerDeviceRemovalAuthority({
      store,
      issuerKey: home.issuerKey,
      secretStore: home.secrets,
      verifier,
      isReachable: () => false,
      now: () => AT1,
      onTrustCommitted: async () => { await store.loadCurrentTrust(); },
    }),
  };
}

async function enrollTarget(home: IssuerHome, name: string): Promise<Device> {
  const key = await DeviceKey.generate();
  const identity = enrollDeviceIdentity(key, { displayName: name, platform: "headless", enrolledAt: AT0 });
  const trust = replayTrustChain(await home.store.loadTrustEvents());
  await home.store.appendTrustEvent({
    event: createSignedTrustEvent({
      current: trust,
      body: {
        t: "enroll",
        device: identity,
        roles: ["executor"],
        pairingTranscriptDigest: protocolDigest("TerminalRetrievalPairing", 1, { deviceId: identity.deviceId }),
      },
      signer: home.issuerKey,
      at: AT0,
    }),
    issuerKey: home.issuerKey,
  });
  home.identities.set(identity.deviceId, identity);
  // 生产配置下照运行时读一次当前信任，刷新常驻验签身份
  await home.store.loadCurrentTrust();
  await home.ports.transportPeers.acceptTransportPeer({ identity, rootCertificatePem: key.rootCertificatePem });
  return { key, identity };
}

async function appendActiveExposure(home: IssuerHome, deviceId: string): Promise<void> {
  await home.store.authorityLog().append([{
    stream: "exposure",
    body: createCredentialExposureRecord({
      deviceId,
      bindingId: `user-alias:${deviceId}:credential-provider-main`,
      bindingRevision: 1,
      service: "provider-main",
      markedAt: AT1,
    }),
  }]);
}

/** 旧目标真实走完：目标签名的 revocation-ready 与 cleanup-ready，issuer 写下终结。 */
async function completeBySignedReceipts(
  home: IssuerHome,
  authority: CurrentIssuerDeviceRemovalAuthority,
  device: Device,
  index: number,
): Promise<void> {
  const { signature: _signature, ...accepted } = await authority.accept({
    requestId: `old-request-${index}`,
    operationId: `old-remove-${index}`,
    targetName: device.identity.displayName,
  });
  const ready = { ...accepted, phase: "revocation-ready" as const };
  await authority.commitReady({ ...ready, signature: device.key.sign("ExecutorRemovalReceipt", 1, ready) });
  const cleanup = {
    ...accepted,
    phase: "cleanup-ready" as const,
    evidenceDigest: protocolDigest("TerminalRetrievalScaleCleanup", 1, { index }),
  };
  expect((await authority.commitCleanupReady({
    ...cleanup,
    signature: device.key.sign("ExecutorRemovalReceipt", 1, cleanup),
  })).phase).toBe("removed");
  expect(home.identities.has(device.identity.deviceId)).toBe(true);
}

async function startIssuer(
  home: IssuerHome,
  relayPort: number,
  options: { readonly anchorPort?: number; readonly beforeResolve?: () => Promise<void> } = {},
) {
  const authority = home.authority();
  await authority.resumeActive();
  const terminalServices = new MeshServiceRegistry();
  registerDeviceRemovalIssuerMeshService(terminalServices, {
    authority,
    authorizeTarget: (deviceId) => authority.authorizesTarget(deviceId),
    terminalOnly: true,
  });
  const trust = (await home.store.loadCurrentTrust())!;
  const control = new ProductionMeshControlPlane({
    localIdentity: home.issuerKey,
    trust,
    configuration: {
      enabledRoles: ["anchor"],
      relayRegistration: { host: "127.0.0.1", port: relayPort },
      ...(options.anchorPort === undefined
        ? {}
        : { anchorListen: { bind: { host: "127.0.0.1", port: options.anchorPort } } }),
    },
    endpoints: new MeshEndpointDirectory(),
    transportPeers: await loadActiveMemberTransportPeers(home.ports.transportPeers, trust.members, home.issuerKey.deviceId),
    secretStore: home.secrets,
    endpointDirectory: home.ports.endpoints,
    transportPeerDirectory: home.ports.transportPeers,
    trustProjection: Object.freeze({ loadCurrentTrust: () => home.store.loadCurrentTrust() }),
    services: new MeshServiceRegistry(),
    terminalRoutes: {
      services: terminalServices,
      resolve: async (locator) => {
        await options.beforeResolve?.();
        return resolveExecutorRemovalTerminalRoute({
          authority,
          transportPeer: (deviceId) => home.ports.transportPeers.transportPeer(deviceId),
        }, locator);
      },
      secret: () => loadOrCreateIssuerTerminalRouteSecret(home.secrets, home.issuerKey.deviceId),
    },
    watchTrust: false,
  });
  await control.start();
  return { authority, control };
}

function createTarget(
  home: IssuerHome,
  device: Device,
  relayPort: number,
  overrides: {
    readonly cleanup?: () => Promise<readonly { readonly kind: "cleanup"; readonly digest: string }[]>;
    readonly transports?: MeshEndpointDescriptor["transports"];
  } = {},
) {
  const secrets = new MemorySecretStore();
  const log = new FileAuthorityCommitLog(
    path.join(home.home, `target-${device.identity.deviceId.slice(4, 16)}`),
    home.store.artifactStore(),
  );
  const endpoint: MeshEndpointDescriptor = {
    v: 1,
    deviceId: home.issuer.deviceId,
    transports: overrides.transports ?? [{ kind: "blind-relay", relay: { host: "127.0.0.1", port: relayPort } }],
    revision: 1,
    at: AT0,
  };
  const target = new ExecutorRemovalTarget({
    log,
    homeId: "home-terminal",
    deviceKey: device.key,
    verifier: home.verifier,
    secretStore: secrets,
    issuerRoute: async () => ({
      peer: { identity: home.issuer, rootCertificatePem: home.issuerKey.rootCertificatePem },
      endpoint,
    }),
    closeAdmission: async () => undefined,
    settleAcceptedWork: async () => undefined,
    releaseAdmission: async () => undefined,
    transferToAnchor: async () => undefined,
    cleanup: overrides.cleanup ?? (async () => [{
      kind: "cleanup" as const,
      digest: protocolDigest("TerminalRetrievalCleanup", 1, { deviceId: device.identity.deviceId }),
    }]),
    finalizeDeviceKey: async (operationId) => [{
      kind: "cleanup" as const,
      digest: protocolDigest("TerminalRetrievalKeyDeleted", 1, { operationId }),
    }],
    now: () => AT1,
  });
  return { target, secrets, log };
}

/** 接受、落盘路由材料、目标决定，issuer 收到 ready 后撤销。 */
async function driveToRevoked(
  home: IssuerHome,
  authority: CurrentIssuerDeviceRemovalAuthority,
  device: Device,
  target: ExecutorRemovalTarget,
  operationId: string,
) {
  const accepted = await authority.accept({
    requestId: `request-${operationId}`,
    operationId,
    targetName: device.identity.displayName,
  });
  await target.accept(accepted, await authority.terminalRoute(operationId));
  const decision = await target.decide({
    operationId,
    mode: "destroy",
    currentAnchorDeviceId: home.issuer.deviceId,
  });
  if (decision.kind !== "ready") throw new Error("target did not reach revocation-ready");
  const revoked = await authority.commitReady(decision.receipt);
  expect(revoked.phase).toBe("revoked");
  return { accepted, ready: decision.receipt, revoked };
}

/** 截获注册的服务定义，按成员连接的形状直接调用；可模拟回执在途丢失（成员连接断开）。 */
class InMemoryMemberLink extends MeshServiceRegistry {
  readonly #definitions = new Map<string, MeshServiceDefinition>();

  override register(serviceId: string, definition: MeshServiceDefinition): () => void {
    this.#definitions.set(serviceId, definition);
    return super.register(serviceId, definition);
  }

  client(peerDeviceId: string, dropResponseOf?: (command: { readonly op?: unknown }) => boolean): MeshServiceClient {
    const connection = { peer: { deviceId: peerDeviceId } } as never;
    return {
      request: async (serviceId, payload, signal) => {
        const definition = this.#definitions.get(serviceId);
        if (!definition) throw new Error(`member link service is not registered: ${serviceId}`);
        if (definition.authorize && !(await definition.authorize(connection))) {
          throw new Error(`member link peer is not authorized: ${peerDeviceId}`);
        }
        const response = await definition.handler(payload, connection, signal ?? new AbortController().signal);
        const command = JSON.parse(Buffer.from(payload).toString("utf8")) as { readonly op?: unknown };
        if (dropResponseOf?.(command)) throw new Error("member connection closed before the response arrived");
        return response;
      },
    };
  }
}

/** 对 terminal-route 种类的删除注入一次失败，之后恢复正常。 */
function failNextRouteDelete(store: MemorySecretStore): void {
  const original = store.delete.bind(store);
  let pending = true;
  store.delete = async (ref) => {
    if (pending && ref.kind === "terminal-route") {
      pending = false;
      throw new Error("simulated secret store delete failure");
    }
    return original(ref);
  };
}

async function startRelay() {
  const matcher = new BlindRendezvousMatcher();
  const sockets = new Set<Socket>();
  const hellos: { readonly role: string; readonly key: string }[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    void readBlindRendezvousHello(socket).then((hello) => {
      hellos.push({ role: hello.role, key: hello.key });
      try {
        matcher.accept(socket, hello);
      } catch {
        socket.destroy();
      }
    }, () => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing relay port");
  return {
    port: address.port,
    hellos,
    close: async () => {
      matcher.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type ProjectionReads = { readonly keys: number; readonly scanned: number };

/** 持久投影的读取：按键读取的键数、扫描返回的行数，以及读出值（扫描另含键）的规范化字节。 */
function countProjectionReads() {
  const counts = { keys: 0, scanned: 0, bytes: 0 };
  const size = (value: unknown) => value === undefined ? 0 : Buffer.byteLength(canonicalize(value));
  const prototype = FileDurableProjectionIndex.prototype;
  const { get, getMany, scan } = prototype;
  const spies = [
    vi.spyOn(prototype, "get").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      counts.keys += 1;
      const value = await get.apply(this, args);
      counts.bytes += size(value);
      return value;
    }),
    vi.spyOn(prototype, "getMany").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      counts.keys += args[0].length;
      const values = await getMany.apply(this, args);
      for (const value of values) counts.bytes += size(value);
      return values;
    }),
    vi.spyOn(prototype, "scan").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      const page = await scan.apply(this, args);
      counts.scanned += page.entries.length;
      for (const entry of page.entries) counts.bytes += Buffer.byteLength(entry.key) + size(entry.value);
      return page;
    }),
  ];
  const reset = () => {
    counts.keys = 0;
    counts.scanned = 0;
    counts.bytes = 0;
  };
  return {
    take(): ProjectionReads {
      const value = { keys: counts.keys, scanned: counts.scanned };
      reset();
      return value;
    },
    takeWithBytes(): ProjectionReads & { readonly bytes: number } {
      const value = { ...counts };
      reset();
      return value;
    },
    restore() { for (const spy of spies) spy.mockRestore(); },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing free port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not converge");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> { this.values.set(key(ref), value); }
  async get(ref: SecretRef): Promise<string | null> { return this.values.get(key(ref)) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const storageKey = key(ref);
    const existing = this.values.get(storageKey);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(storageKey, value);
    return value;
  }
  async delete(ref: SecretRef): Promise<void> { this.values.delete(key(ref)); }
  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()].filter((value) => value.startsWith(prefix)).map((value) => {
      const separator = value.indexOf("/");
      return { kind: value.slice(0, separator) as SecretRef["kind"], bindingId: value.slice(separator + 1) };
    });
  }
  async unlockState(): Promise<"unlocked"> { return "unlocked"; }
}

function key(ref: SecretRef): string { return `${ref.kind}/${ref.bindingId}`; }
