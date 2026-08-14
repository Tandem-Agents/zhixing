import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import {
  MeshServiceRegistry,
  type MeshServiceDefinition,
} from "@zhixing/mesh/service-registry";
import { createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CurrentIssuerDeviceRemovalAuthority,
  ExecutorRemovalTarget,
  cleanupRemovedDeviceSecrets,
} from "./device-removal.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";
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
    expect((await fixture.store.loadTrustRecord())?.members.find((member) =>
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
    expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).toBe(false);
    await restarted.resumeActive();
    expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).toBe(true);
    await expect(restarted.terminal("remove-1")).resolves.toEqual(removed);
  }, 120_000);

  it("restores the issuer guard after restart without creating a second lifecycle fact", async () => {
    const fixture = await createFixture();
    await fixture.authority().accept({
      requestId: "request-2",
      operationId: "remove-2",
      targetName: "工作电脑",
    });
    const restarted = fixture.authority();
    expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).toBe(false);
    await restarted.resumeActive();
    expect(restarted.authorizesTarget(fixture.targetKey.deviceId)).toBe(true);
    expect((await fixture.store.authorityLog().readStream("device-lifecycle")).length).toBe(2);
  });

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
    await target.accept(accepted);

    const [abort, concurrentAbort] = await Promise.all([
      authority.abort(accepted.operationId),
      authority.abort(accepted.operationId),
    ]);
    expect(concurrentAbort).toEqual(abort);
    const restartedAuthority = fixture.authority();
    await restartedAuthority.resumeActive();
    expect(restartedAuthority.authorizesTarget(fixture.targetKey.deviceId)).toBe(true);
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
    expect(restartedAuthority.authorizesTarget(fixture.targetKey.deviceId)).toBe(false);
    await expect(restartedAuthority.abort(accepted.operationId)).resolves.toEqual(abort);
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
    await target.accept(accepted);
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
    await target.accept(accepted);
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
    await targetClient.accept(accepted);
    const state = await targetClient.abort(accepted.operationId, await authority.abort(accepted.operationId));
    expect(state.phase).toBe("cancelled");
    expect(authority.authorizesTarget(fixture.targetKey.deviceId)).toBe(false);
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
    const options = {
      log,
      homeId: "home-1",
      deviceKey: fixture.targetKey,
      verifier: fixture.verifier,
      closeAdmission: async () => undefined,
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
    await target.accept(accepted);
    const decision = await target.decide({
      operationId: accepted.operationId,
      mode: "transfer",
      currentAnchorDeviceId: fixture.issuerKey.deviceId,
    });
    if (decision.kind !== "ready") throw new Error("unexpected preflight drift");
    await authority.commitReady(decision.receipt);

    const restarted = new ExecutorRemovalTarget(options);
    await restarted.resumeBeforeAdmission();
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

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string): Promise<void> { this.values.set(key(ref), value); }
  async get(ref: SecretRef): Promise<string | null> { return this.values.get(key(ref)) ?? null; }
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
