import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceLifecycleJournal, FileAuthorityCommitLog, FileDurableProjectionIndex } from "@zhixing/core/authority";
import { protocolDigest } from "@zhixing/core/protocol";
import { createMeshEndpointDescriptor } from "@zhixing/mesh/bootstrap";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import {
  MeshServiceRegistry,
  type MeshServiceDefinition,
} from "@zhixing/mesh/service-registry";
import { createSignedTrustEvent, replayTrustChain } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CurrentIssuerDeviceRemovalAuthority,
  ExecutorRemovalTarget,
  cleanupRemovedDeviceSecrets,
} from "./device-removal.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  createLiveTrustedDeviceProtocolVerifier,
  createTrustedDeviceProtocolVerifier,
} from "./trusted-device-protocol-verifier.js";
import {
  DEVICE_REMOVAL_ISSUER_SERVICE,
  DEVICE_REMOVAL_TARGET_SERVICE,
  DeviceRemovalIssuerMeshClient,
  DeviceRemovalTargetMeshClient,
  registerDeviceRemovalIssuerMeshService,
  registerDeviceRemovalTargetMeshService,
} from "./device-removal-mesh.js";

describe("current issuer device removal", () => {
  it("commits revocation before the target cleanup terminal and replays both receipts", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const accepted = await authority.accept({
      requestId: "request-1",
      operationId: "remove-1",
      targetName: "工作电脑",
    });
    const ready = fixture.targetKey.sign("ExecutorRemovalReceipt", 1, {
      v: 1,
      operationId: accepted.operationId,
      homeId: accepted.homeId,
      targetDeviceId: accepted.targetDeviceId,
      targetDeviceKeyGeneration: accepted.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: accepted.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: accepted.acceptedTrustHeadDigest,
      phase: "revocation-ready",
      evidenceDigest: accepted.evidenceDigest,
      at: accepted.at,
    });
    const receipt = {
      v: 1 as const,
      operationId: accepted.operationId,
      homeId: accepted.homeId,
      targetDeviceId: accepted.targetDeviceId,
      targetDeviceKeyGeneration: accepted.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: accepted.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: accepted.acceptedTrustHeadDigest,
      phase: "revocation-ready" as const,
      evidenceDigest: accepted.evidenceDigest,
      at: accepted.at,
      signature: ready,
    };
    const revoked = await authority.commitReady(receipt);
    expect(revoked.phase).toBe("revoked");
    await expect(authority.publicStateForTarget(accepted.targetDeviceId)).resolves.toMatchObject({
      phase: "cleaning-device",
      localData: "known",
    });
    await expect(authority.commitReady(receipt)).resolves.toEqual(revoked);
    const tail = (await fixture.store.authorityLog().readAll()).at(-1);
    expect(tail?.entries.map((entry) => entry.stream)).toEqual(expect.arrayContaining([
      "trust",
      "device-lifecycle",
    ]));
    // 当前快照只列 active 成员；撤销由事件链证明
    expect((await fixture.store.loadTrustRecord())?.members.some((member) =>
      member.device.deviceId === fixture.targetKey.deviceId)).toBe(false);
    expect(replayTrustChain(await fixture.store.loadTrustEvents()).members.find((member) =>
      member.device.deviceId === fixture.targetKey.deviceId)?.state).toBe("revoked");
    await expect(authority.terminal("remove-1")).resolves.toBeUndefined();
    const { signature: _readySignature, ...readyUnsigned } = receipt;
    const cleanupUnsigned = {
      ...readyUnsigned,
      phase: "cleanup-ready" as const,
      evidenceDigest: `sha256:${"d".repeat(64)}`,
    };
    const cleanupReady = {
      ...cleanupUnsigned,
      signature: fixture.targetKey.sign("ExecutorRemovalReceipt", 1, cleanupUnsigned),
    };
    const removed = await authority.commitCleanupReady(cleanupReady);
    expect(removed.phase).toBe("removed");
    await expect(authority.publicStateForTarget(accepted.targetDeviceId)).resolves.toMatchObject({
      phase: "removed",
      localData: "unknown",
    });
    await expect(authority.commitCleanupReady(cleanupReady)).resolves.toEqual(removed);
    await expect(authority.terminal("remove-1")).resolves.toEqual(removed);
    const restarted = fixture.authority();
    // 访问时按持久状态精确核验：已终结的目标不必等启动恢复也仍可重试终端服务
    await expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(true);
    await restarted.resumeActive();
    await expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(true);
    await expect(restarted.terminal("remove-1")).resolves.toEqual(removed);
  }, 120_000);

  it("restores the issuer guard after restart without creating a second lifecycle fact", async () => {
    const fixture = await createFixture();
    await fixture.authority().accept({
      requestId: "request-2",
      operationId: "remove-2",
      targetName: "工作电脑",
    });
    // 接受、冻结准入、绑定终态定位三条；重启恢复不再追加
    expect((await fixture.store.authorityLog().readStream("device-lifecycle")).length).toBe(3);
    const restarted = fixture.authority();
    await expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(true);
    await restarted.resumeActive();
    await expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(true);
    expect((await fixture.store.authorityLog().readStream("device-lifecycle")).length).toBe(3);
  });

  it("restores removal guards from the removal targets alone, whatever the number of host stops", async () => {
    const digest = protocolDigest("DeviceRemovalScaleEvidence", 1, {});
    const rows: { stops: number; keys: number; scanned: number }[] = [];
    for (const stops of [8, 64, 256]) {
      const fixture = await createFixture();
      const accepted = await fixture.authority().accept({
        requestId: `request-scale-${stops}`,
        operationId: `remove-scale-${stops}`,
        targetName: "工作电脑",
      });
      // 每次宿主启停在同一生命周期日志里留下一条终结的 stop 操作：与宿主停止同一份校验与归约
      const journal = new DeviceLifecycleJournal(fixture.store.authorityLog());
      for (let index = 0; index < stops; index++) {
        const operationId = `stop-${index}`;
        await journal.accept({
          v: 1, kind: "stop", requestId: `request-stop-${index}`, operationId, homeId: "home-1",
          localDeviceId: fixture.issuerKey.deviceId, strategy: "immediate",
          host: { kind: "managed", serviceId: "zhixing-home-1", definitionDigest: digest, instanceId: `instance-${index}` },
        });
        for (const phase of ["gate-closed", "work-settled", "flushed", "ready-to-stop"] as const) {
          await journal.advance(operationId, phase);
        }
        await journal.terminal(operationId, "stopped", [{ kind: "supervisor", digest }]);
      }
      const guards: (readonly [string, string | undefined])[] = [];
      const restarted = new CurrentIssuerDeviceRemovalAuthority({
        store: fixture.store,
        issuerKey: fixture.issuerKey,
        secretStore: fixture.secrets,
        verifier: fixture.verifier,
        isReachable: () => true,
        now: () => "2026-08-12T00:00:03.000Z",
        onGuardChanged: (deviceId, operationId) => guards.push([deviceId, operationId]),
      });
      const counts = { keys: 0, scanned: 0 };
      const prototype = FileDurableProjectionIndex.prototype;
      const { get, getMany, scan } = prototype;
      const spies = [
        vi.spyOn(prototype, "get").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
          counts.keys += 1;
          return get.apply(this, args);
        }),
        vi.spyOn(prototype, "getMany").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
          counts.keys += args[0].length;
          return getMany.apply(this, args);
        }),
        vi.spyOn(prototype, "scan").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
          const page = await scan.apply(this, args);
          counts.scanned += page.entries.length;
          return page;
        }),
      ];
      try {
        await restarted.resumeActive();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      await expect(restarted.authorizesTarget(accepted.targetDeviceId)).resolves.toBe(true);
      expect(guards).toEqual([[accepted.targetDeviceId, accepted.operationId]]);
      rows.push({ stops, ...counts });
    }
    // allow-direct-stdout：规模用例的读数输出；测试文件不是运行时输出面
    console.log("REMOVAL_RESUME_ROWS", JSON.stringify(rows));
    // 读取只随移除数：三档相同（整扫全部生命周期操作时随启停次数增长）
    expect(rows.map(({ keys, scanned }) => [keys, scanned]))
      .toEqual(rows.map(() => [rows[0]!.keys, rows[0]!.scanned]));
  }, 600_000);

  it("resumes only pending removals and authorizes completed targets by an exact lookup, whatever the number of completed removals", async () => {
    const rows: { completed: number; resume: ProjectionReads; lookup: ProjectionReads }[] = [];
    for (const completed of [4, 12, 48]) {
      const fixture = await createDynamicFixture();
      const authority = fixture.authority();
      const targets: string[] = [];
      // 每个旧目标都真实走完：目标签名的 revocation-ready 与 cleanup-ready，生产活验签器核验
      for (let index = 0; index < completed; index++) {
        const targetKey = await DeviceKey.generate();
        const identity = enrollDeviceIdentity(targetKey, {
          displayName: `old-target-${index}`,
          platform: "headless",
          enrolledAt: "2026-08-12T00:00:02.000Z",
        });
        const trust = replayTrustChain(await fixture.store.loadTrustEvents());
        await fixture.store.appendTrustEvent({
          event: createSignedTrustEvent({
            current: trust,
            body: {
              t: "enroll",
              device: identity,
              roles: ["executor"],
              pairingTranscriptDigest: protocolDigest("RevocationScalePairing", 1, { deviceId: identity.deviceId }),
            },
            signer: fixture.issuerKey,
            at: "2026-08-12T00:00:02.000Z",
          }),
          issuerKey: fixture.issuerKey,
        });
        fixture.identities.set(identity.deviceId, identity);
        const { signature: _signature, ...accepted } = await authority.accept({
          requestId: `remove-request-${index}`,
          operationId: `old-remove-${index}`,
          targetName: `old-target-${index}`,
        });
        const ready = { ...accepted, phase: "revocation-ready" as const };
        await authority.commitReady({ ...ready, signature: targetKey.sign("ExecutorRemovalReceipt", 1, ready) });
        const cleanup = {
          ...accepted,
          phase: "cleanup-ready" as const,
          evidenceDigest: protocolDigest("RemovalScaleCleanup", 1, { index }),
        };
        expect((await authority.commitCleanupReady({
          ...cleanup,
          signature: targetKey.sign("ExecutorRemovalReceipt", 1, cleanup),
        })).phase).toBe("removed");
        targets.push(identity.deviceId);
      }
      const guards: (readonly [string, string | undefined])[] = [];
      const restarted = new CurrentIssuerDeviceRemovalAuthority({
        store: fixture.store,
        issuerKey: fixture.issuerKey,
        secretStore: fixture.secrets,
        verifier: fixture.verifier,
        isReachable: () => true,
        now: () => "2026-08-12T00:00:03.000Z",
        onGuardChanged: (deviceId, operationId) => guards.push([deviceId, operationId]),
      });
      const counter = countProjectionReads();
      try {
        await restarted.resumeActive();
        const resume = counter.take();
        await expect(restarted.authorizesTarget(targets[0]!)).resolves.toBe(true);
        rows.push({ completed, resume, lookup: counter.take() });
      } finally {
        counter.restore();
      }
      // 没有未终结的移除：启动不恢复任何守卫；从未被移除的设备不放行
      expect(guards).toEqual([]);
      await expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(false);
      await fixture.store.authorityLog().stopStorageMaintenance();
    }
    // allow-direct-stdout：规模用例的读数输出；测试文件不是运行时输出面
    console.log("COMPLETED_REMOVAL_ROWS", JSON.stringify(rows));
    // 启动恢复与一次精确核验的读取都与已完成移除数无关
    expect(rows.map(({ resume, lookup }) => [resume, lookup]))
      .toEqual(rows.map(() => [rows[0]!.resume, rows[0]!.lookup]));
  }, 600_000);

  it("terminates a lost device removal with its own terminal evidence and redrives from any phase", async () => {
    for (const interruptAtTerminal of [false, true]) {
      const fixture = await createFixture();
      const authority = new CurrentIssuerDeviceRemovalAuthority({
        store: fixture.store,
        issuerKey: fixture.issuerKey,
        secretStore: fixture.secrets,
        verifier: fixture.verifier,
        isReachable: () => false,
        now: () => "2026-08-12T00:00:03.000Z",
      });
      const accepted = await authority.accept({
        requestId: `request-lost-${interruptAtTerminal}`,
        operationId: `remove-lost-${interruptAtTerminal}`,
        targetName: "工作电脑",
      });
      if (interruptAtTerminal) {
        // 中断在终结之前：停在 cleanup-complete，再调用时从这里续做
        const terminal = vi.spyOn(DeviceLifecycleJournal.prototype, "terminal")
          .mockRejectedValueOnce(new Error("interrupted before terminal"));
        await expect(authority.commitLost(accepted.operationId)).rejects.toThrow("interrupted before terminal");
        terminal.mockRestore();
        const journal = new DeviceLifecycleJournal(fixture.store.authorityLog());
        expect((await journal.state(accepted.operationId))?.phase).toBe("cleanup-complete");
      }
      const lost = await authority.commitLost(accepted.operationId);
      expect(lost.phase).toBe("lost");
      // 重复调用：已终结即返回同一份回执，不再追加任何生命周期事实
      const before = (await fixture.store.authorityLog().readStream("device-lifecycle")).length;
      await expect(authority.commitLost(accepted.operationId)).resolves.toEqual(lost);
      expect((await fixture.store.authorityLog().readStream("device-lifecycle")).length).toBe(before);
      const journal = new DeviceLifecycleJournal(fixture.store.authorityLog());
      expect((await journal.state(accepted.operationId))?.phase).toBe("terminal");
      await expect(authority.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(true);
      await fixture.store.authorityLog().stopStorageMaintenance();
    }
  }, 120_000);

  it("projects pending and abort-waiting states from the issuer journal after restart", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const accepted = await authority.accept({
      requestId: "request-status-fallback",
      operationId: "remove-status-fallback",
      targetName: "工作电脑",
    });

    await expect(authority.publicStateForTarget(accepted.targetDeviceId)).resolves.toEqual({
      phase: "needs-conversation-decision",
      conversations: [],
      localData: "known",
      credentialActions: ["移除已登记，可继续或取消"],
    });

    await authority.abort(accepted.operationId);
    const restarted = fixture.authority();
    await expect(restarted.publicStateForTarget(accepted.targetDeviceId)).resolves.toEqual({
      phase: "waiting-for-device",
      conversations: [],
      localData: "known",
      credentialActions: ["取消已安全记录；目标设备上线后会自动恢复准入"],
    });
  }, 120_000);

  it("keeps a signed cancel pending until the target durably aborts and exactly replays both sides", async () => {
    const fixture = await createFixture();
    let abortClock = 3;
    const authority = fixture.authority(() =>
      `2026-08-12T00:00:${String(abortClock++).padStart(2, "0")}.000Z`);
    const accepted = await authority.accept({
      requestId: "request-abort-replay",
      operationId: "remove-abort-replay",
      targetName: "工作电脑",
    });
    const releaseAdmission = vi.fn(async () => undefined);
    const targetOptions = {
      ...createTargetOptions(fixture, "target-abort-replay"),
      releaseAdmission,
    };
    const target = new ExecutorRemovalTarget(targetOptions);
    await target.accept(accepted, await authority.terminalRoute(accepted.operationId));

    const [abort, concurrentAbort] = await Promise.all([
      authority.abort(accepted.operationId),
      authority.abort(accepted.operationId),
    ]);
    expect(concurrentAbort).toEqual(abort);
    const restartedAuthority = fixture.authority();
    await restartedAuthority.resumeActive();
    await expect(restartedAuthority.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(true);
    await expect(restartedAuthority.pendingAbortForTarget(fixture.targetKey.deviceId)).resolves.toEqual({
      operationId: accepted.operationId,
      abort,
    });
    await expect(restartedAuthority.abort(accepted.operationId)).resolves.toEqual(abort);

    const aborted = await target.abort(accepted.operationId, abort);
    expect(aborted.phase).toBe("aborted");
    const restartedTarget = new ExecutorRemovalTarget(targetOptions);
    await expect(restartedTarget.abort(accepted.operationId, abort)).resolves.toEqual(aborted);
    expect(releaseAdmission).toHaveBeenCalledTimes(2);
    const conflictingRelease = vi.fn(async () => {
      throw new Error("Device-removal release does not own external admission");
    });
    const conflictingTarget = new ExecutorRemovalTarget({
      ...targetOptions,
      releaseAdmission: conflictingRelease,
    });
    await expect(conflictingTarget.abort(accepted.operationId, abort))
      .rejects.toThrow("does not own external admission");
    expect(conflictingRelease).toHaveBeenCalledWith(accepted.operationId);
    await restartedAuthority.acceptTargetAborted(aborted);
    await expect(restartedAuthority.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(false);
    await expect(restartedAuthority.abort(accepted.operationId)).resolves.toEqual(abort);
    // 已中止的移除在重启恢复时不再放行目标
    const afterAbort = fixture.authority();
    await afterAbort.resumeActive();
    await expect(afterAbort.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(false);
  }, 120_000);

  it("returns the frozen ready winner when cancel reaches a target after its durable decision", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const accepted = await authority.accept({
      requestId: "request-ready-wins",
      operationId: "remove-ready-wins",
      targetName: "工作电脑",
    });
    const target = new ExecutorRemovalTarget(createTargetOptions(fixture, "target-ready-wins"));
    await target.accept(accepted, await authority.terminalRoute(accepted.operationId));
    const decision = await target.decide({
      operationId: accepted.operationId,
      mode: "transfer",
      currentAnchorDeviceId: fixture.issuerKey.deviceId,
    });
    expect(decision.kind).toBe("ready");
    const ready = decision.kind === "ready" ? decision.receipt : undefined;
    expect(ready).toBeDefined();

    const abort = await authority.abort(accepted.operationId);
    const winner = await target.abort(accepted.operationId, abort);
    expect(winner).toEqual(ready);
    const cleanupReady = await target.finish(await authority.commitReady(winner));
    expect(cleanupReady?.phase).toBe("cleanup-ready");
    await target.finish(await authority.commitCleanupReady(cleanupReady!));
    await expect(target.state(accepted.operationId)).resolves.toMatchObject({ phase: "removed" });
  }, 120_000);

  it("replaces an effect-free preflight after accepted work drifts and requires a fresh decision", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const accepted = await authority.accept({
      requestId: "request-preflight-drift",
      operationId: "remove-preflight-drift",
      targetName: "工作电脑",
    });
    let revision = `sha256:${"1".repeat(64)}`;
    const closeAdmission = vi.fn(async () => undefined);
    const releaseAdmission = vi.fn(async () => undefined);
    const settleAcceptedWork = vi.fn(async () => undefined);
    const target = new ExecutorRemovalTarget({
      ...createTargetOptions(fixture, "target-preflight-drift"),
      closeAdmission,
      releaseAdmission,
      settleAcceptedWork,
      captureExternalAcceptedWork: async () => [{
        owner: "remote" as const,
        id: "assignment-1",
        revision,
      }],
    });
    await target.accept(accepted, await authority.terminalRoute(accepted.operationId));
    revision = `sha256:${"2".repeat(64)}`;

    const changed = await target.decide({
      operationId: accepted.operationId,
      mode: "transfer",
      currentAnchorDeviceId: fixture.issuerKey.deviceId,
    });

    expect(changed).toMatchObject({
      kind: "preflight-changed",
      snapshot: {
        ownerItems: [{ owner: "remote", id: "assignment-1", revision }],
      },
    });
    await expect(target.state(accepted.operationId)).resolves.toMatchObject({
      phase: "needs-conversation-decision",
    });
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(settleAcceptedWork).not.toHaveBeenCalled();

    const ready = await target.decide({
      operationId: accepted.operationId,
      mode: "transfer",
      currentAnchorDeviceId: fixture.issuerKey.deviceId,
    });
    expect(ready.kind).toBe("ready");
    expect(closeAdmission).toHaveBeenCalledTimes(2);
    expect(settleAcceptedWork).toHaveBeenCalledTimes(1);
    expect(settleAcceptedWork).toHaveBeenCalledWith({
      operationId: accepted.operationId,
      mode: "transfer",
      ownerItems: [{ owner: "remote", id: "assignment-1", revision }],
    });
  }, 120_000);

  it("carries the durable abort winner through both authenticated mesh facades", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const target = new ExecutorRemovalTarget(createTargetOptions(fixture, "target-mesh-abort"));
    const issuerServices = new CapturingRegistry();
    const targetServices = new CapturingRegistry();
    registerDeviceRemovalIssuerMeshService(issuerServices, {
      authority,
      authorizeTarget: (deviceId) => deviceId === fixture.targetKey.deviceId,
    });
    registerDeviceRemovalTargetMeshService(targetServices, {
      target,
      authorizeIssuer: (deviceId) => deviceId === fixture.issuerKey.deviceId,
      issuerFor: (deviceId) => {
        if (deviceId !== fixture.issuerKey.deviceId) throw new Error("unexpected issuer");
        return new DeviceRemovalIssuerMeshClient(
          issuerServices.client(fixture.targetKey.deviceId),
          fixture.verifier,
        );
      },
    });
    const targetClient = new DeviceRemovalTargetMeshClient(
      targetServices.client(fixture.issuerKey.deviceId),
    );
    const accepted = await authority.accept({
      requestId: "request-mesh-abort",
      operationId: "remove-mesh-abort",
      targetName: "工作电脑",
    });
    await targetClient.accept(accepted, await authority.terminalRoute(accepted.operationId));
    const state = await targetClient.abort(accepted.operationId, await authority.abort(accepted.operationId));
    expect(state.phase).toBe("cancelled");
    await expect(authority.authorizesTarget(fixture.targetKey.deviceId)).resolves.toBe(false);
  }, 120_000);

  it("rejects every non-canonical removal mesh command before lifecycle effects", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const target = new ExecutorRemovalTarget(createTargetOptions(fixture, "target-strict-facade"));
    const issuerServices = new CapturingRegistry();
    const targetServices = new CapturingRegistry();
    registerDeviceRemovalIssuerMeshService(issuerServices, {
      authority,
      authorizeTarget: () => true,
    });
    registerDeviceRemovalTargetMeshService(targetServices, {
      target,
      authorizeIssuer: () => true,
      issuerFor: () => new DeviceRemovalIssuerMeshClient(
        issuerServices.client(fixture.targetKey.deviceId),
        fixture.verifier,
      ),
    });
    const commands = [
      [targetServices, DEVICE_REMOVAL_TARGET_SERVICE, { v: 1, op: "accept", receipt: {}, extra: true }],
      [targetServices, DEVICE_REMOVAL_TARGET_SERVICE, {
        v: 1, op: "decide", operationId: "strict-op", mode: "destroy",
        currentAnchorDeviceId: fixture.issuerKey.deviceId, extra: true,
      }],
      [targetServices, DEVICE_REMOVAL_TARGET_SERVICE, { v: 1, op: "status", operationId: "strict-op", extra: true }],
      [targetServices, DEVICE_REMOVAL_TARGET_SERVICE, {
        v: 1, op: "abort", operationId: "strict-op", abort: {}, extra: true,
      }],
      [issuerServices, DEVICE_REMOVAL_ISSUER_SERVICE, {
        v: 1, op: "accept-self", requestId: "strict-request", operationId: "strict-op", extra: true,
      }],
      ...["ready", "cleanup-ready", "target-aborted"].map((op) => [
        issuerServices,
        DEVICE_REMOVAL_ISSUER_SERVICE,
        { v: 1, op, receipt: {}, extra: true },
      ] as const),
      [issuerServices, DEVICE_REMOVAL_ISSUER_SERVICE, {
        v: 1, op: "terminal", operationId: "strict-op", extra: true,
      }],
      [issuerServices, DEVICE_REMOVAL_ISSUER_SERVICE, {
        v: 0, op: "terminal", operationId: "strict-op",
      }],
    ] as const;

    for (const [registry, serviceId, command] of commands) {
      await expect(registry.client(fixture.targetKey.deviceId).request(
        serviceId,
        Buffer.from(JSON.stringify(command), "utf8"),
      )).rejects.toThrow(/shape|version/u);
    }
    await expect(authority.operation("strict-op")).resolves.toBeUndefined();
    await expect(target.state("strict-op")).resolves.toBeUndefined();
  });

  it("redrives a target from its durable ready state after the revoke response is lost", async () => {
    const fixture = await createFixture();
    const authority = fixture.authority();
    const accepted = await authority.accept({
      requestId: "request-target-replay",
      operationId: "remove-target-replay",
      targetName: "工作电脑",
    });
    const log = new FileAuthorityCommitLog(
      path.join(fixture.home, "target-executor-authority"),
      fixture.store.artifactStore(),
    );
    const cleanup = vi.fn(async () => [{
      kind: "cleanup" as const,
      digest: accepted.evidenceDigest,
    }]);
    const onRemoved = vi.fn(async () => undefined);
    let lifecycleOwnersReady = true;
    const closeAdmission = vi.fn(async () => {
      if (!lifecycleOwnersReady) {
        throw new Error("device-removal lifecycle owners are not ready");
      }
    });
    const options = {
      log,
      homeId: "home-1",
      deviceKey: fixture.targetKey,
      verifier: fixture.verifier,
      secretStore: new MemorySecretStore(),
      issuerRoute: async () => issuerReachability(fixture.issuerKey),
      closeAdmission,
      settleAcceptedWork: async () => undefined,
      releaseAdmission: async () => undefined,
      transferToAnchor: async () => undefined,
      cleanup,
      finalizeDeviceKey: async () => [{
        kind: "cleanup" as const,
        digest: `sha256:${"e".repeat(64)}`,
      }],
      onRemoved,
      now: () => "2026-08-12T00:00:04.000Z",
    };
    const target = new ExecutorRemovalTarget(options);
    await target.accept(accepted, await authority.terminalRoute(accepted.operationId));
    const decision = await target.decide({
      operationId: accepted.operationId,
      mode: "transfer",
      currentAnchorDeviceId: fixture.issuerKey.deviceId,
    });
    if (decision.kind !== "ready") throw new Error("unexpected preflight drift");
    await authority.commitReady(decision.receipt);
    closeAdmission.mockClear();

    lifecycleOwnersReady = false;
    const restarted = new ExecutorRemovalTarget(options);
    expect(closeAdmission).not.toHaveBeenCalled();
    lifecycleOwnersReady = true;
    await restarted.resumeBeforeAdmission();
    expect(closeAdmission).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    await restarted.resumeWithIssuer({
      ready: (receipt) => authority.commitReady(receipt),
      cleanupReady: (receipt) => authority.commitCleanupReady(receipt),
      terminal: (operationId) => authority.terminal(operationId),
    });

    await expect(restarted.state(accepted.operationId)).resolves.toMatchObject({
      phase: "removed",
      localData: "removed",
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("preserves the exact device key until the durable local terminal while removing other secrets", async () => {
    const fixture = await createFixture();
    await fixture.secrets.put({ kind: "device-key", bindingId: `device/v1/${fixture.targetKey.deviceId}` }, "key");
    await fixture.secrets.put({ kind: "channel", bindingId: "channel-a" }, "token");
    // 本机移除的终态路由副本留到本机终结；本机若曾是 issuer，它自有的终态路由秘密照删
    await fixture.secrets.put({ kind: "terminal-route", bindingId: "removal/0123" }, "route-copy");
    await fixture.secrets.put({ kind: "terminal-route", bindingId: `issuer/${fixture.targetKey.deviceId}` }, "own-route");
    await cleanupRemovedDeviceSecrets({
      store: fixture.secrets,
      deviceKey: fixture.targetKey,
      preserveDeviceKey: true,
    });
    expect(await fixture.secrets.get({
      kind: "device-key",
      bindingId: `device/v1/${fixture.targetKey.deviceId}`,
    })).toBe("key");
    expect(await fixture.secrets.get({ kind: "channel", bindingId: "channel-a" })).toBeNull();
    expect(await fixture.secrets.get({ kind: "terminal-route", bindingId: "removal/0123" })).toBe("route-copy");
    expect(await fixture.secrets.get({
      kind: "terminal-route",
      bindingId: `issuer/${fixture.targetKey.deviceId}`,
    })).toBeNull();
  });
});

async function createFixture() {
  const home = await createTempDir("device-removal-authority");
  const issuerKey = await DeviceKey.generate();
  const targetKey = await DeviceKey.generate();
  const issuer = enrollDeviceIdentity(issuerKey, {
    displayName: "值班电脑",
    platform: "headless",
    enrolledAt: "2026-08-12T00:00:00.000Z",
  });
  const target = enrollDeviceIdentity(targetKey, {
    displayName: "工作电脑",
    platform: "headless",
    enrolledAt: "2026-08-12T00:00:01.000Z",
  });
  const store = new FileMeshBootstrapStore(home, issuerKey);
  let trust = (await store.initializeLocalHome({
    key: issuerKey,
    identity: issuer,
    roles: ["anchor"],
    homeId: "home-1",
    at: "2026-08-12T00:00:00.000Z",
  })).projection;
  const enroll = createSignedTrustEvent({
    current: trust,
    body: { t: "enroll", device: target, roles: ["executor"] },
    signer: issuerKey,
    at: "2026-08-12T00:00:02.000Z",
  });
  trust = await store.appendTrustEvent({ event: enroll, issuerKey });
  const verifier = createTrustedDeviceProtocolVerifier([issuer, target]);
  const secrets = new MemorySecretStore();
  return {
    home,
    store,
    secrets,
    issuerKey,
    targetKey,
    verifier,
    authority: (now: () => string = () => "2026-08-12T00:00:03.000Z") =>
      new CurrentIssuerDeviceRemovalAuthority({
      store,
      issuerKey,
      secretStore: secrets,
      verifier,
      isReachable: () => true,
      now,
    }),
  };
}

/** 目标设备可在用例中动态登记：验签器按当前身份表实时取用。 */
async function createDynamicFixture() {
  const fixture = await createFixture();
  const issuer = enrollDeviceIdentity(fixture.issuerKey, {
    displayName: "值班电脑",
    platform: "headless",
    enrolledAt: "2026-08-12T00:00:00.000Z",
  });
  const target = enrollDeviceIdentity(fixture.targetKey, {
    displayName: "工作电脑",
    platform: "headless",
    enrolledAt: "2026-08-12T00:00:01.000Z",
  });
  const identities = new Map([issuer, target].map((item) => [item.deviceId, item] as const));
  const verifier = createLiveTrustedDeviceProtocolVerifier((deviceId) => identities.get(deviceId));
  return {
    ...fixture,
    identities,
    verifier,
    authority: () => new CurrentIssuerDeviceRemovalAuthority({
      store: fixture.store,
      issuerKey: fixture.issuerKey,
      secretStore: fixture.secrets,
      verifier,
      isReachable: () => true,
      now: () => "2026-08-12T00:00:03.000Z",
    }),
  };
}

type ProjectionReads = { readonly keys: number; readonly scanned: number };

/** 持久投影的读取：按键读取的键数与扫描返回的行数。 */
function countProjectionReads() {
  const counts = { keys: 0, scanned: 0 };
  const prototype = FileDurableProjectionIndex.prototype;
  const { get, getMany, scan } = prototype;
  const spies = [
    vi.spyOn(prototype, "get").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      counts.keys += 1;
      return get.apply(this, args);
    }),
    vi.spyOn(prototype, "getMany").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      counts.keys += args[0].length;
      return getMany.apply(this, args);
    }),
    vi.spyOn(prototype, "scan").mockImplementation(async function (this: FileDurableProjectionIndex, ...args) {
      const page = await scan.apply(this, args);
      counts.scanned += page.entries.length;
      return page;
    }),
  ];
  return {
    take(): ProjectionReads {
      const value = { ...counts };
      counts.keys = 0;
      counts.scanned = 0;
      return value;
    },
    restore() { for (const spy of spies) spy.mockRestore(); },
  };
}

function createTargetOptions(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  directory: string,
) {
  return {
    log: new FileAuthorityCommitLog(
      path.join(fixture.home, directory),
      fixture.store.artifactStore(),
    ),
    homeId: "home-1",
    deviceKey: fixture.targetKey,
    verifier: fixture.verifier,
    secretStore: new MemorySecretStore(),
    issuerRoute: async () => issuerReachability(fixture.issuerKey),
    closeAdmission: async () => undefined,
    settleAcceptedWork: async () => undefined,
    releaseAdmission: async () => undefined,
    transferToAnchor: async () => undefined,
    cleanup: async () => [{
      kind: "cleanup" as const,
      digest: `sha256:${"d".repeat(64)}`,
    }],
    finalizeDeviceKey: async () => [{
      kind: "cleanup" as const,
      digest: `sha256:${"e".repeat(64)}`,
    }],
    now: () => "2026-08-12T00:00:04.000Z",
  };
}

/** target 在 accept 时冻结的 issuer 传输身份与端点。 */
function issuerReachability(issuerKey: DeviceKey) {
  const identity = enrollDeviceIdentity(issuerKey, {
    displayName: "值班电脑",
    platform: "headless",
    enrolledAt: "2026-08-12T00:00:00.000Z",
  });
  return {
    peer: { identity, rootCertificatePem: issuerKey.rootCertificatePem },
    endpoint: createMeshEndpointDescriptor({
      deviceId: issuerKey.deviceId,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
      revision: 1,
      at: "2026-08-12T00:00:00.000Z",
    }),
  };
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

class CapturingRegistry extends MeshServiceRegistry {
  readonly #definitions = new Map<string, MeshServiceDefinition>();

  override register(serviceId: string, definition: MeshServiceDefinition): () => void {
    this.#definitions.set(serviceId, definition);
    const unregister = super.register(serviceId, definition);
    return () => {
      this.#definitions.delete(serviceId);
      unregister();
    };
  }

  client(peerDeviceId: string): MeshServiceClient {
    const connection = { peer: { deviceId: peerDeviceId } } as never;
    return {
      request: async (serviceId, payload, signal) => {
        const definition = this.#definitions.get(serviceId);
        if (!definition) throw new Error(`mesh test service is not registered: ${serviceId}`);
        if (definition.authorize && !definition.authorize(connection)) {
          throw new Error(`mesh test peer is not authorized: ${peerDeviceId}`);
        }
        return definition.handler(payload, connection, signal ?? new AbortController().signal);
      },
    };
  }
}

function key(ref: SecretRef): string { return `${ref.kind}/${ref.bindingId}`; }
